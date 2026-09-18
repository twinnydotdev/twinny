/**
 * Team policy on the extension side: what a developer agreed to when they
 * connected, and the two rules it can impose.
 *
 * The policy travels with the team route, is shown before connecting, and
 * is kept in global state until the developer leaves the team. Enforcement
 * is in the provider manager: adding a provider of a kind the team does
 * not allow, or switching a locked job away from the team's model, is
 * refused with a message that says how to get out (leave the team). It is
 * a guard rail for a team that has agreed on it, not a lock a determined
 * person cannot undo.
 */
import type { Memento } from "vscode"

import type { TeamPolicyState } from "../../common/team"

export { describePolicy, isTeamProvider, policyIsEmpty, policyRefusal, teamProviderIdFor } from "../../common/team-policy"

export const TEAM_POLICY_STORAGE_KEY = "twinny.teamPolicy"

export interface TeamPolicyStorage {
  get(): TeamPolicyState | undefined
  set(state: TeamPolicyState): Promise<void>
  clear(): Promise<void>
}

/** Global state backed; one team at a time. */
export class TeamPolicyStore implements TeamPolicyStorage {
  constructor(private readonly _state: Memento) {}

  public get(): TeamPolicyState | undefined {
    const stored = this._state.get<TeamPolicyState>(TEAM_POLICY_STORAGE_KEY)
    if (!stored || typeof stored.url !== "string" || !Array.isArray(stored.providerIds) || typeof stored.policy !== "object") {
      return undefined
    }
    return stored
  }

  public async set(state: TeamPolicyState): Promise<void> {
    await this._state.update(TEAM_POLICY_STORAGE_KEY, state)
  }

  public async clear(): Promise<void> {
    await this._state.update(TEAM_POLICY_STORAGE_KEY, undefined)
  }
}
