import {
  ColorThemeKind,
  ConfigurationTarget,
  InlineCompletionContext,
  InlineCompletionTriggerKind,
  Position,
  Range,
  TextDocument,
  Uri,
  commands,
  window,
  workspace
} from 'vscode'

import path from 'path'

import {
  Theme,
  LanguageType,
  ApiProviders,
  StreamResponse,
  StreamRequest,
  PrefixSuffix,
  Bracket
} from '../common/types'
import { supportedLanguages } from '../common/languages'
import {
  ALL_BRACKETS,
  API_PROVIDER,
  EXTENSION_NAME,
  IMPORT_SEPARATOR,
  SKIP_DECLARATION_SYMBOLS,
  SKIP_IMPORT_KEYWORDS_AFTER,
  PROVIDER_NAMES,
  PARSEABLE_NODES,
  WASM_LANGAUAGES,
  MAX_CONTEXT_LINE_COUNT,
  OPENING_BRACKETS,
  CLOSING_BRACKETS
} from '../common/constants'
import { Logger } from '../common/logger'
import Parser, { SyntaxNode } from 'web-tree-sitter'
import { FileInteractionCache } from './file-interaction'

const logger = new Logger()

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
  return text || ''
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

export const getIsSingleBracket = (completion: string) =>
  completion.length === 1 && getIsBracket(completion)

export const getIsOnlyBrackets = (completion: string) => {
  if (completion?.length === 0) return false

  for (const char of completion) {
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
    SKIP_DECLARATION_SYMBOLS.includes(characterBefore.trim()) &&
    textAfter.length &&
    !getIsOnlyBrackets(textAfter)
  ) {
    return true
  }

  return false
}

export const getSkipImportDeclaration = (
  characterBefore: string,
  textAfter: string
) => {
  for (const skipWord of SKIP_IMPORT_KEYWORDS_AFTER) {
    if (
      textAfter.includes(skipWord) &&
      !IMPORT_SEPARATOR.includes(characterBefore) &&
      characterBefore !== ' '
    ) {
      return true
    }
  }
  return false
}

export const getCharacterBefore = (index = -1): string => {
  const editor = window.activeTextEditor
  if (!editor) return ''
  const document = editor.document
  const cursorPosition = editor.selection.active
  const textBeforeRange = new Range(cursorPosition, new Position(0, 0))
  const textBefore = document.getText(textBeforeRange)
  const characterBefore = textBefore.at(index) as string

  if (characterBefore === undefined) {
    return SKIP_DECLARATION_SYMBOLS[0]
  }

  if (!characterBefore.trim()) {
    return getCharacterBefore(index - 1)
  }
  return characterBefore
}

