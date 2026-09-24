/**
 * The OIDC plugin: developers sign in to the gateway with the company's
 * identity provider (Okta, Entra ID, Google Workspace, Keycloak, Authentik,
 * anything OpenID Connect) instead of an invite or a code.
 *
 *   browser  GET /twinny/v1/plugins/oidc/start      → redirect to the provider (PKCE, state, nonce)
 *   provider GET /twinny/v1/plugins/oidc/callback   → code for id_token, verified against the JWKS,
 *                                                     a key minted for the email, VS Code opened with it
 *
 * The key is minted through a one-time invite with `replace`, so signing
 * in again gives a fresh key and revokes the old one, and an email that
 * never opens VS Code holds no seat. Admin routes (api/) hold the
 * settings: issuer, client id and secret, which domains may sign in and
 * which emails become admins.
 */
import { createHash, createPublicKey, createVerify, randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { isRecord } from "../../common/guards"
import { inviteLink } from "../../protocol/types"
import { writePrivateJson } from "../private-file"

import {
  GatewayPlugin,
  json,
  notFound,
  PluginContext,
  PluginError,
  PluginInstance,
  PluginRequest,
  PluginResponse,
  PublicPluginRequest
} from "./host"

const STATE_TTL_MS = 10 * 60_000
const MAX_PENDING = 500
const KEEP_SIGNINS = 50
const FETCH_TIMEOUT_MS = 15_000

export interface OidcSettings {
  issuer: string
  clientId: string
  clientSecret: string
  /** Space-separated; `openid email profile` unless set. */
  scopes: string
  /** Email domains allowed to sign in; empty means anyone the provider vouches for. */
  allowedDomains: string[]
  /** Emails that get an admin key. */
  adminEmails: string[]
  /** The gateway's address as browsers reach it; taken from the request when empty. */
  publicUrl: string
  /** Which claim names the key: `email` unless set (`preferred_username` for providers without emails). */
  nameClaim: string
}

export interface OidcSettingsView extends Omit<OidcSettings, "clientSecret"> {
  clientSecretSet: boolean
}

export interface OidcSignIn {
  at: string
  name: string
  admin: boolean
  ok: boolean
  error?: string
  from?: string
}

interface Discovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  fetchedAt: number
}

interface Pending {
  verifier: string
  nonce: string
  createdAt: number
  redirectUri: string
}

const DEFAULT_SETTINGS: OidcSettings = {
  issuer: "",
  clientId: "",
  clientSecret: "",
  scopes: "openid email profile",
  allowedDomains: [],
  adminEmails: [],
  publicUrl: "",
  nameClaim: "email"
}

const b64url = (data: Buffer | string): string => Buffer.from(data as Uint8Array).toString("base64url")

export const readOidcSettings = (file: string): OidcSettings => {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_SETTINGS }
    throw error
  }
  if (!isRecord(parsed)) return { ...DEFAULT_SETTINGS }
  const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [])
  return {
    issuer: String(parsed.issuer ?? ""),
    clientId: String(parsed.clientId ?? ""),
    clientSecret: String(parsed.clientSecret ?? ""),
    scopes: String(parsed.scopes ?? DEFAULT_SETTINGS.scopes) || DEFAULT_SETTINGS.scopes,
    allowedDomains: list(parsed.allowedDomains),
    adminEmails: list(parsed.adminEmails),
    publicUrl: String(parsed.publicUrl ?? ""),
    nameClaim: String(parsed.nameClaim ?? "email") || "email"
  }
}

