import * as assert from "assert"

import {
  describeProviderError,
  describeProviderErrorPlain,
  isAbortError,
  stripThinking
} from "../../extension/provider-errors"

const provider = {
  label: "Local Ollama",
  modelName: "codellama:7b-instruct",
  apiHostname: "localhost",
  apiPort: 11434,
  apiProtocol: "http",
  apiPath: "/v1"
}

suite("Provider errors", () => {
  test("explains a refused connection with the provider's address", () => {
    const error = new Error("fetch failed")
    ;(error as Error & { cause: unknown }).cause = {
      code: "ECONNREFUSED",
      message: "connect ECONNREFUSED 127.0.0.1:11434"
    }
    const text = describeProviderError(error, provider)
    assert.ok(text.includes("Could not connect to **Local Ollama**"))
    assert.ok(text.includes("http://localhost:11434/v1"))
    assert.ok(text.includes("ECONNREFUSED"), "keeps the raw error for debugging")
  })

  test("points at the API key for 401s", () => {
    const error = Object.assign(new Error("401 Unauthorized"), { status: 401 })
    assert.ok(describeProviderError(error, provider).includes("API key"))
  })

  test("names the model when the server says it is missing", () => {
    const error = Object.assign(
      new Error("404 model 'codellama:7b-instruct' not found, try pulling it first"),
      { status: 404 }
    )
    const text = describeProviderError(error, provider)
    assert.ok(text.includes("`codellama:7b-instruct`"))
    assert.ok(text.includes("pull"))
  })

  test("suggests the API path for other 404s", () => {
    const error = Object.assign(new Error("404 page not found"), { status: 404 })
    assert.ok(describeProviderError(error, provider).includes("API path"))
  })

  test("falls back to a generic message with the raw text", () => {
    const text = describeProviderError(new Error("weird"), provider)
    assert.ok(text.startsWith("**Local Ollama** returned an error."))
    assert.ok(text.endsWith("`weird`"))
  })

  test("recognises aborts, including nested ones", () => {
    const abort = new Error("aborted")
    abort.name = "AbortError"
    assert.strictEqual(isAbortError(abort), true)
    assert.strictEqual(isAbortError({ cause: abort }), true)
    assert.strictEqual(isAbortError(new Error("boom")), false)
    assert.strictEqual(isAbortError(undefined), false)
  })

  test("plain variant has no markdown", () => {
    const text = describeProviderErrorPlain(new Error("fetch failed"), provider)
    assert.ok(!text.includes("**") && !text.includes("`"))
    assert.ok(text.includes("Local Ollama"))
  })

  test("strips reasoning blocks, closed or not", () => {
    assert.strictEqual(
      stripThinking("<think>\nhmm\n</think>\nFix the bug"),
      "Fix the bug"
    )
    assert.strictEqual(stripThinking("<think>never closed"), "")
    assert.strictEqual(stripThinking("plain"), "plain")
  })
})
