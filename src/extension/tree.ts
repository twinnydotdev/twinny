import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import ignore, { Ignore } from 'ignore'
import {
  getAllFilePaths,
} from './utils'

export class FileTreeProvider {
  private _ignoreRules: Ignore
  private _workspaceRoot = ''

  constructor() {
    this._ignoreRules = this.setupIgnoreRules()

    const workspaceFolders = vscode.workspace.workspaceFolders

    if (!workspaceFolders) return

    this._workspaceRoot = workspaceFolders[0].uri.fsPath
  }

  provideTextDocumentContent(): string {
    return this.generateFileTree(this._workspaceRoot)
  }

  getAllFiles = async (): Promise<string[]> => {
    return getAllFilePaths(this._workspaceRoot)
  }

  private setupIgnoreRules(): Ignore {
    const ig = ignore()
    ig.add(['.git', '.git/**'])

    const gitIgnorePath = path.join(this._workspaceRoot, '.gitignore')
    if (fs.existsSync(gitIgnorePath)) {
      const ignoreContent = fs.readFileSync(gitIgnorePath, 'utf8')
      const rules = ignoreContent
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
      ig.add(rules)
    }

    return ig
  }

  private generateFileTree(dir: string, prefix = ''): string {
    let output = ''
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
      const marker = isLast ? '└── ' : '├── '
      output += `${prefix}${marker}${entry.name}\n`

      if (entry.isDirectory()) {
        const newPrefix = prefix + (isLast ? '    ' : '│   ')
        output += this.generateFileTree(path.join(dir, entry.name), newPrefix)
      }
    })

    return output
  }
}
