import React, { useState } from "react"
import { useTranslation } from "react-i18next"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"

import { TwinnyProvider } from "../extension/provider-manager"

import {
  SvgAnthropic,
  SvgCohere,
  SvgGemini,
  SvgGroq,
  SvgMistral,
  SvgOllama,
  SvgOpenAI,
  SvgOpenRouter,
  SvgPerplexity,
} from "./icons"

import styles from "./styles/providers.module.css"

interface ProviderSelectProps {
  onSelect: (provider: TwinnyProvider) => void
}
const providers: TwinnyProvider[] = [
  {
    label: "OpenAi Compatible (localhost)",
    logo: <SvgOllama />,
    apiHostname: "localhost",
    apiPort: 11434,
    apiPath: "/v1",
    apiProtocol: "http",
    id: "openai-compatible-default",
    modelName: "llama3.2:latest",
    provider: "openai-compatible",
    type: "chat"
  },
  {
    label: "OpenAI",
    logo: <SvgOpenAI />,
    id: "openai-default",
    modelName: "gpt-4o",
    provider: "openai",
    type: "chat"
  },
  {
    label: "Anthropic",
    logo: <SvgAnthropic />,
    id: "anthropic-default",
    modelName: "claude-3-opus-20240229",
    provider: "anthropic",
    type: "chat"
  },
  {
    label: "Groq",
    features: ["Chat", "Streaming"],
    logo: <SvgGroq />,
    id: "groq-default",
    modelName: "llama2-70b-4096",
    provider: "groq",
    type: "chat"
  },
  {
    label: "OpenRouter",
    logo: <SvgOpenRouter />,
    id: "openrouter-default",
    modelName: "openai/gpt-4",
    provider: "openrouter",
    type: "chat"
  },
  {
    label: "Cohere",
    logo: <SvgCohere />,
    id: "cohere",
    modelName: "command-r-plus",
    provider: "cohere",
    type: "chat"
  },
  {
    label: "Perplexity",
    logo: <SvgPerplexity />,
    id: "perplexity",
    modelName: "llama-3-sonar-small-32k-chat",
    provider: "perplexity",
    type: "chat"
  },
  {
    label: "Gemini",
    logo: <SvgGemini />,
    id: "gemini",
    modelName: "gemini-1.5-pro",
    provider: "gemini",
    type: "chat"
  },
  {
    label: "Mistral",
    logo: <SvgMistral />,
    apiPath: "/v1",
    id: "mistral",
    modelName: "mistral-small-latest",
    provider: "mistral",
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
            <span>{provider.apiHostname || "provider default"}</span>
          </div>
          <div className={styles.defaultItem}>
            <span className={styles.defaultLabel}>API Path:</span>
            <span>{provider.apiPath || "provider default"}</span>
          </div>
          <div className={styles.defaultItem}>
            <span className={styles.defaultLabel}>Protocol:</span>
            <span>{provider.apiProtocol || "provider default"}</span>
          </div>
          <div className={styles.defaultItem}>
            <span className={styles.defaultLabel}>Model:</span>
            <span>{provider.modelName || "provider default"}</span>
          </div>
          {provider.apiPort && (
            <div className={styles.defaultItem}>
              <span className={styles.defaultLabel}>Port:</span>
              <span>{provider.apiPort || "provider default"}</span>
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
                <h3 className={styles.providerName}>{provider.label}</h3>
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

              {showDefaults && renderProviderDefaults(provider)}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
