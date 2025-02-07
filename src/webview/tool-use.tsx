import React, { useCallback } from "react"
import ReactDiffViewer, { DiffMethod } from "react-diff-viewer-continued"
import { useTranslation } from "react-i18next"
import SyntaxHighlighter from "react-syntax-highlighter"
import { vs } from "react-syntax-highlighter/dist/esm/styles/hljs"
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism"

import { diffViewerStyles, EVENT_NAME } from "../common/constants"
import { ToolUse } from "../common/parse-assistant-message"
import { Theme } from "../common/types"

import { CollapsibleSection } from "./collapsible-section"
import { useTheme } from "./hooks"
import { parseDiffBlocks } from "./utils"

import styles from "./styles/tool-use.module.css"

interface ToolCardProps {
  toolUse: ToolUse
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any
export const ToolCard: React.FC<ToolCardProps> = ({ toolUse }) => {
  const { t } = useTranslation()
  const theme = useTheme()

  const showDiffViewer =
    (toolUse.name === "replace_in_file" && toolUse.params.diff) ||
    (toolUse.name === "write_to_file" && toolUse.params.content)

  const highlightSyntax = useCallback(
    (str: string) => (
      <SyntaxHighlighter
        language="javascript"
        style={theme === Theme.Dark ? vscDarkPlus : vs}
      >
        {str}
      </SyntaxHighlighter>
    ),
    [theme]
  )

  const AttemptCompletionCard = () => (
    <div className={`${styles.toolCard} ${styles.successCard}`}>
      <div className={styles.toolHeader}>
        <span className={styles.toolName}>{t(toolUse.name)}</span>
      </div>
      <div className={styles.toolBody}>
        {toolUse.params.result && (
          <div className={styles.paramRow}>
            <pre className={styles.paramValue}>{toolUse.params.result}</pre>
          </div>
        )}
        {toolUse.params.command && (
          <div className={styles.paramRow}>
            <pre className={styles.paramValue}>{toolUse.params.command}</pre>
          </div>
        )}
      </div>
    </div>
  )

  if (toolUse.name === "attempt_completion") {
    return <AttemptCompletionCard />
  }

  const handleOpenFile = useCallback((filePath: string | undefined) => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyOpenFile,
      data: filePath
    })
  }, [])

  return (
    <div className={styles.toolCard}>
      <div className={styles.toolHeader}>
        <span className={styles.toolName}>{t(toolUse.name)}</span>
        {toolUse.params.path && (
          <span
            onClick={() => handleOpenFile(toolUse.params.path)}
            className={styles.filePath}
          >
            {toolUse.params.path}
          </span>
        )}
      </div>
      <div className={styles.toolBody}>
        {showDiffViewer ? (
          <div className={styles.diffViewer}>
            {toolUse.name === "replace_in_file" && toolUse.params.diff ? (
              parseDiffBlocks(toolUse.params.diff).map((block, index) => (
                <CollapsibleSection title="Diff">
                  <ReactDiffViewer
                    key={index}
                    oldValue={block.oldText}
                    newValue={block.newText}
                    splitView={false}
                    useDarkTheme={theme === Theme.Dark}
                    compareMethod={DiffMethod.WORDS}
                    renderContent={highlightSyntax}
                    styles={diffViewerStyles}
                    hideLineNumbers
                    showDiffOnly
                  />
                </CollapsibleSection>
              ))
            ) : toolUse.name === "write_to_file" && toolUse.params.content ? (
              <CollapsibleSection title="Diff">
                <ReactDiffViewer
                  oldValue=""
                  newValue={toolUse.params.content.trim()}
                  splitView={false}
                  useDarkTheme={theme === Theme.Dark}
                  compareMethod={DiffMethod.WORDS}
                  renderContent={highlightSyntax}
                  styles={diffViewerStyles}
                  hideLineNumbers
                  showDiffOnly
                />
              </CollapsibleSection>
            ) : null}
          </div>
        ) : (
          <div className={styles.toolParams}>
            {Object.entries(toolUse.params).map(([key, value]) => (
              <div key={key} className={styles.paramRow}>
                <CollapsibleSection title={key} content={value} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default ToolCard
