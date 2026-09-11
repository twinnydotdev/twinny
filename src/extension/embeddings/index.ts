import fs from "fs"
import os from "os"
import path from "path"
import * as vscode from "vscode"

import { ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY } from "../../common/constants"
import { logger } from "../../common/logger"
import { TwinnyProvider } from "../../common/types"
import { resolveProviderEndpoint } from "../p2p/endpoint"
import { sanitizeWorkspaceName } from "../utils"

import { EmbeddingDatabase } from "./database"
import { Embedder } from "./embedder"
import { WorkspaceIndexer } from "./indexer"
import { Reranker } from "./reranker"
import { WorkspaceSearch } from "./search"

export { Hit, SearchOptions } from "./search"

/** Saves are re-indexed this long after the last one to a file. */
const SAVE_DEBOUNCE_MS = 1500

/**
 * Everything the workspace index is made of, built once for the life of
 * the extension: the store, the embedder, the reranker (an 87 MB model,
 * loaded once), the indexer and the search over them. Also keeps the index
 * current as files are saved and deleted, when that setting is on.
 */
export class WorkspaceIndex implements vscode.Disposable {
  public readonly db: EmbeddingDatabase
  public readonly embedder: Embedder
  public readonly reranker: Reranker
  public readonly indexer: WorkspaceIndexer
  public readonly search: WorkspaceSearch

  private readonly _changed = new vscode.EventEmitter<void>()
  private readonly _disposables: vscode.Disposable[] = []
  private readonly _pendingSaves = new Map<string, NodeJS.Timeout>()
  private _running = false

  /** Fires after a background update changed what is indexed. */
  public readonly onDidChange = this._changed.event

  private constructor(
    private readonly _context: vscode.ExtensionContext,
    dbPath: string
  ) {
    this.db = new EmbeddingDatabase(dbPath)
    this.embedder = new Embedder(() =>
      resolveProviderEndpoint(
        _context.globalState.get<TwinnyProvider>(ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY)
      )
    )
    this.reranker = new Reranker()
    this.indexer = new WorkspaceIndexer(_context, this.db, this.embedder)
    this.search = new WorkspaceSearch(this.db, this.embedder, this.reranker)

    this._disposables.push(
      this._changed,
      vscode.workspace.onDidSaveTextDocument((document) =>
        this.scheduleSave(document.uri)
      ),
      vscode.workspace.onDidDeleteFiles((event) => {
        for (const uri of event.files) void this.forget(uri)
      }),
      vscode.workspace.onDidRenameFiles((event) => {
        for (const { oldUri, newUri } of event.files) {
          void this.forget(oldUri)
          this.scheduleSave(newUri)
        }
      })
    )
  }

  /**
   * Opens the index for the current workspace under ~/.twinny. Returns
   * nothing when there is no workspace or the store cannot be opened; the
   * rest of the extension must still come up, only the embeddings tab goes
   * without.
   */
  public static async open(
    context: vscode.ExtensionContext
  ): Promise<WorkspaceIndex | undefined> {
    const workspaceName = sanitizeWorkspaceName(vscode.workspace.name)
    if (!workspaceName) return undefined
    try {
      const dbDir = path.join(os.homedir(), ".twinny/embeddings")
      if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true })
      const index = new WorkspaceIndex(context, path.join(dbDir, workspaceName))
      await index.db.connect()
      return index
    } catch (error) {
      logger.error(
        `Embedding database unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return undefined
    }
  }

  /** Set by the service while a full run is going, so saves wait. */
  public set running(value: boolean) {
    this._running = value
  }

  private get updatesOnSave(): boolean {
    return vscode.workspace
      .getConfiguration("twinny")
      .get<boolean>("embeddingUpdateOnSave", true)
  }

  private scheduleSave(uri: vscode.Uri) {
    if (uri.scheme !== "file" || !this.updatesOnSave || !this.db.hasIndex) return
    const file = uri.fsPath
    clearTimeout(this._pendingSaves.get(file))
    this._pendingSaves.set(
      file,
      setTimeout(() => {
        this._pendingSaves.delete(file)
        if (this._running) return
        void this.indexer.updateFile(file).then((changed) => {
          if (changed) this._changed.fire()
        })
      }, SAVE_DEBOUNCE_MS)
    )
  }

  private async forget(uri: vscode.Uri) {
    if (uri.scheme !== "file" || this._running) return
    if (await this.indexer.removeFile(uri.fsPath)) this._changed.fire()
  }

  public dispose() {
    this.reranker.dispose()
    for (const timer of this._pendingSaves.values()) clearTimeout(timer)
    this._pendingSaves.clear()
    for (const disposable of this._disposables) disposable.dispose()
  }
}
