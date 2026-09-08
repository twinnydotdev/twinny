import React, { ReactNode, useState } from "react"
import { useTranslation } from "react-i18next"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"

import {
  API_PROVIDERS,
  FIM_TEMPLATE_FORMAT,
  PROVIDER_DISPLAY_NAMES
} from "../../common/constants"
import {
  getEndpointDefaults,
  ProviderType
} from "../../common/provider-validation"
import { TwinnyProvider } from "../../common/types"
import {
  SvgAnthropic,
  SvgCohere,
  SvgDeepseek,
  SvgGemini,
  SvgGroq,
  SvgMistral,
  SvgOllama,
  SvgOpenAI,
  SvgOpenRouter,
  SvgPerplexity
} from "../icons"

import styles from "../styles/providers.module.css"

export interface ProviderPreset {
  key: string
  label: string
  /** i18n key for the one-line blurb under the name. */
  descriptionKey: string
  logo: ReactNode
  provider: string
  type: ProviderType
  modelName: string
  fimTemplate?: string
  /** Local servers are listed first: they are what twinny is built around. */
  local: boolean
}

const codicon = (name: string) => <i className={`codicon codicon-${name}`} />

const LOCAL_LOGOS: Record<string, ReactNode> = {
  [API_PROVIDERS.Ollama]: <SvgOllama />,
  [API_PROVIDERS.LMStudio]: codicon("vm"),
  [API_PROVIDERS.LlamaCpp]: codicon("terminal"),
  [API_PROVIDERS.OpenWebUI]: codicon("browser"),
  [API_PROVIDERS.LiteLLM]: codicon("server-environment"),
  [API_PROVIDERS.Oobabooga]: codicon("server"),
  [API_PROVIDERS.OpenAICompatible]: codicon("plug")
}

const local = (
  provider: string,
  type: ProviderType,
  modelName = "",
  fimTemplate?: string
): ProviderPreset => ({
  key: `${provider}-${type}`,
  label: PROVIDER_DISPLAY_NAMES[provider],
  descriptionKey: `preset-${provider}`,
  logo: LOCAL_LOGOS[provider],
  provider,
  type,
  modelName,
  fimTemplate,
  local: true
})

const hosted = (
  provider: string,
  label: string,
  logo: ReactNode,
  modelName: string,
  type: ProviderType = "chat",
  fimTemplate?: string
): ProviderPreset => ({
  key: `${provider}-${type}`,
  label,
  descriptionKey: `preset-${provider}`,
  logo,
  provider,
  type,
  modelName,
  fimTemplate,
  local: false
})

/**
 * Model names are left blank for local servers on purpose: the form asks the
 * server what it has and picks the first match, which is always more useful
 * than a hard-coded name that may not be pulled.
 */
export const PRESETS: ProviderPreset[] = [
  // chat
  local(API_PROVIDERS.Ollama, "chat"),
  local(API_PROVIDERS.LMStudio, "chat"),
  local(API_PROVIDERS.LlamaCpp, "chat"),
  local(API_PROVIDERS.OpenAICompatible, "chat"),
  local(API_PROVIDERS.OpenWebUI, "chat"),
  local(API_PROVIDERS.LiteLLM, "chat"),
  local(API_PROVIDERS.Oobabooga, "chat"),
  hosted(API_PROVIDERS.OpenAI, "OpenAI", <SvgOpenAI />, "gpt-4.1"),
  hosted(
    API_PROVIDERS.Anthropic,
    "Anthropic",
    <SvgAnthropic />,
    "claude-sonnet-4-20250514"
  ),
  hosted(API_PROVIDERS.Deepseek, "DeepSeek", <SvgDeepseek />, "deepseek-chat"),
  hosted(API_PROVIDERS.Gemini, "Gemini", <SvgGemini />, "gemini-2.5-pro-preview-05-06"),
  hosted(API_PROVIDERS.Groq, "Groq", <SvgGroq />, "llama-3.3-70b-versatile"),
  hosted(API_PROVIDERS.Mistral, "Mistral", <SvgMistral />, "mistral-small-latest"),
  hosted(API_PROVIDERS.OpenRouter, "OpenRouter", <SvgOpenRouter />, "openai/gpt-4.1"),
  hosted(API_PROVIDERS.Cohere, "Cohere", <SvgCohere />, "command-r-plus"),
  hosted(
    API_PROVIDERS.Perplexity,
    "Perplexity",
    <SvgPerplexity />,
    "llama-3.1-sonar-small-128k-online"
  ),
  // fim
  local(API_PROVIDERS.Ollama, "fim", "", FIM_TEMPLATE_FORMAT.automatic),
  local(API_PROVIDERS.LMStudio, "fim", "", FIM_TEMPLATE_FORMAT.automatic),
  local(API_PROVIDERS.LlamaCpp, "fim", "", FIM_TEMPLATE_FORMAT.automatic),
  local(API_PROVIDERS.OpenAICompatible, "fim", "", FIM_TEMPLATE_FORMAT.automatic),
  hosted(
    API_PROVIDERS.Mistral,
    "Codestral",
    <SvgMistral />,
    "codestral-latest",
    "fim",
    FIM_TEMPLATE_FORMAT.codestral
  ),
  // embedding
  local(API_PROVIDERS.Ollama, "embedding"),
  local(API_PROVIDERS.LMStudio, "embedding"),
  local(API_PROVIDERS.LlamaCpp, "embedding"),
  local(API_PROVIDERS.OpenAICompatible, "embedding"),
  hosted(
    API_PROVIDERS.OpenAI,
    "OpenAI",
    <SvgOpenAI />,
    "text-embedding-3-small",
    "embedding"
  )
]

