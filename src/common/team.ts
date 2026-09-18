import type { TeamPolicy } from "../protocol/types"

import type { ProviderType } from "./provider-validation"

export type { TeamPolicy }

/** The policy a developer accepted when connecting, kept until they leave the team. */
export interface TeamPolicyState {
  url: string
  policy: TeamPolicy
  /** The team's provider entries, so leaving can remove exactly them. */
  providerIds: string[]
  fetchedAt: string
}

/**
 * What the Providers tab shows about the team: the connection, with the
 * policy when the team sets one (empty otherwise), and whether this
 * machine still holds the key. Derived from the team's provider entries,
 * so it survives restarts on a gateway that sends no policy.
 */
export interface TeamStatus extends TeamPolicyState {
  /** The team entries are here but their key is gone from secret storage. */
  keyMissing?: boolean
}

export interface TeamConnectionRequest {
  url: string
  token: string
}

export interface TeamRolePreview {
  type: ProviderType
  alias?: string
  current?: { id: string; label: string; modelName: string }
}

/** Contains no token; the extension holds credentials until applying or expiry. */
export interface TeamPreview {
  id: string
  url: string
  identity: string
  roles: TeamRolePreview[]
  /** What connecting will enforce, shown for consent before applying. */
  policy?: TeamPolicy
}

/** A sign-in started for a gateway; the code the developer reads to their admin. */
export interface TeamSignInStart {
  id: string
  url: string
  userCode: string
  expiresAt: string
  /** Milliseconds between polls. */
  intervalMs: number
}

export type TeamSignInStatus =
  | { status: "pending" }
  | { status: "denied" }
  | { status: "expired" }
  /** Approved: the key is held by the extension and the usual preview follows. */
  | { status: "approved"; name: string; preview: TeamPreview }

/**
 * What an invite or team link asks the Providers tab to show: the URL
 * filled in, and when the link carried an invite that opened, the preview
 * to confirm; when it did not, why, so the developer can request a key.
 */
export interface TeamOpen {
  url: string
  invite?: { name: string; preview: TeamPreview }
  error?: string
}

export interface TeamApplyRequest {
  previewId: string
  replaceExisting: boolean
}

export interface TeamApplyResult {
  connected: ProviderType[]
}

/* -------------------------------------------------------------------------- */
/*  Sharing this computer with the team                                       */
/* -------------------------------------------------------------------------- */

/** A local server this machine can share: what the first-run discovery finds. */
export interface TeamShareBackend {
  /** The adapter kind: `ollama`, `lmstudio`… */
  provider: string
  label: string
  apiHostname: string
  apiPort: number
  apiProtocol: string
}

export type TeamShareState = "off" | "connecting" | "online" | "reconnecting"

/** This computer as a member of the team's pool, as the share card shows it. */
export interface TeamShareStatus {
  /** Connected to a team whose gateway pools teammates' computers. */
  available: boolean
  /** Sharing is switched on and comes back after a restart. */
  enabled: boolean
  state: TeamShareState
  /** Sharing is on but another VS Code window on this machine is the one doing it. */
  runningElsewhere: boolean
  /** What teammates and the admin see this computer as. */
  machine: string
  backend?: TeamShareBackend
  /** Local servers that answered, to choose from. */
  choices: TeamShareBackend[]
  /** Model names announced to the gateway. */
  models: string[]
  /** Backend model names the team's pool wants. */
  wanted: string[]
  /** Requests served since sharing started. */
  served: number
  /** Whether the local server answered the last check. */
  backendOk?: boolean
  error?: string
}
