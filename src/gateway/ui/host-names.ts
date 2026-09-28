/**
 * Who the developer is on a host, as VS Code knew when it opened the page
 * (`#…&github=<login>` on a sign-in link). Kept in this tab only, and only
 * ever used to fill in an empty name once; a name already set wins.
 */
import { GITHUB_LOGIN_PATTERN } from "../../protocol/types"

const KEY = "twinny-server.host-names"

type Hosts = { github?: string }

const read = (): Hosts => {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY) ?? "{}") as Hosts
    return value && typeof value === "object" ? value : {}
  } catch {
    return {}
  }
}

/** Remembers the names a sign-in link carried. */
export const rememberHostNames = (params: URLSearchParams): void => {
  const github = params.get("github")
  if (!github || !GITHUB_LOGIN_PATTERN.test(github)) return
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...read(), github }))
  } catch {
    // The developer types it instead.
  }
}

/** The name VS Code offered for this host, if it has not been used yet. */
export const hostNameHint = (host: string): string | undefined => (host === "github" ? read().github : undefined)

/** Used or refused: never offered again in this tab. */
export const forgetHostName = (host: string): void => {
  try {
    const rest: Record<string, string | undefined> = { ...read() }
    delete rest[host]
    sessionStorage.setItem(KEY, JSON.stringify(rest))
  } catch {
    // Nothing kept.
  }
}

/** github.com itself, not an Enterprise server, where a github.com login would mean someone else. */
export const isGitHubDotCom = (baseUrl: string): boolean => /^https:\/\/(?:www\.|api\.)?github\.com\/?$/i.test(baseUrl.trim())
