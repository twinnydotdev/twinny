import {
  ColorThemeKind,
  ConfigurationTarget,
  InlineCompletionContext,
  InlineCompletionTriggerKind,
  Position,
  Range,
  TextDocument,
  commands,
  window,
  workspace
} from 'vscode'

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
  CLOSING_BRACKETS,
  EXTENSION_NAME,
  OPENING_BRACKETS,
  PROVIDER_NAMES,
  QUOTES,
  SKIP_DECLARATION_SYMBOLS
} from '../common/constants'
import { Logger } from '../common/logger'

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
    .lineAt(Math.min(position.line + 1, editor.document.lineCount -1))
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

export const getIsMultiLineCompletion = () => {
  const nextLineIsClosingBracket = getNextLineIsClosingBracket()
  const previousLineIsOpeningBracket = getPreviousLineIsOpeningBracket()
  if (
    previousLineIsOpeningBracket &&
    nextLineIsClosingBracket &&
    !getHasLineTextBeforeAndAfter()
  ) {
    return true
  }
  return !getHasLineTextBeforeAndAfter() && !isCursorInEmptyString()
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
    case ApiProviders.Oobabooga:
      return data?.choices[0].text
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
