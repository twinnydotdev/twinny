import fs from 'fs'
import path from 'path'
import * as vscode from 'vscode'
import { StreamOptionsOllama, StreamRequestOptions } from './types'
import { streamEmbedding } from './stream'
import * as lancedb from 'vectordb'
import { EMBEDDING_IGNORE_LIST } from '../constants'

type Vector = number[]

export type EmbeddedDocument = {
  id: string
  chunk: string
  vector: Vector
  relevant?: boolean
}

const TABLE_NAME = 'heimdall-gui'

export class EmbeddingDatabase {
  private _config = vscode.workspace.getConfiguration('twinny')
  private _apiHostname = this._config.get('apiHostname') as string
  private _embeddingsApiPath = this._config.get('embeddingsApiPath') as string
  private _bearerToken = this._config.get('apiBearerToken') as string
  private _port = this._config.get('chatApiPort') as string
  private _embeddingModel = this._config.get('chatModelName') as string
  private _chunks: string[] = []
  private _contexts: EmbeddedDocument[] = []
  private _db: lancedb.Connection | null = null
  private _dbPath: string
  private _useTls = this._config.get('useTls') as boolean

  constructor(dbPath: string) {
    this._dbPath = dbPath
  }

  public async connect() {
    this._db = await lancedb.connect(this._dbPath)
  }

  public async fetchModelEmbedding(content: string) {
    const requestBody: StreamOptionsOllama = {
      model: this._embeddingModel,
      prompt: content,
      stream: false,
      options: {}
    }

    const requestOptions: StreamRequestOptions = {
      hostname: this._apiHostname,
      port: this._port,
      path: this._embeddingsApiPath,
      protocol: this._useTls ? 'https' : 'http',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this._bearerToken}`
      }
    }

    return new Promise<Vector>((resolve) => {
      streamEmbedding({
        body: requestBody,
        options: requestOptions,
        onData: (response: { embedding: Vector }) => {
          const embedding = response?.embedding
          resolve(embedding)
        }
      })
    })
  }

  private async addVector(id: string, chunk: string, vector: Vector) {
    if (this.getIsDuplicateChunk(chunk)) return
    this._chunks.push(chunk.trim().toLowerCase())
    const context = { id, chunk, vector }
    this._contexts.push(context)
  }

  private getAllFilePaths = async (dirPath: string): Promise<string[]> => {
    let filePaths: string[] = []
    const dirents = await fs.promises.readdir(dirPath, {
      withFileTypes: true
    })
    for (const dirent of dirents) {
      const fullPath = path.join(dirPath, dirent.name)
      if (this.getIgnoreDirectory(dirent.name)) continue
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
          const MAX_CHUNK_SIZE = 500
          const chunks = this.getDocumentSplitChunks(content, MAX_CHUNK_SIZE)

          for (const chunk of chunks) {
            const embedding = await this.fetchModelEmbedding(chunk)
            await this.addVector(filePath,  `${filePath}\n\n${chunk.trim()}`, embedding)
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
    if (!tableNames?.includes(TABLE_NAME)) {
      await this._db?.createTable(TABLE_NAME, this._contexts)
    } else {
      const table = await this._db?.openTable(TABLE_NAME)
      await table?.add(this._contexts)
    }
  }

  public async hasEmbeddingTable(): Promise<boolean | undefined> {
    const tableNames = await this._db?.tableNames()
    return tableNames?.includes(TABLE_NAME)
  }

  public async getDocuments(
    vector: number[],
    limit: number
  ): Promise<EmbeddedDocument[] | undefined> {
    const table = await this._db?.openTable(TABLE_NAME)
    const docs: EmbeddedDocument[] | undefined = await table
      ?.search(vector)
      .limit(limit)
      .execute()
    return docs
  }

  private getDocumentSplitChunks(
    content: string,
    maxChunkSize: number
  ): string[] {
    const chunks: string[] = []
    let currentChunkStart = 0

    while (currentChunkStart < content.length) {
      const end = Math.min(currentChunkStart + maxChunkSize, content.length)
      let boundary = content.lastIndexOf('\n', end)
      if (boundary === -1 || boundary - currentChunkStart < maxChunkSize / 2) {
        boundary = end
      }
      chunks.push(content.substring(currentChunkStart, boundary))
      currentChunkStart = boundary + 1
    }

    return chunks
  }

  private getIsDuplicateChunk(chunk: string): boolean {
    return this._chunks.includes(chunk.trim().toLowerCase())
  }

  private getIgnoreDirectory(fileName: string): boolean {
    return EMBEDDING_IGNORE_LIST.some((ignoreItem) =>
      fileName.includes(ignoreItem)
    )
  }
}
