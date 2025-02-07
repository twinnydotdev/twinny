import * as cp from "child_process"
import { distance } from "fastest-levenshtein"
import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"
import Parser from "web-tree-sitter"

import { EVENT_NAME } from "../common/constants"
import { ToolUse } from "../common/parse-assistant-message"
import { ServerMessage } from "../common/types"

import { Base } from "./base"
import { getParser } from "./parser"
import { FileTreeProvider } from "./tree"

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

export function addLineNumbers(content: string, startLine: number = 1): string {
  const lines = content.split("\n")
  const maxLineNumberWidth = String(startLine + lines.length - 1).length
  return lines
    .map((line, index) => {
      const lineNumber = String(startLine + index).padStart(
        maxLineNumberWidth,
        " "
      )
      return `${lineNumber} | ${line}`
    })
    .join("\n")
}
// Checks if every line in the content has line numbers prefixed (e.g., "1 | content" or "123 | content")
// Line numbers must be followed by a single pipe character (not double pipes)
export function everyLineHasLineNumbers(content: string): boolean {
  const lines = content.split(/\r?\n/)
  return (
    lines.length > 0 && lines.every((line) => /^\s*\d+\s+\|(?!\|)/.test(line))
  )
}

// Strips line numbers from content while preserving the actual content
// Handles formats like "1 | content", " 12 | content", "123 | content"
// Preserves content that naturally starts with pipe characters
export function stripLineNumbers(content: string): string {
  // Split into lines to handle each line individually
  const lines = content.split(/\r?\n/)

  // Process each line
  const processedLines = lines.map((line) => {
    // Match line number pattern and capture everything after the pipe
    const match = line.match(/^\s*\d+\s+\|(?!\|)\s?(.*)$/)
    return match ? match[1] : line
  })

  // Join back with original line endings
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n"
  return processedLines.join(lineEnding)
}

/**
 * Truncates multi-line output while preserving context from both the beginning and end.
 * When truncation is needed, it keeps 20% of the lines from the start and 80% from the end,
 * with a clear indicator of how many lines were omitted in between.
 *
 * @param content The multi-line string to truncate
 * @param lineLimit Optional maximum number of lines to keep. If not provided or 0, returns the original content
 * @returns The truncated string with an indicator of omitted lines, or the original content if no truncation needed
 *
 * @example
 * // With 10 line limit on 25 lines of content:
 * // - Keeps first 2 lines (20% of 10)
 * // - Keeps last 8 lines (80% of 10)
 * // - Adds "[...15 lines omitted...]" in between
 */
export function truncateOutput(content: string, lineLimit?: number): string {
  if (!lineLimit) {
    return content
  }

  const lines = content.split("\n")
  if (lines.length <= lineLimit) {
    return content
  }

  const beforeLimit = Math.floor(lineLimit * 0.2) // 20% of lines before
  const afterLimit = lineLimit - beforeLimit // remaining 80% after
  return [
    ...lines.slice(0, beforeLimit),
    `\n[...${lines.length - lineLimit} lines omitted...]\n`,
    ...lines.slice(-afterLimit)
  ].join("\n")
}

export class ToolHandler extends Base {
  constructor(
    context: vscode.ExtensionContext,
    private readonly _webview: vscode.Webview
  ) {
    super(context)
    this.registerHandlers()
  }

