import * as vscode from "vscode"

/** Markdown fence names that are not VS Code language ids. */
const FENCE_ALIASES: Record<string, string> = {
  bash: "shellscript",
  sh: "shellscript",
  shell: "shellscript",
  zsh: "shellscript",
  console: "shellscript",
  ps1: "powershell",
  pwsh: "powershell",
  ts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  jsx: "javascriptreact",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  golang: "go",
  kt: "kotlin",
  cs: "csharp",
  "c++": "cpp",
  cc: "cpp",
  hpp: "cpp",
  h: "c",
  yml: "yaml",
  md: "markdown",
  jsonc: "json",
  txt: "plaintext",
  text: "plaintext",
  dockerfile: "dockerfile",
  html: "html",
  htm: "html"
}

/**
 * Turn a markdown fence name into a language id VS Code actually knows,
 * falling back to the active editor's language and then to plain text.
 */
export const resolveLanguageId = async (
  fence: string | undefined,
  fallback: string | undefined
): Promise<string> => {
  const known = new Set(await vscode.languages.getLanguages())
  const wanted = fence?.trim().toLowerCase()
  if (wanted) {
    const candidate = FENCE_ALIASES[wanted] ?? wanted
    if (known.has(candidate)) return candidate
  }
  if (fallback && known.has(fallback)) return fallback
  return "plaintext"
}

/**
 * Models often quote shell sessions with a prompt in front of each command.
 * Drop `$ `, `> ` and `PS> ` so what lands in the terminal is runnable.
 */
export const stripShellPrompts = (command: string): string =>
  command
    .split("\n")
    .map((line) => line.replace(/^\s*(?:\$|>|PS[^>]*>)\s+/, ""))
    .join("\n")
    .trim()
