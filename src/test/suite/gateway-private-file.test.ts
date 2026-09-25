/**
 * The gateway's private files: written whole through a rename, owner-only,
 * under a directory made owner-only on the way. And the record guard the
 * parsers share.
 */
import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { isRecord } from "../../common/guards"
import { writePrivateFile, writePrivateJson } from "../../gateway/private-file"

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-private-file-test-"))

suite("Private files", () => {
  test("a file lands owner-only in an owner-only directory, with no temporary left behind", () => {
    const file = path.join(scratch, "a", "b", "secret.txt")
    writePrivateFile(file, "shh\n")
    assert.strictEqual(fs.readFileSync(file, "utf8"), "shh\n")
    if (process.platform !== "win32") {
      assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600)
      assert.strictEqual(fs.statSync(path.dirname(file)).mode & 0o777, 0o700)
    }
    assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ["secret.txt"])

    writePrivateFile(file, Buffer.from([1, 2, 3]))
    assert.deepStrictEqual([...fs.readFileSync(file)], [1, 2, 3], "a second write replaces the first")
  })

  test("JSON is indented by two and ends with a newline", () => {
    const file = path.join(scratch, "settings.json")
    writePrivateJson(file, { version: 1, items: ["x"] })
    assert.strictEqual(fs.readFileSync(file, "utf8"), "{\n  \"version\": 1,\n  \"items\": [\n    \"x\"\n  ]\n}\n")
  })

  test("a record is a plain object: not null, not an array, not a scalar", () => {
    assert.strictEqual(isRecord({}), true)
    assert.strictEqual(isRecord({ a: 1 }), true)
    assert.strictEqual(isRecord(Object.create(null)), true)
    assert.strictEqual(isRecord(null), false)
    assert.strictEqual(isRecord([]), false)
    assert.strictEqual(isRecord("{}"), false)
    assert.strictEqual(isRecord(1), false)
    assert.strictEqual(isRecord(undefined), false)
  })
})
