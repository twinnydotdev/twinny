export class Logger {
  private static instance: Logger

  private static colorCodes: Record<string, number> = {
    Default: 0,
    FetchError: 91,
    Abort: 90,
    Timeout: 33
  }

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger()
    }
    return Logger.instance
  }

  public log = (message: string) => {
    console.log(`[twinny] ${message}`)
  }

  public error = (error: Error | string) => {
    const errorMessage = error instanceof Error ? error.message : error
    console.error(`[twinny:ERROR] ${errorMessage}`)
  }

  public logError(errorType: string, message: string, error: Error | string) {
    const colorCode = Logger.colorCodes[errorType] || Logger.colorCodes.Default
    const formattedErrorMessage = this.formatErrorMessage(
      colorCode,
      message,
      error
    )
    console.error(formattedErrorMessage)
  }

  private formatErrorMessage(
    colorCode: number,
    message: string,
    error: Error | string
  ) {
    const errorName = error instanceof Error ? error.name : "Unknown Error"
    const errorMessage = error instanceof Error ? error.message : error
    const coloredMessage = `\x1b[${colorCode}m [ERROR_twinny] \x1b[32m Message: ${message} \n \x1b[${colorCode}m Error Type: ${errorName} \n  Error Message: ${errorMessage} \n \x1b[31m`
    return coloredMessage
  }
}

export const logger = Logger.getInstance()
