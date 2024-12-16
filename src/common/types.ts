import type { JSONSchema7 } from "json-schema"
import { serverMessageKeys } from "symmetry-core"
import { InlineCompletionItem, InlineCompletionList, Uri } from "vscode"

import { ALL_BRACKETS } from "./constants"
import { CodeLanguageDetails } from "./languages"

export interface RequestBodyBase {
  stream: boolean
  n_predict?: number
  temperature?: number
}

export interface RequestOptionsOllama extends RequestBodyBase {
  model: string
  keep_alive?: string | number
  messages?: Message[] | Message
  prompt?: string
  input?: string
  options: Record<string, unknown>
}

export interface StreamBodyOpenAI extends RequestBodyBase {
  messages?: Message[] | Message
  max_tokens: number
  tools?: FunctionTool[]
}

export interface PrefixSuffix {
  prefix: string
  suffix: string
}

export interface RepositoryLevelData {
  uri: Uri
  text: string
  name: string
  isOpen: boolean
  relevanceScore: number
}

type ToolCall = {
  function: {
    name: string
    arguments: Record<string, unknown>
  }
}

export interface StreamResponse {
  model: string
  created_at: string
  response: string
  content: string
  message: {
    content: string
    role: "assistant"
    tool_calls?: ToolCall[]
  }
  done: boolean
  context: number[]
  total_duration: number
  load_duration: number
  prompt_eval_count: number
  prompt_eval_duration: number
  eval_count: number
  eval_duration: number
  type?: string
  tool_calls?: ToolCall[]
  system_fingerprint: string
  choices: [
    {
      text: string
      delta: {
        content: string
      }
      index: number
      message: {
        role: "assistant"
        content: string
        tool_calls?: Array<{
          id: string
          type: "function"
          function: {
            name: string
            arguments: string
          }
        }>
      }
      finish_reason: "stop" | "tool_calls"
    }
  ]
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export interface LanguageType {
  language: CodeLanguageDetails
  languageId: string | undefined
}

export interface ClientMessage<T = string | boolean | Message[], Y = unknown> {
  data?: T
  meta?: Y
  type?: string
  key?: string
}

export type ClientMessageWithData = ClientMessage<string | boolean> &
  ClientMessage<Message[]> &
  ClientMessage<GithubPullRequestMessage>

export interface ServerMessage<T = unknown> {
  type: string
  data: T
}

export interface Message {
  role: string
  content: string | undefined
  tools?: Record<string, Tool>
  id?: string
}

export interface GithubPullRequestMessage {
  owner: string
  repo: string
  number: number
}

export interface Conversation {
  id?: string
  title?: string
  messages: Message[]
}

export const Theme = {
  Light: "Light",
  Dark: "Dark",
  Contrast: "Contrast"
} as const

export interface DefaultTemplate {
  systemMessage?: string
}

export interface TemplateData extends Record<string, string | undefined> {
  code: string
  systemMessage?: string
  language?: string
}

export interface FimTemplateData extends Record<string, string | undefined> {
  context: string
  fileName: string
  prefix: string
  suffix: string
  systemMessage: string
}

export interface ChatTemplateData {
  systemMessage?: string
  role: string
  messages: Message[]
  code: string
  language?: string
}

export type ThemeType = (typeof Theme)[keyof typeof Theme]

export interface FimPromptTemplate {
  context: string
  header: string
  prefixSuffix: PrefixSuffix
  fileContextEnabled: boolean
  language?: string
}

export interface ApiProviders {
  [key: string]: { fimApiPath: string; chatApiPath: string; port: number }
}

export type Bracket = (typeof ALL_BRACKETS)[number]

export interface StreamRequestOptions {
  hostname: string
  path: string
  port?: string | number
  protocol: string
  method: string
  headers: Record<string, string>
}

export interface StreamRequest {
  body: RequestBodyBase | StreamBodyOpenAI
  options: StreamRequestOptions
  onEnd?: (response?: StreamResponse) => void
  onStart?: (controller: AbortController) => void
  onError?: (error: Error) => void
  onData: (streamResponse: StreamResponse) => void
}

export interface UiTabs {
  [key: string]: JSX.Element
}

export const apiProviders = {
  LiteLLM: "litellm",
  LlamaCpp: "llamacpp",
  LMStudio: "lmstudio",
  Ollama: "ollama",
  Oobabooga: "oobabooga",
  OpenWebUI: "openwebui"
} as const

export interface ApiModel {
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

export interface ApiModels {
  models: ApiModel[]
}

export type ResolvedInlineCompletion =
  | InlineCompletionItem[]
  | InlineCompletionList
  | PromiseLike<
      InlineCompletionItem[] | InlineCompletionList | null | undefined
    >
  | null
  | undefined

export interface InteractionItem {
  keyStrokes: number | null | undefined
  lastVisited: number
  name: string | null | undefined
  sessionLength: number
  visits: number | null | undefined
  isOpen: boolean
  relevanceScore?: number | null | undefined
  activeLines: {
    line: number
    character: number
  }[]
}

export interface InferenceProvider {
  apiBaseUrl?: string
  apiHostname?: string
  apiKey?: string
  apiPath?: string
  apiPort?: number
  apiProtocol?: string
  modelName?: string
  name: string
  type: (typeof apiProviders)[keyof typeof apiProviders]
}

export interface Peer {
  publicKey: Buffer
  write: (value: string) => boolean
  on: (key: string, cb: (data: Buffer) => void) => void
  once: (key: string, cb: (data: Buffer) => void) => void
  writable: boolean
  key: string
  discovery_key: string
}

export interface SymmetryMessage<T> {
  key: string
  data: T
}

export type ServerMessageKey = keyof typeof serverMessageKeys

export interface SymmetryConnection {
  sessionToken?: string
  discoveryKey?: string
  modelName?: string
  name: string
  provider: string
  id: string
}

export interface SymmetryModelProvider {
  connections: number | null
  data_collection_enabled: number
  id: number
  last_seen: string
  max_connections: number
  model_name: string
  name: string
  online: number
  provider: string
  public: number
}

export interface InferenceRequest {
  key: string
  messages: Message[]
}

export interface ChunkOptions {
  minSize: number
  maxSize: number
  overlap: number
}

export type Embedding = {
  embeddings: [number[]]
}

export type EmbeddedDocument = {
  content: string
  vector: number[] | undefined
  file: string
}

export interface FileItem {
  name: string
  path: string
}

export interface MentionType {
  name: string
  path: string
}

export interface GitHubPr {
  number: number
  title: string
  html_url: string
}

export interface LMSEmbeddingItem {
  object: string
  embedding: number[]
  index: number
}

export interface LMSEmbeddingUsage {
  prompt_tokens: number
  total_tokens: number
}

export interface LMStudioEmbedding {
  object: string
  data: LMSEmbeddingItem[]
  model: string
  usage: LMSEmbeddingUsage
}

export type FunctionTool = {
  type: "function"
  function: {
    name: string
    description: string
    parameters: JSONSchema7
  }
}

export interface Tool {
  id: string
  name: string
  arguments: Record<string, unknown>
  status?: string
  error?: string
}
