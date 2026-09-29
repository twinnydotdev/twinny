import React, { FormEvent, useEffect, useState } from "react"

import { messageOf } from "../../common/errors"
import type { InferenceCapability } from "../../extension/inference/types"
import type { RemoteStatus, TeamPolicy } from "../../protocol/types"
import type { GatewayModelConfig, GatewayPolicy,GatewayProviderConfig  } from "../config"
import type {
  ConfigurationSnapshot,
  InferenceConfiguration,
  ProviderKind
} from "../configuration"
import type { UsageSummary } from "../usage"

import { api } from "./api"
import { duration, fmt, plural } from "./format"

const CONFIG_URL = "/twinny/v1/admin/config"
const CAPABILITIES: InferenceCapability[] = ["chat", "fim", "embeddings"]
const CAPABILITY_LABELS = {
  chat: "Chat",
  fim: "Autocomplete (FIM)",
  embeddings: "Embeddings"
}
const Field = ({
  label,
  value,
  onChange,
  placeholder,
  required,
  type = "text",
  min,
  step,
  hint,
  max,
  pattern
}: {
  label: string
  value: string | number
  onChange: (value: string) => void
  placeholder?: string
  required?: boolean
  type?: string
  min?: number
  step?: string
  hint?: string
  max?: number
  pattern?: string
}) => (
  <label className="config-field">
    <span>{label}</span>
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      required={required}
      type={type}
      step={step}
      min={min}
      max={max}
      pattern={pattern}
      autoComplete="off"
    />
  {hint && <small className="muted">{hint}</small>}
  </label>
)

