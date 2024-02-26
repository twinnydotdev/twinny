import { VSCodeButton, VSCodeCheckbox } from '@vscode/webview-ui-toolkit/react'
import { useTemplates, useWorkSpaceContext } from './hooks'
import { DEFAULT_ACTION_TEMPLATES, MESSAGE_KEY } from '../common/constants'
import { useEffect, useState } from 'react'
import { kebabToSentence } from './utils'

import styles from './index.module.css'

export const TemplateSettings = () => {
  const { templates, saveTemplates } = useTemplates()
  const [selectedTemplates, setSelectedTemplates] = useState<string[]>([])
  const selectedTemplatesContext =
    useWorkSpaceContext<string[]>(MESSAGE_KEY.selectedTemplates) || []

  const handleTemplateClick = (
    e: React.MouseEvent<HTMLInputElement, MouseEvent>
  ) => {
    const target = e.target as HTMLInputElement

    const template = target.value

    if (selectedTemplates.includes(template)) {
      if (selectedTemplates.length === 1) {
        saveTemplates([])
        setSelectedTemplates([])
        return
      }

      return setSelectedTemplates((prev) => {
        const newValue = prev.filter((item) => item !== template)
        saveTemplates(newValue)
        return newValue
      })
    }

    setSelectedTemplates((prev) => {
      const newValue = [...prev, template]
      saveTemplates(newValue)
      return newValue
    })
  }

  const handleResetTemplates = () => {
    saveTemplates(DEFAULT_ACTION_TEMPLATES)
    setSelectedTemplates(DEFAULT_ACTION_TEMPLATES)
  }

  useEffect(() => {
    if (selectedTemplatesContext !== undefined) {
      return setSelectedTemplates(selectedTemplatesContext)
    } else {
      setSelectedTemplates(DEFAULT_ACTION_TEMPLATES)
    }
  }, [selectedTemplatesContext])

  return (
    <>
      <h4>Template settings</h4>
      <p>
        Select the templates you want to use in the chat interface.
      </p>
      {templates &&
        templates.map((templateName: string) => (
          <div className={styles.templateCheckbox}>
            <label htmlFor={templateName}>
              <VSCodeCheckbox
                id={templateName}
                name={templateName}
                value={templateName}
                onClick={handleTemplateClick}
                checked={selectedTemplates.includes(templateName)}
              ></VSCodeCheckbox>
              <span key={templateName}>{kebabToSentence(templateName)}</span>
            </label>
          </div>
        ))}
      <VSCodeButton className={styles.resetTemplatesButton} onClick={handleResetTemplates}>
        Reset to default
      </VSCodeButton>
    </>
  )
}
