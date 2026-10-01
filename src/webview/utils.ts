import { PluginKey } from "@tiptap/pm/state" // or 'prosemirror-state'
import { Extension } from "@tiptap/react"

import { CodeLanguage, supportedLanguages } from "../common/languages"
import { LanguageType } from "../common/types"

export { getLineBreakCount, kebabToSentence } from "../common/text"

const MentionPluginKey = new PluginKey("mention")

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
      // Stops a reply on its way, from where the user is already typing;
      // pressed twice with nothing running, it clears the draft.
      Escape: ({ editor }) => {
        const mentionState = MentionPluginKey.getState(editor.state)
        if (mentionState && mentionState.active) return false
        return this.options.escape?.() ?? false
      },
      // As in a terminal: stop the reply, or clear the line. With text
      // selected it stays a copy.
      "Ctrl-c": ({ editor }) => {
        if (!editor.state.selection.empty) return false
        return this.options.interrupt?.() ?? false
      },
      "Ctrl-l": () => this.options.newConversation?.() ?? false,
      // On an empty composer "?" asks for the shortcuts; anywhere else it
      // is a question mark.
      "?": ({ editor }) => {
        if (!editor.isEmpty) return false
        return this.options.toggleShortcuts?.() ?? false
      },
      // Agent mode on and off, where Claude Code switches its modes.
      "Shift-Tab": ({ editor }) => {
        const mentionState = MentionPluginKey.getState(editor.state)
        if (mentionState && mentionState.active) return false
        return this.options.toggleAgentMode?.() ?? false
      },
      PageUp: () => this.options.scrollTranscript?.(-1) ?? false,
      PageDown: () => this.options.scrollTranscript?.(1) ?? false,
      // Earlier prompts, as in a shell: from an empty composer, or while
      // already stepping through them.
      ArrowUp: ({ editor }) => {
        const mentionState = MentionPluginKey.getState(editor.state)
        if (mentionState && mentionState.active) return false
        return this.options.recallPrompt?.(-1, editor.isEmpty) ?? false
      },
      ArrowDown: ({ editor }) => {
        const mentionState = MentionPluginKey.getState(editor.state)
        if (mentionState && mentionState.active) return false
        return this.options.recallPrompt?.(1, editor.isEmpty) ?? false
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
