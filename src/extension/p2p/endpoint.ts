/**
 * The one place the rest of twinny meets P2P.
 *
 * A `twinny-p2p` provider is stored without an address. At request time the
 * central provider getters pass it through here, which points it at the
 * local gateway for its device. Chat, FIM, embeddings, probes, and anything
 * written later see an ordinary HTTP provider.
 */

import { API_PROVIDERS } from "../../common/constants"
import { TwinnyProvider } from "../../common/types"

import type { P2pGateway } from "./gateway"

let gateway: P2pGateway | undefined

export const setP2pGateway = (instance: P2pGateway | undefined) => {
  gateway = instance
}

/** The route each provider type calls, relative to the device's base path. */
const ROUTE_FOR_TYPE: Record<string, string> = {
  chat: "/v1",
  fim: "/api/generate",
  embedding: "/api/embed"
}

/**
 * Where a device's listing routes (`/api/tags`, `/v1/models`) live on the
 * gateway. Empty for anything but a P2P provider, so callers can prepend it
 * blindly. The per-type route in `apiPath` is for inference, not listing.
 */
export const p2pListingBase = (provider: TwinnyProvider): string =>
  provider.provider === API_PROVIDERS.TwinnyP2P
    ? gateway?.addressFor(provider.deviceId || "")?.basePath || ""
    : ""

export const resolveProviderEndpoint = <T extends TwinnyProvider | undefined>(
  provider: T
): T => {
  if (!provider || provider.provider !== API_PROVIDERS.TwinnyP2P) return provider
  const deviceId = provider.deviceId || ""
  const address = gateway?.addressFor(deviceId)
  if (!address) {
    // No gateway means no route; a refused connection on a closed port gives
    // the provider error path something honest to report.
    return {
      ...provider,
      apiProtocol: "http",
      apiHostname: "127.0.0.1",
      apiPort: 9,
      apiPath: ROUTE_FOR_TYPE[provider.type] || "",
      apiKey: ""
    }
  }
  return {
    ...provider,
    apiProtocol: "http",
    apiHostname: address.hostname,
    apiPort: address.port,
    apiPath: `${address.basePath}${ROUTE_FOR_TYPE[provider.type] || ""}`,
    apiKey: ""
  }
}
