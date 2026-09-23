import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { defaultTemplates } from "../../extension/templates/defaults"
import { TemplateProvider } from "../../extension/templates/provider"

const builtIn = (name: string) =>
  defaultTemplates.find((template) => template.name === name)?.template as string

suite("Templates", () => {
  let dir: string
  let templates: TemplateProvider

  const write = (name: string, text: string) =>
    fs.writeFileSync(path.join(dir, `${name}.hbs`), text, "utf8")
  const remove = (name: string) => fs.rmSync(path.join(dir, `${name}.hbs`))

  setup(() => {
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "twinny-templates-")), "templates")
    templates = new TemplateProvider(dir)
    templates.init()
  })

  teardown(() => {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true })
  })

  suite("init", () => {
    test("creates the folder and writes every built-in template", () => {
      for (const { name, template } of defaultTemplates) {
        assert.strictEqual(fs.readFileSync(path.join(dir, `${name}.hbs`), "utf8"), template)
      }
    })

    test("never overwrites a template the developer edited", () => {
      write("explain", "Mine: {{{code}}}")
      templates.init()
      assert.strictEqual(fs.readFileSync(path.join(dir, "explain.hbs"), "utf8"), "Mine: {{{code}}}")
    })

    test("does nothing without a folder", () => {
      assert.doesNotThrow(() => new TemplateProvider(undefined).init())
    })
  })

  suite("readTemplate", () => {
    test("renders the developer's copy", async () => {
      write("explain", "Explain {{language}}: {{{code}}}")
      const prompt = await templates.readTemplate("explain", { code: "a < b", language: "ts" })
      assert.strictEqual(prompt, "Explain ts: a < b")
    })

    test("never HTML-escapes: prompts go to a model", async () => {
      const prompt = await templates.readTemplate("review", { title: "Fix <T> & friends", code: "" })
      assert.ok(prompt.includes("titled \"Fix <T> & friends\""), prompt)
    })

    test("uses the built-in copy without a folder", async () => {
      const prompt = await new TemplateProvider(undefined).readTemplate("commit-message", {
        code: "diff --git a/x b/x"
      })
      assert.ok(prompt.startsWith("Write a git commit message"), prompt)
      assert.ok(prompt.endsWith("diff --git a/x b/x"), prompt)
    })

    test("falls back to the built-in copy when the file is missing or blank", async () => {
      remove("refactor")
      const missing = await templates.readTemplate("refactor", { code: "x", language: "go" })
      write("refactor", "  \n")
      const blank = await templates.readTemplate("refactor", { code: "x", language: "go" })
      assert.ok(missing.startsWith("Refactor the following code"), missing)
      assert.strictEqual(blank, missing)
    })

    test("falls back to the built-in copy when the developer's will not render", async () => {
      write("explain", "{{#if code}}unclosed")
      const prompt = await templates.readTemplate("explain", { code: "x", language: "rust" })
      assert.ok(prompt.startsWith("Explain the following code"), prompt)
    })

    test("gives nothing for a broken template with no built-in", async () => {
      write("custom", "{{#each}}")
      assert.strictEqual(await templates.readTemplate("custom", {}), "")
    })

    test("gives nothing, promptly, for a template that does not exist", async () => {
      assert.strictEqual(await templates.readTemplate("no-such-template", { code: "x" }), "")
    })

    test("refuses names that reach outside the folder", async () => {
      fs.writeFileSync(path.join(path.dirname(dir), "secret.hbs"), "secret", "utf8")
      assert.strictEqual(await templates.readTemplate("../secret", {}), "")
    })

    test("still renders when system.hbs has been deleted", async () => {
      remove("system")
      write("custom", "[{{systemMessage}}] {{{code}}}")
      const prompt = await templates.readTemplate("custom", { code: "x" })
      assert.strictEqual(prompt, `[${builtIn("system")}] x`)
    })

    test("renders a template the developer added", async () => {
      write("translate", "Translate to {{target}}: {{{code}}}")
      assert.strictEqual(
        await templates.readTemplate("translate", { code: "hi", target: "French" }),
        "Translate to French: hi"
      )
    })

    test("has the eq helper, whichever provider was initialised", async () => {
      write("custom", "{{#if (eq language 'python')}}py{{else}}other{{/if}}")
      const other = new TemplateProvider(dir)
      assert.strictEqual(await other.readTemplate("custom", { language: "python" }), "py")
      assert.strictEqual(await other.readTemplate("custom", { language: "go" }), "other")
    })

    test("picks up edits between renders", async () => {
      write("custom", "one")
      assert.strictEqual(await templates.readTemplate("custom", {}), "one")
      write("custom", "two")
      assert.strictEqual(await templates.readTemplate("custom", {}), "two")
    })
  })

  suite("system messages", () => {
    test("a template's own system message beats the shared one", async () => {
      write("system", "shared")
      write("custom", "{{systemMessage}}")
      assert.strictEqual(await templates.readTemplate("custom", {}), "shared")
      write("custom-system", "own")
      assert.strictEqual(await templates.readTemplate("custom", {}), "own")
    })

    test("the caller's systemMessage wins", async () => {
      write("custom", "{{systemMessage}}")
      assert.strictEqual(
        await templates.readTemplate("custom", { systemMessage: "given" }),
        "given"
      )
    })

    test("fim-system is empty by default, not the chat system prompt", async () => {
      assert.strictEqual(await templates.readSystemMessageTemplate("fim"), "")
    })

    test("without a folder, the built-in system prompt", async () => {
      assert.strictEqual(
        await new TemplateProvider(undefined).readSystemMessageTemplate("explain"),
        builtIn("system")
      )
    })
  })

  suite("listTemplates", () => {
    test("lists only what the chat can offer, sorted", () => {
      write("translate", "{{{code}}}")
      write("systemd-unit", "{{{code}}}")
      write("translate-system", "own")
      fs.writeFileSync(path.join(dir, "notes.txt"), "not a template")

      const expected = [
        ...defaultTemplates.filter((template) => template.interactive).map(({ name }) => name),
        "systemd-unit",
        "translate"
      ].sort((a, b) => a.localeCompare(b))
      assert.deepStrictEqual(templates.listTemplates(), expected)
    })

    test("leaves out the review summary", () => {
      assert.ok(!templates.listTemplates().includes("review-summary"))
    })

    test("is empty without a folder, or when it is gone", () => {
      assert.deepStrictEqual(new TemplateProvider(undefined).listTemplates(), [])
      fs.rmSync(dir, { recursive: true })
      assert.deepStrictEqual(templates.listTemplates(), [])
    })
  })
})
