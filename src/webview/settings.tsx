import { useTranslation } from "react-i18next"
import { VSCodeButton, VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"

import {
  DEFAULT_ACTION_TEMPLATES,
  WORKSPACE_STORAGE_KEY
} from "../common/constants"

import {
  StorageType,
  useStorageContext
} from "./hooks/useStorageContext"
import { useTemplates } from "./hooks/useTemplates"
import { kebabToSentence } from "./utils"

import styles from "./styles/settings.module.css"

export const Settings = () => {
  const { t } = useTranslation()
  const { templates, saveTemplates, editDefaultTemplates } = useTemplates()
  const {
    context: selectedTemplatesContext,
    setContext: setSelectedTemplatesContext
  } =
    useStorageContext<string[] | undefined>(
      StorageType.Workspace,
      WORKSPACE_STORAGE_KEY.selectedTemplates
    ) || []

  const handleTemplateClick = (
    e: React.MouseEvent<HTMLInputElement, MouseEvent>
  ) => {
    const target = e.target as HTMLInputElement

    const template = target.value

    if (selectedTemplatesContext?.includes(template)) {
      if (selectedTemplatesContext.length === 1) {
      saveTemplates([])
      setSelectedTemplatesContext([])
      return
      }

      const newValue = selectedTemplatesContext.filter((item) => item !== template)
      saveTemplates(newValue)
      setSelectedTemplatesContext(newValue)
      return
    }

    const currentValue = selectedTemplatesContext || []
    const newValue = [...currentValue, template]
    saveTemplates(newValue)
    setSelectedTemplatesContext(newValue)
  }

  const handleClearSelection = () => {
    saveTemplates(DEFAULT_ACTION_TEMPLATES)
    setSelectedTemplatesContext(DEFAULT_ACTION_TEMPLATES)
  }

  const handleEditDefaultTemplates = () => {
    editDefaultTemplates()
  }

  return (
    <div className={styles.settingsContainer}>
      <h3>{t("edit-default-templates")}</h3>
      <p>{t("edit-default-templates-description")}</p>
      <div className={styles.templateEditor}>
        <VSCodeButton onClick={handleEditDefaultTemplates}>
          {t("open-template-editor")}
        </VSCodeButton>
      </div>

      <h3>{t("template-settings")}</h3>
      <p>{t("template-settings-description")}</p>

      <div className={styles.checkboxGroup}>
        {templates &&
          templates.map((templateName: string) => (
            <div key={templateName} className={styles.checkboxItem}>
              <label htmlFor={templateName}>
                <VSCodeCheckbox
                  id={templateName}
                  name={templateName}
                  value={templateName}
                  onClick={handleTemplateClick}
                  checked={selectedTemplatesContext?.includes(templateName)}
                />
                <span>{kebabToSentence(templateName)}</span>
              </label>
            </div>
          ))}
      </div>

      <div className={styles.resetButton}>
        <VSCodeButton onClick={handleClearSelection}>
          {t("clear")}
        </VSCodeButton>
      </div>
    </div>
  )
}
