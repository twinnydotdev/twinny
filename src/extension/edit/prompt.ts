/**
 * Inline edit prompts and reply parsing. Pure: no vscode, no network.
 *
 * The model is asked to return the rewritten code and nothing else, but
 * models being models, the reply is parsed defensively: a fenced block is
 * unwrapped (even while it is still streaming), reasoning tags are dropped,
 * and the original's indentation and trailing newline are restored.
 */
import { SYSTEM, USER } from "../../common/constants"
import { ChatCompletionMessage } from "../../common/types"

export interface EditRequest {
  /** What the user asked for, e.g. "add null checks". */
  instruction: string
  /** The code being rewritten. */
  code: string
  /** Language name for the prompt and the fence, e.g. "typescript". */
  language?: string
  /** Workspace-relative file name, shown to the model for context. */
  fileName?: string
  /** A few lines either side of the selection; never edited. */
  before?: string
  after?: string
}

/** How much of the file around the selection travels with the request. */
export const EDIT_CONTEXT_LINES = 40
export const EDIT_CONTEXT_CHARS = 6000

export const EDIT_SYSTEM_PROMPT = [
  "You are an expert programmer editing code inside the user's editor.",
  "You will be given a piece of code and an instruction.",
  "Rewrite the code so that it follows the instruction.",
  "",
  "Rules:",
  "- Reply with the rewritten code only. No explanation, no commentary, no markdown fences.",
  "- Return the complete replacement for the given code, not a diff and not a fragment.",
  "- Keep everything the instruction does not ask you to change: names, style, formatting, comments.",
  "- Do not repeat the surrounding context; it is shown for reference only.",
  "- If the instruction cannot be applied, return the code unchanged."
].join("\n")

const fence = (language: string | undefined, body: string) =>
  `\`\`\`${language || ""}\n${body}\n\`\`\``

/** The user turn: file, surrounding context, the code, and the instruction. */
export const buildEditPrompt = (request: EditRequest): string => {
  const parts: string[] = []
  if (request.fileName) parts.push(`File: ${request.fileName}`)

  const before = request.before?.trim()
  const after = request.after?.trim()
  if (before || after) {
    parts.push(
      "Surrounding code (for context only, do not include it in your reply):"
    )
    if (before) parts.push(fence(request.language, request.before || ""))
    if (before && after) parts.push("[... the code to edit goes here ...]")
    if (after) parts.push(fence(request.language, request.after || ""))
  }

  parts.push("Code to edit:")
  parts.push(fence(request.language, request.code))
  parts.push(`Instruction: ${request.instruction.trim()}`)
  parts.push("Reply with the rewritten code only.")
  return parts.join("\n\n")
}

export const buildEditMessages = (
  request: EditRequest
): ChatCompletionMessage[] => [
  { role: SYSTEM, content: EDIT_SYSTEM_PROMPT },
  { role: USER, content: buildEditPrompt(request) }
]

/** Drop `<think>…</think>`; an unterminated block (still streaming) yields "". */
const stripReasoning = (text: string) =>
  text
    .replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(think|thinking)>[\s\S]*$/i, "")

/**
 * The code inside the reply. Works on partial replies too, so the editor
 * can be updated as tokens arrive:
 *
 * - text before an opening fence is chatter and is dropped,
 * - an opening fence without its closing fence yields what came after it,
 * - a reply with no fence at all is taken verbatim.
 */
export const extractEditedCode = (reply: string): string => {
  const text = stripReasoning(reply)
  const open = text.match(/(^|\n)[ \t]*```[^\n]*\n?/)
  if (!open || open.index === undefined) return text.replace(/^\s*\n/, "")

  const start = open.index + open[0].length
  // The closing fence is a line of its own; "```js" inside the code is not.
  const close = text.slice(start).match(/(^|\n)[ \t]*```[ \t]*(\n|$)/)
  return close?.index === undefined
    ? text.slice(start)
    : text.slice(start, start + close.index)
}

/** The leading whitespace shared by every non-blank line. */
export const commonIndent = (text: string): string => {
  let indent: string | undefined
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    const lead = line.match(/^[ \t]*/)?.[0] ?? ""
    if (indent === undefined) {
      indent = lead
      continue
    }
    let i = 0
    while (i < indent.length && i < lead.length && indent[i] === lead[i]) i++
    indent = indent.slice(0, i)
    if (!indent) break
  }
  return indent ?? ""
}

/**
 * Line up the reply with the code it replaces. Models routinely strip the
 * indentation of a nested selection, or add one; the editor expects the
 * replacement to sit where the original sat.
 */
export const matchIndentation = (edited: string, original: string): string => {
  const wanted = commonIndent(original)
  const got = commonIndent(edited)
  if (wanted === got) return edited
  return edited
    .split("\n")
    .map((line) => {
      if (!line.trim()) return line
      const rest = line.startsWith(got) ? line.slice(got.length) : line
      return wanted + rest
    })
    .join("\n")
}

/**
 * The final replacement text for a completed reply: unwrapped, re-indented,
 * and ending the way the original ended.
 */
export const finalizeEdit = (reply: string, original: string): string => {
  let code = extractEditedCode(reply).replace(/\s+$/, "")
  if (!code.trim()) return original
  code = matchIndentation(code, original)
  const trailing = original.match(/(\r?\n)+$/)?.[0] ?? ""
  return code + trailing
}

/** Whole lines around a selection, capped so huge files stay affordable. */
export const clampContext = (text: string, fromEnd: boolean): string => {
  if (text.length <= EDIT_CONTEXT_CHARS) return text
  return fromEnd
    ? text.slice(text.length - EDIT_CONTEXT_CHARS)
    : text.slice(0, EDIT_CONTEXT_CHARS)
}
