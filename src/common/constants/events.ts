/**
 * Channel names for the extension <-> webview protocol.
 *
 * These are just the *names*. The payload each name carries is declared once,
 * for both sides, in `src/common/messaging/protocol.ts` — and a compile-time
 * assertion there guarantees every name below is accounted for.
 */
export const EVENT_NAME = {
  twinntGetLocale: "twinnt-get-locale",
  twinnyAcceptSolution: "twinny-accept-solution",
  twinnyAddMessage: "twinny-add-message",
  twinnyChatMessage: "twinny-chat-message",
  twinnyClickSuggestion: "twinny-click-suggestion",
  twinnyEditDefaultTemplates: "twinny-edit-default-templates",
  twinnyFetchOllamaModels: "twinny-fetch-ollama-models",
  twinnyFileListRequest: "twinny-file-list-request",
  twinnyGetConfigValue: "twinny-get-config-value",
  twinnyGetContextItems: "twinny-get-context-items",
  twinnyGetGitChanges: "twinny-get-git-changes",
  twinnyGetModels: "twinny-get-models",
  twinnyGetWorkspaceContext: "twinny-workspace-context",
  twinnyGlobalContext: "twinny-global-context",
  twinnyHideBackButton: "twinny-hide-back-button",
  twinnyListTemplates: "twinny-list-templates",
  twinnyNewConversation: "twinny-new-conversation",
  twinnyNewDocument: "twinny-new-document",
  twinnyNotification: "twinny-notification",
  twinnyOnCompletion: "twinny-on-completion",
  twinnyOnLoading: "twinny-on-loading",
  twinnyOpenDiff: "twinny-open-diff",
  twinnyOpenFile: "twinny-open-file",
  twinnyOpenProviders: "twinny-open-providers",
  twinnyRemoveContextItem: "twinny-remove-context-item",
  twinnySendLanguage: "twinny-send-language",
  twinnySendLoader: "twinny-send-loader",
  twinnySendTheme: "twinny-send-theme",
  twinnySessionContext: "twinny-session-context",
  twinnySetConfigValue: "twinny-set-config-value",
  twinnySetGlobalContext: "twinny-set-global-context",
  twinnySetLocale: "twinny-set-locale",
  twinnySetSessionContext: "twinny-set-session-context",
  twinnySetTab: "twinny-set-tab",
  twinnySetWorkspaceContext: "twinny-set-workspace-context",
  twinnySidebarReady: "twinny-sidebar-ready",
  twinnyStopGeneration: "twinny-stop-generation",
  twinnyTextSelection: "twinny-text-selection",
  twinnyUpdateContextItems: "twinny-update-context-items"
} as const

export const CONVERSATION_EVENT_NAME = {
  clearAllConversations: "twinny.clear-all-conversations",
  getActiveConversation: "twinny.get-active-conversation",
  getConversations: "twinny.get-conversations",
  removeConversation: "twinny.remove-conversation",
  renameConversation: "twinny.rename-conversation",
  saveConversation: "twinny.save-conversation",
  setActiveConversation: "twinny.set-active-conversation"
} as const

export const EMBEDDING_EVENT_NAME = {
  cancel: "embeddings.cancel",
  embed: "embeddings.embed",
  getStatus: "embeddings.getStatus",
  progress: "embeddings.progress"
} as const

export const PROVIDER_EVENT_NAME = {
  addProvider: "twinny.add-provider",
  copyProvider: "twinny.copy-provider",
  exportProviders: "twinny.export-providers",
  focusProviderTab: "twinny.focus-provider-tab",
  getActiveChatProvider: "twinny.get-active-provider",
  getActiveEmbeddingsProvider: "twinny.get-active-embeddings-provider",
  getActiveFimProvider: "twinny.get-active-fim-provider",
  getAllProviders: "twinny.get-providers",
  importProviders: "twinny.import-providers",
  listProviderModels: "twinny.list-provider-models",
  removeProvider: "twinny.remove-provider",
  resetProvidersToDefaults: "twinny.reset-providers-to-defaults",
  setActiveChatProvider: "twinny.set-active-chat-provider",
  setActiveEmbeddingsProvider: "twinny.set-active-embeddings-provider",
  setActiveFimProvider: "twinny.set-active-fim-provider",
  testProvider: "twinny.test-provider",
  updateProvider: "twinny.update-provider"
} as const

export const P2P_EVENT_NAME = {
  getDevices: "p2p.getDevices",
  pairDevice: "p2p.pairDevice",
  refreshDevice: "p2p.refreshDevice",
  removeDevice: "p2p.removeDevice",
  getHost: "p2p.getHost",
  startHost: "p2p.startHost",
  stopHost: "p2p.stopHost",
  newPairingCode: "p2p.newPairingCode",
  removeTrustedPeer: "p2p.removeTrustedPeer"
} as const

export const GITHUB_EVENT_NAME = {
  getPullRequests: "github.getPullRequests",
  getPullRequestReview: "github.getPullRequestReview"
} as const

export const REVIEW_EVENT_NAME = {
  getLocalStatus: "review.getLocalStatus",
  reviewLocal: "review.reviewLocal"
} as const