const ProviderEditor = ({
  originalName,
  initial,
  kinds,
  onApply,
  onCancel
}: {
  originalName: string
  initial: GatewayProviderConfig
  kinds: ProviderKind[]
  onApply: (name: string, value: GatewayProviderConfig) => void
  onCancel: () => void
}) => {
  const [name, setName] = useState(originalName)
  const [value, setValue] = useState(initial)
  const [error, setError] = useState("")
  const set = <K extends keyof GatewayProviderConfig>(
    key: K,
    next: GatewayProviderConfig[K]
  ) => setValue((old) => ({ ...old, [key]: next }))
  // The team pool has no address: teammates' extensions dial the gateway.
  const pooled = value.provider === "team"
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const cleaned: GatewayProviderConfig = { provider: value.provider }
    if (pooled) {
      try {
        onApply(name.trim(), cleaned)
      } catch (error) {
        setError(messageOf(error))
      }
      return
    }
    if (value.apiHostname?.trim())
      cleaned.apiHostname = value.apiHostname.trim()
    if (value.apiProtocol) cleaned.apiProtocol = value.apiProtocol
    if (value.apiPort !== undefined) cleaned.apiPort = value.apiPort
    if (value.apiKeyEnv?.trim()) cleaned.apiKeyEnv = value.apiKeyEnv.trim()
    const paths = Object.fromEntries(
      Object.entries(value.paths ?? {})
        .filter(([, v]) => v?.trim())
        .map(([k, v]) => [k, v.trim()])
    )
    if (Object.keys(paths).length) cleaned.paths = paths
    try {
      onApply(name.trim(), cleaned)
    } catch (error) {
      setError(messageOf(error))
    }
  }
  return (
    <form className="config-editor" onSubmit={submit}>
      <div className="section-heading">
        <h3>{originalName ? `Edit ${originalName}` : "Add provider"}</h3>
        <span className="muted">{pooled ? "Teammates' computers" : "Connection settings"}</span>
      </div>
      <div className="config-fields">
        <Field
          label="Provider name"
          value={name}
          onChange={setName}
          required
          pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,63}"
          placeholder={pooled ? "team" : "team-inference"}
        />
        <label className="config-field">
          <span>Adapter</span>
          <select
            aria-label="Adapter"
            value={value.provider}
            onChange={(e) => {
              const defaults = kinds.find(
                (kind) => kind.id === e.target.value
              )!.defaults
              setValue({
                ...defaults,
                ...(value.apiKeyEnv ? { apiKeyEnv: value.apiKeyEnv } : {})
              })
            }}
          >
            {kinds.map((kind) => (
              <option key={kind.id} value={kind.id}>
                {kind.label}
              </option>
            ))}
          </select>
        </label>
        {!pooled && (
          <>
        <Field
          label="Hostname"
          value={value.apiHostname ?? ""}
          onChange={(v) => set("apiHostname", v)}
          placeholder="Adapter default"
        />
        <Field
          label="Port"
          value={value.apiPort ?? ""}
          onChange={(v) => set("apiPort", v ? Number(v) : undefined)}
          type="number"
          min={1}
          max={65535}
          placeholder="Adapter default"
        />
        <label className="config-field">
          <span>Protocol</span>
          <select
            value={value.apiProtocol ?? "http"}
            onChange={(e) => set("apiProtocol", e.target.value)}
          >
            <option value="http">HTTP</option>
            <option value="https">HTTPS</option>
          </select>
        </label>
        <Field
          label="API key environment variable"
          value={value.apiKeyEnv ?? ""}
          onChange={(v) => set("apiKeyEnv", v)}
          placeholder="Optional, e.g. MODEL_API_KEY"
          pattern="[A-Za-z_][A-Za-z0-9_]*"
        />
          </>
        )}
      </div>
      {pooled && (
        <p className="config-hint">
          Aliases on this provider are served by whichever connected teammate has the model. Developers switch sharing on from the Twinny sidebar (Share this computer with the team); nothing to configure here. Only one such provider is allowed.
        </p>
      )}
      {!pooled && (
        <>
      <p className="config-hint">
        For authenticated backends, name an environment variable available to
        the gateway process. The key itself stays on the server.
      </p>
      <details className="advanced-fields">
        <summary>Custom API paths</summary>
        <p className="config-hint">
          Leave blank to use adapter defaults. Chat uses a base path for
          OpenAI-compatible adapters, such as /v1.
        </p>
        <div className="config-fields">
          {CAPABILITIES.map((capability) => (
            <Field
              key={capability}
              label={`${CAPABILITY_LABELS[capability]} path`}
              value={value.paths?.[capability] ?? ""}
              onChange={(v) =>
                set("paths", { ...value.paths, [capability]: v })
              }
              placeholder="Adapter default"
            />
          ))}
        </div>
      </details>
        </>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="editor-actions">
        <button type="submit" className="primary">
          Apply to draft
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

const ModelEditor = ({
  initial,
  providers,
  apiKey,
  onApply,
  onCancel
}: {
  initial: GatewayModelConfig
  providers: Record<string, GatewayProviderConfig>
  apiKey: string
  onApply: (value: GatewayModelConfig) => void
  onCancel: () => void
}) => {
  const [value, setValue] = useState(initial)
  const [error, setError] = useState("")
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([])
  const [listing, setListing] = useState(true)
  const [listError, setListError] = useState("")
  const [manual, setManual] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const selectedProvider = providers[value.provider]
  useEffect(() => {
    let cancelled = false
    setListing(true)
    setListError("")
    setModels([])
    api<{ models: Array<{ id: string; name: string }> }>("/twinny/v1/admin/provider-models", apiKey, {
      method: "POST", body: { provider: selectedProvider }
    }).then((result) => {
      if (!cancelled) setModels(result.models)
    }).catch((error) => {
      if (!cancelled) setListError(messageOf(error))
    }).finally(() => {
      if (!cancelled) setListing(false)
    })
    return () => { cancelled = true }
  }, [apiKey, selectedProvider, refresh])
  const manualEntry = manual || (!listing && (listError !== "" || models.length === 0))
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!value.model.trim()) {
      setError("Select or enter a backend model.")
      return
    }
    if (!value.capabilities.length) {
      setError("Choose at least one capability.")
      return
    }
    try {
      onApply({
        ...value,
        alias: value.alias.trim(),
        model: value.model.trim()
      })
    } catch (error) {
      setError(messageOf(error))
    }
  }
  return (
    <form className="config-editor" onSubmit={submit}>
      <div className="section-heading">
        <h3>{initial.alias ? `Edit ${initial.alias}` : "Add model"}</h3>
        <span className="muted">Available to developers</span>
      </div>
      <div className="config-fields">
        <Field
          label="Public alias"
          value={value.alias}
          onChange={(alias) => setValue({ ...value, alias })}
          required
          placeholder="team-chat"
        />
        <label className="config-field">
          <span>Provider</span>
          <select
            aria-label="Provider"
            value={value.provider}
            onChange={(e) => { setValue({ ...value, provider: e.target.value, model: "" }); setManual(false) }}
            required
          >
            {Object.keys(providers).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <div className="model-select-field">
          {manualEntry ? <Field label="Backend model name" value={value.model} onChange={(model) => setValue({ ...value, model })} required placeholder="Exact model name on the backend" /> :
            <label className="config-field"><span>Backend model</span><select aria-label="Backend model" value={value.model} onChange={(e) => setValue({ ...value, model: e.target.value })} required disabled={listing}>
              <option value="">{listing ? "Fetching models…" : "Select a model"}</option>
              {value.model && !models.some((model) => model.id === value.model) && <option value={value.model}>{value.model} (current, not listed)</option>}
              {models.map((model) => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
            </select></label>}
          <div className="model-list-actions">
            <button type="button" className="ghost" disabled={listing} onClick={() => setRefresh((value) => value + 1)}>{listing ? "Fetching…" : "Refresh models"}</button>
            {!listing && models.length > 0 && <button type="button" className="ghost" onClick={() => setManual(!manual)}>{manual ? "Choose from list" : "Enter a model name"}</button>}
          </div>
          {!listing && (listError || !models.length) && <p className="config-hint" role="status">{listError ? `Could not fetch models: ${listError}` : "This provider returned no models."} Enter a name manually or refresh the list.</p>}
        </div>
        <Field
          label="Context window (tokens)"
          value={value.contextWindow ?? ""}
          onChange={(v) =>
            setValue({ ...value, contextWindow: v ? Number(v) : undefined })
          }
          type="number"
          min={1}
          placeholder="Optional"
        />
        <Field
          label="Price per million input tokens (for the Usage page)"
          value={value.price?.input ?? ""}
          onChange={(v) => setValue({ ...value, price: v || value.price?.output !== undefined ? { input: v ? Number(v) : 0, output: value.price?.output ?? 0 } : undefined })}
          type="number"
          min={0}
          step="any"
          placeholder="Optional, e.g. 0.15"
          hint="Per million tokens, in the currency set above. Examples: gpt-4o-mini 0.15 in / 0.60 out; claude-3-5-haiku 0.80 / 4.00; mistral-small 0.20 / 0.60; a local model 0 / 0 or your GPU's hourly cost spread over tokens."
        />
        <Field
          label="Price per million output tokens"
          value={value.price?.output ?? ""}
          onChange={(v) => setValue({ ...value, price: v || value.price?.input !== undefined ? { input: value.price?.input ?? 0, output: v ? Number(v) : 0 } : undefined })}
          type="number"
          min={0}
          step="any"
          placeholder="Optional, e.g. 0.60"
        />
      </div>
      <fieldset className="capability-picker">
        <legend>Capabilities</legend>
        {CAPABILITIES.map((capability) => (
          <label key={capability}>
            <input
              type="checkbox"
              checked={value.capabilities.includes(capability)}
              onChange={(e) =>
                setValue({
                  ...value,
                  capabilities: e.target.checked
                    ? [...value.capabilities, capability]
                    : value.capabilities.filter((c) => c !== capability)
                })
              }
            />
            {CAPABILITY_LABELS[capability]}
          </label>
        ))}
      </fieldset>
      <p className="config-hint">
        Select only the jobs this model supports. Developers select the public
        alias in Twinny.
      </p>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="editor-actions">
        <button type="submit" className="primary">
          Apply to draft
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

type Editor =
  | { type: "provider"; name: string }
  | { type: "model"; index: number }

export type ConfigurationSection = "models" | "policy"

export const ConfigurationPanel = ({
  apiKey,
  onSaved,
  features = [],
  section = "models",
  status,
  usage,
  period,
  onNavigate
}: {
  apiKey: string
  onSaved: () => void
  /** Licence features in force; `policy` gates whether the policy is sent. */
  features?: string[]
  /** Which panels to show; the draft and the save bar are shared across both. */
  section?: ConfigurationSection
  /** Live backend checks, for a status beside each provider and model. */
  status?: RemoteStatus
  usage?: UsageSummary
  period?: string
  onNavigate?: (view: "plan") => void
}) => {
  const [saved, setSaved] = useState<ConfigurationSnapshot | null>(null)
  const [draft, setDraft] = useState<InferenceConfiguration | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [confirming, setConfirming] = useState<Editor | "reload" | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const dirty =
    !!saved &&
    !!draft &&
    JSON.stringify(draft) !==
      JSON.stringify({ providers: saved.providers, models: saved.models, teamDefaults: saved.teamDefaults ?? {}, policy: saved.policy ?? {} })
  const accept = (snapshot: ConfigurationSnapshot) => {
    setSaved(snapshot)
    setDraft({ providers: snapshot.providers, models: snapshot.models, teamDefaults: snapshot.teamDefaults ?? {}, policy: snapshot.policy ?? {} })
    setEditor(null)
    setConfirming(null)
    setError("")
  }
  useEffect(() => {
    let cancelled = false
    api<ConfigurationSnapshot>(CONFIG_URL, apiKey)
      .then((snapshot) => {
        if (!cancelled) accept(snapshot)
      })
      .catch((error) => {
        if (!cancelled) setError(messageOf(error))
      })
    return () => {
      cancelled = true
    }
  }, [apiKey])
  useEffect(() => {
    if (!dirty && !editor) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [dirty, editor])
  const reload = async () => {
    setBusy(true)
    try {
      accept(await api<ConfigurationSnapshot>(CONFIG_URL, apiKey))
      setNotice("")
    } catch (error) {
      setError(messageOf(error))
    } finally {
      setBusy(false)
    }
  }
  const save = async () => {
    if (!saved || !draft || busy) return
    setBusy(true)
    setError("")
    setNotice("")
    try {
      accept(
        await api<ConfigurationSnapshot>(CONFIG_URL, apiKey, {
          method: "PUT",
          body: { revision: saved.revision, ...draft }
        })
      )
      setNotice("Saved. New requests now use this configuration.")
      onSaved()
    } catch (error) {
      setError(messageOf(error))
    } finally {
      setBusy(false)
    }
  }
  const edit = (next: Editor) => {
    setEditor(next)
    setConfirming(null)
    setNotice("")
    setError("")
  }
  const remove = () => {
    if (!draft || !confirming || confirming === "reload") return
    if (confirming.type === "provider") {
      const providers = { ...draft.providers }
      delete providers[confirming.name]
      setDraft({ ...draft, providers })
    } else
      setDraft({
        ...draft,
        models: draft.models.filter((_, index) => index !== confirming.index),
        teamDefaults: Object.fromEntries(Object.entries(draft.teamDefaults ?? {}).filter(([, alias]) => alias !== draft.models[confirming.index].alias))
      })
    setConfirming(null)
    setNotice("")
  }
  if (!draft || !saved)
    return (
      <section className="panel">
        {error ? (
          <>
            <div className="error" role="alert">
              {error}
            </div>
            <button onClick={() => void reload()} disabled={busy}>
              Retry
            </button>
          </>
        ) : (
          <div className="loading">Loading configuration…</div>
        )}
      </section>
    )
  const locked = busy || editor !== null
  const backendOf = (name: string) => status?.backends.find((b) => b.provider === name)
  const modelOk = new Map((status?.models ?? []).map((m) => [m.id, m.ok]))
  const requestsOf = (alias: string) => usage?.byModel[alias]?.requests ?? 0
  const savedModel = (alias: string) => saved.models.find((m) => m.alias === alias)
  const defaultsFor = (alias: string) => CAPABILITIES.filter((c) => draft.teamDefaults?.[c] === alias)
  const licensedPolicy = features.includes("policy")
  const initialProvider =
    editor?.type === "provider" ? draft.providers[editor.name] : undefined
  return (
    <div className="configuration">
      <div className="config-toolbar">
        <div>
          <h2>{section === "policy" ? "Team policy" : "Providers & models"}</h2>
          <p>{section === "policy" ? "What connected extensions enforce. Saved with the rest of the configuration." : "Connect backends. Choose the models your team can use."}</p>
        </div>
        <div className="editor-actions">
          <span className={dirty ? "draft-state" : "muted"}>
            {dirty ? "Unsaved changes" : "Up to date"}
          </span>
          <button
            className="ghost"
            disabled={busy}
            onClick={() =>
              dirty || editor ? setConfirming("reload") : void reload()
            }
          >
            Reload
          </button>
          <button
            className="primary"
            disabled={!dirty || locked}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
      {error && (
        <div className="error-bar" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="success-bar" role="status">
          {notice}
        </div>
      )}
      {confirming === "reload" && (
        <div className="confirm-bar" role="alert">
          <span>Discard your draft and reload the saved configuration?</span>
          <button className="danger" disabled={busy} onClick={() => void reload()}>
            Discard and reload
          </button>
          <button className="ghost" disabled={busy} onClick={() => setConfirming(null)}>
            Cancel
          </button>
        </div>
      )}
      <section className="panel" hidden={section !== "models"}>
        <div className="section-heading">
          <h2>Team defaults</h2>
          <span className="muted">What a developer gets the moment they connect</span>
        </div>
        <div className="slots">
          {CAPABILITIES.map((capability) => {
            const alias = draft.teamDefaults?.[capability] ?? ""
            const model = draft.models.find((m) => m.alias === alias)
            const backend = model ? backendOf(model.provider) : undefined
            const ok = model ? modelOk.get(model.alias) : undefined
            const candidates = draft.models.filter((m) => m.capabilities.includes(capability))
            return (
              <div key={capability} className={`slot ${alias ? "" : "unset"}`}>
                <div className="slot-label">{CAPABILITY_LABELS[capability]}</div>
                <select aria-label={`${CAPABILITY_LABELS[capability]} default`} disabled={locked || !candidates.length} value={alias} onChange={(event) => {
                  const teamDefaults = { ...draft.teamDefaults }
                  if (event.target.value) teamDefaults[capability] = event.target.value
                  else delete teamDefaults[capability]
                  setDraft({ ...draft, teamDefaults }); setNotice("")
                }}>
                  <option value="">{candidates.length ? "Not set: developers pick their own" : "No model offers this"}</option>
                  {candidates.map((m) => <option key={m.alias} value={m.alias}>{m.alias}</option>)}
                </select>
                <div className="slot-detail muted">
                  {model ? (
                    <>
                      {savedModel(model.alias) && ok !== undefined && <i className={`status-dot ${ok ? "ok" : "bad"}`} title={ok ? "answering" : "down"} />}
                      {model.model} on {model.provider}
                      {backend && !backend.ok ? <span className="revoked"> · down</span> : backend ? ` · ${duration(backend.ms)}` : ""}
                      {usage && requestsOf(model.alias) > 0 ? ` · ${plural(requestsOf(model.alias), "request")}${period ? ` in ${period}` : ""}` : ""}
                    </>
                  ) : candidates.length ? (
                    "Developers keep whatever they had configured for this."
                  ) : (
                    "Add a model with this capability first."
                  )}
                </div>
              </div>
            )
          })}
        </div>
        <p className="config-hint">Share the gateway URL and a personal access key. Developers open Twinny → Providers → Connect to team. Existing connections keep their aliases until they reconnect.</p>
      </section>
      <div hidden={section !== "policy"}>
        <section className="panel">
          <div className="section-heading">
            <h2>Rules</h2>
            <span className={`pill-s ${licensedPolicy ? "ok" : "warn"}`}>{licensedPolicy ? "enforced" : "not sent: needs a licence"}</span>
          </div>
          <p className="config-hint">
            What connected extensions enforce on the developer's machine. Shown for consent before connecting, re-read at every VS Code start, and released when the developer leaves the team.
          </p>
          {!licensedPolicy && (
            <div className="confirm-bar" style={{ marginBottom: 14 }}>
              <span>Rules are saved but not sent until the gateway's licence includes team policy.</span>
              {onNavigate && <button type="button" className="ghost" onClick={() => onNavigate("plan")}>Plan &amp; licence</button>}
            </div>
          )}
          <fieldset className="policy-rule">
            <legend>Other providers</legend>
            {([
              [false, "Allow", "Developers may add and use their own providers alongside the team gateway."],
              [true, "Team gateway only", "Developers cannot add or activate any other provider while connected."]
            ] as const).map(([teamOnly, title, detail]) => (
              <label key={String(teamOnly)} className="policy-option">
                <input type="radio" name="policy-team-only" checked={(draft.policy?.teamOnly === true) === teamOnly} disabled={locked} onChange={() => {
                  const policy: TeamPolicy = { ...draft.policy }
                  if (teamOnly) policy.teamOnly = true
                  else delete policy.teamOnly
                  setDraft({ ...draft, policy }); setNotice("")
                }} />
                <span><b>{title}</b><small>{detail}</small></span>
              </label>
            ))}
          </fieldset>
          <fieldset className="policy-rule">
            <legend>Default models</legend>
            <label className="policy-option">
              <input type="checkbox" checked={draft.policy?.lockDefaults === true} disabled={locked} onChange={(event) => {
                const policy: TeamPolicy = { ...draft.policy }
                if (event.target.checked) policy.lockDefaults = true
                else delete policy.lockDefaults
                setDraft({ ...draft, policy }); setNotice("")
              }} />
              <span><b>Keep the team defaults active</b><small>Chat, autocomplete and embeddings stay on the team's models; developers cannot switch them to another provider while connected.</small></span>
            </label>
          </fieldset>
        </section>

        <section className="panel">
          <div className="section-heading">
            <h2>Secret shield</h2>
            <span className="muted">Applied by the gateway to every request, whatever client sent it</span>
          </div>
          <fieldset className="policy-rule">
            <legend>Shield prompts sent to</legend>
            {([
              ["offMachine", "Backends off this machine", "Keys, tokens and passwords in prompts become placeholders before a request reaches a hosted API, another host or a teammate's computer, and are put back in the reply."],
              ["always", "Every backend", "Local backends get placeholders too."],
              ["off", "Off", "Prompts are forwarded as they arrive."]
            ] as const).map(([mode, title, detail]) => (
              <label key={mode} className="policy-option">
                <input type="radio" name="secret-shield" checked={(draft.policy?.secretShield ?? "offMachine") === mode} disabled={locked} onChange={() => {
                  const policy: GatewayPolicy = { ...draft.policy }
                  if (mode === "offMachine") delete policy.secretShield
                  else policy.secretShield = mode
                  setDraft({ ...draft, policy }); setNotice("")
                }} />
                <span><b>{title}</b><small>{detail}</small></span>
              </label>
            ))}
          </fieldset>
        </section>

        <section className="panel">
          <div className="section-heading">
            <h2>Team system prompt</h2>
            <span className="muted">Sent to connected extensions and put before every chat's system prompt</span>
          </div>
          <label className="config-field">
            <span>team system prompt</span>
            <textarea rows={4} value={draft.policy?.systemPrompt ?? ""} disabled={locked} placeholder="e.g. We write TypeScript with strict mode. Prefer small functions. Never suggest adding dependencies without saying why." onChange={(event) => {
              const policy: GatewayPolicy = { ...draft.policy }
              if (event.target.value.trim()) policy.systemPrompt = event.target.value
              else delete policy.systemPrompt
              setDraft({ ...draft, policy }); setNotice("")
            }} />
          </label>
        </section>

        <section className="panel">
          <div className="section-heading">
            <h2>Routing rules</h2>
            <span className="muted">By the workspace name the extension sends; the first matching rule decides</span>
          </div>
          {(draft.policy?.routing ?? []).map((rule, index) => (
            <div key={index} className="policy-entry">
            <div className="config-fields">
              <label className="config-field">
                <span>workspace (glob, e.g. payments-*)</span>
                <input value={rule.workspace} disabled={locked} onChange={(event) => {
                  const routing = [...(draft.policy?.routing ?? [])]
                  routing[index] = { ...rule, workspace: event.target.value }
                  setDraft({ ...draft, policy: { ...draft.policy, routing } }); setNotice("")
                }} />
              </label>
              <label className="config-field">
                <span>only these aliases (comma-separated; blank: any)</span>
                <input value={(rule.aliases ?? []).join(", ")} disabled={locked} onChange={(event) => {
                  const routing = [...(draft.policy?.routing ?? [])]
                  const aliases = event.target.value.split(",").map((a) => a.trim()).filter(Boolean)
                  routing[index] = { ...rule, ...(aliases.length ? { aliases } : {}) }
                  if (!aliases.length) delete routing[index].aliases
                  setDraft({ ...draft, policy: { ...draft.policy, routing } }); setNotice("")
                }} />
              </label>
            </div>
            <div className="backup-options">
              <label className="policy-option">
                <input type="checkbox" checked={rule.localOnly === true} disabled={locked} onChange={(event) => {
                  const routing = [...(draft.policy?.routing ?? [])]
                  routing[index] = { ...rule }
                  if (event.target.checked) routing[index].localOnly = true
                  else delete routing[index].localOnly
                  setDraft({ ...draft, policy: { ...draft.policy, routing } }); setNotice("")
                }} />
                <span><b>local backends only</b><small>never a hosted provider</small></span>
              </label>
              <button type="button" className="ghost mini" disabled={locked} onClick={() => {
                const routing = (draft.policy?.routing ?? []).filter((_, i) => i !== index)
                const policy: GatewayPolicy = { ...draft.policy }
                if (routing.length) policy.routing = routing
                else delete policy.routing
                setDraft({ ...draft, policy }); setNotice("")
              }}>remove rule</button>
            </div>
            </div>
          ))}
          <button type="button" disabled={locked} onClick={() => {
            const routing = [...(draft.policy?.routing ?? []), { workspace: "", localOnly: true }]
            setDraft({ ...draft, policy: { ...draft.policy, routing } }); setNotice("")
          }}>+ Add rule</button>
        </section>
      </div>
      <section className="panel" hidden={section !== "models"}>
        <div className="section-heading">
          <h2>Prices</h2>
          <span className="muted">what the Usage page multiplies token counts by; set per alias in its form</span>
        </div>
        <div className="newkey">
          <label>
            <span className="muted">currency</span>
            <input value={draft.pricing?.currency ?? ""} placeholder="USD" maxLength={3} disabled={locked} style={{ width: 80 }} onChange={(event) => {
              const currency = event.target.value.toUpperCase()
              const next = { ...draft }
              if (currency) next.pricing = { currency }
              else delete next.pricing
              setDraft(next); setNotice("")
            }} />
          </label>
          <span className="muted">{draft.models.filter((model) => model.price).length ? `${draft.models.filter((model) => model.price).length} of ${draft.models.length} aliases have a price.` : "No alias has a price yet; open a model and set one per million tokens."}</span>
        </div>
      </section>
      <section className="panel" hidden={section !== "models"}>
        <div className="section-heading">
          <h2>
            Providers{" "}
            <span className="count">{Object.keys(draft.providers).length}</span>
          </h2>
          <button
            disabled={locked}
            onClick={() => edit({ type: "provider", name: "" })}
          >
            + Add provider
          </button>
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Adapter</th>
                <th>Endpoint</th>
                <th>Status</th>
                <th className="num">Models</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(draft.providers).map(([name, provider]) => {
                const linked = draft.models.filter(
                  (model) => model.provider === name
                )
                const defaults = saved.kinds.find(
                  (kind) => kind.id === provider.provider
                )?.defaults
                const host = provider.apiHostname ?? defaults?.apiHostname
                const port = provider.apiPort ?? defaults?.apiPort
                const confirmingThis =
                  confirming !== "reload" &&
                  confirming?.type === "provider" &&
                  confirming.name === name
                return (
                  <React.Fragment key={name}>
                    <tr className={confirmingThis ? "confirming" : undefined}>
                      <td className="entity-name">{name}</td>
                      <td>
                        {saved.kinds.find((kind) => kind.id === provider.provider)
                          ?.label ?? provider.provider}
                      </td>
                      <td className="muted">
                        {host
                          ? `${
                              provider.apiProtocol ??
                              defaults?.apiProtocol ??
                              "http"
                            }://${host}${port ? `:${port}` : ""}`
                          : "Managed by adapter"}
                      </td>
                      <td>
                        {(() => {
                          const b = backendOf(name)
                          if (!saved.providers[name]) return <span className="pill-s warn">unsaved</span>
                          if (!b) return <span className="muted">–</span>
                          return <span className={`pill-s ${b.ok ? "ok" : "bad"}`}>{b.ok ? `answering · ${duration(b.ms)}` : `down · ${b.kind ?? "unreachable"}`}</span>
                        })()}
                      </td>
                      <td className="num">{linked.length}</td>
                      <td className="actions">
                        <button
                          className="ghost"
                          disabled={locked}
                          onClick={() => edit({ type: "provider", name })}
                          aria-label={`Edit provider ${name}`}
                        >
                          Edit
                        </button>
                        <button
                          className="ghost"
                          disabled={
                            locked ||
                            linked.length > 0 ||
                            Object.keys(draft.providers).length === 1
                          }
                          title={
                            linked.length
                              ? "Remove or reassign this provider's models first."
                              : "Keep at least one provider."
                          }
                          onClick={() =>
                            setConfirming(
                              confirmingThis ? null : { type: "provider", name }
                            )
                          }
                          aria-label={`Remove provider ${name}`}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                    {confirmingThis && (
                      <tr className="confirm-row">
                        <td colSpan={6}>
                          <div className="confirm-bar" role="alert">
                            <span>Remove provider “{name}” from the draft?</span>
                            <button
                              className="danger"
                              disabled={busy}
                              onClick={remove}
                              autoFocus
                            >
                              Remove from draft
                            </button>
                            <button
                              className="ghost"
                              disabled={busy}
                              onClick={() => setConfirming(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
        {editor?.type === "provider" && (
          <ProviderEditor
            key={editor.name}
            originalName={editor.name}
            kinds={saved.kinds}
            initial={
              initialProvider ??
              saved.kinds.find((kind) => kind.id === "openai-compatible")!
                .defaults
            }
            onCancel={() => setEditor(null)}
            onApply={(name, value) => {
              if (!name) throw new Error("Enter a provider name.")
              if (name !== editor.name && Object.prototype.hasOwnProperty.call(draft.providers, name))
                throw new Error("That provider name is already in use.")
              const providers = Object.fromEntries(
                Object.entries(draft.providers).map(([oldName, oldValue]) =>
                  oldName === editor.name ? [name, value] : [oldName, oldValue]
                )
              )
              if (!editor.name)
                Object.defineProperty(providers, name, {
                  value,
                  enumerable: true,
                  writable: true,
                  configurable: true
                })
              setDraft({
                ...draft,
                providers,
                models: draft.models.map((model) =>
                  model.provider === editor.name
                    ? { ...model, provider: name }
                    : model
                )
              })
              setEditor(null)
            }}
          />
        )}
      </section>
      <section className="panel" hidden={section !== "models"}>
        <div className="section-heading">
          <h2>
            Models <span className="count">{draft.models.length}</span>
          </h2>
          <button
            disabled={locked || !Object.keys(draft.providers).length}
            onClick={() => edit({ type: "model", index: -1 })}
          >
            + Add model
          </button>
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Public alias</th>
                <th>Backend model</th>
                <th>Provider</th>
                <th>Capabilities</th>
                {usage && <th className="num">Requests{period ? ` · ${period}` : ""}</th>}
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {draft.models.map((model, index) => {
                const confirmingThis =
                  confirming !== "reload" &&
                  confirming?.type === "model" &&
                  confirming.index === index
                return (
                  <React.Fragment key={model.alias}>
                    <tr className={confirmingThis ? "confirming" : undefined}>
                      <td>
                        {savedModel(model.alias) && modelOk.has(model.alias) ? (
                          <i className={`status-dot ${modelOk.get(model.alias) ? "ok" : "bad"}`} title={modelOk.get(model.alias) ? "answering" : "down"} />
                        ) : (
                          <i className="status-dot" title="not saved yet" />
                        )}
                        <span className="entity-name">{model.alias}</span>
                      </td>
                      <td>
                        {model.model}
                        {model.contextWindow ? <div className="muted" style={{ fontSize: 11 }}>{fmt(model.contextWindow)} token context</div> : null}
                      </td>
                      <td className="muted">{model.provider}</td>
                      <td>
                        {model.capabilities.map((capability) => {
                          const isDefault = defaultsFor(model.alias).includes(capability)
                          return (
                            <span className={isDefault ? "capability-tag default" : "capability-tag"} key={capability} title={isDefault ? `Team default for ${CAPABILITY_LABELS[capability].toLowerCase()}` : undefined}>
                              {capability}
                            </span>
                          )
                        })}
                      </td>
                      {usage && <td className="num">{requestsOf(model.alias) ? fmt(requestsOf(model.alias)) : <span className="muted">0</span>}</td>}
                      <td className="actions">
                        <button
                          className="ghost"
                          disabled={locked}
                          onClick={() => edit({ type: "model", index })}
                          aria-label={`Edit model ${model.alias}`}
                        >
                          Edit
                        </button>
                        <button
                          className="ghost"
                          disabled={locked || draft.models.length === 1}
                          title={
                            draft.models.length === 1
                              ? "Keep at least one model."
                              : undefined
                          }
                          onClick={() =>
                            setConfirming(
                              confirmingThis ? null : { type: "model", index }
                            )
                          }
                          aria-label={`Remove model ${model.alias}`}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                    {confirmingThis && (
                      <tr className="confirm-row">
                        <td colSpan={usage ? 6 : 5}>
                          <div className="confirm-bar" role="alert">
                            <span>
                              Remove model “{model.alias}” from the draft?
                              Developers will lose this alias when you save.
                            </span>
                            <button
                              className="danger"
                              disabled={busy}
                              onClick={remove}
                              autoFocus
                            >
                              Remove from draft
                            </button>
                            <button
                              className="ghost"
                              disabled={busy}
                              onClick={() => setConfirming(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
        {editor?.type === "model" && (
          <ModelEditor
            key={editor.index}
            initial={
              draft.models[editor.index] ?? {
                alias: "",
                provider: Object.keys(draft.providers)[0],
                model: "",
                capabilities: ["chat"]
              }
            }
            providers={draft.providers}
            apiKey={apiKey}
            onCancel={() => setEditor(null)}
            onApply={(value) => {
              if (
                draft.models.some(
                  (model, index) =>
                    index !== editor.index &&
                    model.alias.toLowerCase() === value.alias.toLowerCase()
                )
              )
                throw new Error("That public alias is already in use.")
              setDraft({
                ...draft,
                teamDefaults: Object.fromEntries(Object.entries(draft.teamDefaults ?? {}).map(([cap, alias]) => [cap, alias === draft.models[editor.index]?.alias ? value.alias : alias])),
                models:
                  editor.index < 0
                    ? [...draft.models, value]
                    : draft.models.map((model, index) =>
                        index === editor.index ? value : model
                      )
              })
              setEditor(null)
            }}
          />
        )}
      </section>
      <p className="config-hint" hidden={section !== "models"}>
        A highlighted capability is the team default for it. Changes take effect when you save; requests already running finish with
        their original configuration. Keep at least one provider and model.
      </p>
      <p className="config-hint" hidden={section !== "policy"}>
        Changes take effect when you save. Connected developers see new rules the next time VS Code starts.
      </p>
    </div>
  )
}
