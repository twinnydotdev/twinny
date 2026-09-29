import * as assert from "assert"

import { formatCount, formatMs, redact } from "../../common/logger"

suite("Logger", () => {
  test("keys and bearer tokens never reach the log", () => {
    assert.strictEqual(
      redact("Authorization: Bearer sk-abc.123_xyz done"),
      "Authorization: Bearer *** done"
    )
    assert.strictEqual(
      redact("{\"model\":\"m\",\"apiKey\":\"sk-secret\",\"stream\":true}"),
      "{\"model\":\"m\",\"apiKey\":\"***\",\"stream\":true}"
    )
    assert.strictEqual(redact("api_key=abc123&x=1"), "api_key=***&x=1")
    assert.strictEqual(redact("const token = 12"), "const token = ***")
    assert.strictEqual(redact("nothing secret here"), "nothing secret here")
  })

  test("durations and counts read at a glance", () => {
    assert.strictEqual(formatMs(840), "840ms")
    assert.strictEqual(formatMs(1234), "1.2s")
    assert.strictEqual(formatCount(840), "840")
    assert.strictEqual(formatCount(12345), "12.3k")
  })
})
