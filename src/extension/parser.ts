import Parser, { SyntaxNode } from 'web-tree-sitter'
import { WASM_LANGUAGES } from '../common/constants'
import path from 'path'
import { Position } from 'vscode'

const parserCache: { [language: string]: Parser } = {}

let isInitialized = false

export const getParser = async (
  filePath: string
): Promise<Parser | undefined> => {
  try {
    if (!isInitialized) {
      await Parser.init()
      isInitialized = true
    }

    const fileExtension = path.extname(filePath).slice(1)
    const language = WASM_LANGUAGES[fileExtension]

    if (!language) return undefined

    if (parserCache[language]) {
      return parserCache[language]
    }

    const parser = new Parser()
    const wasmPath = path.join(
      __dirname,
      'tree-sitter-wasms',
      `tree-sitter-${language}.wasm`
    )
    const parserLanguage = await Parser.Language.load(wasmPath)
    parser.setLanguage(parserLanguage)

    parserCache[language] = parser
    return parser
  } catch (e) {
    console.error('Error in getParser:', e)
    throw e
  }
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
