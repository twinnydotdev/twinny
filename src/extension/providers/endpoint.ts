/**
 * The provider a request actually uses. A stored provider may be missing
 * something the request needs: a P2P device gets its gateway address here,
 * a Twinny gateway gets its token from secret storage. Everything else
 * passes through unchanged, and no feature knows the difference.
 */
import { TwinnyProvider } from "../../common/types"
import { resolveProviderEndpoint as resolveP2pEndpoint } from "../p2p/endpoint"

import { withGatewayToken } from "./credentials"

export const resolveProviderEndpoint = <T extends TwinnyProvider | undefined>(
  provider: T
): T => withGatewayToken(resolveP2pEndpoint(provider))
