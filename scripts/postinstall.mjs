import ncp from 'ncp'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const targetDir = path.join(__dirname, '../out/tree-sitter-wasms')
fs.mkdirSync(targetDir, { recursive: true })

await new Promise((resolve, reject) => {
  ncp(
    path.join(__dirname, '../node_modules/tree-sitter-wasms/out'),
    targetDir,
    (error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
  )
})

const wasmTargetDir = path.join(__dirname, '../out')
fs.mkdirSync(wasmTargetDir, { recursive: true })

fs.copyFileSync(
  path.join(__dirname, '../node_modules/web-tree-sitter/tree-sitter.wasm'),
  path.join(__dirname, '../out/tree-sitter.wasm')
)
