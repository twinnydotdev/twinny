import React, { FormEvent, useEffect, useState } from "react"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"

import { PROVIDER_EVENT_NAME } from "../../common/constants"
import { messageOf } from "../../common/errors"
import type { TeamOpen, TeamPolicy, TeamPreview, TeamSignInStart } from "../../common/team"
import { describePooling, describeRecording } from "../../common/team-policy"
import { bridge, emit } from "../messaging"

import styles from "../styles/providers.module.css"

const LABELS = { chat: "Chat", fim: "Autocomplete", embedding: "Embeddings" }

/** The same lines the extension enforces, worded for the person agreeing to them. */
export const policyLines = (policy: TeamPolicy): string[] => {
  const lines: string[] = []
  if (policy.teamOnly) {
    lines.push("You can use only the team gateway: no other providers can be added or made active.")
  }
  if (policy.lockDefaults) {
    lines.push("The team's default models stay active for chat, autocomplete and embeddings.")
  }
  const recording = describeRecording(policy.recording)
  if (recording) lines.push(recording)
  const pooling = describePooling(policy.peers)
  if (pooling) lines.push(pooling)
  return lines
}

interface ConnectTeamProps {
  onClose: () => void
  /** Connected: go and use it (the chat tab). */
  onDone?: () => void
  /** The connected team, when reconnecting: its URL is filled in and its key reused. */
  connected?: { url: string; keyMissing?: boolean }
  /** An invite or team link that was just opened in VS Code. */
  open?: TeamOpen
}

