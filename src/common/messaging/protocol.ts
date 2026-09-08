import {
  CONVERSATION_EVENT_NAME,
  EMBEDDING_EVENT_NAME,
  EVENT_NAME,
  GITHUB_EVENT_NAME,
  P2P_EVENT_NAME,
  PROVIDER_EVENT_NAME,
  REVIEW_EVENT_NAME
} from "../constants"
import type { DiscoveredServer } from "../provider-discovery"
import type {
  AnyContextItem,
  ChatCompletionMessage,
  Conversation,
  GitHubPr,
  LanguageType,
  MentionType,
  ModelCatalogue,
  ThemeType,
  TwinnyProvider
} from "../types"

/**
 * A single channel in the protocol.
 *
 * `Payload` is what the sender puts on the wire. `Reply` is what comes back;
 * `never` marks the channel as fire-and-forget, which makes `request()` on it
 * a compile error rather than a promise that hangs forever.
 */
export interface Channel<Payload = void, Reply = never> {
  payload: Payload
  reply: Reply
}

/** Reading and writing a value in one of the extension's storage scopes. */
export interface ContextValue<T = unknown> {
  key: string
  value: T
}

export interface ChatRequest {
  messages: ChatCompletionMessage[]
  /** Files/symbols the user @-mentioned in the composer. */
  mentions: MentionType[]
  conversationId?: string
}

export interface ConfigValue<T = unknown> {
  key: string
  value: T
}

/** The outcome of one live request against a provider. */
export interface ProviderTestResult {
  success: boolean
  /** A readable explanation of the failure, from `describeProviderError`. */
  error?: string
  /** Round-trip time of the probe when it succeeded. */
  latencyMs?: number
  /** What came back, e.g. the first few tokens, to show the model is alive. */
  sample?: string
}

/** Models a provider's endpoint says it serves. */
export interface ProviderModelList {
  models: string[]
  /** Set when the endpoint could not be listed; `models` is then empty. */
  error?: string
}

/** Reply to add/update: either the stored provider or the field errors. */
export interface ProviderSaveResult {
  success: boolean
  provider?: TwinnyProvider
  errors?: Partial<Record<keyof TwinnyProvider, string>>
}

/** What the embeddings tab shows about the workspace index. */
export interface EmbeddingStatus {
  indexed: boolean
  files: number
  chunks: number
  /** Unix ms of the last completed index run. */
  updatedAt?: number
  running: boolean
  workspace?: string
}

/** Live progress of an index run, pushed as files are processed. */
export interface EmbeddingProgress {
  running: boolean
  processed: number
  total: number
  /** Files in flight right now, for the status line. */
  currentFiles: string[]
  startedAt?: number
  /** Set when the run stopped because of a failure. */
  error?: string
  /** Set when the run was cancelled by the user. */
  cancelled?: boolean
}

/** A paired peer-to-peer device as the devices panel shows it. */
export interface P2pDeviceStatus {
  /** The device's public key in hex; also the provider's `deviceId`. */
  id: string
  name: string
  state: "online" | "connecting" | "offline"
  /** Round trip of the last ping while online. */
  latencyMs?: number
  /** Whether the node could reach its Ollama on the last ping. */
  ollamaOk?: boolean
  /** Model names the node reported, most recent first known. */
  models: string[]
  pairedAt: number
  lastSeenAt?: number
  /** Why the device is offline, when known. */
  error?: string
}

/** A device allowed to use this machine's Ollama. */
export interface P2pTrustedPeer {
  id: string
  name: string
  pairedAt: number
  lastSeenAt?: number
  connected: boolean
}

/** This machine as a node: sharing its own Ollama with paired devices. */
export interface P2pHostStatus {
  /** Sharing is switched on and comes back after a restart. */
  enabled: boolean
  running: boolean
  /**
   * Sharing is on but another VS Code window on this machine is the one
   * running the node. Only one window may, or paired devices would reach a
   * random one of them.
   */
  runningElsewhere: boolean
  /** What paired devices see this machine as. */
  name: string
  peerId?: string
  /** UDP port devices reach this computer on; what a firewall rule must allow. */
  port: number
  ollamaUrl: string
  ollamaOk?: boolean
  /** The code to paste on another device, while a pairing window is open. */
  pairingCode?: string
  pairingExpiresAt?: number
  trustedPeers: P2pTrustedPeer[]
  error?: string
}

