import fs from "fs"
import os from "os"
import * as path from "path"
import { Worker } from "worker_threads"

import { logger } from "../../common/logger"

import { RerankReply, RerankRequest, RerankWorkerData } from "./rerank-worker"

/** Workers idle this long are shut down; the next search reloads them (~0.7s). */
const IDLE_MS = 5 * 60_000
/** Each worker holds its own copy of the model (~150 MB), so few of them. */
const POOL_SIZE = Math.min(3, Math.max(1, Math.floor(os.cpus().length / 4)))

interface PoolWorker {
  worker: Worker
  ready: Promise<boolean>
  pending: Map<number, { resolve: (scores: number[]) => void; reject: (error: Error) => void }>
}

/**
 * A cross-encoder that reads the question and a candidate chunk together
 * and says how likely the chunk is to answer it. Unlike a vector distance
 * the score is absolute, so a threshold means the same thing whatever else
 * was in the candidate list.
 *
 * Scoring runs in worker threads (see `rerank-worker.ts`) so the extension
 * host stays responsive, and a candidate list is split across the pool.
 */
export class Reranker {
  private readonly _data: RerankWorkerData
  private readonly _script: string | undefined
  private _pool: PoolWorker[] = []
  private _idleTimer?: NodeJS.Timeout
  private _nextId = 1
  private _broken = false

  constructor(modelDir = path.join(__dirname, "..", "models")) {
    this._data = {
      modelPath: path.join(modelDir, "reranker.onnx"),
      tokenizerPath: path.join(modelDir, "spm.model"),
      wasmDir: Reranker.findWasmDir()
    }
    this._script = Reranker.findScript()
  }

  /** Where the worker bundle lives: next to this file in the bundle, or under the tsc tree. */
  private static findScript(): string | undefined {
    return [
      path.join(__dirname, "rerank-worker.js"),
      path.join(__dirname, "extension", "embeddings", "rerank-worker.js")
    ].find((candidate) => fs.existsSync(candidate))
  }

  /** Where onnxruntime's wasm is: the bundle root, or node_modules in development. */
  private static findWasmDir(): string {
    return (
      [
        __dirname,
        path.join(__dirname, "..", ".."),
        path.join(__dirname, "..", "..", "..", "node_modules", "onnxruntime-web", "dist")
      ].find((dir) => fs.existsSync(path.join(dir, "ort-wasm-simd.wasm"))) || __dirname
    )
  }

  /** Resolves true once the model is usable, false if it cannot be. */
  public get ready(): Promise<boolean> {
    return this.pool()[0]?.ready ?? Promise.resolve(false)
  }

  /**
   * One relevance probability (0..1) per passage, in input order, or
   * nothing when the model is unavailable so the caller can fall back to
   * the retrieval order.
   */
  public async rerank(query: string, passages: string[]): Promise<number[] | undefined> {
    if (!passages.length) return []
    const pool = this.pool()
    if (!pool.length || !(await pool[0].ready)) return undefined
    this.touch()

    // Spread the passages over the workers; each scores its share.
    const workers = pool.length
    const per = Math.ceil(passages.length / workers)
    const parts = Array.from({ length: workers }, (_, i) =>
      passages.slice(i * per, (i + 1) * per)
    ).filter((part) => part.length)
    try {
      const results = await Promise.all(
        parts.map((part, i) => this.send(pool[i], query, part))
      )
      return results.flat()
    } catch (error) {
      logger.error(`Reranking failed: ${error instanceof Error ? error.message : error}`)
      return undefined
    }
  }

  private send(entry: PoolWorker, query: string, passages: string[]): Promise<number[]> {
    return entry.ready.then((ok) => {
      if (!ok) throw new Error("reranker worker failed to load")
      const id = this._nextId++
      return new Promise<number[]>((resolve, reject) => {
        entry.pending.set(id, { resolve, reject })
        entry.worker.postMessage({ id, query, passages } satisfies RerankRequest)
      })
    })
  }

  private pool(): PoolWorker[] {
    if (this._broken || !this._script) return []
    if (!this._pool.length) {
      for (let i = 0; i < POOL_SIZE; i++) this._pool.push(this.spawn())
      this.touch()
    }
    return this._pool
  }

  private spawn(): PoolWorker {
    const worker = new Worker(this._script!, { workerData: this._data })
    const pending: PoolWorker["pending"] = new Map()
    const ready = new Promise<boolean>((resolve) => {
      const startedAt = Date.now()
      worker.on("message", (reply: RerankReply) => {
        if ("ready" in reply) {
          if (reply.ready) {
            logger.log(`Reranker worker ready in ${Date.now() - startedAt}ms`)
          } else {
            logger.error(`Reranker unavailable, results keep retrieval order: ${reply.error}`)
            this._broken = true
          }
          resolve(reply.ready)
          return
        }
        const request = pending.get(reply.id)
        pending.delete(reply.id)
        if (!request) return
        if ("scores" in reply) request.resolve(reply.scores)
        else request.reject(new Error(reply.error))
      })
      worker.on("error", (error) => {
        logger.error(`Reranker worker crashed: ${error.message}`)
        for (const request of pending.values()) request.reject(error)
        pending.clear()
        resolve(false)
      })
      worker.on("exit", () => {
        for (const request of pending.values()) request.reject(new Error("reranker worker exited"))
        pending.clear()
        resolve(false)
      })
    })
    return { worker, ready, pending }
  }

  private touch() {
    clearTimeout(this._idleTimer)
    this._idleTimer = setTimeout(() => this.shutdown(), IDLE_MS)
    this._idleTimer.unref?.()
  }

  /** Stops the workers; they are started again by the next search. */
  public shutdown() {
    clearTimeout(this._idleTimer)
    const pool = this._pool
    this._pool = []
    for (const entry of pool) void entry.worker.terminate()
  }

  public dispose() {
    this.shutdown()
  }
}
