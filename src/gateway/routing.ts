/**
 * Routing rules: which aliases or which kinds of backend may serve a
 * workspace, matched by a glob on the workspace name the extension sends.
 */
/** A `*` glob against a name, case-insensitive; `*` alone or an empty pattern matches everything. */
export const globMatch = (pattern: string, value: string): boolean => {
  const source = `^${pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")}$`
  return new RegExp(source, "i").test(value)
}

export interface RoutingRule {
  /** A glob on the workspace name the extension sends, e.g. `payments-*`. */
  workspace: string
  /** Only backends that run on the team's own machines may serve this workspace. */
  localOnly?: boolean
  /** Only these aliases may serve it. */
  aliases?: string[]
}

/**
 * The first rule whose workspace glob matches decides. Returns why the
 * alias may not serve the workspace, or nothing when it may.
 */
export const refuseByRouting = (
  rules: RoutingRule[] | undefined,
  workspace: string | undefined,
  alias: string,
  hosted: boolean
): string | undefined => {
  if (!rules?.length || !workspace) return undefined
  const rule = rules.find((entry) => globMatch(entry.workspace, workspace))
  if (!rule) return undefined
  if (rule.localOnly && hosted)
    return `Team policy: code from "${workspace}" may only go to models on the team's own machines, and "${alias}" is served by a hosted provider.`
  if (rule.aliases?.length && !rule.aliases.includes(alias))
    return `Team policy: "${workspace}" may only use ${rule.aliases.map((name) => `"${name}"`).join(", ")}, not "${alias}".`
  return undefined
}
