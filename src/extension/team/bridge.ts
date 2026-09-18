/**
 * The share card's channels, registered per webview. `TeamShare`
 * outlives webviews; this answers one webview's questions and forwards
 * status changes to it.
 */
import { Disposable } from "vscode"

import { TEAM_SHARE_EVENT_NAME } from "../../common/constants"
import { ExtensionBridge } from "../messaging/bridge"

import { TeamShare } from "./share"

export class TeamShareBridge implements Disposable {
  private readonly _subscription: Disposable

  constructor(share: TeamShare, bridge: ExtensionBridge) {
    bridge.handleAll({
      [TEAM_SHARE_EVENT_NAME.get]: () => {
        void share.refreshAvailability()
        return share.status()
      },
      [TEAM_SHARE_EVENT_NAME.start]: () => share.start(),
      [TEAM_SHARE_EVENT_NAME.stop]: () => share.stop(),
      [TEAM_SHARE_EVENT_NAME.setBackend]: (backend) => share.setBackend(backend),
      [TEAM_SHARE_EVENT_NAME.discover]: () => share.discover()
    })
    this._subscription = share.onDidChange((status) => bridge.emit(TEAM_SHARE_EVENT_NAME.get, status))
  }

  public dispose() {
    this._subscription.dispose()
  }
}
