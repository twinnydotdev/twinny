import { RefAttributes, useCallback, useMemo } from "react"
import { MentionNodeAttrs } from "@tiptap/extension-mention"
import { ReactRenderer } from "@tiptap/react"
import { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion"
import Fuse from "fuse.js"
import tippy, { Instance as TippyInstance } from "tippy.js"

import { EVENT_NAME, topLevelItems } from "../../common/constants"
import { CategoryType, ContextItem } from "../../common/types"
import { MentionList, MentionListProps, MentionListRef } from "../mention-list"
import { bridge } from "../messaging"

import { useFilePaths } from "./useFilePaths"

export const useSuggestion = () => {
  const { filePaths } = useFilePaths()

  const getFilePaths = useCallback(() => filePaths, [filePaths])

  const suggestionItems = useCallback(
    async ({ query }: { query: string }) => {
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

      // Symbols come from the language servers, already matched to the
      // query, so they bypass the fuzzy search over file names.
      const symbolItems = await searchSymbols(query)

      const groupedItems = groupItemsByCategory([...filteredItems, ...symbolItems])
      const sortedItems = sortItemsByCategory(groupedItems)

      return sortedItems
    },
    [getFilePaths]
  )

  const searchSymbols = async (query: string): Promise<ContextItem[]> => {
    try {
      const items = await bridge.request(EVENT_NAME.twinnySymbolSearch, { query })
      return Array.isArray(items) ? items : []
    } catch {
      return []
    }
  }

  const createFileItems = (filePaths: string[]): ContextItem[] =>
    filePaths.map((path) => ({
      name: path.split("/").pop() || "",
      path,
      category: "files",
      id: path,
    }))

  const groupItemsByCategory = (
    items: ContextItem[]
  ): Record<string, ContextItem[]> =>
    items.reduce((acc, item) => {
      acc[item.category] = [...(acc[item.category] || []), item]
      return acc
    }, {} as Record<string, ContextItem[]>)

  const orderedCategories: CategoryType[] = [
    "workspace",
    "problems",
    "git",
    "terminal",
    "files",
    "symbols"
  ]

  const sortItemsByCategory = (
    groupedItems: Record<string, ContextItem[]>
  ): ContextItem[] =>
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
