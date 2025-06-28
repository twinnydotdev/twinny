/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState
} from "react"
import { useTranslation } from "react-i18next"
import { Editor } from "@tiptap/core"
import { MentionNodeAttrs } from "@tiptap/extension-mention"
import cx from "classnames"

import { topLevelItems } from "../common/constants"
import { CategoryType, ContextItem } from "../common/types"

import styles from "./styles/common.module.css"

const getCategoryIcon = (category: CategoryType): string => {
  switch (category) {
    case "files":
      return "file"
    case "workspace":
      return "root-folder"
    case "problems":
      return "warning"
  }
}

export interface MentionListProps {
  items: ContextItem[]
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
    const [selectedCategory, setSelectedCategory] =
      useState<CategoryType | null>(null)

    const categories = useMemo(() => {
      const orderedCategories: CategoryType[] = [
        "workspace",
        "problems",
        "files"
      ]
      const availableCategories = new Set(
        props.items.map((item) => item.category)
      )
      return orderedCategories.filter((cat) => availableCategories.has(cat))
    }, [props.items])

    const categoryItems = useMemo(() => {
      if (!selectedCategory) return []
      return props.items.filter((item) => item.category === selectedCategory)
    }, [props.items, selectedCategory])

    const selectItem = (index: number) => {
      if (!selectedCategory) {
        const category = categories[index]
        const isTopLevel = topLevelItems.some(
          (item) => item.category === category
        )
        if (isTopLevel) {
          const item = props.items.find((i) => i.category === category)
          if (item) {
            props.command({ id: item.name, label: item.name })
          }
        } else {
          setSelectedCategory(category)
          setSelectedIndex(0)
        }
      } else {
        const item = categoryItems[index]
        if (item) {
          props.command({
            id: item.path,
            label: item.name
          })
        }
      }
    }

    const upHandler = () => {
      const items = selectedCategory ? categoryItems : categories
      setSelectedIndex((selectedIndex + items.length - 1) % items.length)
    }

    const downHandler = () => {
      const items = selectedCategory ? categoryItems : categories
      setSelectedIndex((selectedIndex + 1) % items.length)
    }

    const enterHandler = () => {
      selectItem(selectedIndex)
    }

    useEffect(() => {
      setSelectedIndex(0)
    }, [props.items, selectedCategory])

    useEffect(() => {
      const selectedElement = document.querySelector(
        `.${styles.dropdownSelected}`
      )
      if (selectedElement) {
        selectedElement.scrollIntoView({ block: "nearest", behavior: "auto" })
      }
    }, [selectedIndex])

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

        if (event.key === "Escape") {
          if (selectedCategory) {
            setSelectedCategory(null)
            setSelectedIndex(0)
            return true
          }
          return false
        }

        return false
      }
    }))

    if (props.items.every((item) => item.category === "files")) {
      if (!selectedCategory) {
        setSelectedCategory("files")
        setSelectedIndex(0)
      }
    }

    if (!categories.length) {
      return <div className="item">{t("no-result")}</div>
    }

    return (
      <div className={styles.dropdownMenu}>
        {selectedCategory ? (
          <>
            {categoryItems.map((item, index) => (
              <button
                className={cx(styles.dropdownItem, {
                  [styles.dropdownSelected]: index === selectedIndex
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
            ))}
          </>
        ) : (
          categories.map((category, index) => (
            <button
              className={cx(styles.dropdownItem, {
                [styles.dropdownSelected]: index === selectedIndex
              })}
              key={category}
              onClick={() => selectItem(index)}
            >
              <i className={`codicon codicon-${getCategoryIcon(category)}`} />
              <span className={styles.itemName}>
                {category.charAt(0).toUpperCase() + category.slice(1)}
              </span>
            </button>
          ))
        )}
      </div>
    )
  }
)
