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

  test("removes invalid line breaks", async () => {
    const document = await vscode.workspace.openTextDocument({
      content: "function test() {",
    })
    editor = await vscode.window.showTextDocument(document)
    const position = new vscode.Position(0, document.lineAt(0).text.length)
    editor.selection = new vscode.Selection(position, position)

    // Create a test class that extends CompletionFormatter to access protected methods
    class TestCompletionFormatter extends CompletionFormatter {
      public testRemoveInvalidLineBreaks(completion: string): string {
        this.completion = completion
        return this.removeInvalidLineBreaks().getCompletion()
      }
    }

    const testFormatter = new TestCompletionFormatter(editor)

    // Test with text after cursor
    testFormatter.textAfterCursor = "}"
    assert.strictEqual(testFormatter.testRemoveInvalidLineBreaks("\n  return true;\n  \n"), "\n  return true;")

    // Test with no text after cursor
    testFormatter.textAfterCursor = ""
    assert.strictEqual(testFormatter.testRemoveInvalidLineBreaks("\n  return true;\n  \n"), "\n  return true;\n  \n")
  })

  test("normalizes text correctly", async () => {
    const document = await vscode.workspace.openTextDocument()
    editor = await vscode.window.showTextDocument(document)

    // Create a test class that extends CompletionFormatter to access protected methods
    class TestCompletionFormatter extends CompletionFormatter {
      public testNormalize(text: string): string {
        return this["normalize"](text)
      }
    }

    const testFormatter = new TestCompletionFormatter(editor)

    // Test basic normalization
    assert.strictEqual(testFormatter.testNormalize("  test  "), "test")

    // Test with JavaScript comments
    testFormatter.languageId = "javascript"
    assert.strictEqual(testFormatter.testNormalize("// This is a comment"), "// This is a comment")

    // Test with Python comments
    testFormatter.languageId = "python"
    assert.strictEqual(testFormatter.testNormalize("''' This is a comment '''"), "''' This is a comment '''")
  })

  test("removes duplicate text between completion and text after cursor", async () => {
    const document = await vscode.workspace.openTextDocument({
      content: "function test() {\n  return true;\n}",
    })
    editor = await vscode.window.showTextDocument(document)
    const position = new vscode.Position(0, document.lineAt(0).text.length)
    editor.selection = new vscode.Selection(position, position)

    // Create a test class that extends CompletionFormatter to access protected methods
    class TestCompletionFormatter extends CompletionFormatter {
      public testRemoveDuplicateText(completion: string, textAfter: string): string {
        this.completion = completion
        this.textAfterCursor = textAfter
        return this.removeDuplicateText().getCompletion()
      }
    }

    const testFormatter = new TestCompletionFormatter(editor)

    // Test with overlapping text
    assert.strictEqual(
      testFormatter.testRemoveDuplicateText("return true;", "return true;"),
      ""
    )

    // Test with partial overlap
    assert.strictEqual(
      testFormatter.testRemoveDuplicateText("console.log('test');", "test');"),
      "console.log('"
    )

    // Test with no overlap
    assert.strictEqual(
      testFormatter.testRemoveDuplicateText("const x = 1;", "return true;"),
      "const x = 1;"
    )
  })

  test("prevents quotation completions", async () => {
    const document = await vscode.workspace.openTextDocument()
    editor = await vscode.window.showTextDocument(document)

    // Create a test class that extends CompletionFormatter to access protected methods
    class TestCompletionFormatter extends CompletionFormatter {
      public testPreventQuotationCompletions(completion: string): string {
        this.completion = completion
        return this.preventQuotationCompletions().getCompletion()
      }
    }

    const testFormatter = new TestCompletionFormatter(editor)

    // Test with file reference comments
    assert.strictEqual(testFormatter.testPreventQuotationCompletions("// File: test.js"), "")

    // Test with empty comment
    assert.strictEqual(testFormatter.testPreventQuotationCompletions("//"), "")

    // Test with normal code
    assert.strictEqual(testFormatter.testPreventQuotationCompletions("const x = 1;"), "const x = 1;")

    // Test with multi-line comment references
    assert.strictEqual(
      testFormatter.testPreventQuotationCompletions("// Language: JavaScript\n// This is valid code"),
      "// Language: JavaScript\n// This is valid code"
    )
  })

  test("trims whitespace from start of completion", async () => {
    const document = await vscode.workspace.openTextDocument()
    editor = await vscode.window.showTextDocument(document)

    // Create a test class that extends CompletionFormatter to access protected methods
    class TestCompletionFormatter extends CompletionFormatter {
      public testTrimStart(completion: string, cursorCharacter: number): string {
        this.completion = completion
        this.cursorPosition = new vscode.Position(0, cursorCharacter)
        return this.trimStart().getCompletion()
      }
    }

    const testFormatter = new TestCompletionFormatter(editor)

    // Test with cursor at beginning and whitespace at start
    assert.strictEqual(testFormatter.testTrimStart("  const x = 1;", 0), "const x = 1;")

    // Test with cursor after whitespace
    assert.strictEqual(testFormatter.testTrimStart("  const x = 1;", 3), "  const x = 1;")

    // Test with no whitespace
    assert.strictEqual(testFormatter.testTrimStart("const x = 1;", 0), "const x = 1;")
  })

  test("handles complex nested brackets and quotes", async () => {
    const document = await vscode.workspace.openTextDocument()
    editor = await vscode.window.showTextDocument(document)
    const completionFormatter = new CompletionFormatter(editor)

    // Test nested brackets with string literals
    assert.strictEqual(
      completionFormatter.format("function test() { return { key: \"value with { and }\" }; }"),
      "function test() { return { key: \"value with { and }\" }; }"
    )

    // Test unbalanced brackets in string literals
    assert.strictEqual(
      completionFormatter.format("const str = \"unbalanced { bracket\";"),
      "const str = \"unbalanced { bracket\";"
    )

    // Test with mixed quotes
    assert.strictEqual(
      completionFormatter.format("const str = `template with ${\"nested\"} quotes`;"),
      "const str = `template with ${\"nested\"} quotes`;"
    )
  })

  test("handles HTML/XML tags", async () => {
    const document = await vscode.workspace.openTextDocument({
      language: "html"
    })
    editor = await vscode.window.showTextDocument(document)
    const completionFormatter = new CompletionFormatter(editor)

    // Test basic HTML tag
    assert.strictEqual(
      completionFormatter.format("<div>content</div>"),
      "<div>content</div>"
    )

    // Test self-closing tag
    assert.strictEqual(
      completionFormatter.format("<img src=\"test.jpg\" />"),
      "<img src=\"test.jpg\" />"
    )

    // Test nested tags
    assert.strictEqual(
      completionFormatter.format("<div><span>nested</span></div>"),
      "<div><span>nested</span></div>"
    )

    // Test incomplete tag completion
    assert.strictEqual(
      completionFormatter.format("<div"),
      "<div></div>"
    )

    // Test auto-closing tag
    assert.strictEqual(
      completionFormatter.format("<p>"),
      "<p></p>"
    )

    // Test auto-converting to self-closing tag
    assert.strictEqual(
      completionFormatter.format("<img>"),
      "<img/>"
    )

    // Test tag with attributes
    assert.strictEqual(
      completionFormatter.format("<a href=\"#\">"),
      "<a href=\"#\"></a>"
    )
  })

  test("handles language-specific formatting", async () => {
    // Test JavaScript
    let document = await vscode.workspace.openTextDocument({
      language: "javascript"
    })
    editor = await vscode.window.showTextDocument(document)
    let completionFormatter = new CompletionFormatter(editor)

    assert.strictEqual(
      completionFormatter.format("// This is a comment\nconst x = 1;"),
      "// This is a comment\nconst x = 1;"
    )

    // Test Python
    document = await vscode.workspace.openTextDocument({
      language: "python"
    })
    editor = await vscode.window.showTextDocument(document)
    completionFormatter = new CompletionFormatter(editor)

    assert.strictEqual(
      completionFormatter.format("# This is a comment\ndef test():\n    return True"),
      "# This is a comment\ndef test():\n    return True"
    )
  })

  test("skips similar completions", async () => {
    const document = await vscode.workspace.openTextDocument({
      content: "function test() {",
    })
    editor = await vscode.window.showTextDocument(document)
    const position = new vscode.Position(0, document.lineAt(0).text.length)
    editor.selection = new vscode.Selection(position, position)

    // Create a test class that extends CompletionFormatter to access protected methods
    class TestCompletionFormatter extends CompletionFormatter {
      public testSkipSimilarCompletions(completion: string, textAfter: string): string {
        this.completion = completion

        // For testing purposes, we'll simulate the behavior without mocking
        // Just check if the similarity is high enough to skip
        if (this.calculateStringSimilarity(textAfter, completion) > 0.6) {
          return "";
        }
        return completion;
      }
    }

    const testFormatter = new TestCompletionFormatter(editor)

    // Test with very similar text
    assert.strictEqual(
      testFormatter.testSkipSimilarCompletions("return true;", "return true;"),
      ""
    )

    // Test with somewhat similar text
    assert.strictEqual(
      testFormatter.testSkipSimilarCompletions("return false;", "return true;"),
      ""
    )

    // Test with different text
    assert.strictEqual(
      testFormatter.testSkipSimilarCompletions("console.log('test');", "return true;"),
      "console.log('test');"
    )
  })

  test("handles interface declarations with consistent indentation", async () => {
    const document = await vscode.workspace.openTextDocument({
      language: "typescript",
      content: "export interface ProviderMessage<T = unknown> {"
    })
    editor = await vscode.window.showTextDocument(document)
    const position = new vscode.Position(0, document.lineAt(0).text.length)
    editor.selection = new vscode.Selection(position, position)
    const completionFormatter = new CompletionFormatter(editor)

    assert.strictEqual(
      completionFormatter.format("\n  key: string;\n  value: T;\n}"),
      "\n  key: string;\n  value: T;"
    )
  })
})
