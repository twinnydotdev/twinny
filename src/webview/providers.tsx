import React from "react"
import { useTranslation } from "react-i18next"
import {
  VSCodeButton,
  VSCodeCheckbox,
  VSCodeDivider,
  VSCodeDropdown,
  VSCodeOption,
  VSCodePanelView,
  VSCodeTextField
} from "@vscode/webview-ui-toolkit/react"

import {
  API_PROVIDERS,
  DEFAULT_PROVIDER_FORM_VALUES,
  FIM_TEMPLATE_FORMAT
} from "../common/constants"
import { TwinnyProvider } from "../extension/provider-manager"

import { DefaultProviderSelect } from "./default-providers"
import { useOllamaModels, useProviders } from "./hooks"
import { ModelSelect } from "./model-select"

import indexStyles from "./styles/index.module.css"
import styles from "./styles/providers.module.css"

type ViewState = "providers" | "defaults" | "custom-form" | "fim-form"

export const Providers = () => {
  const { t } = useTranslation()
  const [view, setView] = React.useState<ViewState>("providers")
  const [provider, setProvider] = React.useState<TwinnyProvider | undefined>()
  const {
    providers,
    removeProvider,
    copyProvider,
    resetProviders,
    saveProvider,
    getProvidersByType,
    setActiveFimProvider,
    fimProvider
  } = useProviders()

  const fimProviders = Object.values(getProvidersByType("fim")) || []
  const activeFimProvider = fimProvider

  const handleClose = () => {
    setView("providers")
    setProvider(undefined)
  }

  const handleAdd = () => {
    setView("defaults")
    setProvider(undefined)
  }

  const handleCustom = () => {
    setView("custom-form")
    setProvider(undefined)
  }

  const handleAddFim = () => {
    setView("custom-form")
    setProvider({
      ...DEFAULT_PROVIDER_FORM_VALUES,
      type: "fim"
    })
  }

  const handleAddEmbedding = () => {
    setView("custom-form")
    setProvider({
      ...DEFAULT_PROVIDER_FORM_VALUES,
      type: "embedding"
    })
  }

  const handleEdit = (provider: TwinnyProvider) => {
    setProvider(provider)
    setView("custom-form")
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

  const handleProviderSelect = (selectedProvider: TwinnyProvider) => {
    const tempProvider = { ...selectedProvider }
    delete tempProvider.features
    delete tempProvider.logo
    saveProvider(tempProvider)
    setView("providers")
  }

  const handleFimProviderChange = (e: unknown) => {
    const event = e as React.ChangeEvent<HTMLSelectElement>
    const value = event.target.value
    const provider = providers[value]
    setActiveFimProvider(provider)
  }

  const renderFimSection = () => (
    <div className={styles.fimSection}>
      <div className={styles.fimSelector}>
        <VSCodeDropdown
          value={activeFimProvider?.id}
          name="fimProvider"
          onChange={handleFimProviderChange}
        >
          {fimProviders
            .sort((a, b) => a.label.localeCompare(b.label))
            .map((provider, index) => (
              <VSCodeOption key={index} value={provider.id}>
                {provider.label}
              </VSCodeOption>
            ))}
        </VSCodeDropdown>
      </div>
    </div>
  )

  const renderView = () => {
    switch (view) {
      case "defaults":
        return (
          <>
            <div className={styles.defaultsHeader}>
              <VSCodeButton appearance="secondary" onClick={handleClose}>
                <i className="codicon codicon-arrow-left" />
                {t("back")}
              </VSCodeButton>
              <VSCodeButton onClick={handleCustom}>
                {t("custom-provider")}
              </VSCodeButton>
            </div>
            <DefaultProviderSelect onSelect={handleProviderSelect} />
          </>
        )

      case "custom-form":
        return (
          <ProviderForm
            type={provider?.type || "chat"}
            onClose={handleClose}
            provider={provider}
          />
        )

      default:
        return (
          <>
            <div className={styles.providerHeader}>
              <h4>{t("chat-provider")}</h4>
              <div className={styles.providersButtons}>
                <VSCodeButton appearance="icon" onClick={handleAdd}>
                  <i className="codicon codicon-add" />
                </VSCodeButton>
                <VSCodeButton appearance="secondary" onClick={handleReset}>
                  <i className="codicon codicon-refresh" />
                  {t("reset-providers")}
                </VSCodeButton>
              </div>
            </div>
            {Object.values(providers)
              .filter((p) => p.type === "chat")
              .map((provider, index) => (
                <div className={styles.provider} key={index}>
                  <div className={styles.providerHeader}>
                    <h3 className={styles.providerName}>
                      <i
                        title="chat"
                        className="codicon codicon-comment-discussion"
                      />
                      {provider.label}
                    </h3>
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
                </div>
              ))}

            <VSCodeDivider />

            <div className={styles.providerHeader}>
              <h4>{t("fim-provider")}</h4>
              <VSCodeButton appearance="icon" onClick={handleAddFim}>
                <i className="codicon codicon-add" />
              </VSCodeButton>
            </div>
            {renderFimSection()}
            {Object.values(providers)
              .filter((p) => p.type === "fim")
              .map((provider, index) => (
                <div className={styles.provider} key={index}>
                  <div className={styles.providerHeader}>
                    <h3 className={styles.providerName}>
                      <i title="fim" className="codicon codicon-file-code" />
                      {provider.label}
                    </h3>
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
                </div>
              ))}

            <VSCodeDivider />

            <div className={styles.providerHeader}>
              <h4>{t("embedding-provider")}</h4>
              <div className={styles.providersButtons}>
                <VSCodeButton appearance="icon" onClick={handleAddEmbedding}>
                  <i className="codicon codicon-add" />
                </VSCodeButton>
              </div>
            </div>
            {Object.values(providers)
              .filter((p) => p.type === "embedding")
              .map((provider, index) => (
                <div className={styles.provider} key={index}>
                  <div className={styles.providerHeader}>
                    <h3 className={styles.providerName}>
                      <i
                        title="embedding"
                        className="codicon codicon-database"
                      />
                      {provider.label}
                    </h3>
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
                </div>
              ))}
          </>
        )
    }
  }

  return (
    <div>
      <h3>{t("providers")}</h3>
      <VSCodePanelView>{renderView()}</VSCodePanelView>
    </div>
  )
}

interface ProviderFormProps {
  onClose: () => void
  provider?: TwinnyProvider
  type: string
}

function ProviderForm({ onClose, provider, type }: ProviderFormProps) {
  const { t } = useTranslation()
  const isEditing = provider !== undefined
  const { models } = useOllamaModels()
  const { saveProvider, updateProvider } = useProviders()
  const [formState, setFormState] = React.useState<TwinnyProvider>(
    provider || {
      ...DEFAULT_PROVIDER_FORM_VALUES,
      type
    }
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
    setFormState({ ...formState, repositoryLevel: target.checked })
  }

  const handleCancel = () => {
    onClose()
  }

  const hasOllamaModels = !!models?.length

  const getModelInput = () => {
    if (
      (formState.provider === API_PROVIDERS.Ollama) &&
      hasOllamaModels
    ) {
      return (
        <div>
          <div>
            <label htmlFor="modelName">{t("model-name")}</label>
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
      <div>
        <div>
          <label htmlFor="modelName">{t("model-name")}</label>
        </div>
        <VSCodeTextField
          name="modelName"
          onChange={handleChange}
          value={formState.modelName}
          placeholder={t("model-name-placeholder")}
        ></VSCodeTextField>
      </div>
    )
  }

  return (
    <>
      <VSCodeDivider />
      <div className={styles.defaultsHeader}>
        <VSCodeButton appearance="secondary" onClick={handleCancel}>
          <i className="codicon codicon-arrow-left" />
          {t("back")}
        </VSCodeButton>
      </div>
      <form onSubmit={handleSubmit} className={styles.providerForm}>
        <div>
          <div>
            <label htmlFor="label">{t("label")}</label>
          </div>
          <VSCodeTextField
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
            {["chat", "embedding", "fim"].map((type, index) => (
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
            <label htmlFor="provider">{t("provider")}</label>
          </div>
          <VSCodeDropdown
            name="provider"
            onChange={handleChangeDropdown}
            value={formState.provider}
          >
            {Object.values(API_PROVIDERS).map((type, index) => (
              <VSCodeOption key={index} value={type}>
                {type}
              </VSCodeOption>
            ))}
          </VSCodeDropdown>
        </div>

        <div>
          <div>
            <label htmlFor="apiProtocol">{t("protocol")}</label>
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
            onChange={handleChange}
            name="apiHostname"
            value={formState.apiHostname || ""}
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
            placeholder={t("port-placeholder")}
          ></VSCodeTextField>
        </div>

        <div>
          <div>
            <label htmlFor="apiPath">{t("api-path")}</label>
          </div>
          <VSCodeTextField
            onChange={handleChange}
            name="apiPath"
            value={formState.apiPath || ""}
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
              <span>{t("repository-level")}</span>
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