export interface P2pPairRequest {
  /** The pairing code shown by the node. */
  code: string
  /** What to call this device locally; defaults to the node's own name. */
  name?: string
}

export interface P2pPairResult {
  success: boolean
  device?: P2pDeviceStatus
  error?: string
}

export interface ConversationRename {
  id: string
  title: string
}

export interface PullRequestQuery {
  owner: string | undefined
  repo: string | undefined
}

export interface PullRequestReviewRequest extends PullRequestQuery {
  number: number
  title: string
}

/** What the review tab shows about the open folder's git state. */
export interface LocalReviewStatus {
  isRepository: boolean
  branch: string
  /** Detected merge target, e.g. `origin/main`; absent when none was found. */
  base?: string
  workingTreeFiles: number
  branchFiles: number
  /** Owner and repo parsed from the git remote when it points at GitHub. */
  github?: { owner: string; repo: string }
}

export interface LocalReviewRequest {
  mode: "working-tree" | "branch"
  /** Overrides the detected base for `branch` mode. */
  base?: string
}

/* -------------------------------------------------------------------------- */
/*  webview  ->  extension                                                    */
/* -------------------------------------------------------------------------- */

export interface ClientEvents {
  [EVENT_NAME.twinntGetLocale]: Channel<void, string>
  [EVENT_NAME.twinnyAcceptSolution]: Channel<string>
  [EVENT_NAME.twinnyChatMessage]: Channel<ChatRequest>
  [EVENT_NAME.twinnyClickSuggestion]: Channel<string>
  [EVENT_NAME.twinnyEditDefaultTemplates]: Channel
  [EVENT_NAME.twinnyFileListRequest]: Channel<void, string[]>
  [EVENT_NAME.twinnyGetConfigValue]: Channel<{ key: string }, ConfigValue>
  [EVENT_NAME.twinnyGetContextItems]: Channel
  [EVENT_NAME.twinnyGetGitChanges]: Channel
  [EVENT_NAME.twinnyGetModels]: Channel<void, ModelCatalogue>
  [EVENT_NAME.twinnyGetWorkspaceContext]: Channel<{ key: string }, ContextValue>
  [EVENT_NAME.twinnyGlobalContext]: Channel<{ key: string }, ContextValue>
  [EVENT_NAME.twinnyHideBackButton]: Channel
  [EVENT_NAME.twinnyListTemplates]: Channel<void, string[]>
  [EVENT_NAME.twinnyNewConversation]: Channel
  [EVENT_NAME.twinnyNewDocument]: Channel<string>
  [EVENT_NAME.twinnyNotification]: Channel<string>
  [EVENT_NAME.twinnyOpenFile]: Channel<string>
  [EVENT_NAME.twinnyOpenProviders]: Channel
  [EVENT_NAME.twinnyRemoveContextItem]: Channel<string>
  [EVENT_NAME.twinnySendLanguage]: Channel<void, LanguageType>
  [EVENT_NAME.twinnySendTheme]: Channel<void, ThemeType>
  [EVENT_NAME.twinnySessionContext]: Channel<{ key: string }, ContextValue>
  [EVENT_NAME.twinnySetConfigValue]: Channel<ConfigValue>
  [EVENT_NAME.twinnySetGlobalContext]: Channel<ContextValue>
  [EVENT_NAME.twinnySetSessionContext]: Channel<ContextValue>
  [EVENT_NAME.twinnySetWorkspaceContext]: Channel<ContextValue>
  [EVENT_NAME.twinnySidebarReady]: Channel
  [EVENT_NAME.twinnyStopGeneration]: Channel
  [EVENT_NAME.twinnyTextSelection]: Channel<void, string>

  [CONVERSATION_EVENT_NAME.clearAllConversations]: Channel
  [CONVERSATION_EVENT_NAME.getActiveConversation]: Channel
  [CONVERSATION_EVENT_NAME.getConversations]: Channel
  [CONVERSATION_EVENT_NAME.removeConversation]: Channel<Conversation>
  [CONVERSATION_EVENT_NAME.renameConversation]: Channel<ConversationRename>
  [CONVERSATION_EVENT_NAME.saveConversation]: Channel<Conversation | undefined>
  [CONVERSATION_EVENT_NAME.setActiveConversation]: Channel<
    Conversation | undefined
  >

