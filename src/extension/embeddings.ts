import * as lancedb from "@lancedb/lancedb"
import { IntoVector } from "@lancedb/lancedb/dist/arrow"
import fs from "fs"
import ignore from "ignore"
import PQueue from "p-queue"
import path from "path"
import * as vscode from "vscode"

import { API_PROVIDERS } from "../common/constants"
import {
  EmbeddedDocument,
  Embedding,
  LMStudioEmbedding,
  RequestOptionsOllama,
  StreamRequestOptions as RequestOptions
} from "../common/types"

import { Base } from "./base"
import { fetchEmbedding } from "./llm"
import { TwinnyProvider } from "./provider-manager"
import {
  getDocumentSplitChunks,
  readGitSubmodulesFile,
  sanitizeWorkspaceName
} from "./utils"

export class EmbeddingDatabase extends Base {
  private _documents: EmbeddedDocument[] = []
  private _filePaths: EmbeddedDocument[] = []
  private _db: lancedb.Connection | null = null
  private _dbPath: string
  private _workspaceName = sanitizeWorkspaceName(vscode.workspace.name)
  private _documentTableName = `${this._workspaceName}-documents`
  private _filePathTableName = `${this._workspaceName}-file-paths`

  constructor(dbPath: string, context: vscode.ExtensionContext) {
    super(context)
    this._dbPath = dbPath
  }

  public async connect() {
    try {
      this._db = await lancedb.connect(this._dbPath)
    } catch (e) {
      console.error(e)
    }
  }

