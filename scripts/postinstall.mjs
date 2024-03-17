import ncp from 'ncp'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

await new Promise((resolve, reject) => {
  ncp(
    path.join(__dirname, '../node_modules/tree-sitter-wasms/out'),
    path.join(__dirname, '../out/tree-sitter-wasms'),
    (error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
  )
})

fs.copyFileSync(
  path.join(__dirname, '../node_modules/web-tree-sitter/tree-sitter.wasm'),
  path.join(__dirname, '../out/tree-sitter.wasm')
)
