/* eslint-disable @typescript-eslint/no-explicit-any */
import { forwardRef, useEffect, useImperativeHandle, useState } from "react"
import { useTranslation } from "react-i18next"
import { Editor } from "@tiptap/core"
import { MentionNodeAttrs } from "@tiptap/extension-mention"
import cx from "classnames"

import { FileItem } from "../common/types"

import styles from "./styles/index.module.css"

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
    const { t } = useTranslation()
    const [selectedIndex, setSelectedIndex] = useState(0)

    const selectItem = (index: number) => {
      const item = props.items[index]

      if (item) {
        props.command({ id: item.path, label: item.path })
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
        if (event.key === "ArrowUp") {
          upHandler()
          return true
        }

        if (event.key === "ArrowDown") {
          downHandler()
          return true
        }

        if (event.key === "Enter") {
          enterHandler()
          return true
        }

        return false
      },
    }))

    return (
      <div className={styles.dropdownMenu}>
        {props.items.length ? (
          <>
            {(() => {
              let currentCategory = "";
              return props.items.map((item: FileItem, index: number) => {
                const elements = [];
                if (currentCategory !== item.category) {
                  currentCategory = item.category;
                  elements.push(
                    <div key={`category-${currentCategory}`} className={styles.categoryHeader}>
                      {currentCategory.charAt(0).toUpperCase() + currentCategory.slice(1)}
                    </div>
                  );
                }
                elements.push(
                  <button
                    className={cx(styles.dropdownItem, {
                      [styles.dropdownSelected]: index === selectedIndex,
                    })}
                    key={index}
                    onClick={() => selectItem(index)}
                  >
                    <span className={styles.itemPath}>
                      <span className={styles.itemName}>{item.name}</span>
                      {item.path !== item.name && (
                        <span className={styles.itemFullPath}>{item.path}</span>
                      )}
                    </span>
                  </button>
                );
                return elements;
              }).flat();
            })()}
          </>
        ) : (
          <div className="item">{t("no-result")}</div>
        )}
      </div>
    )
  }
)
