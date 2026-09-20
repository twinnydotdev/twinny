/**
 * Reviews: what one of the gateway's own models makes of a pull. Kept on
 * the server, per pull and head commit, in the plugin's reviews.json;
 * shown on the pull's page and never posted anywhere.
 *
 * A review is asked for with the button, or made in the background for
 * repositories with auto-review on: one at a time, only for pulls that
 * have no review of their current commit, and only while no developer
 * request is in flight, so completions and chats always come first.
 */
import fs from "node:fs"
import path from "node:path"

import type { ChatMessage } from "../../extension/inference/types"

import { PluginError } from "./host"
import type { PluginInference } from "./inference"
import type { PullDetail, PullSummary } from "./pulls"

/** Characters of description and patches a prompt may carry, for small local contexts. */
export const REVIEW_PROMPT_BUDGET = 24_000
const DESCRIPTION_BUDGET = 3_000
export const REVIEW_MAX_TOKENS = 1_500
export const REVIEW_TIMEOUT_MS = 10 * 60_000
/** Reviews kept per plugin; the oldest go first. */
const MAX_REVIEWS = 1_000

export interface ReviewRecord {
  repoId: string
  number: number
  /** The commit reviewed; a pull that moved on shows the review as stale. */
  headSha: string
  alias: string
  /** `auto`, or the admin key that pressed the button. */
  requestedBy: string
  createdAt: string
  ms: number
  status: "done" | "failed"
  text: string
  error?: string
}

/** What a listing carries per pull, to mark it without the text. */
export interface ReviewBrief {
  createdAt: string
  alias: string
  status: ReviewRecord["status"]
  stale: boolean
}

interface ReviewsFile {
  version: 1
  reviews: ReviewRecord[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseReviewsFile = (text: string, file: string): ReviewsFile => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.reviews))
    throw new Error(`${file} is not a twinny-server reviews file.`)
  const reviews: ReviewRecord[] = []
  for (const entry of parsed.reviews) {
    if (
      !isRecord(entry) ||
      typeof entry.repoId !== "string" ||
      typeof entry.number !== "number" ||
      typeof entry.headSha !== "string" ||
      typeof entry.alias !== "string" ||
      typeof entry.createdAt !== "string" ||
      typeof entry.text !== "string" ||
      (entry.status !== "done" && entry.status !== "failed")
    )
      throw new Error(`${file} has a malformed review.`)
    reviews.push({
      repoId: entry.repoId,
      number: entry.number,
      headSha: entry.headSha,
      alias: entry.alias,
      requestedBy: typeof entry.requestedBy === "string" ? entry.requestedBy : "auto",
      createdAt: entry.createdAt,
      ms: typeof entry.ms === "number" ? entry.ms : 0,
      status: entry.status,
      text: entry.text,
      ...(typeof entry.error === "string" ? { error: entry.error } : {})
    })
  }
  return { version: 1, reviews }
}

export class ReviewStore {
  private _reviews: ReviewRecord[] = []

  constructor(public readonly file: string) {}

  public static open(file: string): ReviewStore {
    const store = new ReviewStore(file)
    store.reload()
    return store
  }

  /** The newest review of a pull, whichever commit it was for. */
  public latest(repoId: string, number: number): ReviewRecord | undefined {
    const mine = this._reviews.filter(
      (review) => review.repoId === repoId && review.number === number
    )
    return mine.length ? { ...mine[mine.length - 1] } : undefined
  }

  /** Whether the pull's current commit has a finished review. */
  public hasCurrent(pull: PullSummary, repoId: string): boolean {
    return this._reviews.some(
      (review) =>
        review.repoId === repoId &&
        review.number === pull.number &&
        review.headSha === pull.headSha &&
        review.status === "done"
    )
  }

  public brief(repoId: string, pull: PullSummary): ReviewBrief | undefined {
    const review = this.latest(repoId, pull.number)
    return (
      review && {
        createdAt: review.createdAt,
        alias: review.alias,
        status: review.status,
        stale: review.headSha !== pull.headSha
      }
    )
  }

  /** Keeps a review, replacing any earlier one of the same pull and commit. */
  public put(review: ReviewRecord): void {
    this._reviews = this._reviews.filter(
      (entry) =>
        !(
          entry.repoId === review.repoId &&
          entry.number === review.number &&
          entry.headSha === review.headSha
        )
    )
    this._reviews.push(review)
    if (this._reviews.length > MAX_REVIEWS)
      this._reviews = this._reviews.slice(-MAX_REVIEWS)
    this.save()
  }

  public forgetRepo(repoId: string): void {
    const before = this._reviews.length
    this._reviews = this._reviews.filter((review) => review.repoId !== repoId)
    if (this._reviews.length !== before) this.save()
  }

