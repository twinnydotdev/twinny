import Parser, { SyntaxNode } from 'web-tree-sitter'
import { transform } from '@babel/core'
import { WASM_LANGAUAGES } from '../common/constants'
import path from 'path'
import { Logger } from '../common/logger'
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

export const getNodeContainsSyntaxError = (node: SyntaxNode): boolean => {
  const cursor = node.walk()
  do {
    if (cursor.nodeType === 'ERROR' || cursor.currentNode.hasError) {
      return true
    }
  } while (cursor.gotoFirstChild() || cursor.gotoNextSibling())
  return false
}

export const validateJSX = (jsxString: string) => {
  try {
    transform(`<>${jsxString}</>`, {
      presets: [
        require('@babel/preset-react'),
        require('@babel/preset-typescript')
      ]
    })
    return true
  } catch (error) {
    console.error(error)
    return false
  }
}
