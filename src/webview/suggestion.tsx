/* eslint-disable @typescript-eslint/no-explicit-any */
import { ReactRenderer } from '@tiptap/react'
import tippy, { Instance as TippyInstance } from 'tippy.js'
import { SuggestionProps, SuggestionKeyDownProps } from '@tiptap/suggestion'

import {
  AtList,
  AtListProps,
  AtListRef,
  MentionNodeAttrs
} from './mention-list'
import { RefAttributes } from 'react'

export const suggestion = {
  items: ({ query }: { query: string }): string[] => {
    return ['workspace', 'problems'].filter((item) =>
      item.toLowerCase().startsWith(query.toLowerCase())
    )
  },

  render: () => {
    let component: ReactRenderer<
      AtListRef,
      AtListProps & RefAttributes<AtListRef>
    >
    let popup: TippyInstance[]

    return {
      onStart: (props: SuggestionProps<MentionNodeAttrs>) => {
        component = new ReactRenderer(AtList, {
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
          items: suggestion.items({ query: props.query })
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
        popup[0].destroy()
        component.destroy()
      }
    }
  }
}
