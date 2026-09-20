/**
 * The plugin store: what this build carries, switched on or off. An
 * enabled plugin gets its own entry in the side navigation; its page is
 * looked up here by plugin id.
 */
import React, { useState } from "react"

import type { PluginSummary } from "../plugins/host"

import { PullsPanel } from "./pulls"

interface PluginsPageProps {
  plugins: PluginSummary[]
  onToggle: (id: string, enabled: boolean) => Promise<void>
  onOpen: (id: string) => void
}

export const PluginsPage = ({ plugins, onToggle, onOpen }: PluginsPageProps) => {
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
      {error && <div className="error-bar">{error}</div>}
      <div className="plugin-grid">
        {plugins.map((plugin) => (
          <section key={plugin.id} className={`panel plugin ${plugin.enabled ? "on" : ""}`}>
            <div className="section-heading">
              <h2>{plugin.name}</h2>
              <span className={`pill-s ${plugin.enabled ? "ok" : ""}`}>{plugin.enabled ? "on" : "off"}</span>
            </div>
            <p className="plugin-description">{plugin.description}</p>
            <div className="row-actions">
              <button type="button" className={plugin.enabled ? "ghost" : "primary"} disabled={busy !== null} onClick={() => void toggle(plugin)}>
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
