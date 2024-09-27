import { workspace } from 'vscode'
import { window as vswindow } from 'vscode'

const output = vswindow.createOutputChannel("Twinny", "log")

export class Logger {
  _config = workspace.getConfiguration('twinny')
  _debugEnabled = this._config.get('enableLogging') as boolean

  _date = new Date();
  _hour = this._date.toLocaleTimeString("en-US", {
    hour: '2-digit',
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  public log = (message: string) => {
    if (!this._debugEnabled) return
    if (!output) vswindow.showErrorMessage("Error getting the output channel from VS Code")

    output.appendLine(`${this._date.toLocaleDateString()} ${this._hour} INFO ${message}`)
  }

  public error = (err: NodeJS.ErrnoException) => {
    if (!this._debugEnabled) return
    if (!output) vswindow.showErrorMessage("Error getting the output channel from VS Code")

    output.appendLine(`${this._date.toLocaleDateString()} ${this._hour} ERROR ${err.message}`)
  }

  public updateConfig() {
    this._config = workspace.getConfiguration('twinny')
    this._debugEnabled = this._config.get('enableLogging') as boolean
  }
}
