import { workspace } from "vscode"

export class Logger {
  private static instance: Logger
  private _config = workspace.getConfiguration("twinny")
  private _debugEnabled = this._config.get("enableLogging") as boolean

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger()
    }
    return Logger.instance
  }

  public log = (message: string) => {
    if (!this._debugEnabled) return
    console.log(`[twinny] ${message}`)
  }

  public error = (err: NodeJS.ErrnoException) => {
    if (!this._debugEnabled) return
    console.error(err.message)
  }

  public updateConfig() {
    this._config = workspace.getConfiguration("twinny")
    this._debugEnabled = this._config.get("enableLogging") as boolean
  }
}

export const logger = Logger.getInstance()
