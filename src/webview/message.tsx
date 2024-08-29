import React, { useEffect, useCallback, useMemo } from 'react'
import Markdown, { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { VSCodeButton } from '@vscode/webview-ui-toolkit/react'
import { EditorContent, Extension, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown as TiptapMarkdown } from 'tiptap-markdown'

import CodeBlock from './code-block'
import styles from './index.module.css'
import { Message as MessageType, ThemeType } from '../common/types'
import { ASSISTANT, TWINNY, YOU } from '../common/constants'

interface MessageProps {
  conversationLength?: number
  index?: number
  isAssistant?: boolean
  isLoading?: boolean
  message?: MessageType
  onDelete?: (index: number) => void
  onRegenerate?: (index: number) => void
  onUpdate?: (message: string, index: number) => void
  theme: ThemeType | undefined
}

const CustomKeyMap = Extension.create({
  name: 'messageKeyMap',
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        if (!editor.getText().trim().length) return false
        this.options.handleToggleSave()
        return true
      },
      'Mod-Enter': ({ editor }) => {
        editor.commands.insertContent('\n')
        return true
      },
      'Shift-Enter': ({ editor }) => {
        editor.commands.insertContent('\n')
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
      onUpdate?.(content || '', index)
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

    const renderPre = useCallback(
      ({ children }: { children: React.ReactNode }) => {
        if (React.isValidElement(children)) {
          return (
            <MemoizedCodeBlock
              role={message?.role}
              language={message?.language}
              theme={theme}
              {...children.props}
            />
          )
        }
        return <pre>{children}</pre>
      },
      [message?.role, message?.language, theme]
    )

    const renderCode = useCallback(
      ({ children }: { children: React.ReactNode }) => <code>{children}</code>,
      []
    )

    const markdownComponents = useMemo(
      () => ({
        pre: renderPre,
        code: renderCode
      }),
      [renderPre, renderCode]
    )

    if (!message?.content) return null

    return (
      <div
        className={`${styles.message} ${
          message.role === ASSISTANT
            ? styles.assistantMessage
            : styles.userMessage
        }`}
      >
        <div className={styles.messageRole}>
          <span>{message.role === ASSISTANT ? TWINNY : YOU}</span>
          <div className={styles.messageOptions}>
            {editing && !isAssistant && (
              <>
                <MemoizedVSCodeButton
                  title="Cancel edit"
                  appearance="icon"
                  onClick={handleToggleCancel}
                >
                  <span className="codicon codicon-close"></span>
                </MemoizedVSCodeButton>
                <MemoizedVSCodeButton
                  title="Save message"
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
                  title="Edit message"
                  appearance="icon"
                  onClick={handleToggleEditing}
                >
                  <span className="codicon codicon-edit"></span>
                </MemoizedVSCodeButton>
                <MemoizedVSCodeButton
                  disabled={isLoading || conversationLength <= 2}
                  title="Delete message"
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
                title="Regenerate from here"
                appearance="icon"
                onClick={handleRegenerate}
              >
                <span className="codicon codicon-sync"></span>
              </MemoizedVSCodeButton>
            )}
          </div>
        </div>
        {editing ? (
          <EditorContent
            placeholder="How can twinny help you today?"
            className={styles.tiptap}
            editor={editor}
          />
        ) : (
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={markdownComponents as Components}
          >
            {message.content.trimStart()}
          </Markdown>
        )}
      </div>
    )
  }
)
