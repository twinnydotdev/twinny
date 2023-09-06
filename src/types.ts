import { CreateCompletionRequest } from 'openai'

export type CompletionRequest = CreateCompletionRequest & {
  max_time: number | undefined
  one_line: boolean | undefined
  top_k: number | undefined
  repetition_penalty: number | undefined
  num_return_sequences: number | undefined
}
