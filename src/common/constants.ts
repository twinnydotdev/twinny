import { defaultTemplates } from "../extension/templates"

import { FileItem } from "./types"

export const EXTENSION_NAME = "@ext:rjmacarthy.twinny"
export const ASSISTANT = "assistant"
export const USER = "user"
export const TWINNY = "twinny"
export const SYSTEM = "system"
export const YOU = "You"
export const EMPTY_MESAGE = "Sorry, I don’t understand. Please try again."
export const MODEL_ERROR = "Sorry, something went wrong..."
export const OPENING_BRACKETS = ["[", "{", "("]
export const CLOSING_BRACKETS = ["]", "}", ")"]
export const OPENING_TAGS = ["<"]
export const CLOSING_TAGS = ["</"]
export const QUOTES = ["\"", "'", "`"]
export const ALL_BRACKETS = [...OPENING_BRACKETS, ...CLOSING_BRACKETS] as const
export const BRACKET_REGEX = /^[()[\]{}]+$/
export const NORMALIZE_REGEX = /\s*\r?\n|\r/g
export const LINE_BREAK_REGEX = /\r?\n|\r|\n/g
export const FILE_NAME_REGEX =
  /(?:^|\s|`)(?:@\/|\.\/|(?:[\w-]+\/)*)?\.?[\w.-]+\.(?:jsx?|tsx?|css|s[ac]ss|less|styl|html?|json|jsonc|md|markdown|py|ipynb|java|class|jar|cpp|hpp|cc|hh|c|h|rs|go|php|rb|swift|kt|gradle|m|mm|cs|fs|fsx|elm|lua|sql|ya?ml|toml|xml|conf|ini|env|sh|bash|zsh|ps1|bat|cmd|txt|log|text|doc|rtf|pdf|lock|editorconfig|gitignore|eslintrc|prettier|babelrc|d\.ts|test\.tsx?|spec\.tsx?|snap|svg|graphql|gql|proto|vue|svelte|astro|razor|cshtml|aspx?|jsx?\.map|tsx?\.map|min\.js|chunk\.js|bundle\.js)(?=\s|$|`)/g
export const QUOTES_REGEX = /["'`]/g
export const MAX_CONTEXT_LINE_COUNT = 200
export const SKIP_DECLARATION_SYMBOLS = ["="]
export const IMPORT_SEPARATOR = [",", "{"]
export const SKIP_IMPORT_KEYWORDS_AFTER = ["from", "as", "import"]
export const MIN_COMPLETION_CHUNKS = 2
export const MAX_EMPTY_COMPLETION_CHARS = 250
export const DEFAULT_RERANK_THRESHOLD = 0.5
export const URL_SYMMETRY_WS = "https://twinny.dev/ws"

export const defaultChunkOptions = {
  maxSize: 500,
  minSize: 50,
  overlap: 50
}

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
  twinnyAddOpenFilesToContext: "twinny-add-open-file-to-context",
  twinnyGetContextFiles: "twinny-get-context-files",
  twinnyRemoveContextFile: "twinny-remove-context-file",
  twinnyAcceptToolUse: "twinny-accept-tool-use",
  twinnyRejectToolUse: "twinny-reject-tool-use",
  twinnyRunToolUse: "twinny-run-tool-use",
  twinnyToolUseResult:  "twinny-tool-use-result",
  twinnyReadFiles: "twinny-read-files"
}

export const TWINNY_COMMAND_NAME = {
  addTests: "twinny.addTests",
  addTypes: "twinny.addTypes",
  conversationHistory: "twinny.conversationHistory",
  disable: "twinny.disable",
  embeddings: "twinny.embeddings",
  enable: "twinny.enable",
  review: "twinny.review",
  explain: "twinny.explain",
  focusSidebar: "twinny.sidebar.focus",
  generateDocs: "twinny.generateDocs",
  getGitCommitMessage: "twinny.getGitCommitMessage",
  hideBackButton: "twinny.hideBackButton",
  manageProviders: "twinny.manageProviders",
  manageTemplates: "twinny.manageTemplates",
  newConversation: "twinny.newConversation",
  openPanelChat: "twinny.openPanelChat",
  openChat: "twinny.openChat",
  refactor: "twinny.refactor",
  settings: "twinny.settings",
  stopGeneration: "twinny.stopGeneration",
  templateCompletion: "twinny.templateCompletion",
  templates: "twinny.templates",
  twinnySymmetryTab: "twinny.symmetry",
  addFileToContext: "twinny.addFileToContext",
  getContextFiles: "twinny.getContextFiles"
}

export const OPEN_AI_COMPATIBLE_PROVIDERS = {
  LiteLLM: "litellm",
  Deepseek: "deepseek",
  LMStudio: "lmstudio",
  Oobabooga: "oobabooga",
  OpenWebUI: "openwebui",
  Ollama: "ollama",
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
  setActiveChatProvider: "twinny.set-active-chat-provider",
  setActiveEmbeddingsProvider: "twinny.set-active-embeddings-provider",
  setActiveFimProvider: "twinny.set-active-fim-provider",
  updateProvider: "twinny.update-provider"
}

