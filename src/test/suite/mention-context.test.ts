import * as assert from "assert"

import { formatGitSnapshot } from "../../extension/chat/git-context"
import { cleanMessageHtml } from "../../extension/chat/messages"
import {
  decodeSymbolRef,
  encodeSymbolRef,
  isSymbolRef
} from "../../extension/chat/symbol-ref"

suite("@git context", () => {
  test("shows branch, status and a fenced diff", () => {
    const text = formatGitSnapshot({
      branch: "main",
      status: " M src/a.ts\n?? new.ts\n",
      diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n"
    })
    assert.ok(text.startsWith("Git branch: main"))
    assert.ok(text.includes("Changed files:\n```\n M src/a.ts\n?? new.ts\n```"))
    assert.ok(text.includes("```diff\ndiff --git"))
  })

  test("says so when the tree is clean and cuts a long diff", () => {
    const clean = formatGitSnapshot({ branch: "main", status: "", diff: "" })
    assert.ok(clean.includes("working tree clean"))
    assert.ok(!clean.includes("```diff"))

    const long = formatGitSnapshot(
      {
        branch: "x",
        status: "M a",
        diff: "diff --git a/a b/a\n" + "+line\n".repeat(500)
      },
      400
    )
    assert.ok(long.includes("[diff truncated:"))
  })
})

suite("@symbol references", () => {
  test("round-trips path, line and name, including odd names", () => {
    const ref = { path: "src/a b/c.ts", line: 41, name: "Foo::bar<T>" }
    const id = encodeSymbolRef(ref)
    assert.ok(isSymbolRef(id))
    assert.deepStrictEqual(decodeSymbolRef(id), ref)
    assert.strictEqual(decodeSymbolRef("src/a.ts"), undefined)
    assert.ok(!isSymbolRef("/src/a.ts"))
  })
})

suite("Mention text clean-up", () => {
  test("drops every source mention from the text the model sees", () => {
    const html =
      "<p>why does <span data-type=\"mention\" data-id=\"git\">@git</span> " +
      "and <span data-type=\"mention\" data-id=\"terminal\">@terminal</span> " +
      "show <span data-type=\"mention\" data-id=\"/src/a.ts\">@a.ts</span> failing?</p>"
    const text = cleanMessageHtml(html)
    assert.ok(!text.includes("@git"))
    assert.ok(!text.includes("@terminal"))
    assert.ok(text.includes("@a.ts"))
  })
})
