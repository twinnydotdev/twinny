import { useTranslation } from "react-i18next"
import {
  VSCodeDropdown,
  VSCodeOption,
} from "@vscode/webview-ui-toolkit/react"

import { useProviders } from "./hooks"

import styles from "./styles/providers.module.css"

export const ProviderSelect = () => {
  const { t } = useTranslation()
  const {
    getProvidersByType,
    setActiveChatProvider,
    setActiveFimProvider,
    providers,
    chatProvider,
    fimProvider,
  } = useProviders()

  const handleChangeChatProvider = (e: unknown): void => {
    const event = e as React.ChangeEvent<HTMLSelectElement>
    const value = event.target.value
    const provider = providers[value]
    setActiveChatProvider(provider)
  }

  const handleChangeFimProvider = (e: unknown): void => {
    const event = e as React.ChangeEvent<HTMLSelectElement>
    const value = event.target.value
    const provider = providers[value]
    setActiveFimProvider(provider)
  }

  return (
    <div className={styles.providerSelector}>
      <div>
        <div>
          {t("chat")}
        </div>
        <VSCodeDropdown
          value={chatProvider?.id}
          name="provider"
          onChange={handleChangeChatProvider}
        >
          {Object.values(getProvidersByType("chat"))
            .sort((a, b) => a.modelName.localeCompare(b.modelName))
            .map((provider, index) => (
              <VSCodeOption key={index} value={provider.id}>
                {`${provider.label} (${provider.modelName})`}
              </VSCodeOption>
            ))}
        </VSCodeDropdown>
      </div>
      <div>
        <div>
          {t("fim")}
        </div>
        <VSCodeDropdown
          value={fimProvider?.id}
          name="provider"
          onChange={handleChangeFimProvider}
        >
          {Object.values(getProvidersByType("fim"))
            .sort((a, b) => a.modelName.localeCompare(b.modelName))
            .map((provider, index) => (
              <VSCodeOption key={index} value={provider.id}>
                {`${provider.label} (${provider.modelName})`}
              </VSCodeOption>
            ))}
        </VSCodeDropdown>
      </div>
    </div>
  )
}
