import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import {
  getImportedFiles,
  getRelativeImportSpecifiers,
  resolveImport
} from "../../extension/imports"

suite("Import-aware context", () => {
  let root: string

  const write = (relative: string, content = "") => {
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    return file
  }

  suiteSetup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-imports-"))
  })

  suiteTeardown(async () => {
    fs.rmSync(root, { recursive: true, force: true })
    await vscode.commands.executeCommand("workbench.action.closeAllEditors")
  })

  test("extracts relative specifiers from JavaScript and TypeScript", () => {
    const text = `
      import React from "react"
      import { a } from "./a"
      import * as b from '../b.js'
      import "./side-effect"
      export * from "./re-export"
      const c = require("./c")
      const d = await import("./d")
      import { a as again } from "./a"
    `
    assert.deepStrictEqual(getRelativeImportSpecifiers(text, "typescript"), [
      "./a",
      "../b.js",
      "./side-effect",
      "./re-export",
      "./c",
      "./d"
    ])
  })

  test("extracts relative specifiers from Python", () => {
    const text = `
import os
from .helpers import x
from ..core.models import Model
from . import sibling
from typing import List
`
    assert.deepStrictEqual(getRelativeImportSpecifiers(text, "python"), [
      ".helpers",
      "..core.models",
      "."
    ])
  })

  test("returns nothing for languages it does not understand", () => {
    assert.deepStrictEqual(getRelativeImportSpecifiers("use crate::x;", "rust"), [])
  })

  test("resolves JavaScript specifiers to files on disk", () => {
    const a = write("src/a.ts")
    const b = write("src/lib/b.tsx")
    const index = write("src/dir/index.js")
    const doc = path.join(root, "src/main.ts")

    assert.strictEqual(resolveImport(doc, "./a", "typescript"), a)
    assert.strictEqual(resolveImport(doc, "./a.js", "typescript"), a)
    assert.strictEqual(resolveImport(doc, "./lib/b", "typescript"), b)
    assert.strictEqual(resolveImport(doc, "./dir", "typescript"), index)
    assert.strictEqual(resolveImport(doc, "./missing", "typescript"), undefined)
  })

  test("resolves Python relative imports", () => {
    const helpers = write("pkg/helpers.py")
    const models = write("core/models.py")
    const init = write("pkg/__init__.py")
    const doc = path.join(root, "pkg/main.py")

    assert.strictEqual(resolveImport(doc, ".helpers", "python"), helpers)
    assert.strictEqual(resolveImport(doc, "..core.models", "python"), models)
    assert.strictEqual(resolveImport(doc, ".", "python"), init)
    assert.strictEqual(resolveImport(doc, ".nope", "python"), undefined)
  })

  test("lists the imported files of an open document, skipping itself", async () => {
    const util = write("app/util.ts", "export const x = 1\n")
    const main = write(
      "app/main.ts",
      "import { x } from \"./util\"\nimport self from \"./main\"\nimport y from \"./nothing\"\n"
    )
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(main))
    assert.deepStrictEqual(getImportedFiles(document), [util])
  })

  test("ignores untitled documents", async () => {
    const document = await vscode.workspace.openTextDocument({
      content: "import { x } from \"./x\"",
      language: "typescript"
    })
    assert.deepStrictEqual(getImportedFiles(document), [])
  })
})
