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

export interface Prompts {
  [key: string]: (code: string, language: string) => string
}

export interface ClientMessage {
  data?: string | boolean
  type?: string
  key?: string
  messages?: Messages[]
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
export interface Messages {
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

export type ThemeType = (typeof Theme)[keyof typeof Theme]
