import React, { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { VSCodeButton, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import { P2pDeviceStatus, P2pHostStatus } from "../../common/messaging/protocol"
import { PROVIDER_TYPES, ProviderType } from "../../common/provider-validation"
import { useDevices, useHost } from "../hooks/useDevices"

import styles from "../styles/providers.module.css"

type InputEvent = Event | React.FormEvent<HTMLElement>

const valueOf = (e: InputEvent) =>
  (e as unknown as React.ChangeEvent<HTMLInputElement>).target.value

const STATE_ICONS: Record<P2pDeviceStatus["state"], string> = {
  online: "circle-filled",
  connecting: "loading codicon-modifier-spin",
  offline: "circle-outline"
}

const JOB_ICONS: Record<ProviderType, string> = {
  chat: "comment-discussion",
  fim: "file-code",
  embedding: "database"
}

/** What a device does for one job: nothing yet, set up, or the one in use. */
export interface DeviceJob {
  state: "unset" | "set" | "active"
  modelName?: string
}

export type DeviceJobs = Record<ProviderType, DeviceJob>

interface PairFormProps {
  onDone: (device?: P2pDeviceStatus) => void
  onCancel: () => void
}

const PairForm = ({ onDone, onCancel }: PairFormProps) => {
  const { t } = useTranslation()
  const { pairDevice } = useDevices()
  const [code, setCode] = useState("")
  const [name, setName] = useState("")
  const [pairing, setPairing] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!code.trim() || pairing) return
    setPairing(true)
    setError(undefined)
    const result = await pairDevice(code, name.trim() || undefined)
    setPairing(false)
    if (result.success) {
      onDone(result.device)
    } else {
      setError(result.error || t("unknown-error"))
    }
  }

  return (
    <form className={styles.pairForm} onSubmit={submit} noValidate>
      <p className={styles.sectionBlurb}>{t("pairing-code-hint")}</p>
      <div className={styles.field}>
        <label htmlFor="pairing-code">{t("pairing-code")}</label>
        <VSCodeTextField
          id="pairing-code"
          value={code}
          placeholder={t("pairing-code-placeholder")}
          autofocus
          onInput={(e) => {
            setError(undefined)
            setCode(valueOf(e))
          }}
        />
      </div>
      <div className={styles.field}>
        <label htmlFor="device-name">{t("device-name")}</label>
        <VSCodeTextField
          id="device-name"
          value={name}
          placeholder={t("device-name-placeholder")}
          onInput={(e) => setName(valueOf(e))}
        />
      </div>
      {error && (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      )}
      <div className={styles.formActions}>
        <span className={styles.formActionsSpacer} />
        <VSCodeButton appearance="secondary" disabled={pairing} onClick={onCancel}>
          {t("cancel")}
        </VSCodeButton>
        <VSCodeButton
          appearance="primary"
          type="submit"
          disabled={pairing || !code.trim()}
        >
          {pairing && <i className="codicon codicon-loading codicon-modifier-spin" />}
          {pairing ? t("pairing") : t("pair")}
        </VSCodeButton>
      </div>
    </form>
  )
}

interface DeviceCardProps {
  device: P2pDeviceStatus
  jobs: DeviceJobs
  onUse: (type: ProviderType) => void
  onRefresh: () => void
  onRemove: () => void
}

/**
 * One paired device. The chips are the whole story of what it does for
 * you: a job it is set up for, the job it is active for, and the ones it
 * could take on. Providers behind them are created and switched from here.
 */
