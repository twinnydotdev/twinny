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
import { ChatCompletionMessage, ImageAttachment, MentionType, ThemeType } from "../common/types"

import CodeBlock from "./code-block"
import { useSuggestion } from "./hooks"
import { createCustomImageExtension } from "./image-extension"
import { MentionExtension } from "./mention-extention"
import { useToast } from "./toast"
import { getThinkingMessage } from "./utils"

import styles from "./styles/index.module.css"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

interface MessageProps {
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
    mentions: MentionType[] | undefined,
    images?: ImageAttachment[]
  ) => void
  onHeightChange?: () => void
  theme: ThemeType | undefined
  onDeleteImage?: (id: string) => void
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

interface ThinkingSectionProps {
  thinking: string
  isCollapsed: boolean
  onToggle: () => void
  markdownComponents: Components
}

const ThinkingSection = React.memo(
  ({
    thinking,
    isCollapsed: initialCollapsed,
    onToggle,
    markdownComponents
  }: ThinkingSectionProps) => {
    const { t } = useTranslation()
    const [isCollapsed, setIsCollapsed] = React.useState(initialCollapsed)
    const prevThinkingRef = useRef(thinking)
    const isStreamingRef = useRef(false)

    useEffect(() => {
      // If thinking content changed and is longer, we're streaming
      if (thinking.length > prevThinkingRef.current.length) {
        isStreamingRef.current = true
        setIsCollapsed(false) // Auto-expand during streaming
      } else {
        isStreamingRef.current = false
      }
      prevThinkingRef.current = thinking
    }, [thinking])

    const handleToggle = useCallback(() => {
      if (!isStreamingRef.current) {
        setIsCollapsed((prev) => !prev)
        onToggle()
      }
    }, [onToggle])

    return (
      <div className={styles.thinkingSection}>
        <div className={styles.thinkingHeader} onClick={handleToggle}>
          <span>{t("thinking")}</span>
          <span
            className={`codicon ${isCollapsed ? "codicon-chevron-right" : "codicon-chevron-down"
              }`}
          />
        </div>
        <div
          className={`${styles.thinkingContent} ${isCollapsed ? styles.collapsed : ""
            }`}
        >
          <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {thinking}
          </Markdown>
        </div>
      </div>
    )
  }
)

export const Message: React.FC<MessageProps> = ({
  index = 0,
  isAssistant,
  isLoading,
  message,
  onDelete,
  onRegenerate,
  onEdit,
  onHeightChange,
  theme,
  messages,
  onDeleteImage
}) => {
  const { t } = useTranslation()
  const [isThinkingCollapsed, setIsThinkingCollapsed] = React.useState(false)
  const [editing, setEditing] = React.useState<boolean>(false)
  const messageRef = useRef<HTMLDivElement>(null)
  const prevHeightRef = useRef<number>(0)
  const { Toast, showToast } = useToast()
  const handleThinkingToggle = useCallback(() => {
    setIsThinkingCollapsed((prev) => !prev)
  }, [])
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

    const imageNodes = Array.from(doc.querySelectorAll("img"))
    const imageIds = imageNodes.map(img => img.getAttribute("id")).filter((id): id is string => Boolean(id))
    const allImages = (message?.images || []) as ImageAttachment[]
    const filteredImages = allImages.filter(img => img.id && imageIds.includes(img.id))

    const finalContent = doc.body.innerHTML
    if (message?.content === finalContent) {
      return setEditing(false)
    }

    onEdit?.(
      finalContent,
      index,
      mentions.filter((m): m is MentionType => Boolean(m.name && m.path)),
      filteredImages
    )
    setEditing(false)
  }, [message?.content, onEdit, index, message?.images])

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

  const CustomImageExtension = createCustomImageExtension(onDeleteImage)

  const editor = useEditor(
    {
      extensions: [
        StarterKit,
        TiptapMarkdown,
        MentionExtension,
        CustomImageExtension.configure({
          allowBase64: true,
        }),
        Mention.configure({
          HTMLAttributes: {
            class: "mention"
          },
          suggestion: memoizedSuggestion,
          renderText({ node }) {
            return `@${node.attrs.label}`
          }
        }),
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
            const items = Array.from(event.clipboardData?.items || [])
            const imageItem = items.find(item => item.type.startsWith("image/"))

            if (imageItem) {
              const file = imageItem.getAsFile()
              if (file) {
                const reader = new FileReader()
                reader.onload = (e) => {
                  const base64 = e.target?.result as string
                  const imageData = base64.includes("data:") ? base64 : `data:${file.type};base64,${base64.split(",")[1]}`
                  view.dispatch(
                    view.state.tr.replaceSelectionWith(
                      view.state.schema.nodes.image.create({ src: imageData })
                    )
                  )
                }
                reader.readAsDataURL(file)
                return true
              }
            }

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
        ALLOWED_TAGS: ["span", "p", "br"],
        ALLOWED_ATTR: ["class", "data-id", "data-label", "data-type"],
        ALLOW_DATA_ATTR: true,
        ALLOW_UNKNOWN_PROTOCOLS: true
      });

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

  const renderImageGallery = useCallback(() => {
    const images = message?.images || [] as ImageAttachment[]
    if (!images.length) return null;

    const maxImages = 10
    const limitedImages = images.slice(0, maxImages)

    return (
      <div className={styles.imageGallery}>
        {limitedImages.map((img, index) => (
          <div key={index} className={styles.imageContainer}>
            <img
              src={(img as ImageAttachment).data}
              className={styles.chatImageSquare}
              alt=""
              loading="lazy"
              style={{ maxWidth: "200px", maxHeight: "200px" }}
            />
          </div>
        ))}
        {images.length > maxImages && (
          <div style={{ color: "#888", marginTop: 8 }}>
            {`+${images.length - maxImages} more image(s) not shown for performance`}
          </div>
        )}
      </div>
    )
  }, [message?.images])

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
          (children.includes("class=\"mention\"") || children.includes("<img"))
        ) {
          return renderContent(children)
        }
        return <p {...props}>{children}</p>
      },
    } as Components),
    [renderCodeBlock, renderContent, message?.images]
  )

  if (!message?.content) return null

  const { thinking, message: messageContent } = getThinkingMessage(
    message.content as string
  )

  const conversationLength = messages?.length || 0

  useEffect(() => {
    if (editor) editorRef.current = editor
    editorRef.current?.commands.focus()
  }, [editor])

  return (
    <div
      ref={messageRef}
      className={`${styles.message} ${message.role === ASSISTANT
        ? styles.assistantMessage
        : styles.userMessage
        }`}
    >
      {Toast}
      {thinking && (
        <ThinkingSection
          thinking={thinking}
          isCollapsed={isThinkingCollapsed}
          onToggle={handleThinkingToggle}
          markdownComponents={markdownComponents}
        />
      )}
      <div className={styles.messageRole}>
        <span>{message.role === ASSISTANT ? TWINNY : YOU}</span>
        <div className={styles.messageOptions}>
          <VSCodeButton
            title={t("copy-code")}
            onClick={() => {
              navigator.clipboard.writeText(messageContent)
              showToast(t("copied-to-clipboard"))
            }}
            appearance="icon"
          >
            <span className="codicon codicon-copy"></span>
          </VSCodeButton>
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
        <EditorContent className={styles.tiptap} editor={editor} />
      ) : message.role === ASSISTANT ? (
        <>
          <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {messageContent.trimStart()}
          </Markdown>
          {renderImageGallery()}
        </>
      ) : (
        <>
          {renderContent(messageContent.trimStart())}
          {renderImageGallery()}
        </>
      )}
    </div>
  )
}

export default Message
