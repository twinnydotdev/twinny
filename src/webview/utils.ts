import { EMPTY_MESAGE } from '../common/constants'
import { CodeLanguage, supportedLanguages } from '../common/languages'
import { LanguageType, ServerMessage } from '../common/types'

export const getLanguageMatch = (
  language: LanguageType | undefined,
  className: string | undefined
) => {
  const match = /language-(\w+)/.exec(className || '')

  if (match && match.length) {
    const matchedLanguage = supportedLanguages[match[1] as CodeLanguage]

    return matchedLanguage && matchedLanguage.derivedFrom
      ? matchedLanguage.derivedFrom
      : match[1]
  }

  if (language && language.languageId) {
    const languageId = language.languageId.toString()
    const languageEntry = supportedLanguages[languageId as CodeLanguage]

    return languageEntry && languageEntry.derivedFrom
      ? languageEntry.derivedFrom
      : languageId
  }

  return 'auto'
}

export const getCompletionContent = (message: ServerMessage) => {
  if (message.value.error && message.value.errorMessage) {
    return message.value.errorMessage
  }

  return message.value.completion || EMPTY_MESAGE
}

export const kebabToSentence = (kebabStr: string) => {
  if (!kebabStr) {
    return ''
  }

  const words = kebabStr.split('-')

  if (!words.length) {
    return kebabStr
  }

  words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1)

  return words.join(' ')
}

export const getLineBreakCount = (str: string) => str.split('\n').length

export const getModelShortName = (name: string) => {
  if (name.length > 40) {
    return `${name.substring(0, 35)}...`
  }
  return name
}
