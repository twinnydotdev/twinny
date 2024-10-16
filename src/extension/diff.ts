import * as path from "path"
import * as vscode from "vscode"

import { ClientMessage } from "../common/types"

export class DiffManager {
  private _originalUri: vscode.Uri | undefined
  private _modifiedUri: vscode.Uri | undefined
  private _originalEditor: vscode.TextEditor | undefined
  private _tempDir: string | undefined

  private getFileExtension(document: vscode.TextDocument): string {
    const fileName = document.fileName
    const extension = path.extname(fileName)
    return extension ? extension.slice(1) : "txt"
  }

  private async cleanupTempFiles() {
    if (this._originalUri && this._modifiedUri && this._tempDir) {
      try {
        await vscode.workspace.fs.delete(this._originalUri)
        await vscode.workspace.fs.delete(this._modifiedUri)
        await vscode.workspace.fs.delete(vscode.Uri.file(this._tempDir), { recursive: true })
      } catch (error) {
        console.error("Error cleaning up temporary files:", error)
      }
    }
  }

  public async openDiff(message: ClientMessage) {
    const editor = vscode.window.activeTextEditor
    if (!editor) return

    const selection = editor.selection
    const text = editor.document.getText(selection)

    if (!text) return

    const fileExtension = this.getFileExtension(editor.document)

    this._tempDir = path.join(
      vscode.workspace.workspaceFolders?.[0].uri.fsPath || "",
      "tmp",
      Date.now().toString() // Add timestamp to ensure uniqueness
    )
    this._originalUri = vscode.Uri.file(
      path.join(this._tempDir, `original.${fileExtension}`)
    )
    this._modifiedUri = vscode.Uri.file(
      path.join(this._tempDir, `proposed.${fileExtension}`)
    )
    this._originalEditor = editor

    await vscode.workspace.fs.createDirectory(vscode.Uri.file(this._tempDir))

    await vscode.workspace.fs.writeFile(
      this._originalUri,
      Buffer.from(text, "utf8")
    )
    await vscode.workspace.fs.writeFile(
      this._modifiedUri,
      Buffer.from(message.data as string, "utf8")
    )

    const title = `Original ↔ Modified (${fileExtension})`
    const options: vscode.TextDocumentShowOptions = {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: false,
    }

    await vscode.commands.executeCommand(
      "vscode.diff",
      this._originalUri,
      this._modifiedUri,
      title,
      options
    )

    // Set up a listener to clean up temp files when the diff editor is closed
    const disposable = vscode.window.onDidChangeVisibleTextEditors(async (editors) => {
      const diffEditorOpen = editors.some(e => e.document.uri.scheme === "diff")
      if (!diffEditorOpen) {
        await this.cleanupTempFiles()
        disposable.dispose()
      }
    })
  }

  public async acceptSolution(message: ClientMessage) {
    if (this._originalEditor) {
      const diffEditor = vscode.window.activeTextEditor
      if (diffEditor && diffEditor.document.uri.scheme === "diff") {
        await vscode.commands.executeCommand(
          "workbench.action.closeActiveEditor"
        )
      }
      await this._originalEditor.edit((editBuilder: vscode.TextEditorEdit) => {
        const selection = this._originalEditor?.selection
        if (!selection) return
        editBuilder.replace(selection, message.data as string)
      })
      await this.cleanupTempFiles()
    } else {
      const editor = vscode.window.activeTextEditor
      await editor?.edit((editBuilder: vscode.TextEditorEdit) => {
        const selection = editor?.selection
        if (!selection) return
        editBuilder.replace(selection, message.data as string)
      })
    }
  }
}
