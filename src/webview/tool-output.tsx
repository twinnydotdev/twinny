import React from "react"
import { useTranslation } from "react-i18next"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
import { vs, vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism"
import cx from "classnames"

import { EVENT_NAME } from "../common/constants"
import {
  classifyDiff,
  DiffLine,
  groupByFile,
  languageForPath,
  parseCommandRun,
  parseLocatedLines,
  parseReadFile,
  parseSearchHits,
  replacementDiff
} from "../common/tool-output"
import { Theme, ToolStepView } from "../common/types"

import { useTheme } from "./hooks/useTheme"
import { emit } from "./messaging"

import styles from "./styles/tool-steps.module.css"

interface CodeProps {
  code: string
  language: string
  /** 1-based; line numbers are shown when set. */
  startLine?: number
}

/** Room for a line number and the space after it. */
const GUTTER = "3.6em"

/** Code highlighted as in the chat's code blocks, sized for a step. */
export const Code = ({ code, language, startLine }: CodeProps) => {
  const theme = useTheme()
  const numbered = startLine !== undefined
  return (
    <SyntaxHighlighter
      language={language}
      style={theme === Theme.Dark ? vscDarkPlus : vs}
      showLineNumbers={numbered}
      startingLineNumber={startLine}
      wrapLongLines
      className={styles.code}
      customStyle={{ margin: 0, padding: "6px 8px", background: "var(--tw-surface)", fontSize: "inherit" }}
      codeTagProps={{ style: { fontFamily: "var(--tw-font)", fontSize: "inherit" } }}
      // With numbers and wrapping both on, the highlighter makes each line a
      // flex row, so every token becomes a column and wraps on its own. A
      // line stays text instead, its number hung in the left margin.
      lineProps={numbered ? { style: { display: "block", paddingLeft: GUTTER } } : undefined}
      lineNumberStyle={{
        display: "inline-block",
        boxSizing: "border-box",
        width: GUTTER,
        marginLeft: `-${GUTTER}`,
        paddingRight: "1em",
        textAlign: "right",
        opacity: 0.45,
        userSelect: "none"
      }}
    >
      {code}
    </SyntaxHighlighter>
  )
}

/** A unified diff, a line each, coloured like the editor's diff view. */
const Diff = ({ lines }: { lines: DiffLine[] }) => (
  <pre className={styles.diff}>
    {lines.map((line, i) => (
      <div key={i} className={cx(styles.diffLine, styles[`diff-${line.kind}`])}>
        {line.text || " "}
      </div>
    ))}
  </pre>
)

interface FileLinkProps {
  path: string
  /** 1-based. */
  line?: number
  endLine?: number
  /** Shown in place of the path and line, e.g. the line number alone under its file. */
  label?: string
}

/** A path that opens the file, at the line when there is one. */
const FileLink = ({ path, line, endLine, label }: FileLinkProps) => (
  <button
    type="button"
    className={styles.fileLink}
    title={line !== undefined ? `${path}:${line}` : path}
    onClick={() =>
      emit(EVENT_NAME.twinnyOpenFile, {
        path,
        ...(line !== undefined ? { startLine: line - 1, endLine: (endLine ?? line) - 1 } : {})
      })
    }
  >
    {label ?? (
      <>
        {path}
        {line !== undefined && (
          <span className={styles.fileLine}>:{line}{endLine && endLine !== line ? `–${endLine}` : ""}</span>
        )}
      </>
    )}
  </button>
)

const Label = ({ children }: { children: React.ReactNode }) => (
  <div className={styles.detailLabel}>{children}</div>
)

const Plain = ({ text }: { text: string }) => <pre className={styles.output}>{text}</pre>

const Args = ({ args }: { args: Record<string, string> }) => {
  const entries = Object.entries(args)
  if (!entries.length) return null
  return (
    <dl className={styles.args}>
      {entries.map(([name, value]) => (
        <React.Fragment key={name}>
          <dt>{name}</dt>
          <dd>{value.includes("\n") ? <pre>{value}</pre> : <code>{value}</code>}</dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

/** What a step was given and what came back, shown the way that suits the tool. */
export const ToolOutput = ({ step }: { step: ToolStepView }) => {
  const { t } = useTranslation()
  const args = step.args ?? {}
  const output = step.output ?? ""

  switch (step.name) {
    case "read_file": {
      const slice = parseReadFile(output)
      if (!slice) break
      const endLine = slice.startLine + Math.max(0, slice.code.split("\n").length - 1)
      return (
        <>
          <Label>
            <FileLink path={slice.path} line={slice.startLine} endLine={endLine} />
          </Label>
          <Code code={slice.code} language={languageForPath(slice.path)} startLine={slice.startLine} />
          {slice.note && <div className={styles.note}>{slice.note}</div>}
        </>
      )
    }
    case "edit_file": {
      if (args.find === undefined || args.replace === undefined) break
      return (
        <>
          <Label>{args.path ? <FileLink path={args.path} /> : t("tool-input")}</Label>
          <Diff lines={replacementDiff(args.find, args.replace)} />
          {output && <div className={styles.note}>{output}</div>}
        </>
      )
    }
    case "create_file": {
      if (args.content === undefined) break
      return (
        <>
          <Label>{args.path ? <FileLink path={args.path} /> : t("tool-input")}</Label>
          <Code code={args.content.replace(/\n$/, "")} language={languageForPath(args.path ?? "")} startLine={1} />
          {output && <div className={styles.note}>{output}</div>}
        </>
      )
    }
    case "run_command":
    case "git": {
      const run = parseCommandRun(output)
      if (!run) break
      return (
        <>
          <Code code={run.command} language="bash" />
          <div className={styles.note}>{run.status}</div>
          {run.output.trim() &&
            (run.isDiff ? <Diff lines={classifyDiff(run.output)} /> : <Plain text={run.output.replace(/\n$/, "")} />)}
        </>
      )
    }
    case "search_code": {
      const hits = parseSearchHits(output)
      if (!hits.length) break
      return (
        <>
          {hits.map((hit) => (
            <div key={`${hit.path}:${hit.startLine}`} className={styles.hit}>
              <Label>
                <FileLink path={hit.path} line={hit.startLine} endLine={hit.endLine} />
                <span className={styles.relevance}>{hit.relevance}</span>
              </Label>
              {hit.code ? (
                <Code code={hit.code} language={languageForPath(hit.path)} startLine={hit.startLine} />
              ) : (
                <div className={styles.note}>{t("tool-hit-not-shown")}</div>
              )}
            </div>
          ))}
        </>
      )
    }
    case "find_files": {
      const files = output.split("\n").filter((line) => line.trim() && !line.startsWith("… ") && line !== "No files match.")
      if (!files.length) break
      return (
        <>
          <Args args={args} />
          <div className={styles.located}>
            {files.map((file) => (
              <div key={file}>
                <FileLink path={file} />
              </div>
            ))}
          </div>
          {output.split("\n").filter((line) => line.startsWith("… ")).map((line) => (
            <div key={line} className={styles.note}>{line.slice(2)}</div>
          ))}
        </>
      )
    }
    case "grep":
    case "find_symbol":
    case "diagnostics":
    case "find_references":
    case "go_to_definition": {
      const lines = parseLocatedLines(output)
      if (!lines) break
      const extra = output.split("\n").filter((line) => line.startsWith("… "))
      return (
        <>
          <Args args={args} />
          <div className={styles.located}>
            {groupByFile(lines).map((group, g) => (
              <div key={`${group.path}:${g}`} className={styles.locatedFile}>
                <FileLink path={group.path} />
                {group.lines.map((line, i) => (
                  <div key={i} className={cx(styles.locatedLine, line.context && styles.locatedContext)}>
                    <FileLink path={line.path} line={line.line} label={String(line.line)} />
                    <code>{line.text}</code>
                  </div>
                ))}
              </div>
            ))}
          </div>
          {extra.map((line) => (
            <div key={line} className={styles.note}>{line.slice(2)}</div>
          ))}
        </>
      )
    }
  }

  return (
    <>
      {!!Object.keys(args).length && (
        <>
          <Label>{t("tool-input")}</Label>
          <Args args={args} />
        </>
      )}
      {output && (
        <>
          <Label>{t("tool-output")}</Label>
          <Plain text={output} />
        </>
      )}
    </>
  )
}

export default ToolOutput
