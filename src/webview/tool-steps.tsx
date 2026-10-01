import React, { useState } from "react"
import { useTranslation } from "react-i18next"
import cx from "classnames"

import { EVENT_NAME } from "../common/constants"
import { ToolStepView } from "../common/types"

import { emit } from "./messaging"
import { Code, ToolOutput } from "./tool-output"

import styles from "./styles/tool-steps.module.css"

const STATUS_ICON: Record<ToolStepView["status"], string> = {
  running: "codicon-loading codicon-modifier-spin",
  waiting: "codicon-terminal",
  done: "codicon-check",
  failed: "codicon-error",
  skipped: "codicon-circle-slash",
  stopped: "codicon-debug-stop"
}

/** `a \`b\` c` with the backticked parts set as code. */
const Summary = ({ text }: { text: string }) => (
  <>
    {text.split(/(`[^`]+`)/).map((part, i) =>
      part.startsWith("`") && part.endsWith("`") && part.length > 1 ? (
        <code key={i}>{part.slice(1, -1)}</code>
      ) : (
        <React.Fragment key={i}>{part}</React.Fragment>
      )
    )}
  </>
)

const Step = ({ step }: { step: ToolStepView }) => {
  const { t } = useTranslation()
  const waiting = step.status === "waiting"
  const [open, setOpen] = useState(false)
  const inspectable = !!step.output || !!Object.keys(step.args ?? {}).length
  const answer = (run: boolean) => emit(EVENT_NAME.twinnyToolApproval, { id: step.id, run })

  return (
    <li className={cx(styles.step, styles[step.status])}>
      <button
        type="button"
        className={styles.row}
        onClick={() => setOpen((prev) => !prev)}
        disabled={!inspectable || waiting}
        aria-expanded={open}
      >
        <span className={styles.glyph} aria-hidden="true">
          <span
            className={cx("codicon", waiting && step.approval === "change" ? "codicon-question" : STATUS_ICON[step.status])}
          />
        </span>
        <span className={styles.summary}>
          <Summary text={step.summary} />
        </span>
        {inspectable && !waiting && (
          <span
            className={cx("codicon", open ? "codicon-chevron-up" : "codicon-chevron-down", styles.chevron)}
            aria-hidden="true"
          />
        )}
      </button>
      {waiting && (
        <div className={styles.approval}>
          <div className={styles.approvalLabel}>
            {t(step.approval === "change" ? "tool-change-waiting" : "tool-command-waiting")}
          </div>
          <div className={styles.command}>
            {step.approval === "change" ? (
              <pre className={styles.output}>{step.command}</pre>
            ) : (
              <Code code={step.command ?? ""} language="bash" />
            )}
          </div>
          <div className={styles.actions}>
            <button type="button" className={styles.run} onClick={() => answer(true)}>
              <span className={cx("codicon", step.approval === "change" ? "codicon-check" : "codicon-play")} aria-hidden="true" />
              {t(step.approval === "change" ? "tool-apply" : "tool-run")}
            </button>
            <button type="button" className={styles.skip} onClick={() => answer(false)}>
              {t("tool-skip")}
            </button>
          </div>
        </div>
      )}
      {open && !waiting && (
        <div className={styles.detail}>
          <ToolOutput step={step} />
        </div>
      )}
    </li>
  )
}

/**
 * The tools the model used for a reply, a line each, above the reply. A
 * line opens to what the tool was given and what came back; a command
 * waiting for the user shows Run and Skip in place.
 */
export const ToolSteps = ({ steps }: { steps?: ToolStepView[] }) => {
  if (!steps?.length) return null
  return (
    <ol className={styles.panel}>
      {steps.map((step) => (
        <Step key={step.id} step={step} />
      ))}
    </ol>
  )
}

export default ToolSteps
