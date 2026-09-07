import * as assert from "assert"

import { parseGitHubRemote } from "../../extension/git"

suite("Git remotes", () => {
  test("parses the URL forms git accepts", () => {
    const expected = { owner: "twinnydotdev", repo: "twinny" }
    for (const url of [
      "https://github.com/twinnydotdev/twinny.git",
      "https://github.com/twinnydotdev/twinny",
      "https://github.com/twinnydotdev/twinny/",
      "git@github.com:twinnydotdev/twinny.git",
      "ssh://git@github.com/twinnydotdev/twinny.git",
      "https://user@github.com/twinnydotdev/twinny.git\n"
    ]) {
      assert.deepStrictEqual(parseGitHubRemote(url), expected, url)
    }
  })

  test("ignores remotes that are not on GitHub", () => {
    assert.strictEqual(parseGitHubRemote("git@gitlab.com:a/b.git"), undefined)
    assert.strictEqual(parseGitHubRemote("https://example.com/github.com/x"), undefined)
    assert.strictEqual(parseGitHubRemote(""), undefined)
  })
})
