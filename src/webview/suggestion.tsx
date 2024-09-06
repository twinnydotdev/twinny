/* eslint-disable @typescript-eslint/no-explicit-any */
import { RefAttributes } from 'react'
import { ReactRenderer } from '@tiptap/react'
import tippy, { Instance as TippyInstance } from 'tippy.js'
import { SuggestionProps, SuggestionKeyDownProps } from '@tiptap/suggestion'
import { MentionNodeAttrs } from '@tiptap/extension-mention'

import {
  MentionList,
  MentionListProps,
  MentionListRef,
} from './mention-list'

export const getSuggestions = (fileList: string[]) => ({
  items: ({ query }: { query: string }): string[] => {
    return ['workspace', 'problems', ...fileList].filter((item) =>
      item.toLowerCase().startsWith(query.toLowerCase())
    )
  },

  render: () => {
    let component: ReactRenderer<
      MentionListRef,
      MentionListProps & RefAttributes<MentionListRef>
    >
    let popup: TippyInstance[]

    return {
      onStart: (props: SuggestionProps<MentionNodeAttrs>) => {
        component = new ReactRenderer(MentionList, {
          props,
          editor: props.editor
        })

        const getReferenceClientRect = props.clientRect as () => DOMRect

        if (!props.clientRect) {
          return
        }

        popup = tippy('body', {
          getReferenceClientRect,
          appendTo: () => document.body,
          content: component.element,
          showOnCreate: true,
          interactive: true,
          trigger: 'manual',
          placement: 'bottom-start'
        })
      },

      onUpdate(props: SuggestionProps<MentionNodeAttrs>) {
        component.updateProps({
          ...props,
          items: getSuggestions(fileList).items({ query: props.query })
        })

        if (!props.clientRect) {
          return
        }

        popup[0].setProps({
          getReferenceClientRect: props.clientRect as () => DOMRect
        })
      },

      onKeyDown(props: SuggestionKeyDownProps) {
        if (props.event.key === 'Escape') {
          popup[0].hide()
          return true
        }

        return component.ref?.onKeyDown(props) || false
      },

      onExit() {
        if (popup.length > 0) {
          popup[0].destroy()
          component.destroy()
        }
      }
    }
  }
})
