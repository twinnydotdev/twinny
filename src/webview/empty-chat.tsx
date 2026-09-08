import React from "react"
import { useTranslation } from "react-i18next"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"

import { EVENT_NAME } from "../common/constants"

import { useProviders } from "./hooks/useProviders"
import { emit } from "./messaging"

import styles from "./styles/chat.module.css"

/**
 * The transcript before the first message, done as a small CRT coming on:
 * the pane flickers up, the title types itself out under a block cursor,
 * then the line naming the provider and model fades in. It says where a
 * reply will come from; or, with nothing set, where to fix that.
 */
export const EmptyChat = () => {
  const { t } = useTranslation()
  const { chatProvider, ready } = useProviders()
  const title = t("empty-chat-title")

  return (
    <div className={styles.emptyChat}>
      <div className={styles.crt}>
        <div className={styles.crtGlyph} aria-hidden="true">
          &#10095;_
        </div>
        <h4
          className={styles.crtTitle}
          style={{ "--chars": title.length } as React.CSSProperties}
        >
          <span className={styles.crtTyped}>{title}</span>
          <span className={styles.crtCursor} aria-hidden="true" />
        </h4>

        {ready && (
          <div className={styles.crtLine}>
            {chatProvider ? (
              <>
                <span className={styles.crtLabel}>
                  <i className="codicon codicon-server-environment" />
                  {t("empty-chat-using")}
                </span>
                <strong className={styles.crtProvider}>
                  {t(chatProvider.label)}
                </strong>
                {chatProvider.modelName && (
                  <code className={styles.crtModel} title={chatProvider.modelName}>
                    {chatProvider.modelName}
                  </code>
                )}
              </>
            ) : (
              <>
                <span className={`${styles.crtLabel} ${styles.crtNote}`}>
                  <i className="codicon codicon-warning" />
                  <span>{t("empty-chat-no-provider")}</span>
                </span>
                <VSCodeButton
                  appearance="primary"
                  onClick={() => emit(EVENT_NAME.twinnyOpenProviders)}
                >
                  {t("welcome-choose")}
                </VSCodeButton>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
