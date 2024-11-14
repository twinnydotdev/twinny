import React from "react"
import { useTranslation } from "react-i18next"
import {
  VSCodeButton,
  VSCodeCheckbox,
  VSCodeDivider,
  VSCodeDropdown,
  VSCodeOption,
  VSCodePanelView,
  VSCodeTextField,
} from "@vscode/webview-ui-toolkit/react"

import {
  DEFAULT_PROVIDER_FORM_VALUES,
  FIM_TEMPLATE_FORMAT,
} from "../common/constants"
import { apiProviders } from "../common/types"
import { TwinnyProvider } from "../extension/provider-manager"

import { useOllamaModels, useProviders } from "./hooks"
import { ModelSelect } from "./model-select"

import indexStyles from "./styles/index.module.css"
import styles from "./styles/providers.module.css"

export const Providers = () => {
  const { t } = useTranslation()
  const [showForm, setShowForm] = React.useState(false)
  const [provider, setProvider] = React.useState<TwinnyProvider | undefined>()
  const { models } = useOllamaModels()
  const hasOllamaModels = !!models?.length
  const {
    updateProvider,
    providers,
    removeProvider,
    copyProvider,
    resetProviders,
  } = useProviders()

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

  const handleSetModel = (provider: TwinnyProvider, model: string) => {
    updateProvider({
      ...provider,
      modelName: model,
    })
  }

  const handleChange = (provider: TwinnyProvider, e: unknown) => {
    const event = e as unknown as React.ChangeEvent<HTMLInputElement>
    const { value } = event.target
    handleSetModel(provider, value)
  }

  return (
    <div>
      <h3>
        {t("providers")}
      </h3>
      <VSCodePanelView>
        {showForm ? (
          <ProviderForm onClose={handleClose} provider={provider} />
        ) : (
          <>
            <div>
              <div className={styles.providersHeader}>
                <VSCodeButton onClick={handleAdd}>Add Provider</VSCodeButton>
                <VSCodeButton appearance="secondary" onClick={handleReset}>
                  <i className="codicon codicon-refresh" />
                  {t("reset-providers")}
                </VSCodeButton>
              </div>
              {Object.values(providers).map((provider, index) => (
                <div className={styles.provider} key={index}>
                  <div className={styles.providerHeader}>
                    {provider.provider === apiProviders.Ollama &&
                      hasOllamaModels && (
                        <ModelSelect
                          models={models}
                          model={provider.modelName}
                          setModel={(model: string) =>
                            handleSetModel(provider, model)
                          }
                        />
                      )}
                    {provider.provider !== apiProviders.Ollama && (
                      <VSCodeTextField
                        required
                        name="modelName"
                        onChange={(e) => {
                          handleChange(provider, e)
                        }}
                        value={provider.modelName}
                        placeholder={t("applicable-ollama")}
                      ></VSCodeTextField>
                    )}
                    <div className={styles.providerActions}>
                      <VSCodeButton
                        appearance="icon"
                        title={t("edit-provider")}
                        aria-label={t("edit-provider")}
                        onClick={() => handleEdit(provider)}
                      >
                        <i className="codicon codicon-edit" />
                      </VSCodeButton>
                      <VSCodeButton
                        appearance="icon"
                        title={t("copy-provider")}
                        aria-label={t("copy-provider")}
                        onClick={() => handleCopy(provider)}
                      >
                        <i className="codicon codicon-copy" />
                      </VSCodeButton>
                      <VSCodeButton
                        appearance="icon"
                        title={t("delete-provider")}
                        aria-label={t("delete-provider")}
                        onClick={() => handleDelete(provider)}
                      >
                        <i className="codicon codicon-trash" />
                      </VSCodeButton>
                    </div>
                  </div>
                  <VSCodeDivider />
                  <div className={styles.providerDetails}>
                    <div>
                      <b>{t("label")}:</b> {provider.label}
                    </div>
                    <div>
                      <b>{t("provider")}:</b> {provider.provider}
                    </div>
                    <div>
                      <b>{t("type")}:</b> {provider.type}
                    </div>
                    {provider.type === "fim" && (
                      <div>
                        <b>{t("fim-template")}:</b> {provider.fimTemplate}
                      </div>
                    )}
                    <div>
                      <b>{t("hostname")}:</b> {provider.apiHostname}
                    </div>
                    <div>
                      <b>{t("path")}:</b> {provider.apiPath}
                    </div>
                    <div>
                      <b>{t("protocol")}:</b> {provider.apiProtocol}
                    </div>
                    <div>
                      <b>{t("port")}:</b> {provider.apiPort}
                    </div>
                    {provider.apiKey && (
                      <div>
                        <b>{t("api-key")}:</b> {provider.apiKey.substring(0, 12)}...
                      </div>
                    )}
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
  const { t } = useTranslation()
  const isEditing = provider !== undefined
  const { models } = useOllamaModels()
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
    const value = event?.target.value || ""
    const name = event?.target.name || ""
    setFormState({ ...formState, [name]: value.trim() })
  }

  const handleRepositoryLevelCheck = (
    e: React.MouseEvent<HTMLInputElement, MouseEvent>
  ) => {
    const target = e.target as HTMLInputElement
    console.log(target.checked, target.value)
    setFormState({ ...formState, repositoryLevel: target.checked })
  }

  const handleCancel = () => {
    onClose()
  }

  const hasOllamaModels = !!models?.length

  const getModelInput = () => {
    if (formState.provider === apiProviders.Ollama && hasOllamaModels) {
      return (
        <div>
          <div>
            <label htmlFor="modelName">Model name*</label>
          </div>
          <ModelSelect
            models={models}
            model={formState.modelName}
            setModel={(model: string) => {
              setFormState({ ...formState, modelName: model })
            }}
          />
        </div>
      )
    }

    return (
      <>
        <div>
          <label htmlFor="modelName">{t("model-name")}*</label>
        </div>
        <VSCodeTextField
          required
          name="modelName"
          onChange={handleChange}
          value={formState.modelName}
          placeholder={t("model-name-placeholder")}
        ></VSCodeTextField>
      </>
    )
  }

  return (
    <>
      <VSCodeDivider />
      <form onSubmit={handleSubmit} className={styles.providerForm}>
        <div>
          <div>
            <label htmlFor="label">{t("label")}*</label>
          </div>
          <VSCodeTextField
            required
            name="label"
            onChange={handleChange}
            value={formState.label}
            placeholder={t("label-placeholder")}
          ></VSCodeTextField>
        </div>

        <div>
          <div>
            <label htmlFor="type">{t("type")}*</label>
          </div>
          <VSCodeDropdown
            name="type"
            onChange={handleChangeDropdown}
            value={formState.type}
          >
            {["chat", "fim", "embedding"].map((type, index) => (
              <VSCodeOption key={index} value={type}>
                {type}
              </VSCodeOption>
            ))}
          </VSCodeDropdown>
        </div>

        {formState.type === "fim" && (
          <div>
            <div>
              <label htmlFor="type">{t("fim-template")}*</label>
            </div>
            <VSCodeDropdown
              name="fimTemplate"
              onChange={handleChangeDropdown}
              value={formState.fimTemplate}
            >
              {Object.values(FIM_TEMPLATE_FORMAT).map((type, index) => (
                <VSCodeOption key={index} value={type || t("automatic")}>
                  {type}
                </VSCodeOption>
              ))}
            </VSCodeDropdown>
          </div>
        )}

        <div>
          <div>
            <label htmlFor="provider">{t("provider")}*</label>
          </div>
          <VSCodeDropdown
            name="provider"
            onChange={handleChangeDropdown}
            value={formState.provider}
          >
            {Object.values(apiProviders).map((type, index) => (
              <VSCodeOption key={index} value={type}>
                {type}
              </VSCodeOption>
            ))}
          </VSCodeDropdown>
        </div>

        <div>
          <div>
            <label htmlFor="apiProtocol">{t("protocol")}*</label>
          </div>
          <VSCodeDropdown
            name="apiProtocol"
            onChange={handleChangeDropdown}
            value={formState.apiProtocol}
          >
            {["http", "https"].map((type, index) => (
              <VSCodeOption key={index} value={type}>
                {type}
              </VSCodeOption>
            ))}
          </VSCodeDropdown>
        </div>

        {getModelInput()}

        <div>
          <div>
            <label htmlFor="apiHostname">{t("hostname")}*</label>
          </div>
          <VSCodeTextField
            required
            onChange={handleChange}
            name="apiHostname"
            value={formState.apiHostname}
            placeholder={t("hostname-placeholder")}
          ></VSCodeTextField>
        </div>

        <div>
          <div>
            <label htmlFor="apiPort">{t("port")}</label>
          </div>
          <VSCodeTextField
            onChange={handleChange}
            name="apiPort"
            value={formState.apiPort ? formState.apiPort.toString() : ""}
            placeholder='Enter a port e.g "11434"'
          ></VSCodeTextField>
        </div>

        <div>
          <div>
            <label htmlFor="apiPath">{t("api-path")}*</label>
          </div>
          <VSCodeTextField
            required
            onChange={handleChange}
            name="apiPath"
            value={formState.apiPath}
            placeholder={t("api-path-placeholder")}
          ></VSCodeTextField>
        </div>

        <div>
          <div>
            <label htmlFor="apiKey">{t("api-key")}</label>
          </div>
          <VSCodeTextField
            onChange={handleChange}
            name="apiKey"
            value={formState.apiKey || ""}
            placeholder={t("api-key-placeholder")}
          ></VSCodeTextField>
        </div>

        {formState.type === "fim" && (
          <div className={indexStyles.vscodeCheckbox}>
            <label htmlFor="repositoryLevel">
              <VSCodeCheckbox
                id="repositoryLevel"
                name="repositoryLevel"
                checked={formState.repositoryLevel}
                onClick={handleRepositoryLevelCheck}
              ></VSCodeCheckbox>
              <span>
                {t("repository-level")}
              </span>
            </label>
          </div>
        )}

        <div className={styles.providerFormButtons}>
          <VSCodeButton appearance="primary" type="submit">
            {t("save")}
          </VSCodeButton>
          <VSCodeButton appearance="secondary" onClick={handleCancel}>
            {t("cancel")}
          </VSCodeButton>
        </div>
      </form>
    </>
  )
}