/** Turns a preset into the draft the form opens with. */
export const presetToProvider = (preset: ProviderPreset): TwinnyProvider => {
  const endpoint = getEndpointDefaults(preset.provider, preset.type)
  const suffix = preset.type === "chat" ? "" : ` ${preset.type.toUpperCase()}`
  return {
    id: "",
    label: `${preset.label}${suffix}`,
    modelName: preset.modelName,
    provider: preset.provider,
    type: preset.type,
    apiHostname: endpoint?.apiHostname ?? "",
    apiPort: endpoint?.apiPort,
    apiProtocol: endpoint?.apiProtocol ?? "http",
    apiPath: endpoint?.apiPath ?? "",
    apiKey: "",
    ...(preset.type === "fim"
      ? { fimTemplate: preset.fimTemplate || FIM_TEMPLATE_FORMAT.automatic }
      : {})
  }
}

interface PresetGalleryProps {
  type: ProviderType
  onSelect: (provider: TwinnyProvider) => void
  onCustom: () => void
  onBack: () => void
}

export const PresetGallery = ({
  type,
  onSelect,
  onCustom,
  onBack
}: PresetGalleryProps) => {
  const { t } = useTranslation()
  const [showAll, setShowAll] = useState(false)
  const presets = PRESETS.filter((preset) => preset.type === type)
  const localPresets = presets.filter((preset) => preset.local)
  const hostedPresets = presets.filter((preset) => !preset.local)

  const renderPreset = (preset: ProviderPreset) => (
    <button
      key={preset.key}
      type="button"
      className={styles.presetCard}
      onClick={() => onSelect(presetToProvider(preset))}
    >
      <span className={styles.presetLogo}>{preset.logo}</span>
      <span className={styles.presetBody}>
        <span className={styles.presetName}>{preset.label}</span>
        <span className={styles.presetDescription}>
          {t(preset.descriptionKey)}
        </span>
      </span>
      <i className={`codicon codicon-chevron-right ${styles.presetChevron}`} />
    </button>
  )

  return (
    <div className={styles.gallery}>
      <div className={styles.viewHeader}>
        <VSCodeButton appearance="icon" onClick={onBack} title={t("back")}>
          <i className="codicon codicon-arrow-left" />
        </VSCodeButton>
        <h4>{t(`add-${type}-provider`)}</h4>
      </div>

      <p className={styles.galleryIntro}>{t(`preset-intro-${type}`)}</p>

      <h5 className={styles.galleryGroup}>{t("preset-group-local")}</h5>
      <div className={styles.presetList}>
        {(showAll ? localPresets : localPresets.slice(0, 4)).map(renderPreset)}
      </div>
      {localPresets.length > 4 && !showAll && (
        <button
          type="button"
          className={styles.linkButton}
          onClick={() => setShowAll(true)}
        >
          {t("preset-show-more", { count: localPresets.length - 4 })}
        </button>
      )}

      {hostedPresets.length > 0 && (
        <>
          <h5 className={styles.galleryGroup}>{t("preset-group-hosted")}</h5>
          <div className={styles.presetList}>{hostedPresets.map(renderPreset)}</div>
        </>
      )}

      <div className={styles.galleryFooter}>
        <VSCodeButton appearance="secondary" onClick={onCustom}>
          <i className="codicon codicon-settings-gear" />
          {t("custom-provider")}
        </VSCodeButton>
      </div>
    </div>
  )
}
