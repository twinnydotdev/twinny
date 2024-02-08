import { Position } from 'vscode'
import { CodeLanguageDetails } from './languages'
import { allBrackets } from './constants'
import { RequestOptions } from 'https'
import { ClientRequest } from 'http'

export interface StreamOptions {
  prompt: string
  stream: boolean
  n_predict?: number
  temperature?: number
}

export interface StreamOptionsOllama extends StreamOptions {
  model: string
  options: Record<string, unknown>
}

export interface StreamOptionsMessages extends StreamOptions {
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
  language: string
}

export type ThemeType = (typeof Theme)[keyof typeof Theme]

export interface PromptTemplate {
  context: string
  header: string
  suffix: string
  prefix: string
  useFileContext: boolean
}

export interface ApiProviders {
  [key: string]: { fimApiPath: string; chatApiPath: string; port: number }
}

export type Bracket = (typeof allBrackets)[number]

export interface StreamResponseOptions {
  body: StreamOptions | StreamOptionsMessages
  options: RequestOptions
  onData: (
    streamResponse: StreamResponse | undefined,
    destroy: () => void
  ) => void
  onEnd?: (destroy: () => void) => void
  onStart?: (req: ClientRequest) => void
  onError?: (error: Error) => void
}

export const ProviderNames = {
  Ollama: 'ollama',
  LlamaCpp: 'llamacpp',
  LMStudio: 'lmstudio'
} as const
