import * as fs from "fs"
import ignore from "ignore"
import * as path from "path"
import * as vscode from "vscode"

import { EVENT_NAME } from "../common/constants"
import { ServerMessage } from "../common/types"

export class FileHandler {
  constructor(private readonly _webview: vscode.Webview) {
    this.registerHandlers()
  }

  private getIgnoreHandler(): ReturnType<typeof ignore> {
    const ig = ignore()
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath

    if (rootPath) {
      const gitIgnorePath = path.join(rootPath, ".gitignore")
      if (fs.existsSync(gitIgnorePath)) {
        ig.add(fs.readFileSync(gitIgnorePath).toString())
      }
    }

    ig.add([".git", ".gitignore", "node_modules", "*.log", "dist", "build"])

    return ig
  }

  private async getClosestFilePathMatch(
    targetPath: string
  ): Promise<string | undefined> {
    if (!vscode.workspace.workspaceFolders) {
      return undefined
    }

    const files = await vscode.workspace.findFiles("**/*")
    const ig = this.getIgnoreHandler()

    const filePaths = files
      .map((file) => vscode.workspace.asRelativePath(file))
      .filter((relativePath) => !ig.ignores(relativePath))

    if (filePaths.length === 0) {
      return undefined
    }

    const targetParts = path
      .basename(targetPath)
      .replace(/\.[^/.]+$/, "")
      .split(/[^a-zA-Z0-9]+/)
    const matchingPath = filePaths.find((p) => {
      const fileName = path.basename(p).replace(/\.[^/.]+$/, "")
      return targetParts.every((part) =>
        fileName.toLowerCase().includes(part.toLowerCase())
      )
    })

    if (matchingPath) {
      return matchingPath
    }

    const dirMatch = filePaths.find((p) => {
      const normalizedTarget = targetPath.toLowerCase()
      const normalizedPath = p.toLowerCase()
      return (
        normalizedPath.includes(normalizedTarget) ||
        normalizedTarget.includes(normalizedPath)
      )
    })

    return dirMatch
  }

  public async handleOpenFile(message: ServerMessage<string>) {
    const filePath = message.data
    if (filePath && vscode.workspace.workspaceFolders) {
      const fullPath = path.join(
        vscode.workspace.workspaceFolders[0].uri.fsPath,
        filePath
      )
      try {
        const doc = await vscode.workspace.openTextDocument(fullPath)
        await vscode.window.showTextDocument(doc)
      } catch (error) {
        console.error(`Error opening file ${filePath}:`, error)

        const similarFile = await this.getClosestFilePathMatch(filePath)
        if (similarFile) {
          const similarFullPath = path.join(
            vscode.workspace.workspaceFolders[0].uri.fsPath,
            similarFile
          )
          try {
            const doc = await vscode.workspace.openTextDocument(similarFullPath)
            await vscode.window.showTextDocument(doc)
            vscode.window.showInformationMessage(
              `File "${filePath}" not found. Opened similar file: "${similarFile}"`
            )
          } catch (innerError) {
            console.error(
              `Error opening similar file ${similarFile}:`,
              innerError
            )
          }
        } else {
          vscode.window.showInformationMessage(
            `File "${filePath}" not found and no similar files found.`
          )
        }
      }
    } else {
      vscode.window.showInformationMessage("No workspace open.")
    }
  }

  public registerHandlers() {
    this._webview.onDidReceiveMessage(
      async (message: ServerMessage<string>) => {
        if (message.type === EVENT_NAME.twinnyOpenFile) {
          await this.handleOpenFile(message as ServerMessage<string>)
        }
      }
    )
  }
}
