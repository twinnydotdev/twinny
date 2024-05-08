import ncp from 'ncp'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import os from 'os'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const outDir = path.join(__dirname, '../out')
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


async function downloadAndInstallLanceDB() {
  const platform = os.platform()
  const arch = os.arch()
  let binaryName

  if (platform === 'linux' && arch === 'x64') {
    binaryName = '@lancedb/vectordb-linux-x64-gnu'
  } else if (platform === 'darwin' && arch === 'arm64') {
    binaryName = '@lancedb/vectordb-darwin-arm64'
  }

  if (binaryName) {
    execSync(`npm install ${binaryName}`, { stdio: 'inherit' })
    // shameful hack
    execSync(`cd ${outDir} && npm i vectordb`)
  }

  const target = path.join(__dirname, `../out/node_modules/${binaryName}`)
  fs.mkdirSync(target, { recursive: true })

  await new Promise((resolve, reject) => {
    ncp(
      path.join(__dirname, `../node_modules/${binaryName}`),
      target,
      (error) => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }
    )
  })
}

downloadAndInstallLanceDB()
