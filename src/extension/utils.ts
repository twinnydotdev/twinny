import { exec } from "child_process"
import fs from "fs"
import ignore from "ignore"
import path from "path"
import * as util from "util"
import * as vscode from "vscode"
import {
  ColorThemeKind,
  ExtensionContext,
  InlineCompletionContext,
  InlineCompletionTriggerKind,
  Position,
  Range,
  Terminal,
  TextDocument,
  Webview,
  window,
  workspace
} from "vscode"
import { SyntaxNode } from "web-tree-sitter"

import {
  ALL_BRACKETS,
  API_PROVIDERS,
  CLOSING_BRACKETS,
  defaultChunkOptions,
  EVENT_NAME,
  EXTENSION_CONTEXT_NAME,
  knownErrorMessages,
  MULTILINE_TYPES,
  NORMALIZE_REGEX,
  OPEN_AI_COMPATIBLE_PROVIDERS,
  OPENING_BRACKETS,
  QUOTES,
  SKIP_DECLARATION_SYMBOLS,
  TWINNY
} from "../common/constants"
import { supportedLanguages } from "../common/languages"
import { logger } from "../common/logger"
import {
  Bracket,
  ChatCompletionMessage,
  ChunkOptions,
  LanguageType,
  PrefixSuffix,
  ServerMessage,
  ServerMessageKey,
  StreamResponse,
  Theme,
} from "../common/types"

import { getParser } from "./parser"
import { TwinnyProvider } from "./provider-manager"

const execAsync = util.promisify(exec)

export const delayExecution = <T extends () => void>(
  fn: T,
  delay = 200
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

export const getIsBracket = (char: string): char is Bracket => {
  return ALL_BRACKETS.includes(char as Bracket)
}

export const getIsClosingBracket = (char: string): char is Bracket => {
  return CLOSING_BRACKETS.includes(char as Bracket)
}

export const getIsOpeningBracket = (char: string): char is Bracket => {
  return OPENING_BRACKETS.includes(char as Bracket)
}

export const getIsSingleBracket = (chars: string) =>
  chars?.length === 1 && getIsBracket(chars)

export const getIsOnlyOpeningBrackets = (chars: string) => {
  if (!chars || !chars.length) return false

  for (const char of chars) {
    if (!getIsOpeningBracket(char)) {
      return false
    }
  }
  return true
}

export const getIsOnlyClosingBrackets = (chars: string) => {
  if (!chars || !chars.length) return false

  for (const char of chars) {
    if (!getIsClosingBracket(char)) {
      return false
    }
  }
  return true
}

export const getIsOnlyBrackets = (chars: string) => {
  if (!chars || !chars.length) return false

  for (const char of chars) {
    if (!getIsBracket(char)) {
      return false
    }
  }
  return true
}

export const getSkipVariableDeclataion = (
  characterBefore: string,
  textAfter: string
) => {
  if (
    characterBefore &&
    SKIP_DECLARATION_SYMBOLS.includes(characterBefore.trim()) &&
    textAfter.length &&
    (!textAfter.at(0) as unknown as string) === "?" &&
    !getIsOnlyBrackets(textAfter)
  ) {
    return true
  }

  return false
}

export const getShouldSkipCompletion = (
  context: InlineCompletionContext,
  autoSuggestEnabled: boolean
) => {
  const editor = window.activeTextEditor
  if (!editor) return true
  const document = editor.document
  const cursorPosition = editor.selection.active
  const lineEndPosition = document.lineAt(cursorPosition.line).range.end
  const textAfterRange = new Range(cursorPosition, lineEndPosition)
  const textAfter = document.getText(textAfterRange)
  const { charBefore } = getBeforeAndAfter()

  if (getSkipVariableDeclataion(charBefore, textAfter)) {
    return true
  }

  return (
    context.triggerKind === InlineCompletionTriggerKind.Automatic &&
    !autoSuggestEnabled
  )
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
    prefix: document.getText(prefixRange),
    suffix: document.getText(suffixRange)
  }
}

export const getBeforeAndAfter = () => {
  const editor = window.activeTextEditor
  if (!editor)
    return {
      charBefore: "",
      charAfter: ""
    }

  const position = editor.selection.active
  const lineText = editor.document.lineAt(position.line).text

  const charBefore = lineText
    .substring(0, position.character)
    .trim()
    .split("")
    .reverse()[0]

  const charAfter = lineText.substring(position.character).trim().split("")[0]

  return {
    charBefore,
    charAfter
  }
}

export const getIsMiddleOfString = () => {
  const { charBefore, charAfter } = getBeforeAndAfter()

  return (
    charBefore && charAfter && /\w/.test(charBefore) && /\w/.test(charAfter)
  )
}

