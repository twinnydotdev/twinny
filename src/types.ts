import { Position } from 'vscode'

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
  language: string
  languageId: string
}

export interface Prompts {
  [key: string]: (code: string, language: string) => string
}

export interface PostMessage {
  type: string
  value: {
    type: string
    completion: string
    error?: boolean
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data?: any
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

export type ThemeType = (typeof Theme)[keyof typeof Theme]