  public reload(): void {
    try {
      this._reviews = parseReviewsFile(
        fs.readFileSync(this.file, "utf8"),
        this.file
      ).reviews
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this._reviews = []
        return
      }
      throw error
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const content: ReviewsFile = { version: 1, reviews: this._reviews }
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(content, null, 2)}\n`, {
      mode: 0o600
    })
    fs.renameSync(tmp, this.file)
  }
}

const SYSTEM_PROMPT = `You are a careful senior engineer reviewing a pull request for a teammate. You see the description and the diff, nothing else: do not guess at code you cannot see.

Answer in Markdown with exactly these sections:

## Summary
Two or three sentences on what the change does.

## Issues
Bugs, regressions, security or data risks, and missing tests, each as a bullet naming the file and what is wrong. Write "None found." if there are none.

## Suggestions
Smaller improvements, each as a bullet. Write "None." if there are none.

## Verdict
One line: "Approve", "Request changes" or "Comment", then why in one sentence.

Be specific and brief. Do not repeat the diff back. Do not praise.`

/** The prompt for a pull: description first, then patches until the budget runs out. */
export const reviewMessages = (
  detail: PullDetail,
  noun: string
): ChatMessage[] => {
  const { pull } = detail
  const description = detail.body.trim()
  const head = [
    `# ${noun} ${pull.repo}#${pull.number}: ${pull.title}`,
    `Author: ${pull.author}. Branch \`${pull.headRef}\` into \`${pull.baseRef}\`.${pull.draft ? " Marked as a draft." : ""}`,
    pull.labels.length ? `Labels: ${pull.labels.join(", ")}.` : "",
    "",
    "## Description",
    description
      ? description.length > DESCRIPTION_BUDGET
        ? `${description.slice(0, DESCRIPTION_BUDGET)}\n\n[description cut here]`
        : description
      : "(none)",
    "",
    "## Changes"
  ]
    .filter((line) => line !== undefined)
    .join("\n")
  let budget = REVIEW_PROMPT_BUDGET - head.length
  const parts: string[] = []
  let left = detail.moreFiles
  for (const file of detail.files) {
    const title = `### ${file.status} ${file.previousPath ? `${file.previousPath} → ` : ""}${file.path} (+${file.additions} −${file.deletions})`
    const patch = file.patch ? `\`\`\`diff\n${file.patch}\n\`\`\`` : "(no diff available)"
    const cost = title.length + patch.length + 2
    if (cost > budget) {
      // A patch that does not fit is named, so the reviewer knows it exists.
      if (title.length + 40 <= budget) {
        parts.push(`${title}\n(diff left out: too large for this review)`)
        budget -= title.length + 40
      } else left++
      continue
    }
    parts.push(`${title}\n${patch}`)
    budget -= cost
  }
  if (left > 0) parts.push(`(${left} more changed files not shown)`)
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `${head}\n\n${parts.join("\n\n")}` }
  ]
}

export interface ReviewJob {
  repoId: string
  pull: PullSummary
  detail: () => Promise<PullDetail>
  alias: string
  requestedBy: string
  noun: string
}

/** Runs reviews through the gateway's models, one at a time. */
export class Reviewer {
  private readonly _running = new Set<string>()
  private _busy = false

  constructor(
    private readonly _store: ReviewStore,
    private readonly _inference: PluginInference | undefined,
    private readonly _now: () => number = Date.now
  ) {}

  public get available(): boolean {
    return this._inference !== undefined
  }

  public aliases(): string[] {
    return this._inference?.chatAliases() ?? []
  }

  public isReviewing(repoId: string, number: number): boolean {
    return this._running.has(`${repoId}#${number}`)
  }

  /** Whether a background review may start now: nothing else running, developers idle. */
  public idle(): boolean {
    return !this._busy && (this._inference?.active() ?? 1) === 0
  }

  public get busy(): boolean {
    return this._busy
  }

  public async review(job: ReviewJob, signal: AbortSignal): Promise<ReviewRecord> {
    const inference = this._inference
    if (!inference)
      throw new PluginError(
        "This gateway offers plugins no models, so reviews are unavailable.",
        503
      )
    const key = `${job.repoId}#${job.pull.number}`
    if (this._running.has(key))
      throw new PluginError(
        `${job.pull.repo}#${job.pull.number} is being reviewed already.`,
        409
      )
    if (!inference.chatAliases().includes(job.alias))
      throw new PluginError(
        `No chat model is served as "${job.alias}". Pick a review model on the plugin's page.`,
        409
      )
    this._running.add(key)
    this._busy = true
    const started = this._now()
    const base = {
      repoId: job.repoId,
      number: job.pull.number,
      headSha: job.pull.headSha,
      alias: job.alias,
      requestedBy: job.requestedBy
    }
    try {
      const detail = await job.detail()
      let text = ""
      for await (const piece of inference.chat(
        job.alias,
        reviewMessages(detail, job.noun),
        { signal, maxTokens: REVIEW_MAX_TOKENS, temperature: 0.2 }
      ))
        text += piece
      const review: ReviewRecord = {
        ...base,
        createdAt: new Date(this._now()).toISOString(),
        ms: this._now() - started,
        status: text.trim() ? "done" : "failed",
        text: text.trim(),
        ...(text.trim() ? {} : { error: "The model answered nothing." })
      }
      this._store.put(review)
      return review
    } catch (error) {
      const review: ReviewRecord = {
        ...base,
        createdAt: new Date(this._now()).toISOString(),
        ms: this._now() - started,
        status: "failed",
        text: "",
        error: error instanceof Error ? error.message : String(error)
      }
      this._store.put(review)
      return review
    } finally {
      this._running.delete(key)
      this._busy = false
    }
  }
}
