export {
  endpointFromProvider,
  fetchRemoteIdentity,
  type RemoteEndpoint,
  RemoteInferenceProvider
} from "./client"
export {
  DEFAULT_MAX_BODY_BYTES,
  handleRemoteRequest,
  type RemoteHandlerOptions,
  type RemoteRequestOutcome,
  type RemoteRouteTarget
} from "./handler"
export * from "./types"
export {
  errorFromBody,
  isDoneFrame,
  isErrorBody,
  isInferenceCapability,
  isInferenceErrorKind,
  isRemoteRequestError,
  kindForStatus,
  matchRemoteRoute,
  methodForRoute,
  parseChatRequest,
  parseEmbeddingRequest,
  parseFimRequest,
  parseFrame,
  parseIdentity,
  parseModels,
  parseRequest,
  parseStatus,
  RemoteRequestError,
  type RemoteRouteMatch,
  remoteRoutePath,
  statusForKind,
  toErrorBody
} from "./wire"
