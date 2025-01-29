import { mergeAttributes, Node } from "@tiptap/core"

interface MentionAttributes {
  dataId: string | null
  dataLabel: string | null
}

export const MentionExtension = Node.create<MentionAttributes>({
  name: "mention-extension",
  inline: true,
  group: "inline",
  draggable: false,

  addAttributes() {
    return {
      dataId: {
        default: null
      },
      dataLabel: {
        default: null
      }
    }
  },

  parseHTML() {
    return [
      {
        tag: "span[data-type=\"mention\"]",
        getAttrs: (dom): MentionAttributes | null => {
          if (!(dom instanceof HTMLElement)) return null
          return {
            dataId: dom.getAttribute("data-id"),
            dataLabel: dom.getAttribute("data-label")
          }
        }
      }
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: "mention",
        "data-type": "mention",
        "data-id": node.attrs.dataId,
        "data-label": node.attrs.dataLabel
      }),
      `@${node.attrs.dataLabel}`
    ]
  },

  addKeyboardShortcuts() {
    return {}
  }
})
