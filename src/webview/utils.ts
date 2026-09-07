import { MentionPluginKey } from "@tiptap/extension-mention"
import { Extension } from "@tiptap/react"

import { CodeLanguage, supportedLanguages } from "../common/languages"
import { LanguageType } from "../common/types"

export { getLineBreakCount, kebabToSentence } from "../common/text"

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
      },
    }
  },
})

export const getThinkingMessage = (content: string): { thinking: string | null; message: string } => {
  const thinkMatch = content.match(/<(?:think|thinking)>([\s\S]*?)(?:<\/(?:think|thinking)>|$)/);
  if (!thinkMatch) return { thinking: null, message: content };

  const thinking = thinkMatch[1].trim();
  const message = content.replace(/<(?:think|thinking)>[\s\S]*?(?:<\/(?:think|thinking)>|$)/, "").trim();
  return { thinking, message };
};
