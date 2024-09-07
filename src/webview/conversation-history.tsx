import { VSCodeButton } from '@vscode/webview-ui-toolkit/react'

import { Conversation } from '../common/types'
import styles from './styles/conversation-history.module.css'
import { useConversationHistory } from './hooks'
import { EVENT_NAME } from '../common/constants'

interface ConversationHistoryProps {
  onSelect: () => void
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any
export const ConversationHistory = ({ onSelect }: ConversationHistoryProps) => {
  const {
    conversations: savedConversations,
    setActiveConversation,
    removeConversation,
    clearAllConversations
  } = useConversationHistory()

  const handleSetConversation = (conversation: Conversation) => {
    setActiveConversation(conversation)
    onSelect()
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyHideBackButton
    })
  }

  const handleRemoveConversation = (
    event: React.MouseEvent,
    conversation: Conversation
  ) => {
    event.stopPropagation()
    removeConversation(conversation)
  }

  const handleClearAllConversations = () => clearAllConversations()

  const conversations = Object.values(savedConversations).reverse()

  return (
    <div>
      <h3>Conversation history</h3>
      <VSCodeButton appearance="primary" onClick={handleClearAllConversations}>
        Clear conversations
      </VSCodeButton>
      {conversations.length ? (
        conversations.map((conversation) => (
          <div
            onClick={() => handleSetConversation(conversation)}
            className={styles.conversation}
            key={conversation.id}
          >
            <div>{conversation.title?.substring(0, 100)}...</div>
            <VSCodeButton
              appearance="icon"
              onClick={(e) => handleRemoveConversation(e, conversation)}
            >
              <i className="codicon codicon-trash" />
            </VSCodeButton>
          </div>
        ))
      ) : (
        <p>Nothing to see here...</p>
      )}
    </div>
  )
}
