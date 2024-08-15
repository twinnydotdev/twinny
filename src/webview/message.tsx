import React, { useEffect } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { VSCodeButton } from '@vscode/webview-ui-toolkit/react'
import { EditorContent, Extension, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { Markdown as TiptapMarkdown } from 'tiptap-markdown'

import CodeBlock from './code-block'
import styles from './index.module.css'
import { Message as MessageType, ThemeType } from '../common/types'
import { ASSISTANT, TWINNY, YOU } from '../common/constants'

interface MessageProps {
  conversationLength?: number | undefined
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
        if (!editor.getText().length) return false
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

export const Message = ({
  conversationLength = 0,
  index = 0,
  isAssistant,
  isLoading,
  message,
  onDelete,
  onRegenerate,
  onUpdate,
  theme
}: MessageProps) => {
  if (!message?.content) return null

  const [editing, setEditing] = React.useState<boolean>(false)

  const handleToggleEditing = () => setEditing(!editing)

  const handleDelete = () => onDelete?.(index)

  const handleRegenerate = () => onRegenerate?.(index)

  const handleToggleSave = () => {
    const content = editor?.storage.markdown.getMarkdown()
    onUpdate?.(content || '', index)
    setEditing(false)
  }

  const editor = useEditor(
    {
      extensions: [
        StarterKit,
        Placeholder.configure({
          placeholder: 'How can twinny help you today?'
        }),
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
    if (editor && message.content && message.content !== editor.getText()) {
      editor.commands.setContent(message.content)
    }
  }, [editor, message.content])

  return (
    <>
      <div
        className={`${styles.message} ${
          message?.role === ASSISTANT
            ? styles.assistantMessage
            : styles.userMessage
        }`}
      >
        <div className={styles.messageRole}>
          <span>{message.role === ASSISTANT ? TWINNY : YOU}</span>
          <div className={styles.messageOptions}>
            {editing && !isAssistant && (
              <VSCodeButton
                title="Save message"
                appearance="icon"
                onClick={handleToggleSave}
              >
                <span className="codicon codicon-check"></span>
              </VSCodeButton>
            )}
            {!editing && !isAssistant && (
              <>
                <VSCodeButton
                  disabled={isLoading}
                  title="Edit message"
                  appearance="icon"
                  onClick={handleToggleEditing}
                >
                  <span className="codicon codicon-edit"></span>
                </VSCodeButton>
                <VSCodeButton
                  disabled={isLoading || conversationLength <= 2}
                  title="Edit message"
                  appearance="icon"
                  onClick={handleDelete}
                >
                  <span className="codicon codicon-trash"></span>
                </VSCodeButton>
              </>
            )}
            {!editing && isAssistant && (
              <VSCodeButton
                disabled={isLoading}
                title="Regenerate from here"
                appearance="icon"
                onClick={handleRegenerate}
              >
                <span className="codicon codicon-sync"></span>
              </VSCodeButton>
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
            components={{
              pre({ children }) {
                if (React.isValidElement(children)) {
                  return (
                    <CodeBlock
                      role={message.role}
                      language={message.language}
                      theme={theme}
                      {...children.props}
                    />
                  )
                }
                return <pre>{children}</pre>
              },
              code({ children }) {
                return <code>{children}</code>
              }
            }}
          >
            {message.content.trimStart()}
          </Markdown>
        )}
      </div>
    </>
  )
}
