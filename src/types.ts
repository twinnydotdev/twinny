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

export interface OllamStreamResponse {
  model: string;
  created_at: string;
  response: string;
  done: boolean;
  context: number[];
  total_duration: number;
  load_duration: number;
  prompt_eval_count: number;
  prompt_eval_duration: number;
  eval_count: number;
  eval_duration: number;
}


export interface Prompts {
  [key: string]: (code: string, modelType: string) => string
}

