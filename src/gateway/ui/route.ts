/**
 * Where the page is, kept in the address after "#" so the browser's Back
 * and Forward move through it, a reload stays put and a link can point at
 * one place: "<view>" for a page ("people", "plugin:github"), and
 * "<view>/<rest>" for a place inside it ("plugin:github/pull/1a2b3c4d/7").
 * Moving pushes a history entry; nothing is fetched, so the page's rule of
 * loading nothing from outside is untouched.
 */
import { useSyncExternalStore } from "react"

const read = (): string => {
  try {
    return decodeURIComponent(location.hash.replace(/^#/, ""))
  } catch {
    return ""
  }
}

const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())
const subscribe = (listener: () => void) => {
  if (listeners.size === 0) {
    window.addEventListener("popstate", emit)
    window.addEventListener("hashchange", emit)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      window.removeEventListener("popstate", emit)
      window.removeEventListener("hashchange", emit)
    }
  }
}

/** Each entry remembers where it was entered from, so "back" can tell whether the browser's Back leads there. */
interface Entry {
  from?: string
}

/** Goes to `route`. A new history entry unless `replace`, which is for settling on a place the reader did not choose. */
export const navigate = (route: string, { replace = false } = {}): void => {
  const here = read()
  if (here === route) return
  try {
    if (replace) history.replaceState(history.state, "", `#${route}`)
    else history.pushState({ from: here } satisfies Entry, "", `#${route}`)
  } catch {
    return
  }
  emit()
}

/**
 * Up to `route` from a place inside it. When this place was entered from
 * there, that is the browser's own Back, so Forward returns here and the
 * history does not grow; otherwise (a link or a reload landed here) it is
 * a step forward to it.
 */
export const backTo = (route: string): void => {
  let from: string | undefined
  try {
    from = (history.state as Entry | null)?.from
  } catch {
    from = undefined
  }
  if (from === route) history.back()
  else navigate(route)
}

/** The address after "#", followed as it changes. */
export const useRoute = (): string => useSyncExternalStore(subscribe, read)

/** "plugin:github/pull/1a2b3c4d/7" → view "plugin:github", rest "pull/1a2b3c4d/7". */
export const splitRoute = (route: string): { view: string; rest: string } => {
  const cut = route.indexOf("/")
  return cut < 0 ? { view: route, rest: "" } : { view: route.slice(0, cut), rest: route.slice(cut + 1) }
}
