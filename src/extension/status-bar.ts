import { ExtensionContext, StatusBarItem, workspace } from "vscode"

import {
  ACTIVE_FIM_PROVIDER_STORAGE_KEY,
  TWINNY_COMMAND_NAME
} from "../common/constants"
import { TwinnyProvider } from "../common/types"

const ICON_IDLE = "$(code)"
const ICON_BUSY = "$(loading~spin)"

/**
 * The one status bar item twinny owns. Every part of the extension that
 * starts or finishes a request goes through here so the spinner can never be
 * left running, and the idle state always reflects the current settings.
 */
export class TwinnyStatusBar {
  private _busy = 0

  constructor(
    private readonly _item: StatusBarItem,
    private readonly _context: ExtensionContext
  ) {
    this._item.name = "Twinny"
  }

  /** Show the spinner. Calls nest, so overlapping requests are safe. */
  public busy() {
    this._busy++
    this._item.text = ICON_BUSY
    this._item.tooltip = "Twinny is generating — click to stop"
    this._item.command = TWINNY_COMMAND_NAME.stopGeneration
    this._item.show()
  }

  public idle() {
    this._busy = Math.max(0, this._busy - 1)
    if (this._busy === 0) this.refresh()
  }

  /** Re-read settings and the active FIM provider; no-op while busy. */
  public refresh() {
    if (this._busy > 0) return

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
    this._item.dispose()
  }
}
