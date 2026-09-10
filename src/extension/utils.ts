import fs from "fs"
import ignore from "ignore"
import path from "path"
import * as vscode from "vscode"
import {
  ColorThemeKind,
  ExtensionContext,
  Position,
  Range,
  Terminal,
  TextDocument,
  window,
  workspace
} from "vscode"
import { SyntaxNode } from "web-tree-sitter"

import {
  API_PROVIDERS,
  defaultChunkOptions,
  EVENT_NAME,
  EXTENSION_CONTEXT_NAME,
  FIM_MAX_PREFIX_CHARS,
  FIM_MAX_SUFFIX_CHARS,
  knownErrorMessages,
  NORMALIZE_REGEX,
  OPEN_AI_COMPATIBLE_PROVIDERS,
  TWINNY
} from "../common/constants"
import { supportedLanguages } from "../common/languages"
import { logger } from "../common/logger"
import {
  ChatCompletionMessage,
  ChunkOptions,
  LanguageType,
  PrefixSuffix,
  StreamResponse,
  Theme
} from "../common/types"

import { getParser } from "./completion/parser"
import { isIndexablePath } from "./embeddings/indexable"
import { ExtensionBridge } from "./messaging/bridge"
import { TwinnyProvider } from "./providers/manager"

export const delayExecution = <T extends () => void>(
  fn: T,
  delay = 2000
): NodeJS.Timeout => {
  return setTimeout(() => {
    fn()
  }, delay)
}

export const getTextSelection = () => {
  const editor = window.activeTextEditor
  const selection = editor?.selection
  const text = editor?.document.getText(selection)
  return text || ""
}

export const getLanguage = (): LanguageType => {
  const editor = window.activeTextEditor
  const languageId = editor?.document.languageId
  const language =
    supportedLanguages[languageId as keyof typeof supportedLanguages]
  return {
    language,
    languageId
  }
}

/** True when the cursor sits between two word characters, e.g. `fo|o`. */
export const getIsMiddleOfWord = (
  document: TextDocument,
  position: Position
): boolean => {
  const lineText = document.lineAt(position.line).text
  const charBefore = lineText.charAt(position.character - 1)
  const charAfter = lineText.charAt(position.character)
  return /\w/.test(charBefore) && /\w/.test(charAfter)
}

export const getPrefixSuffix = (
  numLines: number,
  document: TextDocument,
  position: Position,
  contextRatio = [0.85, 0.15]
): PrefixSuffix => {
  const currentLine = position.line
  const numLinesToEnd = document.lineCount - currentLine
  let numLinesPrefix = Math.floor(Math.abs(numLines * contextRatio[0]))
  let numLinesSuffix = Math.ceil(Math.abs(numLines * contextRatio[1]))

  if (numLinesPrefix > currentLine) {
    numLinesSuffix += numLinesPrefix - currentLine
    numLinesPrefix = currentLine
  }

  if (numLinesSuffix > numLinesToEnd) {
    numLinesPrefix += numLinesSuffix - numLinesToEnd
    numLinesSuffix = numLinesToEnd
  }

  const prefixRange = new Range(
    Math.max(0, currentLine - numLinesPrefix),
    0,
    currentLine,
    position.character
  )
  const suffixRange = new Range(
    currentLine,
    position.character,
    currentLine + numLinesSuffix,
    0
  )

  return {
    prefix: trimToLineBoundary(document.getText(prefixRange), FIM_MAX_PREFIX_CHARS, "start"),
    suffix: trimToLineBoundary(document.getText(suffixRange), FIM_MAX_SUFFIX_CHARS, "end")
  }
}

/**
 * Line counts alone don't bound the prompt: a hundred lines of minified or
 * generated code can exceed a small model's context. Cut at a line boundary
 * so the model never sees half a line.
 */
export const trimToLineBoundary = (
  text: string,
  maxChars: number,
  side: "start" | "end"
): string => {
  if (text.length <= maxChars) return text
  if (side === "start") {
    const cut = text.length - maxChars
    const newline = text.indexOf("\n", cut)
    return newline === -1 ? text.slice(cut) : text.slice(newline + 1)
  }
  const newline = text.lastIndexOf("\n", maxChars - 1)
  return newline === -1 ? text.slice(0, maxChars) : text.slice(0, newline + 1)
}

const BLOCK_OPENERS = ["{", "(", "[", ":", "=>", "=", ","]

/**
 * Decides whether to let a completion run over several lines. Multiline is
 * used on a blank line (the model is filling in a block), or after a token
 * that opens one; otherwise, and inside strings or comments, the completion
 * is kept to the rest of the current line.
 */
