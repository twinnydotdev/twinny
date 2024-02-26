import { workspace } from 'vscode'
import { Logger } from '../common/logger'
import { OllamaModels } from '../common/types'

export class OllamaService {
  private logger : Logger
  private _config = workspace.getConfiguration('twinny')
  private _apiHostname = this._config.get('apiHostname') as string
  private _chatApiPort = this._config.get('chatApiPort') as string
  private _fimApiPort = this._config.get('fimApiPort') as string
  private _useTls = this._config.get('useTls') as boolean
  private _baseUrl: string

  constructor () {
    this.logger = new Logger()
    const useTls = this._useTls;
    const port = this._chatApiPort || this._fimApiPort
    const protocol = useTls ? 'https' : 'http';
    this._baseUrl = `${protocol}://${this._apiHostname}:${port}`
  }

  public fetchModels = async (): Promise<OllamaModels> => {
    const res = await fetch(this._baseUrl + '/api/tags')
    if (!res.ok) {
      this.logger.error(new Error(`${res.status}`))
      throw Error('Failed to get ollama models')
    }
    return await res.json()
  }
}
