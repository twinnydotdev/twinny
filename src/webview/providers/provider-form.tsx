import React, { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { TextFieldType } from "@vscode/webview-ui-toolkit"
import {
  VSCodeButton,
  VSCodeCheckbox,
  VSCodeDropdown,
  VSCodeOption,
  VSCodeTextField
} from "@vscode/webview-ui-toolkit/react"

import {
  API_PROVIDERS,
  DEFAULT_PROVIDER_FORM_VALUES,
  FIM_TEMPLATE_FORMAT
} from "../../common/constants"
import { ProviderTestResult } from "../../common/messaging/protocol"
import {
  describeProviderEndpoint,
  expectsApiKey,
  getEndpointDefaults,
  hasConfigurableEndpoint,
  isP2pProvider,
  normalizeProvider,
  PROVIDER_TYPES,
  ProviderField,
  supportsType,
  validateProvider
} from "../../common/provider-validation"
import { TwinnyProvider } from "../../common/types"
import { useDevices } from "../hooks/useDevices"
import { useProviders } from "../hooks/useProviders"

import { ProviderTestBadge } from "./provider-test-badge"

import styles from "../styles/providers.module.css"

const PROVIDER_NAMES: Record<string, string> = {
  [API_PROVIDERS.Anthropic]: "Anthropic",
  [API_PROVIDERS.Cohere]: "Cohere",
  [API_PROVIDERS.Deepseek]: "DeepSeek",
  [API_PROVIDERS.Gemini]: "Gemini",
  [API_PROVIDERS.Groq]: "Groq",
  [API_PROVIDERS.LiteLLM]: "LiteLLM",
  [API_PROVIDERS.LlamaCpp]: "llama.cpp",
  [API_PROVIDERS.LMStudio]: "LM Studio",
  [API_PROVIDERS.Mistral]: "Mistral",
  [API_PROVIDERS.Ollama]: "Ollama",
  [API_PROVIDERS.Oobabooga]: "Oobabooga",
  [API_PROVIDERS.OpenAI]: "OpenAI",
  [API_PROVIDERS.OpenAICompatible]: "OpenAI-compatible server",
  [API_PROVIDERS.OpenRouter]: "OpenRouter",
  [API_PROVIDERS.OpenWebUI]: "Open WebUI",
  [API_PROVIDERS.Perplexity]: "Perplexity",
  [API_PROVIDERS.TwinnyP2P]: "Twinny device (P2P)"
}

const EMBEDDING_MODEL_PATTERN = /embed|minilm|bge|e5|nomic/i
const FIM_MODEL_PATTERN =
  /code|coder|fim|starcoder|codestral|codegemma|stable-code/i

/** When the server lists models, the first one that fits the job. */
export const pickModel = (models: string[], type: string) => {
  if (type === "embedding") {
    return models.find((m) => EMBEDDING_MODEL_PATTERN.test(m)) || models[0]
  }
  const nonEmbedding = models.filter((m) => !EMBEDDING_MODEL_PATTERN.test(m))
  if (type === "fim") {
    return nonEmbedding.find((m) => FIM_MODEL_PATTERN.test(m)) || nonEmbedding[0]
  }
  return nonEmbedding[0] || models[0]
}

type InputEvent = Event | React.FormEvent<HTMLElement>

const valueOf = (e: InputEvent) =>
  (e as unknown as React.ChangeEvent<HTMLInputElement>).target.value

interface ProviderFormProps {
  /** The draft to open with; `id` empty means "new". */
  initial: TwinnyProvider
  onClose: () => void
  onSaved?: (provider: TwinnyProvider) => void
}

export const ProviderForm = ({ initial, onClose, onSaved }: ProviderFormProps) => {
  const { t } = useTranslation()
  const { saveProvider, updateProvider, testProvider, listModels } =
    useProviders()
  const { devices } = useDevices()
  const isEditing = !!initial.id

  const [draft, setDraft] = useState<TwinnyProvider>({
    ...DEFAULT_PROVIDER_FORM_VALUES,
    ...initial
  })
  const [touched, setTouched] = useState<Set<ProviderField>>(new Set())
  const [submitted, setSubmitted] = useState(false)
  const [serverErrors, setServerErrors] = useState<
    Partial<Record<ProviderField, string>>
  >({})
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)

  const [models, setModels] = useState<string[]>([])
  const [modelsError, setModelsError] = useState<string | undefined>()
  const [modelsLoading, setModelsLoading] = useState(false)
  const [customModel, setCustomModel] = useState(false)

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null)

  const normalized = useMemo(() => normalizeProvider(draft), [draft])
  const validation = useMemo(() => validateProvider(normalized), [normalized])
  const endpoint = describeProviderEndpoint(normalized)
  const isP2p = isP2pProvider(draft.provider)
  const showEndpointFields = hasConfigurableEndpoint(draft.provider, draft.type)
  const device = isP2p ? devices.find((d) => d.id === draft.deviceId) : undefined

  const errorFor = (field: ProviderField) =>
    serverErrors[field] ||
    (submitted || touched.has(field) ? validation.errors[field] : undefined)

  const update = (patch: Partial<TwinnyProvider>) => {
    setServerErrors({})
    setTestResult(null)
    setDraft((current) => ({ ...current, ...patch }))
    setTouched((current) => {
      const next = new Set(current)
      for (const key of Object.keys(patch)) next.add(key as ProviderField)
      return next
    })
  }

  /**
   * Switching the provider or type swaps in that server's usual address, but
   * only over values the user has not typed themselves.
   */
  const previousDefaults = useRef(
    getEndpointDefaults(draft.provider, draft.type)
  )
  const changeProviderOrType = (patch: Partial<TwinnyProvider>) => {
    const next = { ...draft, ...patch }
    const defaults = getEndpointDefaults(next.provider, next.type)
    const before = previousDefaults.current
    const untouched = (field: ProviderField) =>
      !draft[field] || draft[field] === before?.[field as keyof typeof before]

    const endpointPatch: Partial<TwinnyProvider> = {}
    if (defaults) {
      if (untouched("apiHostname")) endpointPatch.apiHostname = defaults.apiHostname
      if (untouched("apiPort")) endpointPatch.apiPort = defaults.apiPort
      if (untouched("apiPath")) endpointPatch.apiPath = defaults.apiPath
      if (untouched("apiProtocol")) {
        endpointPatch.apiProtocol = defaults.apiProtocol || "http"
      }
    }
    if (next.type === "fim" && !next.fimTemplate) {
      endpointPatch.fimTemplate = FIM_TEMPLATE_FORMAT.automatic
    }
    previousDefaults.current = defaults
    update({ ...patch, ...endpointPatch })
  }

  // Ask the server what it serves whenever the address changes. Debounced:
  // the user is typing a hostname, not submitting one.
  const listKey = [
    draft.provider,
    draft.type,
    draft.deviceId,
    draft.apiHostname,
    draft.apiPort,
    draft.apiProtocol,
    draft.apiKey
  ].join("|")
  useEffect(() => {
    let cancelled = false
    const probe = normalizeProvider(draft)
    if ((showEndpointFields && !probe.apiHostname) || (isP2p && !probe.deviceId)) {
      setModels([])
      return
    }
    setModelsLoading(true)
    const timer = setTimeout(() => {
      listModels(probe).then((result) => {
        if (cancelled) return
        setModels(result.models)
        setModelsError(result.error)
        setModelsLoading(false)
        // A preset leaves the model blank so the first thing the server
        // actually has gets picked.
        if (!draft.modelName && result.models.length) {
          const chosen = pickModel(result.models, draft.type)
          if (chosen) setDraft((current) => ({ ...current, modelName: chosen }))
        }
      })
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [listKey])

  const modelInList = models.includes(draft.modelName)
  const showModelDropdown = models.length > 0 && !customModel

  const handleTest = async () => {
    setSubmitted(true)
    if (!validation.valid) return
    setTesting(true)
    setTestResult(null)
    setTestResult(await testProvider(normalized))
    setTesting(false)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitted(true)
    if (!validation.valid || saving) return
    setSaving(true)
    const result = isEditing
      ? await updateProvider(normalized)
      : await saveProvider(normalized)
    setSaving(false)
    if (!result.success) {
      setServerErrors(result.errors || { id: t("unknown-error") })
      return
    }
    if (result.provider) onSaved?.(result.provider)
    onClose()
  }

  const field = (
    name: ProviderField,
    label: string,
    control: React.ReactNode,
    hint?: string
  ) => {
    const error = errorFor(name)
    return (
      <div className={`${styles.field} ${error ? styles.fieldInvalid : ""}`}>
        <label htmlFor={name}>{label}</label>
        {control}
        {error ? (
          <span className={styles.fieldError} role="alert">
            {error}
          </span>
        ) : hint ? (
          <span className={styles.fieldHint}>{hint}</span>
        ) : null}
      </div>
    )
  }

  // A device provider is made from the device's card, where the id comes
  // from; it is not something to pick from a list.
  const providerOptions = Object.values(API_PROVIDERS)
    .filter(
      (name) =>
        (supportsType(name, draft.type) && !isP2pProvider(name)) ||
        name === draft.provider
    )
    .sort((a, b) => PROVIDER_NAMES[a].localeCompare(PROVIDER_NAMES[b]))

  return (
    <form onSubmit={handleSubmit} className={styles.providerForm} noValidate>
      <div className={styles.viewHeader}>
        <VSCodeButton appearance="icon" onClick={onClose} title={t("back")}>
          <i className="codicon codicon-arrow-left" />
        </VSCodeButton>
        <h4>{isEditing ? t("edit-provider") : t("new-provider")}</h4>
      </div>

      {field(
        "label",
        t("label"),
        <VSCodeTextField
          id="label"
          value={draft.label}
          placeholder={t("label-placeholder")}
          onInput={(e) => update({ label: valueOf(e) })}
        />
      )}

      <div className={styles.fieldRow}>
        {field(
          "type",
          t("type"),
          <VSCodeDropdown
            id="type"
            value={draft.type}
            disabled={isEditing}
            onChange={(e) => changeProviderOrType({ type: valueOf(e) })}
          >
            {PROVIDER_TYPES.map((type) => (
              <VSCodeOption key={type} value={type}>
                {t(`type-${type}`)}
              </VSCodeOption>
            ))}
          </VSCodeDropdown>
        )}
        {field(
          "provider",
          t("provider"),
          <VSCodeDropdown
            id="provider"
            value={draft.provider}
            onChange={(e) => changeProviderOrType({ provider: valueOf(e) })}
          >
            {providerOptions.map((name) => (
              <VSCodeOption key={name} value={name}>
                {PROVIDER_NAMES[name] || name}
              </VSCodeOption>
            ))}
          </VSCodeDropdown>
        )}
      </div>

      {isP2p &&
        field(
          "deviceId",
          t("device"),
          <div className={styles.staticValue}>
            <i
              className={`codicon codicon-${
                device?.state === "online" ? "circle-filled" : "circle-outline"
              }`}
            />
            <span>{device?.name || draft.deviceId?.slice(0, 12) || "—"}</span>
            {device && (
              <span className={styles.fieldHint}>{t(`device-${device.state}`)}</span>
            )}
          </div>,
          !device ? t("device-not-paired") : undefined
        )}

      {showEndpointFields && (
        <>
          <div className={styles.fieldRow}>
            {field(
              "apiProtocol",
              t("protocol"),
              <VSCodeDropdown
                id="apiProtocol"
                value={draft.apiProtocol}
                onChange={(e) => update({ apiProtocol: valueOf(e) })}
              >
                <VSCodeOption value="http">http</VSCodeOption>
                <VSCodeOption value="https">https</VSCodeOption>
              </VSCodeDropdown>
            )}
            {field(
              "apiPort",
              t("port"),
              <VSCodeTextField
                id="apiPort"
                value={draft.apiPort?.toString() ?? ""}
                placeholder={t("port-placeholder")}
                onInput={(e) => {
                  // Kept as typed so a slip shows up as an error, not as NaN.
                  const raw = valueOf(e).trim()
                  update({
                    apiPort: raw ? (raw as unknown as number) : undefined
                  })
                }}
              />
            )}
          </div>
          {field(
            "apiHostname",
            t("hostname"),
            <VSCodeTextField
              id="apiHostname"
              value={draft.apiHostname || ""}
              placeholder={t("hostname-placeholder")}
              onInput={(e) => update({ apiHostname: valueOf(e) })}
              onBlur={() => {
                // A pasted URL is split into its parts on the way out.
                const parts = normalizeProvider(draft)
                if (parts.apiHostname !== draft.apiHostname) {
                  update({
                    apiHostname: parts.apiHostname,
                    apiPort: parts.apiPort,
                    apiProtocol: parts.apiProtocol,
                    apiPath: parts.apiPath || draft.apiPath
                  })
                }
              }}
            />,
            t("hostname-hint")
          )}
          {field(
            "apiPath",
            t("api-path"),
            <VSCodeTextField
              id="apiPath"
              value={draft.apiPath || ""}
              placeholder={
                getEndpointDefaults(draft.provider, draft.type)?.apiPath ||
                t("api-path-placeholder")
              }
              onInput={(e) => update({ apiPath: valueOf(e) })}
            />,
            draft.type === "chat" ? t("api-path-hint-chat") : undefined
          )}
        </>
      )}

      {!isP2p &&
        field(
        "apiKey",
        t("api-key"),
        <div className={styles.inlineControl}>
          <VSCodeTextField
            id="apiKey"
            type={showKey ? TextFieldType.text : TextFieldType.password}
            value={draft.apiKey || ""}
            placeholder={
              expectsApiKey(draft.provider)
                ? t("api-key-required-placeholder")
                : t("api-key-placeholder")
            }
            onInput={(e) => update({ apiKey: valueOf(e) })}
          />
          <VSCodeButton
            appearance="icon"
            title={showKey ? t("hide-api-key") : t("show-api-key")}
            onClick={() => setShowKey((v) => !v)}
          >
            <i className={`codicon codicon-${showKey ? "eye-closed" : "eye"}`} />
          </VSCodeButton>
        </div>
      )}

      {field(
        "modelName",
        t("model-name"),
        <div className={styles.inlineControl}>
          {showModelDropdown ? (
            <VSCodeDropdown
              id="modelName"
              value={modelInList ? draft.modelName : ""}
              onChange={(e) => update({ modelName: valueOf(e) })}
            >
              {!modelInList && (
                <VSCodeOption value="">
                  {draft.modelName
                    ? t("model-not-listed", { model: draft.modelName })
                    : t("select-model")}
                </VSCodeOption>
              )}
              {models.map((model) => (
                <VSCodeOption key={model} value={model}>
                  {model}
                </VSCodeOption>
              ))}
            </VSCodeDropdown>
          ) : (
            <VSCodeTextField
              id="modelName"
              value={draft.modelName}
              placeholder={t("model-name-placeholder")}
              onInput={(e) => update({ modelName: valueOf(e) })}
            />
          )}
          {models.length > 0 && (
            <VSCodeButton
              appearance="icon"
              title={customModel ? t("choose-from-list") : t("type-model-name")}
              onClick={() => setCustomModel((v) => !v)}
            >
              <i
                className={`codicon codicon-${customModel ? "list-flat" : "edit"}`}
              />
            </VSCodeButton>
          )}
        </div>,
        modelsLoading
          ? t("loading-available-models")
          : models.length
            ? t("models-found", { count: models.length })
            : modelsError
              ? t("models-not-listed")
              : undefined
      )}

      {draft.type === "fim" && (
        <>
          {field(
            "fimTemplate",
            t("fim-template"),
            <VSCodeDropdown
              id="fimTemplate"
              value={draft.fimTemplate || FIM_TEMPLATE_FORMAT.automatic}
              onChange={(e) => update({ fimTemplate: valueOf(e) })}
            >
              {Object.values(FIM_TEMPLATE_FORMAT).map((template) => (
                <VSCodeOption key={template} value={template}>
                  {template}
                </VSCodeOption>
              ))}
            </VSCodeDropdown>,
            t("fim-template-hint")
          )}
          <div className={styles.checkbox}>
            <VSCodeCheckbox
              id="repositoryLevel"
              checked={!!draft.repositoryLevel}
              onChange={(e) =>
                update({
                  repositoryLevel: (e.target as HTMLInputElement).checked
                })
              }
            >
              {t("repository-level")}
            </VSCodeCheckbox>
          </div>
        </>
      )}

      {endpoint && (
        <div className={styles.endpointPreview}>
          <span className={styles.endpointLabel}>{t("will-call")}</span>
          <code>{endpoint}</code>
        </div>
      )}

      {validation.warnings.length > 0 && (
        <ul className={styles.warnings}>
          {validation.warnings.map((warning) => (
            <li key={warning}>
              <i className="codicon codicon-warning" />
              <span>{warning}</span>
            </li>
          ))}
        </ul>
      )}

      {serverErrors.id && (
        <p className={styles.fieldError} role="alert">
          {serverErrors.id}
        </p>
      )}

      <div className={styles.formActions}>
        <VSCodeButton
          appearance="secondary"
          disabled={testing}
          onClick={handleTest}
        >
          <i className={`codicon codicon-${testing ? "loading" : "debug-start"}`} />
          {testing ? t("testing") : t("test-provider")}
        </VSCodeButton>
        <span className={styles.formActionsSpacer} />
        <VSCodeButton appearance="secondary" onClick={onClose}>
          {t("cancel")}
        </VSCodeButton>
        <VSCodeButton
          appearance="primary"
          type="submit"
          disabled={saving || (submitted && !validation.valid)}
        >
          {t("save")}
        </VSCodeButton>
      </div>

      {(testing || testResult) && (
        <ProviderTestBadge result={testResult} pending={testing} verbose />
      )}
    </form>
  )
}
