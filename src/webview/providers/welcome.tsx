import React, { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"

import { DiscoveredServer } from "../../common/provider-discovery"
import { ProviderType } from "../../common/provider-validation"
import { TwinnyProvider } from "../../common/types"
import { useProviders } from "../hooks/useProviders"

import styles from "../styles/providers.module.css"

interface Props {
  onChoose: (type: ProviderType) => void
  onImport: () => void
  /** A found server was taken up; these providers now exist. */
  onUsed: (created: TwinnyProvider[]) => void
}

type Search =
  | { status: "searching" }
  | { status: "done"; servers: DiscoveredServer[] }

const serverKey = (server: DiscoveredServer) =>
  `${server.provider}|${server.apiHostname}|${server.apiPort}`

/**
 * What the providers tab shows when there are none: a search of the usual
 * local ports, with one click to use whatever answered, and the way to the
 * gallery for everyone else. Nothing is written until the person says so.
 */
export const Welcome = ({ onChoose, onImport, onUsed }: Props) => {
  const { t } = useTranslation()
  const { discoverServers, useDiscoveredServer } = useProviders()
  const [search, setSearch] = useState<Search>({ status: "searching" })
  const [applying, setApplying] = useState<string | null>(null)

  const runSearch = async () => {
    setSearch({ status: "searching" })
    const servers = await discoverServers()
    setSearch({ status: "done", servers })
  }

  useEffect(() => {
    void runSearch()
  }, [])

  const use = async (server: DiscoveredServer) => {
    setApplying(serverKey(server))
    const created = await useDiscoveredServer(server)
    if (created.length === 0) {
      setApplying(null)
      return
    }
    onUsed(created)
  }

  return (
    <section className={styles.welcome}>
      <h4>
        <i className="codicon codicon-rocket" />
        {t("welcome-title")}
      </h4>
      <p className={styles.welcomeIntro}>{t("welcome-intro")}</p>

      <div className={styles.welcomeSearch}>
        {search.status === "searching" ? (
          <div className={styles.welcomeStatus}>
            <i className="codicon codicon-loading codicon-modifier-spin" />
            {t("welcome-searching")}
          </div>
        ) : search.servers.length === 0 ? (
          <div className={styles.welcomeStatus}>
            <i className="codicon codicon-info" />
            {t("welcome-none-found")}
          </div>
        ) : (
          <>
            <h5 className={styles.galleryGroup}>{t("welcome-found")}</h5>
            <ul className={styles.welcomeServers}>
              {search.servers.map((server) => {
                const key = serverKey(server)
                const busy = applying === key
                return (
                  <li key={key} className={styles.welcomeServer}>
                    <i className="codicon codicon-server" />
                    <span className={styles.welcomeServerText}>
                      <span className={styles.presetName}>{server.label}</span>
                      <span className={styles.presetDescription}>
                        {server.apiHostname}:{server.apiPort} ·{" "}
                        {t("welcome-models", { count: server.models.length })}
                      </span>
                    </span>
                    <VSCodeButton
                      appearance="primary"
                      disabled={applying !== null}
                      onClick={() => use(server)}
                    >
                      {busy ? t("welcome-applying") : t("welcome-use")}
                    </VSCodeButton>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>

      <div className={styles.welcomeActions}>
        <VSCodeButton
          appearance={
            search.status === "done" && search.servers.length === 0
              ? "primary"
              : "secondary"
          }
          onClick={() => onChoose("chat")}
        >
          <i className="codicon codicon-add" />
          {t("welcome-choose")}
        </VSCodeButton>
        <VSCodeButton
          appearance="secondary"
          disabled={search.status === "searching"}
          onClick={runSearch}
        >
          <i className="codicon codicon-refresh" />
          {t("welcome-retry")}
        </VSCodeButton>
        <button type="button" className={styles.linkButton} onClick={onImport}>
          {t("import-providers")}
        </button>
      </div>
    </section>
  )
}
