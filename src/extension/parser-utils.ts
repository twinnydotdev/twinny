import Parser, { SyntaxNode } from 'web-tree-sitter'
import {
  WASM_LANGAUAGES
} from '../common/constants'
import path from 'path'
import { Logger } from '../common/logger'
import { Position } from 'vscode'
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

  return foundNode
}
