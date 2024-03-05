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
export const NORMALIZE_REGEX = /\s*\r?\n|\r/g;
export const LINE_BREAK_REGEX = /\r?\n|\r|\n/g
export const COMPLETION_TIMEOUT = 20000 // 20 seconds
export const MAX_CONTEXT_LINE_COUNT = 200
export const SKIP_DECLARATION_SYMBOLS = ['=', ':']
export const IMPORT_SEPARATOR = [',', '{']
export const SKIP_IMPORT_KEYWORDS_AFTER = ['from', 'as', 'import']

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
  twinnyGetConfigValue: 'twinny-get-config-value',
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
  apiProvider: 'apiProvider',
}

export const CONTEXT_NAME = {
  twinnyGeneratingText: 'twinnyGeneratingText',
  twinnyManageTemplates: 'twinnyManageTemplates'
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