  [EMBEDDING_EVENT_NAME.cancel]: Channel
  [EMBEDDING_EVENT_NAME.embed]: Channel
  [EMBEDDING_EVENT_NAME.getStatus]: Channel<void, EmbeddingStatus>

  [PROVIDER_EVENT_NAME.addProvider]: Channel<TwinnyProvider, ProviderSaveResult>
  [PROVIDER_EVENT_NAME.copyProvider]: Channel<TwinnyProvider>
  [PROVIDER_EVENT_NAME.discoverProviders]: Channel<void, DiscoveredServer[]>
  [PROVIDER_EVENT_NAME.exportProviders]: Channel
  [PROVIDER_EVENT_NAME.getActiveChatProvider]: Channel
  [PROVIDER_EVENT_NAME.getActiveEmbeddingsProvider]: Channel
  [PROVIDER_EVENT_NAME.getActiveFimProvider]: Channel
  [PROVIDER_EVENT_NAME.getAllProviders]: Channel
  [PROVIDER_EVENT_NAME.importProviders]: Channel
  [PROVIDER_EVENT_NAME.listProviderModels]: Channel<
    TwinnyProvider,
    ProviderModelList
  >
  [PROVIDER_EVENT_NAME.removeProvider]: Channel<TwinnyProvider>
  [PROVIDER_EVENT_NAME.resetProvidersToDefaults]: Channel
  [PROVIDER_EVENT_NAME.setActiveChatProvider]: Channel<TwinnyProvider>
  [PROVIDER_EVENT_NAME.setActiveEmbeddingsProvider]: Channel<TwinnyProvider>
  [PROVIDER_EVENT_NAME.setActiveFimProvider]: Channel<TwinnyProvider>
  [PROVIDER_EVENT_NAME.testProvider]: Channel<TwinnyProvider, ProviderTestResult>
  [PROVIDER_EVENT_NAME.updateProvider]: Channel<
    TwinnyProvider,
    ProviderSaveResult
  >
  [PROVIDER_EVENT_NAME.useDiscoveredServer]: Channel<
    DiscoveredServer,
    TwinnyProvider[]
  >

  [GITHUB_EVENT_NAME.getPullRequests]: Channel<PullRequestQuery, GitHubPr[]>
  [GITHUB_EVENT_NAME.getPullRequestReview]: Channel<PullRequestReviewRequest>

  [P2P_EVENT_NAME.getDevices]: Channel<void, P2pDeviceStatus[]>
  [P2P_EVENT_NAME.pairDevice]: Channel<P2pPairRequest, P2pPairResult>
  [P2P_EVENT_NAME.refreshDevice]: Channel<string, P2pDeviceStatus | undefined>
  [P2P_EVENT_NAME.removeDevice]: Channel<string>
  [P2P_EVENT_NAME.getHost]: Channel<void, P2pHostStatus>
  [P2P_EVENT_NAME.startHost]: Channel<void, P2pHostStatus>
  [P2P_EVENT_NAME.stopHost]: Channel<void, P2pHostStatus>
  [P2P_EVENT_NAME.newPairingCode]: Channel<void, P2pHostStatus>
  [P2P_EVENT_NAME.removeTrustedPeer]: Channel<string, P2pHostStatus>

  [REVIEW_EVENT_NAME.getLocalStatus]: Channel<void, LocalReviewStatus>
  [REVIEW_EVENT_NAME.reviewLocal]: Channel<LocalReviewRequest>
}

/* -------------------------------------------------------------------------- */
/*  extension  ->  webview                                                    */
/* -------------------------------------------------------------------------- */

export interface ServerEvents {
  [EVENT_NAME.twinnyAddMessage]: ChatCompletionMessage | undefined
  [EVENT_NAME.twinnyGetConfigValue]: ConfigValue
  [EVENT_NAME.twinnyGetModels]: ModelCatalogue
  [EVENT_NAME.twinnyGetWorkspaceContext]: ContextValue
  [EVENT_NAME.twinnyGlobalContext]: ContextValue
  [EVENT_NAME.twinnyListTemplates]: string[]
  [EVENT_NAME.twinnyNewConversation]: void
  [EVENT_NAME.twinnyOnCompletion]: ChatCompletionMessage
  [EVENT_NAME.twinnyOnLoading]: void
  [EVENT_NAME.twinnySendLanguage]: LanguageType
  [EVENT_NAME.twinnySendLoader]: string
  [EVENT_NAME.twinnySendTheme]: ThemeType
  [EVENT_NAME.twinnySessionContext]: ContextValue
  [EVENT_NAME.twinnySetLocale]: string
  [EVENT_NAME.twinnySetTab]: string
  [EVENT_NAME.twinnyStopGeneration]: void
  [EVENT_NAME.twinnyTextSelection]: string
  [EVENT_NAME.twinnyUpdateContextItems]: AnyContextItem[]

