import React, { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"

import {
  API_PROVIDERS,
  DEFAULT_PROVIDER_FORM_VALUES,
  EVENT_NAME,
  FIM_TEMPLATE_FORMAT,
  PROVIDER_EVENT_NAME
} from "../../common/constants"
import {
  P2pDeviceStatus,
  ProviderTestResult
} from "../../common/messaging/protocol"
import { pickModel } from "../../common/model-pick"
import {
  getEndpointDefaults,
  isP2pProvider,
  PROVIDER_TYPES,
  ProviderType
} from "../../common/provider-validation"
import type { TeamOpen, TeamStatus } from "../../common/team"
import { describePooling, describeRecording, policyIsEmpty, policyRefusal } from "../../common/team-policy"
import { TwinnyProvider } from "../../common/types"
import { useProviders } from "../hooks/useProviders"
import { bridge, emit, useServerEvent } from "../messaging"

import { DeviceJobs, DevicesSection } from "./devices"
import { PresetGallery } from "./presets"
import { ProviderCard } from "./provider-card"
import { ProviderForm } from "./provider-form"
import { ShareCard } from "./share"
import { ConnectTeam } from "./team"
import { Welcome } from "./welcome"

import styles from "../styles/providers.module.css"

type View =
  | { name: "list" }
  | { name: "team"; open?: TeamOpen }
  | { name: "gallery"; type: ProviderType }
  | { name: "form"; provider: TwinnyProvider }

const SECTION_ICONS: Record<ProviderType, string> = {
  chat: "comment-discussion",
  fim: "file-code",
  embedding: "database"
}

/** A blank draft for the custom form: any OpenAI-compatible server, on the usual local port. */
const blankProvider = (type: ProviderType): TwinnyProvider => {
  const defaults = getEndpointDefaults(DEFAULT_PROVIDER_FORM_VALUES.provider, type)
  return {
    ...DEFAULT_PROVIDER_FORM_VALUES,
    ...defaults,
    type,
    ...(type === "fim" ? { fimTemplate: FIM_TEMPLATE_FORMAT.automatic } : {})
  }
}

/** A draft provider that runs a job on a paired device. */
const deviceProvider = (
  device: P2pDeviceStatus,
  type: ProviderType
): TwinnyProvider => ({
  id: "",
  label: type === "chat" ? device.name : `${device.name} ${type.toUpperCase()}`,
  modelName: "",
  provider: API_PROVIDERS.TwinnyP2P,
  type,
  deviceId: device.id,
  apiHostname: "",
  apiPath: "",
  apiProtocol: "http",
  apiKey: "",
  ...(type === "fim" ? { fimTemplate: FIM_TEMPLATE_FORMAT.automatic } : {})
})

interface ProvidersProps {
  /** Called once a chat provider exists where there was none: back to chat. */
  onDone?: () => void
}

export const Providers = ({ onDone }: ProvidersProps) => {
  const { t } = useTranslation()
  const [view, setView] = useState<View>({ name: "list" })
  // Set when the gallery was opened from the welcome, so saving the first
  // chat provider finishes the setup rather than showing the list.
  const fromWelcome = useRef(false)
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [results, setResults] = useState<Record<string, ProviderTestResult>>({})
  const [testing, setTesting] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Partial<Record<ProviderType, boolean>>>({})
  const [policy, setPolicy] = useState<TeamStatus | null>(null)
  const [leaving, setLeaving] = useState(false)
  const [confirmingLeave, setConfirmingLeave] = useState(false)
  useServerEvent(PROVIDER_EVENT_NAME.getTeamPolicy, (state) => setPolicy(state ?? null))
  useEffect(() => {
    bridge.request(PROVIDER_EVENT_NAME.getTeamPolicy).then((state) => setPolicy(state ?? null)).catch(() => setPolicy(null))
  }, [])
  // An invite link opened in VS Code: shown as it arrives, or collected on
  // mount when the link was opened before this tab existed.
  const showTeamOpen = (open: TeamOpen | null) => {
    if (open) setView({ name: "team", open })
  }
  useServerEvent(PROVIDER_EVENT_NAME.openTeam, (open) => {
    showTeamOpen(open)
    // Collected, so a later mount does not show it twice.
    bridge.request(PROVIDER_EVENT_NAME.takeTeamOpen).catch(() => undefined)
  })
  useEffect(() => {
    bridge.request(PROVIDER_EVENT_NAME.takeTeamOpen).then(showTeamOpen).catch(() => undefined)
  }, [])
  const leaveTeam = async () => {
    setLeaving(true)
    try {
      await bridge.request(PROVIDER_EVENT_NAME.leaveTeam)
      setPolicy(null)
    } finally {
      setLeaving(false)
      setConfirmingLeave(false)
    }
  }

  const {
    activeProviders,
    providers,
    getProvidersByType,
    setActiveProvider,
    saveProvider,
    removeProvider,
    copyProvider,
    resetProviders,
    testProvider,
    triggerExportProviders,
    triggerImportProviders
  } = useProviders()

  /* ---------------------------------------------------------------------- */
  /*  Devices: one provider per job, made and switched from the device card  */
  /* ---------------------------------------------------------------------- */

  const deviceProviderFor = (device: P2pDeviceStatus, type: ProviderType) =>
    Object.values(providers).find(
      (p) => isP2pProvider(p.provider) && p.deviceId === device.id && p.type === type
    )

  const jobsFor = (device: P2pDeviceStatus): DeviceJobs => {
    const jobs = {} as DeviceJobs
    for (const type of PROVIDER_TYPES) {
      const existing = deviceProviderFor(device, type)
      jobs[type] = existing
        ? {
            state: activeProviders[type]?.id === existing.id ? "active" : "set",
            modelName: existing.modelName
          }
        : { state: "unset" }
    }
    return jobs
  }

  /**
   * First click sets the device up for the job with a sensible model and
   * makes it active; a later click switches back to it; on the active job
   * it opens the form so the model can be changed. The form only appears
   * up front when the device lists nothing to pick from.
   */
  const assignDevice = async (device: P2pDeviceStatus, type: ProviderType) => {
    const existing = deviceProviderFor(device, type)
    if (existing) {
      if (activeProviders[type]?.id === existing.id) openForm(existing)
      else setActiveProvider(type, existing)
      return
    }
    const draft = deviceProvider(device, type)
    const model = pickModel(device.models, type)
    if (!model) {
      openForm(draft)
      return
    }
    const result = await saveProvider({ ...draft, modelName: model })
    if (result.success && result.provider) {
      setActiveProvider(type, result.provider)
    } else {
      openForm(draft)
    }
  }

  const runTest = async (provider: TwinnyProvider) => {
    setTesting((current) => new Set(current).add(provider.id))
    setResults((current) => {
      const next = { ...current }
      delete next[provider.id]
      return next
    })
    const result = await testProvider(provider)
    setResults((current) => ({ ...current, [provider.id]: result }))
    setTesting((current) => {
      const next = new Set(current)
      next.delete(provider.id)
      return next
    })
  }


  const openGallery = (type: ProviderType) => setView({ name: "gallery", type })
  const openForm = (provider: TwinnyProvider) => setView({ name: "form", provider })
  const closeView = () => setView({ name: "list" })

  const finishSetup = () => {
    fromWelcome.current = false
    emit(EVENT_NAME.twinnyHideBackButton)
    onDone?.()
  }

  const chooseFromWelcome = (type: ProviderType) => {
    fromWelcome.current = true
    openGallery(type)
  }

  if (view.name === "team") {
    return (
      <div className={styles.page}>
        <ConnectTeam
          onClose={closeView}
          onDone={finishSetup}
          {...(view.open ? { open: view.open } : {})}
          {...(policy ? { connected: { url: policy.url, ...(policy.keyMissing ? { keyMissing: true } : {}) } } : {})}
        />
      </div>
    )
  }

  if (view.name === "gallery") {
    return (
      <div className={styles.page}>
        <PresetGallery
          type={view.type}
          onSelect={openForm}
          onCustom={() => openForm(blankProvider(view.type))}
          onBack={closeView}
          teamOnly={policy?.policy.teamOnly}
        />
      </div>
    )
  }

  if (view.name === "form") {
    return (
      <div className={styles.page}>
        <ProviderForm
          initial={view.provider}
          onClose={closeView}
          onSaved={(saved) => {
            // A fresh test result for what was just saved is more useful than
            // a stale one for what it used to be.
            setResults((current) => {
              const next = { ...current }
              delete next[saved.id]
              return next
            })
            if (fromWelcome.current && saved.type === "chat") finishSetup()
          }}
        />
      </div>
    )
  }

  // Nothing configured: the welcome takes the whole tab. The header stays
  // so the toolbar (import, in particular) is still reachable.
  const empty = Object.keys(providers).length === 0

  const renderSection = (type: ProviderType) => {
    // Device-backed providers live on their device card, not here.
    const list = getProvidersByType(type)
      .filter((p) => !isP2pProvider(p.provider))
      .sort((a, b) => a.label.localeCompare(b.label))
    const active = activeProviders[type]
    const open = !collapsed[type]
    return (
      <section key={type} className={styles.section}>
        <div className={styles.sectionHeader}>
          <button
            type="button"
            className={styles.sectionToggle}
            aria-expanded={open}
            onClick={() => setCollapsed((c) => ({ ...c, [type]: open }))}
          >
            <i className={`codicon codicon-chevron-${open ? "down" : "right"}`} />
            <i className={`codicon codicon-${SECTION_ICONS[type]}`} />
            {t(`type-${type}`)}
            <span className={styles.sectionCount}>{list.length}</span>
          </button>
          <VSCodeButton
            appearance="icon"
            title={t(`add-${type}-provider`)}
            aria-label={t(`add-${type}-provider`)}
            onClick={() => openGallery(type)}
          >
            <i className="codicon codicon-add" />
          </VSCodeButton>
        </div>

        {open &&
          (list.length === 0 ? (
            <button
              type="button"
              className={styles.emptySection}
              onClick={() => openGallery(type)}
            >
              <i className="codicon codicon-add" />
              <span className={styles.emptySectionText}>
                <span>{t(`add-${type}-provider`)}</span>
                <span className={styles.emptySectionBlurb}>{t(`type-${type}-blurb`)}</span>
              </span>
            </button>
          ) : (
            list.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                active={active?.id === provider.id}
                testResult={results[provider.id]}
                testing={testing.has(provider.id)}
                blocked={policyRefusal(policy ?? undefined, "activate", provider, type)}
                onActivate={() => setActiveProvider(type, provider)}
                onTest={() => runTest(provider)}
                onEdit={() => openForm(provider)}
                onCopy={() => copyProvider(provider)}
                onDelete={() => removeProvider(provider)}
              />
            ))
          ))}
      </section>
    )
  }

  return (
    <div className={styles.page}>
      <div className="tw-page-header">
        <h3>{t("providers")}</h3>
        <div className={styles.toolbar}>
          <VSCodeButton
            appearance="icon"
            title={t("import-providers")}
            aria-label={t("import-providers")}
            onClick={triggerImportProviders}
          >
            <i className="codicon codicon-cloud-upload" />
          </VSCodeButton>
          <VSCodeButton
            appearance="icon"
            title={t("export-providers")}
            aria-label={t("export-providers")}
            onClick={triggerExportProviders}
          >
            <i className="codicon codicon-cloud-download" />
          </VSCodeButton>
          <VSCodeButton
            appearance="icon"
            title={t("reset-providers")}
            aria-label={t("reset-providers")}
            onClick={() => setConfirmingReset(true)}
          >
            <i className="codicon codicon-discard" />
          </VSCodeButton>
        </div>
      </div>

      {confirmingReset && (
        <div className={styles.confirmBanner}>
          <span>
            {t("reset-providers-confirm")}
            {policy && ` ${t("reset-keeps-team")}`}
          </span>
          <VSCodeButton
            appearance="secondary"
            onClick={() => setConfirmingReset(false)}
          >
            {t("cancel")}
          </VSCodeButton>
          <VSCodeButton
            appearance="primary"
            onClick={() => {
              setConfirmingReset(false)
              setResults({})
              resetProviders()
            }}
          >
            {t("reset")}
          </VSCodeButton>
        </div>
      )}

      {policy ? (
        <div className={styles.teamBanner}>
          <span>
            <strong>{policyIsEmpty(policy.policy) ? "Connected to your team" : "Managed by your team"}</strong> · {policy.url}
            {policy.keyMissing ? (
              <p className={styles.teamHint} role="alert">
                Your team key is no longer in this machine&apos;s secret storage. Use Reconnect to sign in again.
              </p>
            ) : null}
            <ul>
              {policy.policy.teamOnly ? <li>Only the team gateway may be used: no other providers can be added or made active.</li> : null}
              {policy.policy.lockDefaults ? <li>The team's default models stay active for chat, autocomplete and embeddings.</li> : null}
              {policy.policy.recording?.length ? <li>{describeRecording(policy.policy.recording)}</li> : null}
              {policy.policy.peers?.length ? <li>{describePooling(policy.policy.peers)}</li> : null}
            </ul>
          </span>
          {confirmingLeave ? (
            <span className={styles.teamActions}>
              <VSCodeButton disabled={leaving} onClick={() => void leaveTeam()}>Leave team and remove its providers</VSCodeButton>
              <VSCodeButton appearance="secondary" disabled={leaving} onClick={() => setConfirmingLeave(false)}>Keep</VSCodeButton>
            </span>
          ) : (
            <span className={styles.teamActions}>
              <VSCodeButton appearance="secondary" onClick={() => setView({ name: "team" })}>Reconnect</VSCodeButton>
              <VSCodeButton appearance="secondary" onClick={() => setConfirmingLeave(true)}>Leave team</VSCodeButton>
            </span>
          )}
        </div>
      ) : (
        <div className={styles.teamEntry}>
          <span><strong>Using Twinny with your team?</strong><br />Open the invite link your admin sent, or connect here with the gateway address.</span>
          <VSCodeButton appearance="secondary" onClick={() => setView({ name: "team" })}>Connect to team</VSCodeButton>
        </div>
      )}

      <ShareCard />

      {empty && (
        <Welcome
          onChoose={chooseFromWelcome}
          onImport={triggerImportProviders}
          onUsed={(created) => {
            if (created.some((p) => p.type === "chat")) finishSetup()
          }}
        />
      )}


      <DevicesSection onUse={assignDevice} jobsFor={jobsFor} />

      {!empty && PROVIDER_TYPES.map(renderSection)}
    </div>
  )
}
