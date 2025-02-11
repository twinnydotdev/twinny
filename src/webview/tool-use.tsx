import React, { useCallback } from "react"
import { useTranslation } from "react-i18next"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { diffLines } from "diff"

import { EVENT_NAME } from "../common/constants"
import { ToolUse } from "../common/tool-parser"

import { CollapsibleSection } from "./collapsible-section"
import DiffSummary from "./diff-summary"
import { parseDiffBlocks } from "./utils"

import styles from "./styles/tool-use.module.css"

interface ToolCardProps {
  toolUse: ToolUse
  onDiff: (toolUse: ToolUse) => void
  onRun: (toolUse: ToolUse) => void
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any
export const ToolCard: React.FC<ToolCardProps> = ({ toolUse, onDiff, onRun }) => {
  const { t } = useTranslation()

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
      <div className={styles.toolBody}>
        {toolUse.name === "apply_diff" && toolUse.params.diff && (
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
                    <div>
                      <span>
                        Edit file {" "}
                      </span>
                      <span className={styles.fileLink} onClick={(e) => {
                        e.stopPropagation()
                        handleOpenFile(toolUse.params.path)
                      }}>{toolUse.params.path}</span>
                      <span className={styles.diffSummary}>
                        <span className={styles.addedColor}>+{addedLines}</span>{" "}
                        <span className={styles.removedColor}>-{removedLines}</span>
                      </span>
                    </div>
                    <div>
                      <VSCodeButton
                        onClick={(e) => {
                          e.stopPropagation()
                          onDiff(toolUse)
                        }}
                        appearance="icon"
                        title="View diff"
                      >
                        <span className="codicon codicon-diff" />
                      </VSCodeButton>
                      <VSCodeButton
                        onClick={(e) => {
                          e.stopPropagation()
                          onRun(toolUse)
                        }}
                        appearance="icon"
                        title="Apply diff"
                      >
                        <span className="codicon codicon-check" />
                      </VSCodeButton>
                    </div>
                  </div>
                }>
                  <DiffSummary diff={diff} />
                </CollapsibleSection>
              </>
            );
          })
        )}
        {toolUse.name === "write_to_file" && toolUse.params.content && (
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
        )}
        {toolUse.name === "read_file" && (
          <>
            <CollapsibleSection title={
              <div className={styles.collapsibleTitle}>
                <div>
                  <span>
                    Read file{" "}
                  </span>
                  <span className={styles.fileLink} onClick={(e) => {
                    e.stopPropagation()
                    handleOpenFile(toolUse.params.path)
                  }}>{toolUse.params.path}</span>
                </div>
                <div>
                  <VSCodeButton
                    onClick={(e) => {
                      e.stopPropagation()
                      onRun(toolUse)
                    }}
                    appearance="icon"
                    title="Read File"
                  >
                    <span className="codicon codicon-check" />
                  </VSCodeButton>
                </div>
              </div>
            }>
              Twinny wants to read a file.
            </CollapsibleSection>
          </>
        )}
        {toolUse.name === "ask_followup_question" && (
          <>
            <CollapsibleSection title={
              <div className={styles.collapsibleTitle}>
                <div>
                  <span>
                    Followup question:{" "}
                  </span>
                </div>
              </div>
            }>
              {toolUse.params.question}
            </CollapsibleSection>
          </>
        )}
        {toolUse.name === "read_file_result" && (
          <>
            <CollapsibleSection title={
              <div className={styles.collapsibleTitle}>
                <div>
                  <span>
                    File read succesful {" "}
                  </span>
                  <span className={styles.fileLink} onClick={(e) => {
                    e.stopPropagation()
                    handleOpenFile(toolUse.params.path)
                  }}>{toolUse.params.path}</span>
                </div>
              </div>
            }>
              <SyntaxHighlighter
                language="typescript"
                style={vscDarkPlus}
                wrapLines={true}
              >
                 {toolUse.params.content || ""}
              </SyntaxHighlighter>
            </CollapsibleSection>
          </>
        )}
        {toolUse.name === "apply_diff_result" && (
          <>
            <CollapsibleSection title={
              <div className={styles.collapsibleTitle}>
                <div>
                  <span className={styles.addedColor}>
                    Change applied succesfully {" "}
                  </span>
                  <span className={styles.fileLink} onClick={(e) => {
                    e.stopPropagation()
                    handleOpenFile(toolUse.params.path)
                  }}>{toolUse.params.path}</span>
                </div>
              </div>
            }>
              <SyntaxHighlighter
                language="typescript"
                style={vscDarkPlus}
                wrapLines={true}
              >
                 {toolUse.params.content || ""}
              </SyntaxHighlighter>
            </CollapsibleSection>
          </>
        )}
      </div>
    </div>
  )
}

export default ToolCard
