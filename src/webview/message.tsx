import React, { useCallback, useEffect, useMemo } from "react"
import { useTranslation } from "react-i18next"
import Markdown, { Components } from "react-markdown"
import { EditorContent, Extension, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import remarkGfm from "remark-gfm"
import { Markdown as TiptapMarkdown } from "tiptap-markdown"

import {
  ASSISTANT,
  EVENT_NAME,
  FILE_PATH_REGEX,
  TWINNY,
  YOU
} from "../common/constants"
import { ChatCompletionMessage, ThemeType } from "../common/types"

import { CodeBlock } from "./code-block"
import { getThinkingMessage } from "./utils"

import styles from "./styles/index.module.css"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

interface MessageProps {
  conversationLength?: number
  index?: number
  isAssistant?: boolean
  isLoading?: boolean
  message?: ChatCompletionMessage
  onDelete?: (index: number) => void
  onRegenerate?: (index: number) => void
  onUpdate?: (message: string, index: number) => void
  theme: ThemeType | undefined
}

const CustomKeyMap = Extension.create({
  name: "messageKeyMap",
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        if (!editor.getText().trim().length) return false
        this.options.handleToggleSave()
        return true
      },
      "Mod-Enter": ({ editor }) => {
        editor.commands.insertContent("\n")
        return true
      },
      "Shift-Enter": ({ editor }) => {
        editor.commands.insertContent("\n")
        return true
      }
    }
  }
})

const MemoizedCodeBlock = React.memo(CodeBlock)
const MemoizedVSCodeButton = React.memo(VSCodeButton)

