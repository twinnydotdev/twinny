import fs from 'fs'
import path from 'path'
import * as vscode from 'vscode'
import { fetchEmbedding } from './stream'
import * as lancedb from 'vectordb'
import { minimatch } from 'minimatch'

import {
  EmbeddedDocument,
  StreamOptionsOllama,
  StreamRequestOptions,
  Embedding
} from '../common/types'
import {
  ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  EMBEDDING_IGNORE_LIST
} from '../common/constants'
import { TwinnyProvider } from './provider-manager'
import { getLineBreakCount } from '../webview/utils'
import { getParser } from './parser-utils'
import { randomUUID } from 'crypto'

const CONTEXT_TABLE_NAME = 'test-contexts' // TODO: Name of workspace

export class EmbeddingDatabase {
  private _config = vscode.workspace.getConfiguration('twinny')
  private _bearerToken = this._config.get('apiBearerToken') as string
  private _embeddingModel = this._config.get('embeddingModel') as string
  private _fileContentContexts: EmbeddedDocument[] = []
  private _db: lancedb.Connection | null = null
  private _dbPath: string
  private _extensionContext?: vscode.ExtensionContext

  constructor(dbPath: string, extensionContext: vscode.ExtensionContext) {
    this._dbPath = dbPath
    this._extensionContext = extensionContext
  }

  public async connect() {
    this._db = await lancedb.connect(this._dbPath)
  }

  private getProvider = () => {
    const provider = this._extensionContext?.globalState.get<TwinnyProvider>(
      ACTIVE_CHAT_PROVIDER_STORAGE_KEY
    )
    return provider
  }

  public async fetchModelEmbedding(content: string) {
    const provider = this.getProvider()

    if (!provider) return

    const requestBody: StreamOptionsOllama = {
      model: this._embeddingModel,
      prompt: content,
      stream: false,
      options: {}
    }

    const requestOptions: StreamRequestOptions = {
      hostname: provider.apiHostname,
      port: provider.apiPort,
      path: '/api/embeddings',
      protocol: provider.apiProtocol,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this._bearerToken}`
      }
    }

    return new Promise<number[]>((resolve) => {
      fetchEmbedding({
        body: requestBody,
        options: requestOptions,
        onData: (response) => {
          resolve((response as Embedding).embedding)
        }
      })
    })
  }

  private getAllFilePaths = async (dirPath: string): Promise<string[]> => {
    let filePaths: string[] = []
    const dirents = await fs.promises.readdir(dirPath, {
      withFileTypes: true
    })
    const gitIgnoredFiles = this.readGitIgnoreFile()
    const submodules = this.readGitSubmodulesFile()

    for (const dirent of dirents) {
      const fullPath = path.join(dirPath, dirent.name)
      if (this.getIgnoreDirectory(dirent.name)) continue

      if (submodules?.some((submodule) => fullPath.includes(submodule))) {
        continue
      }

      if (
        gitIgnoredFiles?.some(
          (pattern) =>
            minimatch(fullPath, pattern, { dot: true }) &&
            !pattern.startsWith('!')
        )
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

  public async injestDocuments(
    directoryPath: string
  ): Promise<EmbeddingDatabase> {
    const filePaths = await this.getAllFilePaths(directoryPath)
    const totalFiles = filePaths.length
    let processedFiles = 0

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Embedding',
        cancellable: false
      },
      async (progress) => {
        const promises = filePaths.map(async (filePath) => {
          const content = await fs.promises.readFile(filePath, 'utf-8')
          const chunks = await this.getDocumentSplitChunks(content, filePath)
          const fileName = path.basename(filePath)

          for (const chunk of chunks) {
            const vector = await this.fetchModelEmbedding(chunk)
            if (this.getIsDuplicateChunk(chunk, chunks)) return
            const fullContext: EmbeddedDocument = {
              id: randomUUID(),
              filePath,
              fileName,
              content: `${filePath}\n\n${chunk}`,
              vector
            }
            this._fileContentContexts.push(fullContext)
          }

          processedFiles++
          progress.report({
            message: `${((processedFiles / totalFiles) * 100).toFixed(
              2
            )}% (${filePath.split('/').pop()})`
          })
        })

        await Promise.all(promises)

        vscode.window.showInformationMessage(
          `Embedded successfully! Processed ${totalFiles} files.`
        )
      }
    )

    return this
  }

  public async populateDatabase() {
    const tableNames = await this._db?.tableNames()
    if (!tableNames?.includes(CONTEXT_TABLE_NAME)) {
      await this._db?.createTable(CONTEXT_TABLE_NAME, this._fileContentContexts)
      return
    }
    const contextTable = await this._db?.openTable(CONTEXT_TABLE_NAME)
    await contextTable?.add(this._fileContentContexts)
  }

  public async hasEmbeddingTable(): Promise<boolean | undefined> {
    const tableNames = await this._db?.tableNames()
    return tableNames?.includes(CONTEXT_TABLE_NAME)
  }

  public async getDocuments(
    vector: number[] | undefined,
    limit: number,
    tableName = CONTEXT_TABLE_NAME
  ): Promise<EmbeddedDocument[] | undefined> {
    try {
      const table = await this._db?.openTable(tableName)
      const docs: EmbeddedDocument[] | undefined = await table
        ?.search(vector)
        .where('fileName LIKE \'get-link%\'')
        .limit(limit)
        .execute()
      return docs
    } catch (e) {
      return undefined
    }
  }

  private async getDocumentSplitChunks(
    content: string,
    filePath: string
  ): Promise<string[]> {
    const parser = await getParser(filePath)

    if (!parser) {
      return []
    }

    const tree = parser.parse(content)
    const chunks: string[] = []
    let chunk = ''

    for (const child of tree.rootNode.children) {
      if (!child.text) {
        continue
      }

      const childLineBreakCount = getLineBreakCount(child.text)

      if (childLineBreakCount > 100) {
        const lines = child.text.split('\n')
        const overlap = 20
        for (let i = 0; i < lines.length; i += 100 - overlap) {
          const subChunk = lines.slice(i, i + 100).join('\n')
          chunks.push(subChunk)
        }
        continue
      }

      chunk = (chunk + '\n' + child.text).trimStart()
      const chunkLineBreakCount = getLineBreakCount(chunk)

      if (chunkLineBreakCount >= 100) {
        chunks.push(chunk)
        chunk = ''
      }
    }

    if (chunk.trim() !== '') {
      chunks.push(chunk)
    }

    return chunks
  }

  private getIsDuplicateChunk(chunk: string, chunks: string[]): boolean {
    return chunks.includes(chunk.trim().toLowerCase())
  }

  private readGitIgnoreFile(): string[] | undefined {
    try {
      const folders = vscode.workspace.workspaceFolders
      if (!folders || folders.length === 0) return undefined
      const rootPath = folders[0].uri.fsPath
      if (!rootPath) return undefined
      const gitIgnoreFilePath = path.join(rootPath, '.gitignore')
      if (!fs.existsSync(gitIgnoreFilePath)) return undefined
      const ignoreFileContent = fs.readFileSync(gitIgnoreFilePath).toString()
      return ignoreFileContent.split('\n').filter((line: string) => line !== '')
    } catch (e) {
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

  private getIgnoreDirectory(fileName: string): boolean {
    return EMBEDDING_IGNORE_LIST.some((ignoreItem: string) =>
      fileName.includes(ignoreItem)
    )
  }
}
