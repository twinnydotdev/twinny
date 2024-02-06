import { VSCodeCheckbox } from '@vscode/webview-ui-toolkit/react'
import { useTemplates, useWorkSpaceContext } from './hooks'
import { DEFAULT_TEMPLATES, MESSAGE_KEY } from '../constants'
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

  useEffect(() => {
    if (selectedTemplatesContext !== undefined) {
      return setSelectedTemplates(selectedTemplatesContext)
    } else {
      setSelectedTemplates(DEFAULT_TEMPLATES)
    }
  }, [selectedTemplatesContext])

  return (
    <>
      <h3>Set prompt templates</h3>
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
    </>
  )
}
