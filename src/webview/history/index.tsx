import React, { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { VSCodeButton, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import { EVENT_NAME } from "../../common/constants"
import { DATE_BUCKETS, formatRelativeTime, getDateBucket } from "../../common/time"
import { Conversation } from "../../common/types"
import { useConversationHistory } from "../hooks/useConversationHistory"
import { emit } from "../messaging"

import styles from "../styles/history.module.css"

interface ConversationHistoryProps {
  onSelect: () => void
}

/** The composer stores HTML; titles and previews want the words. */
const stripHtml = (html: string) => {
  const container = document.createElement("div")
  container.innerHTML = html
  return (container.textContent || "").replace(/\s+/g, " ").trim()
}

const firstUserLine = (conversation: Conversation) => {
  const first = conversation.messages?.find((m) => m.role === "user")
  const content = first?.content
  return typeof content === "string" ? stripHtml(content) : ""
}

export const ConversationHistory = ({ onSelect }: ConversationHistoryProps) => {
  const { t } = useTranslation()
  const {
    conversation: active,
    conversations,
    setActiveConversation,
    removeConversation,
    renameConversation,
    clearAllConversations
  } = useConversationHistory()

  const [query, setQuery] = useState("")
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(
    null
  )

  const titleOf = (conversation: Conversation) =>
    stripHtml(conversation.title || "") || t("conversation-history-random-title")

  const grouped = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const list = Object.values(conversations)
      .filter((c) => c.id)
      .filter((c) => {
        if (!needle) return true
        if (titleOf(c).toLowerCase().includes(needle)) return true
        return c.messages?.some(
          (m) =>
            typeof m.content === "string" &&
            stripHtml(m.content).toLowerCase().includes(needle)
        )
      })
      // Newest first; conversations from older builds have no timestamp and
      // keep their stored order at the end.
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))

    return DATE_BUCKETS.map((bucket) => ({
      bucket,
      items: list.filter((c) => getDateBucket(c.updatedAt) === bucket)
    })).filter((group) => group.items.length > 0)
  }, [conversations, query])

  const total = Object.keys(conversations).length

  const open = (conversation: Conversation) => {
    setActiveConversation(conversation)
    onSelect()
    emit(EVENT_NAME.twinnyHideBackButton)
  }

  const startNew = () => {
    emit(EVENT_NAME.twinnyNewConversation)
    onSelect()
    emit(EVENT_NAME.twinnyHideBackButton)
  }

  const commitRename = () => {
    if (renaming && renaming.title.trim()) {
      renameConversation(renaming.id, renaming.title)
    }
    setRenaming(null)
  }

  const renderRow = (conversation: Conversation) => {
    const id = conversation.id as string
    const isActive = active?.id === id
    const isRenaming = renaming?.id === id
    const isDeleting = confirmingDelete === id
    const preview = firstUserLine(conversation)
    const count = conversation.messages?.length || 0

    return (
      <li
        key={id}
        className={`${styles.row} ${isActive ? styles.rowActive : ""}`}
      >
        {isRenaming ? (
          <div className={styles.renameRow}>
            <VSCodeTextField
              autofocus
              value={renaming.title}
              onInput={(e) =>
                setRenaming({
                  id,
                  title: (e as unknown as React.ChangeEvent<HTMLInputElement>)
                    .target.value
                })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename()
                if (e.key === "Escape") setRenaming(null)
              }}
            />
            <VSCodeButton appearance="icon" title={t("save")} onClick={commitRename}>
              <i className="codicon codicon-check" />
            </VSCodeButton>
            <VSCodeButton
              appearance="icon"
              title={t("cancel")}
              onClick={() => setRenaming(null)}
            >
              <i className="codicon codicon-close" />
            </VSCodeButton>
          </div>
        ) : (
          <div className={styles.rowMain}>
            <button
              type="button"
              className={styles.rowBody}
              onClick={() => open(conversation)}
              title={preview}
            >
              <span className={styles.rowTitle}>
                {isActive && <i className="codicon codicon-circle-filled" />}
                {titleOf(conversation)}
              </span>
              <span className={styles.rowMeta}>
                {t("history-messages", { count })}
                {conversation.updatedAt
                  ? ` · ${formatRelativeTime(conversation.updatedAt)}`
                  : ""}
                {preview ? ` · ${preview}` : ""}
              </span>
            </button>
            <div className={styles.rowActions}>
              <VSCodeButton
                appearance="icon"
                title={t("history-rename")}
                aria-label={t("history-rename")}
                onClick={() => setRenaming({ id, title: titleOf(conversation) })}
              >
                <i className="codicon codicon-edit" />
              </VSCodeButton>
              <VSCodeButton
                appearance="icon"
                title={t("delete-conversation")}
                aria-label={t("delete-conversation")}
                onClick={() => setConfirmingDelete(id)}
              >
                <i className="codicon codicon-trash" />
              </VSCodeButton>
            </div>
          </div>
        )}

        {isDeleting && (
          <div className={styles.confirmRow}>
            <span>{t("history-delete-confirm", { title: titleOf(conversation) })}</span>
            <VSCodeButton
              appearance="secondary"
              onClick={() => setConfirmingDelete(null)}
            >
              {t("cancel")}
            </VSCodeButton>
            <VSCodeButton
              appearance="primary"
              onClick={() => {
                setConfirmingDelete(null)
                removeConversation(conversation)
              }}
            >
              {t("remove")}
            </VSCodeButton>
          </div>
        )}
      </li>
    )
  }

  return (
    <div className={styles.page}>
      <div className="tw-page-header">
        <h3>
          {t("conversation-history")}
          <span className={styles.count}>{total}</span>
        </h3>
        <div className={styles.toolbar}>
          <VSCodeButton
            appearance="icon"
            title={t("new-conversation")}
            aria-label={t("new-conversation")}
            onClick={startNew}
          >
            <i className="codicon codicon-add" />
          </VSCodeButton>
          <VSCodeButton
            appearance="icon"
            title={t("clear-conversations")}
            aria-label={t("clear-conversations")}
            disabled={total === 0}
            onClick={() => setConfirmingClear(true)}
          >
            <i className="codicon codicon-clear-all" />
          </VSCodeButton>
        </div>
      </div>

      {confirmingClear && (
        <div className={styles.confirmBanner}>
          <span>{t("history-clear-confirm", { count: total })}</span>
          <VSCodeButton
            appearance="secondary"
            onClick={() => setConfirmingClear(false)}
          >
            {t("cancel")}
          </VSCodeButton>
          <VSCodeButton
            appearance="primary"
            onClick={() => {
              setConfirmingClear(false)
              clearAllConversations()
            }}
          >
            {t("clear")}
          </VSCodeButton>
        </div>
      )}

      {total > 0 && (
        <VSCodeTextField
          className={styles.search}
          placeholder={t("history-search")}
          value={query}
          onInput={(e) =>
            setQuery(
              (e as unknown as React.ChangeEvent<HTMLInputElement>).target.value
            )
          }
        >
          <span slot="start" className="codicon codicon-search" />
        </VSCodeTextField>
      )}

      {total === 0 ? (
        <button type="button" className={styles.empty} onClick={startNew}>
          <i className="codicon codicon-comment-discussion" />
          <span>{t("history-empty")}</span>
        </button>
      ) : grouped.length === 0 ? (
        <p className={styles.noMatch}>{t("history-no-match", { query })}</p>
      ) : (
        grouped.map(({ bucket, items }) => (
          <section key={bucket} className={styles.group}>
            <h5 className={styles.groupTitle}>{t(`history-${bucket}`)}</h5>
            <ul className={styles.list}>{items.map(renderRow)}</ul>
          </section>
        ))
      )}
    </div>
  )
}
