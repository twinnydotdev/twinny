import React, { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import {
  COMPOSER_FONT_SIZES,
  ComposerSettings as Settings,
  DEFAULT_COMPOSER_FONT_SIZE,
  suggestionProviderFor,
  SuggestionSource,
  SuggestionStatus,
  suggestsSentences
} from "../common/composer-settings"
import { usesEndpoint } from "../common/provider-validation"
import { TwinnyProvider } from "../common/types"

import { useModels } from "./hooks/useModels"
import { useProviders } from "./hooks/useProviders"
import { Choices, useDismiss } from "./agent-settings"

import styles from "./styles/agent-settings.module.css"

interface ComposerSettingsProps {
  settings: Settings
  /** The source in force, the old on/off setting counted in. */
  source: SuggestionSource
  /** How the last ask of a model went, and whether one is out now. */
  status: SuggestionStatus
  onChange: (settings: Settings) => void
  onClose: () => void
}

/** Stands for the chat model in the provider list. */
const CHAT_MODEL = ""

/**
 * The composer's own settings, laid over the foot of the transcript like
 * the agent's: where the grey suggestions come from, which model writes the sentence ones (named, so it is never
 * a guess which one answered), and the size of the text typed. Kept for
 * every window; each change shows at once.
 */
export const ComposerSettings = ({ settings, source, status, onChange, onClose }: ComposerSettingsProps) => {
  const { t } = useTranslation()
  const panel = useRef<HTMLDivElement>(null)
  const { models: catalogue } = useModels()
  const { providers, chatProvider, getProvidersByType, listModels } = useProviders()
  useDismiss(panel, "data-composer-settings-toggle", onClose)

  const chatProviders = getProvidersByType("chat").sort((a, b) => t(a.label).localeCompare(t(b.label)))
  // What the extension will ask, by the same rule it uses.
  const inUse = suggestionProviderFor<TwinnyProvider>(chatProvider ?? undefined, providers, settings.model)
  const own = !!settings.model && !!inUse && inUse.id === settings.model.providerId
  const chosen = own ? inUse : undefined

  // A server is asked what it has; a hosted API's models come from the catalogue.
  const [served, setServed] = useState<string[]>([])
  const servesModels = !!chosen && usesEndpoint(chosen.provider, "chat")
  useEffect(() => {
    if (!chosen || !servesModels) {
      setServed([])
      return
    }
    let cancelled = false
    void listModels(chosen).then((result) => !cancelled && setServed(result.models))
    return () => {
      cancelled = true
    }
  }, [chosen?.id, servesModels])
  const offered = !chosen
    ? []
    : servesModels
      ? served
      : catalogue[chosen.provider as keyof typeof catalogue]?.models || []
  const modelName = chosen?.modelName ?? ""
  const modelChoices = modelName && !offered.includes(modelName) ? [modelName, ...offered] : offered

  const chooseProvider = (id: string) => {
    const provider = providers[id]
    onChange({
      ...settings,
      model: provider ? { providerId: provider.id, modelName: provider.modelName } : undefined
    })
  }

  const fontSize = settings.fontSize ?? DEFAULT_COMPOSER_FONT_SIZE
  const sizes = COMPOSER_FONT_SIZES.includes(fontSize)
    ? COMPOSER_FONT_SIZES
    : [...COMPOSER_FONT_SIZES, fontSize].sort((a, b) => a - b)

  return (
    <div ref={panel} className={styles.panel} role="dialog" aria-label={t("composer-settings-title")}>
      <div className={styles.head}>
        <span>{t("composer-settings-title")}</span>
        <button type="button" className={styles.close} onClick={onClose} aria-label={t("composer-settings-close")}>
          <span className="codicon codicon-close" aria-hidden="true" />
        </button>
      </div>
      <Choices<SuggestionSource>
        label={t("composer-settings-suggest")}
        value={source}
        onChange={(suggest) => onChange({ ...settings, suggest })}
        choices={[
          { value: "off", label: t("composer-settings-suggest-off"), title: t("composer-settings-suggest-off-title") },
          { value: "words", label: t("composer-settings-suggest-words"), title: t("composer-settings-suggest-words-title") },
          {
            value: "sentences",
            label: t("composer-settings-suggest-sentences"),
            title: t("composer-settings-suggest-sentences-title")
          },
          { value: "both", label: t("composer-settings-suggest-both"), title: t("composer-settings-suggest-both-title") }
        ]}
      />
      {suggestsSentences(source) && (
        <>
          <div className={styles.row}>
            <label className={styles.label} htmlFor="composer-suggestion-provider" title={t("composer-settings-model-title")}>
              {t("composer-settings-model")}
            </label>
            <select
              id="composer-suggestion-provider"
              className={styles.select}
              value={chosen?.id ?? CHAT_MODEL}
              onChange={(event) => chooseProvider(event.target.value)}
            >
              <option value={CHAT_MODEL}>{t("composer-settings-model-chat")}</option>
              {chatProviders.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {t(provider.label)}
                </option>
              ))}
            </select>
          </div>
          {chosen && (
            <div className={styles.row}>
              <label className={styles.label} htmlFor="composer-suggestion-model">
                {t("composer-settings-model-name")}
              </label>
              {modelChoices.length > 1 ? (
                <select
                  id="composer-suggestion-model"
                  className={styles.select}
                  value={modelName}
                  onChange={(event) =>
                    onChange({ ...settings, model: { providerId: chosen.id, modelName: event.target.value } })
                  }
                >
                  {modelChoices.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  key={chosen.id}
                  id="composer-suggestion-model"
                  className={styles.select}
                  defaultValue={modelName}
                  placeholder={t("enter-model-name")}
                  spellCheck={false}
                  onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
                  onBlur={(event) => {
                    const name = event.target.value.trim()
                    if (name && name !== modelName) {
                      onChange({ ...settings, model: { providerId: chosen.id, modelName: name } })
                    }
                  }}
                />
              )}
            </div>
          )}
          <div className={styles.note}>
            {inUse?.modelName
              ? t(chosen ? "composer-settings-asks" : "composer-settings-asks-chat", { model: inUse.modelName })
              : t("composer-settings-asks-none")}
          </div>
          {(status.asking || status.last) && (
            <div className={styles.note} role="status">
              {status.asking
                ? t("composer-settings-asking")
                : status.last?.result === "failed"
                  ? t("composer-settings-last-failed", { error: status.last.error })
                  : t(
                      status.last?.result === "shown" ? "composer-settings-last-shown" : "composer-settings-last-nothing",
                      { model: status.last?.model, ms: status.last?.ms }
                    )}
            </div>
          )}
        </>
      )}
      <Choices<number>
        label={t("composer-settings-font-size")}
        value={fontSize}
        onChange={(size) =>
          onChange({ ...settings, fontSize: size === DEFAULT_COMPOSER_FONT_SIZE ? undefined : size })
        }
        choices={sizes.map((size) => ({
          value: size,
          label: String(size),
          title: t(
            size === DEFAULT_COMPOSER_FONT_SIZE ? "composer-settings-font-size-default" : "composer-settings-font-size-title",
            { size }
          )
        }))}
      />
    </div>
  )
}

export default ComposerSettings
