import { Position } from 'vscode'
import { CodeLanguageDetails } from './languages'

export interface StreamOptions {
  model: string
  prompt: string
  stream: true
  n_predict?: number
  temperature?: number
  // Ollama
  options: Record<string, unknown>
}

export interface InlineCompletion {
  completion: string
  position: Position
  prefix: string
  suffix: string
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
}

export interface LanguageType {
  language: CodeLanguageDetails
  languageId: string | undefined
}

export interface ClientMessage {
  data?: string | boolean
  type?: string
  key?: string
  messages?: MessageType[]
}

export interface ServerMessage<T = LanguageType> {
  type: string
  value: {
    type: string
    completion: string
    error?: boolean
    data?: T
  }
}
export interface MessageType {
  role: string
  content: string
  type?: string
  language?: LanguageType
}

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
