/**
 * What the chat composer suggests as grey text ahead of the cursor.
 *
 * Two sources: a word predictor in the manner of a phone keyboard, built
 * from what the user has typed before and run on every key, and a model's
 * guess at the rest of the message from the last few exchanges, which
 * takes over once a conversation has some. Both are plain functions here,
 * with no editor or model in sight.
 */

const WORD = /[A-Za-z][A-Za-z0-9_'-]*/g
/** A partial word shorter than this is too open to guess at. */
const MIN_PREFIX = 2
/** Words the user typed count for this many seed words. */
const TYPED_WEIGHT = 20
const MODEL_MAX_CHARS = 80

/**
 * Words anyone asking a coding assistant types, so the predictor has
 * something to offer before the user has typed anything of their own.
 * Earlier words rank higher.
 */
const SEED_WORDS = (
  "the this that what with which would should could there their they these " +
  "function functions file files error errors explain example because before " +
  "between better change changes check class component components config " +
  "configuration create current default different directory document " +
  "documentation everything exception expected extension implement " +
  "implementation import information instead interface javascript language " +
  "message method module notice number object option options output " +
  "parameter parameters performance please possible problem project property " +
  "python question really refactor request response return returns rewrite " +
  "something string structure suggest support terminal typescript understand " +
  "update variable variables version without working workspace write"
).split(" ")

export interface WordModel {
  /** Count per lowercased word, and the spelling seen most for it. */
  words: Map<string, { count: number; form: string }>
  /** Previous word → next word → count, lowercased. */
  follows: Map<string, Map<string, number>>
}

/** A word model from the texts given, most telling first or last alike. */
export const buildWordModel = (texts: string[]): WordModel => {
  const words: WordModel["words"] = new Map()
  const follows: WordModel["follows"] = new Map()
  SEED_WORDS.forEach((word, i) => {
    words.set(word, { count: (SEED_WORDS.length - i) / SEED_WORDS.length, form: word })
  })
  for (const text of texts) {
    // Code says little about how the user writes; leave it out.
    const prose = text.replace(/```[\s\S]*?(```|$)/g, " ")
    // Sentences end a run of words: "done. Then" says nothing about "then".
    for (const sentence of prose.split(/[.!?\n]+/)) {
      let previous: string | undefined
      for (const match of sentence.matchAll(WORD)) {
        const form = match[0]
        const key = form.toLowerCase()
        const entry = words.get(key)
        if (entry && entry.count >= 1) entry.count += TYPED_WEIGHT
        else words.set(key, { count: TYPED_WEIGHT + (entry?.count ?? 0), form })
        if (previous) {
          const next = follows.get(previous) ?? new Map<string, number>()
          next.set(key, (next.get(key) ?? 0) + 1)
          follows.set(previous, next)
        }
        previous = key
      }
    }
  }
  return { words, follows }
}

const lastWord = (text: string): string | undefined =>
  text.match(/([A-Za-z][A-Za-z0-9_'-]*)[^A-Za-z0-9_'.!?\n-]*$/)?.[1]?.toLowerCase()

/**
 * The rest of the word being typed, likelier when it has followed the
 * word before; empty when nothing stands out. A word not yet begun is
 * never guessed: that is left to the model's sentence.
 */
export const predictWord = (draft: string, model: WordModel): string => {
  if (!draft.trim()) return ""
  const partial = draft.match(/(?:^|[^A-Za-z0-9_'-])([A-Za-z][A-Za-z0-9_'-]*)$/)?.[1]

  if (partial) {
    if (partial.length < MIN_PREFIX) return ""
    const prefix = partial.toLowerCase()
    const before = lastWord(draft.slice(0, -partial.length))
    const after = before ? model.follows.get(before) : undefined
    let best: { key: string; form: string; score: number } | undefined
    for (const [key, { count, form }] of model.words) {
      if (key.length <= prefix.length || !key.startsWith(prefix)) continue
      const score = count + (after?.get(key) ?? 0) * TYPED_WEIGHT * 2
      if (!best || score > best.score) best = { key, form, score }
    }
    // "the" is more often meant than "there": a typed word that is a
    // likelier word than any longer one is left alone.
    if (!best || (model.words.get(prefix)?.count ?? 0) >= best.score) return ""
    // The user's own letters stay as typed; the rest as the word is usually spelt.
    const rest = best.form.slice(prefix.length)
    return partial === partial.toUpperCase() && partial.length > 1 ? rest.toUpperCase() : rest
  }

  return ""
}

/** Each earlier turn shown to the model is cut to this. */
const TURN_CHARS = 400

/** The model is shown, and says again, at most this much of the draft. */
const DRAFT_CHARS = 240

/**
 * The part of the draft a model finishes: its last line, and of a long
 * one only the end, cut at a word.
 */
export const suggestionDraft = (draft: string): string => {
  const line = draft.slice(draft.lastIndexOf("\n") + 1)
  if (line.length <= DRAFT_CHARS) return line
  const tail = line.slice(-DRAFT_CHARS)
  return tail.slice(tail.search(/\s/) + 1)
}

/**
 * A chat model asked about a draft answers it, as it answers everything.
 * Told it is a keyboard's predictor, and shown drafts finished in the
 * user's own words, it finishes the next the same way. It writes the
 * whole message out, draft first: a draft may stop inside a word, and
 * only with the draft said again is it plain whether the guess went on
 * with that word ("cen" → "center") or began the next one.
 */
const PREDICTOR_SYSTEM =
  "You are an autocomplete engine inside a chat box, like the predictive " +
  "text on a phone keyboard. You never answer, explain or help. You are " +
  "given the user's unfinished message, which may stop in the middle of a " +
  "word. Write out the whole message, finished: first the unfinished " +
  "message exactly as given, character for character, then the few words " +
  "that finish it, in the user's voice. Output only the finished message."

const EXAMPLES: [conversation: string, draft: string, finished: string][] = [
  [
    "User: my python script is slow\nAssistant: Profile it with cProfile to see where the time goes.",
    "how do I ",
    "how do I run cProfile on a script with arguments?"
  ],
  [
    "User: what is a monad\nAssistant: A monad is a way of chaining computations that carry context.",
    "can you show an exa",
    "can you show an example in TypeScript?"
  ],
  [
    "(none)",
    "is there a faster way",
    "is there a faster way to sort a list?"
  ]
]

const predictorTurn = (conversation: string, draft: string) =>
  `Conversation so far:\n${conversation}\n\n` +
  `The user's unfinished message:\n<draft>${draft}</draft>\n\n` +
  "The finished message:"

/** The messages that ask a chat model for the rest of the draft. */
export const composerSuggestionMessages = (
  draft: string,
  recent: { role: string; content: string }[]
): { role: "system" | "user" | "assistant"; content: string }[] => {
  const conversation = recent
    .map(({ role, content }) => {
      const text = content.replace(/```[\s\S]*?(```|$)/g, "[code]").trim()
      const short = text.length > TURN_CHARS ? `${text.slice(0, TURN_CHARS)}…` : text
      return `${role === "user" ? "User" : "Assistant"}: ${short}`
    })
    .join("\n\n")
  return [
    { role: "system", content: PREDICTOR_SYSTEM },
    ...EXAMPLES.flatMap(([example, exampleDraft, rest]) => [
      { role: "user" as const, content: predictorTurn(example, exampleDraft) },
      { role: "assistant" as const, content: rest }
    ]),
    { role: "user", content: predictorTurn(conversation || "(none)", suggestionDraft(draft)) }
  ]
}

