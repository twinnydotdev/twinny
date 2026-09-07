/**
 * End-to-end check of the real CompletionProvider against a local Ollama.
 * Skipped unless TWINNY_LIVE=1 so CI and offline runs are unaffected.
 */
import * as assert from "assert"
import * as vscode from "vscode"

import { ACTIVE_FIM_PROVIDER_STORAGE_KEY } from "../../common/constants"
import { FileInteractionCache } from "../../extension/completion/file-interaction"
import { CompletionProvider } from "../../extension/completion/provider"
import { TwinnyStatusBar } from "../../extension/status-bar"
import { TemplateProvider } from "../../extension/templates/provider"

const LIVE = process.env.TWINNY_LIVE === "1"

const fimProvider = {
  apiHostname: "localhost",
  apiPort: 11434,
  apiProtocol: "http",
  apiPath: "/api/generate",
  fimTemplate: "automatic",
  label: "Ollama FIM",
  id: "live",
  modelName: process.env.TWINNY_LIVE_MODEL || "codellama:7b-code",
  provider: "ollama",
  type: "fim"
}

const fakeContext = {
  globalState: {
    get: (key: string) =>
      key === ACTIVE_FIM_PROVIDER_STORAGE_KEY ? fimProvider : undefined,
    update: async () => undefined
  },
  subscriptions: []
} as unknown as vscode.ExtensionContext

suite("Live completion provider", function () {
  this.timeout(60000)

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors")
  })

  const complete = async (
    content: string,
    position: vscode.Position,
    language = "javascript"
  ) => {
    const document = await vscode.workspace.openTextDocument({
      content,
      language
    })
    const editor = await vscode.window.showTextDocument(document)
    editor.selection = new vscode.Selection(position, position)
    const statusBar = new TwinnyStatusBar(
      vscode.window.createStatusBarItem(),
      fakeContext
    )
    const provider = new CompletionProvider(
      statusBar,
      new FileInteractionCache(),
      new TemplateProvider(undefined),
      fakeContext
    )
    const source = new vscode.CancellationTokenSource()
    const items = await provider.provideInlineCompletionItems(
      document,
      position,
      { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined },
      source.token
    )
    const text = items?.[0]?.insertText
    return typeof text === "string" ? text : text?.value ?? ""
  }

  test("completes a function body", async function () {
    if (!LIVE) this.skip()
    const text = await complete(
      "function add(a, b) {\n}\n",
      new vscode.Position(0, "function add(a, b) {".length)
    )
    console.log("[live] function body ->", JSON.stringify(text))
    assert.ok(text.includes("a + b"), text)
  })

  test("completes inside empty quotes", async function () {
    if (!LIVE) this.skip()
    const content =
      "// copies the right .env file for the environment\n" +
      "const { copyFileSync } = require('fs')\n" +
      "const environment = process.env.CI_ENVIRONMENT_NAME || ''\n" +
      "copyFileSync(`.env.${environment}`, '.env')\n"
    const text = await complete(content, new vscode.Position(2, 56))
    console.log("[live] empty quotes ->", JSON.stringify(text))
    assert.ok(text.length > 0 && !text.includes("\n"), text)
  })

  test("completes inside a string with code after the cursor", async function () {
    if (!LIVE) this.skip()
    const text = await complete(
      "const name = \"Ada\"\nconsole.log(\"Hello, \")\n",
      new vscode.Position(1, "console.log(\"Hello, ".length)
    )
    console.log("[live] mid string ->", JSON.stringify(text))
    assert.ok(!text.includes("\n"), text)
  })

  test("completes at end of file", async function () {
    if (!LIVE) this.skip()
    const text = await complete(
      "// Returns true when n is prime\n",
      new vscode.Position(1, 0)
    )
    console.log("[live] end of file ->", JSON.stringify(text))
    assert.ok(text.includes("function"), text)
  })
})
