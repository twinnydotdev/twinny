import {
  RefAttributes,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react"
import { MentionNodeAttrs } from "@tiptap/extension-mention"
import { ReactRenderer } from "@tiptap/react"
import { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion"
import Fuse from "fuse.js"
import tippy, { Instance as TippyInstance } from "tippy.js"

import { topLevelItems } from "../../common/constants"
import { CategoryType, FileContextItem } from "../../common/types"
import { MentionList, MentionListProps, MentionListRef } from "../mention-list"

import { useFilePaths } from "./useFilePaths" // Adjusted import path

export const useSuggestion = () => {
  const { filePaths } = useFilePaths()

  const getFilePaths = useCallback(() => filePaths, [filePaths])

  const suggestionItems = useCallback(
    ({ query }: { query: string }) => {
      const filePaths = getFilePaths()
      const fileItems = createFileItems(filePaths)
      const allItems = [...topLevelItems, ...fileItems]

      const fuse = new Fuse(allItems, {
        keys: ["name", "path"],
        threshold: 0.4,
        includeScore: true
      })

      const filteredItems = query
        ? fuse.search(query).map((result) => result.item)
        : allItems

      const groupedItems = groupItemsByCategory(filteredItems)
      const sortedItems = sortItemsByCategory(groupedItems)

      return Promise.resolve(sortedItems)
    },
    [getFilePaths]
  )

  const createFileItems = (filePaths: string[]): FileContextItem[] =>
    filePaths.map((path) => ({
      name: path.split("/").pop() || "",
      path,
      category: "files"
    }))

  const groupItemsByCategory = (
    items: FileContextItem[]
  ): Record<string, FileContextItem[]> =>
    items.reduce((acc, item) => {
      acc[item.category] = [...(acc[item.category] || []), item]
      return acc
    }, {} as Record<string, FileContextItem[]>)

  const orderedCategories: CategoryType[] = ["workspace", "problems", "files"]

  const sortItemsByCategory = (
    groupedItems: Record<string, FileContextItem[]>
  ): FileContextItem[] =>
    orderedCategories.flatMap((category) => groupedItems[category] || [])

  const render = useCallback(() => {
    let reactRenderer: ReactRenderer<
      MentionListRef,
      MentionListProps & RefAttributes<MentionListRef>
    >
    let popup: TippyInstance[]

    return {
      onStart: (props: SuggestionProps<MentionNodeAttrs>) => {
        reactRenderer = new ReactRenderer(MentionList, {
          props,
          editor: props.editor
        })

        const getReferenceClientRect = props.clientRect as () => DOMRect

        popup = tippy("body", {
          getReferenceClientRect,
          appendTo: () => document.body,
          content: reactRenderer.element,
          showOnCreate: true,
          interactive: true,
          trigger: "manual",
          placement: "top-start"
        })
      },

      onUpdate(props: SuggestionProps<MentionNodeAttrs>) {
        reactRenderer.updateProps(props)

        if (popup) {
          popup[0].setProps({
            getReferenceClientRect: props.clientRect as () => DOMRect
          })
        }
      },

      onKeyDown(props: SuggestionKeyDownProps) {
        if (props.event.key === "Escape") {
          popup[0].hide()
          return true
        }

        if (!reactRenderer.ref) return false

        return reactRenderer.ref.onKeyDown(props)
      },

      onExit() {
        if (popup) {
          popup[0].destroy()
          reactRenderer.destroy()
        }
      }
    }
  }, [])

  const suggestion = useMemo(
    () => ({
      items: suggestionItems,
      render
    }),
    [suggestionItems, render]
  )

  return {
    suggestion,
    filePaths
  }
}