export const getShouldSkipCompletion = (
  context: InlineCompletionContext,
  disableAuto: boolean
) => {
  const editor = window.activeTextEditor
  if (!editor) return true
  const document = editor.document
  const cursorPosition = editor.selection.active
  const lineEndPosition = document.lineAt(cursorPosition.line).range.end
  const textAfterRange = new Range(cursorPosition, lineEndPosition)
  const textAfter = document.getText(textAfterRange)
  const characterBefore = getCharacterBefore()
  if (getSkipVariableDeclataion(characterBefore, textAfter)) return true
  if (getSkipImportDeclaration(characterBefore, textAfter)) return true

  return (
    context.triggerKind === InlineCompletionTriggerKind.Automatic && disableAuto
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

export const setApiDefaults = () => {
  const config = workspace.getConfiguration('twinny')

  const provider = config.get('apiProvider') as string

  if (PROVIDER_NAMES.includes(provider)) {
    const { fimApiPath, chatApiPath, port } = API_PROVIDER[provider]
    config.update('fimApiPath', fimApiPath, ConfigurationTarget.Global)
    config.update('chatApiPath', chatApiPath, ConfigurationTarget.Global)
    config.update('chatApiPort', port, ConfigurationTarget.Global)
    config.update('fimApiPort', port, ConfigurationTarget.Global)
    commands.executeCommand('workbench.action.openSettings', EXTENSION_NAME)
  }
}

export const getChatDataFromProvider = (
  provider: string,
  data: StreamResponse | undefined
) => {
  switch (provider) {
    case ApiProviders.Ollama:
    case ApiProviders.OllamaWebUi:
      return data?.choices[0].delta?.content
        ? data?.choices[0].delta.content
        : ''
    case ApiProviders.LlamaCpp:
      return data?.content
    default:
      if (data?.choices[0].delta.content === 'undefined') {
        return ''
      }
      return data?.choices[0].delta?.content
        ? data?.choices[0].delta.content
        : ''
  }
}

export const getFimDataFromProvider = (
  provider: string,
  data: StreamResponse | undefined
) => {
  switch (provider) {
    case ApiProviders.Ollama:
      return data?.response
    case ApiProviders.LlamaCpp:
      return data?.content
    default:
      if (!data?.choices.length) return
      if (data?.choices[0].text === 'undefined') {
        return ''
      }
      return data?.choices[0].text ? data?.choices[0].text : ''
  }
}

export function isStreamWithDataPrefix(stringBuffer: string) {
  return stringBuffer.startsWith('data:')
}

export function safeParseJsonResponse(
  stringBuffer: string
): StreamResponse | undefined {
  try {
    if (isStreamWithDataPrefix(stringBuffer)) {
      return JSON.parse(stringBuffer.split('data:')[1])
    }
    return JSON.parse(stringBuffer)
  } catch (e) {
    return undefined
  }
}

export const logStreamOptions = (opts: StreamRequest) => {
  logger.log(
    `
***Twinny Stream Debug***\n\
Streaming response from ${opts.options.hostname}:${opts.options.port}.\n\
Request body:\n${JSON.stringify(opts.body, null, 2)}\n\n
Request options:\n${JSON.stringify(opts.options, null, 2)}\n\n
    `
  )
}

export const getParserForFile = async (filePath: string) => {
  await Parser.init()
  const parser = new Parser()
  const extension = path.extname(filePath).slice(1)
  const language = WASM_LANGAUAGES[extension]

  logger.log(`Using parser for ${language}`)

  if (!language) return undefined

  const wasmPath = path.join(
    __dirname,
    'tree-sitter-wasms',
    `tree-sitter-${language}.wasm`
  )
  const Language = await Parser.Language.load(wasmPath)
  parser.setLanguage(Language)
  return parser
}

export const getDocumentSplitChunks = async (
  content: string,
  parser: Parser,
  commnetStart?: string
): Promise<string[]> => {
  const tree = parser.parse(content)

  const findNodes = (
    node: Parser.SyntaxNode,
    types: string[]
  ): Parser.SyntaxNode[] => {
    let nodes = []
    if (types.includes(node.type)) {
      nodes.push(node)
    }
    for (const child of node.children) {
      nodes = nodes.concat(findNodes(child, types))
    }
    return nodes
  }

  const targetedNodes = findNodes(tree.rootNode, PARSEABLE_NODES)

  const seenChunks: string[] = []
  const chunks = targetedNodes
    .map((node: Parser.SyntaxNode) => {
      const startLine = node.startPosition.row
      const endLine = node.endPosition.row + 1
      const chunk = content
        .split('\n')
        .slice(startLine, endLine)
        .map((line: string) => `${commnetStart}${line}`)
        .join('\n')
        .trim()

      if (getIsDuplicateChunk(chunk, seenChunks)) return ''

      seenChunks.push(chunk.trim().toLowerCase())
      return chunk
    })
    .filter((chunk: string) => chunk !== '')

  return chunks
}

export const getParsedContext = async (
  parser: Parser,
  document: TextDocument,
  filePath: string
) => {
  const fileChunks: string[] = []

  const language =
    supportedLanguages[document.languageId as keyof typeof supportedLanguages]

  const lang = language?.langName ? `\n//Language: ${language.langName}` : ''

  if (parser && language) {
    const documentChunks = await getDocumentSplitChunks(
      document.getText(),
      parser,
      language.syntaxComments?.singleLine
    )

    const documentContext = documentChunks
      .map((docString) => docString)
      .join('\n')

    if (!documentContext.trim()) return ''

    const chunk = `\n//File: ${filePath} ${lang} \n${documentContext}`

    fileChunks.push(chunk)
  }

  return fileChunks
}

export const getCommentedSnipped = (snippet: string, comment?: string) => {
  return snippet
    .split('\n')
    .map((line) => `${comment || '//'}${line}`)
    .join('\n')
}

export const getAverageLineContext = (
  lineCount: number,
  document: TextDocument,
  filePath: string,
  activeLines: {
    line: number
    character: number
  }[]
) => {
  const fileChunks = []

  const language =
    supportedLanguages[document.languageId as keyof typeof supportedLanguages]

  const lang = language?.langName ? `\n//Language: ${language.langName}` : ''

  if (lineCount > MAX_CONTEXT_LINE_COUNT) {
    const averageLine =
      activeLines.reduce((acc, curr) => acc + curr.line, 0) / activeLines.length
    const start = new Position(
      Math.max(0, Math.ceil(averageLine || 0) - 100),
      0
    )
    const end = new Position(
      Math.min(lineCount, Math.ceil(averageLine || 0) + 100),
      0
    )

    const snippet = getCommentedSnipped(
      document.getText(new Range(start, end)),
      language?.syntaxComments?.singleLine
    )

    const rangeContext = `\n//File: ${filePath} ${lang} \n${snippet}`
    fileChunks.push(rangeContext)
  } else {
    const snippet = getCommentedSnipped(
      document.getText(),
      language?.syntaxComments?.singleLine
    )
    const fileContext = `\n// File: ${filePath} ${lang} \n${snippet}`
    fileChunks.push(fileContext)
  }
  return fileChunks
}

export const getPromptHeader = (languageId: string | undefined, uri: Uri) => {
  const lang = supportedLanguages[languageId as keyof typeof supportedLanguages]

  if (!lang) {
    return ''
  }

  const language = `${lang.syntaxComments?.start || ''} Language: ${
    lang?.langName
  } (${languageId}) ${lang.syntaxComments?.end || ''}`

  const path = `${
    lang.syntaxComments?.start || ''
  } File uri: ${uri.toString()} (${languageId}) ${
    lang.syntaxComments?.end || ''
  }`

  return `\n${language}\n${path}\n`
}

export const getFileInteractionContext = async (
  fileInteractionCache: FileInteractionCache,
  document: TextDocument
) => {
  const interactions = fileInteractionCache.getAll()
  const currentFileName = document.fileName || ''

  let fileChunks: string[] = []

  for (const interaction of interactions) {
    const filePath = interaction.name

    if (filePath.toString().match('.git')) {
      continue
    }

    const uri = Uri.file(filePath)

    if (currentFileName === filePath) continue

    const activeLines = interaction.activeLines

    const document = await workspace.openTextDocument(uri)
    const lineCount = document.lineCount

    const parser = await getParserForFile(filePath)

    if (parser) {
      const context = await getParsedContext(parser, document, filePath)
      fileChunks = fileChunks.concat(context)
      continue
    }

    fileChunks = fileChunks.concat(
      getAverageLineContext(lineCount, document, filePath, activeLines)
    )
  }

  return fileChunks.join('\n')
}

export const getIsDuplicateChunk = (
  chunk: string,
  chunks: string[] = []
): boolean => {
  return chunks.includes(chunk.trim().toLowerCase())
}

function getNodeAtPosition(
  rootNode: SyntaxNode,
  position: Position
): SyntaxNode | null {
  let foundNode: SyntaxNode | null = null

  // Define a recursive function to search for the node
  function searchNode(node: SyntaxNode): boolean {
    // Check if the position is within the node's range
    if (
      position.line + 1 >= node.startPosition.row + 1 &&
      position.line + 1 <= node.endPosition.row + 1
    ) {
      foundNode = node // Update foundNode with the current node
      // Iterate through the children of the current node to search deeper
      for (const child of node.children) {
        if (searchNode(child)) {
          break // Stop searching if the most specific node is found
        }
      }
      return true // Indicates that the node contains the position
    }
    return false // Indicates that the node does not contain the position
  }

  // Start the search with the root node
  searchNode(rootNode)

  return foundNode // Return the most specific node found
}

function getIsMultiLineByNode(node: Parser.SyntaxNode | null): boolean {
  if (
    node?.type === 'statement_block' ||
    (node?.type === 'block' &&
      OPENING_BRACKETS.includes(node.text.at(0) as string) &&
      CLOSING_BRACKETS.includes(node.text.at(-1) as string))
  ) {
    return true
  } else {
    return false
  }
}

export const getIsMultiLineCompletion = (
  rootNode: Parser.SyntaxNode | undefined
) => {
  const editor = window.activeTextEditor

  if (!editor) return false

  if (rootNode?.children.length === 1) {
    return true
  }
  const node = getNodeAtPosition(
    rootNode as Parser.SyntaxNode,
    editor.selection.active
  )

  return getIsMultiLineByNode(node)
}
