export const EVENT_NAME = {
  twinntGetLocale: "twinnt-get-locale",
  twinnyAcceptSolution: "twinny-accept-solution",
  twinnyAddMessage: "twinny-add-message",
  twinnyChat: "twinny-chat",
  twinnyChatMessage: "twinny-chat-message",
  twinnyClickSuggestion: "twinny-click-suggestion",
  twinnyConnectedToSymmetry: "twinny-connected-to-symmetry",
  twinnyConnectSymmetry: "twinny-connect-symmetry",
  twinnyDisconnectedFromSymmetry: "twinny-disconnected-from-symmetry",
  twinnyDisconnectSymmetry: "twinny-disconnect-symmetry",
  twinnyEditDefaultTemplates: "twinny-edit-default-templates",
  twinnyEmbedDocuments: "twinny-embed-documents",
  twinnyEnableModelDownload: "twinny-enable-model-download",
  twinnyFetchOllamaModels: "twinny-fetch-ollama-models",
  twinnyFileListRequest: "twinny-file-list-request",
  twinnyFileListResponse: "twinny-file-list-response",
  twinnyGetConfigValue: "twinny-get-config-value",
  twinnyGetGitChanges: "twinny-get-git-changes",
  twinnyGetWorkspaceContext: "twinny-workspace-context",
  twinnyGithhubReview: "twinny-githhub-review",
  twinnyGlobalContext: "twinny-global-context",
  twinnyHideBackButton: "twinny-hide-back-button",
  twinnyListTemplates: "twinny-list-templates",
  twinnyManageTemplates: "twinny-manage-templates",
  twinnyNewConversation: "twinny-new-conversation",
  twinnyNewDocument: "twinny-new-document",
  twinnyNotification: "twinny-notification",
  twinnyOnCompletion: "twinny-on-completion",
  twinnyOnLoading: "twinny-on-loading",
  twinnyOpenDiff: "twinny-open-diff",
  twinnyOpenFile: "twinny-open-file",
  twinnyRerankThresholdChanged: "twinny-rerank-threshold-changed",
  twinnySendLanguage: "twinny-send-language",
  twinnySendLoader: "twinny-send-loader",
  twinnySendRequestBody: "twinny-send-request-body",
  twinnySendSymmetryMessage: "twinny-send-symmetry-message",
  twinnySendSystemMessage: "twinny-send-system-message",
  twinnySendTheme: "twinny-send-theme",
  twinnySessionContext: "twinny-session-context",
  twinnySetConfigValue: "twinny-set-config-value",
  twinnySidebarReady: "twinny-sidebar-ready",
  twinnySetGlobalContext: "twinny-set-global-context",
  twinnySetLocale: "twinny-set-locale",
  twinnySetOllamaModel: "twinny-set-ollama-model",
  twinnySetSessionContext: "twinny-set-session-context",
  twinnySetTab: "twinny-set-tab",
  twinnySetWorkspaceContext: "twinny-set-workspace-context",
  twinnyStartSymmetryProvider: "twinny-start-symmetry-provider",
  twinnyStopGeneration: "twinny-stop-generation",
  twinnyStopSymmetryProvider: "twinny-stop-symmetry-provider",
  twinnySymmetryModels: "twinny-symmetry-models",
  twinnyGetSymmetryModels: "twinny-get-symmetry-models",
  twinnyTextSelection: "twinny-text-selection",
  twinnyGetModels: "twinny-get-models",
  twinnyUpdateContextItems: "twinny-update-context-items",
  twinnyGetContextItems: "twinny-get-context-items",
  twinnyRemoveContextItem: "twinny-remove-context-item"
}

export const CONVERSATION_EVENT_NAME = {
  clearAllConversations: "twinny.clear-all-conversations",
  getActiveConversation: "twinny.get-active-conversation",
  getConversations: "twinny.get-conversations",
  removeConversation: "twinny.remove-conversation",
  saveConversation: "twinny.save-conversation",
  saveLastConversation: "twinny.save-last-conversation",
  setActiveConversation: "twinny.set-active-conversation"
}

export const PROVIDER_EVENT_NAME = {
  addProvider: "twinny.add-provider",
  copyProvider: "twinny.copy-provider",
  focusProviderTab: "twinny.focus-provider-tab",
  getActiveChatProvider: "twinny.get-active-provider",
  getActiveEmbeddingsProvider: "twinny.get-active-embeddings-provider",
  getActiveFimProvider: "twinny.get-active-fim-provider",
  getAllProviders: "twinny.get-providers",
  removeProvider: "twinny.remove-provider",
  resetProvidersToDefaults: "twinny.reset-providers-to-defaults",
  exportProviders: "twinny.export-providers",
  importProviders: "twinny.import-providers",
  setActiveChatProvider: "twinny.set-active-chat-provider",
  setActiveEmbeddingsProvider: "twinny.set-active-embeddings-provider",
  setActiveFimProvider: "twinny.set-active-fim-provider",
  updateProvider: "twinny.update-provider",
  testProvider: "twinny.test-provider",
  testProviderResult: "twinny.test-provider-result"
}

export const GITHUB_EVENT_NAME = {
  getPullRequests: "github.getPullRequests",
  getPullRequestReview: "github.getPullRequestReview"
}

export const SYMMETRY_EMITTER_KEY = {
  inference: "inference"
}
