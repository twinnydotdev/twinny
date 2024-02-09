import {
  ColorThemeKind,
  ConfigurationTarget,
  Position,
  TextEditor,
  commands,
  window,
  workspace
} from 'vscode'

import { Theme, LanguageType, Bracket } from './types'
import { supportedLanguages } from './languages'
import {
  API_PROVIDERS,
  BRACKET_REGEX,
  EXTENSION_NAME,
  NORMALIZE_REGEX,
  PROVIDER_NAMES,
  allBrackets,
  closingBrackets,
  openingBrackets
} from './constants'

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

export const isBracket = (char: string): char is Bracket => {
  return allBrackets.includes(char as Bracket)
}

export const isMatchingPair = (open?: Bracket, close?: string): boolean => {
  return (
    (open === '[' && close === ']') ||
    (open === '(' && close === ')') ||
    (open === '{' && close === '}')
  )
}

export const countLines = (inputString: string) => {
  const lines = inputString.split('\n')
  const lineCount = lines.length
  return lineCount
}

export const bracketMatcher = (completion: string): string => {
  let accumulatedCompletion = ''
  const normalisedCompletion = completion.replace(NORMALIZE_REGEX, '')
  const openBrackets: Bracket[] = []

  if (BRACKET_REGEX.test(normalisedCompletion) || completion.length <= 1)
    return completion

  for (const character of completion) {
    if (openingBrackets.includes(character)) {
      openBrackets.push(character)
    }

    if (closingBrackets.includes(character)) {
      if (
        openBrackets.length &&
        isMatchingPair(openBrackets.at(-1), character)
      ) {
        openBrackets.pop()
      } else {
        break
      }
    }

    accumulatedCompletion += character
  }

  return accumulatedCompletion.trimEnd() || completion
}

export const removeDuplicateLinesDown = (
  completion: string,
  editor: TextEditor,
  cursorPosition: Position,
  linesDown = 3
) => {
  const accumulatedCompletion = completion
  const lineCount = editor.document.lineCount
  let nextLineIndex = cursorPosition.line + 1
  while (
    nextLineIndex < cursorPosition.line + linesDown &&
    nextLineIndex < lineCount
  ) {
    const line = editor.document.lineAt(nextLineIndex)
    const nextLineText = line.text
    const accumulatedCompletion = nextLineText
      .replace(NORMALIZE_REGEX, '')
      .trim()
    if (accumulatedCompletion === completion) return ''
    nextLineIndex++
  }
  return accumulatedCompletion
}

export const getIsSingleBracket = (completion: string) =>
  completion.length === 1 && isBracket(completion)

export const getCompletionNormalized = (completion: string) =>
  completion.replace(NORMALIZE_REGEX, '')

export const removeDoubleQuoteEndings = (
  completion: string,
  nextCharacter: string
) => {
  if (
    completion.endsWith('\'' || completion.endsWith('"')) &&
    (nextCharacter === '"' || nextCharacter === '\'')
  ) {
    completion = completion.slice(0, -1)
  }
  return completion
}

export const setApiDefaults = () => {
  const config = workspace.getConfiguration('twinny')

  const provider = config.get('apiProvider') as string

  if (PROVIDER_NAMES.includes(provider)) {
    const { fimApiPath, chatApiPath, port } = API_PROVIDERS[provider]
    config.update('fimApiPath', fimApiPath, ConfigurationTarget.Global)
    config.update('chatApiPath', chatApiPath, ConfigurationTarget.Global)
    config.update('chatApiPort', port, ConfigurationTarget.Global)
    config.update('fimApiPort', port, ConfigurationTarget.Global)
    commands.executeCommand('workbench.action.openSettings', EXTENSION_NAME)
  }
}

export const noop = () => undefined
