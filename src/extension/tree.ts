import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { minimatch } from 'minimatch'
import ignore, { Ignore } from 'ignore'
import { EMBEDDING_IGNORE_LIST } from '../common/constants'
import { Logger } from '../common/logger'

const logger = new Logger()

export class FileTreeProvider {
  private ignoreRules: Ignore
  private workspaceRoot = ''

  constructor() {
    this.ignoreRules = this.setupIgnoreRules()

    const workspaceFolders = vscode.workspace.workspaceFolders

    if (!workspaceFolders) return

    this.workspaceRoot = workspaceFolders[0].uri.fsPath
  }

  provideTextDocumentContent(): string {
    return this.generateFileTree(this.workspaceRoot)
  }

  getAllFiles = async (): Promise<string[]> => {
    return this.getAllFilePaths(this.workspaceRoot)
  }

  private setupIgnoreRules(): Ignore {
    const ig = ignore()
    ig.add(['.git', '.git/**'])

    const gitIgnorePath = path.join(this.workspaceRoot, '.gitignore')
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
        this.workspaceRoot,
        path.join(dir, entry.name)
      )
      return !this.ignoreRules.ignores(relativePath)
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

  private readGitIgnoreFile(): string[] | undefined {
    try {
      const folders = vscode.workspace.workspaceFolders
      if (!folders || folders.length === 0) {
        console.log('No workspace folders found')
        return undefined
      }

      const rootPath = folders[0].uri.fsPath
      if (!rootPath) {
        console.log('Root path is undefined')
        return undefined
      }

      const gitIgnoreFilePath = path.join(rootPath, '.gitignore')
      if (!fs.existsSync(gitIgnoreFilePath)) {
        console.log('.gitignore file not found at', gitIgnoreFilePath)
        return undefined
      }

      const ignoreFileContent = fs.readFileSync(gitIgnoreFilePath, 'utf8')
      return ignoreFileContent
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'))
        .map((pattern) => {
          if (pattern.endsWith('/')) {
            return pattern + '**'
          }
          return pattern
        })
    } catch (e) {
      console.error('Error reading .gitignore file:', e)
      return undefined
    }
  }

  private readGitSubmodulesFile(): string[] | undefined {
    try {
      const folders = vscode.workspace.workspaceFolders
      if (!folders || folders.length === 0) return undefined
      const rootPath = folders[0].uri.fsPath
      if (!rootPath) return undefined
      const gitSubmodulesFilePath = path.join(rootPath, '.gitmodules')
      if (!fs.existsSync(gitSubmodulesFilePath)) return undefined
      const submodulesFileContent = fs
        .readFileSync(gitSubmodulesFilePath)
        .toString()
      const submodulePaths: string[] = []
      submodulesFileContent.split('\n').forEach((line: string) => {
        if (line.startsWith('\tpath = ')) {
          submodulePaths.push(line.slice(8))
        }
      })
      return submodulePaths
    } catch (e) {
      return undefined
    }
  }

  private getAllFilePaths = async (dirPath: string): Promise<string[]> => {
    if (!dirPath) return []
    let filePaths: string[] = []
    const dirents = await fs.promises.readdir(dirPath, { withFileTypes: true })
    const gitIgnoredFiles = this.readGitIgnoreFile() || []
    const submodules = this.readGitSubmodulesFile()

    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''

    for (const dirent of dirents) {
      const fullPath = path.join(dirPath, dirent.name)
      const relativePath = path.relative(rootPath, fullPath)

      if (this.getIgnoreDirectory(dirent.name)) continue

      if (submodules?.some((submodule) => fullPath.includes(submodule))) {
        continue
      }

      if (
        gitIgnoredFiles.some((pattern) => {
          const isIgnored =
            minimatch(relativePath, pattern, { dot: true, matchBase: true }) &&
            !pattern.startsWith('!')
          if (isIgnored) {
            logger.log(`Ignoring ${relativePath} due to pattern: ${pattern}`)
          }
          return isIgnored
        })
      ) {
        continue
      }

      if (dirent.isDirectory()) {
        filePaths = filePaths.concat(await this.getAllFilePaths(fullPath))
      } else if (dirent.isFile()) {
        filePaths.push(fullPath)
      }
    }
    return filePaths
  }

  private getIgnoreDirectory(fileName: string): boolean {
    return EMBEDDING_IGNORE_LIST.some((ignoreItem: string) =>
      fileName.includes(ignoreItem)
    )
  }
}
