export const OPEN_AI_COMPATIBLE_PROVIDERS = {
  LiteLLM: "litellm",
  Deepseek: "deepseek",
  LMStudio: "lmstudio",
  Oobabooga: "oobabooga",
  OpenWebUI: "openwebui",
  Ollama: "ollama",
  LlamaCpp: "llamacpp",
  OpenAICompatible: "openai-compatible"
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

export const DEFAULT_PROVIDER_FORM_VALUES = {
  apiHostname: "localhost",
  apiKey: "",
  apiPath: "/v1",
  apiPort: 11434,
  apiProtocol: "http",
  id: "",
  label: "",
  modelName: "",
  provider: "ollama",
  type: "chat"
}
