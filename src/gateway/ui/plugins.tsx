/**
 * The plugin store: what this build carries, switched on or off. An
 * enabled plugin gets its own entry in the side navigation; its page is
 * looked up here by plugin id.
 */
import React, { useState } from "react"

import { messageOf } from "../../common/errors"
import type { PluginSummary } from "../plugins/host"

import { BackupsPanel } from "./backups"
import { ContextPanel } from "./context"
import { NotifyPanel } from "./notify"
import { OidcPanel } from "./oidc"
import { PullsPanel } from "./pulls"

/** Brand marks, inline so the page's content-security policy allows them. */
const ICONS: Record<string, { viewBox: string; path: string; color?: string }> = {
  github: {
    viewBox: "0 0 16 16",
    path: "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"
  },
  backups: {
    viewBox: "0 0 16 16",
    color: "#3987e5",
    // An archive box: lid, body, and the handle slot.
    path: "M1 2.75A.75.75 0 0 1 1.75 2h12.5a.75.75 0 0 1 .75.75v2.5a.75.75 0 0 1-.75.75H14v6.25A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25V6h-.25A.75.75 0 0 1 1 5.25v-2.5zm1.5.75v1h11v-1h-11zM3.5 6v6.25c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25V6h-9zm2.75 1.5h3.5a.75.75 0 0 1 0 1.5h-3.5a.75.75 0 0 1 0-1.5z"
  },
  gitea: {
    viewBox: "0 0 24 24",
    color: "#609926",
    // A mug with a handle: the teacup.
    path: "M4 5.5A1.5 1.5 0 0 1 5.5 4h10A1.5 1.5 0 0 1 17 5.5V7h2.25A2.75 2.75 0 0 1 22 9.75v1.5A3.75 3.75 0 0 1 18.25 15H17v.5A4.5 4.5 0 0 1 12.5 20h-4A4.5 4.5 0 0 1 4 15.5v-10zM17 9v4h1.25A1.75 1.75 0 0 0 20 11.25v-1.5A.75.75 0 0 0 19.25 9H17zm-9 2.5h5v-2H8v2zm0 4h5v-2H8v2z"
  },
  bitbucket: {
    viewBox: "0 0 24 24",
    color: "#2684ff",
    path: "M.778 1.213a.768.768 0 0 0-.768.892l3.263 19.81c.084.5.515.868 1.022.873H19.95a.772.772 0 0 0 .77-.646l3.27-20.03a.768.768 0 0 0-.768-.891zM14.52 15.53H9.522L8.17 8.466h7.561z"
  },
  discord: {
    viewBox: "0 0 24 24",
    color: "#5865f2",
    path: "M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"
  },
  teams: {
    viewBox: "0 0 24 24",
    color: "#6264a7",
    // Two people on a card, as the Teams mark suggests.
    path: "M14.5 3.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19.5 5.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM3 8.75A1.75 1.75 0 0 1 4.75 7h9.5A1.75 1.75 0 0 1 16 8.75V15a4 4 0 0 1-8 0v-1H4.75A1.75 1.75 0 0 1 3 12.25v-3.5zm3 1.25v1.5h1.5V17h1.5v-5.5h1.5V10H6zm11 0h3.25c.966 0 1.75.784 1.75 1.75v3.5A3.5 3.5 0 0 1 18.5 19h-.86A5.98 5.98 0 0 0 18 15v-5z"
  },
  context: {
    viewBox: "0 0 16 16",
    color: "#9085e9",
    // Stacked layers: one index over many repositories.
    path: "M8 1.25a.75.75 0 0 1 .34.08l6 3a.75.75 0 0 1 0 1.34l-6 3a.75.75 0 0 1-.68 0l-6-3a.75.75 0 0 1 0-1.34l6-3A.75.75 0 0 1 8 1.25zM3.93 5 8 7.04 12.07 5 8 2.96 3.93 5zM1.6 8.16a.75.75 0 0 1 1-.32L8 10.54l5.4-2.7a.75.75 0 0 1 .68 1.34l-5.74 2.87a.75.75 0 0 1-.68 0L1.92 9.18a.75.75 0 0 1-.32-1.02zm0 3a.75.75 0 0 1 1-.32L8 13.54l5.4-2.7a.75.75 0 0 1 .68 1.34l-5.74 2.87a.75.75 0 0 1-.68 0l-5.74-2.87a.75.75 0 0 1-.32-1.02z"
  },
  oidc: {
    viewBox: "0 0 16 16",
    color: "#c98500",
    // A key.
    path: "M10.5 0a5.5 5.5 0 0 0-5.3 6.97L.22 11.94A.75.75 0 0 0 0 12.47V15.25c0 .414.336.75.75.75h2.5a.75.75 0 0 0 .75-.75V14h1.25a.75.75 0 0 0 .75-.75V12h1.25a.75.75 0 0 0 .53-.22l1.03-1.03A5.5 5.5 0 1 0 10.5 0zm0 1.5a4 4 0 1 1-1.31 7.78.75.75 0 0 0-.78.18L7.19 10.5H5.75a.75.75 0 0 0-.75.75v1.25H3.75a.75.75 0 0 0-.75.75v1.25H1.5v-1.72l5.09-5.09a.75.75 0 0 0 .18-.78A4 4 0 0 1 10.5 1.5zM12 3.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"
  },
  slack: {
    viewBox: "0 0 24 24",
    color: "#e01e5a",
    // The hash mark, one colour: four lozenges and their tabs.
    path: "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"
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
      setError(messageOf(e))
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

/**
 * What a plugin page shows while its first answer is on the way: the
 * same tiles and panels, as grey bars, so nothing jumps when data lands.
 */
export const PageSkeleton = ({ tiles = 4, rows = 5, title }: { tiles?: number; rows?: number; title?: React.ReactNode }) => (
  <div className="skeleton-page" aria-busy="true" aria-label="Loading">
    <div className="page-title">
      {title ?? <span className="skeleton" style={{ width: 120, height: 24 }} />}
      <span className="skeleton" style={{ width: 360, height: 14 }} />
    </div>
    <div className="tiles">
      {Array.from({ length: tiles }, (_, i) => (
        <div key={i} className="tile">
          <div className="label">
            <span className="skeleton" style={{ width: "60%", height: 11 }} />
          </div>
          <div className="value">
            <span className="skeleton" style={{ width: 40, height: 22 }} />
          </div>
        </div>
      ))}
    </div>
    <section className="panel">
      <div className="section-heading">
        <span className="skeleton" style={{ width: 160, height: 12 }} />
        <span className="skeleton" style={{ width: 220, height: 24 }} />
      </div>
      <div className="skeleton-rows">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="skeleton-row">
            <span className="skeleton" style={{ width: `${55 - (i % 3) * 8}%`, height: 13 }} />
            <span className="skeleton" style={{ width: 70, height: 18, borderRadius: 999 }} />
            <span className="skeleton" style={{ width: 84, height: 18, borderRadius: 999 }} />
            <span className="skeleton" style={{ width: 60, height: 12 }} />
          </div>
        ))}
      </div>
    </section>
    <section className="panel">
      <div className="section-heading">
        <span className="skeleton" style={{ width: 120, height: 12 }} />
      </div>
      <div className="skeleton-rows">
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="skeleton-row">
            <span className="skeleton" style={{ width: "30%", height: 13 }} />
            <span className="skeleton" style={{ width: 50, height: 18 }} />
            <span className="skeleton" style={{ width: 60, height: 12 }} />
          </div>
        ))}
      </div>
    </section>
  </div>
)

/** The page an enabled plugin shows; plugins without one say so. */
export const PluginPage = ({ id, apiKey }: { id: string; apiKey: string }) => {
  if (id === "github" || id === "gitlab" || id === "gitea" || id === "bitbucket") return <PullsPanel host={id} apiKey={apiKey} />
  if (id === "backups") return <BackupsPanel apiKey={apiKey} />
  if (id === "oidc") return <OidcPanel apiKey={apiKey} />
  if (id === "context") return <ContextPanel apiKey={apiKey} />
  if (id === "slack" || id === "discord" || id === "teams") return <NotifyPanel host={id} apiKey={apiKey} />
  return <div className="empty">This plugin has no page.</div>
}
