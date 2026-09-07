import * as assert from "assert"

import {
  formatDuration,
  formatRelativeTime,
  getDateBucket
} from "../../common/time"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

suite("Time helpers", () => {
  test("relative time reads naturally at each scale", () => {
    const now = Date.UTC(2026, 8, 7, 12, 0, 0)
    assert.strictEqual(formatRelativeTime(now - 10_000, now), "just now")
    assert.strictEqual(formatRelativeTime(now - 5 * MINUTE, now), "5 min ago")
    assert.strictEqual(formatRelativeTime(now - 3 * HOUR, now), "3 h ago")
    assert.strictEqual(formatRelativeTime(now - 2 * DAY, now), "2 d ago")
    assert.ok(/\d/.test(formatRelativeTime(now - 30 * DAY, now)))
  })

  test("buckets timestamps by calendar day, not by 24h windows", () => {
    const now = new Date(2026, 8, 7, 1, 0, 0).getTime() // 01:00 local
    assert.strictEqual(getDateBucket(now - 30 * MINUTE, now), "today")
    // Two hours ago was before midnight, so it is yesterday.
    assert.strictEqual(getDateBucket(now - 2 * HOUR, now), "yesterday")
    assert.strictEqual(getDateBucket(now - 3 * DAY, now), "this-week")
    assert.strictEqual(getDateBucket(now - 10 * DAY, now), "older")
    assert.strictEqual(getDateBucket(undefined, now), "older")
  })

  test("durations", () => {
    assert.strictEqual(formatDuration(42_000), "42s")
    assert.strictEqual(formatDuration(65_000), "1m 05s")
  })
})
