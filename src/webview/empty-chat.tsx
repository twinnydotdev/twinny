import React from "react"
import { useTranslation } from "react-i18next"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"

import { EVENT_NAME } from "../common/constants"
import { ModelStatus, shortTokens, STARTERS } from "../common/model-status"

import { useProviders } from "./hooks/useProviders"
import { emit } from "./messaging"
import { useLoadedLabel } from "./model-state"

import styles from "./styles/chat.module.css"

/**
 * The transcript before the first message, done as a small CRT coming on:
 * the pane flickers up, the title types itself out under a block cursor,
 * then the line naming the provider and model fades in. It says where a
 * reply will come from; or, with nothing set, where to fix that.
 *
 * Under that, what the model's server says about it (how much it holds,
 * whether it is in memory) and three first questions about the open file.
 */
export const EmptyChat = ({
  status,
  warming,
  onWarm,
  disabled
}: {
  status: ModelStatus | null
  warming: boolean
  onWarm: () => void
  disabled?: boolean
}) => {
  const { t } = useTranslation()
  const { chatProvider, ready } = useProviders()
  const title = t("empty-chat-title")
  const loaded = useLoadedLabel(status)

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

        {ready && chatProvider && status && (status.contextWindow || loaded) && (
          <div className={styles.crtFacts}>
            {(status.contextWindow || loaded) && (
              <span className={styles.crtChips}>
                {status.contextWindow && (
                  <span
                    className={styles.crtChip}
                    title={t("model-context-title", { window: status.contextWindow.toLocaleString() })}
                  >
                    {t("model-context", { window: shortTokens(status.contextWindow) })}
                  </span>
                )}
                {loaded && (
                  <span
                    className={styles.crtChip}
                    title={
                      status.loaded === false ? t("model-not-loaded-title", { model: chatProvider.modelName }) : undefined
                    }
                  >
                    {warming ? t("model-loading") : loaded}
                  </span>
                )}
                {status.loadError && !warming && (
                  <span className={`${styles.crtChip} ${styles.crtChipError}`} title={status.loadError}>
                    {t("model-load-failed")}
                  </span>
                )}
                {status.canLoad && !warming && (
                  <button type="button" className={styles.crtLoad} onClick={onWarm}>
                    {t("model-load")}
                  </button>
                )}
              </span>
            )}
          </div>
        )}

        {ready && chatProvider && (
          <div className={styles.starters} title={t("starters-title")}>
            {STARTERS.map((kind) => (
              <button
                key={kind}
                type="button"
                className={styles.starter}
                disabled={disabled}
                onClick={() => emit(EVENT_NAME.twinnyStarter, kind)}
              >
                {t(`starter-${kind}`)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
