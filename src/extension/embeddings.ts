import * as lancedb from "@lancedb/lancedb"
import { IntoVector } from "@lancedb/lancedb/dist/arrow"
import fs from "fs"
import ignore from "ignore"
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
import PQueue from "p-queue"
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
  private _embeddingQueue = new PQueue({ concurrency: 5 })

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
    return this._embeddingQueue.add(async () => {
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

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Embedding",
        cancellable: true
      },
      async (progress) => {
        if (!this.context) return
        const promises = filePaths.map(async (filePath) => {
          const content = await fs.promises.readFile(filePath, "utf-8")

          const chunks = await getDocumentSplitChunks(
            content,
            filePath,
            this.context
          )

          const filePathEmbedding = await this.fetchModelEmbedding(filePath)

          this._filePaths.push({
            content: filePath,
            vector: filePathEmbedding,
            file: filePath
          })

          for (const chunk of chunks) {
            const chunkEmbedding = await this.fetchModelEmbedding(chunk)
              if (this.getIsDuplicateItem(chunk, chunks)) continue

            this._documents.push({
              content: chunk,
              vector: chunkEmbedding,
              file: filePath
            })
          }

          processedFiles++
          progress.report({
            message: `${((processedFiles / totalFiles) * 100).toFixed(
              2
            )}% (${filePath.split("/").pop()})`
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
        await this._db?.createTable(this._documentTableName, this._documents, {
          mode: "overwrite"
        })
      }

      if (!tableNames?.includes(`${this._workspaceName}-file-paths`)) {
        await this._db?.createTable(this._filePathTableName, this._filePaths, {
          mode: "overwrite"
        })
        return
      }

      await this._db?.dropTable(`${this._workspaceName}-documents`)
      await this._db?.dropTable(`${this._workspaceName}-file-paths`)
      await this.populateDatabase()

      this._documents.length = 0
      this._filePaths.length = 0
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
