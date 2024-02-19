/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-var-requires */
const { execSync } = require('child_process')
const os = require('os')

function downloadAndInstallLanceDB() {
  const platform = os.platform()
  const arch = os.arch()
  let binaryName

  if (platform === 'linux' && arch === 'x64') {
    binaryName = '@lancedb/vectordb-linux-x64-gnu'
  } else if (platform === 'darwin' && arch === 'arm64') {
    binaryName = '@lancedb/vectordb-darwin-arm64'
  }

  if (binaryName) {
    console.log(`Installing ${binaryName}...`)
    execSync(`npm install ${binaryName}`, { stdio: 'inherit' })
  } else {
    console.error('Unsupported platform or architecture for LanceDB.')
  }
}

downloadAndInstallLanceDB()
