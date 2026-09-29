import { ExtensionContext, StatusBarItem, workspace } from "vscode"

import {
  ACTIVE_FIM_PROVIDER_STORAGE_KEY,
  TWINNY_COMMAND_NAME
} from "../common/constants"
import { TwinnyProvider } from "../common/types"

import { GenerationTracker } from "./generations"

const ICON_IDLE = "$(code)"
const ICON_BUSY = "$(loading~spin)"

/**
 * The one status bar item twinny owns. It spins while the generation
 * tracker has anything running, and otherwise reflects the current settings.
 */
export class TwinnyStatusBar {
  private readonly _subscription: { dispose(): void }

  constructor(
    private readonly _item: StatusBarItem,
    private readonly _context: ExtensionContext,
    private readonly _generations: GenerationTracker
  ) {
    this._item.name = "Twinny"
    this._subscription = _generations.onDidChange((state) => {
      if (state.busy) this.showBusy()
      else this.refresh()
    })
  }

  private showBusy() {
    this._item.text = ICON_BUSY
    this._item.tooltip = "Twinny is generating — click to stop"
    this._item.command = TWINNY_COMMAND_NAME.stopGeneration
    this._item.show()
  }

  /** Re-read settings and the active FIM provider; no-op while busy. */
  public refresh() {
    if (this._generations.state.busy) return

    const config = workspace.getConfiguration("twinny")
    if (!config.get<boolean>("enabled", true)) {
      this._item.hide()
      return
    }

    const autoSuggest = config.get<boolean>("autoSuggestEnabled", true)
    const provider = this._context.globalState.get<TwinnyProvider>(
      ACTIVE_FIM_PROVIDER_STORAGE_KEY
    )

    const lines = [
      provider
        ? `Twinny · ${provider.modelName} (${provider.label})`
        : "Twinny · no FIM provider selected",
      autoSuggest
        ? "Auto-suggest is on"
        : "Auto-suggest is off — trigger completions manually with Alt+\\",
      "Click for options"
    ]

    this._item.text = autoSuggest ? ICON_IDLE : `${ICON_IDLE} off`
    this._item.tooltip = lines.join("\n")
    this._item.command = TWINNY_COMMAND_NAME.statusBarMenu
    this._item.show()
  }

  public dispose() {
    this._subscription.dispose()
    this._item.dispose()
  }
}
