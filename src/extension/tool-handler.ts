import { distance } from "fastest-levenshtein"
import * as vscode from "vscode"

import { EVENT_NAME } from "../common/constants"
import { ToolUse } from "../common/parse-assistant-message"
import { ServerMessage } from "../common/types"

interface ReplaceInFileToolUse extends ToolUse {
  name: "replace_in_file"
  params: {
    path?: string
    diff?: string
    fuzzyThreshold?: number
  }
}

const DEFAULT_FUZZY_THRESHOLD = 0.9 // 90% similarity required by default

function getSimilarity(original: string, search: string): number {
  if (search === "") return 1

  // Normalize strings by removing extra whitespace but preserve case
  const normalizeStr = (str: string) => str.replace(/\s+/g, " ").trim()
  const normalizedOriginal = normalizeStr(original)
  const normalizedSearch = normalizeStr(search)

  if (normalizedOriginal === normalizedSearch) return 1

  // Calculate Levenshtein distance
  const dist = distance(normalizedOriginal, normalizedSearch)

  // Calculate similarity ratio (0 to 1, where 1 is exact match)
  const maxLength = Math.max(normalizedOriginal.length, normalizedSearch.length)
  return 1 - dist / maxLength
}

export class ToolHandler {
  constructor(private readonly _webview: vscode.Webview) {
    this.registerHandlers()
  }

  private async handleReplaceInFile(toolUse: ReplaceInFileToolUse) {
    const {
      path,
      diff,
      fuzzyThreshold = DEFAULT_FUZZY_THRESHOLD
    } = toolUse.params

    if (!path || !diff) {
      vscode.window.showErrorMessage("Missing required parameters for replace_in_file")
      return
    }

    try {
      // Get the workspace folder
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
      if (!workspaceFolder) {
        vscode.window.showErrorMessage("No workspace folder open")
        return
      }

      // Get the full file path
      const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, path)

      // Read the file content
      const document = await vscode.workspace.openTextDocument(fullPath)
      let content = document.getText()

      // Find all diff blocks using regex
      const diffBlockRegex = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g
      const diffBlocks = Array.from(diff.matchAll(diffBlockRegex))

      if (diffBlocks.length === 0) {
        vscode.window.showErrorMessage("No valid diff blocks found")
        return
      }

      // Process each diff block
      for (const [, searchContent, replaceContent] of diffBlocks) {
        // Split content into lines for line-by-line comparison
        const searchLines = searchContent.split("\n")
        const contentLines = content.split("\n")

        // Find best matching position using fuzzy search
        let bestMatchStart = -1
        let bestMatchScore = 0
        let bestMatchLength = 0

        for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
          const contentChunk = contentLines
            .slice(i, i + searchLines.length)
            .join("\n")
          const similarity = getSimilarity(contentChunk, searchContent)

          if (similarity > bestMatchScore) {
            bestMatchScore = similarity
            bestMatchStart = i
            bestMatchLength = contentChunk.length
          }
        }

        // If no match meets the threshold, show warning and continue to next block
        if (bestMatchScore < fuzzyThreshold) {
          vscode.window.showWarningMessage(
            `Skipping block - No sufficiently similar match found (${Math.floor(
              bestMatchScore * 100
            )}% similar, needs ${Math.floor(fuzzyThreshold * 100)}%)`
          )
          continue
        }

        // Calculate the character position from line number
        let matchPosition = 0
        for (let i = 0; i < bestMatchStart; i++) {
          matchPosition += contentLines[i].length + 1 // +1 for newline
        }

        // Preserve indentation of the first line
        const originalIndent = contentLines[bestMatchStart].match(/^[\t ]*/)?.[0] || ""
        const replaceLines = replaceContent.split("\n")
        const indentedReplaceContent = replaceLines
          .map((line, i) => (i === 0 ? line : originalIndent + line))
          .join("\n")

        // Update the content with the replacement
        content =
          content.substring(0, matchPosition) +
          indentedReplaceContent +
          content.substring(matchPosition + bestMatchLength)

        vscode.window.showInformationMessage(
          `Applied change block (${Math.floor(bestMatchScore * 100)}% match)`
        )
      }

      // Create and apply the final edit
      const edit = new vscode.WorkspaceEdit()
      edit.replace(
        fullPath,
        new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length)
        ),
        content
      )

      const success = await vscode.workspace.applyEdit(edit)
      if (!success) {
        vscode.window.showErrorMessage("Failed to apply edits")
        return
      }

      vscode.window.showInformationMessage(
        `Successfully applied all changes (${diffBlocks.length} blocks)`
      )
    } catch (error) {
      vscode.window.showErrorMessage(`Error applying changes: ${error}`)
    }
  }

  private async handleAcceptToolUse(message: ServerMessage<ToolUse>) {
    const toolUse = message.data
    if (!toolUse) return

    switch (toolUse.name) {
      case "replace_in_file":
        await this.handleReplaceInFile(toolUse as ReplaceInFileToolUse)
        // Save the file after applying changes
        await this.openAndSaveFile(toolUse.params.path)
        break
      default:
        vscode.window.showErrorMessage(`Unsupported tool: ${toolUse.name}`)
    }
  }

  private async openAndSaveFile(path?: string) {
    if (!path) {
      vscode.window.showErrorMessage("No file path provided for saving")
      return
    }

    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
      if (!workspaceFolder) {
        vscode.window.showErrorMessage("No workspace folder open")
        return
      }

      const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, path)
      const document = await vscode.workspace.openTextDocument(fullPath)
      // Open the document in the editor if it's not already opened
      await vscode.window.showTextDocument(document, { preview: false })
      await document.save()
      vscode.window.showInformationMessage(`File saved: ${path}`)
    } catch (error) {
      vscode.window.showErrorMessage(`Error saving file: ${error}`)
    }
  }

  public registerHandlers() {
    this._webview.onDidReceiveMessage(
      async (message: ServerMessage<ToolUse>) => {
        switch (message.type) {
          case EVENT_NAME.twinnyAcceptToolUse:
            await this.handleAcceptToolUse(message)
            break
          case EVENT_NAME.twinnyRejectToolUse:
            // Handle rejection if needed
            break
        }
      }
    )
  }
}
