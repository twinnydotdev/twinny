/**
 * The plugin store: what this build carries, switched on or off. An
 * enabled plugin gets its own entry in the side navigation; its page is
 * looked up here by plugin id.
 */
import React, { useState } from "react"

import type { PluginSummary } from "../plugins/host"

import { PullsPanel } from "./pulls"

/** Brand marks, inline so the page's content-security policy allows them. */
const ICONS: Record<string, { viewBox: string; path: string; color?: string }> = {
  github: {
    viewBox: "0 0 16 16",
    path: "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"
  },
  gitlab: {
    viewBox: "0 0 24 24",
    color: "#fc6d26",
    path: "m23.6 9.593-.034-.086L20.3.981a.85.85 0 0 0-.336-.405.875.875 0 0 0-1 .054.875.875 0 0 0-.29.44l-2.205 6.748H7.538L5.332 1.07a.857.857 0 0 0-.29-.441.875.875 0 0 0-1-.054.859.859 0 0 0-.336.405L.433 9.502l-.032.086a6.066 6.066 0 0 0 2.012 7.01l.011.009.03.021 4.976 3.727 2.462 1.863 1.5 1.132a1.009 1.009 0 0 0 1.22 0l1.5-1.132 2.461-1.863 5.006-3.749.013-.01a6.068 6.068 0 0 0 2.009-7.003z"
  }
}

/** A plugin's mark, in its brand colour where it has one; nothing for plugins without one. */
export const PluginIcon = ({ id, size = 16 }: { id: string; size?: number }) => {
  const icon = ICONS[id]
  if (!icon) return null
  return (
    <svg className="plugin-icon" width={size} height={size} viewBox={icon.viewBox} aria-hidden="true" focusable="false" style={icon.color ? { color: icon.color } : undefined}>
      <path fill="currentColor" d={icon.path} />
    </svg>
  )
}

interface PluginsPageProps {
  plugins: PluginSummary[]
  /** Whether the plan carries the plugins feature; switches are off otherwise. */
  licensed: boolean
  onToggle: (id: string, enabled: boolean) => Promise<void>
  onOpen: (id: string) => void
  onNavigate: (view: "plan") => void
}

export const PluginsPage = ({ plugins, licensed, onToggle, onOpen, onNavigate }: PluginsPageProps) => {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | undefined>()
  const toggle = async (plugin: PluginSummary) => {
    setBusy(plugin.id)
    setError(undefined)
    try {
      await onToggle(plugin.id, !plugin.enabled)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  const on = plugins.filter((plugin) => plugin.enabled).length
  return (
    <>
      <div className="page-title">
        <h2>Plugins</h2>
        <p>
          {on === 0 ? "Nothing switched on." : `${on} of ${plugins.length} switched on.`} A plugin keeps its own files under the data directory and adds a page here.
        </p>
      </div>
      {!licensed && (
        <div className="confirm-bar">
          <span>
            Plugins are a licence feature. {on > 0 ? "The ones switched on are stopped until a licence is installed." : "Install a licence to switch one on."}
          </span>
          <button type="button" className="primary" onClick={() => onNavigate("plan")}>
            Plan &amp; licence
          </button>
        </div>
      )}
      {error && <div className="error-bar">{error}</div>}
      <div className="plugin-grid">
        {plugins.map((plugin) => (
          <section key={plugin.id} className={`panel plugin ${plugin.enabled ? "on" : ""}`}>
            <div className="section-heading">
              <h2 className="plugin-name">
                <PluginIcon id={plugin.id} size={22} />
                {plugin.name}
              </h2>
              <span className={`pill-s ${plugin.enabled ? "ok" : ""}`}>{plugin.enabled ? "on" : "off"}</span>
            </div>
            <p className="plugin-description">{plugin.description}</p>
            <div className="row-actions">
              <button type="button" className={plugin.enabled ? "ghost" : "primary"} disabled={busy !== null || (!licensed && !plugin.enabled)} title={!licensed && !plugin.enabled ? "Needs a licence with the plugins feature" : undefined} onClick={() => void toggle(plugin)}>
                {busy === plugin.id ? "…" : plugin.enabled ? "switch off" : "switch on"}
              </button>
              {plugin.enabled && (
                <button type="button" className="link" onClick={() => onOpen(plugin.id)}>
                  open
                </button>
              )}
            </div>
          </section>
        ))}
      </div>
    </>
  )
}

/** The page an enabled plugin shows; plugins without one say so. */
export const PluginPage = ({ id, apiKey }: { id: string; apiKey: string }) => {
  if (id === "github" || id === "gitlab") return <PullsPanel host={id} apiKey={apiKey} />
  return <div className="empty">This plugin has no page.</div>
}
