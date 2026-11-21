import * as assert from "node:assert"
import { test } from "node:test"

import { dueNudge } from "../../common/nudge"

const DAY = 24 * 60 * 60 * 1000

test("the team message comes first, then the support message once, well apart", () => {
  assert.strictEqual(dueNudge({ since: 0 }, 13 * DAY, false), undefined)
  assert.strictEqual(dueNudge({ since: 0 }, 14 * DAY, false), "team")
  assert.strictEqual(dueNudge({ since: 0, shown: true, shownAt: 14 * DAY }, 29 * DAY, false), undefined)
  assert.strictEqual(dueNudge({ since: 0, shown: true, shownAt: 14 * DAY }, 30 * DAY, false), "support")
  assert.strictEqual(dueNudge({ since: 0, shown: true, shownAt: 25 * DAY }, 30 * DAY, false), undefined)
  assert.strictEqual(dueNudge({ since: 0, shown: true, shownAt: 25 * DAY }, 39 * DAY, false), "support")
  assert.strictEqual(dueNudge({ since: 0, shown: true, supportShown: true }, 99 * DAY, false), undefined)
})

test("someone who saw the team message before this version still gets the support one", () => {
  assert.strictEqual(dueNudge({ since: 0, shown: true }, 30 * DAY, false), "support")
})

test("a machine on a team gateway sees neither", () => {
  assert.strictEqual(dueNudge({ since: 0 }, 99 * DAY, true), undefined)
  assert.strictEqual(dueNudge({ since: 0, shown: true }, 99 * DAY, true), undefined)
})
