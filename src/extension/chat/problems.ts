import { DiagnosticSeverity, languages, workspace } from "vscode"

/** Diagnostics beyond this add noise, not signal, to an @problems prompt. */
const MAX_PROBLEMS = 50

/**
 * The workspace's current diagnostics as one line of JSON each, errors first,
 * capped so one noisy file cannot flood the prompt.
 */
export const getProblemsContext = (): string => {
  const problems = workspace.textDocuments
    .flatMap((document) =>
      languages.getDiagnostics(document.uri).map((diagnostic) => ({
        severity: DiagnosticSeverity[diagnostic.severity],
        severityRank: diagnostic.severity,
        file: workspace.asRelativePath(document.uri),
        message: diagnostic.message,
        code: document.getText(diagnostic.range),
        line: document.lineAt(diagnostic.range.start.line).text,
        lineNumber: diagnostic.range.start.line + 1,
        character: diagnostic.range.start.character + 1,
        source: diagnostic.source,
        diagnosticCode: diagnostic.code
      }))
    )
    .sort((a, b) => a.severityRank - b.severityRank)

  const shown = problems.slice(0, MAX_PROBLEMS).map((problem) => {
    const { severityRank, ...rest } = problem
    void severityRank
    return JSON.stringify(rest)
  })

  if (problems.length > MAX_PROBLEMS) {
    shown.push(`... and ${problems.length - MAX_PROBLEMS} more problems`)
  }

  return shown.join("\n")
}
