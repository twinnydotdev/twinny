import * as fs from "fs"
import * as Handlebars from "handlebars"
import * as os from "os"
import * as path from "path"
import { workspace } from "vscode"

import { DEFAULT_TEMPLATE_NAMES, SYSTEM } from "../common/constants"

import { defaultTemplates } from "./templates"

export class TemplateProvider {
  private _basePath: string | undefined

  constructor(basePath: string | undefined) {
    this._basePath = basePath
  }

  public init() {
    this.createTemplateDir()
    this.registerHandlebarsHelpers()
  }

  public registerHandlebarsHelpers(): void {
    Handlebars.registerHelper("eq", (a, b) => a == b)
  }

  public createTemplateDir() {
    try {
      if (!this._basePath) return
      const exists = fs.existsSync(this._basePath)
      if (!exists) {
        fs.mkdirSync(this._basePath, { recursive: true })
        console.log(`The folder ${this._basePath} has been created`)
      }
      this.copyDefaultTemplates()
    } catch (err) {
      console.error(`Failed to create the basePath ${this._basePath}`, err)
    }
  }

  public copyDefaultTemplates() {
    try {
      defaultTemplates.forEach(({ name, template }) => {
        const destFile = path.join(this._basePath || "", name)
        if (!fs.existsSync(`${destFile}.hbs`)) {
          fs.writeFileSync(`${destFile}.hbs`, template, "utf8")
        }
      })
    } catch {
      console.log(`Problem creating default templates "${this._basePath}`)
    }
  }

  public async readSystemMessageTemplate(agent?: boolean) {
    try {
      const systemTemplateName = "system"
      const template =
        agent ? `agent-${systemTemplateName}` : systemTemplateName

      return await this.readTemplate(template, {
        cwd: workspace.workspaceFolders?.[0].uri.fsPath,
        defaultShell: os.userInfo().shell,
        osName: os.platform(),
        homedir: os.homedir()
      })
    } catch (error) {
      console.error(`Problem reading system template: ${error}`)
      return Promise.reject(error)
    }
  }

  public compileTemplateFromFile<T>(templateName: string) {
    const path = `${this._basePath}/${templateName}.hbs`
    try {
      return new Promise<HandlebarsTemplateDelegate<T>>((resolve, reject) => {
        fs.readFile(path, { encoding: "utf-8" }, (err, templateString) => {
          if (err && err.code !== "ENOENT") return reject(err)

          if (
            !templateString &&
            DEFAULT_TEMPLATE_NAMES.includes(templateName)
          ) {
            templateString =
              defaultTemplates.find(({ name }) => name === templateName)
                ?.template || ""
            if (!templateString) {
              return reject(new Error(`Template "${templateName}" not found`))
            }
            return resolve(Handlebars.compile(templateString))
          }

          const template = Handlebars.compile(templateString)
          resolve(template)
        })
      })
    } catch (e) {
      console.log(`Problem reading default template "${path}"`)
      return Promise.reject(e)
    }
  }

  private filterSystemTemplates = (filterName: string) => {
    return filterName !== "chat" && filterName.includes(SYSTEM) === false
  }

  public listTemplates(): string[] {
    if (!this._basePath) return []
    const files = fs.readdirSync(this._basePath, "utf8")
    const templates = files.filter((fileName) => fileName.endsWith(".hbs"))
    const templateNames = templates
      .map((fileName) => fileName.replace(".hbs", ""))
      .sort((a, b) => a.localeCompare(b))
      .filter(this.filterSystemTemplates)
    return templateNames
  }

  public async readTemplate<T>(templateName: string, data: T) {
    try {
      const template: HandlebarsTemplateDelegate<T> =
        await this.compileTemplateFromFile(templateName)

      const result = template(data)
      return result
    } catch (error) {
      console.error("Error rendering the template:", error)
      return ""
    }
  }
}
