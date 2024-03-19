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
  EXTENSION_NAME,
  IMPORT_SEPARATOR,
  PROVIDER_NAMES,
  QUOTES,
  SKIP_DECLARATION_SYMBOLS,
  SKIP_IMPORT_KEYWORDS_AFTER
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

export const getIsSingleBracket = (completion: string) =>
  completion.length === 1 && getIsBracket(completion)

export const getIsOnlyBrackets = (completion: string) => {
  if (completion.length === 0) return false

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

export const getBeforeAndAfter = (matcher: (char: string) => boolean) => {
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
    .split('')
    .reverse()
    .find(matcher)

  const charAfter = lineText
    .substring(position.character)
    .split('')
    .find(matcher)

  return {
    charBefore,
    charAfter
  }
}

export const isMiddleWord = () => {
  const { charBefore, charAfter } = getBeforeAndAfter((char: string) => {
    return /\w/.test(char)
  })

  return charBefore && charAfter && QUOTES?.includes(charAfter)
}

export const isCursorInEmptyString = () => {
  const { charBefore, charAfter } = getBeforeAndAfter((char) =>
    QUOTES.includes(char)
  )

  return charBefore && charAfter
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
