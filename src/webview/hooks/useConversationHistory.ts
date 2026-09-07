import { useEffect, useState } from "react"

import { CONVERSATION_EVENT_NAME } from "../../common/constants"
import { Conversation } from "../../common/types"
import { emit, useServerEvent } from "../messaging"

export const useConversationHistory = () => {
  const [conversations, setConversations] = useState<
    Record<string, Conversation>
  >({})
  const [conversation, setConversation] = useState<Conversation>()

  useServerEvent(CONVERSATION_EVENT_NAME.getConversations, (all) => {
    if (all) setConversations(all)
  })
  useServerEvent(CONVERSATION_EVENT_NAME.setActiveConversation, (active) => {
    if (active) setConversation(active)
  })

  const getConversations = () => emit(CONVERSATION_EVENT_NAME.getConversations)

  const setActiveConversation = (next: Conversation | undefined) => {
    emit(CONVERSATION_EVENT_NAME.setActiveConversation, next)
    setConversation(next)
  }

  useEffect(() => {
    getConversations()
    emit(CONVERSATION_EVENT_NAME.getActiveConversation)
  }, [])

  return {
    conversation,
    conversations,
    getConversations,
    setActiveConversation,
    clearAllConversations: () =>
      emit(CONVERSATION_EVENT_NAME.clearAllConversations),
    removeConversation: (target: Conversation) =>
      emit(CONVERSATION_EVENT_NAME.removeConversation, target),
    renameConversation: (id: string, title: string) =>
      emit(CONVERSATION_EVENT_NAME.renameConversation, { id, title }),
    saveLastConversation: (target: Conversation | undefined) =>
      emit(CONVERSATION_EVENT_NAME.saveConversation, target)
  }
}
