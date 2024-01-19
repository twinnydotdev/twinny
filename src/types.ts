import { Position } from 'vscode'

export interface StreamBody {
  model: string
  prompt: string
  options: Record<string, unknown>
}

export interface InlineCompletion {
  completion: string
  position: Position
  prefix: string
  suffix: string
}
