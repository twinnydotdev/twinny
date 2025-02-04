import * as fs from "fs"
import ignore, { Ignore } from "ignore"
import * as path from "path"
import * as vscode from "vscode"

import { getAllFilePaths } from "./utils"

export class FileTreeProvider {
  private _ignoreRules: Ignore
  private _workspaceRoot = ""

  constructor() {
    this._ignoreRules = this.setupIgnoreRules()

    const workspaceFolders = vscode.workspace.workspaceFolders

    if (!workspaceFolders) return

    this._workspaceRoot = workspaceFolders[0].uri.fsPath
  }

  getWorkSpaceTree(): string {
    return this.generateFileTree(this._workspaceRoot)
  }

  getAllFiles = async (): Promise<string[]> => {
    return getAllFilePaths(this._workspaceRoot)
  }

  private setupIgnoreRules(): Ignore {
    const ig = ignore()
    ig.add([".git", ".git/**"])

    const gitIgnorePath = path.join(this._workspaceRoot, ".gitignore")
    if (fs.existsSync(gitIgnorePath)) {
      const ignoreContent = fs.readFileSync(gitIgnorePath, "utf8")
      const rules = ignoreContent
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
      ig.add(rules)
    }

    return ig
  }

  async getEnvironmentDetails() {
    try {
      const allFiles = await getAllFilePaths(this._workspaceRoot)
      const visibleFiles = await this.getVisibleFiles()
      const openTabs = await this.getOpenTabs()

      let output = "<environment_details>\n"
      output += "# VSCode Visible Files\n"
      output += visibleFiles.join("\n") + "\n"
      output += "# VSCode Open Tabs\n"
      output += openTabs.join("\n") + "\n"
      output += "# All Files\n"
      output += allFiles.join("\n")
      output += "</environment_details>"

      return output
    } catch {
      return ""
    }
  }

  private async getVisibleFiles(): Promise<string[]> {
    const visibleFiles = await vscode.workspace.findFiles(
      "**/*",
      "**/node_modules/**"
    )
    return visibleFiles.map((file) => vscode.workspace.asRelativePath(file))
  }

  private async getOpenTabs(): Promise<string[]> {
    return vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.input instanceof vscode.TabInputText)
      .map((tab) =>
        vscode.workspace.asRelativePath((tab.input as vscode.TabInputText).uri)
      )
      .filter((relativePath) => !this._ignoreRules.ignores(relativePath))
  }

  private generateFileTree(dir: string, prefix = ""): string {
    let output = ""
    const entries = fs.readdirSync(dir, { withFileTypes: true })

    const filteredEntries = entries.filter((entry) => {
      const relativePath = path.relative(
        this._workspaceRoot,
        path.join(dir, entry.name)
      )
      return !this._ignoreRules.ignores(relativePath)
    })

    filteredEntries.forEach((entry, index) => {
      const isLast = index === filteredEntries.length - 1
      const marker = isLast ? "└── " : "├── "
      output += `${prefix}${marker}${entry.name}\n`

      if (entry.isDirectory()) {
        const newPrefix = prefix + (isLast ? "    " : "│   ")
        output += this.generateFileTree(path.join(dir, entry.name), newPrefix)
      }
    })

    return output
  }
}
