import { Position } from 'vscode'
import { CodeLanguageDetails } from './languages'
import { ALL_BRACKETS } from '../constants'

export interface StreamBodyBase {
  prompt: string
  stream: boolean
  n_predict?: number
  temperature?: number
}

export interface StreamOptionsOllama extends StreamBodyBase {
  model: string
  keep_alive?: number
  options: Record<string, unknown>
}

export interface StreamBodyOpenAI extends StreamBodyBase {
  messages?: MessageType[] | MessageRoleContent
  max_tokens: number
}

export interface InlineCompletion {
  completion: string
  position: Position
  prefix: string
  suffix: string
  stop: string[]
}

export interface StreamResponse {
  model: string
  created_at: string
  response: string
  content: string
  done: boolean
  context: number[]
  total_duration: number
  load_duration: number
  prompt_eval_count: number
  prompt_eval_duration: number
  eval_count: number
  eval_duration: number
  choices: [
    {
      text: string
      delta: {
        content: string
      }
    }
  ]
}

export interface LanguageType {
  language: CodeLanguageDetails
  languageId: string | undefined
}

export interface ClientMessage<T = string | boolean | MessageType[]> {
  data?: T
  type?: string
  key?: string
}

export interface ServerMessage<T = LanguageType> {
  type: string
  value: {
    completion: string
    data?: T
    error?: boolean
    errorMessage?: string
    type: string
  }
}
export interface MessageType {
  role: string
  content: string | undefined
  type?: string
  language?: LanguageType
  error?: boolean
}

export type MessageRoleContent = Pick<MessageType, 'role' | 'content'>

export const Theme = {
  Light: 'Light',
  Dark: 'Dark',
  Contrast: 'Contrast'
} as const

export interface DefaultTemplate {
  systemMessage?: string
}

export interface TemplateData extends Record<string, string | undefined> {
  systemMessage?: string
  code: string
  language: string
}

export interface ChatTemplateData {
  systemMessage?: string
  role: string
  messages: MessageType[]
  code: string
  language?: string
}

export type ThemeType = (typeof Theme)[keyof typeof Theme]

export interface FimPromptTemplate {
  context: string
  header: string
  suffix: string
  prefix: string
  useFileContext: boolean
}

export interface ApiProviders {
  [key: string]: { fimApiPath: string; chatApiPath: string; port: number }
}

export type Bracket = (typeof ALL_BRACKETS)[number]

export interface StreamRequestOptions {
  hostname: string
  path: string
  port: string | number
  protocol: string
  method: string
  headers: Record<string, string>
}

export interface StreamRequest {
  body: StreamBodyBase | StreamBodyOpenAI
  options: StreamRequestOptions
  onEnd?: () => void
  onStart?: (controller: AbortController) => void
  onError?: (error: Error) => void
  onData: (streamResponse: StreamResponse | undefined) => void
}

export interface UiTabs {
  [key: string]: JSX.Element
}

export const ApiProviders = {
  Ollama: 'ollama',
  OllamaWebUi: 'ollamawebui',
  LlamaCpp: 'llamacpp',
  LMStudio: 'lmstudio',
  Oobabooga: 'oobabooga'
} as const

export interface OllamaModel {
  parent_model: string
  format: string
  family: string
  parameter_size: string
  digest: string
  model: string
  modified_at: string
  name: string
  size: number
}

export interface OllamaModels {
  models: OllamaModel[]
}