export const ACTIVE_CONVERSATION_STORAGE_KEY = "twinny.active-conversation"
export const ACTIVE_CHAT_PROVIDER_STORAGE_KEY = "twinny.active-chat-provider"
export const ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY =
  "twinny.active-embeddings-provider"
export const ACTIVE_FIM_PROVIDER_STORAGE_KEY = "twinny.active-fim-provider"
export const CONVERSATION_STORAGE_KEY = "twinny.conversations"
export const INFERENCE_PROVIDERS_STORAGE_KEY = "twinny.inference-providers"
export const AGENT_STORAGE_KEY = "twinny.agent"


export const GLOBAL_STORAGE_KEY = {
  autoConnectSymmetryProvider: "twinny.autoConnectSymmetryProvider",
  selectedModel: "twinny.selectedModel"
}

export const WORKSPACE_STORAGE_KEY = {
  autoScroll: "autoScroll",
  chatMessage: "chatMessage",
  contextFiles: "contextFiles",
  downloadCancelled: "downloadCancelled",
  selectedTemplates: "selectedTemplates",
  selection: "selection",
  showEmbeddingOptions: "showEmbeddingOptions",
  showProviders: "showProviders",
  reviewOwner: "reviewOwner",
  reviewRepo: "reviewRepo"
}

export const EXTENSION_SETTING_KEY = {
  apiProvider: "apiProvider",
  apiProviderFim: "apiProviderFim",
  chatModelName: "chatModelName",
  fimModelName: "fimModelName"
}

export const EXTENSION_CONTEXT_NAME = {
  twinnyConversationHistory: "twinnyConversationHistory",
  twinnyEnableRag: "twinnyEnableRag",
  twinnyGeneratingText: "twinnyGeneratingText",
  twinnyManageProviders: "twinnyManageProviders",
  twinnyManageTemplates: "twinnyManageTemplates",
  twinnyMaxChunkSize: "twinnyMaxChunkSize",
  twinnyMinChunkSize: "twinnyMinChunkSize",
  twinnyOverlapSize: "twinnyOverlapSize",
  twinnyRelevantCodeSnippets: "twinnyRelevantCodeSnippets",
  twinnyRelevantFilePaths: "twinnyRelevantFilePaths",
  twinnyRerankThreshold: "twinnyRerankThreshold",
  twinnyReviewTab: "twinnyReviewTab",
  twinnySymmetryTab: "twinnySymmetryTab",
  twinnyEmbeddingsTab: "twinnyEmbeddingsTab",
  twinnyMode: "twinnyMode",
}

export const EXTENSION_SESSION_NAME = {
  twinnySymmetryConnection: "twinnySymmetryConnection",
  twinnySymmetryConnectionProvider: "twinnySymmetryConnectionProvider"
}

export const WEBUI_TABS = {
  chat: "chat",
  history: "history",
  providers: "providers",
  review: "review",
  settings: "templates",
  symmetry: "symmetry",
  embeddings: "embeddings"
}

export const FIM_TEMPLATE_FORMAT = {
  automatic: "automatic",
  codegemma: "codegemma",
  codellama: "codellama",
  codeqwen: "codeqwen",
  codestral: "codestral",
  custom: "custom-template",
  deepseek: "deepseek",
  llama: "llama",
  stableCode: "stable-code",
  starcoder: "starcoder"
}

export const STOP_LLAMA = ["<EOT>"]

export const STOP_DEEPSEEK = [
  "<｜fim▁begin｜>",
  "<｜fim▁hole｜>",
  "<｜fim▁end｜>",
  "<END>",
  "<｜end▁of▁sentence｜>"
]

export const STOP_STARCODER = [
  "<|endoftext|>",
  "<file_sep>",
  "<file_sep>",
  "<fim_prefix>",
  "<repo_name>"
]

export const STOP_QWEN = [
  "<|endoftext|>",
  "<|file_sep|>",
  "<|fim_prefix|>",
  "<|im_end|>",
  "<|im_start|>",
  "<|repo_name|>",
  "<|fim_pad|>",
  "<|cursor|>"
]

export const STOP_CODEGEMMA = ["<|file_separator|>", "<|end_of_turn|>", "<eos>"]

export const STOP_CODESTRAL = ["[PREFIX]", "[SUFFIX]"]

export const DEFAULT_TEMPLATE_NAMES = defaultTemplates.map(({ name }) => name)

export const DEFAULT_ACTION_TEMPLATES = []

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

export const GITHUB_EVENT_NAME = {
  getPullRequests: "github.getPullRequests",
  getPullRequestReview: "github.getPullRequestReview"
}

export const TITLE_GENERATION_PROMPT_MESAGE = `
  Generate a title for this conversation in under 10 words.
  It should not contain any special characters or quotes.
`

