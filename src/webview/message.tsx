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
import { ToolUse } from "../common/parse-assistant-message"
// import { ToolUse } from "../common/parse-assistant-message"
import { ChatCompletionMessage, MentionType, ThemeType } from "../common/types"

import CodeBlock from "./code-block"
import { CollapsibleSection } from "./collapsible-section"
import { useSuggestion } from "./hooks"
import { MentionExtension } from "./mention-extention"
import { ToolCard } from "./tool-use"
import { getThinkingMessage as parseMessage } from "./utils"

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
  onEdit?: (
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

export const Message: React.FC<MessageProps> = ({
  conversationLength = 0,
  index = 0,
  isAssistant,
  isLoading,
  message,
  onDelete,
  onRegenerate,
  onEdit,
  onHeightChange,
  theme,
  messages
}) => {
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
  }, [editing, message?.content])

  const handleToggleEditing = useCallback(() => setEditing((prev) => !prev), [])
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

    onEdit?.(
      finalContent,
      index,
      mentions.filter((m): m is MentionType => Boolean(m.name && m.path))
    )
    setEditing(false)
  }, [message?.content, onEdit, index])

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
          <CodeBlock role={message?.role} {...children.props} theme={theme} />
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

  const onRun = (toolUse: ToolUse) => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyToolUse,
      data: toolUse
    })
  }

  if (!message?.content) return null

  const { thinking, messageBlocks } = parseMessage(message.content as string)

  useEffect(() => {
    if (editor) editorRef.current = editor
    editorRef.current?.commands.focus()
  }, [editor])

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
        <CollapsibleSection
          content={thinking}
          title={t("thinking")}
          markdownComponents={markdownComponents}
        />
      )}
      <div className={styles.messageRole}>
        <span>{message.role === ASSISTANT ? TWINNY : YOU}</span>
        <div className={styles.messageOptions}>
          {editing && !isAssistant && (
            <>
              <VSCodeButton
                title={t("cancel-edit")}
                appearance="icon"
                onClick={handleToggleCancel}
              >
                <span className="codicon codicon-close" />
              </VSCodeButton>
              <VSCodeButton
                title={t("save-edit")}
                appearance="icon"
                onClick={handleToggleSave}
              >
                <span className="codicon codicon-check" />
              </VSCodeButton>
            </>
          )}
          {!editing && !isAssistant && (
            <>
              <VSCodeButton
                disabled={isLoading}
                title={t("edit-message")}
                appearance="icon"
                onClick={handleToggleEditing}
              >
                <span className="codicon codicon-edit" />
              </VSCodeButton>
              <VSCodeButton
                disabled={isLoading || conversationLength <= 2}
                title={t("delete-message")}
                appearance="icon"
                onClick={handleDelete}
              >
                <span className="codicon codicon-trash" />
              </VSCodeButton>
            </>
          )}
          {!editing && isAssistant && (
            <VSCodeButton
              disabled={isLoading}
              title={t("regenerate-message")}
              appearance="icon"
              onClick={handleRegenerate}
            >
              <span className="codicon codicon-sync" />
            </VSCodeButton>
          )}
        </div>
      </div>
      {editing ? (
        <EditorContent className={styles.tiptap} editor={editorRef.current} />
      ) : messageBlocks.some(({ type }) => type === "tool_use") ? (
        <div className={styles.messageContent}>
          {messageBlocks.map((block) =>
            block.type === "tool_use" ? (
              <React.Fragment key={`${block.type}`}>
                {block.name.endsWith("_result") ? (
                  <CollapsibleSection
                    title={t("result")}
                    content={block.params.content || ""}
                    markdownComponents={markdownComponents}
                  />
                ) : (
                  <>
                    <ToolCard toolUse={block} />
                  </>
                )}
                <div className={styles.toolFooter}>
                  <VSCodeButton
                    onClick={() => onRun(block)}
                    appearance="primary"
                  >
                    {t(block.name)}
                  </VSCodeButton>
                </div>
                <div className={styles.rawMessage}>
                  <details>
                    <summary>{t("show-raw-message")}</summary>
                    <div className={styles.rawMessageContent}>
                      <pre>{JSON.stringify(block, null, 2)}</pre>
                      <div className={styles.rawMessageActions}>
                        <VSCodeButton title={t("copy-code")} appearance="icon">
                          <span className="codicon codicon-copy"></span>
                        </VSCodeButton>
                      </div>
                    </div>
                  </details>
                </div>
              </React.Fragment>
            ) : (
              <Markdown
                key={block.content}
                remarkPlugins={[remarkGfm]}
                components={markdownComponents}
              >
                {block.content.trimStart()}
              </Markdown>
            )
          )}
        </div>
      ) : (
        renderContent((message.content as string).trimStart())
      )}
    </div>
  )
}

export default Message
