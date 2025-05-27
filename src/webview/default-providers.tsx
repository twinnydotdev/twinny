import React, { useState } from "react"
import { useTranslation } from "react-i18next"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"

import { API_PROVIDERS } from "../common/constants"
import { TwinnyProvider } from "../extension/provider-manager"

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
  SvgPerplexity,
  SvgTwinny,
} from "./icons"

import styles from "./styles/providers.module.css"

interface ProviderSelectProps {
  onSelect: (provider: TwinnyProvider) => void
}
const providers: TwinnyProvider[] = [
  {
    label: "providers-twinny-name",
    apiHostname: "twinny.dev",
    apiPath: "/v1",
    logo: <SvgTwinny />,
    apiProtocol: "https",
    modelName: "",
    id: "twinny",
    provider: API_PROVIDERS.Twinny,
    type: "chat",
  },
  {
    label: "providers-ollama-name",
    logo: <SvgOllama />,
    apiHostname: "localhost",
    apiPort: 11434,
    apiPath: "/v1",
    apiProtocol: "http",
    id: "openai-compatible-default",
    modelName: "codellama:7b-instruct",
    provider: API_PROVIDERS.Ollama,
    type: "chat",
  },
  {
    label: "providers-openai-compatible-name",
    logo: <SvgOpenAI />,
    apiHostname: "localhost",
    apiPort: 11434,
    apiPath: "/v1",
    apiProtocol: "http",
    id: "openai-compatible-default",
    modelName: "codellama:7b-instruct",
    provider: API_PROVIDERS.OpenAICompatible,
    type: "chat",
  },
  {
    label: "providers-openai-name",
    logo: <SvgOpenAI />,
    id: "openai-default",
    modelName: "gpt-4.1",
    provider: API_PROVIDERS.OpenAI,
    type: "chat"
  },
  {
    label: "providers-anthropic-name",
    logo: <SvgAnthropic />,
    id: "anthropic-default",
    modelName: "claude-3-opus-20240229",
    provider: API_PROVIDERS.Anthropic,
    type: "chat"
  },
  {
    label: "providers-deepseek-name",
    logo: <SvgDeepseek />,
    id: "openai-default",
    modelName: "deepseek-chat",
    provider: API_PROVIDERS.Deepseek,
    type: "chat",
    apiHostname: "api.deepseek.com",
    apiProtocol: "https"
  },
  {
    label: "providers-groq-name",
    logo: <SvgGroq />,
    id: "groq-default",
    modelName: "llama-3.3-70b-versatile",
    provider: API_PROVIDERS.Groq,
    type: "chat"
  },
  {
    label: "providers-openrouter-name",
    logo: <SvgOpenRouter />,
    id: "openrouter-default",
    modelName: "openai/gpt-4",
    provider: API_PROVIDERS.OpenRouter,
    type: "chat"
  },
  {
    label: "providers-cohere-name",
    logo: <SvgCohere />,
    id: "cohere",
    modelName: "command-r-plus",
    provider: API_PROVIDERS.Cohere,
    type: "chat"
  },
  {
    label: "providers-perplexity-name",
    logo: <SvgPerplexity />,
    id: "perplexity",
    modelName: "llama-3-sonar-small-32k-chat",
    provider: API_PROVIDERS.Perplexity,
    type: "chat"
  },
  {
    label: "providers-gemini-name",
    logo: <SvgGemini />,
    id: "gemini",
    modelName: "gemini-1.5-pro",
    provider: API_PROVIDERS.Gemini,
    type: "chat"
  },
  {
    label: "providers-mistral-name",
    logo: <SvgMistral />,
    apiPath: "/v1",
    id: "mistral",
    modelName: "mistral-small-latest",
    provider: API_PROVIDERS.Mistral,
    type: "chat"
  }
]

export const DefaultProviderSelect: React.FC<ProviderSelectProps> = ({
  onSelect
}) => {
  const { t } = useTranslation()
  const [showDefaults, setShowDefaults] = useState<boolean>(false)

  const handleProviderClick = (provider: TwinnyProvider) => {
    onSelect(provider)
  }

  const renderProviderDefaults = (provider: TwinnyProvider) => {
    return (
      <div className={styles.defaults}>
        <h4 className={styles.defaultsTitle}>{t("default-settings")}</h4>
        <div className={styles.defaultsGrid}>
          <div className={styles.defaultItem}>
            <span className={styles.defaultLabel}>API Host:</span>
            <span>{provider.apiHostname || t("providers-default-detail")}</span>
          </div>
          <div className={styles.defaultItem}>
            <span className={styles.defaultLabel}>API Path:</span>
            <span>{provider.apiPath || t("providers-default-detail")}</span>
          </div>
          <div className={styles.defaultItem}>
            <span className={styles.defaultLabel}>Protocol:</span>
            <span>{provider.apiProtocol || t("providers-default-detail")}</span>
          </div>
          <div className={styles.defaultItem}>
            <span className={styles.defaultLabel}>Model:</span>
            <span>{provider.modelName || t("providers-default-detail")}</span>
          </div>
          {provider.apiPort && (
            <div className={styles.defaultItem}>
              <span className={styles.defaultLabel}>Port:</span>
              <span>{provider.apiPort || t("providers-default-detail")}</span>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <h2 className={styles.title}>{t("select-llm-provider")}</h2>

      <div className={styles.providersList}>
        {providers.map((provider) => (
          <div key={provider.label} className={styles.providerCard} onClick={() => handleProviderClick(provider)}>
            <div className={styles.logo}>{provider.logo}</div>

            <div className={styles.content}>
              <div className={styles.header}>
                <h3 className={styles.providerName}>{t(provider.label)}</h3>
                <div className={styles.actions}>
                  <VSCodeButton
                    appearance="icon"
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setShowDefaults(!showDefaults)
                    }}
                    title={t("toggle-defaults")}
                  >
                    <i className="codicon codicon-question"></i>
                  </VSCodeButton>
                  <VSCodeButton
                    appearance="icon"
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      handleProviderClick(provider)
                    }}
                    title={t("select-provider")}
                  >
                    <i className="codicon codicon-add"></i>
                  </VSCodeButton>
                </div>
              </div>
              {provider.features && (
                <div className={styles.features}>
                  {provider.features.map((feature) => (
                    <span key={feature} className={styles.featureBadge}>
                      {t(feature)}
                    </span>
                  ))}
                </div>
              )}
              {showDefaults && renderProviderDefaults(provider)}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
