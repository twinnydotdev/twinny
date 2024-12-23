import { useTranslation } from "react-i18next"
import { VSCodeButton, VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"

import {
  DEFAULT_ACTION_TEMPLATES,
  WORKSPACE_STORAGE_KEY
} from "../common/constants"

import { useTemplates, useWorkSpaceContext } from "./hooks"
import { kebabToSentence } from "./utils"

import styles from "./styles/index.module.css"

export const Settings = () => {
  const { t } = useTranslation()
  const { templates, saveTemplates, editDefaultTemplates } = useTemplates()
  const {
    context: selectedTemplatesContext,
    setContext: setSelectedTemplatesContext
  } =
    useWorkSpaceContext<string[]>(WORKSPACE_STORAGE_KEY.selectedTemplates) || []

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

      return setSelectedTemplatesContext((prev) => {
        const newValue = prev?.filter((item) => item !== template)
        if (!newValue) return
        saveTemplates(newValue)
        return newValue
      })
    }

    setSelectedTemplatesContext((prev) => {
      if (!prev) return
      const newValue = [...prev, template]
      saveTemplates(newValue)
      return newValue
    })
  }

  const handleResetTemplates = () => {
    saveTemplates(DEFAULT_ACTION_TEMPLATES)
    setSelectedTemplatesContext(DEFAULT_ACTION_TEMPLATES)
  }

  const handleEditDefaultTemplates = () => {
    editDefaultTemplates()
  }

  return (
    <>
      <h3>
        {t("edit-default-templates")}
      </h3>
      <p>
        {t("edit-default-templates-description")}
      </p>
      <VSCodeButton onClick={handleEditDefaultTemplates}>
        Open template editor
      </VSCodeButton>
      <h3>
        {t("template-settings")}
      </h3>
      <p>
        {t("template-settings-description")}
      </p>
      {templates &&
        templates.map((templateName: string) => (
          <div key={templateName} className={styles.vscodeCheckbox}>
            <label htmlFor={templateName}>
              <VSCodeCheckbox
                id={templateName}
                name={templateName}
                value={templateName}
                onClick={handleTemplateClick}
                checked={selectedTemplatesContext?.includes(templateName)}
              ></VSCodeCheckbox>
              <span key={templateName}>{kebabToSentence(templateName)}</span>
            </label>
          </div>
        ))}
      <VSCodeButton
        className={styles.resetTemplatesButton}
        onClick={handleResetTemplates}
      >
        {t("reset-to-default")}
      </VSCodeButton>
    </>
  )
}
