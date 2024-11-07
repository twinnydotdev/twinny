import { Base } from "../extension/base"

export class Logger extends Base {
  private static instance: Logger

  constructor () {
    super()
  }

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger()
    }
    return Logger.instance
  }

  public log = (message: string) => {
    if (!this.config.enableLogging) return
    console.log(`[twinny] ${message}`)
  }

  public error = (err: NodeJS.ErrnoException) => {
    if (!this.config.enableLogging) return
    console.error(err.message)
  }
}

export const logger = Logger.getInstance()
