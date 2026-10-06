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
/** A next word must have followed the previous one this often. */
const MIN_FOLLOWS = 2
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
 * The rest of the word being typed, or after a space the word that most
 * often comes next; empty when nothing stands out.
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

  // Only straight after a space, as a keyboard's next-word guess.
  if (!/[A-Za-z0-9_'-] $/.test(draft)) return ""
  const after = model.follows.get(lastWord(draft) ?? "")
  if (!after) return ""
  let best: [string, number] | undefined
  for (const entry of after) {
    if (entry[1] >= MIN_FOLLOWS && (!best || entry[1] > best[1])) best = entry
  }
  return best ? model.words.get(best[0])?.form ?? best[0] : ""
}

/** Each earlier turn shown to the model is cut to this. */
const TURN_CHARS = 400

/**
 * A chat model asked about a draft answers it, as it answers everything.
 * Told it is a keyboard's predictor, and shown two drafts finished in the
 * user's own words, it finishes the third the same way.
 */
const PREDICTOR_SYSTEM =
  "You are an autocomplete engine inside a chat box, like the predictive " +
  "text on a phone keyboard. You never answer, explain or help. You only " +
  "predict the next few words the user will type to finish their own " +
  "unfinished message, in the user's voice. Output only those words."

const EXAMPLES: [conversation: string, draft: string, rest: string][] = [
  [
    "User: my python script is slow\nAssistant: Profile it with cProfile to see where the time goes.",
    "how do I ",
    "run cProfile on a script with arguments?"
  ],
  [
    "User: what is a monad\nAssistant: A monad is a way of chaining computations that carry context.",
    "can you show ",
    "an example in TypeScript?"
  ]
]

const predictorTurn = (conversation: string, draft: string) =>
  `Conversation so far:\n${conversation}\n\n` +
  `The user's unfinished message:\n<draft>${draft}</draft>\n\n` +
  "The words that finish it:"

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
    { role: "user", content: predictorTurn(conversation || "(none)", draft) }
  ]
}

/** Where the model is asked for the rest: after a space or punctuation. */
export const wantsModelSuggestion = (draft: string): boolean =>
  draft.trim().length >= 3 && /[\s,;:]$/.test(draft)

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
  const typed = draft.trim()
  if (typed && text.toLowerCase().startsWith(typed.toLowerCase())) {
    text = text.slice(typed.length).trim()
  } else if (typed) {
    // Some models start again from the last few words.
    const words = typed.split(/\s+/)
    for (let n = Math.min(3, words.length); n > 0; n--) {
      const tail = words.slice(-n).join(" ").toLowerCase()
      if (tail.length < 6 || !text.toLowerCase().startsWith(`${tail} `)) continue
      text = text.slice(tail.length).trim()
      break
    }
    // Or from just the last word ("what if" → "if I want…").
    const last = words[words.length - 1]?.toLowerCase()
    if (last && text.toLowerCase().startsWith(`${last} `)) text = text.slice(last.length).trim()
  }
  if (!text || /^[^A-Za-z0-9@`(]/.test(text)) return ""
  if (/^(sure|certainly|of course|here('s| is)|i (can|will|would)|as an ai|you (can|could|should|need|might)|this is because|it'?s because)\b/i.test(text)) return ""

  // Up to the end of the first sentence, and not past the cap.
  const sentence = text.match(/^.*?[.?!](?=\s|$)/)?.[0] ?? text
  text = sentence.length <= MODEL_MAX_CHARS
    ? sentence
    : sentence.slice(0, MODEL_MAX_CHARS).replace(/\s+\S*$/, "")
  if (!text) return ""
  return /\s$/.test(draft) ? text : ` ${text}`
}
