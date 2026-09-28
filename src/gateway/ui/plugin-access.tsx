/**
 * Who a plugin is shared with, on its card in the store: nobody (admins
 * only), every developer with a key, or the people ticked. A developer a
 * plugin is shared with signs in to this page with their own key and sees
 * that plugin's page, without its settings; VS Code announces the share
 * and opens the page signed in, so there is no key to hand out.
 */
import React, { useEffect, useState } from "react"

import { messageOf } from "../../common/errors"
import type { PluginAccess } from "../plugins/access"

type Mode = "nobody" | "everyone" | "people"

const modeOf = (access: PluginAccess): Mode => (access.everyone ? "everyone" : access.people.length ? "people" : "nobody")

/** One line for the card: who may use the plugin besides the admins. */
export const describeAccess = (access: PluginAccess): string =>
  access.everyone
    ? "every developer with a key"
    : access.people.length
      ? access.people.join(", ")
      : "admins only"

interface AccessEditorProps {
  access: PluginAccess
  /** Developers' key names to choose from: the active keys that are not admins. */
  people: string[]
  onSave: (access: PluginAccess) => Promise<void>
}

export const AccessEditor = ({ access, people, onSave }: AccessEditorProps) => {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<Mode>(modeOf(access))
  const [chosen, setChosen] = useState<string[]>(access.people)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  // The store refreshes every minute; only a change in the grant itself resets the form.
  const saved = `${access.everyone}:${access.people.join(",")}`
  useEffect(() => {
    setMode(modeOf(access))
    setChosen(access.people)
  }, [saved])

  // A grant for someone whose key is gone stays listed, so it can be seen and removed.
  const names = [...new Set([...people, ...access.people])].sort((a, b) => a.localeCompare(b))
  const toggle = (name: string) => setChosen((current) => (current.includes(name) ? current.filter((entry) => entry !== name) : [...current, name]))

  const save = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await onSave({ everyone: mode === "everyone", people: mode === "people" ? chosen : [] })
      setOpen(false)
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  if (!open)
    return (
      <div className="row-actions access-line">
        <span className="muted">
          Shared with: <b>{describeAccess(access)}</b>
        </span>
        <button type="button" className="link" onClick={() => setOpen(true)}>
          share
        </button>
      </div>
    )

  return (
    <div className="access-editor">
      <span className="chips" role="group" aria-label="Shared with">
        {(["nobody", "everyone", "people"] as const).map((entry) => (
          <button key={entry} type="button" className={mode === entry ? "on" : ""} aria-pressed={mode === entry} onClick={() => setMode(entry)}>
            {entry === "nobody" ? "admins only" : entry === "everyone" ? "every developer" : "these people"}
          </button>
        ))}
      </span>
      {mode === "people" &&
        (names.length ? (
          <div className="access-people">
            {names.map((name) => (
              <label key={name} className={people.includes(name) ? "" : "muted"} title={people.includes(name) ? undefined : "No active key has this name"}>
                <input type="checkbox" checked={chosen.includes(name)} onChange={() => toggle(name)} disabled={busy} /> {name}
              </label>
            ))}
          </div>
        ) : (
          <div className="empty">No developer keys yet. Invite someone under People.</div>
        ))}
      {error && <div className="error">{error}</div>}
      <div className="row-actions">
        <span className="muted">
          Nothing to send them: VS Code tells each developer it was shared, and <b>Providers → Your team&apos;s plugins</b> opens it signed in. They see the plugin&apos;s page, without its settings.
        </span>
        <button type="button" className="primary" disabled={busy || (mode === "people" && chosen.length === 0)} onClick={() => void save()}>
          {busy ? "…" : "save"}
        </button>
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() => {
            setMode(modeOf(access))
            setChosen(access.people)
            setError(undefined)
            setOpen(false)
          }}
        >
          cancel
        </button>
      </div>
    </div>
  )
}
