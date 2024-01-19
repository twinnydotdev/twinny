import { addTests, addTypes, explain, generateDocs, refactor } from './prompts'
import { Prompts } from './types'

export const EXTENSION_NAME = '@ext:rjmacarthy.twinny'
export const BOT_NAME = 'twinny'
export const USER_NAME = 'user'

export const MODEL = {
  llama: 'llama',
  deepseek: 'deepseek'
}

export const EMPTY_MESAGE = 'Sorry, I don’t understand. Please try again.'

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
  twinnyStopGeneration: 'twinny-stop-generation',
  twinnyTextSelection: 'twinny-text-selection',
  twinnyWorkspaceContext: 'twinny-workspace-context',
  twinnySendSystemMessage: 'twinny-send-system-message'
}

export const MESSAGE_KEY = {
  lastConversation: 'lastConversation',
  selection: 'selection',
  chatMessage: 'chatMessage'
}

export const codeActionTypes = ['add-types', 'refactor']

export const prompts: Prompts = {
  explain: explain,
  'add-types': addTypes,
  refactor: refactor,
  'add-tests': addTests,
  'generate-docs': generateDocs
}
