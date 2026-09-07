import {
  CancellationTokenSource,
  ExtensionContext,
  ProgressLocation,
  window,
  workspace
} from "vscode"

import { EMBEDDING_EVENT_NAME, WORKSPACE_STORAGE_KEY } from "../../common/constants"
import { logger } from "../../common/logger"
import {
  EmbeddingProgress,
  EmbeddingStatus
} from "../../common/messaging/protocol"
import { formatDuration } from "../../common/time"
import { ExtensionBridge } from "../messaging/bridge"

import { EmbeddingDatabase } from "./database"

/**
 * Runs and reports on workspace indexing for the embeddings tab.
 *
 * One run at a time. Progress goes to the webview (a bar in the tab) and to
 * a VS Code notification (so it is visible from any tab), and the run stops
 * cleanly on the first provider failure with the reason shown in both.
 */
export class EmbeddingService {
  private _cancel?: CancellationTokenSource
  private _progress: EmbeddingProgress = {
    running: false,
    processed: 0,
    total: 0,
    currentFiles: []
  }

  constructor(
    private readonly _context: ExtensionContext,
    private readonly _bridge: ExtensionBridge,
    private readonly _db: EmbeddingDatabase | undefined
  ) {
    _bridge.handleAll({
      [EMBEDDING_EVENT_NAME.embed]: () => void this.embedWorkspace(),
      [EMBEDDING_EVENT_NAME.cancel]: () => this._cancel?.cancel(),
      [EMBEDDING_EVENT_NAME.getStatus]: () => this.getStatus()
    })
  }

  public async getStatus(): Promise<EmbeddingStatus> {
    const counts = (await this._db?.countRows()) || { files: 0, chunks: 0 }
    return {
      indexed: counts.files > 0 || counts.chunks > 0,
      ...counts,
      updatedAt: this._context.workspaceState.get<number>(
        WORKSPACE_STORAGE_KEY.embeddingsUpdatedAt
      ),
      running: this._progress.running,
      workspace: workspace.name
    }
  }

  private report(patch: Partial<EmbeddingProgress>) {
    this._progress = { ...this._progress, ...patch }
    this._bridge.emit(EMBEDDING_EVENT_NAME.progress, this._progress)
  }

  public async embedWorkspace(): Promise<void> {
    const folders = workspace.workspaceFolders
    if (!folders?.length) {
      window.showErrorMessage("Open a folder to index it.")
      return
    }
    if (!this._db) {
      window.showErrorMessage("The embedding database is not available.")
      return
    }
    if (this._progress.running) return

    this._cancel = new CancellationTokenSource()
    const token = this._cancel.token
    const startedAt = Date.now()
    this.report({
      running: true,
      processed: 0,
      total: 0,
      currentFiles: [],
      startedAt,
      error: undefined,
      cancelled: undefined
    })

    let files = 0
    let chunks = 0
    try {
      await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: "twinny: indexing workspace",
          cancellable: true
        },
        async (progress, notificationToken) => {
          notificationToken.onCancellationRequested(() => this._cancel?.cancel())
          for (const folder of folders) {
            if (token.isCancellationRequested) break
            const result = await this._db!.ingestDocuments(folder.uri.fsPath, {
              token,
              onProgress: (update) => {
                this.report({
                  processed: files + update.processed,
                  total: files + update.total,
                  currentFiles: update.currentFiles
                })
                progress.report({
                  message: `${this._progress.processed}/${this._progress.total}`
                })
              }
            })
            files += result.files
            chunks += result.chunks
          }
        }
      )

      if (token.isCancellationRequested) {
        this.report({ running: false, cancelled: true, currentFiles: [] })
        window.showInformationMessage("Indexing cancelled.")
        return
      }

      await this._context.workspaceState.update(
        WORKSPACE_STORAGE_KEY.embeddingsUpdatedAt,
        Date.now()
      )
      this.report({ running: false, currentFiles: [] })
      window.showInformationMessage(
        `Indexed ${files} files (${chunks} chunks) in ${formatDuration(
          Date.now() - startedAt
        )}.`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(`Indexing failed: ${message}`)
      this.report({ running: false, error: message, currentFiles: [] })
      window.showErrorMessage(`Indexing stopped: ${message}`)
    } finally {
      this._cancel?.dispose()
      this._cancel = undefined
      this._bridge.emit(EMBEDDING_EVENT_NAME.getStatus, await this.getStatus())
    }
  }
}
