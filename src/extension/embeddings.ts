import fs from 'fs'
import path from 'path'
import * as vscode from 'vscode'
import { fetchEmbedding } from './stream'
import * as lancedb from '@lancedb/lancedb'
import { minimatch } from 'minimatch'

import {
  EmbeddedDocument,
  RequestOptionsOllama,
  StreamRequestOptions as RequestOptions,
  Embedding
} from '../common/types'
import {
  ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY,
  EMBEDDING_IGNORE_LIST
} from '../common/constants'
import { TwinnyProvider } from './provider-manager'
import { getDocumentSplitChunks } from './utils'
import { IntoVector } from '@lancedb/lancedb/dist/arrow'

export class EmbeddingDatabase {
  private _config = vscode.workspace.getConfiguration('twinny')
  private _bearerToken = this._config.get('apiBearerToken') as string
  private _embeddingModel = this._config.get('embeddingModel') as string
  private _documents: EmbeddedDocument[] = []
  private _filePaths: EmbeddedDocument[] = []
  private _db: lancedb.Connection | null = null
  private _dbPath: string
  private _extensionContext?: vscode.ExtensionContext
  private _workspaceName = vscode.workspace.name || ''
  private _documentTableName = `${this._workspaceName}-documents`
  private _filePathTableName = `${this._workspaceName}-file-paths`

  constructor(dbPath: string, extensionContext: vscode.ExtensionContext) {
    this._dbPath = dbPath
    this._extensionContext = extensionContext
  }

  public async connect() {
    try {
      this._db = await lancedb.connect(this._dbPath)
    } catch (e) {
      console.error(e)
    }
  }

  private getProvider = () =>
    this._extensionContext?.globalState.get<TwinnyProvider>(
      ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY
    )

  public async fetchModelEmbedding(content: string) {
    const provider = this.getProvider()

    if (!provider) return

    const requestBody: RequestOptionsOllama = {
      model: this._embeddingModel,
      prompt: content,
      stream: false,
      options: {}
    }

    const requestOptions: RequestOptions = {
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
        cancellable: true,
      },
      async (progress) => {
        if (!this._extensionContext) return
        const promises = filePaths.map(async (filePath) => {
          const content = await fs.promises.readFile(filePath, 'utf-8')
          const chunks = await getDocumentSplitChunks(content, filePath, this._extensionContext)
          const filePathEmbedding = await this.fetchModelEmbedding(filePath)

          this._filePaths.push({
            content: filePath,
            vector: filePathEmbedding,
            file: filePath
          })

          for (const chunk of chunks) {
            const vector = await this.fetchModelEmbedding(filePath)
            if (this.getIsDuplicateItem(chunk, chunks)) return
            this._documents.push({
              content: chunk,
              file: filePath,
              vector: vector
            })
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
    try {
      const tableNames = await this._db?.tableNames()
      if (!tableNames?.includes(`${this._workspaceName}-documents`)) {
        await this._db?.createTable(this._documentTableName, this._documents)
      }

      if (!tableNames?.includes(`${this._workspaceName}-file-paths`)) {
        await this._db?.createTable(this._filePathTableName, this._filePaths)
        return
      }

      await this._db?.dropTable(`${this._workspaceName}-documents`)
      await this._db?.dropTable(`${this._workspaceName}-file-paths`)
      await this.populateDatabase()

      this._documents.length = 0
      this._filePaths.length = 0
    } catch (e) {
      console.log('Error populating database', e)
    }
  }

  public async hasEmbeddingTable(name: string): Promise<boolean | undefined> {
    const tableNames = await this._db?.tableNames()
    return tableNames?.includes(name)
  }

  public async getDocuments(
    vector: IntoVector,
    limit: number,
    tableName: string,
    where?: string
  ): Promise<EmbeddedDocument[] | undefined> {
    try {
      const table = await this._db?.openTable(tableName)
      const query = await table?.search(vector).limit(limit)
      if (where) query?.where(where)
      return query?.toArray()
    } catch (e) {
      return undefined
    }
  }

  public async getDocumentByFilePath(filePath: string) {
    const content = await fs.promises.readFile(filePath, 'utf-8')
    const contentSnippet = content?.slice(0, 500)
    return contentSnippet
  }

  private getIsDuplicateItem(item: string, collection: string[]): boolean {
    return collection.includes(item.trim().toLowerCase())
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
