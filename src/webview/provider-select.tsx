import { useTranslation } from "react-i18next"
import {
  VSCodeCheckbox,
  VSCodeDropdown,
  VSCodeOption
} from "@vscode/webview-ui-toolkit/react"

import { EXTENSION_CONTEXT_NAME } from "../common/constants"

import { useGlobalContext, useProviders } from "./hooks"

import indexStyles from "./styles/index.module.css"
import styles from "./styles/providers.module.css"

export const ProviderSelect = () => {
  const { t } = useTranslation()
  const {
    getProvidersByType,
    setActiveChatProvider,
    setActiveFimProvider,
    providers,
    chatProvider,
    fimProvider
  } = useProviders()

  const { context: enableTools = false, setContext: setEnableTools } =
    useGlobalContext<boolean>(EXTENSION_CONTEXT_NAME.twinnyEnableTools)

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
        <div>{t("chat")}</div>
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
        <div>{t("fim")}</div>
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
      <div className={styles.enableTools}>
        <div className={indexStyles.vscodeCheckbox}>
          <label htmlFor="repositoryLevel">
            <VSCodeCheckbox
              id="repositoryLevel"
              name="repositoryLevel"
              checked={enableTools}
              onClick={() => setEnableTools(!enableTools)}
            ></VSCodeCheckbox>
            <span>{t("enable-tools")}</span>
          </label>
        </div>
      </div>
    </div>
  )
}
