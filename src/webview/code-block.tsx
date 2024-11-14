import React, { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
import { vs,vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"

import { ASSISTANT, EVENT_NAME } from "../common/constants"
import { LanguageType, Theme, ThemeType } from "../common/types"

import { getLanguageMatch } from "./utils"

import styles from "./styles/index.module.css"

interface CodeBlockProps {
  className?: string
  children?: ReactNode
  language: LanguageType | undefined
  theme: ThemeType
  role: string | undefined
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const CodeBlock = (props: CodeBlockProps) => {
  const { t } = useTranslation()
  const { children, language, className, theme, role } = props

  const lang = getLanguageMatch(language, className)

  const handleCopy = () => {
    const text = String(children).replace(/^\n/, "")
    navigator.clipboard.writeText(text)
  }

  const handleNewDocument = () => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyNewDocument,
      data: String(children).replace(/^\n/, ""),
    })
  }

  const handleAccept = () => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyAcceptSolution,
      data: String(children).replace(/^\n/, ""),
    })
  }

  const handleOpenDiff = () => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyOpenDiff,
      data: String(children).replace(/^\n/, ""),
    })
  }

  return (
    <>
      <SyntaxHighlighter
        children={String(children).trimStart().replace(/\n$/, "")}
        style={theme === Theme.Dark ? vscDarkPlus : vs}
        language={lang || "auto"}
      />
      {role === ASSISTANT && (
        <>
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
        </>
      )}
    </>
  )
}

export default React.memo(CodeBlock)
