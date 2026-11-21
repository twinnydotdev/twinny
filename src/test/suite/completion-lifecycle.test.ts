import * as assert from "assert"
import * as http from "http"
import { AddressInfo } from "net"
import * as vscode from "vscode"

import { ACTIVE_FIM_PROVIDER_STORAGE_KEY, API_PROVIDERS } from "../../common/constants"
import { FileInteractionCache } from "../../extension/completion/file-interaction"
import { CompletionProvider, SuggestionLines } from "../../extension/completion/provider"
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

  /** An Ollama that answers each `/api/generate` in turn and keeps the prompts it was sent. */
  const fakeOllama = (replies: string[]) =>
    new Promise<{ port: number; prompts: string[]; close(): Promise<void> }>((resolve) => {
      const prompts: string[] = []
      const server = http.createServer((request, response) => {
        let text = ""
        request.on("data", (chunk) => (text += chunk))
        request.on("end", () => {
          prompts.push(String(JSON.parse(text).prompt))
          response.writeHead(200, { "Content-Type": "application/x-ndjson" })
          response.write(`${JSON.stringify({ response: replies[prompts.length - 1] ?? "", done: false })}\n`)
          response.end(`${JSON.stringify({ response: "", done: true })}\n`)
        })
      })
      server.listen(0, "127.0.0.1", () =>
        resolve({
          port: (server.address() as AddressInfo).port,
          prompts,
          close: () =>
            new Promise((done) => {
              (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
              server.close(() => done())
            })
        })
      )
    })

  /** What an inline completion item inserts, as plain text. */
  const textOf = (items: vscode.InlineCompletionItem[] | undefined) => {
    const text = items?.[0]?.insertText
    return typeof text === "string" ? text : text?.value ?? ""
  }

  const setUp = async (
    replies: string[],
    provider: string = API_PROVIDERS.Ollama,
    content = "const total = sum(items)\n\nexport {}\n"
  ) => {
    const server = await fakeOllama(replies)
    const config = {
      id: "fake", label: "Fake", modelName: "codellama:7b-code", provider, type: "fim",
      apiHostname: "127.0.0.1", apiPort: server.port, apiProtocol: "http", apiPath: "/api/generate"
    }
    const context = {
      globalState: { get: (key: string) => (key === ACTIVE_FIM_PROVIDER_STORAGE_KEY ? config : undefined) }
    } as unknown as vscode.ExtensionContext
    const completions = new CompletionProvider(
      new GenerationTracker(), new FileInteractionCache(), new TemplateProvider(undefined), context
    )
    const document = await vscode.workspace.openTextDocument({ content, language: "javascript" })
    const editor = await vscode.window.showTextDocument(document)
    const source = new vscode.CancellationTokenSource()
    const ask = async (position: vscode.Position) => {
      editor.selection = new vscode.Selection(position, position)
      return textOf(await completions.provideInlineCompletionItems(
        document, position,
        { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined },
        source.token
      ))
    }
    const type = async (position: vscode.Position, text: string) => {
      await editor.edit((edit) => edit.insert(position, text))
      const end = document.positionAt(document.offsetAt(position) + text.length)
      editor.selection = new vscode.Selection(end, end)
      return end
    }
    const pending = () => (completions as unknown as { _prefetch?: { result: Promise<string> } })._prefetch
    const tearDown = async () => {
      source.dispose()
      completions.dispose()
      await server.close()
      await vscode.commands.executeCommand("workbench.action.closeAllEditors")
    }
    return { server, completions, editor, ask, type, pending, tearDown }
  }

  suite("prefetch", () => {
    test("accepting a suggestion and pressing Enter shows the next one without another request", async () => {
      const { server, completions, ask, type, pending, tearDown } = await setUp([
        "const mean = total / items.length",
        "console.log(mean)"
      ])
      try {
        const first = await ask(new vscode.Position(1, 0))
        assert.strictEqual(first, "const mean = total / items.length")
        assert.ok(pending(), "the line after it is asked for at once")

        // Accepted: the cursor moves, which is what stops a request in flight.
        const accepted = await type(new vscode.Position(1, 0), first)
        completions.abortCompletion()
        assert.ok(pending(), "accepting keeps the prefetch")
        const next = await type(accepted, "\n")
        completions.abortCompletion()

        assert.strictEqual(await ask(next), "console.log(mean)")
        assert.strictEqual(server.prompts.length, 2, "nothing was asked for a second time")
        assert.ok(
          server.prompts[1].includes("const mean = total / items.length\n"),
          "the prefetch was made as if the suggestion were in the file"
        )
        assert.ok(!server.prompts[0].includes("const mean"))
      } finally {
        await tearDown()
      }
    })

    test("going somewhere else lets go of it", async () => {
      const { completions, ask, type, pending, tearDown } = await setUp(["const mean = total / items.length", "x"])
      try {
        await ask(new vscode.Position(1, 0))
        assert.ok(pending())
        await type(new vscode.Position(1, 0), "let other")
        completions.abortCompletion()
        assert.strictEqual(pending(), undefined)
      } finally {
        await tearDown()
      }
    })

    test("a hosted API is never asked ahead of time", async () => {
      const { server, ask, pending, tearDown } = await setUp(
        ["const mean = total / items.length", "x"],
        API_PROVIDERS.OpenRouter
      )
      try {
        await ask(new vscode.Position(1, 0))
        assert.strictEqual(pending(), undefined)
        assert.strictEqual(server.prompts.length, 1)
      } finally {
        await tearDown()
      }
    })
  })

  suite("one line or several, asked for by command (#201)", () => {
    /**
     * Runs the command the way a keyboard shortcut does, with the provider
     * registered so the editor itself asks it, and returns what it showed.
     */
    const suggest = async (
      completions: CompletionProvider,
      editor: vscode.TextEditor,
      position: vscode.Position,
      lines: SuggestionLines
    ) => {
      editor.selection = new vscode.Selection(position, position)
      let shown: (text: string) => void = () => undefined
      const result = new Promise<string>((resolve) => (shown = resolve))
      const registration = vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, {
        async provideInlineCompletionItems(document, at, context, token) {
          const items = await completions.provideInlineCompletionItems(document, at, context, token)
          if (context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke) shown(textOf(items))
          return items
        }
      })
      try {
        await completions.suggest(lines)
        return await result
      } finally {
        registration.dispose()
        await vscode.commands.executeCommand("editor.action.inlineSuggest.hide")
      }
    }

    test("Suggest several lines shows a block where the settings show one line", async () => {
      const reply = ".filter(Boolean)\n  .length"
      const { completions, editor, ask, tearDown } = await setUp(
        // Each suggestion shown also has the line after it asked for.
        Array(8).fill(reply),
        API_PROVIDERS.Ollama,
        "const total = items\nconst count = items\n"
      )
      try {
        const end = new vscode.Position(0, 19)
        assert.strictEqual(await ask(end), ".filter(Boolean)")
        // The line on screen would be served again as typed-through text;
        // the block shows only when the model is asked afresh.
        assert.strictEqual(await suggest(completions, editor, end, "multi"), reply)

        assert.strictEqual(
          await ask(new vscode.Position(1, 19)),
          ".filter(Boolean)",
          "the next suggestion is the settings' length again"
        )
      } finally {
        await tearDown()
      }
    })

    test("Suggest one line stops at the end of the line where the settings show a block", async () => {
      const reply = "const total = sum(items)\n  return total / items.length"
      const { completions, editor, ask, tearDown } = await setUp(
        // Each suggestion shown also has the line after it asked for.
        Array(8).fill(reply),
        API_PROVIDERS.Ollama,
        "function mean(items) {\n  \n}\n"
      )
      try {
        const indented = new vscode.Position(1, 2)
        assert.strictEqual(await ask(indented), reply)
        assert.strictEqual(await suggest(completions, editor, indented, "single"), "const total = sum(items)")
      } finally {
        await tearDown()
      }
    })

    test("the other length can be asked for while a suggestion is showing", async function () {
      this.timeout(10000)
      const reply = ".filter(Boolean)\n  .length"
      const { completions, editor, tearDown } = await setUp(
        Array(8).fill(reply),
        API_PROVIDERS.Ollama,
        "const total = items\nconst count = items\n"
      )
      const shown: string[] = []
      let arrived: () => void = () => undefined
      const registration = vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, {
        async provideInlineCompletionItems(document, at, context, token) {
          const items = await completions.provideInlineCompletionItems(document, at, context, token)
          if (context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke) {
            shown.push(textOf(items))
            arrived()
          }
          return items
        }
      })
      const next = () => Promise.race([
        new Promise<void>((resolve) => (arrived = resolve)),
        new Promise<void>((resolve) => setTimeout(resolve, 2500))
      ])
      try {
        editor.selection = new vscode.Selection(0, 19, 0, 19)
        let waiting = next()
        await completions.suggest("single")
        await waiting
        waiting = next()
        await completions.suggest("multi")
        await waiting
        assert.deepStrictEqual(shown, [".filter(Boolean)", reply])
      } finally {
        registration.dispose()
        await vscode.commands.executeCommand("editor.action.inlineSuggest.hide")
        await tearDown()
      }
    })

    test("the asked length is for the request it sets off, at the place it was asked", async () => {
      const reply = ".filter(Boolean)\n  .length"
      const { completions, editor, ask, tearDown } = await setUp(
        // Each suggestion shown also has the line after it asked for.
        Array(8).fill(reply),
        API_PROVIDERS.Ollama,
        "const total = items\nconst count = items\n"
      )
      try {
        // Asked for on the first line. This provider is not registered
        // with the editor, so the command's own request never reaches it
        // and the first one it sees is made on the second line.
        editor.selection = new vscode.Selection(0, 19, 0, 19)
        await completions.suggest("multi")
        assert.strictEqual(await ask(new vscode.Position(1, 19)), ".filter(Boolean)")
        assert.strictEqual(await ask(new vscode.Position(0, 19)), ".filter(Boolean)", "it was let go")
      } finally {
        await tearDown()
      }
    })
  })
})
