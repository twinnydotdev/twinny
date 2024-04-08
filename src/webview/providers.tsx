import React from 'react'
import { useProviders } from './hooks'
import {
  VSCodeButton,
  VSCodeDivider,
  VSCodeDropdown,
  VSCodeOption,
  VSCodePanelView,
  VSCodeTextField
} from '@vscode/webview-ui-toolkit/react'
import { ApiProviders } from '../common/types'

import styles from './providers.module.css'
import { TwinnyProvider } from '../extension/provider-manager'
import {
  DEFAULT_PROVIDER_FORM_VALUES,
  FIM_TEMPLATE_TYPE
} from '../common/constants'

export const Providers = () => {
  const [showForm, setShowForm] = React.useState(false)
  const [provider, setProvider] = React.useState<TwinnyProvider | undefined>()
  const { providers, removeProvider, copyProvider, resetProviders } =
    useProviders()

  const handleClose = () => {
    setShowForm(false)
  }

  const handleAdd = () => {
    setProvider(undefined)
    setShowForm(true)
  }

  const handleEdit = (provider: TwinnyProvider) => {
    setProvider(provider)
    setShowForm(true)
  }

  const handleDelete = (provider: TwinnyProvider) => {
    removeProvider(provider)
  }

  const handleCopy = (provider: TwinnyProvider) => {
    copyProvider(provider)
  }

  const handleReset = () => {
    resetProviders()
  }

  return (
    <div>
      <h3>Providers</h3>
      <VSCodePanelView>
        {showForm ? (
          <ProviderForm onClose={handleClose} provider={provider} />
        ) : (
          <>
            <div>
              <div className={styles.providerHeader}>
                <VSCodeButton onClick={handleAdd}>Add Provider</VSCodeButton>
                <VSCodeButton appearance="secondary" onClick={handleReset}>
                <i className="codicon codicon-refresh" />
                  Reset Providers
                </VSCodeButton>
              </div>
              {Object.values(providers).map((provider, index) => (
                <div className={styles.provider} key={index}>
                  <div className={styles.providerDetails}>
                    <div>
                      <b>Provider:</b> {provider.provider}
                    </div>
                    <div>
                      <b>Type:</b> {provider.type}
                    </div>
                    {provider.type === 'fim' && (
                      <div>
                        <b>Fim Template Type:</b> {provider.fimTemplate}
                      </div>
                    )}
                    <div>
                      <b>Model:</b> {provider.modelName}
                    </div>
                    <div>
                      <b>Hostname:</b> {provider.apiHostname}
                    </div>
                    <div>
                      <b>Path:</b> {provider.apiPath}
                    </div>
                    <div>
                      <b>Protocol:</b> {provider.apiProtocol}
                    </div>
                    <div>
                      <b>Port:</b> {provider.apiPort}
                    </div>
                  </div>
                  <div className={styles.providerActions}>
                    <VSCodeButton
                      appearance="icon"
                      title="Edit provider"
                      aria-label="Edit provider"
                      onClick={() => handleEdit(provider)}
                    >
                      <i className="codicon codicon-edit" />
                    </VSCodeButton>
                    <VSCodeButton
                      appearance="icon"
                      title="Copy provider"
                      aria-label="Copy provider"
                      onClick={() => handleCopy(provider)}
                    >
                      <i className="codicon codicon-copy" />
                    </VSCodeButton>
                    <VSCodeButton
                      appearance="icon"
                      title="Delete provider"
                      aria-label="Delete provider"
                      onClick={() => handleDelete(provider)}
                    >
                      <i className="codicon codicon-trash" />
                    </VSCodeButton>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </VSCodePanelView>
    </div>
  )
}

interface ProviderFormProps {
  onClose: () => void
  provider?: TwinnyProvider
}

function ProviderForm({ onClose, provider }: ProviderFormProps) {
  const isEditing = provider !== undefined
  const { saveProvider, updateProvider } = useProviders()
  const [formState, setFormState] = React.useState<TwinnyProvider>(
    provider || DEFAULT_PROVIDER_FORM_VALUES
  )

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (isEditing) {
      updateProvider(formState)
      return onClose()
    }
    saveProvider(formState)
    onClose()
  }

  const handleChange = (e: unknown) => {
    const event = e as unknown as React.ChangeEvent<HTMLInputElement>
    const { name, value } = event.target
    setFormState({ ...formState, [name]: value.trim() })
  }

  const handleChangeDropdown = (e: unknown): void => {
    const event = e as React.ChangeEvent<HTMLSelectElement>
    const value = event?.target.value || ''
    const name = event?.target.name || ''
    setFormState({ ...formState, [name]: value.trim() })
  }

  const handleCancel = () => {
    onClose()
  }

  return (
    <>
      <VSCodeDivider />
      <form onSubmit={handleSubmit} className={styles.providerForm}>
        <div>
          <div>
            <label htmlFor="type">Type*</label>
          </div>
          <VSCodeDropdown
            name="type"
            onChange={handleChangeDropdown}
            value={formState.type}
          >
            {['chat', 'fim'].map((type, index) => (
              <VSCodeOption key={index} value={type}>
                {type === 'chat' ? 'Chat' : 'FIM'}
              </VSCodeOption>
            ))}
          </VSCodeDropdown>
        </div>

        {formState.type === 'fim' && (
          <div>
            <div>
              <label htmlFor="type">Fim Template*</label>
            </div>
            <VSCodeDropdown
              name="fimTemplate"
              onChange={handleChangeDropdown}
              value={formState.fimTemplate}
            >
              {FIM_TEMPLATE_TYPE.map((type, index) => (
                <VSCodeOption key={index} value={type || 'automatic'}>
                  {type}
                </VSCodeOption>
              ))}
            </VSCodeDropdown>
          </div>
        )}

        <div>
          <div>
            <label htmlFor="provider">Provider*</label>
          </div>
          <VSCodeDropdown
            name="provider"
            onChange={handleChangeDropdown}
            value={formState.provider}
          >
            {Object.values(ApiProviders).map((type, index) => (
              <VSCodeOption key={index} value={type}>
                {type}
              </VSCodeOption>
            ))}
          </VSCodeDropdown>
        </div>

        <div>
          <div>
            <label htmlFor="apiProtocol">Protocol*</label>
          </div>
          <VSCodeDropdown
            name="apiProtocol"
            onChange={handleChangeDropdown}
            value={formState.apiProtocol}
          >
            {['http', 'https'].map((type, index) => (
              <VSCodeOption key={index} value={type}>
                {type}
              </VSCodeOption>
            ))}
          </VSCodeDropdown>
        </div>

        <div>
          <div>
            <label htmlFor="modelName">Model name*</label>
          </div>
          <VSCodeTextField
            required
            name="modelName"
            onChange={handleChange}
            value={formState.modelName}
            placeholder='Enter a model name e.g "codellama:7b-code"'
          ></VSCodeTextField>
        </div>

        <div>
          <div>
            <label htmlFor="apiHostname">Hostname*</label>
          </div>
          <VSCodeTextField
            required
            onChange={handleChange}
            name="apiHostname"
            value={formState.apiHostname}
            placeholder='Enter a hostname e.g "localhost"'
          ></VSCodeTextField>
        </div>

        <div>
          <div>
            <label htmlFor="apiPort">Port*</label>
          </div>
          <VSCodeTextField
            required
            onChange={handleChange}
            name="apiPort"
            value={formState.apiPort.toString()}
            placeholder='Enter a port e.g "80"'
          ></VSCodeTextField>
        </div>

        <div>
          <div>
            <label htmlFor="apiPath">API path*</label>
          </div>
          <VSCodeTextField
            required
            onChange={handleChange}
            name="apiPath"
            value={formState.apiPath}
            placeholder='e.g "/api/generate" or "/v1/chat/completions"'
          ></VSCodeTextField>
        </div>

        <div>
          <div>
            <label htmlFor="apiKey">API key</label>
          </div>
          <VSCodeTextField
            required
            onChange={handleChange}
            name="apiKey"
            value={formState.apiKey || ''}
            placeholder="Enter an API key"
          ></VSCodeTextField>
        </div>

        <div className={styles.providerFormButtons}>
          <VSCodeButton appearance="primary" type="submit">
            Save
          </VSCodeButton>
          <VSCodeButton appearance="secondary" onClick={handleCancel}>
            Cancel
          </VSCodeButton>
        </div>
      </form>
    </>
  )
}
