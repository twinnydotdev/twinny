import {
  ColorThemeKind,
  InlineCompletionContext,
  InlineCompletionTriggerKind,
  Position,
  Range,
  Terminal,
  TextDocument,
  window,
  workspace
} from 'vscode'
import * as util from 'util'
import { exec } from 'child_process'

const execAsync = util.promisify(exec)

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
  CLOSING_BRACKETS,
  LINE_BREAK_REGEX,
  MULTILINE_TYPES,
  OPENING_BRACKETS,
  QUOTES,
  QUOTES_REGEX,
  SKIP_DECLARATION_SYMBOLS,
  TWINNY
} from '../common/constants'
import { Logger } from '../common/logger'
import { SyntaxNode } from 'web-tree-sitter'

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
    (!textAfter.at(0) as unknown as string) === '?' &&
    !getIsOnlyBrackets(textAfter)
  ) {
    return true
  }

  return false
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
  const { charBefore } = getBeforeAndAfter()

  if (getSkipVariableDeclataion(charBefore, textAfter)) {
    return true
  }

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

export const getBeforeAndAfter = () => {
  const editor = window.activeTextEditor
  if (!editor)
    return {
      charBefore: '',
      charAfter: ''
    }

  const position = editor.selection.active
  const lineText = editor.document.lineAt(position.line).text

  const charBefore = lineText
    .substring(0, position.character)
    .trim()
    .split('')
    .reverse()[0]

  const charAfter = lineText.substring(position.character).trim().split('')[0]

  return {
    charBefore,
    charAfter
  }
}

export const getIsMiddleWord = () => {
  const { charBefore, charAfter } = getBeforeAndAfter()

  return (
    charBefore && charAfter && /\w/.test(charBefore) && /\w/.test(charAfter)
  )
}

export const getCurrentLineText = (position: Position | null) => {
  const editor = window.activeTextEditor
  if (!editor || !position) return ''

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
    .split('')
    .reverse()[0]
  return getIsOnlyOpeningBrackets(previousLineCharacter)
}

export const getIsMultilineCompletion = (
  node: SyntaxNode | null,
  prefixSuffix: PrefixSuffix | null
) => {
  if (!node) return false
  const isMultilineCompletion =
    (!getHasLineTextBeforeAndAfter() &&
      !isCursorInEmptyString() &&
      MULTILINE_TYPES.includes(node.type)) ||
    !prefixSuffix?.suffix.trim()
  return isMultilineCompletion
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
    case ApiProviders.LiteLLM:
    default:
      if (data?.choices[0].delta.content === 'undefined') return ''
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
    case ApiProviders.LiteLLM:
      return data?.choices[0].delta.content
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
      return JSON.parse(stringBuffer.split('data:')[1])
    }
    return JSON.parse(stringBuffer)
  } catch (e) {
    return undefined
  }
}

export const getCurrentWorkspacePath = (): string | undefined => {
  if (workspace.workspaceFolders && workspace.workspaceFolders.length > 0) {
    const workspaceFolder = workspace.workspaceFolders[0]
    return workspaceFolder.uri.fsPath
  } else {
    window.showInformationMessage('No workspace is open.')
    return undefined
  }
}

export const getGitChanges = async (): Promise<string> => {
  try {
    const path = getCurrentWorkspacePath()
    const { stdout } = await execAsync('git diff --cached', {
      cwd: path
    })
    return stdout
  } catch (error) {
    console.error('Error executing git command:', error)
    return ''
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
    window.showErrorMessage('No active terminals')
    return false
  }
  return true
}

export const getSanitizedCommitMessage = (commitMessage: string) => {
  const sanitizedMessage = commitMessage
    .replace(QUOTES_REGEX, '')
    .replace(LINE_BREAK_REGEX, '')
    .trim()

  return `git commit -m "${sanitizedMessage}"`
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
