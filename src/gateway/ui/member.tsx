/**
 * The page for a developer signed in with their own key: the plugins an
 * admin shared with them, each on its own page without its settings.
 * Nothing else of the admin page is reachable with a developer's key.
 */
import React, { useCallback, useEffect, useState } from "react"

import { messageOf } from "../../common/errors"
import type { RemoteIdentity } from "../../protocol/types"
import type { PluginSummary } from "../plugins/host"

import { api, ApiError } from "./api"
import { PluginIcon, PluginPage } from "./plugins"

const VIEW_PREFIX = "plugin:"

/** The plugin the URL names, so a link can point at one. */
const openedInHash = (): string | undefined => {
  const hash = location.hash.replace(/^#/, "")
  return hash.startsWith(VIEW_PREFIX) ? hash.slice(VIEW_PREFIX.length) : undefined
}

interface MemberAppProps {
  apiKey: string
  who: RemoteIdentity
  /** Back to the sign-in form, with why when the key stopped working. */
  onSignOut: (reason?: string) => void
}

export const MemberApp = ({ apiKey, who, onSignOut }: MemberAppProps) => {
  const [plugins, setPlugins] = useState<PluginSummary[] | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [opened, setOpenedState] = useState<string | undefined>(openedInHash)

  const setOpened = useCallback((id: string) => {
    setOpenedState(id)
    try {
      history.replaceState(null, "", `#${VIEW_PREFIX}${id}`)
    } catch {
      // Nothing to remember.
    }
  }, [])

  const load = useCallback(async () => {
    try {
      const answer = await api<{ plugins: PluginSummary[] }>("/twinny/v1/admin/plugins", apiKey)
      setPlugins(answer.plugins)
      setError(undefined)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        onSignOut(e.message)
        return
      }
      setError(messageOf(e))
    }
  }, [apiKey, onSignOut])

  // Sharing can change while the tab is open; look again every minute.
  useEffect(() => {
    void load()
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load()
    }, 60_000)
    return () => clearInterval(timer)
  }, [load])

  const current = plugins?.find((plugin) => plugin.id === opened) ?? plugins?.[0]

  return (
    <div className="app">
      <header className="top">
        <h1>
          twinny<span>-server</span>
        </h1>
        <span className="spacer" />
        <span className="who" title="Signed in with this developer key">
          {who.key}
        </span>
        <button className="ghost" onClick={() => onSignOut()}>
          sign out
        </button>
      </header>

      <div className="shell">
        <nav className="sidenav" aria-label="Plugins shared with you">
          <div className="group">Plugins</div>
          {plugins?.map((plugin) => (
            <button key={plugin.id} className={current?.id === plugin.id ? "on" : ""} onClick={() => setOpened(plugin.id)} aria-current={current?.id === plugin.id ? "page" : undefined}>
              <span className="nav-plugin">
                <PluginIcon id={plugin.id} size={14} />
                {plugin.name}
              </span>
            </button>
          ))}
        </nav>
        <div className="main">
          {error && <div className="error-bar">{error}</div>}
          {!plugins && !error && <div className="loading">Loading…</div>}
          {plugins && !current && (
            <div className="empty">
              Nothing is shared with {who.key} yet. An admin can share a plugin with you on the Plugins page; the rest of this page is for admins.
            </div>
          )}
          {current && <PluginPage key={current.id} id={current.id} apiKey={apiKey} member />}
        </div>
      </div>
    </div>
  )
}
