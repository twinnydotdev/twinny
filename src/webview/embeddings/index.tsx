import React, { useMemo } from "react"
import { useTranslation } from "react-i18next"
import {
  VSCodeButton,
  VSCodeCheckbox,
  VSCodeDropdown,
  VSCodeOption,
  VSCodeTextField
} from "@vscode/webview-ui-toolkit/react"

import {
  DEFAULT_RERANK_THRESHOLD,
  defaultChunkOptions,
  EVENT_NAME,
  EXTENSION_CONTEXT_NAME
} from "../../common/constants"
import { formatRelativeTime } from "../../common/time"
import { useEmbeddings } from "../hooks/useEmbeddings"
import { useProviders } from "../hooks/useProviders"
import { StorageType, useStorageContext } from "../hooks/useStorageContext"
import { emit } from "../messaging"

import styles from "../styles/embeddings.module.css"

type InputEvent = Event | React.FormEvent<HTMLElement>

const valueOf = (e: InputEvent) =>
  (e as unknown as React.ChangeEvent<HTMLInputElement>).target.value

interface NumberFieldProps {
  id: string
  label: string
  hint: string
  value: string
  min: number
  max: number
  error?: string
  onChange: (value: string) => void
}

const NumberField = ({
  id,
  label,
  hint,
  value,
  min,
  max,
  error,
  onChange
}: NumberFieldProps) => {
  const number = Number(value)
  const outOfRange =
    value !== "" && (!Number.isInteger(number) || number < min || number > max)
  const message = error || (outOfRange ? `${min}–${max}` : undefined)
  return (
    <div className={`${styles.field} ${message ? styles.fieldInvalid : ""}`}>
      <label htmlFor={id}>{label}</label>
      <VSCodeTextField
        id={id}
        value={value}
        onInput={(e) => onChange(valueOf(e).trim())}
      />
      <span className={message ? styles.fieldError : styles.fieldHint}>
        {message || hint}
      </span>
    </div>
  )
}

