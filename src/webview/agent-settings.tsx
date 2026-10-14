import React, { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import cx from "classnames"

import { EVENT_NAME, GLOBAL_STORAGE_KEY } from "../common/constants"
import type { TeamAgentPolicy } from "../common/team"

import { StorageType, useStorageContext } from "./hooks/useStorageContext"
import { bridge, emit } from "./messaging"

import styles from "./styles/agent-settings.module.css"

/** Steps a reply may take, offered as presets; 12 is the default. */
export const STEP_PRESETS = [8, 12, 20, 30]

/** The presets, with the user's own number among them when they set another in their settings. */
const stepChoices = (current: number) =>
  Number.isFinite(current) && !STEP_PRESETS.includes(current)
    ? [...STEP_PRESETS, current].sort((a, b) => a - b)
    : STEP_PRESETS

/**
 * A `twinny.*` setting, read once and written back to the user's
 * settings; the panel shows a change at once rather than waiting for the
 * round trip.
 */
const useSetting = <T,>(key: string, fallback: T): [T, (value: T) => void] => {
  const [value, setValue] = useState<T>(fallback)
  useEffect(() => {
    bridge
      .request(EVENT_NAME.twinnyGetConfigValue, { key })
      .then((answer) => answer?.value !== undefined && setValue(answer.value as T))
      .catch(() => undefined)
  }, [key])
  const write = useCallback(
    (next: T) => {
      setValue(next)
      emit(EVENT_NAME.twinnySetConfigValue, { key, value: next })
    },
    [key]
  )
  return [value, write]
}

interface Choice<T> {
  value: T
  label: string
  title?: string
  /** Why it cannot be chosen, when it cannot. */
  locked?: string
}

const Choices = <T extends string | number>({
  label,
  value,
  choices,
  onChange
}: {
  label: string
  value: T
  choices: Choice<T>[]
  onChange: (value: T) => void
}) => (
  <div className={styles.row} role="radiogroup" aria-label={label}>
    <span className={styles.label}>{label}</span>
    <span className={styles.choices}>
      {choices.map((choice) => (
        <button
          key={String(choice.value)}
          type="button"
          role="radio"
          aria-checked={choice.value === value}
          disabled={!!choice.locked}
          className={cx(styles.choice, { [styles.chosen]: choice.value === value })}
          title={choice.locked ?? choice.title}
          onClick={() => choice.value !== value && onChange(choice.value)}
        >
          {choice.label}
        </button>
      ))}
    </span>
  </div>
)

interface AgentSettingsProps {
  /** What the connected team's policy allows, if it sets agent rules. */
  team?: TeamAgentPolicy
  autoRun: boolean
  setAutoRun: (on: boolean) => void
  onClose: () => void
}

/**
 * What agent mode may do, from the composer: how changes land, whether
 * commands ask, run or are off, where they run, and how many steps a reply
 * may take. Each is a setting the user has (`twinny.chatTools…`), written
 * back to their settings; a rule the team sets shows, and cannot be
 * loosened here.
 */
export const AgentSettings = ({ team, autoRun, setAutoRun, onClose }: AgentSettingsProps) => {
  const { t } = useTranslation()
  const panel = useRef<HTMLDivElement>(null)
  const [edits, setEdits] = useSetting<string>("chatToolsEdits", "apply")
  const [commands, setCommands] = useSetting<string>("chatToolsCommands", "ask")
  const [runIn, setRunIn] = useSetting<string>("chatToolsCommandsRunIn", "background")
  const [maxSteps, setMaxSteps] = useSetting<number>("chatToolsMaxSteps", 12)
  const { context: always, setContext: setAlways } = useStorageContext<string[]>(
    StorageType.Global,
    GLOBAL_STORAGE_KEY.alwaysRunCommands
  )
  const { context: alwaysMcp, setContext: setAlwaysMcp } = useStorageContext<string[]>(
    StorageType.Global,
    GLOBAL_STORAGE_KEY.alwaysRunMcpTools
  )
  const [mcpServers] = useSetting<Record<string, unknown>>("chatToolsMcpServers", {})
  const servers = Object.keys(mcpServers ?? {}).length

  // Escape or a click elsewhere puts it away.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.stopPropagation()
      onClose()
    }
    const onPointer = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!panel.current?.contains(target) && !target?.closest("[data-agent-settings-toggle]")) onClose()
    }
    window.addEventListener("keydown", onKey, true)
    window.addEventListener("mousedown", onPointer)
    return () => {
      window.removeEventListener("keydown", onKey, true)
      window.removeEventListener("mousedown", onPointer)
    }
  }, [onClose])

  const teamSays = t("agent-settings-team")
  const commandsOff = team?.commands === "off" || commands === "off"
  const commandMode = commandsOff ? "off" : autoRun && !team?.commands ? "run" : "ask"
  const kept = always?.length ?? 0
  const keptMcp = alwaysMcp?.length ?? 0

  const chooseCommands = (mode: string) => {
    if (mode === "off") {
      setCommands("off")
      return
    }
    // The composer's auto-run switch and the setting say the same thing.
    setCommands(mode === "run" ? "allow" : "ask")
    setAutoRun(mode === "run")
  }

  return (
    <div ref={panel} className={styles.panel} role="dialog" aria-label={t("agent-settings-title")}>
      <div className={styles.head}>
        <span>{t("agent-settings-title")}</span>
        <button type="button" className={styles.close} onClick={onClose} aria-label={t("agent-settings-close")}>
          <span className="codicon codicon-close" aria-hidden="true" />
        </button>
      </div>
      <Choices
        label={t("agent-settings-edits")}
        value={team?.edits === "review" ? "review" : edits}
        onChange={setEdits}
        choices={[
          {
            value: "apply",
            label: t("agent-settings-edits-apply"),
            title: t("agent-settings-edits-apply-title"),
            ...(team?.edits === "review" ? { locked: teamSays } : {})
          },
          { value: "review", label: t("agent-settings-edits-review"), title: t("agent-settings-edits-review-title") }
        ]}
      />
      <Choices
        label={t("agent-settings-commands")}
        value={commandMode}
        onChange={chooseCommands}
        choices={[
          {
            value: "ask",
            label: t("agent-settings-commands-ask"),
            title: t("agent-settings-commands-ask-title"),
            ...(team?.commands === "off" ? { locked: teamSays } : {})
          },
          {
            value: "run",
            label: t("agent-settings-commands-run"),
            title: t("agent-settings-commands-run-title"),
            ...(team?.commands ? { locked: teamSays } : {})
          },
          { value: "off", label: t("agent-settings-commands-off"), title: t("agent-settings-commands-off-title") }
        ]}
      />
      {!commandsOff && (
        <Choices
          label={t("agent-settings-run-in")}
          value={runIn}
          onChange={setRunIn}
          choices={[
            { value: "background", label: t("agent-settings-run-in-background"), title: t("agent-settings-run-in-background-title") },
            { value: "terminal", label: t("agent-settings-run-in-terminal"), title: t("agent-settings-run-in-terminal-title") }
          ]}
        />
      )}
      <Choices
        label={t("agent-settings-steps")}
        value={maxSteps}
        onChange={setMaxSteps}
        choices={stepChoices(maxSteps).map((steps) => ({
          value: steps,
          label: String(steps),
          title: t("agent-settings-steps-title", { count: steps })
        }))}
      />
      {team?.commands !== "off" && team?.mcp !== "off" && (
        <div className={styles.row}>
          <span className={styles.label} title={t("agent-settings-mcp-title")}>
            {t("agent-settings-mcp", { count: servers })}
          </span>
          <button type="button" className={styles.link} onClick={() => emit(EVENT_NAME.twinnyOpenAgentSettings)}>
            {t(servers ? "agent-settings-mcp-configure" : "agent-settings-mcp-add")}
          </button>
        </div>
      )}
      {kept + keptMcp > 0 && !team?.commands && (
        <div className={styles.row}>
          <span className={styles.label}>
            {[
              ...(kept ? [t("agent-settings-always", { count: kept })] : []),
              ...(keptMcp ? [t("agent-settings-always-mcp", { count: keptMcp })] : [])
            ].join(" · ")}
          </span>
          <button
            type="button"
            className={styles.link}
            onClick={() => {
              if (kept) setAlways([])
              if (keptMcp) setAlwaysMcp([])
            }}
            title={t("agent-settings-forget-title")}
          >
            {t("agent-settings-forget")}
          </button>
        </div>
      )}
      <button type="button" className={styles.more} onClick={() => emit(EVENT_NAME.twinnyOpenAgentSettings)}>
        {t("agent-settings-more")}
      </button>
    </div>
  )
}

export default AgentSettings
