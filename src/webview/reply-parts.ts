import { ToolStepView } from "../common/types"

export type ReplyPart = { text: string } | { steps: ToolStepView[] }

/** Where an open ``` fence before `at` closes, so a split never lands inside a code block. */
const outsideFence = (text: string, at: number) => {
  const fences = text.slice(0, at).match(/^[ \t]*(```|~~~)/gm)?.length ?? 0
  if (fences % 2 === 0) return at
  const close = /^[ \t]*(```|~~~)[^\n]*$/gm
  close.lastIndex = at
  const found = close.exec(text)
  return found ? found.index + found[0].length : text.length
}

/**
 * A reply's text cut where its tools ran, with each run of steps in its
 * place: what the model said, the tools it then used, what it said next.
 * Steps saved without a place go first, as they used to.
 */
export const replyParts = (text: string, steps?: ToolStepView[]): ReplyPart[] => {
  if (!steps?.length) return [{ text }]
  const groups = new Map<number, ToolStepView[]>()
  for (const step of steps) {
    const at = outsideFence(text, Math.min(Math.max(step.at ?? 0, 0), text.length))
    groups.set(at, [...(groups.get(at) ?? []), step])
  }
  const parts: ReplyPart[] = []
  let from = 0
  for (const at of [...groups.keys()].sort((a, b) => a - b)) {
    if (at > from) parts.push({ text: text.slice(from, at) })
    parts.push({ steps: groups.get(at)! })
    from = at
  }
  if (from < text.length) parts.push({ text: text.slice(from) })
  return parts
}
