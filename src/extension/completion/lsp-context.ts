import {
  CancellationToken,
  commands,
  CompletionItem,
  CompletionItemKind,
  CompletionList,
  Position,
  Range,
  TextDocument
} from "vscode"

const MAX_ITEMS = 20
const MAX_CHARS = 2000
const TIMEOUT_MS = 150

const compact = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 200)

/** Keep useful symbols and their available signatures, without large docs/snippets. */
export function formatLspSuggestions(items: CompletionItem[], prefix: string) {
  const matching = items.filter((item) => {
    if (item.kind === CompletionItemKind.Snippet || item.kind === CompletionItemKind.Text) {
      return false
    }
    const label = typeof item.label === "string" ? item.label : item.label.label
    return (item.filterText || label).toLowerCase().startsWith(prefix.toLowerCase())
  }).sort((a, b) => {
    const aLabel = typeof a.label === "string" ? a.label : a.label.label
    const bLabel = typeof b.label === "string" ? b.label : b.label.label
    const aSort = a.sortText || aLabel
    const bSort = b.sortText || bLabel
    return aSort < bSort ? -1 : aSort > bSort ? 1 : 0
  })

  const lines = ["IntelliSense suggestions at the cursor (name / type or signature):"]
  const seen = new Set<string>()
  let length = lines[0].length
  for (const item of matching) {
    const label = typeof item.label === "string" ? item.label : item.label.label
    const details = typeof item.label === "string"
      ? [] : [item.label.detail || "", item.label.description || ""]
    const line = [...new Set([label, ...details, item.detail || ""].map(compact).filter(Boolean))].join(" | ")
    if (!line || seen.has(line)) continue
    if (length + line.length + 1 > MAX_CHARS) continue
    seen.add(line)
    lines.push(line)
    length += line.length + 1
    if (seen.size >= MAX_ITEMS) break
  }
  return seen.size ? lines.join("\n") : ""
}

export class LspContext {
  // The VS Code command has no cancellation argument. Avoid piling up requests
  // while a timed-out language provider is still running.
  private pending = false

  async get(document: TextDocument, position: Position, token: CancellationToken): Promise<string> {
    if (this.pending || token.isCancellationRequested) return ""
    const version = document.version
    const word = document.getWordRangeAtPosition(position)
    const prefix = word ? document.getText(new Range(word.start, position)) : ""
    this.pending = true

    return new Promise<string>((resolve) => {
      let settled = false
      const finish = (value: string) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        cancellation.dispose()
        resolve(value)
      }
      const timeout = setTimeout(() => finish(""), TIMEOUT_MS)
      const cancellation = token.onCancellationRequested(() => finish(""))
      // No resolve pass: use details already supplied by the language provider.
      // https://code.visualstudio.com/api/references/commands
      void (async () => {
        try {
          const list = await commands.executeCommand<CompletionList>(
            "vscode.executeCompletionItemProvider", document.uri, position
          )
          if (settled) return
          finish(document.version === version && !token.isCancellationRequested
            ? formatLspSuggestions(list?.items || [], prefix) : "")
        } catch {
          finish("")
        } finally {
          this.pending = false
        }
      })()
    })
  }
}
