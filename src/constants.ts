import { defaultTemplates } from './extension/templates'
import { ApiProviders } from './extension/types'

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
export const LINE_BREAK_REGEX = /\r?\n$/
export const COMPLETION_TIMEOUT = 20000 // 20 seconds

export const MESSAGE_NAME = {
  twinngAddMessage: 'twinny-add-message',
  twinnyAcceptSolution: 'twinny-accept-solution',
  twinnyAdditionalOptions: 'twinny-additional-options',
  twinnyChat: 'twinny-chat',
  twinnyChatMessage: 'twinny-chat-message',
  twinnyClickSuggestion: 'twinny-click-suggestion',
  twinnyEmbedDocuments: 'twinny-embed-documents',
  twinnyEnableModelDownload: 'twinny-enable-model-download',
  twinnyFetchOllamaModels: 'twinny-fetch-ollama-models',
  twinnyGetConfigValue: 'twinnyGetConfigValue',
  twinnyGlobalContext: 'twinny-global-context',
  twinnyListTemplates: 'twinny-list-templates',
  twinnyNewDocument: 'twinny-new-document',
  twinnyNotification: 'twinny-notification',
  twinnyOnCompletion: 'twinny-on-completion',
  twinnyOnEnd: 'twinny-on-end',
  twinnyOnLoading: 'twinny-on-loading',
  twinnyOpenDiff: 'twinny-open-diff',
  twinnyOpenSettings: 'twinny-open-settings',
  twinnySendLanguage: 'twinny-send-language',
  twinnySendSystemMessage: 'twinny-send-system-message',
  twinnySendTheme: 'twinny-send-theme',
  twinnySetConfigValue: 'twinny-set-config-value',
  twinnySetGlobalContext: 'twinny-set-global-context',
  twinnySetOllamaModel: 'twinny-set-ollama-model',
  twinnySetTab: 'twinny-set-tab',
  twinnySetWorkspaceContext: 'twinny-set-workspace-context',
  twinnyStopGeneration: 'twinny-stop-generation',
  twinnyTextSelection: 'twinny-text-selection',
  twinnyWorkspaceContext: 'twinny-workspace-context',
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
  twinnyAdditionalOptions: 'twinnyAdditionalOptions'
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
  stableCode: 'stable-code'
}

export const API_PROVIDER: ApiProviders = {
  ollama: {
    fimApiPath: '/api/generate',
    chatApiPath: '/api/generate',
    embeddingsPath: '/api/embeddings',
    port: 11434
  },
  ollamawebui: {
    fimApiPath: '/ollama/api/generate',
    chatApiPath: '/ollama/api/generate',
    embeddingsPath: '/ollama/api/embeddings',
    port: 8080
  },
  llamacpp: {
    fimApiPath: '/completion',
    chatApiPath: '/completion',
    embeddingsPath: '/v1/embeddings',
    port: 8080
  },
  lmstudio: {
    fimApiPath: '/v1/completions',
    chatApiPath: '/v1/chat/completions',
    embeddingsPath: '/v1/embeddings',
    port: 1234
  },
  oobabooga: {
    fimApiPath: '/v1/completions',
    chatApiPath: '/v1/chat/completions',
    embeddingsPath: '/v1/embeddings',
    port: 5000
  }
}

export const PROVIDER_NAMES = Object.keys(API_PROVIDER)

export const DEFAULT_TEMPLATE_NAMES = defaultTemplates.map(({ name }) => name)

export const DEFAULT_ACTION_TEMPLATES = [
  'refactor',
  'add-tests',
  'add-types',
  'explain',
  'rerank'
]

export const EMBEDDING_IGNORE_LIST = [
  '.git',
  '.svn',
  '.hg',
  '.md',
  'node_modules',
  'bower_components',
  'dist',
  'build',
  'out',
  'release',
  'bin',
  'temp',
  'tmp',
  '.eslintignore',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.json',
  '.babelrc',
  '.babelrc.js',
  '.babelrc.json',
  '.stylelintrc',
  '.stylelintrc.js',
  '.stylelintrc.json',
  '.prettierrc',
  '.prettierrc.js',
  '.prettierrc.json',
  'webpack.config.js',
  'tsconfig.json',
  'package-lock.json',
  'package.json',
  'yarn.lock',
  'composer.json',
  'composer.lock',
  '.editorconfig',
  '.travis.yml',
  '.gitignore',
  '.gitattributes',
  '.gitlab-ci.yml',
  '.dockerignore',
  'vagrantfile',
  'Dockerfile',
  'Makefile',
  'Procfile',
  'build.gradle',
  'pom.xml',
  'Gemfile',
  'Gemfile.lock',
  '.env',
  '.env.development',
  '.env.test',
  '.env.production',
  '.log',
  '.tmp',
  '.temp',
  '.swp',
  '.idea',
  '.vscode',
  '.eclipse',
  '.classpath',
  '.project',
  '.settings',
  '.DS_Store',
  'Thumbs.db',
  '__tests__',
  '__mocks__',
  'test',
  'tests',
  'Test',
  'Tests',
  'doc',
  'docs',
  'Doc',
  'Docs',
  'documentation',
  'LICENSE',
  'README.md',
  'CHANGELOG.md',
  'scripts',
  'tools',
  'util',
  'utils',
  'Resources',
  'assets',
  '.storybook',
  'storybook-static',
  'reports',
  'coverage',
  '.circleci',
  'jenkins',
  'public',
  'private',
  'sample',
  'samples',
  'demo',
  'demos',
  'example',
  'examples',
  'archive',
  'archives',
  'backup',
  'backups'
]
