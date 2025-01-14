import * as path from "path"
import * as vscode from "vscode"

const throttleDelay = 200

export function arePathsEqual(path1?: string, path2?: string): boolean {
  if (!path1 && !path2) {
    return true
  }
  if (!path1 || !path2) {
    return false
  }

  path1 = normalizePath(path1)
  path2 = normalizePath(path2)

  if (process.platform === "win32") {
    return path1.toLowerCase() === path2.toLowerCase()
  }
  return path1 === path2
}

function normalizePath(p: string): string {
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

export class StreamingDiffController {
  private editor?: vscode.TextEditor
  private streamedLines: string[] = []
  private originalUri: vscode.Uri
  private isInitialized = false
  private decoration?: vscode.TextEditorDecorationType
  private originalContent = ""

  // For throttling:
  private updateTimeout?: NodeJS.Timeout
  private pendingContent = ""
  private pendingFullArgs = ""

  constructor(originalUri: vscode.Uri) {
    this.originalUri = originalUri

    // Decoration for highlighting changed lines:
    this.decoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: "rgba(255, 255, 0, 0.2)",
      isWholeLine: true
    })
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return

    // Read original content
    const content = await vscode.workspace.fs.readFile(this.originalUri)
    this.originalContent = new TextDecoder().decode(content)
    this.streamedLines = this.originalContent.split("\n")

    // Open diff view between original content and current file
    this.editor = await this.openDiffEditor()

    this.isInitialized = true
  }

  private async openDiffEditor(): Promise<vscode.TextEditor> {
    const fileName = path.basename(this.originalUri.fsPath)

    // Check for existing diff view
    const diffTab = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .find(
        (tab) =>
          tab.input instanceof vscode.TabInputTextDiff &&
          tab.input?.original?.scheme === "twinny-diff" &&
          arePathsEqual(tab.input.modified.fsPath, this.originalUri.fsPath)
      )

    if (diffTab && diffTab.input instanceof vscode.TabInputTextDiff) {
      return vscode.window.showTextDocument(diffTab.input.modified)
    }

    // Open new diff editor
    return new Promise<vscode.TextEditor>((resolve, reject) => {
      const disposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (
          editor &&
          arePathsEqual(editor.document.uri.fsPath, this.originalUri.fsPath)
        ) {
          disposable.dispose()
          resolve(editor)
        }
      })

      vscode.commands.executeCommand(
        "vscode.diff",
        vscode.Uri.parse(`twinny-diff:${fileName}`).with({
          query: Buffer.from(this.originalContent).toString("base64")
        }),
        this.originalUri,
        `${fileName}: Original ↔ Changes`
      )

      setTimeout(() => {
        disposable.dispose()
        reject(new Error("Failed to open diff editor"))
      }, 5000)
    })
  }

  // Rest of your existing code remains the same, just update the URI references
  private async applyLineEdit(line: string, lineNumber: number): Promise<void> {
    if (!this.editor) throw new Error("Editor not initialized")

    const edit = new vscode.WorkspaceEdit()
    const docLineCount = this.editor.document.lineCount

    if (lineNumber < docLineCount) {
      const range = this.editor.document.lineAt(lineNumber).range
      edit.replace(this.originalUri, range, line)
    } else {
      const position = new vscode.Position(docLineCount, 0)
      const newLinePrefix = docLineCount > 0 ? "\n" : ""
      edit.insert(this.originalUri, position, newLinePrefix + line)
    }

    await vscode.workspace.applyEdit(edit)
    this.highlightLine(lineNumber)
  }

  private async removeExtraLines(
    fromLine: number,
    toLine: number
  ): Promise<void> {
    if (!this.editor) return

    const edit = new vscode.WorkspaceEdit()
    for (let i = toLine - 1; i >= fromLine; i--) {
      const lineRange = this.editor.document.lineAt(i).range
      edit.delete(this.originalUri, lineRange)
    }
    await vscode.workspace.applyEdit(edit)
  }

  // Your other existing methods remain the same
  private unescapeContent(content: string): string {
    return content
      .replace(/\\\\n/g, "\\n")
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\")
  }

  private highlightLine(lineNumber: number): void {
    if (!this.editor || !this.decoration) return
    const range = new vscode.Range(lineNumber, 0, lineNumber, 0)
    this.editor.setDecorations(this.decoration, [range])
    this.editor.revealRange(range, vscode.TextEditorRevealType.InCenter)
  }

  public async update(incoming: string, fullArgs: string): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize()
    }

    this.pendingContent = incoming
    this.pendingFullArgs = fullArgs

    const isFinal = /"\s*\}\s*$/.test(fullArgs)
    if (isFinal) {
      if (this.updateTimeout) {
        clearTimeout(this.updateTimeout)
        this.updateTimeout = undefined
      }
      await this.applyUpdate(this.pendingContent, this.pendingFullArgs)
      await this.finalize()
      return
    }

    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout)
    }

    this.updateTimeout = setTimeout(async () => {
      const content = this.pendingContent
      const args = this.pendingFullArgs
      this.updateTimeout = undefined
      await this.applyUpdate(content, args)
    }, throttleDelay)
  }

  private async applyUpdate(incoming: string, fullArgs: string): Promise<void> {
    const unescaped = this.unescapeContent(incoming)
    const incomingLines = unescaped.split("\n")

    if (!/"\s*\}\s*$/.test(fullArgs)) {
      incomingLines.pop()
    }

    for (let i = 0; i < incomingLines.length; i++) {
      const newLine = incomingLines[i]
      if (i >= this.streamedLines.length || this.streamedLines[i] !== newLine) {
        this.streamedLines[i] = newLine
        await this.applyLineEdit(newLine, i)
      }
    }

    if (this.streamedLines.length > incomingLines.length) {
      await this.removeExtraLines(
        incomingLines.length,
        this.streamedLines.length
      )
      this.streamedLines.splice(incomingLines.length)
    }
  }

  public async finalize(): Promise<void> {
    if (!this.editor?.document) return
    await this.editor.document.save()
    await this.cleanup()
  }

  async cleanup(): Promise<void> {
    if (this.decoration) {
      this.decoration.dispose()
    }
    this.isInitialized = false
  }
}
