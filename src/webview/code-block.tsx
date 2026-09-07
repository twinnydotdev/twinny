import { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
import { vs,vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"

import { ASSISTANT, EVENT_NAME } from "../common/constants"
import { LanguageType, Theme, ThemeType } from "../common/types"

import { useTheme } from "./hooks/useTheme"
import { emit } from "./messaging"
import { useToast } from "./toast"
import { getLanguageMatch } from "./utils"

import styles from "./styles/code-block.module.css"

interface CodeBlockProps {
  className?: string
  children?: ReactNode
  language: LanguageType | undefined
  theme: ThemeType
  role: string | undefined
}

export const CodeBlock = (props: CodeBlockProps) => {
  const { t } = useTranslation()
  const { children, language, className, role } = props
  const { Toast, showToast } = useToast()
  const theme = useTheme()
  const lang = getLanguageMatch(language, className)

  const handleCopy = async () => {
    const text = String(children).replace(/^\n/, "")
    await navigator.clipboard.writeText(text)
    showToast(t("copied-to-clipboard"))
  }

  const code = () => String(children).replace(/^\n/, "")

  const handleNewDocument = () => emit(EVENT_NAME.twinnyNewDocument, code())

  const handleAccept = () => emit(EVENT_NAME.twinnyAcceptSolution, code())

  const handleOpenDiff = () => emit(EVENT_NAME.twinnyOpenDiff, code())

  return (
    <div className={styles.codeBlock}>
      {Toast}
      <div className={styles.codeBar}>
        <span className={styles.codeLang}>{lang || ""}</span>
        {role === ASSISTANT && (
          <div className={styles.codeOptions}>
            <VSCodeButton
              title={t("accept-solution")}
              onClick={handleAccept}
              appearance="icon"
            >
              <span className="codicon codicon-check"></span>
            </VSCodeButton>
            <VSCodeButton
              title={t("copy-code")}
              onClick={handleCopy}
              appearance="icon"
            >
              <span className="codicon codicon-copy"></span>
            </VSCodeButton>
            <VSCodeButton
              title={t("new-document")}
              onClick={handleNewDocument}
              appearance="icon"
            >
              <span className="codicon codicon-new-file"></span>
            </VSCodeButton>
            <VSCodeButton
              title={t("open-diff")}
              onClick={handleOpenDiff}
              appearance="icon"
            >
              <span className="codicon codicon-diff"></span>
            </VSCodeButton>
          </div>
        )}
      </div>
      <SyntaxHighlighter
        children={String(children).trimStart().replace(/\n$/, "")}
        style={theme === Theme.Dark ? vscDarkPlus : vs}
        language={lang || "auto"}
      />
    </div>
  )
}

export default CodeBlock
