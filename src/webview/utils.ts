import { EMPTY_MESAGE } from '../constants'
import { CodeLanguage, supportedLanguages } from '../extension/languages'
import { LanguageType, ServerMessage } from '../extension/types'

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

  return 'javascript'
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

export const getModelShortName = (name: string) => {
  if (name.length > 32) {
    return `${name.substring(0, 15)}...${name.substring(name.length - 16)}`
  }
  return name
}
