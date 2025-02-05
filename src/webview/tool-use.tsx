import React, { useCallback } from "react"
import ReactDiffViewer, { DiffMethod } from "react-diff-viewer-continued"
import { useTranslation } from "react-i18next"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
import { vs, vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism"

import { diffViewerStyles, EVENT_NAME } from "../common/constants"
import { ToolUse } from "../common/parse-assistant-message"
import { Theme } from "../common/types"

import { useTheme } from "./hooks"
import { parseDiffBlocks } from "./utils"

import styles from "./styles/tool-use.module.css"

interface ToolCardProps {
  toolUse: ToolUse
  onAccept?: (tool: ToolUse) => void
  onReject?: (tool: ToolUse) => void
  onRun?: (tool: ToolUse) => void
  onUpdate?: (id: string, status: "accepted" | "rejected" | "running") => void
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any
export const ToolCard: React.FC<ToolCardProps> = ({ toolUse }) => {
  const { t } = useTranslation()
  const theme = useTheme()

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
              ))
            ) : toolUse.name === "write_to_file" && toolUse.params.content ? (
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
            ) : null}
          </div>
        ) : (
          <div className={styles.toolParams}>
            {Object.entries(toolUse.params).map(([key, value]) => (
              <div key={key} className={styles.paramRow}>
                <span className={styles.paramName}>{t(key)}:</span>
                <span className={styles.paramValue}>{value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default ToolCard
