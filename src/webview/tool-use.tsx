import React, { useCallback } from "react"
import { useTranslation } from "react-i18next"
import { diffLines } from "diff"

import { EVENT_NAME } from "../common/constants"
import { ToolUse } from "../common/parse-assistant-message"

import { CollapsibleSection } from "./collapsible-section"
import DiffSummary from "./diff-summary"
import { parseDiffBlocks } from "./utils"

import styles from "./styles/tool-use.module.css"

interface ToolCardProps {
  toolUse: ToolUse
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any
export const ToolCard: React.FC<ToolCardProps> = ({ toolUse }) => {
  const { t } = useTranslation()

  const showDiffViewer =
    (toolUse.name === "apply_diff" && toolUse.params.diff) ||
    (toolUse.name === "write_to_file" && toolUse.params.content)

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
      </div>
      <div className={styles.toolBody}>
        {showDiffViewer ? (
          <div className={styles.diffViewer}>
            {toolUse.name === "apply_diff" && toolUse.params.diff ? (
              parseDiffBlocks(toolUse.params.diff).map((block) => {
                const diff = diffLines(block.oldText, block.newText);
                let addedLines = 0;
                let removedLines = 0;

                diff.forEach((part) => {
                  if (part.added) addedLines += part.count || 0;
                  if (part.removed) removedLines += part.count || 0;
                });

                return (
                  <>
                    <CollapsibleSection title={
                      <div className={styles.collapsibleTitle}>
                        <span onClick={(e) => {
                          e.stopPropagation()
                          handleOpenFile(toolUse.params.path)
                        }}>{toolUse.params.path}</span>
                        <span className={styles.diffSummary}>
                          <span className={styles.addedColor}>+{addedLines}</span>{" "}
                          <span className={styles.removedColor}>-{removedLines}</span>
                        </span>
                      </div>
                    }>
                      <DiffSummary diff={diff} />
                    </CollapsibleSection>
                  </>
                );
              })
            ) : toolUse.name === "write_to_file" && toolUse.params.content ? (
              <>
                {(() => {
                  const diff = diffLines("", toolUse.params.content.trim());
                  let addedLines = 0;
                  let removedLines = 0;

                  diff.forEach((part) => {
                    if (part.added) addedLines += part.count || 0;
                    if (part.removed) removedLines += part.count || 0;
                  });

                  return (
                    <>
                      <div className={styles.diffSummary}>
                        <span className={styles.addedColor}>+{addedLines}</span>{" "}
                        <span className={styles.removedColor}>-{removedLines}</span>
                      </div>
                      <DiffSummary diff={diff} />
                    </>
                  );
                })()}
              </>
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
