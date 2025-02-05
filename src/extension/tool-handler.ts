import * as cp from "child_process"
import { distance } from "fastest-levenshtein"
import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"
import Parser from "web-tree-sitter"

import { EVENT_NAME } from "../common/constants"
import {
  ExecuteCommandToolUse,
  ListCodeDefinitionNamesToolUse,
  ReplaceInFileToolUse,
  ToolUse,
  WriteToFileToolUse
} from "../common/parse-assistant-message"
import { ServerMessage } from "../common/types"

import { Base } from "./base"
import { getParser } from "./parser"

const DEFAULT_FUZZY_THRESHOLD = 0.9

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

export class ToolHandler extends Base {
  constructor(
    context: vscode.ExtensionContext,
    private readonly _webview: vscode.Webview
  ) {
    super(context)
    this.registerHandlers()
  }

  private async handleReplaceInFile(toolUse: ReplaceInFileToolUse) {
    const { path, diff } = toolUse.params

    if (!path || !diff) {
      vscode.window.showErrorMessage(
        "Missing required parameters for replace_in_file"
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

      // Create directory structure if it doesn't exist
      const dirUri = vscode.Uri.joinPath(fullPath, "..")
      try {
        await vscode.workspace.fs.createDirectory(dirUri)
      } catch {
        // Ignore if directory already exists
      }

      // Modified regex to handle empty search content
      const diffBlockRegex =
        /<<<<<<< SEARCH\n?([\s\S]*?)\n?=======\n([\s\S]*?)\n>>>>>>> REPLACE/g
      const diffBlocks = Array.from(diff.matchAll(diffBlockRegex))

      if (diffBlocks.length === 0) {
        vscode.window.showErrorMessage("No valid diff blocks found")
        return
      }

      let content: string
      let isNewFile = false
      try {
        const document = await vscode.workspace.openTextDocument(fullPath)
        content = document.getText()
      } catch {
        // File doesn't exist, mark as new file
        isNewFile = true
        content = ""
      }

      // Process each diff block
      for (const [, searchContent, replaceContent] of diffBlocks) {
        // If file is new or search content is empty, just use replace content
        if (isNewFile || !searchContent.trim()) {
          content = replaceContent
          continue
        }

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
        if (bestMatchScore < DEFAULT_FUZZY_THRESHOLD) {
          vscode.window.showWarningMessage(
            `Skipping block - No sufficiently similar match found (${Math.floor(
              bestMatchScore * 100
            )}% similar, needs ${Math.floor(DEFAULT_FUZZY_THRESHOLD * 100)}%)`
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
      }

      // Write the final content
      if (isNewFile) {
        await vscode.workspace.fs.writeFile(fullPath, Buffer.from(content))
        vscode.window.showInformationMessage(
          "Successfully created new file with content"
        )
      } else {
        const document = await vscode.workspace.openTextDocument(fullPath)
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
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Error applying changes: ${error}`)
    }
  }

  public async handleAcceptToolUse(
    message: ServerMessage<ToolUse>
  ): Promise<string> {
    const toolUse = message.data
    if (!toolUse) return ""

    switch (toolUse.name) {
      case "replace_in_file":
        await this.handleReplaceInFile(toolUse as ReplaceInFileToolUse)
        // Save the file after applying changes
        return await this.openAndSaveFile(toolUse.params.path)
      case "list_code_definition_names":
        return await this.handleListCodeDefinitionNames(
          toolUse as ListCodeDefinitionNamesToolUse
        )
      case "read_files": {
        const paths = toolUse.params.paths?.split(",")
        return await this.handleReadFiles(paths)
      }
      case "execute_command":
        return await this.handleExecuteCommand(toolUse as ExecuteCommandToolUse)
      case "write_to_file":
        return await this.handleWriteToFile(toolUse as WriteToFileToolUse)
      default:
        vscode.window.showErrorMessage(`Unsupported tool: ${toolUse.name}`)
        return ""
    }
  }

  private async handleWriteToFile(
    toolUse: WriteToFileToolUse
  ): Promise<string> {
    const { path, content } = toolUse.params

    if (!path || content === undefined) {
      vscode.window.showErrorMessage(
        "Missing required parameters for write_to_file"
      )
      return "Missing required parameters for write_to_file"
    }

    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
      if (!workspaceFolder) {
        vscode.window.showErrorMessage("No workspace folder open")
        return "No workspace folder open"
      }

      const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, path)
      const writeData = Buffer.from(content, "utf8")
      await vscode.workspace.fs.writeFile(fullPath, writeData)

      vscode.window.showInformationMessage(`File written successfully: ${path}`)

      return `File written successfully: ${path}`
    } catch (error) {
      vscode.window.showErrorMessage(`Error writing file: ${error}`)
      return `Error writing file: ${error}`
    }
  }

  private async handleExecuteCommand(
    toolUse: ExecuteCommandToolUse
  ): Promise<string> {
    const { command } = toolUse.params

    if (!command) {
      vscode.window.showErrorMessage(
        "Missing required parameter 'command' for execute_command"
      )
      return ""
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
      const message = `Command executed successfully: ${command} : ${result}`
      this.emit("resolve-tool-result", message)
      return message
    } catch (error) {
      vscode.window.showErrorMessage(`Error executing command: ${error}`)
      return ""
    }
  }

  private async handleListCodeDefinitionNames(
    toolUse: ListCodeDefinitionNamesToolUse
  ): Promise<string> {
    const { path: directoryPath } = toolUse.params

    if (!directoryPath) {
      vscode.window.showErrorMessage(
        "Missing required parameter 'path' for list_code_definition_names"
      )
      return "Missing required parameter 'path' for list_code_definition_names"
    }

    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
      if (!workspaceFolder) {
        vscode.window.showErrorMessage("No workspace folder open")
        return "No workspace folder open"
      }

      const fullPath = vscode.Uri.joinPath(
        workspaceFolder.uri,
        directoryPath
      ).fsPath
      const definitions = await this.getCodeDefinitions(fullPath)

      return definitions.join("\n")
    } catch (error) {
      vscode.window.showErrorMessage(`Error listing code definitions: ${error}`)
      return `Error listing code definitions: ${error}`
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

  private async openAndSaveFile(path?: string): Promise<string> {
    if (!path) {
      vscode.window.showErrorMessage("No file path provided for saving")
      return "No file path provided for saving"
    }

    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
      if (!workspaceFolder) {
        vscode.window.showErrorMessage("No workspace folder open")
        return "No workspace folder open"
      }

      const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, path)
      const document = await vscode.workspace.openTextDocument(fullPath)
      // Open the document in the editor if it's not already opened
      await vscode.window.showTextDocument(document, { preview: false })
      await document.save()
      vscode.window.showInformationMessage(`File saved: ${path}`)
      return `File saved ${path}`
    } catch (error) {
      vscode.window.showErrorMessage(`Error saving file: ${error}`)
      return `Error saving file: ${error}`
    }
  }

  private async handleReadFiles(paths: string[] | undefined): Promise<string> {
    try {
      if (!paths?.length) return "No files provided for reading"
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
      if (!workspaceFolder) {
        vscode.window.showErrorMessage("No workspace folder open")
        return "No workspace folder open"
      }

      const results = await Promise.all(
        paths.map(async (path) => {
          const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, path)
          const content = await vscode.workspace.fs.readFile(fullPath)
          return `<file_content>${path}\n${Buffer.from(content).toString(
            "utf8"
          )}</file_content>`
        })
      )

      return results.join("\n")
    } catch (error) {
      vscode.window.showErrorMessage(`Error reading files: ${error}`)
      return `Error reading files: ${error}`
    }
  }

  public registerHandlers() {
    this._webview.onDidReceiveMessage(
      async (message: ServerMessage<ToolUse>) => {
        switch (message.type) {
          case EVENT_NAME.twinnyAcceptToolUse:
            await this.handleAcceptToolUse(message)
            break
          case EVENT_NAME.twinnyRunToolUse:
            await this.handleExecuteCommand(
              message.data as ExecuteCommandToolUse
            )
            break
          case EVENT_NAME.twinnyRejectToolUse:
            // Handle rejection if needed
            break
        }
      }
    )
  }
}
