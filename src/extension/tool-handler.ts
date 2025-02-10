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

  private async handleOpenFile(
    message: ServerMessage<ToolUse>,
    content: string
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
        result: `<apply_diff_result>
          <path>${path}</path>
          <content>${content}</content>
        </apply_diff_result>`
      })

      return `File saved ${path}`
    } catch (error) {
      vscode.window.showErrorMessage(`Error saving file: ${error}`)
      return `Error saving file: ${error}`
    }
  }

  private async handleReadFile(
    message: ServerMessage<ToolUse>
  ): Promise<string> {
    try {
      const paths = message.data.params.path
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
            .slice(0, -1) // Remove last line
            .map((line, index) => `${index + 1} | ${line}`)
            .join("\n")
          return `${relativePath}\n${numberedLines}`
        })
      )

      const result = `<read_file_result><params><content>${results.join(
        "\n"
      )}\n</content></params></read_file_result>`

      this.emit("resolve-tool-result", {
        message,
        result: result
      })

      return result
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

  private async getDiffedContent(
    message: ServerMessage<ToolUse>
  ): Promise<string> {
    const {
      diff,
      path,
      start_line: startLine,
      end_line: endLine
    } = message.data.params

    if (!path) return "Missing path parameter"

    if (!diff) return "Missing diff parameter"

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
    if (!workspaceFolder) {
      vscode.window.showErrorMessage("No workspace folder open")
      return ""
    }
    const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, path)

    // Ensure directory exists
    const dirUri = vscode.Uri.joinPath(fullPath, "..")
    await vscode.workspace.fs.createDirectory(dirUri)

    // Read original file content if exists
    const document = await vscode.workspace.openTextDocument(fullPath)
    const originalContent = document.getText()

    const DEFAULT_FUZZY_THRESHOLD = 1.0

    // Extract the search and replace blocks
    const match = diff.match(
      /<<<<<<< SEARCH\n([\s\S]*?)\n?=======\n([\s\S]*?)\n?>>>>>>> REPLACE/
    )
    if (!match) {
      return "Invalid diff format - missing required SEARCH/REPLACE sections\n\nDebug Info:\n- Expected Format: <<<<<<< SEARCH\\n[search content]\\n=======\\n[replace content]\\n>>>>>>> REPLACE\n- Tip: Make sure to include both SEARCH and REPLACE sections with correct markers"
    }

    let [, searchContent, replaceContent] = match

    // Detect line ending from original content
    const lineEnding = originalContent.includes("\r\n") ? "\r\n" : "\n"

    // Strip line numbers from search and replace content if every line starts with a line number
    if (
      everyLineHasLineNumbers(searchContent) &&
      everyLineHasLineNumbers(replaceContent)
    ) {
      searchContent = stripLineNumbers(searchContent)
      replaceContent = stripLineNumbers(replaceContent)
    }

    // Split content into lines, handling both \n and \r\n
    const searchLines = searchContent === "" ? [] : searchContent.split(/\r?\n/)
    const replaceLines =
      replaceContent === "" ? [] : replaceContent.split(/\r?\n/)
    const originalLines = originalContent.split(/\r?\n/)

    // Validate that empty search requires start line
    if (searchLines.length === 0 && !startLine) {
      return "Empty search content requires start_line to be specified\n\nDebug Info:\n- Empty search content is only valid for insertions at a specific line\n- For insertions, specify the line number where content should be inserted"
    }

    // Validate that empty search requires same start and end line
    if (
      searchLines.length === 0 &&
      startLine &&
      endLine &&
      startLine !== endLine
    ) {
      return `Empty search content requires start_line and end_line to be the same (got ${startLine}-${endLine})\n\nDebug Info:\n- Empty search content is only valid for insertions at a specific line\n- For insertions, use the same line number for both start_line and end_line`
    }

    // Initialize search variables
    let matchIndex = -1
    let bestMatchScore = 0
    let bestMatchContent = ""
    const searchChunk = searchLines.join("\n")

    // Determine search bounds
    let searchStartIndex = 0
    let searchEndIndex = originalLines.length

    // Validate and handle line range if provided
    if (startLine && endLine) {
      // Convert to 0-based index
      const exactStartIndex = +startLine - 1
      const exactEndIndex = +endLine - 1

      if (
        exactStartIndex < 0 ||
        exactEndIndex > originalLines.length ||
        exactStartIndex > exactEndIndex
      ) {
        return `Line range ${startLine}-${endLine} is invalid (file has ${originalLines.length} lines)\n\nDebug Info:\n- Requested Range: lines ${startLine}-${endLine}\n- File Bounds: lines 1-${originalLines.length}`
      }

      // Try exact match first
      const originalChunk = originalLines
        .slice(exactStartIndex, exactEndIndex + 1)
        .join("\n")
      const similarity = getSimilarity(originalChunk, searchChunk)
      if (similarity >= DEFAULT_FUZZY_THRESHOLD) {
        matchIndex = exactStartIndex
        bestMatchScore = similarity
        bestMatchContent = originalChunk
      } else {
        // Set bounds for buffered search
        searchStartIndex = Math.max(0, +startLine - (20 + 1))
        searchEndIndex = Math.min(originalLines.length, +endLine + 20)
      }
    }

    // If no match found yet, try middle-out search within bounds
    if (matchIndex === -1) {
      const midPoint = Math.floor((searchStartIndex + searchEndIndex) / 2)
      let leftIndex = midPoint
      let rightIndex = midPoint + 1

      // Search outward from the middle within bounds
      while (
        leftIndex >= searchStartIndex ||
        rightIndex <= searchEndIndex - searchLines.length
      ) {
        // Check left side if still in range
        if (leftIndex >= searchStartIndex) {
          const originalChunk = originalLines
            .slice(leftIndex, leftIndex + searchLines.length)
            .join("\n")
          const similarity = getSimilarity(originalChunk, searchChunk)
          if (similarity > bestMatchScore) {
            bestMatchScore = similarity
            matchIndex = leftIndex
            bestMatchContent = originalChunk
          }
          leftIndex--
        }

        // Check right side if still in range
        if (rightIndex <= searchEndIndex - searchLines.length) {
          const originalChunk = originalLines
            .slice(rightIndex, rightIndex + searchLines.length)
            .join("\n")
          const similarity = getSimilarity(originalChunk, searchChunk)
          if (similarity > bestMatchScore) {
            bestMatchScore = similarity
            matchIndex = rightIndex
            bestMatchContent = originalChunk
          }
          rightIndex++
        }
      }
    }

    // Require similarity to meet threshold
    if (matchIndex === -1 || bestMatchScore < DEFAULT_FUZZY_THRESHOLD) {
      const searchChunk = searchLines.join("\n")
      const originalContentSection =
        startLine !== undefined && endLine !== undefined
          ? `\n\nOriginal Content:\n${addLineNumbers(
              originalLines
                .slice(
                  Math.max(0, +startLine - 1 - 20),
                  Math.min(originalLines.length, +endLine + 20)
                )
                .join("\n"),
              Math.max(1, +startLine - 20)
            )}`
          : `\n\nOriginal Content:\n${addLineNumbers(originalLines.join("\n"))}`

      const bestMatchSection = bestMatchContent
        ? `\n\nBest Match Found:\n${addLineNumbers(
            bestMatchContent,
            matchIndex + 1
          )}`
        : "\n\nBest Match Found:\n(no match)"

      const lineRange =
        startLine || endLine
          ? ` at ${startLine ? `start: ${startLine}` : "start"} to ${
              endLine ? `end: ${endLine}` : "end"
            }`
          : ""
      return `No sufficiently similar match found${lineRange} (${Math.floor(
        bestMatchScore * 100
      )}% similar, needs ${Math.floor(
        DEFAULT_FUZZY_THRESHOLD * 100
      )}%)\n\nDebug Info:\n- Similarity Score: ${Math.floor(
        bestMatchScore * 100
      )}%\n- Required Threshold: ${Math.floor(
        DEFAULT_FUZZY_THRESHOLD * 100
      )}%\n- Search Range: ${
        startLine && endLine ? `lines ${startLine}-${endLine}` : "start to end"
      }\n- Tip: Use read_file to get the latest content of the file before attempting the diff again, as the file content may have changed\n\nSearch Content:\n${searchChunk}${bestMatchSection}${originalContentSection}`
    }

    // Get the matched lines from the original content
    const matchedLines = originalLines.slice(
      matchIndex,
      matchIndex + searchLines.length
    )

    // Get the exact indentation (preserving tabs/spaces) of each line
    const originalIndents = matchedLines.map((line) => {
      const match = line.match(/^[\t ]*/)
      return match ? match[0] : ""
    })

    // Get the exact indentation of each line in the search block
    const searchIndents = searchLines.map((line) => {
      const match = line.match(/^[\t ]*/)
      return match ? match[0] : ""
    })

    // Apply the replacement while preserving exact indentation
    const indentedReplaceLines = replaceLines.map((line) => {
      // Get the matched line's exact indentation
      const matchedIndent = originalIndents[0] || ""

      // Get the current line's indentation relative to the search content
      const currentIndentMatch = line.match(/^[\t ]*/)
      const currentIndent = currentIndentMatch ? currentIndentMatch[0] : ""
      const searchBaseIndent = searchIndents[0] || ""

      // Calculate the relative indentation level
      const searchBaseLevel = searchBaseIndent.length
      const currentLevel = currentIndent.length
      const relativeLevel = currentLevel - searchBaseLevel

      // If relative level is negative, remove indentation from matched indent
      // If positive, add to matched indent
      const finalIndent =
        relativeLevel < 0
          ? matchedIndent.slice(
              0,
              Math.max(0, matchedIndent.length + relativeLevel)
            )
          : matchedIndent + currentIndent.slice(searchBaseLevel)

      return finalIndent + line.trim()
    })

    // Construct the final content
    const beforeMatch = originalLines.slice(0, matchIndex)
    const afterMatch = originalLines.slice(matchIndex + searchLines.length)

    const finalContent = [
      ...beforeMatch,
      ...indentedReplaceLines,
      ...afterMatch
    ].join(lineEnding)

    return finalContent
  }

  normalizePath(p: string): string {
    // normalize resolve ./.. segments, removes duplicate slashes, and standardizes path separators
    let normalized = path.normalize(p)
    // however it doesn't remove trailing slashes
    // remove trailing slash, except for root paths
    if (
      normalized.length > 1 &&
      (normalized.endsWith("/") || normalized.endsWith("\\"))
    ) {
      normalized = normalized.slice(0, -1)
    }
    return normalized
  }

  public arePathsEqual(path1?: string, path2?: string): boolean {
    if (!path1 && !path2) {
      return true
    }
    if (!path1 || !path2) {
      return false
    }

    path1 = this.normalizePath(path1)
    path2 = this.normalizePath(path2)

    if (process.platform === "win32") {
      return path1.toLowerCase() === path2.toLowerCase()
    }
    return path1 === path2
  }

  public async handleViewDiff(
    message: ServerMessage<ToolUse>
  ): Promise<vscode.TextEditor | undefined> {
    const diff = await this.getDiffedContent(message)
    // Ensure you have a valid file path
    const filePath = message.data.params.path
    if (!filePath) {
      vscode.window.showErrorMessage("No file path provided")
      return
    }

    // Find the workspace folder
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
    if (!workspaceFolder) {
      vscode.window.showErrorMessage("No workspace folder open")
      return
    }

    // Build the original file URI
    const uri = vscode.Uri.joinPath(workspaceFolder.uri, filePath)
    // If this diff editor is already open (ie if a previous write file was interrupted) then we should activate that instead of opening a new diff
    const diffTab = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .find(
        (tab) =>
          tab.input instanceof vscode.TabInputTextDiff &&
          tab.input?.original?.scheme === "twinny-diff" &&
          this.arePathsEqual(tab.input.modified.fsPath, uri.fsPath)
      )
    if (diffTab && diffTab.input instanceof vscode.TabInputTextDiff) {
      const editor = await vscode.window.showTextDocument(
        diffTab.input.modified
      )
      return editor
    }
    // Open new diff editor
    return new Promise<vscode.TextEditor>((resolve, reject) => {
      const fileName = path.basename(uri.fsPath)
      const fileExists = true
      const disposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (
          editor &&
          this.arePathsEqual(editor.document.uri.fsPath, uri.fsPath)
        ) {
          disposable.dispose()
          resolve(editor)
        }
      })
      vscode.commands.executeCommand(
        "vscode.diff",
        uri,
        vscode.Uri.parse(`twinny-diff:${fileName}`).with({
          query: Buffer.from(diff ?? "").toString("base64")
        }),
        `${fileName}: ${
          fileExists ? "Original ↔ Twinnys's Changes" : "New File"
        } (Editable)`
      )
      // This may happen on very slow machines ie project idx
      setTimeout(() => {
        disposable.dispose()
        reject(new Error("Failed to open diff editor, please try again..."))
      }, 10_000)
    })
  }

  public async handleApplyDiff(message: ServerMessage<ToolUse>) {
    const newContent = await this.getDiffedContent(message)

    const path = message.data.params.path

    if (!path) return

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
    if (!workspaceFolder) {
      vscode.window.showErrorMessage("No workspace folder open")
      return ""
    }

    const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, path)

    const dirUri = vscode.Uri.joinPath(fullPath, "..")
    await vscode.workspace.fs.createDirectory(dirUri)

    const fileUri = vscode.Uri.file(fullPath.fsPath)
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(newContent, "utf8"))

    return await this.handleOpenFile(message, newContent)
  }

  public registerHandlers() {
    this._webview.onDidReceiveMessage(
      async (message: ServerMessage<ToolUse>) => {
        if (message.type !== EVENT_NAME.twinnyToolUse) return
        switch (message.data.name) {
          case "view_diff":
            return await this.handleViewDiff(message)
          case "apply_diff":
            return await this.handleApplyDiff(message)
          case "list_code_definition_names":
            return await this.handleListCodeDefinitionNames(message)
          case "read_file":
            return await this.handleReadFile(message)
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
