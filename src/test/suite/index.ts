import path from 'path'
import Mocha from 'mocha'
import { globSync } from 'glob'

export function run() {
  try {
    const mocha = new Mocha({ ui: 'tdd' })
    const testsRoot = path.resolve(__dirname, '..')
    const files = globSync('**/**.test.js', { cwd: testsRoot })
    files.forEach((file) => mocha.addFile(path.resolve(testsRoot, file)))
    mocha.run()
  } catch (err) {
    console.error(err)
  }
}
