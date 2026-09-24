/**
 * Reviews: what one of the gateway's own models makes of a pull. Kept on
 * the server, per pull and head commit, in the plugin's reviews.json;
 * shown on the pull's page, and posted to the host only when asked (or auto-post is on).
 *
 * A review is asked for with the button, or made in the background for
 * repositories with auto-review on: one at a time, only for pulls that
 * have no review of their current commit, and only while no developer
 * request is in flight, so completions and chats always come first.
 *
 * A finished review can be asked about: each question goes to the same
 * model with the pull, the review and the earlier questions in front of
 * it, and the exchange is kept on the review as its thread.
 */
import fs from "node:fs"

import { messageOf } from "../../common/errors"
import { isRecord } from "../../common/guards"
import type { ChatMessage } from "../../extension/inference/types"
import { writePrivateJson } from "../private-file"

import type { PullDetail, PullSummary } from "./forge"
import { PluginError } from "./host"
import { type PluginInference, repoWorkspace } from "./inference"

/** Characters of description and patches a prompt may carry, for small local contexts. */
export const REVIEW_PROMPT_BUDGET = 24_000
const DESCRIPTION_BUDGET = 3_000
/** Room for the answer, and for a reasoning model that thinks first despite being asked not to. */
export const REVIEW_MAX_TOKENS = 4_000
export const REVIEW_TIMEOUT_MS = 10 * 60_000
/** A follow-up answer is shorter than a review. */
export const ASK_MAX_TOKENS = 2_000
export const ASK_TIMEOUT_MS = 5 * 60_000
/** Characters a question may have. */
const QUESTION_LIMIT = 4_000
/** Earlier turns a question carries; older ones are kept on the record but left out of the prompt. */
const THREAD_CONTEXT_TURNS = 20
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
  /** Why the text ends early, when the model stopped before finishing. */
  cutShort?: string
  /** Questions asked about the review and the model's answers, oldest first. */
  thread?: ReviewTurn[]
  /** When and how it was posted to the host, if it was. */
  postedAt?: string
  postedAs?: ReviewPostAs
  postedUrl?: string
  postedBy?: string
}

export type ReviewPostAs = "comment" | "request-changes" | "approve"

export interface ReviewTurn {
  role: "user" | "assistant"
  text: string
  at: string
  /** The admin key that asked, on a question. */
  by?: string
  /** How long the answer took, on an answer. */
  ms?: number
  /** Why the answer ends early, when it does. */
  cutShort?: string
}

/** What a listing carries per pull, to mark it without the text. */
export interface ReviewBrief {
  createdAt: string
  alias: string
  status: ReviewRecord["status"]
  stale: boolean
  posted?: boolean
}

interface ReviewsFile {
  version: 1
  reviews: ReviewRecord[]
}

/** The turns that are whole; a damaged one is dropped rather than failing the file. */
const parseThread = (entries: unknown[]): ReviewTurn[] =>
  entries.flatMap((entry) =>
    isRecord(entry) &&
    (entry.role === "user" || entry.role === "assistant") &&
    typeof entry.text === "string" &&
    typeof entry.at === "string"
      ? [
          {
            role: entry.role,
            text: entry.text,
            at: entry.at,
            ...(typeof entry.by === "string" ? { by: entry.by } : {}),
            ...(typeof entry.ms === "number" ? { ms: entry.ms } : {}),
            ...(typeof entry.cutShort === "string" ? { cutShort: entry.cutShort } : {})
          }
        ]
      : []
  )

const parseReviewsFile = (text: string, file: string): ReviewsFile => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `${file} is not valid JSON: ${messageOf(error)}`
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
      ...(typeof entry.error === "string" ? { error: entry.error } : {}),
      ...(typeof entry.cutShort === "string" ? { cutShort: entry.cutShort } : {}),
      ...(Array.isArray(entry.thread) ? { thread: parseThread(entry.thread) } : {}),
      ...(typeof entry.postedAt === "string" ? { postedAt: entry.postedAt } : {}),
      ...(entry.postedAs === "comment" || entry.postedAs === "request-changes" || entry.postedAs === "approve" ? { postedAs: entry.postedAs } : {}),
      ...(typeof entry.postedUrl === "string" ? { postedUrl: entry.postedUrl } : {}),
      ...(typeof entry.postedBy === "string" ? { postedBy: entry.postedBy } : {})
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
        stale: review.headSha !== pull.headSha,
        ...(review.postedAt ? { posted: true } : {})
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
    const content: ReviewsFile = { version: 1, reviews: this._reviews }
    writePrivateJson(this.file, content)
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

/**
 * The answer without any inline thinking: some reasoning models put their
 * thoughts in `<think>…</think>` in the content itself. An unclosed block
 * (a budget spent thinking) leaves nothing.
 */