  public async fetchModelEmbedding(content: string) {
    const provider = this.getEmbeddingProvider()

    if (!provider) return

    const requestBody: RequestOptionsOllama = {
      model: provider.modelName,
      input: content,
      stream: false,
      options: {}
    }

    const requestOptions: RequestOptions = {
      hostname: provider.apiHostname || "localhost",
      port: provider.apiPort,
      path: provider.apiPath || "/api/embed",
      protocol: provider.apiProtocol || "http",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`
      }
    }

    return new Promise<number[]>((resolve) => {
      fetchEmbedding({
        body: requestBody,
        options: requestOptions,
        onData: (response) => {
          resolve(this.getEmbeddingFromResponse(provider, response))
        }
      })
    })
  }

  private getAllFilePaths = async (
    rootPath: string,
    dirPath: string
  ): Promise<string[]> => {
    let filePaths: string[] = []
    const dirents = await fs.promises.readdir(dirPath, { withFileTypes: true })
    const submodules = readGitSubmodulesFile()

    const ig = ignore()

    const gitIgnoreFilePath = path.join(rootPath, ".gitignore")

    if (fs.existsSync(gitIgnoreFilePath)) {
      ig.add(fs.readFileSync(gitIgnoreFilePath).toString())
    }

    const embeddingIgnoredGlobs = this.config.get(
      "embeddingIgnoredGlobs",
      [] as string[]
    )

    ig.add(embeddingIgnoredGlobs)
    ig.add([".git", ".gitignore"])

    for (const dirent of dirents) {
      const fullPath = path.join(dirPath, dirent.name)
      const relativePath = path.relative(rootPath, fullPath)

      if (submodules?.some((submodule) => fullPath.includes(submodule))) {
        continue
      }

      if (ig.ignores(relativePath)) {
        continue
      }

      if (dirent.isDirectory()) {
        filePaths = filePaths.concat(
          await this.getAllFilePaths(rootPath, fullPath)
        )
      } else if (dirent.isFile()) {
        filePaths.push(fullPath)
      }
    }
    return filePaths
  }

  public async injestDocuments(
    directoryPath: string
  ): Promise<EmbeddingDatabase> {
    const filePaths = await this.getAllFilePaths(directoryPath, directoryPath)
    const totalFiles = filePaths.length
    let processedFiles = 0
    const embeddingQueue = new PQueue({ concurrency: 30 })
    const currentlyProcessingFilePaths = new Set<string>()

    let docsBatch: EmbeddedDocument[] = []
    let filePathsBatch: EmbeddedDocument[] = []
    let currentBatchSize: number = 0
    const maxBatchSize: number = 1000

    await this.clearDatabase()

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Embedding",
        cancellable: true
      },
      async (progress, token) => {
        if (!this.context) return

        const startTime = Date.now()

        const promises = filePaths.map(async (filePath) =>
          embeddingQueue.add(async () => {
            if (token.isCancellationRequested) {
              embeddingQueue.clear()
              return
            }

            const fileName = filePath.split("/").pop() || ""
            currentlyProcessingFilePaths.add(fileName)
            progress.report({
              message: this.getProgressReportMessage(
                processedFiles,
                totalFiles,
                currentlyProcessingFilePaths
              )
            })

            const content = await fs.promises.readFile(filePath, "utf-8")

            const chunks = await getDocumentSplitChunks(
              content,
              filePath,
              this.context
            )

            const filePathEmbedding = await this.fetchModelEmbedding(filePath)

            filePathsBatch.push({
              content: filePath,
              vector: filePathEmbedding,
              file: filePath
            })

            for (const chunk of chunks) {
              const chunkEmbedding = await this.fetchModelEmbedding(chunk)
              if (this.getIsDuplicateItem(chunk, chunks)) break
              docsBatch.push({
                content: chunk,
                vector: chunkEmbedding,
                file: filePath
              })
            }

            currentBatchSize++

            if (currentBatchSize >= maxBatchSize) {
              this.populateDatabase(docsBatch, filePathsBatch)
              docsBatch = []
              filePathsBatch = []
              currentBatchSize = 0
            }

            currentlyProcessingFilePaths.delete(fileName)
            processedFiles++
            progress.report({
              message: this.getProgressReportMessage(
                processedFiles,
                totalFiles,
                currentlyProcessingFilePaths
              ),
              increment: 100 / totalFiles
            })
          })
        )

        await Promise.all(promises)

        if (currentBatchSize > 0) {
          await this.populateDatabase(docsBatch, filePathsBatch)
        }

        const endTime = Date.now()
        const elapsedSeconds = ((endTime - startTime) / 1000).toFixed(2)

        vscode.window.showInformationMessage(
          `Embedded successfully! Processed ${totalFiles} files and finished in ${elapsedSeconds} seconds.`
        )
      }
    )

    return this
  }

  private getProgressReportMessage(
    processedFiles: number,
    totalFiles: number,
    currentlyProcessingFilePaths: Set<string>
  ) {
    return `${((processedFiles / totalFiles) * 100).toFixed(2)}% ${Array.from(
      currentlyProcessingFilePaths
    )
      .join(",\u00A0")
      .slice(0, 165)}...`
  }

  public async clearDatabase() {
    try {
      const tableNames = await this._db?.tableNames()
      if (tableNames?.includes(`${this._workspaceName}-documents`)) {
        await this._db?.dropTable(`${this._workspaceName}-documents`)
      }

      if (tableNames?.includes(`${this._workspaceName}-file-paths`)) {
        await this._db?.dropTable(`${this._workspaceName}-file-paths`)
      }
    } catch (e) {
      console.log("Error clearing database", e)
    }
  }

  public async populateDatabase(
    documents: EmbeddedDocument[],
    filePaths: EmbeddedDocument[]
  ) {
    try {
      const tableNames = await this._db?.tableNames()

      if (!tableNames?.includes(this._documentTableName)) {
        await this._db?.createTable(this._documentTableName, documents, {
          mode: "overwrite"
        })
      } else {
        const table = await this._db?.openTable(this._documentTableName)
        await table?.add(documents)
      }

      if (!tableNames?.includes(this._filePathTableName)) {
        await this._db?.createTable(this._filePathTableName, filePaths, {
          mode: "overwrite"
        })
      } else {
        const table = await this._db?.openTable(this._filePathTableName)
        await table?.add(documents)
      }
    } catch (e) {
      console.log("Error populating database", e)
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
      const query = table?.vectorSearch(vector).limit(limit)
      if (where) query?.where(where)
      return query?.toArray()
    } catch {
      return undefined
    }
  }

  public async getDocumentByFilePath(filePath: string) {
    const content = await fs.promises.readFile(filePath, "utf-8")
    const contentSnippet = content?.slice(0, 500)
    return contentSnippet
  }

  private getIsDuplicateItem(item: string, collection: string[]): boolean {
    return collection.includes(item.trim().toLowerCase())
  }

  private getEmbeddingFromResponse<T>(
    provider: TwinnyProvider,
    response: T
  ): number[] {
    if (provider.provider === API_PROVIDERS.LMStudio) {
      return (response as LMStudioEmbedding).data?.[0].embedding
    }

    return (response as Embedding).embeddings[0]
  }
}
