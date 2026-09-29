/**
 * Runs the cross-encoder off the extension host thread. onnxruntime-web has
 * no multi-threading under Node, so a `session.run` blocks whatever thread
 * it is on; in a worker it blocks only itself, and a few workers score a
 * candidate list in parallel.
 *
 * Protocol: the parent sends `{ id, query, passages }` and gets back
 * `{ id, scores }` (one relevance probability per passage) or
 * `{ id, error }`. A `{ ready: true }` or `{ ready: false, error }` message
 * is sent once loading has finished.
 */
import * as ort from "onnxruntime-web"
import { Toxe } from "toxe"
import { parentPort, workerData } from "worker_threads"

import { messageOf } from "../../common/errors"

import { sigmoid } from "./rank"

/**
 * Total tokens per pair, the most the model allows. A default-sized chunk
 * (1000 chars) is 250 to 450 tokens of code with its path, and a chunk cut
 * short hides whatever answered the question in its tail; the extra time
 * over a smaller budget is worth that.
 */
const MAX_TOKENS = 512
/** Tokens of the question kept when it is long, leaving room for the passage. */
const MAX_QUERY_TOKENS = 64
const PAD_ID = 0
const CLS_ID = 1
const SEP_ID = 2

export interface RerankWorkerData {
  modelPath: string
  tokenizerPath: string
  wasmDir: string
}

export interface RerankRequest {
  id: number
  query: string
  passages: string[]
}

export type RerankReply =
  | { id: number; scores: number[] }
  | { id: number; error: string }
  | { ready: boolean; error?: string }

const { modelPath, tokenizerPath, wasmDir } = workerData as RerankWorkerData
ort.env.wasm.numThreads = 1
ort.env.wasm.wasmPaths = wasmDir.endsWith("/") ? wasmDir : `${wasmDir}/`

let session: ort.InferenceSession
const tokenizer = new Toxe(tokenizerPath)

const score = async (query: string, passages: string[]): Promise<number[]> => {
  if (!passages.length) return []
  const queryIds = (await tokenizer.encodeSample(query)).slice(0, MAX_QUERY_TOKENS)
  const passageBudget = MAX_TOKENS - queryIds.length - 3
  const rows = await Promise.all(
    passages.map(async (passage) => {
      const ids = (await tokenizer.encodeSample(passage)).slice(0, passageBudget)
      return [CLS_ID, ...queryIds, SEP_ID, ...ids, SEP_ID]
    })
  )
  const width = Math.max(...rows.map((row) => row.length))
  const inputIds = new BigInt64Array(rows.length * width).fill(BigInt(PAD_ID))
  const mask = new BigInt64Array(rows.length * width).fill(0n)
  rows.forEach((row, r) => {
    row.forEach((id, c) => {
      inputIds[r * width + c] = BigInt(id)
      mask[r * width + c] = 1n
    })
  })
  const output = await session.run({
    input_ids: new ort.Tensor("int64", inputIds, [rows.length, width]),
    attention_mask: new ort.Tensor("int64", mask, [rows.length, width])
  })
  return Array.from((await output.logits.getData()) as Float32Array).map(sigmoid)
}

const post = (reply: RerankReply) => parentPort?.postMessage(reply)

const main = async () => {
  try {
    const [loaded] = await Promise.all([
      ort.InferenceSession.create(modelPath, { executionProviders: ["wasm"] }),
      tokenizer.loadModel()
    ])
    session = loaded
    post({ ready: true })
  } catch (error) {
    post({ ready: false, error: messageOf(error) })
    return
  }

  parentPort?.on("message", (request: RerankRequest) => {
    score(request.query, request.passages)
      .then((scores) => post({ id: request.id, scores }))
      .catch((error) =>
        post({ id: request.id, error: messageOf(error) })
      )
  })
}

void main()
