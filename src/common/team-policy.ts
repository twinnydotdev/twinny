/**
 * The team policy rules, pure, so the extension enforces them and the
 * webview can show the same verdicts on the provider list.
 */
import { API_PROVIDERS } from "./constants"
import type { ProviderType } from "./provider-validation"
import type { TeamPolicy, TeamPolicyState } from "./team"
import type { TwinnyProvider } from "./types"

const JOB_LABEL: Record<ProviderType, string> = {
  chat: "chat",
  fim: "autocomplete",
  embedding: "embeddings"
}

/** Whether a policy asks or discloses anything at all. */
export const policyIsEmpty = (policy: TeamPolicy | undefined): boolean =>
  !policy || (!policy.teamOnly && !policy.lockDefaults && !policy.recording?.length && !policy.peers?.length)

const RECORDING_LABEL: Record<string, string> = { chat: "chat conversations", fim: "autocomplete requests", embeddings: "embedding inputs" }

/** "The gateway keeps …", for consent screens and the banner. */
export const describeRecording = (routes: string[] | undefined): string | undefined =>
  routes?.length ? `The gateway keeps the content of your ${routes.map((r) => RECORDING_LABEL[r] ?? r).join(", ")}.` : undefined

/** "Requests to … may run on teammates' computers.", for consent screens and the banner. */
export const describePooling = (aliases: string[] | undefined): string | undefined =>
  aliases?.length
    ? `Requests to ${aliases.join(" and ")} may run on teammates' computers. Nothing is stored there.`
    : undefined

/** One line per rule, for consent screens and the providers tab. */
export const describePolicy = (policy: TeamPolicy): string[] => {
  const lines: string[] = []
  if (policy.teamOnly) {
    lines.push("Only the team gateway may be used: no other providers can be added or made active.")
  }
  if (policy.lockDefaults) {
    lines.push("The team's default models stay active for chat, autocomplete and embeddings.")
  }
  const recording = describeRecording(policy.recording)
  if (recording) lines.push(recording)
  const pooling = describePooling(policy.peers)
  if (pooling) lines.push(pooling)
  if (policy.systemPrompt) lines.push("The team's system prompt is put before every chat.")
  if (policy.templates?.length) lines.push(`The team shares ${policy.templates.length} prompt template${policy.templates.length === 1 ? "" : "s"}: ${policy.templates.map((t) => t.name).join(", ")}.`)
  return lines
}

let currentPolicy: TeamPolicy | undefined

/** What the extension applies right now: set by the team connection whenever the policy loads or goes. */
export const rememberTeamPolicy = (policy: TeamPolicy | undefined): void => {
  currentPolicy = policy && !policyIsEmpty(policy) ? policy : undefined
}

export const currentTeamPolicy = (): TeamPolicy | undefined => currentPolicy

const leaveHint = "To use your own settings, leave the team from the Providers tab."

/** A provider entry made by Connect to team: the gateway kind under the `team-<group>-<type>` id. */
export const isTeamProvider = (provider: TwinnyProvider): boolean =>
  provider.provider === API_PROVIDERS.TwinnyRemote && /^team-[0-9a-f]+-(chat|fim|embedding)$/.test(provider.id)

/** The team's own entry for a job, by the id convention `team-<group>-<type>`. */
export const teamProviderIdFor = (state: TeamPolicyState, type: ProviderType): string | undefined =>
  state.providerIds.find((id) => id.endsWith(`-${type}`))

/**
 * Why a provider may not be added or made active under the team's policy,
 * or nothing. The team's own entries are always allowed.
 */
export const policyRefusal = (
  state: TeamPolicyState | undefined,
  action: "add" | "activate",
  provider: TwinnyProvider,
  type?: ProviderType
): string | undefined => {
  if (!state) return undefined
  if (provider.id && state.providerIds.includes(provider.id)) return undefined
  const { policy } = state
  const kind = provider.provider
  if (policy.teamOnly && kind !== API_PROVIDERS.TwinnyRemote) {
    return `Your team (${state.url}) does not allow ${kind} providers. Only the team gateway may be used. ${leaveHint}`
  }
  if (action === "activate" && policy.lockDefaults && type && teamProviderIdFor(state, type)) {
    return `Your team (${state.url}) keeps its default ${JOB_LABEL[type]} model active. ${leaveHint}`
  }
  return undefined
}
