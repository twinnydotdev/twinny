import * as ort from 'onnxruntime-web'
import * as path from 'path'
import { Transumter } from '../../pkg'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
ort.env.wasm.numThreads = 1

export const getTransmuter = async () => {
  const module = await import('../../pkg')
  return module
}

export class Reranker {
  private _modelName: string
  private _modelPath: string
  private _tokenizer: Transumter | null

  constructor(modelName: string) {
    this._tokenizer = null
    this._modelName = modelName
    this._modelPath = path.join(__dirname, 'models', `${this._modelName}`)
    this.loadModel()
    this.loadTokenizer()
  }

  public tokenizeInput() {
    this._tokenizer?.encode('Hello world!', true)
  }

  public async loadTokenizer() {
    try {
      const transmuter = await getTransmuter()
      const tokenizerJson = await fetch(`${this._modelPath}/tokenizer.json`)
      this._tokenizer = new transmuter.Transumter(await tokenizerJson.json())
    } catch (error) {
      console.error('Error loading tokenizer:', error)
    }
  }

  public async loadModel() {
    const onnxPath = `${this._modelPath}/model.onnx`
    const session = await ort.InferenceSession.create(onnxPath, {
      executionProviders: ['wasm']
    })
    return session
  }
}