export const ConnectTeam = ({ onClose, onDone, connected, open }: ConnectTeamProps) => {
  const [url, setUrl] = useState(open?.url ?? connected?.url ?? "")
  const [token, setToken] = useState("")
  const [preview, setPreview] = useState<TeamPreview | null>(open?.invite?.preview ?? null)
  const [replace, setReplace] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(open?.error ?? "")
  const [signIn, setSignIn] = useState<TeamSignInStart | null>(null)
  const [invited, setInvited] = useState<string | null>(open?.invite?.name ?? null)
  // Invite and sign-in keys stay in the extension while the preview is
  // edited. Remember only their URL so rechecking never needs a new key.
  const [heldKeyUrl, setHeldKeyUrl] = useState(open?.invite?.preview.url ?? "")
  useEffect(() => () => emit(PROVIDER_EVENT_NAME.cancelTeam), [])
  // A second link opened while this view is up replaces what it shows.
  useEffect(() => {
    if (!open) return
    setUrl(open.url)
    setPreview(open.invite?.preview ?? null)
    setInvited(open.invite?.name ?? null)
    setError(open.error ?? "")
    setSignIn(null)
    setHeldKeyUrl(open.invite?.preview.url ?? "")
    setToken("")
    setReplace(false)
  }, [open])

  // While a sign-in is waiting on the admin, ask the extension (which
  // holds the device code) at the gateway's interval until it resolves.
  useEffect(() => {
    if (!signIn) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const status = await bridge.request(PROVIDER_EVENT_NAME.pollTeamSignIn, { id: signIn.id })
        if (stopped) return
        switch (status.status) {
          case "pending":
            timer = setTimeout(() => void tick(), signIn.intervalMs)
            return
          case "approved":
            setPreview(status.preview)
            setHeldKeyUrl(status.preview.url)
            setSignIn(null)
            return
          case "denied":
            setError("Your admin denied the sign-in request.")
            setSignIn(null)
            return
          case "expired":
            setError("The sign-in code expired before it was approved. Request a new one.")
            setSignIn(null)
            return
        }
      } catch (error) {
        if (stopped) return
        setError(messageOf(error))
        setSignIn(null)
      }
    }
    void tick()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [signIn])

  const requestKey = async () => {
    if (busy || !url.trim()) return
    setBusy(true)
    setError("")
    try {
      setSignIn(await bridge.request(PROVIDER_EVENT_NAME.startTeamSignIn, { url }))
    } catch (error) {
      setError(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const check = async (event?: FormEvent) => {
    event?.preventDefault()
    if (busy) return
    setBusy(true)
    setError("")
    setReplace(false)
    try {
      const checked = await bridge.request(PROVIDER_EVENT_NAME.previewTeam, { url, token })
      setPreview(checked)
      setHeldKeyUrl(checked.url)
    } catch (error) {
      setPreview(null)
      setError(messageOf(error))
    } finally {
      setBusy(false)
    }
  }
  const connect = async () => {
    if (!preview || busy) return
    setBusy(true)
    setError("")
    try {
      // One click: applied, told about it by VS Code, and straight to the
      // chat when there is one. Nothing more to confirm here.
      const applied = await bridge.request(PROVIDER_EVENT_NAME.applyTeam, {
        previewId: preview.id,
        replaceExisting: replace
      })
      setToken("")
      if (onDone && applied.connected.includes("chat")) onDone()
      else onClose()
      return
    } catch (error) {
      setError(messageOf(error))
    } finally {
      setBusy(false)
    }
  }
  const configured = preview?.roles.filter((role) => !!role.alias) ?? []
  const replacing = configured.filter((role) => role.current)
  // Same gateway as the connected team and a key on this machine: the
  // stored key is used unless a new one is typed.
  const keyOnFile =
    !!connected && !connected.keyMissing && url.trim().replace(/\/+$/, "") === connected.url
  const keyHeld = !!heldKeyUrl && url.trim().replace(/\/+$/, "") === heldKeyUrl
  return (
    <section className={styles.teamConnect}>
      <VSCodeButton appearance="secondary" disabled={busy} onClick={onClose}>
        Back to providers
      </VSCodeButton>
      <h3>{invited && preview ? `Welcome, ${invited}` : connected ? "Reconnect to team" : "Connect to team"}</h3>
      <p>
        {invited && preview
          ? "Your invite opened and your key is ready. Confirm the team's models below to finish."
          : connected
            ? "Checks the team's current defaults again and applies them. Your key stays as it is."
            : "One gateway connection for your team's chat, autocomplete and embeddings."}
      </p>
      {connected?.keyMissing && !preview && !signIn && (
        <p className={styles.teamHint} role="alert">
          Your key for this team is gone from VS Code's secret storage. Paste it if you still have it, or request a new one.
        </p>
      )}
      {!preview && signIn && (
        <div className={styles.teamSignIn} role="status">
          <p>Give this code to your gateway admin:</p>
          <code className={styles.teamCode}>{signIn.userCode}</code>
          <p className={styles.teamHint}>
            They approve it on the gateway's admin page and choose your key
            name. Your key then arrives here by itself. The code is good for
            ten minutes.
          </p>
          <p className={styles.teamHint}>Waiting for approval…</p>
          <VSCodeButton
            appearance="secondary"
            onClick={() => {
              emit(PROVIDER_EVENT_NAME.cancelTeam)
              setSignIn(null)
            }}
          >
            Cancel
          </VSCodeButton>
        </div>
      )}
      {!preview && !signIn && (
        <form onSubmit={(event) => void check(event)}>
          <label className={styles.teamField}>
            Gateway URL
            <input
              type="url"
              required
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://ai.example.com"
              disabled={busy}
              autoComplete="off"
            />
          </label>
          <label className={styles.teamField}>
            {keyOnFile ? "Personal key (optional: yours is on file)" : keyHeld ? "Personal key (optional: ready for this connection)" : "Personal key"}
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={keyOnFile || keyHeld ? "Leave blank to keep your current key" : "tsk_…"}
              disabled={busy}
              autoComplete="off"
            />
          </label>
          <p className={styles.teamHint}>
            {keyOnFile || keyHeld
              ? "Your current key is used unless you paste another. Request a key only if your admin has replaced yours."
              : "Ask your admin for these details, or request a key: you get a short code to give your admin, and the key arrives here once they approve it. Your key goes into VS Code's secret storage when you connect."}
          </p>
          <div className={styles.teamActions}>
            <VSCodeButton
              type="submit"
              disabled={busy || !url.trim() || (!token.trim() && !keyOnFile && !keyHeld)}
            >
              {busy ? "Checking access…" : "Check connection"}
            </VSCodeButton>
            <VSCodeButton
              appearance="secondary"
              disabled={busy || !url.trim()}
              onClick={() => void requestKey()}
            >
              Request a key
            </VSCodeButton>
          </div>
        </form>
      )}
      {preview && (
        <>
          <div className={styles.teamIdentity}>
            <strong>{preview.identity}</strong>
            <span>{preview.url}</span>
          </div>
          <ul className={styles.teamRoles}>
            {preview.roles.map((role) => (
              <li key={role.type}>
                <div className={styles.teamRoleHeading}>
                  <strong>{LABELS[role.type]}</strong>
                  <span>{role.alias ? "Team default" : "Not configured"}</span>
                </div>
                {role.alias && <code>{role.alias}</code>}
                {!role.alias && (
                  <p>Your admin has not selected a default for this feature.</p>
                )}
                {role.current && role.alias && (
                  <p className={styles.teamHint}>
                    Will replace active setting: {role.current.label} ·{" "}
                    {role.current.modelName}
                  </p>
                )}
                {!role.alias && (
                  <p className={styles.teamHint}>
                    Your current setting stays unchanged.
                  </p>
                )}
              </li>
            ))}
          </ul>
          {preview.policy && (
            <div className={styles.teamPolicy}>
              <strong>Your team sets a policy</strong>
              <ul>
                {policyLines(preview.policy).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <p className={styles.teamHint}>
                It applies while you are connected. You can leave the team from
                the Providers tab at any time.
              </p>
            </div>
          )}
          <>
              {configured.length > 0 && (
                <p className={styles.teamHint}>
                  Nothing is sent to the models before you connect. Your admin
                  keeps them working on the gateway; to try one yourself, use
                  Test Provider on its card in the Providers tab.
                </p>
              )}
              {replacing.length > 0 && (
                <label className={styles.teamConsent}>
                  <input
                    type="checkbox"
                    checked={replace}
                    disabled={busy}
                    onChange={(event) => setReplace(event.target.checked)}
                  />
                  Replace my active{" "}
                  {replacing
                    .map((role) => LABELS[role.type].toLowerCase())
                    .join(", ")}{" "}
                  settings. Keep my existing providers available.
                </label>
              )}
              {!configured.length && (
                <p className={styles.teamHint}>
                  Your admin has not set a default model for any feature yet.
                  Ask them to, then check again.
                </p>
              )}
              <div className={styles.teamActions}>
                <VSCodeButton
                  disabled={
                    busy || !configured.length || (replacing.length > 0 && !replace)
                  }
                  onClick={() => void connect()}
                >
                  {busy ? "Connecting…" : "Connect"}
                </VSCodeButton>
                <VSCodeButton
                  appearance="secondary"
                  disabled={busy}
                  onClick={() => {
                    emit(PROVIDER_EVENT_NAME.cancelTeam)
                    setPreview(null)
                    setError("")
                  }}
                >
                  Cancel
                </VSCodeButton>
              </div>
          </>
        </>
      )}
      {error && (
        <p role="alert" className={styles.teamError}>
          {error}
        </p>
      )}
    </section>
  )
}