const DeviceCard = ({ device, jobs, onUse, onRefresh, onRemove }: DeviceCardProps) => {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const online = device.state === "online"
  const summary = online
    ? [
        device.latencyMs !== undefined ? `${device.latencyMs} ms` : "",
        device.ollamaOk === false
          ? t("device-ollama-down")
          : device.models.length
            ? t("device-models", { count: device.models.length })
            : t("device-no-models")
      ]
        .filter(Boolean)
        .join(" · ")
    : device.error || t(`device-${device.state}`)

  const refresh = async () => {
    setRefreshing(true)
    await onRefresh()
    setRefreshing(false)
  }

  const chipTitle = (type: ProviderType) => {
    const job = jobs[type]
    const name = t(`type-${type}`)
    if (job.state === "active") return t("device-job-active", { job: name })
    if (job.state === "set") return t("device-job-set", { job: name })
    return t(`use-for-${type}`)
  }

  return (
    <div className={`${styles.card} ${online ? styles.cardActive : ""}`}>
      <div className={styles.cardMain}>
        <span
          className={`${styles.deviceState} ${styles[`deviceState-${device.state}`] || ""}`}
          title={t(`device-${device.state}`)}
        >
          <i className={`codicon codicon-${STATE_ICONS[device.state]}`} />
        </span>
        <div className={styles.cardText}>
          <div className={styles.cardTitle}>
            <span className={styles.cardLabel}>{device.name}</span>
            <span className={styles.cardBadge}>{t(`device-${device.state}`)}</span>
          </div>
          <div
            className={styles.cardSummary}
            title={device.models.length ? device.models.join(", ") : summary}
          >
            {summary}
          </div>
        </div>
        <div className={styles.cardActions}>
          {!online && (
            <VSCodeButton
              appearance="icon"
              title={t("refresh-device")}
              aria-label={t("refresh-device")}
              disabled={refreshing}
              onClick={refresh}
            >
              <i
                className={`codicon codicon-${
                  refreshing ? "loading codicon-modifier-spin" : "sync"
                }`}
              />
            </VSCodeButton>
          )}
          <VSCodeButton
            appearance="icon"
            title={t("remove-device")}
            aria-label={t("remove-device")}
            onClick={() => setConfirming(true)}
          >
            <i className="codicon codicon-trash" />
          </VSCodeButton>
        </div>
      </div>

      <div className={styles.jobChips}>
        {PROVIDER_TYPES.map((type) => {
          const job = jobs[type]
          return (
            <button
              key={type}
              type="button"
              className={`${styles.jobChip} ${styles[`jobChip-${job.state}`] || ""}`}
              title={chipTitle(type)}
              aria-pressed={job.state === "active"}
              onClick={() => onUse(type)}
            >
              <i className={`codicon codicon-${JOB_ICONS[type]}`} />
              <span>{t(`type-${type}`)}</span>
              {job.modelName && (
                <span className={styles.jobChipModel}>{job.modelName}</span>
              )}
            </button>
          )
        })}
      </div>

      {confirming && (
        <div className={styles.confirmRow}>
          <span>{t("remove-device-confirm", { name: device.name })}</span>
          <VSCodeButton appearance="secondary" onClick={() => setConfirming(false)}>
            {t("cancel")}
          </VSCodeButton>
          <VSCodeButton
            appearance="primary"
            onClick={() => {
              setConfirming(false)
              onRemove()
            }}
          >
            {t("remove")}
          </VSCodeButton>
        </div>
      )}
    </div>
  )
}

