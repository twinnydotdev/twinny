import { defaultTemplates } from '../extension/templates'

export const EXTENSION_NAME = '@ext:rjmacarthy.twinny'
export const ASSISTANT = 'assistant'
export const USER = 'user'
export const TWINNY = '🤖 twinny'
export const SYSTEM = 'system'
export const YOU = '👤 You'
export const EMPTY_MESAGE = 'Sorry, I don’t understand. Please try again.'
export const MODEL_ERROR = 'Sorry, something went wrong...'
export const OPENING_BRACKETS = ['[', '{', '(']
export const CLOSING_BRACKETS = [']', '}', ')']
export const OPENING_TAGS = ['<']
export const CLOSING_TAGS = ['</']
export const QUOTES = ['"', '\'', '`']
export const ALL_BRACKETS = [...OPENING_BRACKETS, ...CLOSING_BRACKETS] as const
export const BRACKET_REGEX = /^[()[\]{}]+$/
export const NORMALIZE_REGEX = /\s*\r?\n|\r/g
export const LINE_BREAK_REGEX = /\r?\n|\r|\n/g
export const QUOTES_REGEX = /["'`]/g
export const MAX_CONTEXT_LINE_COUNT = 200
export const SKIP_DECLARATION_SYMBOLS = ['=']
export const IMPORT_SEPARATOR = [',', '{']
export const SKIP_IMPORT_KEYWORDS_AFTER = ['from', 'as', 'import']
export const MIN_COMPLETION_CHUNKS = 2
export const MAX_EMPTY_COMPLETION_CHARS = 250
export const DEFAULT_RERANK_THRESHOLD = 0.5

export const defaultChunkOptions = {
  maxSize: 500,
  minSize: 50,
  overlap: 50
}

export const EVENT_NAME = {
  twinngAddMessage: 'twinny-add-message',
  twinnyAcceptSolution: 'twinny-accept-solution',
  twinnyChat: 'twinny-chat',
  twinnyChatMessage: 'twinny-chat-message',
  twinnyClickSuggestion: 'twinny-click-suggestion',
  twinnyConnectedToSymmetry: 'twinny-connected-to-symmetry',
  twinnyConnectSymmetry: 'twinny-connect-symmetry',
  twinnyDisconnectedFromSymmetry: 'twinny-disconnected-from-symmetry',
  twinnyDisconnectSymmetry: 'twinny-disconnect-symmetry',
  twinnyEmbedDocuments: 'twinny-embed-documents',
  twinnyEnableModelDownload: 'twinny-enable-model-download',
  twinnyFetchOllamaModels: 'twinny-fetch-ollama-models',
  twinnyGetConfigValue: 'twinny-get-config-value',
  twinnyGetGitChanges: 'twinny-get-git-changes',
  twinnyGlobalContext: 'twinny-global-context',
  twinnyHideBackButton: 'twinny-hide-back-button',
  twinnyListTemplates: 'twinny-list-templates',
  twinnyManageTemplates: 'twinny-manage-templates',
  twinnyNewDocument: 'twinny-new-document',
  twinnyNotification: 'twinny-notification',
  twinnyOnCompletion: 'twinny-on-completion',
  twinnyOnEnd: 'twinny-on-end',
  twinnyOnLoading: 'twinny-on-loading',
  twinnyOpenDiff: 'twinny-open-diff',
  twinnyRerankThresholdChanged: 'twinny-rerank-threshold-changed',
  twinnySendLanguage: 'twinny-send-language',
  twinnySendLoader: 'twinny-send-loader',
  twinnySendSystemMessage: 'twinny-send-system-message',
  twinnySendTheme: 'twinny-send-theme',
  twinnySessionContext: 'twinny-session-context',
  twinnySetConfigValue: 'twinny-set-config-value',
  twinnySetGlobalContext: 'twinny-set-global-context',
  twinnySetOllamaModel: 'twinny-set-ollama-model',
  twinnySetSessionContext: 'twinny-set-session-context',
  twinnySetTab: 'twinny-set-tab',
  twinnySetWorkspaceContext: 'twinny-set-workspace-context',
  twinnyStopGeneration: 'twinny-stop-generation',
  twinnyTextSelection: 'twinny-text-selection',
  twinnyWorkspaceContext: 'twinny-workspace-context',
  twinnyGithhubReview: 'twinny-githhub-review'
}

export const TWINNY_COMMAND_NAME = {
  addTests: 'twinny.addTests',
  addTypes: 'twinny.addTypes',
  conversationHistory: 'twinny.conversationHistory',
  disable: 'twinny.disable',
  enable: 'twinny.enable',
  explain: 'twinny.explain',
  focusSidebar: 'twinny.sidebar.focus',
  generateDocs: 'twinny.generateDocs',
  getGitCommitMessage: 'twinny.getGitCommitMessage',
  hideBackButton: 'twinny.hideBackButton',
  manageProviders: 'twinny.manageProviders',
  manageTemplates: 'twinny.manageTemplates',
  newConversation: 'twinny.newConversation',
  openChat: 'twinny.openChat',
  refactor: 'twinny.refactor',
  sendTerminalText: 'twinny.sendTerminalText',
  settings: 'twinny.settings',
  stopGeneration: 'twinny.stopGeneration',
  templateCompletion: 'twinny.templateCompletion',
  templates: 'twinny.templates',
  twinnySymmetryTab: 'twinny.symmetry'
}

export const CONVERSATION_EVENT_NAME = {
  clearAllConversations: 'twinny.clear-all-conversations',
  getActiveConversation: 'twinny.get-active-conversation',
  getConversations: 'twinny.get-conversations',
  removeConversation: 'twinny.remove-conversation',
  saveConversation: 'twinny.save-conversation',
  saveLastConversation: 'twinny.save-last-conversation',
  setActiveConversation: 'twinny.set-active-conversation'
}

export const PROVIDER_EVENT_NAME = {
  addProvider: 'twinny.add-provider',
  copyProvider: 'twinny.copy-provider',
  focusProviderTab: 'twinny.focus-provider-tab',
  getActiveChatProvider: 'twinny.get-active-provider',
  getActiveEmbeddingsProvider: 'twinny.get-active-embeddings-provider',
  getActiveFimProvider: 'twinny.get-active-fim-provider',
  getAllProviders: 'twinny.get-providers',
  removeProvider: 'twinny.remove-provider',
  resetProvidersToDefaults: 'twinny.reset-providers-to-defaults',
  setActiveChatProvider: 'twinny.set-active-chat-provider',
  setActiveEmbeddingsProvider: 'twinny.set-active-embeddings-provider',
  setActiveFimProvider: 'twinny.set-active-fim-provider',
  updateProvider: 'twinny.update-provider'
}

export const ACTIVE_CONVERSATION_STORAGE_KEY = 'twinny.active-conversation'
export const ACTIVE_CHAT_PROVIDER_STORAGE_KEY = 'twinny.active-chat-provider'
export const ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY =
  'twinny.active-embeddings-provider'
export const ACTIVE_FIM_PROVIDER_STORAGE_KEY = 'twinny.active-fim-provider'
export const CONVERSATION_STORAGE_KEY = 'twinny.conversations'
export const INFERENCE_PROVIDERS_STORAGE_KEY = 'twinny.inference-providers'

export const WORKSPACE_STORAGE_KEY = {
  autoScroll: 'autoScroll',
  chatMessage: 'chatMessage',
  downloadCancelled: 'downloadCancelled',
  selectedTemplates: 'selectedTemplates',
  selection: 'selection',
  showEmbeddingOptions: 'showEmbeddingOptions',
  showProviders: 'showProviders'
}

export const EXTENSION_SETTING_KEY = {
  apiProvider: 'apiProvider',
  apiProviderFim: 'apiProviderFim',
  chatModelName: 'chatModelName',
  fimModelName: 'fimModelName'
}

export const EXTENSION_CONTEXT_NAME = {
  twinnyConversationHistory: 'twinnyConversationHistory',
  twinnyGeneratingText: 'twinnyGeneratingText',
  twinnyManageProviders: 'twinnyManageProviders',
  twinnyManageTemplates: 'twinnyManageTemplates',
  twinnyRerankThreshold: 'twinnyRerankThreshold',
  twinnyMaxChunkSize: 'twinnyMaxChunkSize',
  twinnyMinChunkSize: 'twinnyMinChunkSize',
  twinnyOverlapSize: 'twinnyOverlapSize',
  twinnySymmetryTab: 'twinnySymmetryTab'
}

export const EXTENSION_SESSION_NAME = {
  twinnySymmetryConnection: 'twinnySymmetryConnection'
}

export const WEBUI_TABS = {
  chat: 'chat',
  history: 'history',
  providers: 'providers',
  settings: 'templates',
  symmetry: 'symmetry'
}

export const FIM_TEMPLATE_FORMAT = {
  automatic: 'automatic',
  codegemma: 'codegemma',
  codellama: 'codellama',
  codeqwen: 'codeqwen',
  custom: 'custom-template',
  deepseek: 'deepseek',
  llama: 'llama',
  stableCode: 'stable-code',
  starcoder: 'starcoder'
}

export const STOP_LLAMA = ['<EOT>']

export const STOP_DEEPSEEK = [
  '<｜fim▁begin｜>',
  '<｜fim▁hole｜>',
  '<｜fim▁end｜>',
  '<END>',
  '<｜end▁of▁sentence｜>'
]

export const STOP_STARCODER = ['<|endoftext|>', '<file_sep>']

export const STOP_CODEGEMMA = ['<|file_separator|>', '<|end_of_turn|>', '<eos>']

export const DEFAULT_TEMPLATE_NAMES = defaultTemplates.map(({ name }) => name)

export const DEFAULT_ACTION_TEMPLATES = [
  'refactor',
  'add-tests',
  'add-types',
  'explain'
]

export const DEFAULT_PROVIDER_FORM_VALUES = {
  apiHostname: '0.0.0.0',
  apiKey: '',
  apiPath: '',
  apiPort: 11434,
  apiProtocol: 'http',
  id: '',
  label: '',
  modelName: '',
  name: '',
  provider: 'ollama',
  type: 'chat'
}

export const TITLE_GENERATION_PROMPT_MESAGE = `
  Generate a title for this conversation in under 10 words.
  It should not contain any special characters or quotes.
`

export const WASM_LANGUAGES: { [key: string]: string } = {
  'php-s': 'php',
  bash: 'bash',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hxx: 'cpp',
  cs: 'c_sharp',
  c: 'c',
  cjs: 'javascript',
  css: 'css',
  cts: 'typescript',
  eex: 'embedded_template',
  el: 'elisp',
  elm: 'elm',
  emacs: 'elisp',
  erb: 'ruby',
  ex: 'elixir',
  exs: 'elixir',
  go: 'go',
  h: 'c',
  heex: 'embedded_template',
  htm: 'html',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'javascript',
  leex: 'embedded_template',
  lua: 'lua',
  mjs: 'javascript',
  ml: 'ocaml',
  mli: 'ocaml',
  mts: 'typescript',
  ocaml: 'ocaml',
  php: 'php',
  php3: 'php',
  php4: 'php',
  php5: 'php',
  php7: 'php',
  phps: 'php',
  phtml: 'php',
  py: 'python',
  pyi: 'python',
  pyw: 'python',
  ql: 'ql',
  rb: 'ruby',
  rdl: 'systemrdl',
  res: 'rescript',
  resi: 'rescript',
  rs: 'rust',
  sh: 'bash',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  vue: 'vue'
}

// TODO: We could have an extendable regex for this
export const EMBEDDING_IGNORE_LIST = [
  '__mocks__',
  '__tests__',
  '.babelrc.js',
  '.babelrc.json',
  '.babelrc',
  '.circleci',
  '.classpath',
  '.dockerignore',
  '.DS_Store',
  '.eclipse',
  '.editorconfig',
  '.env.development',
  '.env.production',
  '.env.test',
  '.env',
  '.eslintignore',
  '.eslintrc.js',
  '.eslintrc.json',
  '.eslintrc',
  '.git',
  '.gitattributes',
  '.gitignore',
  '.gitlab-ci.yml',
  '.hg',
  '.idea',
  '.log',
  '.md',
  '.model',
  '.prettierrc.js',
  '.prettierrc.json',
  '.prettierrc',
  '.project',
  '.settings',
  '.storybook',
  '.stylelintrc.js',
  '.stylelintrc.json',
  '.stylelintrc',
  '.svn',
  '.swp',
  '.spm',
  '.temp',
  '.tmp',
  '.travis.yml',
  '.vscode',
  'archive',
  'archives',
  'assets',
  'backup',
  'backups',
  'bin',
  'bower_components',
  'build.gradle',
  'build',
  'CHANGELOG.md',
  'composer.json',
  'composer.lock',
  'coverage',
  'css',
  'demo',
  'demos',
  'dist',
  'doc',
  'Doc',
  'Dockerfile',
  'docs',
  'Docs',
  'documentation',
  'example',
  'examples',
  'Gemfile.lock',
  'Gemfile',
  'jenkins',
  'json',
  'LICENSE',
  'Makefile',
  'node_modules',
  'onnx',
  'out',
  'package-lock.json',
  'package.json',
  'pom.xml',
  'private',
  'Procfile',
  'public',
  'README.md',
  'release',
  'reports',
  'Resources',
  'sample',
  'samples',
  'scripts',
  'storybook-static',
  'svg',
  'target',
  'temp',
  'test-results',
  'test',
  'Test',
  'tests',
  'Tests',
  'Thumbs.db',
  'tmp',
  'tools',
  'tsconfig.json',
  'util',
  'utils',
  'vagrantfile',
  'vsix',
  'webpack.config.js',
  'yarn.lock',
  'yml'
]

export const MULTILINE_OUTSIDE = [
  'class_body',
  'class',
  'export',
  'identifier',
  'interface_body',
  'interface',
  'program'
]

export const MULTILINE_INSIDE = [
  'body',
  'export_statement',
  'formal_parameters',
  'function_definition',
  'named_imports',
  'object_pattern',
  'object_type',
  'object',
  'parenthesized_expression',
  'statement_block'
]

export const MULTILINE_TYPES = [...MULTILINE_OUTSIDE, ...MULTILINE_INSIDE]

export const MULTI_LINE_DELIMITERS = ['\n\n', '\r\n\r\n']

export const RELEVANT_FILE_COUNT = 10 // todo make this configurable

export const RELEVANT_CODE_COUNT = 5 // todo make this configurable

export const SYMMETRY_DATA_MESSAGE = {
  disconnect: 'disconnect',
  heartbeat: 'heartbeat',
  inference: 'inference',
  inferenceEnd: 'inferenceEnd',
  join: 'join',
  leave: 'leave',
  newConversation: 'newConversation',
  ping: 'ping',
  pong: 'pong',
  providerDetails: 'providerDetails',
  reportCompletion: 'reportCompletion',
  requestProvider: 'requestProvider',
  sessionValid: 'sessionValid',
  verifySession: 'verifySession'
} as const

export const SYMMETRY_EMITTER_KEY = {
  conversationTitle: 'conversationTitle',
  inference: 'inference'
}
export const MULTI_LINE_REACT = [
  'jsx_closing_element',
  'jsx_element',
  'jsx_element',
  'jsx_opening_element',
  'jsx_self_closing_element'
]
