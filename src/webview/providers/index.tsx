import React, { useState } from "react"
import { useTranslation } from "react-i18next"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"

import {
  API_PROVIDERS,
  DEFAULT_PROVIDER_FORM_VALUES,
  FIM_TEMPLATE_FORMAT
} from "../../common/constants"
import {
  P2pDeviceStatus,
  ProviderTestResult
} from "../../common/messaging/protocol"
import {
  getEndpointDefaults,
  isP2pProvider,
  PROVIDER_TYPES,
  ProviderType
} from "../../common/provider-validation"
import { TwinnyProvider } from "../../common/types"
import { useProviders } from "../hooks/useProviders"

import { DeviceJobs, DevicesSection } from "./devices"
import { PresetGallery } from "./presets"
import { ProviderCard } from "./provider-card"
import { pickModel, ProviderForm } from "./provider-form"
import { SetupCheck } from "./setup-check"

import styles from "../styles/providers.module.css"

type View =
  | { name: "list" }
  | { name: "gallery"; type: ProviderType }
  | { name: "form"; provider: TwinnyProvider }

const SECTION_ICONS: Record<ProviderType, string> = {
  chat: "comment-discussion",
  fim: "file-code",
  embedding: "database"
}

/** A blank draft for the custom form, pointed at Ollama's usual address. */
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

export const Providers = () => {
  const { t } = useTranslation()
  const [view, setView] = useState<View>({ name: "list" })
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [results, setResults] = useState<Record<string, ProviderTestResult>>({})
  const [testing, setTesting] = useState<Set<string>>(new Set())
  const [checkingSetup, setCheckingSetup] = useState(false)
  const [collapsed, setCollapsed] = useState<Partial<Record<ProviderType, boolean>>>({})

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

  const runSetupCheck = async () => {
    setCheckingSetup(true)
    await Promise.all(
      PROVIDER_TYPES.map((type) => activeProviders[type])
        .filter((provider): provider is TwinnyProvider => !!provider)
        .map(runTest)
    )
    setCheckingSetup(false)
  }

  const openGallery = (type: ProviderType) => setView({ name: "gallery", type })
  const openForm = (provider: TwinnyProvider) => setView({ name: "form", provider })
  const closeView = () => setView({ name: "list" })

  if (view.name === "gallery") {
    return (
      <div className={styles.page}>
        <PresetGallery
          type={view.type}
          onSelect={openForm}
          onCustom={() => openForm(blankProvider(view.type))}
          onBack={closeView}
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
          }}
        />
      </div>
    )
  }

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
      <div className={styles.pageHeader}>
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
          <span>{t("reset-providers-confirm")}</span>
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

      <SetupCheck
        roles={PROVIDER_TYPES.map((type) => {
          const provider = activeProviders[type]
          return {
            type,
            provider,
            result: provider ? results[provider.id] : undefined,
            pending: provider ? testing.has(provider.id) : false
          }
        })}
        running={checkingSetup}
        onRun={runSetupCheck}
        onAdd={openGallery}
        onFix={openForm}
      />

      <DevicesSection onUse={assignDevice} jobsFor={jobsFor} />

      {PROVIDER_TYPES.map(renderSection)}
    </div>
  )
}