export const Message: React.FC<MessageProps> = React.memo(
  ({
    conversationLength = 0,
    index = 0,
    isAssistant,
    isLoading,
    message,
    onDelete,
    onRegenerate,
    onUpdate,
    theme
  }) => {
    const [isThinkingCollapsed, setIsThinkingCollapsed] = React.useState(true)
    const { t } = useTranslation()
    const [editing, setEditing] = React.useState<boolean>(false)

    const handleToggleEditing = useCallback(
      () => setEditing((prev) => !prev),
      []
    )
    const handleDelete = useCallback(() => onDelete?.(index), [onDelete, index])
    const handleRegenerate = useCallback(
      () => onRegenerate?.(index),
      [onRegenerate, index]
    )

    const handleToggleCancel = useCallback(() => {
      setEditing(false)
      editor?.commands.setContent(message?.content as string)
    }, [message?.content])

    const handleToggleSave = useCallback(() => {
      const content = editor?.storage.markdown.getMarkdown()
      if (message?.content === content) {
        return setEditing(false)
      }
      onUpdate?.(content || "", index)
      setEditing(false)
    }, [message?.content, onUpdate, index])

    const editor = useEditor(
      {
        extensions: [
          StarterKit,
          CustomKeyMap.configure({
            handleToggleSave
          }),
          TiptapMarkdown
        ],
        content: message?.content
      },
      [index]
    )

    useEffect(() => {
      if (editor && message?.content && message.content !== editor.getText()) {
        editor.commands.setContent(message.content)
      }
    }, [editor, message?.content])

    const handleOpenFile = useCallback((filePath: string) => {
      global.vscode.postMessage({
        type: EVENT_NAME.twinnyOpenFile,
        data: filePath.replace(/^@/, "")
      })
    }, [])

    const processContent = useCallback(
      (text: string) => {
        const parts = text.split(FILE_PATH_REGEX)

        return (
          <>
            {parts.map((part, index) => {
              const trimmedPart = part.trim()
              const isFilePath = FILE_PATH_REGEX.test(trimmedPart)

              if (isFilePath) {
                const displayPart = trimmedPart.replace("@", "")

                return (
                  <span
                    key={`file-${index}`}
                    onClick={() => handleOpenFile(trimmedPart)}
                    className={styles.fileLink}
                    role="button"
                    tabIndex={0}
                  >
                    {displayPart}
                  </span>
                )
              }

              return part
            })}
          </>
        )
      },
      [handleOpenFile]
    )

    const renderCode = useCallback(
      ({ children }: { children: React.ReactNode }) => {
        if (typeof children === "string") {
          return <code>{processContent(children)}</code>
        }
        return <code>{children}</code>
      },
      [processContent]
    )

    const renderPre = useCallback(
      ({ children }: { children: React.ReactNode }) => {
        if (React.isValidElement(children)) {
          return (
            <MemoizedCodeBlock
              role={message?.role}
              theme={theme}
              {...children.props}
            />
          )
        }
        return <pre>{children}</pre>
      },
      [message?.role, theme]
    )

    const markdownComponents = useMemo(
      () => ({
        code: renderCode,
        pre: renderPre,
        p: ({
          children,
          ...props
        }: React.HTMLAttributes<HTMLParagraphElement> & {
          children: React.ReactNode
        }) => {
          if (typeof children === "string") {
            return <p {...props}>{processContent(children)}</p>
          }
          if (Array.isArray(children)) {
            return (
              <p {...props}>
                {children.map((child, i) => {
                  if (typeof child === "string") {
                    return (
                      <React.Fragment key={i}>
                        {processContent(child)}
                      </React.Fragment>
                    )
                  }
                  return child
                })}
              </p>
            )
          }
          return <p {...props}>{children}</p>
        }
      }),
      [renderCode, processContent]
    )

    if (!message?.content) return null

    const { thinking, message: messageContent } = getThinkingMessage(
      message.content as string
    )

    return (
      <div
        className={`${styles.message} ${
          message.role === ASSISTANT
            ? styles.assistantMessage
            : styles.userMessage
        }`}
      >
        {thinking && (
          <div className={styles.thinkingSection}>
            <div
              className={styles.thinkingHeader}
              onClick={() => setIsThinkingCollapsed(!isThinkingCollapsed)}
            >
              <span>Thinking</span>
              <span
                className={`codicon ${
                  isThinkingCollapsed
                    ? "codicon-chevron-right"
                    : "codicon-chevron-down"
                }`}
              ></span>
            </div>
            <div
              className={`${styles.thinkingContent} ${
                isThinkingCollapsed ? styles.collapsed : ""
              }`}
            >
              <Markdown
                remarkPlugins={[remarkGfm]}
                components={markdownComponents as Components}
              >
                {thinking}
              </Markdown>
            </div>
          </div>
        )}
        <div className={styles.messageRole}>
          <span>{message.role === ASSISTANT ? TWINNY : YOU}</span>
          <div className={styles.messageOptions}>
            {editing && !isAssistant && (
              <>
                <MemoizedVSCodeButton
                  title={t("cancel-edit")}
                  appearance="icon"
                  onClick={handleToggleCancel}
                >
                  <span className="codicon codicon-close"></span>
                </MemoizedVSCodeButton>
                <MemoizedVSCodeButton
                  title={t("save-edit")}
                  appearance="icon"
                  onClick={handleToggleSave}
                >
                  <span className="codicon codicon-check"></span>
                </MemoizedVSCodeButton>
              </>
            )}
            {!editing && !isAssistant && (
              <>
                <MemoizedVSCodeButton
                  disabled={isLoading}
                  title={t("edit-message")}
                  appearance="icon"
                  onClick={handleToggleEditing}
                >
                  <span className="codicon codicon-edit"></span>
                </MemoizedVSCodeButton>
                <MemoizedVSCodeButton
                  disabled={isLoading || conversationLength <= 2}
                  title={t("delete-message")}
                  appearance="icon"
                  onClick={handleDelete}
                >
                  <span className="codicon codicon-trash"></span>
                </MemoizedVSCodeButton>
              </>
            )}
            {!editing && isAssistant && (
              <MemoizedVSCodeButton
                disabled={isLoading}
                title={t("regenerate-message")}
                appearance="icon"
                onClick={handleRegenerate}
              >
                <span className="codicon codicon-sync"></span>
              </MemoizedVSCodeButton>
            )}
          </div>
        </div>
        {editing ? (
          <EditorContent className={styles.tiptap} editor={editor} />
        ) : (
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={markdownComponents as Components}
          >
            {messageContent.trimStart()}
          </Markdown>
        )}
      </div>
    )
  }
)
