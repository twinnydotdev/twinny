import * as assert from "assert"
import * as vscode from "vscode"

import { API_PROVIDERS } from "../../common/constants"
import { RequestOptionsOllama, StreamResponse } from "../../common/types"
import { createStreamRequestBodyFim } from "../../extension/completion/request-body"
import {
  getFimDataFromProvider,
  getIsMiddleOfWord,
  getPrefixSuffix,
  getShouldUseMultiline,
  safeParseJsonResponse,
  trimToLineBoundary
} from "../../extension/utils"

const openDocument = (content: string, language = "typescript") =>
  vscode.workspace.openTextDocument({ content, language })

const endOfLine = (document: vscode.TextDocument, line: number) =>
  document.lineAt(line).range.end

suite("FIM utilities", () => {
  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors")
  })

  suite("safeParseJsonResponse", () => {
    test("parses plain JSON lines", () => {
      assert.deepStrictEqual(safeParseJsonResponse("{\"response\":\"x\"}"), {
        response: "x"
      })
    })

    test("strips the SSE data prefix without truncating the payload", () => {
      const line = "data: {\"choices\":[{\"text\":\"const data: string\"}]}"
      const parsed = safeParseJsonResponse(line)
      assert.strictEqual(parsed?.choices[0].text, "const data: string")
    })

    test("ignores [DONE], blanks and malformed lines", () => {
      assert.strictEqual(safeParseJsonResponse("data: [DONE]"), undefined)
      assert.strictEqual(safeParseJsonResponse(""), undefined)
      assert.strictEqual(safeParseJsonResponse(": keep-alive"), undefined)
      assert.strictEqual(safeParseJsonResponse("data: {oops"), undefined)
    })
  })

  suite("getFimDataFromProvider", () => {
    const chunk = (partial: Partial<StreamResponse>) =>
      partial as StreamResponse

    test("reads each provider's native field", () => {
      assert.strictEqual(
        getFimDataFromProvider(API_PROVIDERS.Ollama, chunk({ response: "a" })),
        "a"
      )
      assert.strictEqual(
        getFimDataFromProvider(API_PROVIDERS.LlamaCpp, chunk({ content: "b" })),
        "b"
      )
      assert.strictEqual(
        getFimDataFromProvider(
          API_PROVIDERS.LMStudio,
          chunk({ choices: [{ text: "c" }] } as Partial<StreamResponse>)
        ),
        "c"
      )
      assert.strictEqual(
        getFimDataFromProvider(
          API_PROVIDERS.LiteLLM,
          chunk({ choices: [{ delta: { content: "d" } }] } as Partial<StreamResponse>)
        ),
        "d"
      )
    })

    test("falls back to any known shape when the provider type is off", () => {
      assert.strictEqual(
        getFimDataFromProvider(
          API_PROVIDERS.Ollama,
          chunk({ choices: [{ text: "c" }] } as Partial<StreamResponse>)
        ),
        "c"
      )
      assert.strictEqual(
        getFimDataFromProvider(API_PROVIDERS.OpenAI, chunk({ response: "a" })),
        "a"
      )
    })

    test("returns undefined for chunks without text", () => {
      assert.strictEqual(getFimDataFromProvider(API_PROVIDERS.Ollama, undefined), undefined)
      assert.strictEqual(
        getFimDataFromProvider(API_PROVIDERS.OpenAI, chunk({ choices: [] as never })),
        undefined
      )
      assert.strictEqual(
        getFimDataFromProvider(API_PROVIDERS.Ollama, chunk({ done: true })),
        undefined
      )
    })
  })

  suite("createStreamRequestBodyFim", () => {
    const options = {
      model: "m",
      numPredictFim: 128,
      temperature: 0.1,
      keepAlive: "5m",
      stop: ["<a>", "<b>", "<c>", "<d>", "<e>"]
    }

    test("sends stop sequences to Ollama inside options", () => {
      const body = createStreamRequestBodyFim(API_PROVIDERS.Ollama, "p", options)
      assert.deepStrictEqual(body, {
        model: "m",
        prompt: "p",
        stream: true,
        keep_alive: "5m",
        options: { temperature: 0.1, num_predict: 128, stop: options.stop }
      })
    })

    test("caps stop sequences for hosted OpenAI-style APIs", () => {
      const body = createStreamRequestBodyFim(API_PROVIDERS.OpenRouter, "p", options)
      assert.deepStrictEqual(body.stop, ["<a>", "<b>", "<c>", "<d>"])
      const local = createStreamRequestBodyFim(API_PROVIDERS.LMStudio, "p", options)
      assert.deepStrictEqual(local.stop, options.stop)
    })

    test("omits max_tokens for OpenAI-style APIs when unlimited", () => {
      const body = createStreamRequestBodyFim(API_PROVIDERS.LMStudio, "p", {
        ...options,
        numPredictFim: -1
      })
      assert.strictEqual("max_tokens" in body && body.max_tokens, undefined)
      const ollama = createStreamRequestBodyFim(API_PROVIDERS.Ollama, "p", {
        ...options,
        numPredictFim: -1
      })
      assert.strictEqual(
        (ollama as RequestOptionsOllama).options.num_predict,
        -1
      )
    })
  })

  suite("getIsMiddleOfWord", () => {
    test("is true only between two word characters", async () => {
      const document = await openDocument("foo bar")
      assert.strictEqual(getIsMiddleOfWord(document, new vscode.Position(0, 1)), true)
      assert.strictEqual(getIsMiddleOfWord(document, new vscode.Position(0, 3)), false)
      assert.strictEqual(getIsMiddleOfWord(document, new vscode.Position(0, 4)), false)
      assert.strictEqual(getIsMiddleOfWord(document, new vscode.Position(0, 7)), false)
      assert.strictEqual(getIsMiddleOfWord(document, new vscode.Position(0, 0)), false)
    })
  })

  suite("getShouldUseMultiline", () => {
    const decide = (
      document: vscode.TextDocument,
      position: vscode.Position,
      multilineEnabled = true
    ) => getShouldUseMultiline({ document, position, node: null, multilineEnabled })

    test("is false when multiline is disabled", async () => {
      const document = await openDocument("function foo() {\n")
      assert.strictEqual(decide(document, endOfLine(document, 0), false), false)
    })

    test("is true on a blank line", async () => {
      const document = await openDocument("function foo() {\n  \n}")
      assert.strictEqual(decide(document, endOfLine(document, 1)), true)
    })

    test("is true after a block opener", async () => {
      const document = await openDocument("function foo() {\nconst x = [\nconst y =\nif (x):")
      for (let line = 0; line < document.lineCount; line++) {
        assert.strictEqual(decide(document, endOfLine(document, line)), true, `line ${line}`)
      }
    })

    test("is false at the end of a complete statement", async () => {
      const document = await openDocument("const x = foo.bar")
      assert.strictEqual(decide(document, endOfLine(document, 0)), false)
    })

    test("is false when there is code after the cursor", async () => {
      const document = await openDocument("foo(| bar)")
      assert.strictEqual(decide(document, new vscode.Position(0, 4)), false)
    })

    test("is false inside strings and comments", async () => {
      const document = await openDocument("const s = `")
      const node = { type: "template_string" } as never
      assert.strictEqual(
        getShouldUseMultiline({
          document,
          position: endOfLine(document, 0),
          node,
          multilineEnabled: true
        }),
        false
      )
    })
  })

  suite("trimToLineBoundary", () => {
    test("keeps short text as is", () => {
      assert.strictEqual(trimToLineBoundary("a\nb", 100, "start"), "a\nb")
    })

    test("drops leading lines to fit the budget", () => {
      assert.strictEqual(trimToLineBoundary("aaaa\nbbbb\ncccc", 9, "start"), "cccc")
      assert.strictEqual(trimToLineBoundary("aaaa\nbbbb\ncccc", 10, "start"), "bbbb\ncccc")
    })

    test("drops trailing lines to fit the budget", () => {
      assert.strictEqual(trimToLineBoundary("aaaa\nbbbb\ncccc", 9, "end"), "aaaa\n")
      assert.strictEqual(trimToLineBoundary("aaaa\nbbbb\ncccc", 10, "end"), "aaaa\nbbbb\n")
    })

    test("falls back to a hard cut on a single long line", () => {
      assert.strictEqual(trimToLineBoundary("abcdefgh", 3, "start"), "fgh")
      assert.strictEqual(trimToLineBoundary("abcdefgh", 3, "end"), "abc")
    })
  })

  suite("getPrefixSuffix", () => {
    test("splits the document around the cursor", async () => {
      const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`)
      const document = await openDocument(lines.join("\n"))
      const position = new vscode.Position(20, 4)
      const { prefix, suffix } = getPrefixSuffix(10, document, position)
      assert.ok(prefix.endsWith("line 19\nline"))
      assert.ok(suffix.startsWith(" 20\nline 21"))
      assert.strictEqual(prefix.split("\n").length, 9)
      assert.strictEqual(suffix.split("\n").length, 3)
    })

    test("gives the spare lines to the other side near the document edges", async () => {
      const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`)
      const document = await openDocument(lines.join("\n"))
      const top = getPrefixSuffix(10, document, new vscode.Position(1, 0))
      assert.strictEqual(top.prefix, "line 0\n")
      assert.strictEqual(top.suffix.split("\n").length, 10)
    })
  })
})
