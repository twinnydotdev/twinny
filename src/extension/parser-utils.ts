import Parser, { SyntaxNode } from 'web-tree-sitter'
import {
  DECLARATION_TYPE,
  MULTI_LINE_NODE_TYPE,
  WASM_LANGAUAGES
} from '../common/constants'
import { Position, window } from 'vscode'
import path from 'path'
import { getIsOnlyBrackets } from './utils'
import { Logger } from '../common/logger'
import { getLineBreakCount } from '../webview/utils'
const logger = new Logger()

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
      position.line >= node.startPosition.row &&
      position.line <= node.endPosition.row
    ) {
      foundNode = node
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

  if (treeNodeWithError) return treeNodeWithError

  if (vistedNodeWithError && vistedNodeWithError.text.split('\n')) {
    return vistedNodeWithError
  }

  return foundNode
}

const getIsErrorWithLexicalDeclaration = (node: SyntaxNode) => {
  if (!node.hasError && node.text === '') return false
  const lineCount = getLineBreakCount(node.text)
  return node.type === 'lexical_declaration' && node.hasError && lineCount === 1
}

const getIsEmptyJsxNode = (node: SyntaxNode) => {
  if (!node) return false
  return node.type === 'jsx_element' && node.childCount === 2
}

const getIsNodeWithErrorDeclaration = (node: SyntaxNode) => {
  if (!node.hasError) return false
  const isErrorWithDeclaration = node.text.split('\n')[0].trim().at(-1) === '='
  return isErrorWithDeclaration
}

export const getIsMultiLineNode = (node: SyntaxNode | null) => {
  if (!node) return false
  return node && MULTI_LINE_NODE_TYPE.includes(node.type)
}

export const getIsEmptyMultiLineBlock = (node: SyntaxNode | null): boolean => {
  if (!node) return false
  const isMultiLineType = getIsMultiLineNode(node)
  const isOnlyBrackets = getIsOnlyBrackets(
    node.children.map((n) => n.text).join('')
  )
  return isMultiLineType && (isOnlyBrackets || !node.hasError)
}

export const getOpenAndCloseBracketMatchJsx = (node: SyntaxNode | null) => {
  const firstNode = node?.children[0]
  const lastNode = node?.children[node?.childCount - 1]
  if (!firstNode || !lastNode) return
  if (firstNode.text === '<' && lastNode?.text === '>') return true
  return false
}

export const getIsEmptyMultiLineNode = (node: SyntaxNode) => {
  const editor = window.activeTextEditor || undefined
  const cursorLinePosition = editor?.selection.active.line || 0

  return (
    getIsMultiLineNode(node) && node.startPosition.row - cursorLinePosition <= 0
  )
}

export const getIsDeclarationType = (node: SyntaxNode) => {
  if (
    DECLARATION_TYPE.includes(node.text) ||
    DECLARATION_TYPE.includes(node.type)
  ) {
    return true
  }
  return false
}

export const getIsMultiLineCompletionNode = (node: SyntaxNode | null) => {
  if (!node) return false

  return (
    getOpenAndCloseBracketMatchJsx(node) ||
    getIsDeclarationType(node) ||
    getIsEmptyMultiLineBlock(node) ||
    getIsNodeWithErrorDeclaration(node) ||
    getIsErrorWithLexicalDeclaration(node) ||
    getIsEmptyJsxNode(node)
  )
}