export const getCurrentLineText = (position: Position | null) => {
  const editor = window.activeTextEditor
  if (!editor || !position) return ""

  const lineText = editor.document.lineAt(position.line).text

  return lineText
}

export const getHasLineTextBeforeAndAfter = () => {
  const { charBefore, charAfter } = getBeforeAndAfter()

  return charBefore && charAfter
}

export const isCursorInEmptyString = () => {
  const { charBefore, charAfter } = getBeforeAndAfter()

  return QUOTES.includes(charBefore) && QUOTES.includes(charAfter)
}

export const getNextLineIsClosingBracket = () => {
  const editor = window.activeTextEditor
  if (!editor) return false
  const position = editor.selection.active
  const nextLineText = editor.document
    .lineAt(Math.min(position.line + 1, editor.document.lineCount - 1))
    .text.trim()
  return getIsOnlyClosingBrackets(nextLineText)
}

export const getPreviousLineIsOpeningBracket = () => {
  const editor = window.activeTextEditor
  if (!editor) return false
  const position = editor.selection.active
  const previousLineCharacter = editor.document
    .lineAt(Math.max(position.line - 1, 0))
    .text.trim()
    .split("")
    .reverse()[0]
  return getIsOnlyOpeningBrackets(previousLineCharacter)
}

export const getIsMultilineCompletion = ({
  node,
  prefixSuffix
}: {
  node: SyntaxNode | null
  prefixSuffix: PrefixSuffix | null
}) => {
  if (!node) return false

  const isMultilineCompletion =
    !getHasLineTextBeforeAndAfter() &&
    !isCursorInEmptyString() &&
    MULTILINE_TYPES.includes(node.type)

  return !!(isMultilineCompletion || !prefixSuffix?.suffix.trim())
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
  const providers = Object.values(OPEN_AI_COMPATIBLE_PROVIDERS) as string []
  return providers.includes(provider.provider)
}

export const getFimDataFromProvider = (
  provider: string,
  data: StreamResponse | undefined
) => {
  switch (provider) {
    case API_PROVIDERS.OpenAICompatible:
    case API_PROVIDERS.Ollama:
    case API_PROVIDERS.OpenWebUI:
      return data?.response
    case API_PROVIDERS.LlamaCpp:
      return data?.content
    case API_PROVIDERS.LiteLLM:
      return data?.choices[0].delta.content
    default:
      if (!data?.choices.length) return
      if (data?.choices[0].text === "undefined") {
        return ""
      }
      return data?.choices[0].text ? data?.choices[0].text : ""
  }
}

export function isStreamWithDataPrefix(stringBuffer: string) {
  return stringBuffer.startsWith("data:")
}

export const getNoTextBeforeOrAfter = () => {
  const editor = window.activeTextEditor
  const cursorPosition = editor?.selection.active
  if (!cursorPosition) return
  const lastLinePosition = new Position(
    cursorPosition.line,
    editor.document.lineCount
  )
  const textAfterRange = new Range(cursorPosition, lastLinePosition)
  const textAfter = editor?.document.getText(textAfterRange)
  const textBeforeRange = new Range(new Position(0, 0), cursorPosition)
  const textBefore = editor?.document.getText(textBeforeRange)
  return !textAfter || !textBefore
}

export function safeParseJsonResponse(
  stringBuffer: string
): StreamResponse | undefined {
  try {
    if (isStreamWithDataPrefix(stringBuffer)) {
      return JSON.parse(stringBuffer.split("data:")[1])
    }
    return JSON.parse(stringBuffer)
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

export const getGitChanges = async (): Promise<string> => {
  try {
    const path = getCurrentWorkspacePath()
    const { stdout } = await execAsync("git diff", {
      cwd: path
    })
    return stdout
  } catch (error) {
    console.error("Error executing git command:", error)
    return ""
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

export function createSymmetryMessage<T>(
  key: ServerMessageKey,
  data?: T
): string {
  return JSON.stringify({ key, data })
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
  webView: Webview | undefined,
  message: string
) => {
  webView?.postMessage({
    type: EVENT_NAME.twinnySendLoader,
    data: message
  } as ServerMessage<string>)
}

export const updateSymmetryStatus = (
  webView: Webview | undefined,
  message: string
) => {
  webView?.postMessage({
    type: EVENT_NAME.twinnySendSymmetryMessage,
    data: message
  } as ServerMessage<string>)
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
      logger.log(`git-ignored: ${relativePath}`)
      continue
    }

    if (dirent.isDirectory()) {
      filePaths.push(...(await getAllFilePaths(fullPath)))
    } else if (dirent.isFile()) {
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
