/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from "assert"
import * as vscode from "vscode"

import { CompletionFormatter } from "../../extension/completion-formatter"

suite("Completion formatter", () => {
  let editor: vscode.TextEditor

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors")
  })

  test("bracketed completions work correctly", async () => {
    const document = await vscode.workspace.openTextDocument()
    editor = await vscode.window.showTextDocument(document)
    const completionFormatter = new CompletionFormatter(editor)
    assert.strictEqual(completionFormatter.format("{\n\n"), "{")
    assert.strictEqual(completionFormatter.format("{"), "{")
    assert.strictEqual(completionFormatter.format("})"), "})")
    assert.strictEqual(completionFormatter.format("}"), "}")
    assert.strictEqual(completionFormatter.format("\n\n\n}"), "}")
    assert.strictEqual(completionFormatter.format("{{\n\n\n"), "{{")
  })

  test("handles brackets inside string literals", async () => {
    const document = await vscode.workspace.openTextDocument()
    editor = await vscode.window.showTextDocument(document)
    const completionFormatter = new CompletionFormatter(editor)
    assert.strictEqual(completionFormatter.format("const str = \"{ test }\";"), "const str = \"{ test }\";")
    assert.strictEqual(completionFormatter.format("const str = '{ test }';"), "const str = '{ test }';")
    assert.strictEqual(completionFormatter.format("const str = `{ test }`;"), "const str = `{ test }`;")
  })

  test("removes duplicate closing bracket", async () => {
    const document = await vscode.workspace.openTextDocument({
      content: "'')",
    })
    editor = await vscode.window.showTextDocument(document)
    const position = new vscode.Position(0, document.lineAt(0).text.length - 1)
    editor.selection = new vscode.Selection(position, position)
    const completionFormatter = new CompletionFormatter(editor)
    assert.ok(editor, "Editor should be defined")
    assert.strictEqual(completionFormatter.format("')"), "'")
  })

  test("removes duplicate closing quote", async () => {
    const document = await vscode.workspace.openTextDocument({
      content: "'word')}",
    })
    editor = await vscode.window.showTextDocument(document)
    const position = new vscode.Position(0, document.lineAt(0).text.length - 3)
    editor.selection = new vscode.Selection(position, position)
    const completionFormatter = new CompletionFormatter(editor)
    assert.ok(editor, "Editor should be defined")
    assert.strictEqual(completionFormatter.format("word')}"), "word")
  })

  test("skips completion in the middle of the word", async () => {
    const document = await vscode.workspace.openTextDocument({
      content: "word",
    })
    editor = await vscode.window.showTextDocument(document)
    const position = new vscode.Position(0, document.lineAt(0).text.length - 2)
    editor.selection = new vscode.Selection(position, position)
    const completionFormatter = new CompletionFormatter(editor)
    assert.ok(editor, "Editor should be defined")
    assert.strictEqual(completionFormatter.format("word smithery!"), "")
  })

  test("handles backtick quotes", async () => {
    const document = await vscode.workspace.openTextDocument({
      content: "`template`",
    })
    editor = await vscode.window.showTextDocument(document)
    const position = new vscode.Position(0, document.lineAt(0).text.length - 1)
    editor.selection = new vscode.Selection(position, position)
    const completionFormatter = new CompletionFormatter(editor)
    assert.ok(editor, "Editor should be defined")
    assert.strictEqual(completionFormatter.format("template`"), "template")
  })

  // test("applies indentation to multi-line completions", async () => {
  //   const document = await vscode.workspace.openTextDocument({
  //     content: "    if (condition) {",
  //   })
  //   editor = await vscode.window.showTextDocument(document)
  //   const position = new vscode.Position(0, document.lineAt(0).text.length)
  //   editor.selection = new vscode.Selection(position, position)
  //   const completionFormatter = new CompletionFormatter(editor)
  //   assert.ok(editor, "Editor should be defined")

  //   const result = completionFormatter.format("\ndoSomething();\nreturn true;\n}")
  //   assert.strictEqual(result, "\ndoSomething();\nreturn true;\n}")
  // })

  test("prevents duplicate lines", async () => {
    const document = await vscode.workspace.openTextDocument({
      content: "line1\nline2\nline3",
    })
    editor = await vscode.window.showTextDocument(document)
    const position = new vscode.Position(0, document.lineAt(0).text.length)
    editor.selection = new vscode.Selection(position, position)
    const completionFormatter = new CompletionFormatter(editor)
    assert.ok(editor, "Editor should be defined")

    // Should skip completion that matches line2
    assert.strictEqual(completionFormatter.format("line2"), "")
  })

  test("calculates string similarity correctly", async () => {
    const document = await vscode.workspace.openTextDocument()
    editor = await vscode.window.showTextDocument(document)

    // Create a test class that extends CompletionFormatter to access protected methods
    class TestCompletionFormatter extends CompletionFormatter {
      public testSimilarity(str1: string, str2: string): number {
        return this["calculateStringSimilarity"](str1, str2)
      }
    }

    const testFormatter = new TestCompletionFormatter(editor)

    // Test exact match
    assert.strictEqual(testFormatter.testSimilarity("test", "test"), 1.0)

    // Test completely different strings
    assert.ok(testFormatter.testSimilarity("test", "abcd") < 0.5)

    // Test similar strings
    assert.ok(testFormatter.testSimilarity("test", "tast") > 0.5)

    // Test empty strings
    assert.strictEqual(testFormatter.testSimilarity("", ""), 1.0)
    assert.strictEqual(testFormatter.testSimilarity("test", ""), 0.0)
  })
})
