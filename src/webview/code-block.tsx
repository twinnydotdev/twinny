import { Children, isValidElement, ReactNode, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
import { vs, vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism"

import { ASSISTANT, EVENT_NAME } from "../common/constants"
import { LanguageType, Theme } from "../common/types"

import { useTheme } from "./hooks/useTheme"
import { emit } from "./messaging"
import { getLanguageMatch } from "./utils"

import styles from "./styles/code-block.module.css"

interface CodeBlockProps {
  className?: string
  children?: ReactNode
  language?: LanguageType
  role: string | undefined
}

const COPIED_MS = 1500

/** Fence names whose contents are a command to run, not a file to edit. */
const SHELL_FENCES = new Set([
  "bash",
  "sh",
  "shell",
  "shellscript",
  "zsh",
  "fish",
  "console",
  "terminal",
  "powershell",
  "pwsh",
  "ps1",
  "cmd",
  "bat",
  "batch"
])

/*
 * react-markdown hands the <code> children as a string most of the time, but a
 * fenced block that contains inline html or entities arrives as an array of
 * nodes. String(array) would join them with commas, so flatten by hand.
 */
const toText = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(toText).join("")
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return toText(node.props.children)
  }
  return Children.toArray(node).map(toText).join("")
}

interface ActionProps {
  icon: string
  label: string
  title: string
  onClick: () => void
  active?: boolean
}

/*
 * A plain <button>, not a toolkit web component: it lays out the same in
 * every host, and an icon with a word beside it beats a bare glyph nobody
 * can decode at 14px.
 */
const Action = ({ icon, label, title, onClick, active }: ActionProps) => (
  <button
    type="button"
    className={active ? `${styles.action} ${styles.actionActive}` : styles.action}
    title={title}
    aria-label={title}
    onClick={onClick}
  >
    <span className={`codicon codicon-${icon}`} aria-hidden="true" />
    <span className={styles.actionLabel}>{label}</span>
  </button>
)

export const CodeBlock = (props: CodeBlockProps) => {
  const { t } = useTranslation()
  const { children, language, className, role } = props
  const theme = useTheme()
  const lang = getLanguageMatch(language, className)
  const [copied, setCopied] = useState(false)

  const code = useMemo(
    () => toText(children).replace(/^\n+/, "").replace(/\n$/, ""),
    [children]
  )

  const isShell = !!lang && SHELL_FENCES.has(lang.toLowerCase())
  const isAssistant = role === ASSISTANT

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
    } catch {
      return
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), COPIED_MS)
  }

  const handleApply = () => emit(EVENT_NAME.twinnyAcceptSolution, code)

  const handleNewDocument = () =>
    emit(EVENT_NAME.twinnyNewDocument, { content: code, language: lang })

  const handleTerminal = () => emit(EVENT_NAME.twinnyRunInTerminal, code)

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeBar}>
        <span className={styles.codeLang}>{lang || t("code")}</span>
        <div className={styles.codeOptions}>
          {isAssistant && isShell && (
            <Action
              icon="terminal"
              label={t("action-terminal")}
              title={t("run-in-terminal")}
              onClick={handleTerminal}
            />
          )}
          {isAssistant && !isShell && (
            <Action
              icon="diff"
              label={t("action-apply")}
              title={t("apply-code")}
              onClick={handleApply}
            />
          )}
          <Action
            icon={copied ? "check" : "copy"}
            label={copied ? t("action-copied") : t("action-copy")}
            title={copied ? t("copied-to-clipboard") : t("copy-code")}
            onClick={handleCopy}
            active={copied}
          />
          {isAssistant && (
            <Action
              icon="new-file"
              label={t("action-new-file")}
              title={t("new-document")}
              onClick={handleNewDocument}
            />
          )}
          <span className={styles.srOnly} role="status" aria-live="polite">
            {copied ? t("copied-to-clipboard") : ""}
          </span>
        </div>
      </div>
      <SyntaxHighlighter
        children={code}
        style={theme === Theme.Dark ? vscDarkPlus : vs}
        language={lang || "text"}
        PreTag="pre"
      />
    </div>
  )
}

export default CodeBlock
