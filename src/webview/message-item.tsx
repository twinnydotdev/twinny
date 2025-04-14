import React, { memo } from "react"
import cn from "classnames"

import { ChatCompletionMessage, MentionType, ThemeType } from "../common/types"

import Message from "./message"
import TypingIndicator from "./typing-indicator"

interface MessageListProps {
  message: ChatCompletionMessage
  messages: ChatCompletionMessage[]
  completion?: ChatCompletionMessage | null
  isLoading: boolean
  index: number
  generatingRef: React.RefObject<boolean>
  theme: ThemeType
  handleDeleteMessage: (index: number) => void
  handleEditMessage: (
    message: string,
    index: number,
    mentions: MentionType[] | undefined
  ) => void
  handleRegenerateMessage: (
    index: number,
    mentions: MentionType[] | undefined
  ) => void
  handleDeleteImage?: (id: string) => void
}

const MessageItem = memo(
  ({
    message,
    messages,
    completion,
    isLoading,
    theme,
    index,
    handleDeleteMessage,
    handleEditMessage,
    handleRegenerateMessage,
    handleDeleteImage,
  }: MessageListProps) => {
    const isUserMessage = message?.role === "user"
    const isAgentMessage = message?.role === "assistant"
    const isLastMessage = index === messages?.length - 1
    const messageKey = `${message?.role}-0`

    return (
      <>
        {isUserMessage && (
          <Message
            key={messageKey}
            message={message}
            theme={theme}
            index={index}
            isLoading={isLoading}
            messages={messages}
            onDelete={handleDeleteMessage}
            onEdit={handleEditMessage}
            onRegenerate={handleRegenerateMessage}
            onDeleteImage={handleDeleteImage}
          />
        )}
        {isAgentMessage && (
          <Message
            key={messageKey}
            message={message}
            theme={theme}
            index={index}
            isLoading={isLoading}
            messages={messages}
            onDelete={handleDeleteMessage}
            onEdit={handleEditMessage}
            onRegenerate={handleRegenerateMessage}
            isAssistant
            onDeleteImage={handleDeleteImage}
          />
        )}
        {completion && isLastMessage && (
          <Message
            key={`completion-${messageKey}`}
            isAssistant={true}
            message={completion}
            theme={theme}
            index={index}
            isLoading={isLoading}
            messages={messages}
            onDelete={handleDeleteMessage}
            onEdit={handleEditMessage}
            onRegenerate={handleRegenerateMessage}
            onDeleteImage={handleDeleteImage}
          />
        )}
        {isLoading && !completion && isLastMessage && (
          <div className={cn("message", "assistantMessage")}>
            <TypingIndicator />
          </div>
        )}
      </>
    )
  }
)

export default MessageItem