export const stripThinking = (text: string): string =>
  text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trim()

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
    if (this._running.has(`${key}:ask`))
      throw new PluginError(
        `A question about ${job.pull.repo}#${job.pull.number}'s review is being answered; review again when it is.`,
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
      const { text, thought, cut } = await this.generate(
        inference,
        job.alias,
        reviewMessages(detail, job.noun),
        REVIEW_MAX_TOKENS,
        signal,
        repoWorkspace(job.pull.repo)
      )
      const answer = stripThinking(text)
      const review: ReviewRecord = {
        ...base,
        createdAt: new Date(this._now()).toISOString(),
        ms: this._now() - started,
        status: answer ? "done" : "failed",
        text: answer,
        ...(answer
          ? cut
            ? { cutShort: cutShortNotice("review", REVIEW_MAX_TOKENS, thought) }
            : {}
          : {
              error: thought
                ? `The model spent its whole answer thinking (${thought.toLocaleString("en-US")} characters of reasoning) and never wrote the review. Pick a model that does not reason, or one that honours "think: false".`
                : text.trim()
                  ? "The model answered only with thinking and no review."
                  : "The model answered nothing. Check the alias on Providers & models, and that the model is loaded."
            })
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
        error: messageOf(error)
      }
      this._store.put(review)
      return review
    } finally {
      this._running.delete(key)
      this._busy = false
    }
  }

  /**
   * Answers a question about a pull's latest finished review, with the
   * pull, the review and the thread so far in front of the model, and
   * keeps the exchange on the review. Throws when the question cannot be
   * taken; a model failure is an error too, and leaves the thread as it was.
   */
  public async ask(job: ReviewJob, question: string, signal: AbortSignal): Promise<ReviewRecord> {
    const inference = this._inference
    if (!inference)
      throw new PluginError("This gateway offers plugins no models, so nothing can answer.", 503)
    const asked = question.trim()
    if (!asked) throw new PluginError("Ask something about the review.", 400)
    if (asked.length > QUESTION_LIMIT)
      throw new PluginError(`Keep a question under ${QUESTION_LIMIT.toLocaleString("en-US")} characters.`, 400)
    const review = this._store.latest(job.repoId, job.pull.number)
    if (!review || review.status !== "done")
      throw new PluginError("There is no finished review to ask about.", 409)
    const key = `${job.repoId}#${job.pull.number}`
    if (this._running.has(key))
      throw new PluginError(`${job.pull.repo}#${job.pull.number} is being reviewed right now; ask when it is done.`, 409)
    if (this._running.has(`${key}:ask`))
      throw new PluginError("An earlier question is still being answered.", 409)
    if (!inference.chatAliases().includes(job.alias))
      throw new PluginError(`No chat model is served as "${job.alias}". Pick a review model on the plugin's page.`, 409)
    this._running.add(`${key}:ask`)
    this._busy = true
    const started = this._now()
    try {
      const detail = await job.detail()
      const earlier = (review.thread ?? []).slice(-THREAD_CONTEXT_TURNS)
      const messages: ChatMessage[] = [
        ...reviewMessages(detail, job.noun),
        { role: "assistant", content: review.text },
        ...earlier.map((turn): ChatMessage => ({ role: turn.role, content: turn.text })),
        { role: "user", content: asked }
      ]
      const { text, thought, cut } = await this.generate(
        inference,
        job.alias,
        messages,
        ASK_MAX_TOKENS,
        signal,
        repoWorkspace(job.pull.repo)
      )
      const answer = stripThinking(text)
      if (!answer)
        throw new PluginError(
          thought
            ? `The model spent its whole answer thinking (${thought.toLocaleString("en-US")} characters of reasoning) and never answered.`
            : "The model answered nothing.",
          502
        )
      const now = new Date(this._now()).toISOString()
      const updated: ReviewRecord = {
        ...review,
        thread: [
          ...(review.thread ?? []),
          { role: "user", text: asked, at: now, by: job.requestedBy },
          {
            role: "assistant",
            text: answer,
            at: now,
            ms: this._now() - started,
            ...(cut ? { cutShort: cutShortNotice("answer", ASK_MAX_TOKENS, thought) } : {})
          }
        ]
      }
      this._store.put(updated)
      return updated
    } finally {
      this._running.delete(`${key}:ask`)
      this._busy = false
    }
  }

  /** One answer, whole, with how much of it was thinking and whether the cap cut it. */
  private async generate(
    inference: PluginInference,
    alias: string,
    messages: ChatMessage[],
    maxTokens: number,
    signal: AbortSignal,
    workspace: string
  ): Promise<{ text: string; thought: number; cut: boolean }> {
    let text = ""
    let thought = 0
    let cut = false
    for await (const piece of inference.chat(alias, messages, {
      signal,
      maxTokens,
      temperature: 0.2,
      think: false,
      onReasoning: (reasoning) => (thought += reasoning.length),
      onFinish: (reason) => (cut = reason === "length"),
      workspace
    }))
      text += piece
    return { text, thought, cut }
  }
}

/** Why an answer ends early, for the page and the record. */
const cutShortNotice = (what: "review" | "answer", limit: number, thought: number): string =>
  `The model reached the ${what}'s limit of ${limit.toLocaleString("en-US")} output tokens before it finished` +
  (thought
    ? `, after spending ${thought.toLocaleString("en-US")} characters of that on thinking. Pick a model that does not reason, or one that honours "think: false".`
    : ". Try a model that writes more briefly, or ask about what is missing.")
