import { defaultTemplates } from '../extension/templates'
import { ApiProviders } from './types'

export const EXTENSION_NAME = '@ext:rjmacarthy.twinny'
export const BOT_NAME = 'assistant'
export const USER_NAME = 'user'
export const TWINNY = '🤖 twinny'
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
export const MAX_CONTEXT_LINE_COUNT = 200
export const SKIP_DECLARATION_SYMBOLS = ['=', ':']
export const IMPORT_SEPARATOR = [',', '{']
export const SKIP_IMPORT_KEYWORDS_AFTER = ['from', 'as', 'import']
export const SKIP_TOKEN = '#####skip#####'

export const MESSAGE_NAME = {
  twinnyAcceptSolution: 'twinny-accept-solution',
  twinnyChat: 'twinny-chat',
  twinnyChatMessage: 'twinny-chat-message',
  twinnyClickSuggestion: 'twinny-click-suggestion',
  twinnyEnableModelDownload: 'twinny-enable-model-download',
  twinnyGlobalContext: 'twinny-global-context',
  twinnyListTemplates: 'twinny-list-templates',
  twinnyManageTemplates: 'twinny-manage-templates',
  twinnyNewDocument: 'twinny-new-document',
  twinnyNotification: 'twinny-notification',
  twinnyOnCompletion: 'twinny-on-completion',
  twinngAddMessage: 'twinny-add-message',
  twinnyOnEnd: 'twinny-on-end',
  twinnyOnLoading: 'twinny-on-loading',
  twinnyOpenDiff: 'twinny-open-diff',
  twinnyOpenSettings: 'twinny-open-settings',
  twinnySendLanguage: 'twinny-send-language',
  twinnySendSystemMessage: 'twinny-send-system-message',
  twinnySendTheme: 'twinny-send-theme',
  twinnySetGlobalContext: 'twinny-set-global-context',
  twinnySetTab: 'twinny-set-tab',
  twinnySetWorkspaceContext: 'twinny-set-workspace-context',
  twinnyStopGeneration: 'twinny-stop-generation',
  twinnyTextSelection: 'twinny-text-selection',
  twinnyWorkspaceContext: 'twinny-workspace-context',
  twinnyFetchOllamaModels: 'twinny-fetch-ollama-models',
  twinnySetOllamaModel: 'twinny-set-ollama-model',
  twinnySetConfigValue: 'twinny-set-config-value',
  twinnyGetConfigValue: 'twinny-get-config-value'
}

export const MESSAGE_KEY = {
  autoScroll: 'autoScroll',
  chatMessage: 'chatMessage',
  downloadCancelled: 'downloadCancelled',
  lastConversation: 'lastConversation',
  selectedTemplates: 'selectedTemplates',
  selection: 'selection'
}

export const SETTING_KEY = {
  fimModelName: 'fimModelName',
  chatModelName: 'chatModelName',
  apiProvider: 'apiProvider'
}

export const CONTEXT_NAME = {
  twinnyGeneratingText: 'twinnyGeneratingText',
  twinnyManageTemplates: 'twinnyManageTemplates',
  lastEditorState: 'lastEditorState'
}

export const UI_TABS = {
  chat: 'chat',
  templates: 'templates'
}

export const FIM_TEMPLATE_FORMAT = {
  automatic: 'automatic',
  codellama: 'codellama',
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

export const STOP_STABLECODE = ['<|endoftext|>']

export const API_PROVIDER: ApiProviders = {
  ollama: {
    fimApiPath: '/api/generate',
    chatApiPath: '/v1/chat/completions',
    port: 11434
  },
  ollamawebui: {
    fimApiPath: '/ollama/api/generate',
    chatApiPath: '/ollama/v1/chat/completions',
    port: 8080
  },
  llamacpp: {
    fimApiPath: '/completion',
    chatApiPath: '/completion',
    port: 8080
  },
  lmstudio: {
    fimApiPath: '/v1/completions',
    chatApiPath: '/v1/chat/completions',
    port: 1234
  },
  oobabooga: {
    fimApiPath: '/v1/completions',
    chatApiPath: '/v1/chat/completions',
    port: 5000
  }
}

export const PROVIDER_NAMES = Object.keys(API_PROVIDER)

export const DEFAULT_TEMPLATE_NAMES = defaultTemplates.map(({ name }) => name)

export const DEFAULT_ACTION_TEMPLATES = [
  'refactor',
  'add-tests',
  'add-types',
  'explain'
]

export const WASM_LANGAUAGES: { [key: string]: string } = {
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hxx: 'cpp',
  cs: 'c_sharp',
  c: 'c',
  h: 'c',
  css: 'css',
  php: 'php',
  phtml: 'php',
  php3: 'php',
  php4: 'php',
  php5: 'php',
  php7: 'php',
  phps: 'php',
  'php-s': 'php',
  bash: 'bash',
  sh: 'bash',
  json: 'json',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  vue: 'vue',
  yaml: 'yaml',
  yml: 'yaml',
  elm: 'elm',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyw: 'python',
  pyi: 'python',
  el: 'elisp',
  emacs: 'elisp',
  ex: 'elixir',
  exs: 'elixir',
  go: 'go',
  eex: 'embedded_template',
  heex: 'embedded_template',
  leex: 'embedded_template',
  html: 'html',
  htm: 'html',
  java: 'java',
  lua: 'lua',
  ocaml: 'ocaml',
  ml: 'ocaml',
  mli: 'ocaml',
  ql: 'ql',
  res: 'rescript',
  resi: 'rescript',
  rb: 'ruby',
  erb: 'ruby',
  rs: 'rust',
  rdl: 'systemrdl',
  toml: 'toml'
}

export const PARSEABLE_NODES = [
  'export_statement',
  'import_statement',
  'function_declaration',
  'class_declaration',
  'variable_declaration',
  'import_declaration',
  'export_declaration',
  'export_named_declaration',
  'export_default_declaration',
  'lexical_declaration',
  'if_statement',
  'for_statement',
  'for_in_statement',
  'for_of_statement',
  'while_statement',
  'do_while_statement',
  'switch_statement',
  'try_statement',
  'catch_clause',
  'finally_clause',
  'return_statement',
  'break_statement',
  'continue_statement',
  'throw_statement',
  'array_expression',
  'object_expression',
  'arrow_function',
  'function_expression',
  'call_expression',
  'new_expression',
  'assignment_expression',
  'binary_expression',
  'template_string',
  'conditional_expression',
  'yield_expression',
  'type_alias_declaration',
  'interface_declaration',
  'enum_declaration',
  'module_declaration',
  'namespace_declaration',
  'type_assertion_expression',
  'type_annotation',
  'decorator',
  'block_statement',
  'expression_statement',
  'empty_statement',
  'spread_element',
  'rest_element',
  'template_literal',
  'tagged_template_expression',
  'await_expression',
  'async_function_declaration',
  'async_arrow_function',
  'jsx_element',
  'jsx_fragment',
  'import_specifier',
  'import_namespace_specifier',
  'import_expression',
  'shorthand_property_identifier_pattern',
  'computed_property_name',
  'export_clause',
  'import_clause',
  'default_parameter',
  'parenthesized_expression',
  'sequence_expression',
  'binary_pattern',
  'destructuring_pattern',
  'object_pattern',
  'object',
  'array',
  'array_pattern',
  'assignment_pattern',
  'optional_parameter',
  'property_identifier',
  'member_expression',
  'literal_pattern'
]