export const getShouldUseMultiline = ({
  document,
  position,
  node,
  multilineEnabled
}: {
  document: TextDocument
  position: Position
  node: SyntaxNode | null
  multilineEnabled: boolean
}): boolean => {
  if (!multilineEnabled) return false

  const lineText = document.lineAt(position.line).text
  const before = lineText.slice(0, position.character).trimEnd()
  const after = lineText.slice(position.character).trim()

  if (after.length > 0) return false

  const nodeType = node?.type || ""
  if (
    nodeType.includes("string") ||
    nodeType.includes("comment") ||
    nodeType.includes("template")
  ) {
    return false
  }

  if (before.trim().length === 0) return true

  return BLOCK_OPENERS.some((opener) => before.endsWith(opener))
}

export const getTheme = () => {
  const currentTheme = window.activeColorTheme
  if (currentTheme.kind === ColorThemeKind.Light) {
    return Theme.Light
  } else if (currentTheme.kind === ColorThemeKind.Dark) {
    return Theme.Dark
  } else {
    return Theme.Contrast
  }
}

export const getResponseData = (data: StreamResponse) => {
  return {
    type: "content" as const,
    content:
      data?.choices?.[0]?.delta?.content ||
      data.choices[0].message?.content ||
      ""
  }
}

export const getIsOpenAICompatible = (provider: TwinnyProvider) => {
  const providers = Object.values(OPEN_AI_COMPATIBLE_PROVIDERS) as string[]
  return providers.includes(provider.provider)
}

/**
 * Pulls the streamed text out of a chunk. Providers are checked for their
 * native shape first, then every known shape is tried so a misconfigured
 * provider type still works as long as the server speaks a common dialect.
 */
export const getFimDataFromProvider = (
  provider: string,
  data: StreamResponse | undefined
): string | undefined => {
  if (!data) return undefined

  switch (provider) {
    case API_PROVIDERS.OpenAICompatible:
    case API_PROVIDERS.Ollama:
    case API_PROVIDERS.OpenWebUI:
    case API_PROVIDERS.TwinnyP2P:
      if (typeof data.response === "string") return data.response
      break
    case API_PROVIDERS.LlamaCpp:
      if (typeof data.content === "string") return data.content
      break
  }

  const choice = data.choices?.[0]
  if (typeof choice?.text === "string") return choice.text
  if (typeof choice?.delta?.content === "string") return choice.delta.content
  if (typeof choice?.message?.content === "string") return choice.message.content
  if (typeof data.response === "string") return data.response
  if (typeof data.content === "string") return data.content
  return undefined
}

export function isStreamWithDataPrefix(stringBuffer: string) {
  return stringBuffer.startsWith("data:")
}

export function safeParseJsonResponse(
  stringBuffer: string
): StreamResponse | undefined {
  try {
    const line = stringBuffer.trim()
    if (!line) return undefined
    const payload = isStreamWithDataPrefix(line)
      ? line.slice("data:".length).trim()
      : line
    if (!payload || payload === "[DONE]") return undefined
    return JSON.parse(payload)
  } catch {
    return undefined
  }
}

export function safeParseJsonStringBuffer(
  stringBuffer: string
): unknown | undefined {
  try {
    return JSON.parse(stringBuffer.replace(NORMALIZE_REGEX, ""))
  } catch {
    return undefined
  }
}

export function safeParseJson<T>(data: string): T | undefined {
  try {
    return JSON.parse(data)
  } catch {
    return undefined
  }
}

export const getCurrentWorkspacePath = (): string | undefined => {
  if (workspace.workspaceFolders && workspace.workspaceFolders.length > 0) {
    const workspaceFolder = workspace.workspaceFolders[0]
    return workspaceFolder.uri.fsPath
  } else {
    window.showInformationMessage("No workspace is open.")
    return undefined
  }
}

export const getTerminal = async (): Promise<Terminal | undefined> => {
  const twinnyTerminal = window.terminals.find((t) => t.name === TWINNY)
  if (twinnyTerminal) return twinnyTerminal
  const terminal = window.createTerminal({ name: TWINNY })
  terminal.show()
  return terminal
}

export const getTerminalExists = (): boolean => {
  if (window.terminals.length === 0) {
    window.showErrorMessage("No active terminals")
    return false
  }
  return true
}

export const getNormalisedText = (text: string) =>
  text.replace(NORMALIZE_REGEX, " ")