/** The page shown after the provider sends the browser back: opens VS Code, with a link in case it does not. */
const landingHtml = (title: string, body: string, link?: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>html,body{margin:0;background:#0d1012;color:#d7dee2;font:15px/1.5 ui-monospace,Menlo,Consolas,monospace}main{max-width:560px;margin:12vh auto;padding:24px;background:#131719;border:1px solid #1f2629;border-radius:8px}h1{font-size:18px;margin:0 0 8px}h1 span{color:#23d18b}p{color:#8b979d}a{color:#23d18b}a.button{display:inline-block;margin-top:10px;padding:8px 14px;background:#23d18b;color:#0d1012;border-radius:5px;text-decoration:none;font-weight:600}</style>
${link ? `<meta http-equiv="refresh" content="1;url=${link.replace(/"/g, "&quot;")}">` : ""}
</head><body><main><h1>twinny<span>-server</span></h1><p>${body}</p>${link ? `<a class="button" href="${link.replace(/"/g, "&quot;")}">Open VS Code</a>` : ""}</main></body></html>
`

export class OidcPlugin implements PluginInstance {
  private _settings: OidcSettings
  private readonly _file: string
  private _discovery: Discovery | undefined
  private _discoveryError: string | undefined
  private readonly _pending = new Map<string, Pending>()
  private readonly _signIns: OidcSignIn[] = []
  private _jwks: { keys: Array<Record<string, unknown>>; fetchedAt: number } | undefined

  constructor(private readonly _context: PluginContext) {
    this._file = path.join(_context.dataDir, "settings.json")
    this._settings = readOidcSettings(this._file)
  }

  public get settings(): OidcSettings {
    return { ...this._settings }
  }

  public start(): void {
    if (this.configured) void this.discover().catch(() => undefined)
  }

  private get configured(): boolean {
    return !!(this._settings.issuer && this._settings.clientId && this._settings.clientSecret)
  }

  private timeout(): AbortSignal {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS).unref()
    return controller.signal
  }

  /** Reads the provider's `.well-known/openid-configuration`, once an hour at most. */
  public async discover(force = false): Promise<Discovery> {
    if (!force && this._discovery && this._context.now() - this._discovery.fetchedAt < 60 * 60_000) return this._discovery
    if (!this._settings.issuer) throw new PluginError("Set the issuer first.", 409)
    const url = `${this._settings.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`
    try {
      const response = await this._context.fetch(url, { signal: this.timeout(), headers: { Accept: "application/json" } })
      if (!response.ok) throw new Error(`the provider answered ${response.status}`)
      const body = (await response.json()) as Record<string, unknown>
      for (const field of ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"]) {
        if (typeof body[field] !== "string") throw new Error(`the discovery document has no ${field}`)
      }
      this._discovery = {
        issuer: body.issuer as string,
        authorization_endpoint: body.authorization_endpoint as string,
        token_endpoint: body.token_endpoint as string,
        jwks_uri: body.jwks_uri as string,
        fetchedAt: this._context.now()
      }
      this._discoveryError = undefined
      return this._discovery
    } catch (error) {
      this._discoveryError = `Discovery at ${url} failed: ${error instanceof Error ? error.message : String(error)}`
      throw new PluginError(this._discoveryError, 502)
    }
  }

  private async jwks(force = false): Promise<Array<Record<string, unknown>>> {
    if (!force && this._jwks && this._context.now() - this._jwks.fetchedAt < 60 * 60_000) return this._jwks.keys
    const discovery = await this.discover()
    const response = await this._context.fetch(discovery.jwks_uri, { signal: this.timeout(), headers: { Accept: "application/json" } })
    if (!response.ok) throw new PluginError(`The provider's keys could not be read (${response.status}).`, 502)
    const body = (await response.json()) as { keys?: unknown }
    const keys = Array.isArray(body.keys) ? body.keys.filter(isRecord) : []
    this._jwks = { keys, fetchedAt: this._context.now() }
    return keys
  }

  /** The gateway's address as the browser sees it. */
  private publicUrl(request: PublicPluginRequest): string {
    if (this._settings.publicUrl) return this._settings.publicUrl.replace(/\/+$/, "")
    const proto = request.headers["x-forwarded-proto"] ?? (request.headers.host?.startsWith("127.0.0.1") || request.headers.host?.startsWith("localhost") ? "http" : "https")
    return `${proto}://${request.headers.host ?? "localhost"}`
  }

  private redirectUri(request: PublicPluginRequest): string {
    return `${this.publicUrl(request)}/twinny/v1/plugins/oidc/callback`
  }

  /** Verifies an RS256 id_token against the provider's keys and this client; returns its claims. */
  public async verifyIdToken(token: string, nonce: string): Promise<Record<string, unknown>> {
    const parts = token.split(".")
    if (parts.length !== 3) throw new PluginError("The provider returned a malformed id_token.", 502)
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as { alg?: string; kid?: string }
    if (header.alg !== "RS256") throw new PluginError(`The id_token is signed with ${header.alg ?? "an unknown algorithm"}; only RS256 is supported.`, 502)
    let keys = await this.jwks()
    let jwk = keys.find((key) => key.kid === header.kid)
    if (!jwk) {
      keys = await this.jwks(true)
      jwk = keys.find((key) => key.kid === header.kid)
    }
    if (!jwk) throw new PluginError("The id_token was signed with a key the provider does not publish.", 502)
    const verifier = createVerify("RSA-SHA256")
    verifier.update(`${parts[0]}.${parts[1]}`)
    if (!verifier.verify(createPublicKey({ key: jwk as Parameters<typeof createPublicKey>[0] extends { key: infer K } ? K : never, format: "jwk" }), parts[2], "base64url"))
      throw new PluginError("The id_token's signature does not verify.", 502)
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>
    const discovery = await this.discover()
    if (claims.iss !== discovery.issuer) throw new PluginError("The id_token was issued by someone else.", 502)
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!aud.includes(this._settings.clientId)) throw new PluginError("The id_token is for another client.", 502)
    if (typeof claims.exp !== "number" || claims.exp * 1000 < this._context.now() - 60_000) throw new PluginError("The id_token has expired.", 502)
    if (claims.nonce !== nonce) throw new PluginError("The id_token does not match this sign-in.", 502)
    return claims
  }

  private prune(): void {
    const now = this._context.now()
    for (const [state, pending] of this._pending) if (now - pending.createdAt > STATE_TTL_MS) this._pending.delete(state)
  }

  private remember(signIn: OidcSignIn): void {
    this._signIns.push(signIn)
    if (this._signIns.length > KEEP_SIGNINS) this._signIns.splice(0, this._signIns.length - KEEP_SIGNINS)
  }

  /** The browser side: start and callback, no credential. */
  public async handlePublic(request: PublicPluginRequest): Promise<PluginResponse> {
    if (!this.configured) return { status: 503, html: landingHtml("Sign-in is not set up", "This gateway's admin has not set up SSO yet.") }
    if (request.path === "start" && request.method === "GET") {
      this.prune()
      if (this._pending.size >= MAX_PENDING) return { status: 429, html: landingHtml("Too many sign-ins", "Too many sign-ins are waiting. Try again in a few minutes.") }
      const discovery = await this.discover()
      const state = randomBytes(24).toString("base64url")
      const verifier = randomBytes(48).toString("base64url")
      const nonce = randomBytes(24).toString("base64url")
      const redirectUri = this.redirectUri(request)
      this._pending.set(state, { verifier, nonce, createdAt: this._context.now(), redirectUri })
      const url = new URL(discovery.authorization_endpoint)
      url.searchParams.set("response_type", "code")
      url.searchParams.set("client_id", this._settings.clientId)
      url.searchParams.set("redirect_uri", redirectUri)
      url.searchParams.set("scope", this._settings.scopes)
      url.searchParams.set("state", state)
      url.searchParams.set("nonce", nonce)
      url.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()))
      url.searchParams.set("code_challenge_method", "S256")
      return { status: 302, body: null, headers: { Location: url.toString() } }
    }
    if (request.path === "callback" && request.method === "GET") {
      this.prune()
      const state = request.query.get("state") ?? ""
      const pending = this._pending.get(state)
      this._pending.delete(state)
      const fail = (message: string, name = "?") => {
        this.remember({ at: new Date(this._context.now()).toISOString(), name, admin: false, ok: false, error: message, from: request.address })
        this._context.log.warn({ event: "plugin.oidc-refused", reason: name, message })
        return { status: 400, html: landingHtml("Sign-in failed", message) }
      }
      if (!pending) return fail("This sign-in is unknown or took longer than ten minutes. Start again.")
      const providerError = request.query.get("error")
      if (providerError) return fail(`The provider refused: ${providerError}${request.query.get("error_description") ? ` (${request.query.get("error_description")})` : ""}.`)
      const code = request.query.get("code")
      if (!code) return fail("The provider sent no code back.")
      const discovery = await this.discover()
      const form = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: pending.redirectUri,
        client_id: this._settings.clientId,
        client_secret: this._settings.clientSecret,
        code_verifier: pending.verifier
      })
      let tokens: Record<string, unknown>
      try {
        const response = await this._context.fetch(discovery.token_endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: form.toString(),
          signal: this.timeout()
        })
        tokens = (await response.json()) as Record<string, unknown>
        if (!response.ok) return fail(`The provider would not exchange the code: ${String(tokens.error ?? response.status)}${tokens.error_description ? ` (${String(tokens.error_description)})` : ""}.`)
      } catch (error) {
        return fail(`The provider's token endpoint failed: ${error instanceof Error ? error.message : String(error)}.`)
      }
      let claims: Record<string, unknown>
      try {
        claims = await this.verifyIdToken(String(tokens.id_token ?? ""), pending.nonce)
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
      const name = typeof claims[this._settings.nameClaim] === "string" ? (claims[this._settings.nameClaim] as string).trim().toLowerCase() : ""
      if (!name) return fail(`The provider sent no "${this._settings.nameClaim}" claim; add the scope that carries it, or change the name claim.`)
      if (claims.email_verified === false) return fail(`${name} is not a verified address at the provider.`, name)
      const domain = name.includes("@") ? name.slice(name.lastIndexOf("@") + 1) : ""
      if (this._settings.allowedDomains.length && !this._settings.allowedDomains.some((d) => d.toLowerCase() === domain))
        return fail(`${name} is not in a domain this gateway allows.`, name)
      if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/.test(name)) return fail(`"${name}" cannot be a key name.`, name)
      const admin = this._settings.adminEmails.some((e) => e.toLowerCase() === name)
      if (!this._context.invites) return fail("This gateway cannot mint keys for plugins.", name)
      let code_: string
      try {
        code_ = (await this._context.invites.create({ name, admin, replace: true, ttlMs: 10 * 60_000, createdBy: "oidc" })).code
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error), name)
      }
      this.remember({ at: new Date(this._context.now()).toISOString(), name, admin, ok: true, from: request.address })
      this._context.log.info({ event: "plugin.oidc-signed-in", key: name, ...(admin ? { admin: true } : {}) })
      this._context.events?.emit({ type: "signin.sso", source: "oidc", level: "info", title: `${name} signed in with SSO`, text: admin ? "As an admin." : "", data: { name, admin } })
      const link = inviteLink(this.publicUrl(request), code_)
      return { status: 200, html: landingHtml("Signed in", `Welcome, <b>${name}</b>. VS Code is opening to connect you${admin ? " as an admin" : ""}. If it does not, press the button; the link works once and for ten minutes.`, link) }
    }
    return notFound()
  }

  private view(): OidcSettingsView {
    const { clientSecret, ...rest } = this._settings
    return { ...rest, clientSecretSet: !!clientSecret }
  }

  private overview(request?: PluginRequest) {
    return {
      settings: this.view(),
      configured: this.configured,
      discovery: this._discovery ? { issuer: this._discovery.issuer, authorization: this._discovery.authorization_endpoint } : null,
      discoveryError: this._discoveryError,
      signIns: [...this._signIns].reverse(),
      startPath: "/twinny/v1/plugins/oidc/start",
      callbackPath: "/twinny/v1/plugins/oidc/callback",
      pending: this._pending.size,
      ...(request ? {} : {})
    }
  }

  public async handle(request: PluginRequest): Promise<PluginResponse> {
    const { method, path: route } = request
    if (route === "" && method === "GET") return json(this.overview(request))
    if (route === "settings" && method === "PUT") {
      const body = await request.body()
      const next: OidcSettings = { ...this._settings }
      const text = (value: unknown, fallback: string) => (typeof value === "string" ? value.trim() : fallback)
      const list = (value: unknown, fallback: string[]) =>
        Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").map((v) => v.trim().toLowerCase()).filter(Boolean) : typeof value === "string" ? value.split(/[,\s]+/).map((v) => v.trim().toLowerCase()).filter(Boolean) : fallback
      if (body.issuer !== undefined) {
        next.issuer = text(body.issuer, "")
        if (next.issuer && !/^https?:\/\//.test(next.issuer)) throw new PluginError("The issuer is a URL, e.g. https://login.example.com/realms/dev.", 400)
      }
      if (body.clientId !== undefined) next.clientId = text(body.clientId, "")
      if (typeof body.clientSecret === "string" && body.clientSecret) next.clientSecret = body.clientSecret
      if (body.scopes !== undefined) next.scopes = text(body.scopes, DEFAULT_SETTINGS.scopes) || DEFAULT_SETTINGS.scopes
      if (!/\bopenid\b/.test(next.scopes)) next.scopes = `openid ${next.scopes}`.trim()
      if (body.allowedDomains !== undefined) next.allowedDomains = list(body.allowedDomains, [])
      if (body.adminEmails !== undefined) next.adminEmails = list(body.adminEmails, [])
      if (body.publicUrl !== undefined) {
        next.publicUrl = text(body.publicUrl, "").replace(/\/+$/, "")
        if (next.publicUrl && !/^https?:\/\//.test(next.publicUrl)) throw new PluginError("The public URL starts with https://.", 400)
      }
      if (body.nameClaim !== undefined) next.nameClaim = text(body.nameClaim, "email") || "email"
      writePrivateJson(this._file, next)
      const issuerChanged = next.issuer !== this._settings.issuer
      this._settings = next
      if (issuerChanged) {
        this._discovery = undefined
        this._jwks = undefined
        this._discoveryError = undefined
      }
      this._context.log.info({ event: "plugin.oidc-settings", key: request.principal })
      if (this.configured) await this.discover(true).catch(() => undefined)
      return json(this.overview(request))
    }
    if (route === "check" && method === "POST") {
      const discovery = await this.discover(true)
      await this.jwks(true)
      return json({ ok: true, issuer: discovery.issuer, authorization: discovery.authorization_endpoint })
    }
    return notFound()
  }
}

export const oidcPlugin: GatewayPlugin = {
  id: "oidc",
  name: "SSO sign-in",
  description:
    "Developers sign in with your identity provider (Okta, Entra ID, Google Workspace, Keycloak, any OpenID Connect) and VS Code connects with a key of their own; no invites or codes.",
  create: (context) => new OidcPlugin(context)
}
