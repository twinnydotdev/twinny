import Parser, { SyntaxNode } from 'web-tree-sitter'
import path from 'path'

import { Position, window } from 'vscode'

import {
  DECLARATION_TYPE,
  EMPTY_MESAGE,
  MULTI_LINE_CANIDATES,
  WASM_LANGAUAGES
} from '../common/constants'
import { CodeLanguage, supportedLanguages } from '../common/languages'
import { LanguageType, ServerMessage } from '../common/types'
import { Logger } from '../common/logger'
import { getIsOnlyBrackets } from '../extension/utils'

const logger = new Logger()

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

export const getModelShortName = (name: string) => {
  if (name.length > 32) {
    return `${name.substring(0, 15)}...${name.substring(name.length - 16)}`
  }
  return name
}

export const getParserForFile = async (
  filePath: string
): Promise<Parser | undefined> => {
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

export function getNodeAtPosition(
  tree: Parser.Tree | undefined,
  position: Position
): SyntaxNode | null {
  let foundNode: SyntaxNode | null = null
  const visitedNodes: SyntaxNode[] = []
  if (!tree || !position) {
    return null
  }

  function searchNode(node: SyntaxNode): boolean {
    if (
      position.line + 1 >= node.startPosition.row + 1 &&
      position.line + 1 <= node.endPosition.row + 1
    ) {
      foundNode = node
      console.log(foundNode?.type)
      for (const child of node.children) {
        visitedNodes.push(child)
        if (searchNode(child)) break
      }
      return true
    }
    return false
  }

  searchNode(tree.rootNode)

  const vistedNodeWithError = visitedNodes.find((n) => n.hasError)
  const treeNodeWithError = tree.rootNode.children.find((n) => n.hasError)

  if (treeNodeWithError) {
    return treeNodeWithError
  }

  if (vistedNodeWithError && vistedNodeWithError.text.split('\n')) {
    return vistedNodeWithError
  }

  return foundNode
}

const isErrorWithLexicalDeclaration = (node: SyntaxNode) => {
  if (!node.hasError && node.text === '') return false
  return node.type === 'lexical_declaration' && node.hasError
}

const getIsNodeWithErrorDeclaration = (node: SyntaxNode) => {
  if (!node.hasError) return false
  const isErrorWithDeclaration = node.text.split('\n')[0].trim().at(-1) === '='
  return isErrorWithDeclaration
}

export const getIsMultiLineCandidate = (node: SyntaxNode | null) => {
  if (!node) return false
  return node && MULTI_LINE_CANIDATES.includes(node.type)
}

export const getIsEmptyCandidate = (node: SyntaxNode | null): boolean => {
  if (!node) return false
  const isMultiLineCandidate = getIsMultiLineCandidate(node)
  const isOnlyBrackets = getIsOnlyBrackets(
    node.children.map((n) => n.text).join('')
  )
  return isMultiLineCandidate && isOnlyBrackets
}

export const getIsMultiLineCompletion = (node: SyntaxNode | null) => {
  if (!node) return false

  if (DECLARATION_TYPE.includes(node.text) || DECLARATION_TYPE.includes(node.type)) {
    return true
  }

  if (
    getIsEmptyCandidate(node) ||
    getIsNodeWithErrorDeclaration(node) ||
    isErrorWithLexicalDeclaration(node)
  ) {
    return true
  }

  const editor = window.activeTextEditor || undefined
  const cursorPosition = editor?.selection.active.line || 0

  const isBlock = getIsMultiLineCandidate(node)

  console.log(isBlock, node.startPosition.row - cursorPosition)

  if (isBlock && node.startPosition.row - cursorPosition <= 0) {
    return true
  }

  return false
}

export const getLineBreakCount = (str: string) => str.split('\n').length
