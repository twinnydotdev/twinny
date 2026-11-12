import { MutableRefObject, useCallback, useEffect, useRef, useState } from "react"
import { Editor } from "@tiptap/react"

import {
  buildWordModel,
  predictWord,
  wantsModelSuggestion,
  WordModel
} from "../../common/composer-predict"
import { SuggestionSource, SuggestionStatus, suggestsSentences, suggestsWords } from "../../common/composer-settings"
import { ASSISTANT, EVENT_NAME, USER } from "../../common/constants"
import { ChatCompletionMessage } from "../../common/types"
import { bridge } from "../messaging"

/** How long typing has to stop before the model is asked. */
const MODEL_DELAY_MS = 250
/** The exchanges the model is shown, latest last. */
const RECENT_MESSAGES = 6

const plainText = (html: string) =>
  html
    .replace(/<\/p>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")

const messageText = (message: ChatCompletionMessage) =>
  typeof message.content === "string"
    ? message.content
    : (message.content || [])
        .map((part) => ("text" in part ? part.text : ""))
        .join(" ")

/** The draft when the cursor is at its very end, else undefined. */
const draftAtEnd = (editor: Editor): string | undefined => {
  const { state } = editor
  const { selection, doc } = state
  if (!selection.empty || selection.from !== doc.content.size - 1) return undefined
  return doc.textBetween(0, doc.content.size, "\n", " ")
}

interface Options {
  editorRef: MutableRefObject<Editor | null>
  messages: ChatCompletionMessage[]
  promptHistoryRef: MutableRefObject<string[]>
  /** No model requests while a reply is coming: they would share the GPU. */
  busyRef: MutableRefObject<boolean>
  /** Where suggestions come from, as the composer's settings have it. */
  source: SuggestionSource
}

/**
 * Grey text ahead of the cursor in the composer. From the first key it
 * finishes the word being typed from the words the user has typed before.
 * A short pause anywhere in a message, the first of a conversation
 * included, asks a model for the rest of it, as a mail composer does;
 * three dots mark the wait, and its guess replaces the word one for as
 * long as the draft still agrees with it.
 */
export const useComposerSuggestions = ({
  editorRef,
  messages,
  promptHistoryRef,
  busyRef,
  source
}: Options) => {
  const timerRef = useRef<ReturnType<typeof setTimeout>>()
  const requestRef = useRef(0)
  /** The draft with the model's guess on the end, while it still applies. */
  const guessRef = useRef("")
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const [status, setStatus] = useState<SuggestionStatus>({ asking: false })

  // Rebuilt when the user has sent something, which is when it learns.
  const wordModelRef = useRef<{ turns: number; model: WordModel }>()
  const wordModel = () => {
    const turns = messagesRef.current.filter((m) => m.role === USER)
    if (wordModelRef.current?.turns !== turns.length) {
      wordModelRef.current = {
        turns: turns.length,
        model: buildWordModel([
          ...promptHistoryRef.current.map(plainText),
          ...turns.map(messageText)
        ])
      }
    }
    return wordModelRef.current.model
  }

  const askModel = useCallback(async (draft: string) => {
    const id = ++requestRef.current
    const recent = messagesRef.current
      .filter((m) => m.role === USER || m.role === ASSISTANT)
      .slice(-RECENT_MESSAGES)
      .map((m) => ({ role: m.role, content: messageText(m) }))
    editorRef.current?.commands.setGhostPending(true)
    setStatus((was) => ({ ...was, asking: true }))
    const answer = await bridge
      .request(EVENT_NAME.twinnyComposerSuggest, { draft, recent })
      .catch((error: unknown) => ({ text: "", error: String(error), model: undefined, ms: undefined }))
    // A newer draft has its own request, and its own dots.
    if (id !== requestRef.current) return
    const editor = editorRef.current
    editor?.commands.setGhostPending(false)
    const { text, model, ms, error } = answer
    setStatus({
      asking: false,
      last: { model, ms, error, result: error ? "failed" : text ? "shown" : "nothing" }
    })
    if (!text || !editor || draftAtEnd(editor) !== draft) return
    guessRef.current = draft + text
    editor.commands.setGhostText(text)
  }, [editorRef])

  /** Called on every change to the draft. */
  const update = useCallback(() => {
    const editor = editorRef.current
    clearTimeout(timerRef.current)
    if (!editor || source === "off") return
    const draft = draftAtEnd(editor)
    // Typing past the cursor, or at an @ the mention list owns.
    if (draft === undefined || !draft.trim() || /(^|\s)@\S*$/.test(draft)) {
      requestRef.current++
      guessRef.current = ""
      return
    }

    const guess = guessRef.current
    if (guess.length > draft.length && guess.startsWith(draft)) {
      // Typed (or accepted) along the model's guess: the rest still stands.
      editor.commands.setGhostText(guess.slice(draft.length))
      return
    }
    guessRef.current = ""
    requestRef.current++

    const word = suggestsWords(source) ? predictWord(draft, wordModel()) : ""
    if (word) editor.commands.setGhostText(word)

    if (!suggestsSentences(source) || busyRef.current || !wantsModelSuggestion(draft)) return
    timerRef.current = setTimeout(() => {
      if (!busyRef.current) void askModel(draft)
    }, MODEL_DELAY_MS)
  }, [askModel, busyRef, editorRef, source])

  /** Drops any pending guess, as when the draft is sent or replaced. */
  const reset = useCallback(() => {
    clearTimeout(timerRef.current)
    requestRef.current++
    guessRef.current = ""
    editorRef.current?.commands.setGhostText("")
    editorRef.current?.commands.setGhostPending(false)
    setStatus((was) => (was.asking ? { ...was, asking: false } : was))
  }, [editorRef])

  useEffect(() => () => clearTimeout(timerRef.current), [])

  // A source switched off takes what it was showing with it.
  useEffect(() => {
    reset()
  }, [reset, source])

  return { updateSuggestion: update, resetSuggestion: reset, suggestionStatus: status }
}
