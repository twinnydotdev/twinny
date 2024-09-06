/* eslint-disable @typescript-eslint/no-explicit-any */
import cx from 'classnames'
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import { Editor } from '@tiptap/core'
import { MentionNodeAttrs } from '@tiptap/extension-mention'

import { FileItem } from '../common/types'
import styles from '../styles/index.module.css'

export interface MentionListProps {
  items: FileItem[]
  command: (attrs: MentionNodeAttrs) => void
  editor: Editor
  range: Range
}

export interface MentionListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean
}

export const MentionList = forwardRef<MentionListRef, MentionListProps>(
  (props, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0)

    const selectItem = (index: number) => {
      const item = props.items[index]

      if (item) {
        props.command({ id: item.path, label: item.name })
      }
    }

    const upHandler = () => {
      setSelectedIndex(
        (selectedIndex + props.items.length - 1) % props.items.length
      )
    }

    const downHandler = () => {
      setSelectedIndex((selectedIndex + 1) % props.items.length)
    }

    const enterHandler = () => {
      selectItem(selectedIndex)
    }

    useEffect(() => setSelectedIndex(0), [props.items])

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }: { event: KeyboardEvent }) => {
        if (event.key === 'ArrowUp') {
          upHandler()
          return true
        }

        if (event.key === 'ArrowDown') {
          downHandler()
          return true
        }

        if (event.key === 'Enter') {
          enterHandler()
          return true
        }

        return false
      }
    }))

    return (
      <div className={styles.dropdownMenu}>
        {props.items.length ? (
          props.items.map((item: FileItem, index: number) => (
            <button
              className={cx({
                [styles.dropdownSelected]: index === selectedIndex
              })}
              key={index}
              onClick={() => selectItem(index)}
            >
              {item.name}
            </button>
          ))
        ) : (
          <div className="item">No result</div>
        )}
      </div>
    )
  }
)
