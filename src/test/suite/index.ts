import { globSync } from "glob"
import Mocha from "mocha"
import path from "path"

export function run(): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const mocha = new Mocha({ ui: "tdd" })
      const testsRoot = path.resolve(__dirname, "..")

      // Mocha runs the compiled tests
      const files = globSync("**/*.test.js", { cwd: testsRoot })

      files.forEach((file) => mocha.addFile(path.resolve(testsRoot, file)))

      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} tests failed.`))
        } else {
          resolve()
        }
      })
    } catch (err) {
      console.error(err)
      reject(err)
    }
  })
}
