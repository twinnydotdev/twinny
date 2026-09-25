import * as fs from "fs"
import * as Handlebars from "handlebars"
import * as path from "path"

import { SYSTEM } from "../../common/constants"
import { messageOf } from "../../common/errors"
import { logger } from "../../common/logger"

import { defaultTemplates } from "./defaults"

/**
 * twinny's own Handlebars environment, so the helpers templates rely on are
 * there however many providers exist and whichever of them was initialised.
 */
const handlebars = Handlebars.create()
handlebars.registerHelper("eq", (a, b) => a == b)

const EXTENSION = ".hbs"

/**
 * Compiled templates by source text. Completions render the FIM template on
 * every keystroke; an edited file is simply a new key. Bounded so a long
 * session of edits cannot grow it without end.
 */
const compiled = new Map<string, HandlebarsTemplateDelegate>()
const MAX_COMPILED = 64

const compile = (source: string): HandlebarsTemplateDelegate => {
  let template = compiled.get(source)
  if (!template) {
    if (compiled.size >= MAX_COMPILED) compiled.clear()
    // Prompts go to a model, not a browser: nothing should be HTML-escaped.
    template = handlebars.compile(source, { noEscape: true })
    compiled.set(source, template)
  }
  return template
}

const builtIn = (name: string): string | undefined =>
  defaultTemplates.find((template) => template.name === name)?.template

/** A system message: "system" itself, or the per-template "<name>-system". */
const isSystemTemplate = (name: string) =>
  name === SYSTEM || name.endsWith(`-${SYSTEM}`)

/** Built-in templates the chat cannot offer as a button (see `interactive`). */
const NON_INTERACTIVE = new Set(
  defaultTemplates
    .filter((template) => !template.interactive)
    .map((template) => template.name)
)

/**
 * The prompts twinny sends, as Handlebars templates. Each one is read from
 * `<basePath>/<name>.hbs`, where the developer can edit it, and falls back
 * to the built-in copy when the file is missing, empty or will not render.
 * A template's `{{systemMessage}}` is `<name>-system.hbs` when there is
 * one, otherwise `system.hbs`.
 */
export class TemplateProvider {
  private readonly _basePath: string | undefined

  constructor(basePath: string | undefined) {
    this._basePath = basePath
  }

  /** Creates the template folder and writes any built-in template missing from it. */
  public init() {
    if (!this._basePath) return
    try {
      fs.mkdirSync(this._basePath, { recursive: true })
    } catch (error) {
      logger.error(`Could not create the template folder ${this._basePath}: ${error}`)
      return
    }
    for (const { name, template } of defaultTemplates) {
      try {
        // "wx" never overwrites: the developer's edits are theirs.
        fs.writeFileSync(this.fileFor(name) as string, template, { encoding: "utf8", flag: "wx" })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          logger.warn(`Could not write the default template "${name}": ${error}`)
        }
      }
    }
  }

  /** The system message for a template: its own, the shared one, or none. */
  public async readSystemMessageTemplate(templateName?: string): Promise<string> {
    const own =
      templateName && !isSystemTemplate(templateName)
        ? await this.readSource(`${templateName}-${SYSTEM}`)
        : undefined
    return own ?? (await this.readSource(SYSTEM)) ?? ""
  }

  /**
   * Renders a template with `data`, plus `systemMessage` unless the caller
   * supplied one. Never throws: an unknown or broken template gives "" and a
   * line in the log, and callers say so in their own terms.
   */
  public async readTemplate<T extends object>(
    templateName: string,
    data: T
  ): Promise<string> {
    const [source, systemMessage] = await Promise.all([
      this.readSource(templateName),
      this.readSystemMessageTemplate(templateName)
    ])
    if (source === undefined) {
      logger.warn(`No template named "${templateName}"`)
      return ""
    }

    const context: Record<string, unknown> = { ...(data as Record<string, unknown>) }
    if (context.systemMessage == null) context.systemMessage = systemMessage
    try {
      return compile(source)(context)
    } catch (error) {
      const fallback = builtIn(templateName)
      logger.error(
        `The template "${templateName}" did not render` +
          (fallback !== undefined && fallback !== source ? "; using the built-in one" : "") +
          `: ${messageOf(error)}`
      )
      if (fallback === undefined || fallback === source) return ""
      try {
        return compile(fallback)(context)
      } catch {
        return ""
      }
    }
  }

  /**
   * The templates the chat offers as code actions: every file in the folder
   * except system messages and the built-ins another feature fills in.
   */
  public listTemplates(): string[] {
    if (!this._basePath) return []
    let files: string[]
    try {
      files = fs.readdirSync(this._basePath, "utf8")
    } catch {
      return []
    }
    return files
      .filter((file) => file.endsWith(EXTENSION))
      .map((file) => file.slice(0, -EXTENSION.length))
      .filter((name) => !NON_INTERACTIVE.has(name) && !isSystemTemplate(name))
      .sort((a, b) => a.localeCompare(b))
  }

  /** Where a template lives on disk; undefined for names that are not plain file names. */
  private fileFor(name: string): string | undefined {
    if (!this._basePath || !name || path.basename(name) !== name) return undefined
    return path.join(this._basePath, `${name}${EXTENSION}`)
  }

  /**
   * A template's text: the developer's file, or the built-in copy when the
   * file is missing or blank. Undefined when neither exists.
   */
  private async readSource(name: string): Promise<string | undefined> {
    const file = this.fileFor(name)
    let text: string | undefined
    if (file) {
      try {
        text = await fs.promises.readFile(file, "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          logger.warn(`Could not read the template ${file}: ${error}`)
        }
      }
    }
    if (text?.trim()) return text
    return builtIn(name) ?? text
  }
}
