import {
  CONVERSATION_EVENT_NAME,
  EVENT_NAME,
  GITHUB_EVENT_NAME,
  PROVIDER_EVENT_NAME
} from "../constants"
import type {
  AnyContextItem,
  ApiModel,
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

export interface ProviderTestResult {
  success: boolean
  error?: string
}

export interface PullRequestQuery {
  owner: string | undefined
  repo: string | undefined
}

export interface PullRequestReviewRequest extends PullRequestQuery {
  number: number
  title: string
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
  [EVENT_NAME.twinnyEmbedDocuments]: Channel
  [EVENT_NAME.twinnyFetchOllamaModels]: Channel<void, ApiModel[]>
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
  [EVENT_NAME.twinnyOpenDiff]: Channel<string>
  [EVENT_NAME.twinnyOpenFile]: Channel<string>
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
  [CONVERSATION_EVENT_NAME.saveConversation]: Channel<Conversation | undefined>
  [CONVERSATION_EVENT_NAME.setActiveConversation]: Channel<
    Conversation | undefined
  >

  [PROVIDER_EVENT_NAME.addProvider]: Channel<TwinnyProvider>
  [PROVIDER_EVENT_NAME.copyProvider]: Channel<TwinnyProvider>
  [PROVIDER_EVENT_NAME.exportProviders]: Channel
  [PROVIDER_EVENT_NAME.getActiveChatProvider]: Channel
  [PROVIDER_EVENT_NAME.getActiveEmbeddingsProvider]: Channel
  [PROVIDER_EVENT_NAME.getActiveFimProvider]: Channel
  [PROVIDER_EVENT_NAME.getAllProviders]: Channel
  [PROVIDER_EVENT_NAME.importProviders]: Channel
  [PROVIDER_EVENT_NAME.removeProvider]: Channel<TwinnyProvider>
  [PROVIDER_EVENT_NAME.resetProvidersToDefaults]: Channel
  [PROVIDER_EVENT_NAME.setActiveChatProvider]: Channel<TwinnyProvider>
  [PROVIDER_EVENT_NAME.setActiveEmbeddingsProvider]: Channel<TwinnyProvider>
  [PROVIDER_EVENT_NAME.setActiveFimProvider]: Channel<TwinnyProvider>
  [PROVIDER_EVENT_NAME.testProvider]: Channel<TwinnyProvider>
  [PROVIDER_EVENT_NAME.updateProvider]: Channel<TwinnyProvider>

  [GITHUB_EVENT_NAME.getPullRequests]: Channel<PullRequestQuery>
  [GITHUB_EVENT_NAME.getPullRequestReview]: Channel<PullRequestReviewRequest>
}

/* -------------------------------------------------------------------------- */
/*  extension  ->  webview                                                    */
/* -------------------------------------------------------------------------- */

export interface ServerEvents {
  [EVENT_NAME.twinnyAddMessage]: ChatCompletionMessage | undefined
  [EVENT_NAME.twinnyFetchOllamaModels]: ApiModel[]
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

  [PROVIDER_EVENT_NAME.focusProviderTab]: string
  [PROVIDER_EVENT_NAME.getActiveChatProvider]: TwinnyProvider | undefined
  [PROVIDER_EVENT_NAME.getActiveEmbeddingsProvider]: TwinnyProvider | undefined
  [PROVIDER_EVENT_NAME.getActiveFimProvider]: TwinnyProvider | undefined
  [PROVIDER_EVENT_NAME.getAllProviders]: Record<string, TwinnyProvider>
  [PROVIDER_EVENT_NAME.testProviderResult]: ProviderTestResult

  [GITHUB_EVENT_NAME.getPullRequests]: GitHubPr[]
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
  | (typeof PROVIDER_EVENT_NAME)[keyof typeof PROVIDER_EVENT_NAME]
  | (typeof GITHUB_EVENT_NAME)[keyof typeof GITHUB_EVENT_NAME]

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
