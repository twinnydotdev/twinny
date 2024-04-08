import {
  VSCodeDropdown,
  VSCodeOption,
  VSCodeDivider
} from '@vscode/webview-ui-toolkit/react'

import styles from './providers.module.css'
import { useProviders } from './hooks'

export const ProviderSelect = () => {
  const {
    getFimProvidersByType,
    setActiveChatProvider,
    setActiveFimProvider,
    providers,
    chatProvider,
    fimProvider
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
    <>
      <div className={styles.providerSelector}>
        <div>
          <div>Chat</div>
          <VSCodeDropdown
            value={chatProvider?.id}
            name="provider"
            onChange={handleChangeChatProvider}
          >
            {Object.values(getFimProvidersByType('chat'))
              .sort((a, b) => a.modelName.localeCompare(b.modelName))
              .map((provider, index) => (
                <VSCodeOption key={index} value={provider.id}>
                  {`${provider.label} (${provider.provider})`}
                </VSCodeOption>
              ))}
          </VSCodeDropdown>
        </div>
        <div>
          <div>Fill-in-middle</div>
          <VSCodeDropdown
            value={fimProvider?.id}
            name="provider"
            onChange={handleChangeFimProvider}
          >
            {Object.values(getFimProvidersByType('fim'))
              .sort((a, b) => a.modelName.localeCompare(b.modelName))
              .map((provider, index) => (
                <VSCodeOption key={index} value={provider.id}>
                  {`${provider.label} (${provider.provider})`}
                </VSCodeOption>
              ))}
          </VSCodeDropdown>
        </div>
      </div>
      <VSCodeDivider />
    </>
  )
}
