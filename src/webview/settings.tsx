import { VSCodeButton, VSCodeCheckbox } from '@vscode/webview-ui-toolkit/react'
import { useDrive, useTemplates, useWorkSpaceContext } from './hooks'
import {
  DEFAULT_ACTION_TEMPLATES,
  EVENT_NAME,
  WORKSPACE_STORAGE_KEY
} from '../common/constants'
import { useEffect, useState } from 'react'
import { kebabToSentence } from './utils'

import styles from './index.module.css'
import { ClientMessage } from '../common/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any
export const Settings = () => {
  const { templates, saveTemplates } = useTemplates()
  const { drive } = useDrive()
  const [selectedTemplates, setSelectedTemplates] = useState<string[]>([])
  const selectedTemplatesContext =
    useWorkSpaceContext<string[]>(WORKSPACE_STORAGE_KEY.selectedTemplates) || []

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
    }
    setSelectedTemplates(DEFAULT_ACTION_TEMPLATES)
  }, [selectedTemplatesContext.length])

  const handleEmbedDocuments = () => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyEmbedDocuments
    } as ClientMessage<string[]>)
  }

  const handleNewP2PKey = () => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyOpenDrive
    } as ClientMessage<string[]>)
  }

  return (
    <>
      <h3>Template settings</h3>
      <p>Select the templates you want to use in the chat interface.</p>
      {templates &&
        templates.map((templateName: string) => (
          <div key={templateName} className={styles.templateCheckbox}>
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
      <VSCodeButton
        className={styles.resetTemplatesButton}
        onClick={handleResetTemplates}
      >
        Reset to default
      </VSCodeButton>
      <h4>Embedding options</h4>
      <p>Click the button below to embed all documents in this workspace.</p>
      <VSCodeButton
        onClick={handleEmbedDocuments}
        className={styles.embedDocumentsButton}
      >
        Embed Documents
      </VSCodeButton>
      <h4>Generate P2P Key</h4>
      <p>Click the button below to generate a P2P Beam.</p>
      <VSCodeButton
        onClick={handleNewP2PKey}
        className={styles.embedDocumentsButton}
      >
        Generate beam
      </VSCodeButton>
      {!!drive && (
        <>
          <h4>Your P2P Key</h4>
          <p>This is your P2P Key. Share it with others to connect.</p>
          <small>{drive.key}</small>
          <br />
          <small>{drive.discoveryKey}</small>
        </>
      )}
    </>
  )
}
