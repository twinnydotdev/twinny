import Parser, { SyntaxNode } from 'web-tree-sitter'
import { WASM_LANGAUAGES } from '../common/constants'
import path from 'path'
import { Logger } from '../common/logger'
import { Position } from 'vscode'
const logger = new Logger()

let parser: Parser
let fileExtension = ''

export const getParser = async (
  filePath: string
): Promise<Parser | undefined> => {
  const newFileExtension = path.extname(filePath).slice(1)
  const language = WASM_LANGAUAGES[newFileExtension]

  if (newFileExtension === fileExtension && parser) return parser

  fileExtension = newFileExtension

  await Parser.init()

  parser = new Parser()

  logger.log(`Using parser for ${language}`)

  if (!language) return undefined

  const wasmPath = path.join(
    __dirname,
    'tree-sitter-wasms',
    `tree-sitter-${language}.wasm`
  )
  const parserLanguage = await Parser.Language.load(wasmPath)
  parser.setLanguage(parserLanguage)

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
