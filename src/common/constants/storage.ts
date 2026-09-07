export const ACTIVE_CONVERSATION_STORAGE_KEY = "twinny.active-conversation"
export const ACTIVE_CHAT_PROVIDER_STORAGE_KEY = "twinny.active-chat-provider"
export const ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY =
  "twinny.active-embeddings-provider"
export const ACTIVE_FIM_PROVIDER_STORAGE_KEY = "twinny.active-fim-provider"
export const CONVERSATION_STORAGE_KEY = "twinny.conversations"
export const INFERENCE_PROVIDERS_STORAGE_KEY = "twinny.inference-providers"
/** Paired P2P devices, keyed by their public key. */
export const P2P_DEVICES_STORAGE_KEY = "twinny.p2p.devices"
/** This installation's P2P identity seed, kept in secret storage. */
export const P2P_IDENTITY_SECRET_KEY = "twinny.p2p.identity-seed"
/** The seed this machine uses when it shares its own Ollama. */
export const P2P_HOST_SECRET_KEY = "twinny.p2p.host-seed"
/** Whether this machine should share its Ollama on start. */
export const P2P_HOST_ENABLED_STORAGE_KEY = "twinny.p2p.host-enabled"
/** Devices allowed to use this machine's Ollama. */
export const P2P_TRUSTED_PEERS_STORAGE_KEY = "twinny.p2p.trusted-peers"

export const GLOBAL_STORAGE_KEY = {
  selectedModel: "twinny.selectedModel"
}

export const WORKSPACE_STORAGE_KEY = {
  autoScroll: "autoScroll",
  chatMessage: "chatMessage",
  contextItems: "contextItems", // Renamed from contextFiles
  downloadCancelled: "downloadCancelled",
  selectedTemplates: "selectedTemplates",
  selection: "selection",
  showEmbeddingOptions: "showEmbeddingOptions",
  showProviders: "showProviders",
  reviewOwner: "reviewOwner",
  reviewRepo: "reviewRepo",
  embeddingsUpdatedAt: "embeddingsUpdatedAt"
}

export const EXTENSION_SETTING_KEY = {
  apiProvider: "apiProvider",
  apiProviderFim: "apiProviderFim",
  chatModelName: "chatModelName",
  fimModelName: "fimModelName"
}
