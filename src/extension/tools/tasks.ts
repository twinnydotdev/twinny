/**
 * The model's own list of steps for work with several parts. It is the
 * one thing the model writes down for itself: the loop keeps it, shows it
 * to the user, and puts it back in front of the model when a reply runs
 * out of steps or a new turn begins, so a small model that has read six
 * files still knows what it set out to do and how far it got.
 */
import { parseLenientJson, ToolSpec } from "./protocol"

export interface Task {
  text: string
  done: boolean
}

const MAX_TASKS = 20
const MAX_TASK_CHARS = 200

export const TASKS_TOOL_NAME = "update_tasks"

export const TASKS_TOOL: ToolSpec = {
  name: TASKS_TOOL_NAME,
  description:
    "Write down your steps for work with several parts, or update the list. Send the whole list each time, one step per line: `[ ] step` for one still to do, `[x] step` for one done.",
  guidance:
    "For work with three or more parts, write the steps down first with update_tasks, and send the list again with `[x]` as you finish each. Do not use it for a question or a single change.",
  parameters: [{ name: "tasks", description: "The whole list, one step per line: `[ ] step` or `[x] step`." }]
}

const DONE_WORDS = /^(done|completed?|finished|x|true|yes)$/i

const fromJson = (value: unknown): Task[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const tasks: Task[] = []
  for (const entry of value) {
    if (typeof entry === "string") {
      const [task] = fromLines(entry)
      if (task) tasks.push(task)
    } else if (entry && typeof entry === "object") {
      const { text, task, content, title, step, done, completed, status } = entry as Record<string, unknown>
      const said = [text, task, content, title, step].find((v) => typeof v === "string" && v.trim()) as string | undefined
      if (!said) continue
      tasks.push({
        text: said.trim(),
        done: done === true || completed === true || DONE_WORDS.test(String(status ?? done ?? completed ?? ""))
      })
    }
  }
  return tasks
}

const fromLines = (text: string): Task[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      // `- [x] step`, `1. [ ] step`, `[X] step`, `✓ step`, or a bare line (still to do).
      const body = line.replace(/^(?:[-*•]|\d+[.)])\s+/, "")
      const box = body.match(/^\[([^\]]?)\]\s*(.*)$/)
      if (box) return { text: box[2].trim(), done: /^[xX✓✔]$/.test(box[1]) }
      const ticked = body.match(/^[✓✔☑]\s*(.*)$/)
      if (ticked) return { text: ticked[1].trim(), done: true }
      return { text: body.replace(/^[☐□]\s*/, "").trim(), done: false }
    })
    .filter((task) => task.text)

/** The list as the model sent it: checkbox lines, or JSON from a model that prefers it. Undefined when there is nothing in it. */
export const parseTasks = (raw: string | undefined): Task[] | undefined => {
  const text = raw?.trim()
  if (!text) return undefined
  const parsed = text.startsWith("[{") || text.startsWith("[\"") ? parseLenientJson(text) : undefined
  const tasks = (parsed && "value" in parsed ? fromJson(parsed.value) : undefined) ?? fromLines(text)
  const kept = tasks
    .slice(0, MAX_TASKS)
    .map((task) => ({ text: task.text.length > MAX_TASK_CHARS ? `${task.text.slice(0, MAX_TASK_CHARS)}…` : task.text, done: task.done }))
  return kept.length ? kept : undefined
}

export const renderTasks = (tasks: Task[]) => tasks.map((task) => `[${task.done ? "x" : " "}] ${task.text}`).join("\n")

export const sameTasks = (a: Task[], b: Task[]) =>
  a.length === b.length && a.every((task, i) => task.text === b[i].text && task.done === b[i].done)

/** `2 of 5 done`. */
export const tasksProgress = (tasks: Task[]) => `${tasks.filter((task) => task.done).length} of ${tasks.length} done`
