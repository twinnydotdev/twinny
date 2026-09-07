/**
 * The devices panel's channels, registered per webview.
 *
 * The runtime outlives webviews; this is the thin layer that answers a
 * particular webview's questions and forwards status changes to it.
 */

import { Disposable } from "vscode"

import { P2P_EVENT_NAME } from "../../common/constants"
import { P2pPairResult } from "../../common/messaging/protocol"
import { ExtensionBridge } from "../messaging/bridge"
import { ProviderManager } from "../providers/manager"

import { P2pRuntime } from "./runtime"

export class P2pBridge implements Disposable {
  private readonly _subscriptions: Disposable[]

  constructor(
    private readonly _runtime: P2pRuntime,
    private readonly _bridge: ExtensionBridge,
    private readonly _providers: ProviderManager
  ) {
    _bridge.handleAll({
      [P2P_EVENT_NAME.getDevices]: () => _runtime.statuses(),
      [P2P_EVENT_NAME.pairDevice]: ({ code, name }) => this.pair(code, name),
      [P2P_EVENT_NAME.refreshDevice]: (id) => _runtime.refresh(id),
      [P2P_EVENT_NAME.removeDevice]: (id) => void this.remove(id),
      [P2P_EVENT_NAME.getHost]: () => {
        void _runtime.host.checkOllama()
        return _runtime.host.status()
      },
      [P2P_EVENT_NAME.startHost]: () => _runtime.host.start(),
      [P2P_EVENT_NAME.stopHost]: () => _runtime.host.stop(),
      [P2P_EVENT_NAME.newPairingCode]: () => _runtime.host.newPairingCode(),
      [P2P_EVENT_NAME.removeTrustedPeer]: (id) =>
        _runtime.host.removeTrustedPeer(id)
    })
    this._subscriptions = [
      _runtime.onDidChangeDevices((devices) =>
        _bridge.emit(P2P_EVENT_NAME.getDevices, devices)
      ),
      _runtime.host.onDidChange((status) =>
        _bridge.emit(P2P_EVENT_NAME.getHost, status)
      )
    ]
  }

  public dispose() {
    for (const subscription of this._subscriptions) subscription.dispose()
  }

  private async pair(code: string, name?: string): Promise<P2pPairResult> {
    try {
      const device = await this._runtime.pair(code, name)
      return { success: true, device }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private async remove(id: string) {
    await this._runtime.remove(id)
    await this._providers.removeProvidersForDevice(id)
  }
}
