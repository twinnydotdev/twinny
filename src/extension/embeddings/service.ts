import {
  CancellationTokenSource,
  Disposable,
  ExtensionContext,
  ProgressLocation,
  window,
  workspace
} from "vscode"

import { EMBEDDING_EVENT_NAME } from "../../common/constants"
import { logger } from "../../common/logger"
import {
  EmbeddingProgress,
  EmbeddingStatus
} from "../../common/messaging/protocol"
import { formatDuration } from "../../common/time"
import { ExtensionBridge } from "../messaging/bridge"

import { WorkspaceIndex } from "./index"
import { IndexRunResult } from "./indexer"

/**
 * The embeddings tab's side of the index: starts update and rebuild runs,
 * cancels them, and reports status and progress. Progress goes to the
 * webview (a bar in the tab) and to a VS Code notification (visible from
 * any tab). A run stops at the first provider failure with the reason
 * shown in both.
 */
export class EmbeddingService implements Disposable {
  private _cancel?: CancellationTokenSource
  private _progress: EmbeddingProgress = {
    running: false,
    phase: "embedding",
    processed: 0,
    total: 0,
    currentFiles: []
  }
  private readonly _subscription?: Disposable

  constructor(
    private readonly _context: ExtensionContext,
    private readonly _bridge: ExtensionBridge,
    private readonly _index: WorkspaceIndex | undefined
  ) {
    _bridge.handleAll({
      [EMBEDDING_EVENT_NAME.embed]: () => void this.run("update"),
      [EMBEDDING_EVENT_NAME.rebuild]: () => void this.run("rebuild"),
      [EMBEDDING_EVENT_NAME.cancel]: () => this._cancel?.cancel(),
      [EMBEDDING_EVENT_NAME.getStatus]: () => this.getStatus()
    })
    this._subscription = _index?.onDidChange(() => void this.pushStatus())
  }

  public dispose() {
    this._subscription?.dispose()
  }

  public async getStatus(): Promise<EmbeddingStatus> {
    const index = this._index
    const manifest = index?.db.manifest
    const files = manifest ? Object.keys(manifest.files).length : 0
    return {
      indexed: files > 0,
      files,
      chunks: (await index?.db.countChunks()) ?? 0,
      updatedAt: manifest?.updatedAt,
      model: manifest?.model || undefined,
      activeModel: index?.embedder.model,
      modelChanged: index?.indexer.modelChanged ?? false,
      running: this._progress.running,
      workspace: workspace.name
    }
  }

  private async pushStatus() {
    this._bridge.emit(EMBEDDING_EVENT_NAME.getStatus, await this.getStatus())
  }

  private report(patch: Partial<EmbeddingProgress>) {
    this._progress = { ...this._progress, ...patch }
    this._bridge.emit(EMBEDDING_EVENT_NAME.progress, this._progress)
  }

  private describe(result: IndexRunResult, elapsedMs: number): string {
    const took = formatDuration(elapsedMs)
    if (!result.embedded && !result.removed) {
      return `Index is up to date: ${result.files} files, nothing changed (${took}).`
    }
    const parts = [`${result.embedded} files embedded (${result.chunks} chunks)`]
    if (result.unchanged) parts.push(`${result.unchanged} unchanged`)
    if (result.removed) parts.push(`${result.removed} removed`)
    return `Indexed: ${parts.join(", ")} in ${took}.`
  }

  public async run(mode: "update" | "rebuild"): Promise<void> {
    if (!workspace.workspaceFolders?.length) {
      window.showErrorMessage("Open a folder to index it.")
      return
    }
    if (!this._index) {
      window.showErrorMessage("The embedding database is not available.")
      return
    }
    if (this._progress.running) return

    this._cancel = new CancellationTokenSource()
    const token = this._cancel.token
    const startedAt = Date.now()
    this._index.running = true
    this.report({
      running: true,
      phase: "scanning",
      processed: 0,
      total: 0,
      currentFiles: [],
      startedAt,
      error: undefined,
      cancelled: undefined
    })

    try {
      const result = await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: mode === "rebuild" ? "twinny: rebuilding index" : "twinny: updating index",
          cancellable: true
        },
        (progress, notificationToken) => {
          notificationToken.onCancellationRequested(() => this._cancel?.cancel())
          return this._index!.indexer.run({
            mode,
            token,
            onProgress: (update) => {
              this.report(update)
              progress.report({
                message:
                  update.phase === "embedding"
                    ? `${update.processed}/${update.total}`
                    : update.phase
              })
            }
          })
        }
      )

      if (token.isCancellationRequested) {
        this.report({ running: false, cancelled: true, currentFiles: [] })
        window.showInformationMessage(
          `Indexing cancelled. ${result.embedded} files were embedded and kept; run again to continue.`
        )
        return
      }

      this.report({ running: false, currentFiles: [] })
      window.showInformationMessage(this.describe(result, Date.now() - startedAt))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(`Indexing failed: ${message}`)
      this.report({ running: false, error: message, currentFiles: [] })
      window.showErrorMessage(`Indexing stopped: ${message}`)
    } finally {
      this._index.running = false
      this._cancel?.dispose()
      this._cancel = undefined
      await this.pushStatus()
    }
  }
}
