import * as assert from "assert"

import { isIndexablePath, looksBinary } from "../../extension/embeddings/indexable"

suite("Embeddings: indexable files", () => {
  test("indexes source, config and docs", () => {
    for (const file of [
      "src/index.ts",
      "src/types.d.ts",
      "src/app.test.tsx",
      "lib/main.py",
      "README.md",
      "docs/guide.rst",
      "config/settings.yaml",
      "schema.graphql",
      "Makefile",
      "Dockerfile",
      "LICENSE",
      ".gitignore",
      ".prettierrc",
      "config.yaml.example",
      "CMakeLists.txt"
    ]) {
      assert.ok(isIndexablePath(file), `${file} should be indexed`)
    }
  })

  test("skips binaries, media and generated files", () => {
    for (const file of [
      "fonts/inter.woff",
      "fonts/inter.woff2",
      "fonts/inter.ttf",
      "img/logo.png",
      "img/photo.JPG",
      "media/intro.mp4",
      "build/app.wasm",
      "dist/bundle.min.js",
      "dist/bundle.js.map",
      "package-lock.json",
      "yarn.lock",
      "Cargo.lock",
      "__snapshots__/app.test.tsx.snap",
      "archive.tar.gz",
      "data.sqlite",
      "notes.pdf",
      "secrets.env",
      ".env",
      "binary-with-no-extension"
    ]) {
      assert.ok(!isIndexablePath(file), `${file} should be skipped`)
    }
  })

  test("sniffs binary content", () => {
    assert.ok(!looksBinary(Buffer.from("const a = 1\n")))
    assert.ok(!looksBinary(Buffer.from("héllo wörld ✓")))
    assert.ok(looksBinary(Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01])))
    assert.ok(!looksBinary(Buffer.alloc(0)))
  })
})
