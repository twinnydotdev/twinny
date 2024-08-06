import * as ort from 'onnxruntime-web'
import * as path from 'path'
import { Toxe } from 'toxe'
import { Logger } from '../common/logger'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
ort.env.wasm.numThreads = 1

const logger = new Logger()

export class Reranker {
  private _tokenizer: Toxe | null
  private _session: ort.InferenceSession | null

  constructor() {
    this._tokenizer = null
    this._session = null
    this.init()
  }

  public async init() {
    try {
      await this.loadModel()
      const modelPath = path.join(__dirname, 'models', 'spm.model')
      logger.log('Loading tokenizer...')
      this._tokenizer = new Toxe(modelPath)
      console.log('Tokenizer loaded')
    } catch (error) {
      console.error('Error loading tokenizer:', error)
    }
  }

  public sigmoid(value: number) {
    return 1 / (1 + Math.exp(-value))
  }

  public async rerank(sample: string, samples: string[]) {
    const ids = await this._tokenizer?.encode(sample, samples)
    if (!ids?.length) return
    const buffer = new ArrayBuffer(ids.length * 8)
    const inputIdsBigInt64Array = new BigInt64Array(buffer)
    const inputIds = ids.map((id) => BigInt(id))
    inputIdsBigInt64Array.set(inputIds)

    const inputTensor = new ort.Tensor('int64', BigInt64Array.from(inputIds), [
      samples.length,
      inputIds.length / samples.length
    ])

    const attentionMaskTensor = new ort.Tensor(
      'int64',
      new BigInt64Array(inputIds.length).fill(1n),
      [samples.length, inputIds.length / samples.length]
    )

    const output = await this._session?.run({
      input_ids: inputTensor,
      attention_mask: attentionMaskTensor
    })

    if (!output) return []

    const data = await output.logits.getData()

    const probabilities = Array.prototype.slice.call(data).map(this.sigmoid)

    logger.log(`Reranked samples: \n
      ${Array.from(new Set(samples))
        .map((s, i) => `${i + 1}. ${s}: ${probabilities[i].toFixed(3)}`.trim())
        .join('\n')}
    `.trim())

    return probabilities
  }

  public async loadModel() {
    try {
      const modelPath = path.join(__dirname, 'models', 'reranker.onnx')
      console.log(`Loading model from ${modelPath}`)
      this._session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['wasm']
      })
      logger.log(`Model loaded from ${modelPath}`)
    } catch (e) {
      console.error('Error loading model', e)
    }
  }
}
