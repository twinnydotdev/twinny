/** The one line the extension, the webview and the gateway show for what was thrown. */
import * as assert from "assert"

import { messageOf } from "../../common/errors"

suite("messageOf", () => {
  test("an Error's message; anything else as text", () => {
    assert.strictEqual(messageOf(new Error("boom")), "boom")
    assert.strictEqual(messageOf(new TypeError("typed")), "typed")
    assert.strictEqual(messageOf("plain"), "plain")
    assert.strictEqual(messageOf(42), "42")
    assert.strictEqual(messageOf(undefined), "undefined")
    assert.strictEqual(messageOf(null), "null")
    assert.strictEqual(messageOf({ message: "not an Error" }), "[object Object]")
  })
})
