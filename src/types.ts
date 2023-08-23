import { CreateCompletionRequest } from 'openai'

export type CompletionRequest = CreateCompletionRequest & {
  one_line: boolean | undefined
}
