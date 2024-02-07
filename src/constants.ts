import { defaultTemplates } from './templates'

export const EXTENSION_NAME = '@ext:rjmacarthy.twinny'
export const BOT_NAME = 'assistant'
export const USER_NAME = 'user'

export const EMPTY_MESAGE = 'Sorry, I don’t understand. Please try again.'
export const MODEL_ERROR = 'Sorry, something went wrong...'

export const OLLAMA_DOWNLOAD_URL = 'https://ollama.ai/download'

export const MESSAGE_NAME = {
  twinnyAcceptSolution: 'twinny-accept-solution',
  twinnyChat: 'twinny-chat',
  twinnyChatMessage: 'twinny-chat-message',
  twinnyOnCompletion: 'twinny-on-completion',
  twinnyOnEnd: 'twinny-on-end',
  twinnyOnLoading: 'twinny-on-loading',
  twinnyOpenDiff: 'twinny-open-diff',
  twinnyOpenSettings: 'twinny-open-settings',
  twinnySetWorkspaceContext: 'twinny-set-workspace-context',
  twinnyNotification: 'twinny-notification',
  twinnySetGlobalContext: 'twinny-set-global-context',
  twinnyStopGeneration: 'twinny-stop-generation',
  twinnyTextSelection: 'twinny-text-selection',
  twinnyWorkspaceContext: 'twinny-workspace-context',
  twinnyGlobalContext: 'twinny-global-context',
  twinnySendSystemMessage: 'twinny-send-system-message',
  twinnyClickSuggestion: 'twinny-click-suggestion',
  twinnyEnableModelDownload: 'twinny-enable-model-download',
  twinnySendLanguage: 'twinny-send-language',
  twinnySendTheme: 'twinny-send-theme',
  twinnyListTemplates: 'twinny-list-templates',
  twinnyManageTemplates: 'twinny-manage-templates',
  twinnySetTab: 'twinny-set-tab'
}

export const MESSAGE_KEY = {
  lastConversation: 'lastConversation',
  downloadCancelled: 'downloadCancelled',
  selection: 'selection',
  chatMessage: 'chatMessage',
  autoScroll: 'autoScroll',
  selectedTemplates: 'selectedTemplates'
}

export const CONTEXT_NAME = {
  twinnyGeneratingText: 'twinnyGeneratingText',
  twinnyManageTemplates: 'twinnyManageTemplates'
}

export const TABS = {
  chat: 'chat',
  templates: 'templates'
}

export const fimTempateFormats = {
  deepseek: 'deepseek',
  codellama: 'codellama',
  stableCode: 'stable-code'
}

export const openingBrackets = ['[', '{', '(']
export const closingBrackets = [']', '}', ')']

export const openingTags = ['<']
export const closingTags = ['</']
export const quotes = ['"', '\'']

export const allBrackets = [...openingBrackets, ...closingBrackets] as const

export const BRACKET_REGEX = /^[()[\]{}]+$/
export const NORMALIZE_REGEX = /\r?\n|\r/g
export const LINE_BREAK_REGEX = /\r?\n$/

export const ALL_TEMPLATES = defaultTemplates.map(({ name }) => name)

export const CODE_ACTION_TYPES = [
  'add-types',
  'refactor',
  'generate-docs',
  'fix-code'
]

export const DEFAULT_TEMPLATES = [
  'refactor',
  'add-tests',
  'add-types',
  'explain'
]
