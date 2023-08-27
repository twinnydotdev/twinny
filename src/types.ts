import { CreateCompletionRequest } from 'openai'

export type CompletionRequest = CreateCompletionRequest & {
  one_line: boolean | undefined
  top_k: number | undefined
  num_return_sequences: number | undefined
}
