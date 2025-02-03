import { MentionPluginKey } from "@tiptap/extension-mention"
import { Extension } from "@tiptap/react"

import { CodeLanguage, supportedLanguages } from "../common/languages"
import {
  AssistantMessageContent,
  parseAssistantMessage
} from "../common/parse-assistant-message"
import { LanguageType } from "../common/types"

export const getLanguageMatch = (
  language: LanguageType | undefined,
  className: string | undefined
) => {
  const match = /language-(\w+)/.exec(className || "")

  if (match && match.length) {
    const matchedLanguage = supportedLanguages[match[1] as CodeLanguage]

    return matchedLanguage && matchedLanguage.derivedFrom
      ? matchedLanguage.derivedFrom
      : match[1]
  }

  if (language && language.languageId) {
    const languageId = language.languageId.toString()
    const languageEntry = supportedLanguages[languageId as CodeLanguage]

    return languageEntry && languageEntry.derivedFrom
      ? languageEntry.derivedFrom
      : languageId
  }

  return "auto"
}

export const kebabToSentence = (kebabStr: string) => {
  if (!kebabStr) {
    return ""
  }

  const words = kebabStr.split("-")

  if (!words.length) {
    return kebabStr
  }

  words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1)

  return words.join(" ")
}

export const getLineBreakCount = (str: string) => str.split("\n").length

export const getModelShortName = (name: string) => {
  if (name.length > 40) {
    return `${name.substring(0, 35)}...`
  }
  return name
}

export const CustomKeyMap = Extension.create({
  name: "chatKeyMap",

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const mentionState = MentionPluginKey.getState(editor.state)
        if (mentionState && mentionState.active) {
          return false
        }
        this.options.handleSubmitForm()
        this.options.clearEditor()
        return true
      },
      "Mod-Enter": ({ editor }) => {
        editor.commands.insertContent("\n")
        return true
      },
      "Shift-Enter": ({ editor }) => {
        editor.commands.insertContent("\n")
        return true
      }
    }
  }
})

export const getThinkingMessage = (content: string) => {
  const contentBlocks = parseAssistantMessage(content)
  console.log(contentBlocks)
  const thinkingBlocks: string[] = []
  const messageBlocks: AssistantMessageContent[] = []

  let isInThinking = false

  for (const block of contentBlocks) {
    if (block.type === "text") {
      const lines = block.content.split("\n")
      for (const line of lines) {
        if (line.startsWith("<thinking>")) {
          isInThinking = true
          continue
        }
        if (line.startsWith("</thinking>")) {
          isInThinking = false
          continue
        }
        if (isInThinking) {
          thinkingBlocks.push(line)
        } else if (line.trim()) {
          messageBlocks.push({ type: "text", content: line, partial: false })
        }
      }
    } else {
      messageBlocks.push(block)
    }
  }

  return {
    thinking: thinkingBlocks.join("\n"),
    messageBlocks,
    message: messageBlocks
      .map((block) => {
        if (block.type === "text") {
          return block.content
        }
        return ""
      })
      .join("\n")
  }
}

export const parseDiffBlocks = (diffContent: string) => {
  const regex =
    /<<<<<<< (?:SEARCH\n)?([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g
  let match
  const blocks: { oldText: string; newText: string }[] = []

  while ((match = regex.exec(diffContent)) !== null) {
    blocks.push({
      oldText: match[1].trim(),
      newText: match[2].trim()
    })
  }

  if (blocks.length === 0) {
    blocks.push({ oldText: diffContent, newText: diffContent })
  }

  return blocks
}
