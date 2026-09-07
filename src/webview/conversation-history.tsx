import { useTranslation } from "react-i18next"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import DOMPurify from "dompurify"

import { EVENT_NAME } from "../common/constants"
import { Conversation } from "../common/types"

import { useConversationHistory } from "./hooks/useConversationHistory"
import { emit } from "./messaging"

import styles from "./styles/conversation-history.module.css"

interface ConversationHistoryProps {
  onSelect: () => void
}

export const ConversationHistory = ({ onSelect }: ConversationHistoryProps) => {
  const { t } = useTranslation()
  const {
    conversations: savedConversations,
    setActiveConversation,
    removeConversation,
    clearAllConversations
  } = useConversationHistory()

  const handleSetConversation = (conversation: Conversation) => {
    setActiveConversation(conversation)
    onSelect()
    emit(EVENT_NAME.twinnyHideBackButton)
  }

  const handleRemoveConversation = (
    event: React.MouseEvent,
    conversation: Conversation
  ) => {
    event.stopPropagation()
    removeConversation(conversation)
  }

  function stripHtml(html: string) {
    const tmp = document.createElement("DIV")
    tmp.innerHTML = html
    return tmp.textContent || tmp.innerText || ""
  }

  const handleClearAllConversations = () => clearAllConversations()

  const conversations = Object.values(savedConversations).reverse()

  const getTitle = (conversation: Conversation) => {
    return (
      DOMPurify.sanitize(stripHtml(conversation.title || "")) ||
      t("conversation-history-random-title")
    )
  }

  return (
    <div>
      <h3>
        {t("conversation-history")} ({conversations.length})
      </h3>
      <VSCodeButton appearance="primary" onClick={handleClearAllConversations}>
        {t("clear-conversations")}
      </VSCodeButton>
      {conversations.length ? (
        conversations.map((conversation) => (
          <div
            onClick={() => handleSetConversation(conversation)}
            className={styles.conversation}
            key={conversation.id}
          >
            <div className={styles.conversationTitle}>
              {getTitle(conversation)}
            </div>
            <VSCodeButton
              appearance="icon"
              onClick={(e) => handleRemoveConversation(e, conversation)}
            >
              <i className="codicon codicon-trash" />
            </VSCodeButton>
          </div>
        ))
      ) : (
        <p>{t("nothing-to-see-here")}</p>
      )}
    </div>
  )
}
