import * as assert from "assert"

import { FIM_TEMPLATE_FORMAT } from "../../common/constants"
import { FimPromptTemplate } from "../../common/types"
import {
  getFimPrompt,
  getFimTemplateRepositoryLevel,
  getStopWords,
  isChatFimPrompt,
  resolveFimFormat
} from "../../extension/completion/fim-templates"
import { createStreamRequestBodyFim } from "../../extension/inference/adapters/fim-dialects"

const args = (overrides: Partial<FimPromptTemplate> = {}): FimPromptTemplate => ({
  contextFiles: [],
  header: "",
  prefixSuffix: { prefix: "PRE", suffix: "SUF" },
  language: "typescript",
  fileName: "src/a.ts",
  repoName: "repo",
  ...overrides
})

suite("FIM templates", () => {
  test("resolves the format from the model name when automatic", () => {
    const cases: [string, string][] = [
      ["codellama:7b-code", FIM_TEMPLATE_FORMAT.codellama],
      ["qwen2.5-coder:1.5b-base", FIM_TEMPLATE_FORMAT.codeqwen],
      ["Qwen/Qwen2.5-Coder-7B", FIM_TEMPLATE_FORMAT.codeqwen],
      ["codeqwen:7b-code", FIM_TEMPLATE_FORMAT.codeqwen],
      ["qwen3-coder:30b", FIM_TEMPLATE_FORMAT.qwen3Coder],
      ["Qwen/Qwen3-Coder-30B-A3B-Instruct", FIM_TEMPLATE_FORMAT.qwen3Coder],
      ["qwen/qwen3-coder-next", FIM_TEMPLATE_FORMAT.qwen3Coder],
      ["deepseek-coder:6.7b-base", FIM_TEMPLATE_FORMAT.deepseek],
      ["deepseek-coder-v2:16b", FIM_TEMPLATE_FORMAT.deepseek],
      ["codestral:22b", FIM_TEMPLATE_FORMAT.codestral],
      ["codegemma:2b-code", FIM_TEMPLATE_FORMAT.codegemma],
      ["stable-code:3b-code", FIM_TEMPLATE_FORMAT.stableCode],
      ["starcoder2:3b", FIM_TEMPLATE_FORMAT.starcoder],
      ["granite-code:3b-base", FIM_TEMPLATE_FORMAT.starcoder],
      ["llama3:8b", FIM_TEMPLATE_FORMAT.llama],
      ["some-unknown-model", FIM_TEMPLATE_FORMAT.codellama]
    ]
    for (const [model, expected] of cases) {
      assert.strictEqual(resolveFimFormat(model, "automatic"), expected, model)
      assert.strictEqual(resolveFimFormat(model, undefined), expected, model)
    }
  })

  test("an explicit format wins over the model name", () => {
    assert.strictEqual(
      resolveFimFormat("qwen2.5-coder", FIM_TEMPLATE_FORMAT.deepseek),
      FIM_TEMPLATE_FORMAT.deepseek
    )
    assert.strictEqual(
      resolveFimFormat("anything", "not-a-real-format"),
      FIM_TEMPLATE_FORMAT.codellama
    )
  })

  test("custom templates still infer stop words from the model name", () => {
    assert.deepStrictEqual(
      getStopWords("qwen2.5-coder", FIM_TEMPLATE_FORMAT.custom),
      getStopWords("qwen2.5-coder", FIM_TEMPLATE_FORMAT.codeqwen)
    )
  })

  test("renders each dialect with its own control tokens", () => {
    assert.strictEqual(
      getFimPrompt("x", FIM_TEMPLATE_FORMAT.codellama, args()),
      "<PRE> PRE <SUF> SUF <MID>"
    )
    assert.strictEqual(
      getFimPrompt("x", FIM_TEMPLATE_FORMAT.deepseek, args()),
      "<｜fim▁begin｜>PRE<｜fim▁hole｜>SUF<｜fim▁end｜>"
    )
    assert.strictEqual(
      getFimPrompt("x", FIM_TEMPLATE_FORMAT.codestral, args()),
      "[SUFFIX]SUF[PREFIX]PRE"
    )
    assert.strictEqual(
      getFimPrompt("x", FIM_TEMPLATE_FORMAT.codeqwen, args()),
      "<|fim_prefix|>PRE<|fim_suffix|>SUF<|fim_middle|>"
    )
    assert.strictEqual(
      getFimPrompt("x", FIM_TEMPLATE_FORMAT.codegemma, args()),
      "<|fim_prefix|>PRE<|fim_suffix|>SUF<|fim_middle|>"
    )
    assert.strictEqual(
      getFimPrompt("x", FIM_TEMPLATE_FORMAT.starcoder, args()),
      "<fim_prefix>PRE<fim_suffix>SUF<fim_middle>"
    )
    assert.strictEqual(
      getFimPrompt("x", FIM_TEMPLATE_FORMAT.stableCode, args()),
      "<fim_prefix>PRE<fim_suffix>SUF<fim_middle>"
    )
  })

  test("places the header immediately before the prefix", () => {
    const prompt = getFimPrompt(
      "x",
      FIM_TEMPLATE_FORMAT.codeqwen,
      args({ header: "// Path: src/a.ts \n" })
    )
    assert.strictEqual(
      prompt,
      "<|fim_prefix|>// Path: src/a.ts \nPRE<|fim_suffix|>SUF<|fim_middle|>"
    )
  })

  test("renders context files with repo tokens for models that have them", () => {
    const withContext = args({
      contextFiles: [{ name: "src/b.ts", text: "export const b = 1\n" }]
    })
    assert.strictEqual(
      getFimPrompt("x", FIM_TEMPLATE_FORMAT.codeqwen, withContext),
      "<|file_sep|>src/b.ts\nexport const b = 1\n<|file_sep|>src/a.ts\n" +
        "<|fim_prefix|>PRE<|fim_suffix|>SUF<|fim_middle|>"
    )
    assert.strictEqual(
      getFimPrompt("x", FIM_TEMPLATE_FORMAT.starcoder, withContext),
      "<repo_name>repo\n<file_sep>src/b.ts\nexport const b = 1\n<file_sep>src/a.ts\n" +
        "<fim_prefix>PRE<fim_suffix>SUF<fim_middle>"
    )
    assert.strictEqual(
      getFimPrompt("x", FIM_TEMPLATE_FORMAT.codegemma, withContext),
      "<|file_separator|>src/b.ts\nexport const b = 1\n<|file_separator|>src/a.ts\n" +
        "<|fim_prefix|>PRE<|fim_suffix|>SUF<|fim_middle|>"
    )
  })

  test("renders context files as comments for models without repo tokens", () => {
    const withContext = args({
      contextFiles: [{ name: "src/b.ts", text: "export const b = 1\n" }]
    })
    assert.strictEqual(
      getFimPrompt("x", FIM_TEMPLATE_FORMAT.codellama, withContext),
      "<PRE> /* File: src/b.ts */\nexport const b = 1\n\nPRE <SUF> SUF <MID>"
    )
    const python = getFimPrompt(
      "x",
      FIM_TEMPLATE_FORMAT.deepseek,
      args({ ...withContext, language: "python" })
    )
    assert.ok(python.startsWith("<｜fim▁begin｜>''' File: src/b.ts '''\n"), python)
  })

  test("repository-level prompt keeps the FIM markers", () => {
    const prompt = getFimTemplateRepositoryLevel(
      args({ contextFiles: [{ name: "src/b.ts", text: "b" }] })
    )
    assert.strictEqual(
      prompt,
      "<|repo_name|>repo\n<|file_sep|>src/b.ts\nb\n<|file_sep|>src/a.ts\n" +
        "<|fim_prefix|>PRE<|fim_suffix|>SUF<|fim_middle|>"
    )
  })

  test("uses a plain continuation prompt when there is no suffix", () => {
    const eof = args({ prefixSuffix: { prefix: "PRE", suffix: "\n  \n" } })
    assert.strictEqual(getFimPrompt("x", FIM_TEMPLATE_FORMAT.codellama, eof), "PRE")
    assert.strictEqual(getFimPrompt("x", FIM_TEMPLATE_FORMAT.deepseek, eof), "PRE")
    assert.strictEqual(getFimPrompt("x", FIM_TEMPLATE_FORMAT.codestral, eof), "PRE")
    assert.strictEqual(
      getFimPrompt("x", FIM_TEMPLATE_FORMAT.codeqwen, {
        ...eof,
        header: "// Path: src/a.ts\n",
        contextFiles: [{ name: "src/b.ts", text: "b" }]
      }),
      "<|file_sep|>src/b.ts\nb\n<|file_sep|>src/a.ts\n// Path: src/a.ts\nPRE"
    )
    assert.strictEqual(
      getFimPrompt("x", FIM_TEMPLATE_FORMAT.starcoder, eof),
      "PRE"
    )
    assert.strictEqual(
      getFimTemplateRepositoryLevel(eof),
      "<|repo_name|>repo\n<|file_sep|>src/a.ts\nPRE"
    )
  })

  test("every control token used by a template is also a stop word", () => {
    const formats = [
      FIM_TEMPLATE_FORMAT.codellama,
      FIM_TEMPLATE_FORMAT.deepseek,
      FIM_TEMPLATE_FORMAT.codestral,
      FIM_TEMPLATE_FORMAT.codeqwen,
      FIM_TEMPLATE_FORMAT.qwen3Coder,
      FIM_TEMPLATE_FORMAT.codegemma,
      FIM_TEMPLATE_FORMAT.starcoder,
      FIM_TEMPLATE_FORMAT.stableCode
    ]
    for (const format of formats) {
      const prompt = getFimPrompt("x", format, args({
        contextFiles: [{ name: "b", text: "b" }]
      }))
      const stopWords = getStopWords("x", format)
      const tokens = prompt.match(/<[^<>\s]+>|\[(?:PREFIX|SUFFIX)\]/g) || []
      assert.ok(tokens.length > 0, `${format} has no tokens`)
      for (const token of tokens) {
        assert.ok(
          stopWords.includes(token),
          `${format}: ${token} is not a stop word`
        )
      }
    }
  })

  test("sends Qwen3-Coder the FIM prompt as a chat turn", () => {
    const turn = (fim: string) =>
      "<|im_start|>system\nYou are a code completion assistant.<|im_end|>\n" +
      `<|im_start|>user\n${fim}<|im_end|>\n<|im_start|>assistant\n`
    assert.strictEqual(
      getFimPrompt("qwen3-coder:30b", FIM_TEMPLATE_FORMAT.automatic, args()),
      turn("<|fim_prefix|>PRE<|fim_suffix|>SUF<|fim_middle|>")
    )
    // A chat model does not continue plain text, so the markers stay.
    assert.strictEqual(
      getFimPrompt("x", FIM_TEMPLATE_FORMAT.qwen3Coder, args({
        prefixSuffix: { prefix: "PRE", suffix: "" }
      })),
      turn("<|fim_prefix|>PRE<|fim_suffix|><|fim_middle|>")
    )
    assert.strictEqual(
      getFimTemplateRepositoryLevel(
        args({ prefixSuffix: { prefix: "PRE", suffix: "" } }),
        "qwen3-coder:30b",
        FIM_TEMPLATE_FORMAT.automatic
      ),
      turn(
        "<|repo_name|>repo\n<|file_sep|>src/a.ts\n" +
          "<|fim_prefix|>PRE<|fim_suffix|><|fim_middle|>"
      )
    )
  })

  test("asks Ollama not to template a prompt that is already a chat", () => {
    assert.ok(isChatFimPrompt("qwen3-coder:30b", FIM_TEMPLATE_FORMAT.automatic))
    assert.ok(!isChatFimPrompt("qwen2.5-coder:7b", FIM_TEMPLATE_FORMAT.automatic))
    const body = (raw: boolean) =>
      createStreamRequestBodyFim("ollama", "p", {
        model: "m",
        numPredictFim: 10,
        raw
      }) as unknown as Record<string, unknown>
    assert.strictEqual(body(true).raw, true)
    assert.ok(!("raw" in body(false)))
  })
})
