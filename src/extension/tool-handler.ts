import * as cp from "child_process"
import { distance } from "fastest-levenshtein"
import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"
import Parser from "web-tree-sitter"

import { EVENT_NAME } from "../common/constants"
import { ToolUse } from "../common/parse-assistant-message"
import { ServerMessage } from "../common/types"

import { getParser } from "./parser"

interface ReplaceInFileToolUse extends ToolUse {
  name: "replace_in_file"
  params: {
    path?: string
    diff?: string
    fuzzyThreshold?: number
  }
}

interface ListCodeDefinitionNamesToolUse extends ToolUse {
  name: "list_code_definition_names"
  params: {
    path?: string
  }
}

interface ExecuteCommandToolUse extends ToolUse {
  name: "execute_command"
  params: {
    command: string
  }
}

interface WriteToFileToolUse extends ToolUse {
  name: "write_to_file"
  params: {
    path: string
    content: string
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
      vscode.window.showErrorMessage(
        "Missing required parameters for replace_in_file"
      )
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
      const diffBlockRegex =
        /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g
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
        const originalIndent =
          contentLines[bestMatchStart].match(/^[\t ]*/)?.[0] || ""
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
      case "list_code_definition_names":
        await this.handleListCodeDefinitionNames(
          toolUse as ListCodeDefinitionNamesToolUse
        )
        break
      case "execute_command":
        await this.handleExecuteCommand(toolUse as ExecuteCommandToolUse)
        break
      case "write_to_file":
        await this.handleWriteToFile(toolUse as WriteToFileToolUse)
        break
      default:
        vscode.window.showErrorMessage(`Unsupported tool: ${toolUse.name}`)
    }
  }

  private async handleWriteToFile(toolUse: WriteToFileToolUse) {
    const { path, content } = toolUse.params

    if (!path || content === undefined) {
      vscode.window.showErrorMessage(
        "Missing required parameters for write_to_file"
      )
      return
    }

    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
      if (!workspaceFolder) {
        vscode.window.showErrorMessage("No workspace folder open")
        return
      }

      const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, path)
      const writeData = Buffer.from(content, "utf8")
      await vscode.workspace.fs.writeFile(fullPath, writeData)

      vscode.window.showInformationMessage(`File written successfully: ${path}`)

      // Send the result back to the webview
      this._webview.postMessage({
        type: EVENT_NAME.twinnyToolUseResult,
        data: {
          name: "write_to_file",
          result: `File written successfully: ${path}`
        }
      })
    } catch (error) {
      vscode.window.showErrorMessage(`Error writing file: ${error}`)
    }
  }

  private async handleExecuteCommand(toolUse: ExecuteCommandToolUse) {
    const { command } = toolUse.params

    if (!command) {
      vscode.window.showErrorMessage(
        "Missing required parameter 'command' for execute_command"
      )
      return
    }

    try {
      const { stdout, stderr } = await new Promise<{
        stdout: string
        stderr: string
      }>((resolve, reject) => {
        cp.exec(
          command,
          { cwd: vscode.workspace.rootPath },
          (error, stdout, stderr) => {
            if (error) {
              reject(error)
            } else {
              resolve({ stdout, stderr })
            }
          }
        )
      })

      const result = stdout || stderr
      vscode.window.showInformationMessage(
        `Command executed successfully: ${command}`
      )

      // Send the result back to the webview
      this._webview.postMessage({
        type: EVENT_NAME.twinnyToolUseResult,
        data: {
          name: "execute_command",
          result: result
        }
      })
    } catch (error) {
      vscode.window.showErrorMessage(`Error executing command: ${error}`)
    }
  }

  private async handleListCodeDefinitionNames(
    toolUse: ListCodeDefinitionNamesToolUse
  ) {
    const { path: directoryPath } = toolUse.params

    if (!directoryPath) {
      vscode.window.showErrorMessage(
        "Missing required parameter 'path' for list_code_definition_names"
      )
      return
    }

    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
      if (!workspaceFolder) {
        vscode.window.showErrorMessage("No workspace folder open")
        return
      }

      const fullPath = vscode.Uri.joinPath(
        workspaceFolder.uri,
        directoryPath
      ).fsPath
      const definitions = await this.getCodeDefinitions(fullPath)

      // Send the result back to the webview
      this._webview.postMessage({
        type: EVENT_NAME.twinnyToolUseResult,
        data: {
          name: "list_code_definition_names",
          result: definitions.join("\n")
        }
      })
    } catch (error) {
      vscode.window.showErrorMessage(`Error listing code definitions: ${error}`)
    }
  }

  private async getCodeDefinitions(directoryPath: string): Promise<string[]> {
    const definitions: string[] = []

    const files = await this.getFilesRecursively(directoryPath)
    for (const file of files) {
      const parser = await getParser(file)
      if (parser) {
        const content = await fs.promises.readFile(file, "utf8")
        const tree = parser.parse(content)
        const fileDefinitions = this.extractDefinitions(
          tree.rootNode,
          path.basename(file)
        )
        definitions.push(...fileDefinitions)
      }
    }

    return definitions
  }

  private async getFilesRecursively(dir: string): Promise<string[]> {
    const dirents = await fs.promises.readdir(dir, { withFileTypes: true })
    const files = await Promise.all(
      dirents.map((dirent) => {
        const res = path.resolve(dir, dirent.name)
        return dirent.isDirectory() ? this.getFilesRecursively(res) : res
      })
    )
    return Array.prototype.concat(...files)
  }

  private extractDefinitions(
    node: Parser.SyntaxNode,
    fileName: string
  ): string[] {
    const definitions: string[] = []

    if (this.isDefinition(node)) {
      const name = this.getDefinitionName(node)
      if (name) {
        definitions.push(`${fileName}: ${node.type} ${name}`)
      }
    }

    for (const child of node.children) {
      definitions.push(...this.extractDefinitions(child, fileName))
    }

    return definitions
  }

  private isDefinition(node: Parser.SyntaxNode): boolean {
    const definitionTypes = [
      "function_declaration",
      "method_definition",
      "class_declaration",
      "interface_declaration",
      "enum_declaration",
      "const_declaration",
      "variable_declaration"
    ]
    return definitionTypes.includes(node.type)
  }

  private getDefinitionName(node: Parser.SyntaxNode): string | null {
    const nameNode = node.childForFieldName("name")
    return nameNode ? nameNode.text : null
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
