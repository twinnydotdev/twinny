export const OPEN_AI_COMPATIBLE_PROVIDERS = {
  LiteLLM: "litellm",
  Deepseek: "deepseek",
  LMStudio: "lmstudio",
  Oobabooga: "oobabooga",
  OpenWebUI: "openwebui",
  Ollama: "ollama",
  LlamaCpp: "llamacpp",
  OpenAICompatible: "openai-compatible",
  /** Another machine's Ollama, reached over an encrypted peer-to-peer link. */
  TwinnyP2P: "twinny-p2p"
}

export const API_PROVIDERS = {
  Anthropic: "anthropic",
  OpenAI: "openai",
  Mistral: "mistral",
  Groq: "groq",
  OpenRouter: "openrouter",
  Cohere: "cohere",
  Perplexity: "perplexity",
  Gemini: "gemini",
  ...OPEN_AI_COMPATIBLE_PROVIDERS
}

/** How each provider is named in the UI. */
export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  [API_PROVIDERS.Anthropic]: "Anthropic",
  [API_PROVIDERS.Cohere]: "Cohere",
  [API_PROVIDERS.Deepseek]: "DeepSeek",
  [API_PROVIDERS.Gemini]: "Gemini",
  [API_PROVIDERS.Groq]: "Groq",
  [API_PROVIDERS.LiteLLM]: "LiteLLM",
  [API_PROVIDERS.LlamaCpp]: "llama.cpp",
  [API_PROVIDERS.LMStudio]: "LM Studio",
  [API_PROVIDERS.Mistral]: "Mistral",
  [API_PROVIDERS.Ollama]: "Ollama",
  [API_PROVIDERS.Oobabooga]: "Oobabooga",
  [API_PROVIDERS.OpenAI]: "OpenAI",
  [API_PROVIDERS.OpenAICompatible]: "OpenAI-compatible server",
  [API_PROVIDERS.OpenRouter]: "OpenRouter",
  [API_PROVIDERS.OpenWebUI]: "Open WebUI",
  [API_PROVIDERS.Perplexity]: "Perplexity",
  [API_PROVIDERS.TwinnyP2P]: "Twinny device (P2P)"
}

/**
 * The blank custom form. Any server speaking the OpenAI API is the
 * general case; the port is Ollama's, which is the most common thing to
 * find there and also serves `/v1`.
 */
export const DEFAULT_PROVIDER_FORM_VALUES = {
  apiHostname: "localhost",
  apiKey: "",
  apiPath: "/v1",
  apiPort: 11434,
  apiProtocol: "http",
  id: "",
  label: "",
  modelName: "",
  provider: API_PROVIDERS.OpenAICompatible,
  type: "chat"
}
