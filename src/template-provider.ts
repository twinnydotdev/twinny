import * as fs from 'fs'
import * as Handlebars from 'handlebars'
import * as path from 'path'
import { DefaultTemplate } from './types'

export class TemplateProvider {
  private _basePath: string
  private _sourcePath: string = path.join(__dirname, '../src/templates')

  constructor(basePath: string) {
    this._basePath = basePath
    this.createTemplateDir()
    this.registerHandlebarsHelpers()
  }

  public registerHandlebarsHelpers(): void {
    Handlebars.registerHelper('eq', (a, b) => a == b)
  }

  public createTemplateDir() {
    try {
      const exists = fs.existsSync(this._basePath)
      if (!exists) {
        this.copyDefaultTemplates()
        fs.mkdirSync(this._basePath, { recursive: true })
        console.log(`The folder ${this._basePath} has been created`)
      }
    } catch (err) {
      console.error(`Failed to create the basePath ${this._basePath}`, err)
    }
  }

  public copyDefaultTemplates() {
    const destPath = path.join(this._basePath)
    try {
      fs.mkdirSync(destPath, { recursive: true })
      fs.readdir(this._sourcePath, (err, files) => {
        if (err) {
          console.error('Failed to list source templates', err)
          return
        }

        files.forEach((file) => {
          const srcFile = path.join(this._sourcePath, file)
          const destFile = path.join(destPath, file)
          fs.copyFileSync(srcFile, destFile)
        })
      })
    } catch (e) {
      console.log(`Problem creating default templates "${this._basePath}`)
    }
  }

  public readSystemMessageTemplate() {
    const path = `${this._basePath}/system.hbs`
    try {
      return new Promise<string>((resolve, reject) => {
        fs.readFile(
          path,
          { encoding: 'utf-8' },
          (err, templateString: string) => {
            if (err) return reject(err)
            resolve(templateString)
          }
        )
      })
    } catch (e) {
      console.log(
        `Problem reading default template "${this._basePath}/system.hbs`
      )
      return Promise.reject()
    }
  }

  public compileTemplateFromFile<T>(templateName: string) {
    const path = `${this._basePath}/${templateName}.hbs`
    try {
      return new Promise<HandlebarsTemplateDelegate<T>>((resolve, reject) => {
        fs.readFile(path, { encoding: 'utf-8' }, (err, templateString) => {
          if (err) return reject(err)
          const template = Handlebars.compile(templateString)
          resolve(template)
        })
      })
    } catch (e) {
      console.log(`Problem reading default template "${path}"`)
      return Promise.reject(e)
    }
  }

  public async renderTemplate<T extends DefaultTemplate>(
    templateName: string,
    data: T
  ) {
    try {
      const template: HandlebarsTemplateDelegate<T> =
        await this.compileTemplateFromFile(templateName)

      const result = template({
        ...data,
        systemMessage: await this.readSystemMessageTemplate()
      })
      return result
    } catch (error) {
      console.error('Error rendering the template:', error)
      return ''
    }
  }
}
