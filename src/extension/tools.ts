import * as path from "path"
import * as vscode from "vscode"

import { FileTreeProvider } from "./tree"

interface CreateFileArgs {
  path: string
  content: string
  openAfterCreate?: boolean
}

interface RunCommandArgs {
  command: string
  cwd?: string
}

interface RenameFileArgs {
  oldPath: string
  newPath: string
}

export class Tools {
  private _fileTreeProvider: FileTreeProvider
  private _workspaceRoot: string

  constructor() {
    this._fileTreeProvider = new FileTreeProvider()

    const workspaceFolders = vscode.workspace.workspaceFolders
    if (!workspaceFolders) {
      throw new Error("No workspace folder open")
    }
    this._workspaceRoot = workspaceFolders[0].uri.fsPath
  }

  async getWorkspaceTree(): Promise<string> {
    return new Promise((resolve) => resolve(this._fileTreeProvider.getWorkSpaceTree()))
  }

  async createFile(args: CreateFileArgs): Promise<string> {
    const { path: filePath, content, openAfterCreate = false } = args

    const fullPath = path.join(this._workspaceRoot, filePath)
    const uri = vscode.Uri.file(fullPath)

    try {
      const ws = new vscode.WorkspaceEdit()
      ws.createFile(uri, { overwrite: false })
      await vscode.workspace.applyEdit(ws)

      const enc = new TextEncoder()
      await vscode.workspace.fs.writeFile(uri, enc.encode(content))

      if (openAfterCreate) {
        const doc = await vscode.workspace.openTextDocument(uri)
        await vscode.window.showTextDocument(doc)
      }

      return `File created successfully at ${fullPath}`
    } catch (error) {
      throw new Error(
        `Failed to create file: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  async runCommand(args: RunCommandArgs): Promise<string> {
    const { command, cwd = this._workspaceRoot } = args

    return new Promise((resolve, reject) => {
      const terminal = vscode.window.createTerminal({
        name: "Extension Command",
        cwd: cwd
      })

      let output = ""
      const channel = vscode.window.createOutputChannel("Command Output")

      const writeEmitter = new vscode.EventEmitter<string>()

      const disposable = vscode.window.onDidCloseTerminal((closedTerminal) => {
        if (closedTerminal === terminal) {
          if (closedTerminal.exitStatus?.code === 0) {
            channel.dispose()
            resolve(output)
          } else {
            channel.dispose()
            reject(
              new Error(
                `Command failed with exit code ${closedTerminal.exitStatus?.code}`
              )
            )
          }
          disposable.dispose()
        }
      })

      writeEmitter.event((data) => {
        output += data
        channel.append(data)
      })

      terminal.sendText(command, true)
      terminal.show()

      resolve("Command executed successfully!")
    })
  }

  async renameFile(args: RenameFileArgs): Promise<void> {
    const { oldPath, newPath } = args

    const oldUri = vscode.Uri.file(path.join(this._workspaceRoot, oldPath))
    const newUri = vscode.Uri.file(path.join(this._workspaceRoot, newPath))

    try {
      const ws = new vscode.WorkspaceEdit()
      ws.renameFile(oldUri, newUri)
      const success = await vscode.workspace.applyEdit(ws)

      if (!success) {
        throw new Error("Workspace edit failed")
      }
    } catch (error) {
      throw new Error(
        `Failed to rename file: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }
}
