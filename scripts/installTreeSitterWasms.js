/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-var-requires */
const ncp = require('ncp').ncp
const path = require('path')

async function copyWasms() {
  await new Promise((resolve, reject) => {
    ncp(
      path.join(__dirname, '../node_modules/tree-sitter-wasms/out'),
      path.join(__dirname, '../out/tree-sitter-wasms'),
      (err) => {
        if (err) {
          console.error('Error copying tree-sitter-wasms')
          reject(err)
        }
        resolve()
      }
    )
  })
  await new Promise((resolve, reject) => {
    ncp(
      path.join(__dirname, '../node_modules/web-tree-sitter/tree-sitter.wasm'),
      path.join(__dirname, '../out/tree-sitter.wasm'),
      (err) => {
        if (err) {
          console.error('Error copying tree-sitter.wasm')
          reject(err)
        }
        resolve()
      }
    )
  })
  console.log('Copied wasms to out directory')
}

copyWasms()
