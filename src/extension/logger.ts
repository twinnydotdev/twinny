import { workspace } from 'vscode'

const debugEnabled = workspace.getConfiguration('twinny').get('enableLogging')

export class Logger {
  _config = workspace.getConfiguration('twinny')
  _debugEnabled = this._config.get('enableLogging') as boolean

  constructor() {
    this._config = workspace.getConfiguration('twinny')
  }

  public log = (message: string) => {
    if (!debugEnabled) return
    console.log(message)
  }

  public error = (err: NodeJS.ErrnoException) => {
    if (!debugEnabled) return
    console.error(err.message)
  }

  public updateConfig() {
    this._config = workspace.getConfiguration('twinny')
    this._debugEnabled = this._config.get('debugEnabled') as boolean
  }
}
