import { MutableRefObject, useCallback, useEffect, useRef, useState } from "react"
import { Editor } from "@tiptap/react"

import {
  buildWordModel,
  predictWord,
  wantsModelSuggestion,
  WordModel
} from "../../common/composer-predict"
import { ASSISTANT, EVENT_NAME, USER } from "../../common/constants"
import { ChatCompletionMessage } from "../../common/types"
import { bridge } from "../messaging"

/** How long typing has to stop before the model is asked. */
const MODEL_DELAY_MS = 500
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
}

/**
 * Grey text ahead of the cursor in the composer. From the first key it
 * finishes the word being typed, or guesses the next one, from the words
 * the user has typed before, as a phone keyboard does. Once the
 * conversation has an exchange, a pause after a word asks the chat model
 * for the rest of the message given the last few turns, and its guess
 * replaces the word one for as long as the draft still agrees with it.
 */
export const useComposerSuggestions = ({
  editorRef,
  messages,
  promptHistoryRef,
  busyRef
}: Options) => {
  const [enabled, setEnabled] = useState(true)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()
  const requestRef = useRef(0)
  /** The draft with the model's guess on the end, while it still applies. */
  const guessRef = useRef("")
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  useEffect(() => {
    bridge
      .request(EVENT_NAME.twinnyGetConfigValue, { key: "chatSuggestions" })
      .then(({ value }) => setEnabled(value !== false))
      .catch(() => undefined)
  }, [])

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
    let completion = ""
    try {
      completion = await bridge.request(EVENT_NAME.twinnyComposerSuggest, {
        draft,
        recent
      })
    } catch {
      return
    }
    const editor = editorRef.current
    if (id !== requestRef.current || !completion || !editor) return
    if (draftAtEnd(editor) !== draft) return
    guessRef.current = draft + completion
    editor.commands.setGhostText(completion)
  }, [editorRef])

  /** Called on every change to the draft. */
  const update = useCallback(() => {
    const editor = editorRef.current
    clearTimeout(timerRef.current)
    if (!editor || !enabled) return
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

    const word = predictWord(draft, wordModel())
    if (word) editor.commands.setGhostText(word)

    const hasExchange = messagesRef.current.some((m) => m.role === ASSISTANT)
    if (!hasExchange || busyRef.current || !wantsModelSuggestion(draft)) return
    timerRef.current = setTimeout(() => {
      if (!busyRef.current) void askModel(draft)
    }, MODEL_DELAY_MS)
  }, [askModel, busyRef, editorRef, enabled])

  /** Drops any pending guess, as when the draft is sent or replaced. */
  const reset = useCallback(() => {
    clearTimeout(timerRef.current)
    requestRef.current++
    guessRef.current = ""
    editorRef.current?.commands.setGhostText("")
  }, [editorRef])

  useEffect(() => () => clearTimeout(timerRef.current), [])

  return { updateSuggestion: update, resetSuggestion: reset }
}