  [CONVERSATION_EVENT_NAME.getConversations]: Record<string, Conversation>
  [CONVERSATION_EVENT_NAME.setActiveConversation]: Conversation | undefined

  [EMBEDDING_EVENT_NAME.getStatus]: EmbeddingStatus
  [EMBEDDING_EVENT_NAME.progress]: EmbeddingProgress

  [PROVIDER_EVENT_NAME.focusProviderTab]: string
  [PROVIDER_EVENT_NAME.getActiveChatProvider]: TwinnyProvider | undefined
  [PROVIDER_EVENT_NAME.getActiveEmbeddingsProvider]: TwinnyProvider | undefined
  [PROVIDER_EVENT_NAME.getActiveFimProvider]: TwinnyProvider | undefined
  [PROVIDER_EVENT_NAME.getAllProviders]: Record<string, TwinnyProvider>

  [GITHUB_EVENT_NAME.getPullRequests]: GitHubPr[]

  [P2P_EVENT_NAME.getDevices]: P2pDeviceStatus[]
  [P2P_EVENT_NAME.getHost]: P2pHostStatus
}

/* -------------------------------------------------------------------------- */
/*  Derived types                                                             */
/* -------------------------------------------------------------------------- */

export type ClientEventName = keyof ClientEvents
export type ServerEventName = keyof ServerEvents

export type PayloadOf<K extends ClientEventName> = ClientEvents[K]["payload"]
export type ReplyOf<K extends ClientEventName> = ClientEvents[K]["reply"]
export type ServerPayloadOf<K extends ServerEventName> = ServerEvents[K]

/** The subset of client channels that actually answer — see `Channel`. */
export type RequestableEvent = {
  [K in ClientEventName]: [ReplyOf<K>] extends [never] ? never : K
}[ClientEventName]

/** Channels whose payload is `void`, so the caller may omit the argument. */
export type VoidPayloadEvent = {
  [K in ClientEventName]: [PayloadOf<K>] extends [void] ? K : never
}[ClientEventName]

/* -------------------------------------------------------------------------- */
/*  Compile-time guards                                                       */
/* -------------------------------------------------------------------------- */

type EveryName =
  | (typeof EVENT_NAME)[keyof typeof EVENT_NAME]
  | (typeof CONVERSATION_EVENT_NAME)[keyof typeof CONVERSATION_EVENT_NAME]
  | (typeof EMBEDDING_EVENT_NAME)[keyof typeof EMBEDDING_EVENT_NAME]
  | (typeof PROVIDER_EVENT_NAME)[keyof typeof PROVIDER_EVENT_NAME]
  | (typeof GITHUB_EVENT_NAME)[keyof typeof GITHUB_EVENT_NAME]
  | (typeof P2P_EVENT_NAME)[keyof typeof P2P_EVENT_NAME]
  | (typeof REVIEW_EVENT_NAME)[keyof typeof REVIEW_EVENT_NAME]

/**
 * Every declared name must be used by at least one direction, and no channel
 * may invent a name that is not in the constants. Deleting a constant that is
 * still in the protocol — or adding one nobody speaks — fails the build here.
 */
type Assert<T extends true> = T
type Extends<A, B> = [A] extends [B] ? true : false

export type _NamesAreDeclared = Assert<
  Extends<ClientEventName | ServerEventName, EveryName>
>
export type _NamesAreUsed = Assert<
  Extends<EveryName, ClientEventName | ServerEventName>
>

/**
 * A channel that exists in both directions must agree with itself: the value
 * the extension replies with is the same value it broadcasts unprompted.
 */
export type _RepliesMatchBroadcasts = Assert<
  {
    [K in ClientEventName & ServerEventName]: [ReplyOf<K>] extends [never]
      ? true
      : Extends<ReplyOf<K>, ServerEvents[K]>
  }[ClientEventName & ServerEventName] extends true
    ? true
    : false
>
