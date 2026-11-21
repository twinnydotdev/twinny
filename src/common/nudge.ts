/** The two one-time messages, kept apart so nobody sees them close together. */
const DAY_MS = 24 * 60 * 60 * 1000
const TEAM_AFTER_MS = 14 * DAY_MS
const SUPPORT_AFTER_MS = 30 * DAY_MS
const SUPPORT_GAP_MS = 14 * DAY_MS

export interface NudgeState {
  since: number
  shown?: boolean
  shownAt?: number
  supportShown?: boolean
}

/** Which message is due, if any. A machine on a team gateway gets neither. */
export const dueNudge = (state: NudgeState, now: number, onTeam: boolean): "team" | "support" | undefined => {
  if (onTeam) return undefined
  if (!state.shown) return now - state.since >= TEAM_AFTER_MS ? "team" : undefined
  if (state.supportShown || now - state.since < SUPPORT_AFTER_MS) return undefined
  return state.shownAt !== undefined && now - state.shownAt < SUPPORT_GAP_MS ? undefined : "support"
}