  private async handleReplaceInFile(message: ServerMessage<ToolUse>) {
    // Extract parameters
    const path = message.data.params.path as string
    const diff = message.data.params.diff as string
    const startLine = message.data.params.start_line
      ? Number(message.data.params.start_line)
      : undefined
    const endLine = message.data.params.end_line
      ? Number(message.data.params.end_line)
      : undefined
    const DEFAULT_FUZZY_THRESHOLD = 1.0
    const BUFFER_LINES = 20

    if (!path || !diff) {
      vscode.window.showErrorMessage(
        "Missing required parameters for replace_in_file"
      )
      return ""
    }

    try {
      // Get workspace folder and file URI
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
      if (!workspaceFolder) {
        vscode.window.showErrorMessage("No workspace folder open")
        return ""
      }
      const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, path)

      // Ensure directory exists
      const dirUri = vscode.Uri.joinPath(fullPath, "..")
      try {
        await vscode.workspace.fs.createDirectory(dirUri)
      } catch {
        console.log("err")
      }

      // Read original file content if exists
      let originalContent: string
      let isNewFile = false
      try {
        const document = await vscode.workspace.openTextDocument(fullPath)
        originalContent = document.getText()
      } catch {
        isNewFile = true
        originalContent = ""
      }

      // Extract the SEARCH/REPLACE diff block
      const match = diff.match(
        /<<<<<<< SEARCH\n([\s\S]*?)\n?=======\n([\s\S]*?)\n?>>>>>>> REPLACE/
      )
      if (!match) {
        vscode.window.showErrorMessage(
          "Invalid diff format - missing required SEARCH/REPLACE sections"
        )
        return ""
      }
      let [, searchContent, replaceContent] = match

      // Strip line numbers if present
      if (
        everyLineHasLineNumbers(searchContent) &&
        everyLineHasLineNumbers(replaceContent)
      ) {
        searchContent = stripLineNumbers(searchContent)
        replaceContent = stripLineNumbers(replaceContent)
      }

      // Determine file line ending
      const lineEnding = originalContent.includes("\r\n") ? "\r\n" : "\n"

      // Split diff and file content into lines
      const searchLines =
        searchContent === "" ? [] : searchContent.split(/\r?\n/)
      const replaceLines =
        replaceContent === "" ? [] : replaceContent.split(/\r?\n/)
      const originalLines = originalContent.split(/\r?\n/)

      // Validate empty search requires a specified insertion line
      if (searchLines.length === 0 && startLine === undefined) {
        vscode.window.showErrorMessage(
          "Empty search content requires start_line to be specified"
        )
        return ""
      }
      if (
        searchLines.length === 0 &&
        startLine !== undefined &&
        endLine !== undefined &&
        startLine !== endLine
      ) {
        vscode.window.showErrorMessage(
          `Empty search content requires start_line and end_line to be the same (got ${startLine}-${endLine})`
        )
        return ""
      }

      // Find best match in original content using fuzzy search
      let matchIndex = -1
      let bestMatchScore = 0
      const searchChunk = searchLines.join("\n")

      // If a line range is provided, try an exact match first.
      let searchStartIndex = 0
      let searchEndIndex = originalLines.length
      if (startLine !== undefined && endLine !== undefined) {
        const exactStartIndex = startLine - 1
        const exactEndIndex = endLine - 1
        if (
          exactStartIndex < 0 ||
          exactEndIndex >= originalLines.length ||
          exactStartIndex > exactEndIndex
        ) {
          vscode.window.showErrorMessage(
            `Line range ${startLine}-${endLine} is invalid (file has ${originalLines.length} lines)`
          )
          return ""
        }
        const originalChunk = originalLines
          .slice(exactStartIndex, exactEndIndex + 1)
          .join("\n")
        const similarity = getSimilarity(originalChunk, searchChunk)
        if (similarity >= DEFAULT_FUZZY_THRESHOLD) {
          matchIndex = exactStartIndex
          bestMatchScore = similarity
        } else {
          // Expand search bounds with a buffer if exact match fails
          searchStartIndex = Math.max(0, startLine - (BUFFER_LINES + 1))
          searchEndIndex = Math.min(
            originalLines.length,
            endLine + BUFFER_LINES
          )
        }
      }

      // Perform a middle-out fuzzy search if no match was found yet
      if (matchIndex === -1) {
        const midPoint = Math.floor((searchStartIndex + searchEndIndex) / 2)
        let leftIndex = midPoint
        let rightIndex = midPoint + 1
        while (
          leftIndex >= searchStartIndex ||
          rightIndex <= searchEndIndex - searchLines.length
        ) {
          if (leftIndex >= searchStartIndex) {
            const originalChunk = originalLines
              .slice(leftIndex, leftIndex + searchLines.length)
              .join("\n")
            const similarity = getSimilarity(originalChunk, searchChunk)
            if (similarity > bestMatchScore) {
              bestMatchScore = similarity
              matchIndex = leftIndex
            }
            leftIndex--
          }
          if (rightIndex <= searchEndIndex - searchLines.length) {
            const originalChunk = originalLines
              .slice(rightIndex, rightIndex + searchLines.length)
              .join("\n")
            const similarity = getSimilarity(originalChunk, searchChunk)
            if (similarity > bestMatchScore) {
              bestMatchScore = similarity
              matchIndex = rightIndex
            }
            rightIndex++
          }
        }
      }

      // Require sufficient similarity threshold
      if (matchIndex === -1 || bestMatchScore < DEFAULT_FUZZY_THRESHOLD) {
        vscode.window.showErrorMessage(
          `No sufficiently similar match found (${Math.floor(
            bestMatchScore * 100
          )}% similar, needs ${Math.floor(DEFAULT_FUZZY_THRESHOLD * 100)}%)`
        )
        return ""
      }

      // Preserve the indentation of the matched content
      const matchedLines = originalLines.slice(
        matchIndex,
        matchIndex + searchLines.length
      )
      const originalIndents = matchedLines.map(
        (line) => (line.match(/^[\t ]*/) || [""])[0]
      )
      const searchIndents = searchLines.map(
        (line) => (line.match(/^[\t ]*/) || [""])[0]
      )
      const indentedReplaceLines = replaceLines.map((line) => {
        const matchedIndent = originalIndents[0] || ""
        const currentIndentMatch = line.match(/^[\t ]*/)
        const currentIndent = currentIndentMatch ? currentIndentMatch[0] : ""
        const searchBaseIndent = searchIndents[0] || ""
        const searchBaseLevel = searchBaseIndent.length
        const currentLevel = currentIndent.length
        const relativeLevel = currentLevel - searchBaseLevel
        const finalIndent =
          relativeLevel < 0
            ? matchedIndent.slice(
                0,
                Math.max(0, matchedIndent.length + relativeLevel)
              )
            : matchedIndent + currentIndent.slice(searchBaseLevel)
        return finalIndent + line.trim()
      })

      // Replace the search block with the new indented content
      const beforeMatch = originalLines.slice(0, matchIndex)
      const afterMatch = originalLines.slice(matchIndex + searchLines.length)
      const finalContent = [
        ...beforeMatch,
        ...indentedReplaceLines,
        ...afterMatch
      ].join(lineEnding)

      // Write the updated content back to the file
      if (isNewFile) {
        await vscode.workspace.fs.writeFile(fullPath, Buffer.from(finalContent))
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
          finalContent
        )
        const success = await vscode.workspace.applyEdit(edit)
        if (!success) return ""
        await vscode.workspace.openTextDocument(fullPath)
      }
      return await this.handleOpenAndSaveFile(message)
    } catch (error) {
      vscode.window.showErrorMessage(`Error applying changes: ${error}`)
      return ""
    }
  }

  private async handleWriteToFile(
    message: ServerMessage<ToolUse>
  ): Promise<string> {
    const content = message.data.params.content
    const path = message.data.params.path

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

      this.emit("resolve-tool-result", {
        message,
        result: `File written successfully: ${path}`
      })

      return `File written successfully: ${path}`
    } catch (error) {
      vscode.window.showErrorMessage(`Error writing file: ${error}`)
      return `Error writing file: ${error}`
    }
  }

  private async handleExecuteCommand(
    message: ServerMessage<ToolUse>
  ): Promise<string> {
    const command = message.data.params.command

    if (!command) {
      vscode.window.showErrorMessage(
        "Missing required parameter 'command' for execute_command"
      )
      return ""
    }

    // Display the command to the user
    vscode.window.showInformationMessage(`Executing command: ${command}`)

    try {
      const workspaceFolders = vscode.workspace.workspaceFolders
      if (!workspaceFolders?.length) {
        throw new Error("No workspace folder open")
      }

      const { stdout, stderr } = await this.executeCommandNonInteractive(
        command,
        workspaceFolders[0].uri.fsPath
      )

      const result = stdout || stderr
      const resultMessage = `Command executed: ${command}\nResult: ${result}`
      this.emit("resolve-tool-result", {
        message,
        result: resultMessage
      })
      return resultMessage
    } catch (error) {
      const errorMessage = `Error executing command: ${error}`
      this.emit("resolve-tool-result", {
        message,
        result: errorMessage
      })
      vscode.window.showErrorMessage(errorMessage)
      return ""
    }
  }

  private executeCommandNonInteractive(
    command: string,
    cwd: string,
    timeout = 60000,
    successRegex = /(ready in|Local:|server running at|listening on|webpack \d+\.\d+\.\d+|development server running at|server started|compiled successfully|\d+\.\d+\.\d+\.\d+:\d+|localhost:\d+|started server on|server is running on|vite \d+\.\d+\.\d+|starting development server|webpack compiled|listening at http|server listening on|dev server running at|webpack: compiled|started server|ready on|available on|project is running at|app running at|successfully compiled|build complete|VITE v\d+\.\d+\.\d+|local:.+:\d+|network:.+:\d+|➜\s+local:\s+http|➜\s+network:\s+http|ready in \d+m?s|\d+ modules? transformed|http:\/\/localhost:\d+)/i
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const childProcess = cp.spawn(command, [], {
        cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"]
      })

      let stdout = ""
      let stderr = ""

      childProcess.stdout.on("data", (data) => {
        stdout += data.toString()
        console.log(stdout)
        if (successRegex.test(stdout)) {
          resolve({ stdout, stderr })
        }
      })

      childProcess.stderr.on("data", (data) => {
        stderr += data.toString()
      })

      const timeoutId = setTimeout(() => {
        childProcess.kill()
        reject(new Error(`Command timed out after ${timeout / 1000} seconds`))
      }, timeout)

      childProcess.on("error", (error) => {
        clearTimeout(timeoutId)
        reject(error)
      })
    })
  }

  private async handleListCodeDefinitionNames(
    message: ServerMessage<ToolUse>
  ): Promise<string> {
    const path = message.data.params.path

    if (!path) {
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

      const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, path).fsPath
      const definitions = await this.getCodeDefinitions(fullPath)

      this.emit("resolve-tool-result", {
        message,
        result: definitions.join("\n")
      })

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

  private async handleOpenAndSaveFile(
    message: ServerMessage<ToolUse>
  ): Promise<string> {
    const path = message.data.params.path

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

      this.emit("resolve-tool-result", {
        message,
        result: `File saved ${path}`
      })

      return `File saved ${path}`
    } catch (error) {
      vscode.window.showErrorMessage(`Error saving file: ${error}`)
      return `Error saving file: ${error}`
    }
  }

  private async handleReadFiles(message: ServerMessage<ToolUse>): Promise<string> {
    try {
      const paths = message.data.params.paths
      if (!paths?.length) return "No files provided for reading"

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
      if (!workspaceFolder) {
        vscode.window.showErrorMessage("No workspace folder open")
        return "No workspace folder open"
      }

      const results = await Promise.all(
        paths.split(",").map(async (path) => {
          const relativePath = path
            .replace(workspaceFolder.uri.path, "")
            .replace(/^\//, "")
          const fullPath = vscode.Uri.joinPath(
            workspaceFolder.uri,
            relativePath
          )
          const content = await vscode.workspace.fs.readFile(fullPath)
          const lines = Buffer.from(content).toString("utf8").split("\n")
          const numberedLines = lines
            .slice(0, -1)  // Remove last line
            .map((line, index) => `${index + 1} | ${line}`)
            .join("\n")
          return `${relativePath}\n${numberedLines}`
        })
      )

      const xmlResult = `<read_files_result><params><content>${results.join("\n")}\n</content></params></read_files_result>`

      this.emit("resolve-tool-result", {
        message,
        result: xmlResult
      })

      return xmlResult
    } catch (error) {
      vscode.window.showErrorMessage(`Error reading files: ${error}`)
      return `Error reading files: ${error}`
    }
  }

  private async handleListFiles(
    message: ServerMessage<ToolUse>
  ): Promise<string> {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
      if (!workspaceFolder) {
        vscode.window.showErrorMessage("No workspace folder open")
        return "No workspace folder open"
      }

      const fileTreeProvider = new FileTreeProvider()

      const result = await fileTreeProvider.getEnvironmentDetails()

      this.emit("resolve-tool-result", {
        message,
        result
      })

      return result
    } catch (error) {
      vscode.window.showErrorMessage(`Error listing files: ${error}`)
      return `Error listing files: ${error}`
    }
  }

  public registerHandlers() {
    this._webview.onDidReceiveMessage(
      async (message: ServerMessage<ToolUse>) => {
        if (message.type !== EVENT_NAME.twinnyToolUse) return
        switch (message.data.name) {
          case "replace_in_file":
            return await this.handleReplaceInFile(message)
          case "list_code_definition_names":
            return await this.handleListCodeDefinitionNames(message)
          case "read_files": {
            return await this.handleReadFiles(message)
          }
          case "execute_command":
            return await this.handleExecuteCommand(message)
          case "write_to_file":
            return await this.handleWriteToFile(message)
          case "list_files":
            return await this.handleListFiles(message)
          default:
            vscode.window.showErrorMessage(
              `Unsupported tool: ${message.data.name}`
            )
            return ""
        }
      }
    )
  }
}
