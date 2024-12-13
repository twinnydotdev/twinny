import { useTranslation } from "react-i18next"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"

import { Message, Tool } from "../common/types"

import styles from "./styles/tool-execution.module.css"

const StatusIcon = ({ status }: { status: string }) => {
  const iconClass = {
    pending: "codicon-circle-outline",
    running: "codicon-sync codicon-modifier-spin",
    success: "codicon-pass",
    error: "codicon-error"
  }[status]

  return <span className={`codicon ${iconClass} ${styles.statusIcon}`} />
}

interface ToolExecutionProps {
  message: Message
  onRunTool?: (toolName: string) => void
  onRejectTool?: (toolName: string) => void
}

export default function ToolExecution({
  message,
  onRunTool,
  onRejectTool
}: ToolExecutionProps) {
  const { t } = useTranslation()
  const tools = message.tools || {}

  if (!Object.keys(tools)?.length) {
    return null
  }

  const handleRunAll = () => {
    Object.values(tools).forEach((tool) => {
      if (tool.status !== "running") {
        handleRunTool(tool)
      }
    })
  }

  const handleRunTool = (tool: Tool) => {
    onRunTool?.(tool.name)
  }

  const handleRejectTool = (tool: Tool) => {
    onRejectTool?.(tool.name)
  }

  const toolsByStatus = Object.values(tools).reduce((acc, tool) => {
    const status = tool.status || "pending"
    acc[status] = [...(acc[status] || []), tool]
    return acc
  }, {} as Record<string, (typeof tools)[keyof typeof tools][]>)

  const isAnyToolRunning = Object.values(tools).some(
    (tool) => tool.status === "running"
  )

  const runningCount = toolsByStatus.running?.length || 0
  const errorCount = toolsByStatus.error?.length || 0

  return (
    <div className={styles.root}>
      <div className={styles.headerBar}>
        <div className={styles.headerTitle}>
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
            onClick={handleRunAll}
            disabled={isAnyToolRunning}
          >
            <span className="codicon codicon-play" />
            {t("run-all")}
          </VSCodeButton>
        </div>
      </div>

      <div className={styles.toolsList}>
        {["running", "error", "pending", "success"].map((status) =>
          toolsByStatus[status]?.length ? (
            <div key={status} className={styles.toolGroup}>
              <div className={styles.toolGroupHeader}>
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
                        onClick={() => handleRunTool(tool)}
                        className={styles.actionButton}
                        disabled={tool.status === "running"}
                        appearance="icon"
                      >
                        <span className="codicon codicon-play" />
                      </VSCodeButton>
                      <VSCodeButton
                        onClick={() => handleRejectTool(tool)}
                        className={styles.actionButton}
                        disabled={tool.status === "running"}
                        title={t("remove")}
                        appearance="icon"
                      >
                        <span className="codicon codicon-trash" />
                      </VSCodeButton>
                    </div>
                  </div>

                  <div className={styles.toolContent}>
                    {Object.entries(tool.arguments).map(([key, value]) => (
                      <div key={key} className={styles.argumentRow}>
                        <div className={styles.argumentHeader}>
                          <span className={styles.argumentKey}>{key}</span>
                          <span className={styles.argumentType}>
                            {typeof value}
                          </span>
                        </div>
                        <pre className={styles.argumentValue}>
                          {typeof value === "boolean" ? (
                            <span>{value ? t("true") : t("false")}</span>
                          ) : (
                            value
                          )}
                        </pre>
                      </div>
                    ))}
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
