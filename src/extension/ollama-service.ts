import { workspace } from 'vscode'
import { Logger } from '../common/logger'

export class OllamaService {
  private logger: Logger
  private _config = workspace.getConfiguration('twinny')
  private _apiHostname = this._config.get('apiHostname') as string
  private _chatApiPort = this._config.get('chatApiPort') as string
  private _fimApiPort = this._config.get('fimApiPort') as string
  private _useTls = this._config.get('useTls') as boolean
  private _baseUrlChat: string
  private _baseUrlFim: string

  constructor() {
    this.logger = new Logger()
    const useTls = this._useTls
    const protocol = useTls ? 'https' : 'http'
    this._baseUrlChat = `${protocol}://${this._apiHostname}:${this._chatApiPort}`
    this._baseUrlFim = `${protocol}://${this._apiHostname}:${this._fimApiPort}`
  }

  public fetchModels = async (resource = '/api/tags') => {
    const chatModelsRes = (await fetch(this._baseUrlChat + resource)) || []
    const fimModelsRes = await fetch(this._baseUrlFim + resource)
    const { models: chatModels } = await chatModelsRes.json()
    const { models: fimModels } = await fimModelsRes.json()
    const models = new Set()
    if (Array.isArray(chatModels)) {
      for (const model of chatModels) {
        models.add(model)
      }
    }
    if (Array.isArray(fimModels)) {
      for (const model of fimModels) {
        models.add(model)
      }
    }
    return Array.from(models)
  }
}
