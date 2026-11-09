import * as assert from "assert"
import * as vscode from "vscode"

import { FileInteractionCache } from "../../extension/completion/file-interaction"
import { CompletionProvider } from "../../extension/completion/provider"
import { GenerationTracker } from "../../extension/generations"
import { TemplateProvider } from "../../extension/templates/provider"

suite("Completion lifecycle", () => {
  for (const stop of ["explicit abort", "new disabled invocation"]) {
    test(`${stop} invalidates a request still waiting for debounce`, async () => {
      const context = { globalState: { get: () => ({ id: "test", modelName: "test" }) } } as unknown as vscode.ExtensionContext
      const provider = new CompletionProvider(
        new GenerationTracker(),
        new FileInteractionCache(),
        {} as TemplateProvider,
        context
      )
      let enabled = true
      let requests = 0
      Object.assign(provider, {
        config: {
          get(key: string, fallback: unknown) {
            if (key === "enabled") return enabled
            if (key === "autoSuggestEnabled") return true
            if (key === "debounceWait") return 20
            return fallback
          }
        },
        // Observe dispatch without ever calling a model, even on regression.
        async complete() { requests++; return undefined }
      })
      const document = await vscode.workspace.openTextDocument({ content: "const value = " })
      const source = new vscode.CancellationTokenSource()
      const invoke = () => provider.provideInlineCompletionItems(
        document, new vscode.Position(0, 14),
        { triggerKind: vscode.InlineCompletionTriggerKind.Automatic, selectedCompletionInfo: undefined },
        source.token
      )
      try {
        const pending = invoke()
        if (stop === "explicit abort") provider.abortCompletion()
        else { enabled = false; await invoke() }
        await pending
        assert.strictEqual(requests, 0)
      } finally {
        source.dispose()
        provider.dispose()
      }
    })
  }

  test("a log line in the Output panel does not stop the request in flight (#559)", async () => {
    const context = { globalState: { get: () => ({ id: "test", modelName: "test" }) } } as unknown as vscode.ExtensionContext
    const provider = new CompletionProvider(
      new GenerationTracker(),
      new FileInteractionCache(),
      {} as TemplateProvider,
      context
    )
    let requests = 0
    Object.assign(provider, {
      config: {
        get(key: string, fallback: unknown) {
          if (key === "enabled" || key === "autoSuggestEnabled") return true
          if (key === "debounceWait") return 20
          return fallback
        }
      },
      async complete() { requests++; return undefined }
    })
    const document = await vscode.workspace.openTextDocument({ content: "const value = " })
    // The Output panel's document, as VS Code hands it over when twinny's log grows.
    const output = { uri: vscode.Uri.parse("output:extension-output-twinny"), languageId: "log" } as vscode.TextDocument
    const source = new vscode.CancellationTokenSource()
    const context0 = { triggerKind: vscode.InlineCompletionTriggerKind.Automatic, selectedCompletionInfo: undefined }
    try {
      const pending = provider.provideInlineCompletionItems(document, new vscode.Position(0, 14), context0, source.token)
      await provider.provideInlineCompletionItems(output, new vscode.Position(0, 0), context0, source.token)
      await pending
      assert.strictEqual(requests, 1)
    } finally {
      source.dispose()
      provider.dispose()
    }
  })
})
