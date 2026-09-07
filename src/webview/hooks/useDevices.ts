import { P2P_EVENT_NAME } from "../../common/constants"
import {
  P2pDeviceStatus,
  P2pHostStatus,
  P2pPairResult
} from "../../common/messaging/protocol"
import { bridge, emit, useServerState } from "../messaging"

const EMPTY: P2pDeviceStatus[] = []

/** The paired P2P devices, kept fresh by the extension's status pushes. */
export const useDevices = () => {
  const { data, isLoading, refetch } = useServerState(
    P2P_EVENT_NAME.getDevices,
    EMPTY
  )

  return {
    devices: data ?? EMPTY,
    isLoading,
    refetch,
    pairDevice: (code: string, name?: string): Promise<P2pPairResult> =>
      bridge
        .request(P2P_EVENT_NAME.pairDevice, { code, name })
        .catch((error: unknown) => ({
          success: false,
          error: error instanceof Error ? error.message : String(error)
        })),
    refreshDevice: (id: string): Promise<P2pDeviceStatus | undefined> =>
      bridge.request(P2P_EVENT_NAME.refreshDevice, id).catch(() => undefined),
    removeDevice: (id: string) => emit(P2P_EVENT_NAME.removeDevice, id)
  }
}

/** This machine as a node, and the switches that drive it. */
export const useHost = () => {
  const { data, isLoading, refetch } = useServerState(P2P_EVENT_NAME.getHost)
  const call = (
    request: () => Promise<P2pHostStatus>
  ): Promise<P2pHostStatus | undefined> => request().catch(() => undefined)
  return {
    host: data,
    isLoading,
    refetch,
    startHost: () => call(() => bridge.request(P2P_EVENT_NAME.startHost)),
    stopHost: () => call(() => bridge.request(P2P_EVENT_NAME.stopHost)),
    newPairingCode: () =>
      call(() => bridge.request(P2P_EVENT_NAME.newPairingCode)),
    removeTrustedPeer: (id: string) =>
      call(() => bridge.request(P2P_EVENT_NAME.removeTrustedPeer, id))
  }
}
