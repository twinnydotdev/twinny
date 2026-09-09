/**
 * Write-tests naming and prompts. Pure: no vscode, no network.
 *
 * The tests for a file go in a sibling file named the way the language's
 * test runner expects (`foo.test.ts`, `test_foo.py`, `foo_test.go`). The
 * model is asked for the test code alone; the reply is parsed the same
 * defensive way an inline edit's is.
 */
import * as path from "path"

import { SYSTEM, USER } from "../../common/constants"
import { ChatCompletionMessage } from "../../common/types"

export interface TestRequest {
  /** The code to test. */
  code: string
  /** Language name for the prompt and the fence, e.g. "typescript". */
  language?: string
  /** Workspace-relative path of the source file. */
  fileName: string
  /** Workspace-relative path of the test file. */
  testFileName: string
  /** The framework to use, when known; else the model picks. */
  framework?: string
  /** What the test file already holds, when it exists. */
  existing?: string
}

/** The test file's name for a source file's `name` and `ext`. */
export const testFileName = (
  name: string,
  ext: string,
  languageId: string
): string => {
  switch (languageId) {
    case "python":
      return `test_${name}${ext}`
    case "go":
    case "rust":
      return `${name}_test${ext}`
    case "ruby":
      return `${name}_spec${ext}`
    case "java":
    case "kotlin":
    case "scala":
    case "csharp":
    case "php":
      return `${name}Test${ext}`
    default:
      return `${name}.test${ext}`
  }
}

/** Where the tests for `sourcePath` belong: next to it. */
export const testFilePath = (sourcePath: string, languageId: string): string => {
  const { dir, name, ext } = path.parse(sourcePath)
  return path.join(dir, testFileName(name, ext, languageId))
}

/** Whether a file is itself a test file, by any of the names above. */
export const isTestFile = (filePath: string): boolean => {
  const base = path.basename(filePath)
  return (
    /\.(test|spec)\.[^.]+$/i.test(base) ||
    /_(test|spec)\.[^.]+$/i.test(base) ||
    /^test_.*\.py$/i.test(base) ||
    /Tests?\.(java|kt|scala|cs|php)$/.test(base)
  )
}

const JS_LANGUAGES = new Set([
  "javascript",
  "javascriptreact",
  "typescript",
  "typescriptreact"
])

/**
 * The framework to ask for. JavaScript projects declare theirs in
 * package.json; the other languages have one obvious answer.
 */
export const testFrameworkFor = (
  languageId: string,
  dependencies: string[] = []
): string | undefined => {
  const has = (name: string) => dependencies.includes(name)
  if (JS_LANGUAGES.has(languageId)) {
    if (has("vitest")) return "vitest"
    if (has("jest") || has("ts-jest") || has("@jest/globals")) return "jest"
    if (has("mocha")) return "mocha with node's assert module"
    if (has("ava")) return "ava"
    if (has("jasmine")) return "jasmine"
    return undefined
  }
  switch (languageId) {
    case "python":
      return "pytest"
    case "go":
      return "the standard testing package"
    case "rust":
      return "the built-in #[test] attribute"
    case "ruby":
      return "RSpec"
    case "java":
    case "kotlin":
    case "scala":
      return "JUnit 5"
    case "csharp":
      return "xUnit"
    case "php":
      return "PHPUnit"
    default:
      return undefined
  }
}

export const TEST_SYSTEM_PROMPT = [
  "You are an expert programmer writing unit tests inside the user's editor.",
  "You will be given source code and the name of the test file the tests go in.",
  "",
  "Rules:",
  "- Reply with the test code only. No explanation, no commentary, no markdown fences.",
  "- Write complete, runnable tests: include the imports and setup they need.",
  "- The test file sits in the same directory as the source file; import the code under test from there.",
  "- Cover the normal cases, the edge cases and the error cases of what the code does.",
  "- Do not modify or restate the source code; test it as it is."
].join("\n")

const fence = (language: string | undefined, body: string) =>
  `\`\`\`${language || ""}\n${body}\n\`\`\``

/** The user turn: the source, where the tests go, and what to use. */
export const buildTestPrompt = (request: TestRequest): string => {
  const parts: string[] = []
  parts.push(`Source file: ${request.fileName}`)
  parts.push(fence(request.language, request.code))

  let where = `Test file: ${request.testFileName}`
  if (request.language && JS_LANGUAGES.has(request.language)) {
    const { name } = path.parse(request.fileName)
    where += ` (import the code under test from "./${name}")`
  }
  parts.push(where)

  if (request.framework) {
    parts.push(`Framework: ${request.framework}.`)
  } else {
    parts.push(
      `Framework: the most popular testing library for ${
        request.language || "this language"
      }.`
    )
  }

  if (request.existing?.trim()) {
    parts.push("The test file already exists with this content:")
    parts.push(fence(request.language, request.existing))
    parts.push(
      "Reply with the new tests to add at the end of it only; do not repeat the imports or the tests already there."
    )
  }

  parts.push("Reply with the test code only.")
  return parts.join("\n\n")
}

export const buildTestMessages = (
  request: TestRequest
): ChatCompletionMessage[] => [
  { role: SYSTEM, content: TEST_SYSTEM_PROMPT },
  { role: USER, content: buildTestPrompt(request) }
]

/**
 * The test file's last line with the new tests after it. A file that
 * already has content gets a blank line between the old and the new.
 */
export const appendTests = (
  lastLine: string,
  fileIsEmpty: boolean,
  code: string
): string => {
  if (!code) return lastLine
  if (fileIsEmpty) return code
  return lastLine ? `${lastLine}\n\n${code}` : `\n${code}`
}

/** The names a package.json declares, for the framework lookup. */
export const declaredDependencies = (packageJson: string): string[] => {
  try {
    const parsed = JSON.parse(packageJson) as Record<string, unknown>
    const names: string[] = []
    for (const key of ["dependencies", "devDependencies"]) {
      const section = parsed[key]
      if (section && typeof section === "object") {
        names.push(...Object.keys(section as Record<string, unknown>))
      }
    }
    return names
  } catch {
    return []
  }
}
