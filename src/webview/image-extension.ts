import Image from "@tiptap/extension-image"

export function createCustomImageExtension(onDeleteImage?: (id: string) => void) {
  return Image.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        id: {
          default: null,
          parseHTML: element => element.getAttribute("id"),
          renderHTML: attributes => {
            if (!attributes.id) return {};
            return { id: attributes.id };
          }
        }
      }
    },
    addNodeView() {
      return ({ node, editor, getPos }) => {
        const dom = document.createElement("div")
        dom.classList.add("imageContainer")

        const img = document.createElement("img")
        img.src = node.attrs.src
        img.setAttribute("id", node.attrs.id)
        img.classList.add("chatImage")

        const deleteButton = document.createElement("div")
        deleteButton.classList.add("imageDeleteButton")
        deleteButton.innerHTML = "<span class=\"codicon codicon-close\"></span>"
        deleteButton.addEventListener("click", () => {
          if (typeof getPos === "function") {
            editor.commands.deleteRange({ from: getPos(), to: getPos() + node.nodeSize })
            if (node.attrs.id && typeof onDeleteImage === "function") {
              onDeleteImage(node.attrs.id)
            }
          }
        })

        dom.appendChild(img)
        dom.appendChild(deleteButton)

        return {
          dom,
          update: (updatedNode) => {
            if (updatedNode.type.name === "image") {
              img.src = updatedNode.attrs.src
              img.setAttribute("id", updatedNode.attrs.id)
              return true
            }
            return false
          },
          destroy: () => {
            deleteButton.removeEventListener("click", () => { })
          }
        }
      }
    }
  })
}
