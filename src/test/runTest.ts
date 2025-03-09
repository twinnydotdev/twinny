import * as cp from "child_process"
import * as path from "path"

async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, "../../")
    const extensionTestsPath = path.resolve(__dirname, "./suite/index")

    // Use the VSCode CLI test runner
    const cliPath = path.resolve(extensionDevelopmentPath, "node_modules", ".bin", "vscode-test")

    const args = [
      "--extensionDevelopmentPath=" + extensionDevelopmentPath,
      "--extensionTestsPath=" + extensionTestsPath,
      "--disable-extensions"
    ]

    console.log(`Running tests with command: ${cliPath} ${args.join(" ")}`)

    const proc = cp.spawn(cliPath, args, {
      stdio: "inherit"
    })

    proc.on("exit", (code) => {
      if (code !== 0) {
        console.error(`Tests failed with exit code ${code}`)
        process.exit(code || 1)
      }
      process.exit(0)
    })
  } catch (err) {
    console.error(err)
    console.error("Failed to run tests")
    process.exit(1)
  }
}

main()
