import * as assert from "assert"
import * as vscode from "vscode"

import { FIM_TEMPLATE_FORMAT } from "../../common/constants"
import { getFimPrompt, getFimTemplateRepositoryLevel } from "../../extension/completion/fim-templates"
import { formatLspSuggestions, LspContext } from "../../extension/completion/lsp-context"

suite("FIM IntelliSense context", () => {
  test("filters by typed prefix, respects ranking, retains types and deduplicates", () => {
    const first = new vscode.CompletionItem({ label: "getName", detail: "(): string" }, vscode.CompletionItemKind.Method)
    first.sortText = "0"
    const second = new vscode.CompletionItem("getAge", vscode.CompletionItemKind.Method)
    second.detail = "(): number\nAge in years"
    second.sortText = "1"
    const result = formatLspSuggestions([
      second, first, first,
      new vscode.CompletionItem("setName", vscode.CompletionItemKind.Method),
      new vscode.CompletionItem("getSnippet", vscode.CompletionItemKind.Snippet)
    ], "ge")
    assert.ok(result.includes("getName | (): string"))
    assert.ok(result.includes("getAge | (): number Age in years"))
    assert.ok(result.indexOf("getName") < result.indexOf("getAge"))
    assert.strictEqual(result.split("getName").length, 2)
    assert.ok(!result.includes("setName") && !result.includes("getSnippet"))
    assert.strictEqual(formatLspSuggestions([], ""), "")
  })

  test("bounds both the item count and prompt size", () => {
    const items = Array.from({ length: 100 }, (_, i) => new vscode.CompletionItem(`symbol${i}`))
    assert.strictEqual(formatLspSuggestions(items, "").split("\n").length, 21)
    items.forEach((item) => { item.detail = "x".repeat(10000) })
    assert.ok(formatLspSuggestions(items, "").length <= 2000)
  })

  test("includes suggestions in every built-in FIM dialect and repository prompts", () => {
    const text = formatLspSuggestions([new vscode.CompletionItem("getName")], "")
    const args = {
      contextFiles: [{ name: "IntelliSense context", text }],
      header: "", language: "typescript", fileName: "a.ts", repoName: "repo",
      prefixSuffix: { prefix: "obj.", suffix: "\n}" }
    }
    for (const format of Object.values(FIM_TEMPLATE_FORMAT)) {
      assert.ok(getFimPrompt("qwen", format, args).includes(text))
    }
    assert.ok(getFimTemplateRepositoryLevel(args).includes(text))
  })

  test("queries installed providers at the cursor and uses the typed prefix", async () => {
    const document = await vscode.workspace.openTextDocument({ content: "obj.ge", language: "plaintext" })
    const registration = vscode.languages.registerCompletionItemProvider({ scheme: "untitled", language: "plaintext" }, {
      provideCompletionItems(doc, position) {
        assert.strictEqual(doc.uri.toString(), document.uri.toString())
        assert.strictEqual(position.character, 6)
        return [new vscode.CompletionItem("getName", vscode.CompletionItemKind.Method), new vscode.CompletionItem("setName")]
      }
    })
    const source = new vscode.CancellationTokenSource()
    try {
      const result = await new LspContext().get(document, new vscode.Position(0, 6), source.token)
      assert.ok(result.includes("getName"), result)
      assert.ok(!result.includes("setName"))
    } finally {
      source.dispose()
      registration.dispose()
    }
  })

  test("times out slow providers and avoids overlapping requests", async () => {
    const document = await vscode.workspace.openTextDocument({ content: "obj.", language: "plaintext" })
    let calls = 0
    let release: (items: vscode.CompletionItem[]) => void = () => undefined
    const registration = vscode.languages.registerCompletionItemProvider({ scheme: "untitled", language: "plaintext" }, {
      provideCompletionItems() {
        calls++
        return new Promise<vscode.CompletionItem[]>((resolve) => { release = resolve })
      }
    })
    const source = new vscode.CancellationTokenSource()
    const context = new LspContext()
    try {
      assert.strictEqual(await context.get(document, new vscode.Position(0, 4), source.token), "")
      assert.strictEqual(await context.get(document, new vscode.Position(0, 4), source.token), "")
      assert.strictEqual(calls, 1)
    } finally {
      release([])
      source.dispose()
      registration.dispose()
    }
  })

  test("does not query providers for cancelled requests", async () => {
    const document = await vscode.workspace.openTextDocument({ content: "obj." })
    const source = new vscode.CancellationTokenSource()
    source.cancel()
    try {
      assert.strictEqual(await new LspContext().get(document, new vscode.Position(0, 4), source.token), "")
    } finally {
      source.dispose()
    }
  })
})
