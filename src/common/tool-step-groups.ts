/**
 * A long stretch of looking around (a dozen reads, a few searches) told
 * as one line in the chat: "read 9 files · 3 searches", which opens to
 * the steps themselves. Plain data and functions, no editor in sight.
 */
import { ToolStepView } from "./types"

export type LookKind = "read" | "search" | "list"

const LOOK_KINDS: Record<string, LookKind> = {
  read_file: "read",
  grep: "search",
  search_code: "search",
  find_files: "search",
  find_symbol: "search",
  find_references: "search",
  go_to_definition: "search",
  list_dir: "list"
}

/** Fewer than this in a row and the steps stay as they are: two lines need no folding. */
export const MIN_GROUPED_STEPS = 3

export interface StepGroup {
  /** The first step's id: the same while the group grows, so it stays open if opened. */
  id: string
  steps: ToolStepView[]
  /** Files read, each counted once however many slices of it were read. */
  files: number
  searches: number
  lists: number
}

/** What kind of looking a finished step was, or undefined for a step that stands alone. */
export const lookKindOf = (step: ToolStepView): LookKind | undefined =>
  step.status === "done" && !step.said ? LOOK_KINDS[step.name] : undefined

/** The files a read step read: its path, or each of the several one call took. */
const filesRead = (step: ToolStepView): string[] => {
  const one = step.args?.path?.trim()
  const several = (step.args?.paths ?? "")
    .split(/[\n,]/)
    .map((item) => item.replace(/["'`[\]]/g, "").trim())
    .filter(Boolean)
  const files = [...(one ? [one] : []), ...several]
  return files.length ? files : [step.id]
}

const groupOf = (steps: ToolStepView[]): StepGroup => {
  const kinds = steps.map(lookKindOf)
  const reads = steps.filter((_, i) => kinds[i] === "read")
  return {
    id: steps[0].id,
    steps,
    files: new Set(reads.flatMap((step) => filesRead(step))).size,
    searches: kinds.filter((kind) => kind === "search").length,
    lists: kinds.filter((kind) => kind === "list").length
  }
}

export const isStepGroup = (item: ToolStepView | StepGroup): item is StepGroup => "steps" in item

/**
 * The steps in order, with each run of finished reads, searches and
 * listings folded into a group. Anything that changed something, ran a
 * command, failed, is still going or was said by the user stays its own
 * line, and ends the run before it.
 */
export const groupSteps = (steps: ToolStepView[], min = MIN_GROUPED_STEPS): (ToolStepView | StepGroup)[] => {
  const out: (ToolStepView | StepGroup)[] = []
  let run: ToolStepView[] = []
  const flush = () => {
    if (run.length >= min) out.push(groupOf(run))
    else out.push(...run)
    run = []
  }
  for (const step of steps) {
    if (lookKindOf(step)) {
      run.push(step)
    } else {
      flush()
      out.push(step)
    }
  }
  flush()
  return out
}
