import * as ort from 'onnxruntime-web'
import * as path from 'path'
import { Toxe } from 'toxe'
import { Logger } from '../common/logger'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
ort.env.wasm.numThreads = 1

const logger = new Logger()

export class Reranker {
  private _tokenizer: Toxe | null = null
  private _session: ort.InferenceSession | null = null
  private readonly _modelPath: string
  private readonly _tokenizerPath: string

  constructor() {
    this._modelPath = path.join(__dirname, '..', 'models', 'reranker.onnx')
    this._tokenizerPath = path.join(__dirname, '..', 'models', 'spm.model')
    this.init()
  }

  public async init(): Promise<void> {
    try {
      await Promise.all([this.loadModel(), this.loadTokenizer()])
      logger.log('Reranker initialized successfully')
    } catch (error) {
      console.error(error)
    }
  }

  public sigmoid(value: number) {
    return 1 / (1 + Math.exp(-value))
  }

  public async rerank(sample: string, samples: string[]): Promise<number[] | undefined> {
    const ids = await this._tokenizer?.encode(sample, samples);
    if (!ids?.length) return undefined;

    const inputIds = ids.map((id) => BigInt(id));
    const inputTensor = new ort.Tensor('int64', BigInt64Array.from(inputIds), [
      samples.length,
      inputIds.length / samples.length
    ]);

    const attentionMaskTensor = new ort.Tensor(
      'int64',
      new BigInt64Array(inputIds.length).fill(1n),
      [samples.length, inputIds.length / samples.length]
    );

    const output = await this._session?.run({
      input_ids: inputTensor,
      attention_mask: attentionMaskTensor
    });

    if (!output) return undefined;

    const data = await output.logits.getData();
    const logits = Array.prototype.slice.call(data);

    const normalizedProbabilities = this.softmax(logits);

    logger.log(
      `Reranked samples: \n${this.formatResults(samples, normalizedProbabilities)}`
    );

    return normalizedProbabilities;
  }

  private softmax(logits: number[]): number[] {
    const maxLogit = Math.max(...logits);
    const scores = logits.map(l => Math.exp(l - maxLogit));
    const sum = scores.reduce((a, b) => a + b, 0);
    return scores.map(s => s / sum);
  }

  private formatResults(samples: string[], probabilities: number[]): string {
    return Array.from(new Set(samples))
      .map((s, i) => `${i + 1}. ${s}: ${probabilities[i].toFixed(3)}`.trim())
      .join('\n')
  }

  private async loadModel(): Promise<void> {
    try {
      this._session = await ort.InferenceSession.create(this._modelPath, {
        executionProviders: ['wasm']
      })
      logger.log(`Model loaded from ${this._modelPath}`)
    } catch (error) {
      console.error('Error loading model:', error)
      throw error
    }
  }

  private async loadTokenizer(): Promise<void> {
    try {
      logger.log('Loading tokenizer...')
      this._tokenizer = new Toxe(this._tokenizerPath)
      logger.log('Tokenizer loaded')
    } catch (error) {
      console.error('Error loading tokenizer:', error)
      throw error
    }
  }
}
