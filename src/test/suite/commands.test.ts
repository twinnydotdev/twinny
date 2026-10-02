import * as assert from "assert"
import * as vscode from "vscode"

/**
 * Every command the manifest contributes must be registered once the
 * extension is active. One that is not still shows in the command palette
 * and fails with "command not found" (twinny.templates did until 4.3.5).
 */
suite("Commands", () => {
  test("every contributed command is registered", async function () {
    this.timeout(30_000)
    const extension = vscode.extensions.getExtension("rjmacarthy.twinny")
    assert.ok(extension, "the extension under test is loaded")
    await extension.activate()

    const contributed: { command: string }[] = extension.packageJSON.contributes.commands
    const registered = new Set(await vscode.commands.getCommands(true))
    const missing = contributed.map(({ command }) => command).filter((id) => !registered.has(id))
    assert.deepStrictEqual(missing, [])
  })
})
