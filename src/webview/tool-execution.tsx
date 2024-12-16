import { useTranslation } from "react-i18next"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"

import { Message, Tool } from "../common/types"

import styles from "./styles/tool-execution.module.css"

const StatusIcon = ({ status }: { status: string }) => {
  const iconClass = {
    pending: "codicon-circle-outline",
    running: "codicon-sync codicon-modifier-spin",
    success: "codicon-check",
    error: "codicon-error",
    rejected: "codicon-trash"
  }[status]

  return <span className={`codicon ${iconClass} ${styles.statusIcon}`} data-status={status} />
}

interface ToolExecutionProps {
  message: Message
  onRunTool?: (message: Message, tool: Tool) => void
  onRejectTool?: (message: Message, tool: Tool) => void
  onRunAllTools?: (message: Message) => void
}

export function ToolExecution({
  message,
  onRunTool,
  onRejectTool,
  onRunAllTools
}: ToolExecutionProps) {
  const { t } = useTranslation()
  const tools = message.tools || {}

  if (!Object.keys(tools)?.length) {
    return (
      <div className={styles.emptyState}>
        <span className="codicon codicon-debug-disconnect" />
        <p>{t("no-tools")}</p>
      </div>
    )
  }

  const handleRunAll = (message: Message) => {
    onRunAllTools?.(message)
  }

  const handleRunTool = (message: Message, tool: Tool) => {
    onRunTool?.(message, tool)
  }

  const handleRejectTool = (message: Message, tool: Tool) => {
    onRejectTool?.(message, tool)
  }

  const toolsByStatus = Object.values(tools).reduce((acc, tool) => {
    const status = tool.status || "pending"
    acc[status] = [...(acc[status] || []), tool]
    return acc
  }, {} as Record<string, Tool[]>)

  const runningCount = toolsByStatus.running?.length || 0
  const errorCount = toolsByStatus.error?.length || 0

  return (
    <div className={styles.root}>
      {message.content && (
        <p className={styles.messageContent}>
          {message.content}
        </p>
      )}
      <div className={styles.headerBar}>
        <div className={styles.headerTitle}>
          <span className="codicon codicon-tools" />
          {t("tools")}
          {runningCount > 0 && (
            <span className={styles.statusBadge} data-status="running">
              {runningCount}
            </span>
          )}
          {errorCount > 0 && (
            <span className={styles.statusBadge} data-status="error">
              {errorCount}
            </span>
          )}
        </div>
        <div className={styles.headerControls}>
          <VSCodeButton
            className={styles.runAllButton}
            disabled={runningCount > 0}
            onClick={() => handleRunAll(message)}
            title={t("run-all-tools")}
          >
            <span className="codicon codicon-play" />
            {t("run-all")}
          </VSCodeButton>
        </div>
      </div>

      <div className={styles.toolsList}>
        {["running", "error", "pending", "success", "rejected"].map((status) =>
          toolsByStatus[status]?.length ? (
            <div key={status} className={styles.toolGroup}>
              <div className={styles.toolGroupHeader} data-status={status}>
                <StatusIcon status={status} />
                {t(status)}
                <span className={styles.toolCount}>
                  {toolsByStatus[status].length}
                </span>
              </div>
              {toolsByStatus[status].map((tool) => (
                <div
                  key={tool.name}
                  className={styles.toolItem}
                  data-status={tool.status}
                >
                  <div className={styles.toolRow}>
                    <span className={styles.toolName}>{t(tool.name)}</span>
                    <div className={styles.toolActions}>
                      <VSCodeButton
                        onClick={() => handleRunTool(message, tool)}
                        className={styles.actionButton}
                        disabled={tool.status === "running"}
                        appearance="icon"
                        title={t("run-tool")}
                      >
                        <span className="codicon codicon-play" />
                      </VSCodeButton>
                      <VSCodeButton
                        onClick={() => handleRejectTool(message, tool)}
                        className={styles.actionButton}
                        disabled={
                          tool.status === "running" || tool.status === "success"
                        }
                        title={t("reject-tool")}
                        appearance="icon"
                      >
                        <span className="codicon codicon-trash" />
                      </VSCodeButton>
                    </div>
                  </div>

                  <div className={styles.toolContent}>
                    <div className={styles.argumentsContainer}>
                      {Object.entries(tool.arguments || {}).map(
                        ([key, value]) => (
                          <div key={key} className={styles.argumentRow}>
                            <div className={styles.argumentHeader}>
                              <span className={styles.argumentKey}>{key}</span>
                              <span className={styles.argumentType}>
                                {typeof value}
                              </span>
                            </div>
                            <div className={styles.argumentValue}>
                              {JSON.stringify(value, null, 2)}
                            </div>
                          </div>
                        )
                      )}
                    </div>
                    {!!tool.error && tool.status !== "success" && (
                      <div className={styles.toolError}>{tool.error}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : null
        )}
      </div>
    </div>
  )
}
