/** Type guards shared across the extension, the protocol and the gateway. Pure. */

/** A plain object: not null, not an array. What JSON.parse gives for `{...}`. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