const formatCountdown = (expiresAt: number, now: number) => {
  const seconds = Math.max(0, Math.round((expiresAt - now) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

/**
 * This computer as a node. Start sharing, hand out a pairing code, see who
 * is paired; all without leaving the editor.
 */
const HostCard = () => {
  const { t } = useTranslation()
  const { host, startHost, stopHost, newPairingCode, removeTrustedPeer } =
    useHost()
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [showPeers, setShowPeers] = useState(false)
  const [now, setNow] = useState(Date.now())

  // A ticking countdown while a code is showing.
  useEffect(() => {
    if (!host?.pairingExpiresAt) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [host?.pairingExpiresAt])

  if (!host) return null

  const run = async (action: () => Promise<P2pHostStatus | undefined>) => {
    setBusy(true)
    await action()
    setBusy(false)
  }

  const copy = async () => {
    if (!host.pairingCode) return
    try {
      await navigator.clipboard.writeText(host.pairingCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Selecting the code by hand still works.
    }
  }

  // Idle, the card is a single quiet row; the pitch lives in the button's
  // tooltip rather than in text that a narrow sidebar would cut off anyway.
  const summary = host.running
    ? [
        host.ollamaOk === false ? t("host-ollama-down") : host.ollamaUrl,
        t("host-port", { port: host.port }),
        t("host-paired-count", { count: host.trustedPeers.length })
      ].join(" · ")
    : host.runningElsewhere
      ? t("host-running-elsewhere")
      : host.error || host.name

  return (
    <div className={`${styles.card} ${host.running ? styles.cardActive : ""}`}>
      <div className={styles.cardMain}>
        <span
          className={`${styles.deviceState} ${host.running ? styles["deviceState-online"] : ""}`}
        >
          <i className={`codicon codicon-${host.running ? "broadcast" : "device-desktop"}`} />
        </span>
        <div className={styles.cardText}>
          <div className={styles.cardTitle}>
            <span className={styles.cardLabel} title={host.name}>
              {t("this-computer")}
            </span>
            {host.running && (
              <span className={styles.cardBadge}>{t("host-sharing")}</span>
            )}
          </div>
          <div className={styles.cardSummary} title={summary}>
            {summary}
          </div>
        </div>
        <div className={styles.cardActions}>
          {host.running && host.trustedPeers.length > 0 && (
            <VSCodeButton
              appearance="icon"
              title={t("host-paired-devices")}
              aria-label={t("host-paired-devices")}
              onClick={() => setShowPeers((v) => !v)}
            >
              <i className={`codicon codicon-${showPeers ? "chevron-up" : "list-unordered"}`} />
            </VSCodeButton>
          )}
          {host.running ? (
            <>
              <VSCodeButton
                appearance="icon"
                title={t("new-pairing-code")}
                aria-label={t("new-pairing-code")}
                disabled={busy}
                onClick={() => run(newPairingCode)}
              >
                <i className="codicon codicon-key" />
              </VSCodeButton>
              <VSCodeButton
                appearance="icon"
                title={t("stop-sharing")}
                aria-label={t("stop-sharing")}
                disabled={busy}
                onClick={() => run(stopHost)}
              >
                <i className="codicon codicon-debug-stop" />
              </VSCodeButton>
            </>
          ) : host.runningElsewhere ? (
            <VSCodeButton
              appearance="icon"
              title={t("stop-sharing")}
              aria-label={t("stop-sharing")}
              disabled={busy}
              onClick={() => run(stopHost)}
            >
              <i className="codicon codicon-debug-stop" />
            </VSCodeButton>
          ) : (
            <VSCodeButton
              appearance="secondary"
              disabled={busy}
              title={t("host-blurb")}
              onClick={() => run(startHost)}
            >
              {busy && <i className="codicon codicon-loading codicon-modifier-spin" />}
              {t("start-sharing")}
            </VSCodeButton>
          )}
        </div>
      </div>

      {host.running && host.pairingCode && host.pairingExpiresAt && (
        <div className={styles.pairingCode}>
          <div className={styles.pairingCodeHead}>
            <span>{t("pairing-code")}</span>
            <span className={styles.fieldHint}>
              {t("pairing-code-expires", {
                time: formatCountdown(host.pairingExpiresAt, now)
              })}
            </span>
            <VSCodeButton
              appearance="icon"
              title={t("copy-code")}
              aria-label={t("copy-code")}
              onClick={copy}
            >
              <i className={`codicon codicon-${copied ? "check" : "copy"}`} />
            </VSCodeButton>
          </div>
          <code>{host.pairingCode}</code>
          <p className={styles.fieldHint}>{t("pairing-code-share-hint")}</p>
          <p className={styles.fieldHint}>{t("host-port-hint", { port: host.port })}</p>
        </div>
      )}

      {host.running && !host.pairingCode && host.trustedPeers.length === 0 && (
        <div className={styles.confirmRow}>
          <span>{t("host-no-peers")}</span>
          <VSCodeButton appearance="secondary" disabled={busy} onClick={() => run(newPairingCode)}>
            {t("new-pairing-code")}
          </VSCodeButton>
        </div>
      )}

      {host.running && showPeers && host.trustedPeers.length > 0 && (
        <ul className={styles.peerList}>
          {host.trustedPeers.map((peer) => (
            <li key={peer.id}>
              <i
                className={`codicon codicon-${peer.connected ? "circle-filled" : "circle-outline"}`}
                title={peer.connected ? t("device-online") : t("device-offline")}
              />
              <span className={styles.peerName}>{peer.name}</span>
              <span className={styles.fieldHint}>{peer.id.slice(0, 8)}…</span>
              <VSCodeButton
                appearance="icon"
                title={t("remove-trusted-peer")}
                aria-label={t("remove-trusted-peer")}
                disabled={busy}
                onClick={() => run(() => removeTrustedPeer(peer.id))}
              >
                <i className="codicon codicon-trash" />
              </VSCodeButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

interface DevicesSectionProps {
  /** Set the device up for a job, or switch to it. */
  onUse: (device: P2pDeviceStatus, type: ProviderType) => void
  /** What each device currently does, from the provider list. */
  jobsFor: (device: P2pDeviceStatus) => DeviceJobs
}

/**
 * Other computers paired over Twinny P2P, and this one as a node. Folded
 * away until it is in use, so people who never pair anything do not scroll
 * past it.
 */
export const DevicesSection = ({ onUse, jobsFor }: DevicesSectionProps) => {
  const { t } = useTranslation()
  const { devices, refreshDevice, removeDevice } = useDevices()
  const { host } = useHost()
  const [adding, setAdding] = useState(false)
  const [toggled, setToggled] = useState<boolean | undefined>()

  const inUse = devices.length > 0 || !!host?.enabled
  const open = toggled ?? inUse

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <button
          type="button"
          className={styles.sectionToggle}
          aria-expanded={open}
          onClick={() => setToggled(!open)}
        >
          <i className={`codicon codicon-chevron-${open ? "down" : "right"}`} />
          <i className="codicon codicon-broadcast" />
          {t("devices")}
          <span className={styles.sectionCount}>{devices.length}</span>
        </button>
        <VSCodeButton
          appearance="icon"
          title={t("add-device")}
          aria-label={t("add-device")}
          onClick={() => {
            setToggled(true)
            setAdding(true)
          }}
        >
          <i className="codicon codicon-add" />
        </VSCodeButton>
      </div>

      {open && (
        <>
          <HostCard />

          {adding && (
            <PairForm onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />
          )}

          {devices.length === 0 && !adding ? (
            <button
              type="button"
              className={styles.emptySection}
              onClick={() => setAdding(true)}
            >
              <i className="codicon codicon-add" />
              <span className={styles.emptySectionText}>
                <span>{t("add-device")}</span>
                <span className={styles.emptySectionBlurb}>{t("devices-blurb")}</span>
              </span>
            </button>
          ) : (
            devices.map((device) => (
              <DeviceCard
                key={device.id}
                device={device}
                jobs={jobsFor(device)}
                onUse={(type) => onUse(device, type)}
                onRefresh={() => refreshDevice(device.id)}
                onRemove={() => removeDevice(device.id)}
              />
            ))
          )}
        </>
      )}
    </section>
  )
}
