/**
 * Hits from the team gateway's shared index (the Shared context plugin),
 * for a chat's "relevant code". Best effort: no team, no plugin, or a
 * slow gateway means no hits, never an error in the chat.
 */
import { currentTeamState, teamProviderIdFor } from "../../common/team-policy"
import type { Hit } from "../embeddings/rank"
import { gatewayTokenFor } from "../providers/credentials"

const TIMEOUT_MS = 8_000

interface TeamHit {
  repo: string
  path: string
  startLine: number
  endLine: number
  text: string
  score: number
}

/** `team:<repo>/<path>`: what the sources list shows for a hit that lives on the gateway, not on this machine. */
export const teamHitFile = (repo: string, filePath: string): string => `team:${repo}/${filePath}`

export const searchTeamContext = async (query: string, limit: number, fetchImpl: typeof fetch = fetch): Promise<Hit[]> => {
  const state = currentTeamState()
  if (!state?.url) return []
  const providerId = teamProviderIdFor(state, "chat") ?? teamProviderIdFor(state, "fim")
  const token = providerId ? gatewayTokenFor(providerId) : undefined
  if (!token) return []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetchImpl(`${state.url.replace(/\/+$/, "")}/twinny/v1/plugins/context/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, k: limit }),
      signal: controller.signal
    })
    if (!response.ok) return []
    const body = (await response.json()) as { hits?: TeamHit[] }
    return (body.hits ?? []).map((hit) => ({
      file: teamHitFile(hit.repo, hit.path),
      content: hit.text,
      startLine: Math.max(0, hit.startLine - 1),
      endLine: Math.max(0, hit.endLine - 1),
      score: hit.score,
      kind: "team" as const
    }))
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}