function getSplitChunks(node: SyntaxNode, options: ChunkOptions): string[] {
  const { minSize = 50, maxSize = 500 } = options
  const chunks: string[] = []

  function traverse(node: SyntaxNode) {
    if (node.text.length <= maxSize && node.text.length >= minSize) {
      chunks.push(node.text)
    } else if (node.children.length > 0) {
      for (const child of node.children) {
        traverse(child)
      }
    } else if (node.text.length > maxSize) {
      let start = 0
      while (start < node.text.length) {
        const end = Math.min(start + maxSize, node.text.length)
        chunks.push(node.text.slice(start, end))
        start = end
      }
    }
  }

  traverse(node)
  return chunks
}

export const getChunkOptions = (
  context: ExtensionContext | undefined
): ChunkOptions => {
  if (!context) return defaultChunkOptions
  const maxChunkSizeContext = `${EVENT_NAME.twinnyGlobalContext}-${EXTENSION_CONTEXT_NAME.twinnyMaxChunkSize}`
  const minChunkSizeContext = `${EVENT_NAME.twinnyGlobalContext}-${EXTENSION_CONTEXT_NAME.twinnyMinChunkSize}`
  const overlap = `${EVENT_NAME.twinnyGlobalContext}-${EXTENSION_CONTEXT_NAME.twinnyOverlapSize}`

  const options = {
    maxSize: Number(context.globalState.get(maxChunkSizeContext)) || 500,
    minSize: Number(context.globalState.get(minChunkSizeContext)) || 50,
    overlap: Number(context.globalState.get(overlap)) || 10
  }

  return options
}

export async function getDocumentSplitChunks(
  content: string,
  filePath: string,
  context: ExtensionContext | undefined
): Promise<string[]> {
  if (!context) return []

  const options = getChunkOptions(context)

  try {
    const parser = await getParser(filePath)

    if (!parser) {
      return simpleChunk(content, options)
    }

    const tree = parser.parse(content)
    const chunks = getSplitChunks(tree.rootNode, options)
    return combineChunks(chunks, options)
  } catch (error) {
    console.error(`Error parsing file ${filePath}: ${error}`)
    return simpleChunk(content, options)
  }
}

function combineChunks(chunks: string[], options: ChunkOptions): string[] {
  const { minSize, maxSize, overlap } = options
  const result: string[] = []
  let currentChunk = ""

  for (const chunk of chunks) {
    if (currentChunk.length + chunk.length > maxSize) {
      if (currentChunk.length >= minSize) {
        result.push(currentChunk)
        currentChunk = chunk
      } else {
        currentChunk += " " + chunk
      }
    } else {
      currentChunk += (currentChunk ? " " : "") + chunk
    }
    if (currentChunk.length >= maxSize - overlap) {
      result.push(currentChunk)
      currentChunk = currentChunk.slice(-overlap)
    }
  }

  if (currentChunk.length >= minSize) {
    result.push(currentChunk)
  }

  return result
}

function simpleChunk(content: string, options: ChunkOptions): string[] {
  const { minSize = 50, maxSize = 500, overlap = 50 } = options
  const chunks: string[] = []
  let start = 0

  while (start < content.length) {
    const end = Math.min(start + maxSize, content.length)
    const chunk = content.slice(start, end)

    try {
      chunks.push(chunk)
    } catch (error) {
      if (
        error instanceof RangeError &&
        error.message.includes("Invalid array length")
      ) {
        break
      } else {
        throw error
      }
    }

    start = end - overlap > start ? end - overlap : end

    if (end === content.length) break
  }

  return chunks.filter(
    (chunk, index) => chunk.length >= minSize || index === chunks.length - 1
  )
}

export const updateLoadingMessage = (
  bridge: ExtensionBridge | undefined,
  message: string
) => {
  bridge?.emit(EVENT_NAME.twinnySendLoader, message)
}

export function getNonce() {
  let text = ""
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length))
  }
  return text
}

export function readGitSubmodulesFile(): string[] | undefined {
  try {
    const folders = workspace.workspaceFolders
    if (!folders || folders.length === 0) return undefined
    const rootPath = folders[0].uri.fsPath
    if (!rootPath) return undefined
    const gitSubmodulesFilePath = path.join(rootPath, ".gitmodules")
    if (!fs.existsSync(gitSubmodulesFilePath)) return undefined
    const submodulesFileContent = fs
      .readFileSync(gitSubmodulesFilePath)
      .toString()
    const submodulePaths: string[] = []
    submodulesFileContent.split("\n").forEach((line: string) => {
      if (line.startsWith("\tpath = ")) {
        submodulePaths.push(line.slice(8))
      }
    })
    return submodulePaths
  } catch {
    return undefined
  }
}

