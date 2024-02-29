import { workspace } from 'vscode'

export class Logger {
  _config = workspace.getConfiguration('twinny')
  _debugEnabled = this._config.get('enableLogging') as boolean

  public log = (message: string) => {
    if (!this._debugEnabled) return
    console.log(message)
  }

  public error = (err: NodeJS.ErrnoException) => {
    if (!this._debugEnabled) return
    console.error(err.message)
  }

  public updateConfig() {
    this._config = workspace.getConfiguration('twinny')
    this._debugEnabled = this._config.get('enableLogging') as boolean
  }
}