/**
 * Where the model is asked for the rest: anywhere in a message that has
 * begun, a word half typed included, but not after a sentence has ended.
 */
export const wantsModelSuggestion = (draft: string): boolean =>
  draft.trim().length >= 3 && !/[.?!]\s*$/.test(draft)

/**
 * A model's guess at the rest of the message made fit to show after the
 * draft: one line, without the draft said again, quotes, or a reply to
 * it instead of a continuation. Empty when nothing usable is left.
 */
export const cleanModelSuggestion = (draft: string, raw: string): string => {
  let text = (raw.split("\n").map((line) => line.trim()).find(Boolean) ?? "")
    .replace(/^(continuation|completion|suggestion)\s*:\s*/i, "")
    .trim()
  // Quotes round the whole guess, not ones that belong to it.
  const quoted = text.match(/^(["'`])(.*)\1$/s)
  if (quoted) text = quoted[2].trim()
  const typed = suggestionDraft(draft).trim()
  const endsInSpace = /\s$/.test(draft)
  const midWord = /[A-Za-z0-9_'-]$/.test(draft)
  /** What goes between the draft and the guess. */
  let lead = endsInSpace ? "" : " "
  /** Whether the guess said enough of the draft again to show where it joins. */
  let anchored = false
  /**
   * Drops the guess up to where it says `said` again, when the draft
   * could have got that far. A model that says the draft again may mend
   * a typo on the way ("witht his" → "with this"), so past the very
   * start the place is looked for, nearest where the draft would end.
   */
  const cut = (said: string, inWord: boolean, anywhere = false): boolean => {
    if (!said) return false
    const lower = text.toLowerCase()
    const needle = said.toLowerCase()
    const expected = typed.length - said.length
    let at = -1
    for (let i = lower.indexOf(needle); i !== -1; i = anywhere ? lower.indexOf(needle, i + 1) : -1) {
      const rest = text.slice(i + said.length)
      // "can you " said again is not the start of "can your", nor "his" the end of "this".
      const whole = (i === 0 || /\s/.test(text[i - 1])) && (inWord || !rest || /^\s/.test(rest))
      if (whole && (at === -1 || Math.abs(i - expected) < Math.abs(at - expected))) at = i
      if (!anywhere && i !== 0) break
    }
    if (at === -1 || (!anywhere && at !== 0)) return false
    const rest = text.slice(at + said.length)
    if (!endsInSpace) lead = /^\s/.test(rest) ? " " : ""
    text = rest.trim()
    anchored = true
    return true
  }
  if (typed && !cut(typed, !endsInSpace)) {
    // Otherwise by the last few words, or just the last ("what if" →
    // "if I want…"); a word cut short needs three letters to go by.
    const words = typed.split(/\s+/)
    for (let n = Math.min(3, words.length); n > 0; n--) {
      const tail = words.slice(-n).join(" ")
      if (n > 1 && tail.length < 6) continue
      if (cut(tail, midWord && tail.length >= 3, true)) break
    }
    // The draft begun again with nothing to place it by is not the rest of it.
    const first = words[0].toLowerCase()
    if (!anchored && words.length > 1 && text.toLowerCase().split(/\s+/)[0] === first) return ""
  }
  // A guess that never said the half-typed word again cannot be joined to it.
  if (midWord && !anchored) return ""
  if (!text || /^[^A-Za-z0-9@`(]/.test(text)) return ""
  if (/^(sure|certainly|of course|here('s| is)|i (can|will|would)|as an ai|you (can|could|should|need|might)|this is because|it'?s because)\b/i.test(text)) return ""

  // Up to the end of the first sentence, and not past the cap.
  const sentence = text.match(/^.*?[.?!](?=\s|$)/)?.[0] ?? text
  text = sentence.length <= MODEL_MAX_CHARS
    ? sentence
    : sentence.slice(0, MODEL_MAX_CHARS).replace(/\s+\S*$/, "")
  if (!text) return ""
  return `${lead}${text}`
}
