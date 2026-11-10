/**
 * What a starter asks, as a pure function of the file: a short, plain
 * instruction a small local model follows well, with the code attached
 * and cut to what the model's context has room for.
 */
import type { StarterKind } from "../../common/model-status"

const STARTER: Record<StarterKind, { verb: string; prompt: string }> = {
  explain: {
    verb: "Explain",
    prompt:
      "Explain what this code does. Start with one sentence on its purpose, then go through the main parts in order. Be brief."
  },
  bugs: {
    verb: "Find bugs in",
    prompt:
      "Look for bugs in this code. List each one with its line, why it is wrong, and the fix. If you find none, say so; do not invent problems."
  },
  tests: {
    verb: "Write tests for",
    prompt:
      "Write unit tests for this code, in the test framework this project already uses if you can tell. Cover the main paths and the edge cases."
  }
}

/** The attached code may take this share of the model's context. */
const CODE_SHARE = 0.5
const CHARS_PER_TOKEN = 3
const ASSUMED_WINDOW = 8192

export const starterRequest = (
  kind: StarterKind,
  file: { path: string; text: string; selection?: { startLine: number; endLine: number } },
  contextWindow?: number
) => {
  const room = Math.floor((contextWindow || ASSUMED_WINDOW) * CODE_SHARE * CHARS_PER_TOKEN)
  const cut = file.text.length > room
  const content = cut ? `${file.text.slice(0, room)}\n… (cut here: the rest does not fit the model's context)` : file.text
  const lines = file.selection ? ` (lines ${file.selection.startLine + 1}–${file.selection.endLine + 1})` : ""
  return {
    display: `${STARTER[kind].verb} ${file.path}${lines}`,
    prompt: STARTER[kind].prompt,
    entry: { path: file.path, content, ...(file.selection ? { range: file.selection } : {}) },
    cut
  }
}