export const EmbeddingOptions = () => {
  const { t } = useTranslation()
  const { status, progress, update, rebuild, cancel } = useEmbeddings()
  const {
    embeddingProvider,
    getProvidersByType,
    providers,
    setActiveEmbeddingsProvider
  } = useProviders()

  const setting = (key: string, fallback: string) => {
    const { context, setContext } = useStorageContext<string>(
      StorageType.Global,
      key
    )
    return [context ?? fallback, setContext] as const
  }
  const [maxChunk, setMaxChunk] = setting(
    EXTENSION_CONTEXT_NAME.twinnyMaxChunkSize,
    String(defaultChunkOptions.maxSize)
  )
  const [minChunk, setMinChunk] = setting(
    EXTENSION_CONTEXT_NAME.twinnyMinChunkSize,
    String(defaultChunkOptions.minSize)
  )
  const [overlap, setOverlap] = setting(
    EXTENSION_CONTEXT_NAME.twinnyOverlapSize,
    String(defaultChunkOptions.overlap)
  )
  const [snippets, setSnippets] = setting(
    EXTENSION_CONTEXT_NAME.twinnyRelevantCodeSnippets,
    "6"
  )
  const { context: threshold = DEFAULT_RERANK_THRESHOLD, setContext: setThreshold } =
    useStorageContext<number>(
      StorageType.Global,
      EXTENSION_CONTEXT_NAME.twinnyRerankThreshold
    )
  const { context: automatic = false, setContext: setAutomatic } =
    useStorageContext<boolean>(
      StorageType.Global,
      EXTENSION_CONTEXT_NAME.twinnyWorkspaceAutoContext
    )

  const embeddingProviders = useMemo(
    () =>
      getProvidersByType("embedding").sort((a, b) =>
        a.label.localeCompare(b.label)
      ),
    [providers]
  )

  const chunkErrors = {
    min:
      Number(minChunk) >= Number(maxChunk)
        ? t("embeddings-min-below-max")
        : undefined,
    overlap:
      Number(overlap) >= Number(minChunk)
        ? t("embeddings-overlap-below-min")
        : undefined
  }

  const running = progress.running
  const percent =
    running && progress.total > 0
      ? Math.min(100, Math.round((progress.processed / progress.total) * 100))
      : 0

  const renderIndexState = () => {
    if (running) {
      const label =
        progress.phase === "scanning"
          ? t("embeddings-scanning")
          : progress.phase === "finishing"
            ? t("embeddings-finishing")
            : t("embeddings-indexing", {
                processed: progress.processed,
                total: progress.total
              })
      return (
        <>
          <div className={styles.progressLine}>
            <span>{label}</span>
            {progress.phase === "embedding" && (
              <span className={styles.progressPercent}>{percent}%</span>
            )}
          </div>
          <div className={styles.progressBar} role="progressbar" aria-valuenow={percent}>
            <div
              className={`${styles.progressFill} ${
                progress.phase !== "embedding" ? styles.progressBusy : ""
              }`}
              style={{ width: progress.phase === "embedding" ? `${percent}%` : "100%" }}
            />
          </div>
          {progress.currentFiles.length > 0 && (
            <div className={styles.progressFiles}>
              {progress.currentFiles.join(", ")}
            </div>
          )}
        </>
      )
    }
    if (progress.error) {
      return (
        <p className={`${styles.stateLine} ${styles.stateError}`}>
          <i className="codicon codicon-error" />
          <span>{progress.error}</span>
        </p>
      )
    }
    if (!status) return null
    if (!status.indexed) {
      return (
        <p className={`${styles.stateLine} ${styles.stateEmpty}`}>
          <i className="codicon codicon-circle-large-outline" />
          <span>{t("embeddings-not-indexed")}</span>
        </p>
      )
    }
    return (
      <>
        <p className={`${styles.stateLine} ${styles.stateOk}`}>
          <i className="codicon codicon-pass-filled" />
          <span>
            {t("embeddings-indexed", { files: status.files, chunks: status.chunks })}
            {status.updatedAt
              ? ` · ${formatRelativeTime(status.updatedAt)}`
              : ""}
            {progress.cancelled ? ` · ${t("embeddings-cancelled")}` : ""}
          </span>
        </p>
        {status.model && (
          <p className={styles.modelLine}>
            {t("embeddings-model", { model: status.model })}
          </p>
        )}
        {status.modelChanged && (
          <p className={`${styles.stateLine} ${styles.stateWarn}`}>
            <i className="codicon codicon-warning" />
            <span>
              {t("embeddings-model-changed", {
                indexed: status.model,
                active: status.activeModel
              })}
            </span>
          </p>
        )}
      </>
    )
  }

  const renderActions = () => {
    if (running) {
      return (
        <VSCodeButton appearance="secondary" onClick={cancel}>
          <i className="codicon codicon-debug-stop" />
          {t("cancel")}
        </VSCodeButton>
      )
    }
    const disabled = !embeddingProvider
    const title = disabled ? t("embeddings-need-provider") : undefined
    if (!status?.indexed) {
      return (
        <VSCodeButton appearance="primary" disabled={disabled} onClick={update} title={title}>
          <i className="codicon codicon-sync" />
          {t("embeddings-index")}
        </VSCodeButton>
      )
    }
    return (
      <div className={styles.actions}>
        <VSCodeButton
          appearance={status.modelChanged ? "secondary" : "primary"}
          disabled={disabled || status.modelChanged}
          onClick={update}
          title={title || t("embeddings-update-hint")}
        >
          <i className="codicon codicon-sync" />
          {t("embeddings-update")}
        </VSCodeButton>
        <VSCodeButton
          appearance={status.modelChanged ? "primary" : "secondary"}
          disabled={disabled}
          onClick={rebuild}
          title={title || t("embeddings-rebuild-hint")}
        >
          <i className="codicon codicon-refresh" />
          {t("embeddings-rebuild")}
        </VSCodeButton>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <div className="tw-page-header">
        <h3>{t("embeddings")}</h3>
      </div>
      <p className={styles.intro}>{t("embeddings-intro")}</p>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h4>
            <i className="codicon codicon-database" />
            {t("embeddings-index-title")}
            {status?.workspace && (
              <span className={styles.workspaceName}>{status.workspace}</span>
            )}
          </h4>
          {renderActions()}
        </div>
        {renderIndexState()}
      </section>

      <section className={styles.group}>
        <h4>{t("embeddings-usage")}</h4>
        <VSCodeCheckbox
          checked={automatic}
          onChange={(e) =>
            setAutomatic((e.target as HTMLInputElement).checked)
          }
        >
          {t("embeddings-automatic")}
        </VSCodeCheckbox>
        <p className={styles.groupBlurb}>{t("embeddings-automatic-blurb")}</p>
      </section>

      <section className={styles.group}>
        <h4>{t("embedding-provider")}</h4>
        {embeddingProviders.length === 0 ? (
          <div className={styles.emptyProvider}>
            <span>{t("embeddings-no-provider")}</span>
            <VSCodeButton
              appearance="secondary"
              onClick={() => emit(EVENT_NAME.twinnyOpenProviders)}
            >
              {t("add-embedding-provider")}
            </VSCodeButton>
          </div>
        ) : (
          <div className={styles.field}>
            <VSCodeDropdown
              value={embeddingProvider?.id || ""}
              onChange={(e) => {
                const provider = providers[valueOf(e)]
                if (provider) setActiveEmbeddingsProvider(provider)
              }}
            >
              {embeddingProviders.map((provider) => (
                <VSCodeOption key={provider.id} value={provider.id}>
                  {`${t(provider.label)} · ${provider.modelName}`}
                </VSCodeOption>
              ))}
            </VSCodeDropdown>
            <span className={styles.fieldHint}>{t("embeddings-provider-hint")}</span>
          </div>
        )}
      </section>

      <section className={styles.group}>
        <h4>{t("embeddings-retrieval")}</h4>
        <p className={styles.groupBlurb}>{t("embeddings-retrieval-blurb")}</p>
        <div className={styles.fieldRow}>
          <NumberField
            id="snippets"
            label={t("relevant-code-snippets")}
            hint={t("number-code-snippets")}
            value={snippets}
            min={1}
            max={30}
            onChange={setSnippets}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="threshold">
            {t("rerank-threshold")}
            <span className={styles.thresholdValue}>{threshold.toFixed(2)}</span>
          </label>
          <input
            className={styles.slider}
            type="range"
            id="threshold"
            min="0.02"
            max="0.6"
            step="0.01"
            value={threshold}
            onChange={(e) => setThreshold(parseFloat(e.target.value))}
          />
          <span className={styles.fieldHint}>{t("rerank-threshold-description")}</span>
        </div>
      </section>

      <section className={styles.group}>
        <h4>{t("embeddings-chunking")}</h4>
        <p className={styles.groupBlurb}>{t("embeddings-chunking-blurb")}</p>
        <div className={styles.fieldRow}>
          <NumberField
            id="maxChunk"
            label={t("max-chunk-size")}
            hint={t("embeddings-chars")}
            value={maxChunk}
            min={200}
            max={6000}
            onChange={setMaxChunk}
          />
          <NumberField
            id="minChunk"
            label={t("min-chunk-size")}
            hint={t("embeddings-chars")}
            value={minChunk}
            min={20}
            max={6000}
            error={chunkErrors.min}
            onChange={setMinChunk}
          />
          <NumberField
            id="overlap"
            label={t("overlap-size")}
            hint={t("embeddings-chars")}
            value={overlap}
            min={0}
            max={2000}
            error={chunkErrors.overlap}
            onChange={setOverlap}
          />
        </div>
        <p className={styles.groupNote}>{t("embeddings-chunking-note")}</p>
      </section>
    </div>
  )
}
