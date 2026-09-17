import * as fs from "fs"
import ignore from "ignore"
import * as path from "path"
import * as vscode from "vscode"

import { EVENT_NAME } from "../../common/constants"
import { FileLocation } from "../../common/messaging/protocol"
import { workspacePathCandidates } from "../chat/context-files"
import { ExtensionBridge } from "../messaging/bridge"

export class FileHandler {
  constructor(private readonly _bridge: ExtensionBridge) {
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

  /**
   * Opens a workspace file, scrolled to and selecting the given lines when
   * there are any (a chunk the workspace search used, a pinned selection).
   */
  public async handleOpenFile(target: string | FileLocation) {
    const location: FileLocation =
      typeof target === "string" ? { path: target } : target
    const filePath = location.path
    if (filePath && vscode.workspace.workspaceFolders) {
      const candidates = workspacePathCandidates(
        filePath,
        vscode.workspace.workspaceFolders.map((folder) => ({
          name: folder.name,
          fsPath: folder.uri.fsPath
        }))
      ).map((candidate) => path.normalize(candidate))
      const fullPath =
        candidates.find((candidate) => fs.existsSync(candidate)) ??
        path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, filePath)
      try {
        const doc = await vscode.workspace.openTextDocument(fullPath)
        const editor = await vscode.window.showTextDocument(doc)
        if (location.startLine !== undefined) {
          const start = new vscode.Position(location.startLine, 0)
          const endLine = Math.min(
            location.endLine ?? location.startLine,
            Math.max(0, doc.lineCount - 1)
          )
          const end = doc.lineAt(endLine).range.end
          editor.selection = new vscode.Selection(start, end)
          editor.revealRange(
            new vscode.Range(start, end),
            vscode.TextEditorRevealType.InCenter
          )
        }
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
    this._bridge.handle(EVENT_NAME.twinnyOpenFile, (filePath) =>
      this.handleOpenFile(filePath)
    )
  }
}
