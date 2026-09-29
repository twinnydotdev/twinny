/** What was thrown, as a line to show. Pure; shared by the extension, the webview and the gateway. */

/** An Error's message; anything else, as text. */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
