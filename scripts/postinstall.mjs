import ncp from 'ncp'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import os from 'os'
import { rimrafSync } from 'rimraf'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const outDir = path.join(__dirname, '../out')

rimrafSync(outDir)
fs.mkdirSync(outDir, { recursive: true })

async function installLanceDb() {
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
    execSync(`cd ${outDir} && npm i vectordb`) // shameful hack
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

installLanceDb()

