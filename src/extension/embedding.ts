import fs from 'fs'
import path from 'path'
import Parser from 'web-tree-sitter'
import * as vscode from 'vscode'
import { StreamOptionsOllama, StreamRequestOptions } from './types'
import { streamEmbedding } from './stream'
import * as lancedb from 'vectordb'
import { EMBEDDING_IGNORE_LIST, WASM_LANGAUAGES } from '../constants'

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
          // const MAX_CHUNK_SIZE = 500
          const chunks = await this.getDocumentSplitChunks(content, filePath)

          for (const chunk of chunks) {
            const embedding = await this.fetchModelEmbedding(chunk)
            await this.addVector(
              filePath,
              `${filePath}\n\n${chunk.trim()}`,
              embedding
            )
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

  private async getParserForFile(filePath: string) {
    await Parser.init()
    const parser = new Parser()
    const extension = path.extname(filePath).slice(1);
    const wasmPath = path.join(
      __dirname,
      'tree-sitter-wasms',
      `tree-sitter-${WASM_LANGAUAGES[extension]}.wasm`
    )
    const Language = await Parser.Language.load(wasmPath)
    parser.setLanguage(Language)
    return parser
  }

  private async getDocumentSplitChunks(
    content: string,
    filePath: string,
  ): Promise<string[]> {

    const parser = await this.getParserForFile(filePath)
    const tree = await parser.parse(content)

    const chunks = tree.rootNode.children.map((node) => {
      const start = node.startPosition.row
      const end = node.endPosition.row
      const chunk = content.substring(start, end).trim()
      if (this.getIsDuplicateChunk(chunk)) {
        return ''
      } else {
        this._chunks.push(chunk.trim().toLowerCase())
        return chunk
      }
    }).filter((chunk) => chunk !== '')

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
