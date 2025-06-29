export const OPEN_AI_COMPATIBLE_PROVIDERS = {
  LiteLLM: "litellm",
  Deepseek: "deepseek",
  LMStudio: "lmstudio",
  Oobabooga: "oobabooga",
  OpenWebUI: "openwebui",
  Ollama: "ollama",
  Twinny: "twinny",
  OpenAICompatible: "openai-compatible"
}

export const API_PROVIDERS = {
  Anthropic: "anthropic",
  OpenAI: "openai",
  Mistral: "mistral",
  LlamaCpp: "llamacpp",
  Groq: "groq",
  OpenRouter: "openrouter",
  Cohere: "cohere",
  Perplexity: "perplexity",
  Gemini: "gemini",
  ...OPEN_AI_COMPATIBLE_PROVIDERS
}

export const DEFAULT_PROVIDER_FORM_VALUES = {
  apiHostname: "0.0.0.0",
  apiKey: "",
  apiPath: "",
  apiPort: 11434,
  apiProtocol: "http",
  id: "",
  label: "",
  modelName: "",
  name: "",
  provider: "ollama",
  type: "chat"
}