export const WASM_LANGUAGES: { [key: string]: string } = {
  "php-s": "php",
  bash: "bash",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cpp: "cpp",
  cs: "c_sharp",
  css: "css",
  cts: "typescript",
  cxx: "cpp",
  eex: "embedded_template",
  el: "elisp",
  elm: "elm",
  emacs: "elisp",
  erb: "ruby",
  ex: "elixir",
  exs: "elixir",
  go: "go",
  h: "c",
  heex: "embedded_template",
  hpp: "cpp",
  htm: "html",
  html: "html",
  hxx: "cpp",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  leex: "embedded_template",
  lua: "lua",
  mjs: "javascript",
  ml: "ocaml",
  mli: "ocaml",
  mts: "typescript",
  ocaml: "ocaml",
  php: "php",
  php3: "php",
  php4: "php",
  php5: "php",
  php7: "php",
  phps: "php",
  phtml: "php",
  py: "python",
  pyi: "python",
  pyw: "python",
  ql: "ql",
  rb: "ruby",
  rdl: "systemrdl",
  res: "rescript",
  resi: "rescript",
  rs: "rust",
  sh: "bash",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  vue: "vue"
}

export const DEFAULT_RELEVANT_FILE_COUNT = 10
export const DEFAULT_RELEVANT_CODE_COUNT = 5

export const MULTILINE_OUTSIDE = [
  "class_body",
  "class",
  "export",
  "identifier",
  "interface_body",
  "interface",
  "program"
]

export const MULTILINE_INSIDE = [
  "body",
  "export_statement",
  "formal_parameters",
  "function_definition",
  "named_imports",
  "object_pattern",
  "object_type",
  "object",
  "parenthesized_expression",
  "statement_block"
]

export const MULTILINE_TYPES = [...MULTILINE_OUTSIDE, ...MULTILINE_INSIDE]

export const MULTI_LINE_DELIMITERS = ["\n\n", "\r\n\r\n"]

export const SYMMETRY_EMITTER_KEY = {
  inference: "inference"
}

//Define an array containing all the error messages that need to be detected when fetch error occurred
export const knownErrorMessages = [
  "First parameter has member 'readable' that is not a ReadableStream.", //This error occurs When plugins such as Fitten Code are enabled
  "The 'transform.readable' property must be an instance of ReadableStream. Received an instance of h" //When you try to enable the Node.js compatibility mode Compat to solve the problem, this error may pop up
]

export const topLevelItems: FileItem[] = [
  { name: "workspace", path: "", category: "workspace" },
  { name: "problems", path: "", category: "problems" }
]

export const diffViewerStyles = {
  variables: {
    light: {
      diffViewerBackground: "#fff",
      diffViewerColor: "#212529",
      addedBackground: "#e6ffed",
      addedColor: "#24292e",
      removedBackground: "#ffeef0",
      removedColor: "#24292e",
      wordAddedBackground: "#acf2bd",
      wordRemovedBackground: "#fdb8c0",
      addedGutterBackground: "#cdffd8",
      removedGutterBackground: "#ffdce0",
      gutterBackground: "#f7f7f7",
      gutterBackgroundDark: "#f3f1f1",
      highlightBackground: "#fffbdd",
      highlightGutterBackground: "#fff5b1",
      codeFoldGutterBackground: "#dbedff",
      codeFoldBackground: "#f1f8ff",
      emptyLineBackground: "#fafbfc",
      gutterColor: "#212529",
      addedGutterColor: "#212529",
      removedGutterColor: "#212529",
      codeFoldContentColor: "#212529",
      diffViewerTitleBackground: "#fafbfc",
      diffViewerTitleColor: "#212529",
      diffViewerTitleBorderColor: "#eee"
    },
    dark: {
      diffViewerBackground: "#1e1e1e",
      diffViewerColor: "#d4d4d4",
      addedBackground: "#1C4532", // Darker but more visible green
      addedColor: "#98FEB3", // Brighter green text
      removedBackground: "#601B1F", // Darker but more visible red
      removedColor: "#FFA3A3", // Brighter red text
      wordAddedBackground: "#236E4A", // Slightly lighter green for word changes
      wordRemovedBackground: "#8B3E44", // Slightly lighter red for word changes
      addedGutterBackground: "#133926",
      removedGutterBackground: "#4D1519",
      gutterBackground: "#252526",
      gutterBackgroundDark: "#1e1e1e",
      highlightBackground: "#264f78",
      highlightGutterBackground: "#2b2b2b",
      codeFoldGutterBackground: "#333333",
      codeFoldBackground: "#2d2d2d",
      emptyLineBackground: "#1e1e1e",
      gutterColor: "#858585",
      addedGutterColor: "#7CCC7C", // More visible green
      removedGutterColor: "#FF7B7B", // More visible red
      codeFoldContentColor: "#cfcfcf",
      diffViewerTitleBackground: "#2d2d2d",
      diffViewerTitleColor: "#d4d4d4",
      diffViewerTitleBorderColor: "#444444"
    }
  }
}
