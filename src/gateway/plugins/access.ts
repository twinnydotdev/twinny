/**
 * Sharing a plugin with developers. Admins always use every plugin; a
 * developer's key reaches a plugin only when an admin shared it with them,
 * and then only the routes the plugin itself calls safe for a developer.
 *
 *   who     an access record per plugin: everyone with a key, or named people
 *   what    the plugin's `memberRoutes`: method and path, nothing else
 *
 * People are key names, not key ids, so a grant follows the person across
 * a replaced key, an invite or a single sign-on. The shared token is never
 * a person and gets nothing here.
 */
import { isRecord } from "../../common/guards"
import { KEY_NAME_PATTERN } from "../keys"

/** Who besides the admins may use a plugin. */
export interface PluginAccess {
  /** Every developer with a gateway key of their own. */
  everyone: boolean
  /** Key names, sorted; not consulted while `everyone` is on. */
  people: string[]
}

/** A route a developer may call on a plugin shared with them. */
export interface MemberRoute {
  method: "GET" | "POST" | "PUT" | "DELETE"
  /** Matched against the whole path after `/api/`, without a leading slash. */
  path: RegExp
}

export const NO_ACCESS: PluginAccess = Object.freeze({ everyone: false, people: [] }) as PluginAccess

/** More names than this is a sign of a mistake; `everyone` is the way to share widely. */
export const MAX_PEOPLE = 500

/**
 * Reads an access record from a request or a file. Names are trimmed,
 * checked like key names, and deduplicated; anything malformed is refused
 * with a reason a person can act on.
 */
export const parseAccess = (value: unknown): PluginAccess => {
  if (!isRecord(value)) throw new Error("Send { everyone, people }.")
  if (value.everyone !== undefined && typeof value.everyone !== "boolean")
    throw new Error("everyone is true or false.")
  if (value.people !== undefined && !Array.isArray(value.people))
    throw new Error("people is a list of key names.")
  const names = new Set<string>()
  for (const entry of (value.people ?? []) as unknown[]) {
    const name = typeof entry === "string" ? entry.trim() : ""
    if (!KEY_NAME_PATTERN.test(name)) throw new Error(`"${String(entry)}" is not a key name.`)
    names.add(name)
  }
  if (names.size > MAX_PEOPLE) throw new Error(`At most ${MAX_PEOPLE} people; share with everyone instead.`)
  return { everyone: value.everyone === true, people: [...names].sort((a, b) => a.localeCompare(b)) }
}

/** Whether the record lets this key name in. */
export const grants = (access: PluginAccess, principal: string): boolean =>
  access.everyone || access.people.includes(principal)

/** Whether a developer may make this request; the method and the whole path must match one route. */
export const memberMay = (routes: readonly MemberRoute[], method: string, path: string): boolean =>
  routes.some((route) => route.method === method && route.path.test(path))

/** The record as it is kept: nothing for a plugin shared with nobody. */
export const isShared = (access: PluginAccess): boolean => access.everyone || access.people.length > 0
