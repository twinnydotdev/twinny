import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    ghostText: {
      /** Grey text after the end of the draft, or none for an empty string. */
      setGhostText: (text: string) => ReturnType
      /** Puts the grey text into the draft. */
      acceptGhostText: (part?: "all" | "word") => ReturnType
    }
  }
}

export const GhostTextKey = new PluginKey<string>("ghostText")

/** The ghost shown now, or an empty string. */
export const ghostTextOf = (state: Parameters<typeof GhostTextKey.getState>[0]) =>
  GhostTextKey.getState(state) ?? ""

/** As VS Code accepts a word of an inline suggestion: up to the next space. */
const firstWord = (text: string) => text.match(/^\s*\S+/)?.[0] ?? text

/**
 * A suggestion shown in grey after the cursor, as an inline completion is
 * in the editor. It is only ever a decoration, never part of the draft,
 * until Tab (all of it) or Ctrl+→ (a word of it) puts it there. Any edit
 * or cursor move clears it; whoever sets it sets it again.
 */
export const GhostText = Extension.create({
  name: "ghostText",

  // Ahead of StarterKit's list keys, which also want Tab.
  priority: 1000,

  addCommands() {
    return {
      setGhostText:
        (text) =>
        ({ tr, dispatch }) => {
          dispatch?.(tr.setMeta(GhostTextKey, text).setMeta("addToHistory", false))
          return true
        },
      acceptGhostText:
        (part = "all") =>
        ({ state, tr, dispatch }) => {
          const ghost = ghostTextOf(state)
          if (!ghost) return false
          const text = part === "word" ? firstWord(ghost) : ghost
          if (dispatch) {
            tr.insertText(text, state.selection.from)
            // Accepting a word keeps the rest on show.
            tr.setMeta(GhostTextKey, ghost.slice(text.length))
            dispatch(tr.scrollIntoView())
          }
          return true
        }
    }
  },

  addKeyboardShortcuts() {
    return {
      Tab: () => this.editor.commands.acceptGhostText("all"),
      "Ctrl-ArrowRight": () => this.editor.commands.acceptGhostText("word"),
      // The first Esc puts the suggestion away rather than counting
      // towards clearing the draft.
      Escape: () =>
        ghostTextOf(this.editor.state) !== "" && this.editor.commands.setGhostText("")
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<string>({
        key: GhostTextKey,
        state: {
          init: () => "",
          apply(tr, ghost) {
            const set = tr.getMeta(GhostTextKey)
            if (typeof set === "string") return set
            return tr.docChanged || tr.selectionSet ? "" : ghost
          }
        },
        props: {
          decorations(state) {
            const ghost = GhostTextKey.getState(state)
            const { selection, doc } = state
            if (!ghost || !selection.empty) return null
            // Only at the very end of the draft, where it reads on from it.
            const end = doc.content.size - 1
            if (selection.from !== end) return null
            const widget = Decoration.widget(
              selection.from,
              () => {
                const span = document.createElement("span")
                span.className = "ghostText"
                span.textContent = ghost
                span.setAttribute("aria-hidden", "true")
                return span
              },
              { side: 1, key: `ghost:${ghost}` }
            )
            return DecorationSet.create(doc, [widget])
          }
        }
      })
    ]
  }
})
