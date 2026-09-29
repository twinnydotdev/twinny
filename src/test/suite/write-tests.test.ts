import * as assert from "assert"

import {
  appendTests,
  buildTestMessages,
  buildTestPrompt,
  declaredDependencies,
  isTestFile,
  testFileName,
  testFilePath,
  testFrameworkFor
} from "../../extension/edit/tests"

suite("Write tests", () => {
  suite("testFileName", () => {
    test("uses .test. for JavaScript-family files", () => {
      assert.strictEqual(testFileName("foo", ".ts", "typescript"), "foo.test.ts")
      assert.strictEqual(testFileName("Foo", ".jsx", "javascriptreact"), "Foo.test.jsx")
      assert.strictEqual(testFileName("foo", ".css", "css"), "foo.test.css")
    })

    test("follows each runner's convention elsewhere", () => {
      assert.strictEqual(testFileName("foo", ".py", "python"), "test_foo.py")
      assert.strictEqual(testFileName("foo", ".go", "go"), "foo_test.go")
      assert.strictEqual(testFileName("foo", ".rs", "rust"), "foo_test.rs")
      assert.strictEqual(testFileName("foo", ".rb", "ruby"), "foo_spec.rb")
      assert.strictEqual(testFileName("Foo", ".java", "java"), "FooTest.java")
      assert.strictEqual(testFileName("Foo", ".cs", "csharp"), "FooTest.cs")
    })

    test("puts the test file next to the source", () => {
      assert.strictEqual(
        testFilePath("/w/src/a/b.ts", "typescript"),
        "/w/src/a/b.test.ts"
      )
      assert.strictEqual(testFilePath("/w/pkg/m.py", "python"), "/w/pkg/test_m.py")
    })
  })

  suite("isTestFile", () => {
    test("recognises every name it would produce", () => {
      for (const name of [
        "a.test.ts",
        "a.spec.js",
        "a_test.go",
        "a_test.rs",
        "a_spec.rb",
        "test_a.py",
        "ATest.java",
        "ATests.cs"
      ]) {
        assert.ok(isTestFile(`/w/${name}`), name)
      }
    })

    test("leaves source files alone", () => {
      for (const name of ["a.ts", "test.ts", "tester.py", "atest.go", "contest.rb"]) {
        assert.ok(!isTestFile(`/w/${name}`), name)
      }
    })
  })

  suite("testFrameworkFor", () => {
    test("reads the JavaScript framework off the dependencies", () => {
      assert.strictEqual(testFrameworkFor("typescript", ["vitest"]), "vitest")
      assert.strictEqual(testFrameworkFor("javascript", ["ts-jest", "jest"]), "jest")
      assert.ok(testFrameworkFor("typescript", ["mocha"])?.startsWith("mocha"))
      assert.strictEqual(testFrameworkFor("typescript", []), undefined)
    })

    test("has one answer for the other languages", () => {
      assert.strictEqual(testFrameworkFor("python"), "pytest")
      assert.strictEqual(testFrameworkFor("ruby"), "RSpec")
      assert.strictEqual(testFrameworkFor("java"), "JUnit 5")
      assert.strictEqual(testFrameworkFor("plaintext"), undefined)
    })

    test("declaredDependencies merges both sections and survives bad JSON", () => {
      assert.deepStrictEqual(
        declaredDependencies(
          JSON.stringify({ dependencies: { a: "1" }, devDependencies: { b: "2" } })
        ),
        ["a", "b"]
      )
      assert.deepStrictEqual(declaredDependencies("{"), [])
      assert.deepStrictEqual(declaredDependencies("{}"), [])
    })
  })

  suite("buildTestPrompt", () => {
    test("names both files, quotes the code and the framework", () => {
      const prompt = buildTestPrompt({
        code: "export const add = (a: number, b: number) => a + b",
        language: "typescript",
        fileName: "src/math.ts",
        testFileName: "src/math.test.ts",
        framework: "jest"
      })
      assert.ok(prompt.startsWith("Source file: src/math.ts"))
      assert.ok(prompt.includes("```typescript\nexport const add"))
      assert.ok(prompt.includes("Test file: src/math.test.ts"))
      assert.ok(prompt.includes("from \"./math\""), "js gets an import hint")
      assert.ok(prompt.includes("Framework: jest."))
      assert.ok(!prompt.includes("already exists"))
      assert.ok(prompt.endsWith("Reply with the test code only."))
    })

    test("asks for the popular framework when none is known", () => {
      const prompt = buildTestPrompt({
        code: "def f(): pass",
        language: "python",
        fileName: "m.py",
        testFileName: "test_m.py"
      })
      assert.ok(prompt.includes("most popular testing library for python"))
      assert.ok(!prompt.includes("import the code under test from"))
    })

    test("shows an existing test file and asks only for additions", () => {
      const prompt = buildTestPrompt({
        code: "x",
        fileName: "a.ts",
        testFileName: "a.test.ts",
        existing: "import { x } from './a'\n\ntest('x', () => {})"
      })
      assert.ok(prompt.includes("already exists with this content"))
      assert.ok(prompt.includes("test('x', () => {})"))
      assert.ok(prompt.includes("new tests to add at the end of it only"))
    })

    test("messages are a system prompt plus one user turn", () => {
      const messages = buildTestMessages({
        code: "x",
        fileName: "a.ts",
        testFileName: "a.test.ts"
      })
      assert.deepStrictEqual(
        messages.map((m) => m.role),
        ["system", "user"]
      )
      assert.ok(String(messages[0].content).includes("No explanation"))
    })
  })

  suite("appendTests", () => {
    test("a new file is just the tests", () => {
      assert.strictEqual(appendTests("", true, "t()"), "t()")
    })

    test("a file ending without a newline gets a blank line first", () => {
      assert.strictEqual(appendTests("last", false, "t()"), "last\n\nt()")
    })

    test("a file ending with a newline gets one blank line", () => {
      assert.strictEqual(appendTests("", false, "t()"), "\nt()")
    })

    test("nothing to add leaves the last line as it was", () => {
      assert.strictEqual(appendTests("last", false, ""), "last")
    })
  })
})
