import React, { memo } from "react"

import { WorkspaceSearchReport } from "../common/messaging/protocol"
import { ChatCompletionMessage, MentionType, ToolStepView } from "../common/types"

import Message from "./message"
import TypingIndicator from "./typing-indicator"

interface MessageListProps {
  message: ChatCompletionMessage
  messages: ChatCompletionMessage[]
  completion?: ChatCompletionMessage | null
  /** The workspace search for the reply in progress, shown under it. */
  context?: WorkspaceSearchReport
  /** The tool steps of the reply in progress, shown above it. */
  steps?: ToolStepView[]
  isLoading: boolean
  index: number
  generatingRef: React.RefObject<boolean>
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
  handleContinue?: () => void
}

const MessageItem = memo(
  ({
    message,
    messages,
    completion,
    context,
    steps,
    isLoading,
    index,
    handleDeleteMessage,
    handleEditMessage,
    handleRegenerateMessage,
    handleDeleteImage,
    handleContinue
  }: MessageListProps) => {
    const isUserMessage = message?.role === "user"
    const isAgentMessage = message?.role === "assistant"
    const isLastMessage = index === messages?.length - 1
    const messageKey = `${message?.role}-0`
    const canContinue =
      isAgentMessage && isLastMessage && !isLoading && !!message.meta?.stopped

    return (
      <>
        {isUserMessage && (
          <Message
            key={messageKey}
            message={message}
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
            index={index}
            isLoading={isLoading}
            messages={messages}
            onDelete={handleDeleteMessage}
            onEdit={handleEditMessage}
            onRegenerate={handleRegenerateMessage}
            isAssistant
            onDeleteImage={handleDeleteImage}
            onContinue={canContinue ? handleContinue : undefined}
          />
        )}
        {completion && isLastMessage && (
          <Message
            key={`completion-${messageKey}`}
            isAssistant={true}
            message={completion}
            context={context}
            steps={steps}
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
          <TypingIndicator context={context} steps={steps} />
        )}
      </>
    )
  }
)

export default MessageItem
