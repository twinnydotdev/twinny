import * as vscode from 'vscode'
import * as path from 'path'

import { ClientMessage } from '../common/types'

export class DiffManager {
  private originalUri: vscode.Uri | undefined
  private modifiedUri: vscode.Uri | undefined
  private originalEditor: vscode.TextEditor | undefined

  private getFileExtension(document: vscode.TextDocument): string {
    const fileName = document.fileName
    const extension = path.extname(fileName)
    return extension ? extension.slice(1) : 'txt'
  }

  public async openDiff(message: ClientMessage) {
    const editor = vscode.window.activeTextEditor
    if (!editor) return

    const selection = editor.selection
    const text = editor.document.getText(selection)

    if (!text) return

    const fileExtension = this.getFileExtension(editor.document)

    const tempDir = path.join(
      vscode.workspace.workspaceFolders?.[0].uri.fsPath || '',
      'tmp'
    )
    this.originalUri = vscode.Uri.file(
      path.join(tempDir, `original.${fileExtension}`)
    )
    this.modifiedUri = vscode.Uri.file(
      path.join(tempDir, `proposed.${fileExtension}`)
    )
    this.originalEditor = editor

    await vscode.workspace.fs.createDirectory(vscode.Uri.file(tempDir))

    await vscode.workspace.fs.writeFile(
      this.originalUri,
      Buffer.from(text, 'utf8')
    )
    await vscode.workspace.fs.writeFile(
      this.modifiedUri,
      Buffer.from(message.data as string, 'utf8')
    )

    const title = `Original ↔ Modified (${fileExtension})`
    const options: vscode.TextDocumentShowOptions = {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: false
    }

    await vscode.commands.executeCommand(
      'vscode.diff',
      this.originalUri,
      this.modifiedUri,
      title,
      options
    )
  }

  public async acceptSolution(message: ClientMessage) {
    if (!this.originalEditor) return

    const diffEditor = vscode.window.activeTextEditor
    if (diffEditor && diffEditor.document.uri.scheme === 'diff') {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
    }

    await this.originalEditor.edit((editBuilder: vscode.TextEditorEdit) => {
      const selection = this.originalEditor?.selection
      if (!selection) return
      editBuilder.replace(selection, message.data as string)
    })

    if (this.originalUri && this.modifiedUri) {
      await vscode.workspace.fs.delete(this.originalUri)
      await vscode.workspace.fs.delete(this.modifiedUri)
    }
  }
}