export async function getAllFilePaths(dirPath: string): Promise<string[]> {
  if (!dirPath) return []

  const rootPath = workspace.workspaceFolders?.[0]?.uri.fsPath || ""
  const config = workspace.getConfiguration("twinny")
  const submodules = readGitSubmodulesFile()

  const ig = ignore()
  const embeddingIgnoredGlobs = config.get<string[]>(
    "embeddingIgnoredGlobs",
    []
  )
  ig.add([...embeddingIgnoredGlobs, ".git", ".gitignore"])

  const gitIgnoreFilePath = path.join(rootPath, ".gitignore")
  if (fs.existsSync(gitIgnoreFilePath)) {
    ig.add(fs.readFileSync(gitIgnoreFilePath).toString())
  }

  const filePaths: string[] = []
  const dirents = await fs.promises.readdir(dirPath, { withFileTypes: true })

  for (const dirent of dirents) {
    const fullPath = path.join(dirPath, dirent.name)
    const relativePath = "/" + path.relative(rootPath, fullPath)

    if (submodules?.some((submodule) => relativePath.includes(submodule))) {
      continue
    }

    if (ig.ignores(relativePath.slice(1))) {
      continue
    }

    if (dirent.isDirectory()) {
      filePaths.push(...(await getAllFilePaths(fullPath)))
    } else if (dirent.isFile() && isIndexablePath(fullPath)) {
      filePaths.push(relativePath)
    }
  }

  return filePaths
}

export function readGitIgnoreFile(): string[] | undefined {
  try {
    const folders = workspace.workspaceFolders
    if (!folders || folders.length === 0) {
      console.log("No workspace folders found")
      return undefined
    }

    const rootPath = folders[0].uri.fsPath
    if (!rootPath) {
      console.log("Root path is undefined")
      return undefined
    }

    const gitIgnoreFilePath = path.join(rootPath, ".gitignore")
    if (!fs.existsSync(gitIgnoreFilePath)) {
      console.log(".gitignore file not found at", gitIgnoreFilePath)
      return undefined
    }

    const ignoreFileContent = fs.readFileSync(gitIgnoreFilePath, "utf8")
    return ignoreFileContent
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((pattern) => {
        if (pattern.endsWith("/")) {
          return pattern + "**"
        }
        return pattern
      })
  } catch (e) {
    console.error("Error reading .gitignore file:", e)
    return undefined
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const logStreamOptions = (opts: any) => {
  const hostname = opts.options?.hostname ?? "unknown"
  const port = opts.options?.port ?? undefined
  const body = opts.body ?? {}
  const options = opts.options ?? {}

  const totalCharacters = calculateTotalCharacters(body.messages)

  const logMessage = `
    ***Twinny Stream Debug***
    Streaming response from ${hostname}${port ? `:${port}` : ""}.
    Request body:
    ${JSON.stringify(body, null, 2)}

    Request options:
    ${JSON.stringify(options, null, 2)}

    Number characters in all messages = ${totalCharacters}
  `.trim()

  logger.log(logMessage)
}

const calculateTotalCharacters = (
  messages: ChatCompletionMessage[] | undefined
): number => {
  if (!Array.isArray(messages)) {
    return 0
  }

  return messages.reduce((acc: number, msg: ChatCompletionMessage) => {
    return acc + (typeof msg.content === "string" ? msg.content.length : 0)
  }, 0)
}

export function notifyKnownErrors(error: Error) {
  if (knownErrorMessages.some((msg) => error.message.includes(msg))) {
    vscode.window
      .showInformationMessage(
        "Besides Twinny, there may be other AI extensions being enabled (such as Fitten Code) that are affecting the behavior of the fetch API or ReadableStream used in the Twinny plugin. We recommend that you disable that AI plugin for the smooth use of Twinny",
        "View extensions",
        "Restart Visual Studio Code (after disabling related extensions)"
      )
      .then((selected) => {
        if (selected === "View extensions") {
          vscode.commands.executeCommand("workbench.view.extensions")
        } else if (
          selected ===
          "Restart Visual Studio Code (after disabling related extensions)"
        ) {
          vscode.commands.executeCommand("workbench.action.reloadWindow")
        }
      })
  }
}

export function sanitizeWorkspaceName(
  workspaceName: string | undefined
): string {
  const invalidChars = /[^a-zA-Z0-9_.-]+/g
  const sanitizedName = (workspaceName || "").replace(invalidChars, "_")

  return sanitizedName
}
