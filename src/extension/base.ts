import * as vscode from "vscode"

export class Base {
  public config = vscode.workspace.getConfiguration("twinny")

  constructor () {
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("twinny")) {
        return
      }
      this.updateConfig()
    })
  }

  public updateConfig() {
    this.config = vscode.workspace.getConfiguration("twinny")
  }
}
