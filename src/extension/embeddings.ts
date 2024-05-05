import fs from 'fs'
import path from 'path'
import Parser from 'web-tree-sitter'
import * as vscode from 'vscode'
import { streamEmbedding } from './stream'
import * as lancedb from 'vectordb'
import { EmbeddedDocument, StreamOptionsOllama, StreamRequestOptions, Embedding } from '../common/types'
import { ACTIVE_CHAT_PROVIDER_STORAGE_KEY, EMBEDDING_IGNORE_LIST, WASM_LANGAUAGES } from '../common/constants'
import { TwinnyProvider } from './provider-manager'

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
      streamEmbedding({
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
          const chunks = await this.getDocumentSplitChunks(content, filePath)

          for (const chunk of chunks) {
            const vector = await this.fetchModelEmbedding(chunk)
            if (this.getIsDuplicateChunk(chunk, chunks)) return
            const fullContext: EmbeddedDocument = {
              id: filePath,
              chunk: `${filePath}\n\n${chunk}`,
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
        .limit(limit)
        .execute()
      return docs
    } catch (e) {
      return undefined
    }
  }

  private async getParserForFile(filePath: string): Promise<Parser | null> {
    await Parser.init()
    const parser = new Parser()
    const extension = path.extname(filePath).slice(1)

    if (!WASM_LANGAUAGES[extension]) {
      return null
    }

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
    filePath: string
  ): Promise<string[]> {
    const parser = await this.getParserForFile(filePath)

    if (!parser) return []

    const tree = parser.parse(content)

    const positionToIndex = (line: number, column: number) => {
      let index = 0
      let currentLine = 0

      while (currentLine < line) {
        index = content.indexOf('\n', index) + 1
        if (index === 0) break
        currentLine++
      }

      return index + column
    }

    const chunks = tree.rootNode.children
      .map((node) => {
        const start = positionToIndex(
          node.startPosition.row,
          node.startPosition.column
        )
        const end = positionToIndex(
          node.endPosition.row,
          node.endPosition.column
        )
        const chunk = content.substring(start, end).trim()

        return chunk
      })
      .filter((chunk) => chunk !== '')

    return chunks
  }

  private getIsDuplicateChunk(chunk: string, chunks: string[]): boolean {
    return chunks.includes(chunk.trim().toLowerCase())
  }

  private getIgnoreDirectory(fileName: string): boolean {
    return EMBEDDING_IGNORE_LIST.some((ignoreItem: string) =>
      fileName.includes(ignoreItem)
    )
  }
}
