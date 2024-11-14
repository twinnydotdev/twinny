import { Base } from "../extension/base"

export class Logger extends Base {
  private static instance: Logger

  public static ErrorType = {
    Default: 0, // default color
    Fetch_Error: 91, // red -- fetch error
    Abort: 90, // gray -- abort
    Timeout: 33, // yellow -- timeout
  };

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

  public logConsoleError(errorKey: number, message: string, error: Error | string): void {
    const color = errorKey;
    const coloredMessage = `\x1b[91m [ERROR_twinny] \x1b[32m Message: ${message} \n \x1b[${color}m Error Type: ${error instanceof Error ? error.name : 'Unknown Error'} \n  Error Message: ${error instanceof Error ? error.message : error} \n \x1b[31m`;
    console.error(coloredMessage, error);
  }
}

export const logger = Logger.getInstance()
