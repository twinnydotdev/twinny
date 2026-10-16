import { useEffect, useState } from "react"

import { Theme } from "../../common/types"

import { useTheme } from "./useTheme"

/** VS Code's own class on the webview's body: changes the moment the user switches theme. */
const bodyTheme = (): "light" | "dark" | undefined => {
  const classes = document.body.classList
  if (classes.contains("vscode-light") || classes.contains("vscode-high-contrast-light")) return "light"
  if (classes.contains("vscode-dark") || classes.contains("vscode-high-contrast")) return "dark"
  return undefined
}

/**
 * Whether code should be highlighted for a light or a dark ground. Read
 * from the body's theme class, which follows a theme switch without a
 * reload; the theme the extension reported at start is the fallback.
 * High-contrast themes go by their ground, not by being "contrast".
 */
export const useCodeTheme = (): "light" | "dark" => {
  const reported = useTheme()
  const [fromBody, setFromBody] = useState(bodyTheme)

  useEffect(() => {
    const observer = new MutationObserver(() => setFromBody(bodyTheme()))
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])

  return fromBody ?? (reported === Theme.Light ? "light" : "dark")
}
