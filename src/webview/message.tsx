import React, { useCallback, useEffect, useMemo, useRef } from "react"
import { useTranslation } from "react-i18next"
import Markdown, { Components } from "react-markdown"
import Mention from "@tiptap/extension-mention"
import { Editor, EditorContent, Extension, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import DOMPurify from "dompurify"
import remarkGfm from "remark-gfm"
import { Markdown as TiptapMarkdown } from "tiptap-markdown"

import { ASSISTANT, EVENT_NAME, TWINNY, YOU } from "../common/constants"
import { ChatCompletionMessage, MentionType, ThemeType } from "../common/types"

import { CodeBlock } from "./code-block"
import { useSuggestion } from "./hooks"
import { MentionExtension } from "./mention-extention"
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
  messages?: ChatCompletionMessage[]
  onDelete?: (index: number) => void
  onRegenerate?: (index: number, mentions: MentionType[] | undefined) => void
  onUpdate?: (
    message: string,
    index: number,
    mentions: MentionType[] | undefined
  ) => void
  onHeightChange?: () => void
  theme: ThemeType | undefined
}

const CustomKeyMap = Extension.create({
  name: "messageKeyMap",
  addKeyboardShortcuts() {
    return {
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
    onHeightChange,
    theme,
    messages,
  }) => {
    const [isThinkingCollapsed, setIsThinkingCollapsed] = React.useState(true)
    const { t } = useTranslation()
    const [editing, setEditing] = React.useState<boolean>(false)
    const messageRef = useRef<HTMLDivElement>(null)
    const prevHeightRef = useRef<number>(0)

    useEffect(() => {
      const currentHeight = messageRef.current?.offsetHeight
      if (currentHeight && currentHeight !== prevHeightRef.current) {
        prevHeightRef.current = currentHeight
        onHeightChange?.()
      }
    }, [isThinkingCollapsed, editing, message?.content])

    const handleToggleEditing = useCallback(
      () => setEditing((prev) => !prev),
      []
    )
    const handleDelete = useCallback(() => onDelete?.(index), [onDelete, index])

    const extractMentionsFromHtml = (content: string): MentionType[] => {
      const parser = new DOMParser()
      const doc = parser.parseFromString(content, "text/html")
      const mentions: MentionType[] = []

      doc.querySelectorAll(".mention").forEach((mention) => {
        const path = mention.getAttribute("data-id")
        const label = mention.getAttribute("data-label")
        if (path && label) {
          mentions.push({
            name: label,
            path: path
          })
        }
      })

      return mentions
    }

    const handleRegenerate = useCallback(() => {
      if (!messages?.length) return
      const lastMessage = messages[index - 1]
      const mentions = extractMentionsFromHtml(lastMessage?.content as string)
      onRegenerate?.(index, mentions)
    }, [onRegenerate, index])

    const handleToggleCancel = useCallback(() => {
      setEditing(false)
      editorRef.current?.commands.setContent(message?.content as string)
    }, [message?.content])

    const handleToggleSave = useCallback(() => {
      const editorContent = editorRef.current?.getHTML()
      if (!editorContent) {
        return setEditing(false)
      }
      const parser = new DOMParser()
      const doc = parser.parseFromString(editorContent, "text/html")
      const mentions = Array.from(doc.querySelectorAll(".mention")).map(
        (mention) => {
          const filePath = mention.getAttribute("data-id")
          const label = mention.getAttribute("data-label")
          if (filePath && label) {
            mention.outerHTML = `<span class="mention" data-type="mention" data-id="${filePath}" data-label="${label}">@${label}</span>`
          }
          return { name: label, path: filePath }
        }
      )

      const finalContent = doc.body.innerHTML
      if (message?.content === finalContent) {
        return setEditing(false)
      }

      onUpdate?.(
        finalContent,
        index,
        mentions.filter((m): m is MentionType => Boolean(m.name && m.path))
      )
      setEditing(false);
    }, [message?.content, onUpdate, index])

    const handleOpenFile = useCallback((filePath: string) => {
      global.vscode.postMessage({
        type: EVENT_NAME.twinnyOpenFile,
        data: filePath
      })
    }, [])

    const { suggestion, filePaths } = useSuggestion()

    const memoizedSuggestion = useMemo(
      () => suggestion,
      [JSON.stringify(filePaths)]
    )

    const editorRef = useRef<Editor | null>(null)

    const editor = useEditor(
      {
        extensions: [
          Mention.configure({
            HTMLAttributes: {
              class: "mention"
            },
            suggestion: memoizedSuggestion,
            renderText({ node }) {
              return `@${node.attrs.label}`
            }
          }),
          StarterKit,
          TiptapMarkdown,
          MentionExtension,
          CustomKeyMap.configure({
            handleToggleSave
          })
        ],
        content: message?.content,
        editorProps: {
          attributes: {
            class: styles.editor
          },
          handleDOMEvents: {
            paste: (view, event) => {
              event.preventDefault()
              const text =
                event.clipboardData?.getData("text/html") ||
                event.clipboardData?.getData("text/plain")
              if (text) {
                view.dispatch(view.state.tr.insertText(text))
              }
              return true
            }
          }
        },
        onFocus: () => {
          if (editorRef.current) {
            editorRef.current.commands.focus("end")
          }
        }
      },
      [memoizedSuggestion]
    )

    useEffect(() => {
      if (editor) {
        editorRef.current = editor
      }
    }, [editor])

    useEffect(() => {
      if (
        editorRef.current &&
        message?.content &&
        message.content !== editorRef.current.getText()
      ) {
        editorRef.current.commands.setContent(message.content);
      }
    }, [message?.content])

    useEffect(() => {
      if (editorRef.current) {
        const mentionExtension =
          editorRef.current.extensionManager.extensions.find(
            (extension) => extension.name === "mention"
          )
        if (mentionExtension) {
          mentionExtension.options.suggestion = memoizedSuggestion
          editorRef.current.commands.focus()
        }
      }
    }, [memoizedSuggestion])

    const renderContent = useCallback(
      (htmlContent: string) => {
        const sanitizedHtml = DOMPurify.sanitize(htmlContent, {
          ALLOWED_TAGS: [
            "span",
            "p",
            "pre",
            "code",
            "strong",
            "em",
            "br",
            "a",
            "ul",
            "ol",
            "li"
          ],
          ALLOWED_ATTR: [
            "class",
            "data-type",
            "data-id",
            "data-label",
            "language"
          ]
        })

        return (
          <div
            className={styles.messageContent}
            dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
            onClick={(e) => {
              const target = e.target as HTMLElement
              const mention = target.closest(".mention")
              if (mention) {
                const filePath = mention.getAttribute("data-id")
                if (filePath) {
                  handleOpenFile(filePath)
                }
              }
            }}
          />
        )
      },
      [handleOpenFile]
    )

    const renderCodeBlock = useCallback(
      ({
        children,
        ...props
      }: { children: React.ReactNode } & React.HTMLProps<HTMLPreElement>) => {
        if (React.isValidElement(children)) {
          return (
            <MemoizedCodeBlock
              role={message?.role}
              {...children.props}
              theme={theme}
            />
          )
        }
        return <pre {...props}>{children}</pre>
      },
      [message?.role, theme]
    )

    const markdownComponents = useMemo(
      () =>
        ({
          pre: renderCodeBlock,
          p: ({
            children,
            ...props
          }: React.HTMLAttributes<HTMLParagraphElement>) => {
            if (
              typeof children === "string" &&
              children.includes("class=\"mention\"")
            ) {
              return renderContent(children)
            }
            return <p {...props}>{children}</p>
          }
        } as Components),
      [renderCodeBlock, renderContent]
    )

    if (!message?.content) return null

    const { thinking, message: messageContent } = getThinkingMessage(
      message.content as string
    )

    return (
      <div
        ref={messageRef}
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
              <span>{t("thinking")}</span>
              <span
                className={`codicon ${
                  isThinkingCollapsed
                    ? "codicon-chevron-right"
                    : "codicon-chevron-down"
                }`}
              />
            </div>
            <div
              className={`${styles.thinkingContent} ${
                isThinkingCollapsed ? styles.collapsed : ""
              }`}
            >
              <Markdown
                remarkPlugins={[remarkGfm]}
                components={markdownComponents}
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
                  <span className="codicon codicon-close" />
                </MemoizedVSCodeButton>
                <MemoizedVSCodeButton
                  title={t("save-edit")}
                  appearance="icon"
                  onClick={handleToggleSave}
                >
                  <span className="codicon codicon-check" />
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
                  <span className="codicon codicon-edit" />
                </MemoizedVSCodeButton>
                <MemoizedVSCodeButton
                  disabled={isLoading || conversationLength <= 2}
                  title={t("delete-message")}
                  appearance="icon"
                  onClick={handleDelete}
                >
                  <span className="codicon codicon-trash" />
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
                <span className="codicon codicon-sync" />
              </MemoizedVSCodeButton>
            )}
          </div>
        </div>
        {editing ? (
          <EditorContent className={styles.tiptap} editor={editor} />
        ) : message.role === ASSISTANT ? (
          <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {messageContent.trimStart()}
          </Markdown>
        ) : (
          renderContent(messageContent.trimStart())
        )}
      </div>
    )
  }
)

export default Message
