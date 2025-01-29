import { mergeAttributes, Node } from "@tiptap/react"

export const MentionExtension = Node.create({
  name: "mention",
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
        getAttrs: (dom) => {
          const element = dom as HTMLElement
          return {
            dataId: element.getAttribute("data-id"),
            dataLabel: element.getAttribute("data-label")
          }
        }
      }
    ]
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  renderHTML({ node }: any) {
    const { dataId, dataLabel, id, label } = node.attrs
    return [
      "span",
      mergeAttributes({
        class: "mention",
        "data-type": "mention",
        "data-id": dataId || id,
        "data-label": dataLabel || label
      }),
      `@${dataLabel || label}`
    ]
  },

  addKeyboardShortcuts() {
    return {}
  }
})
