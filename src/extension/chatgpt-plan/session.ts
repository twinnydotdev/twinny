import * as crypto from "crypto"
import * as http from "http"
import { AddressInfo } from "net"
import { env, ExtensionContext, Uri } from "vscode"

const ISSUER = "https://auth.openai.com"
const RESOURCE = "https://api.openai.com/v1"
const DYNAMIC_CLIENT_ID = "dynamic_agent_client"
const AGENT_NAME = "Twinny"
const CALLBACK_PATH = "/auth/callback"
const HOST_ID_KEY = "twinny.chatgpt-plan.host-id"
const PROFILE_KEY = "twinny.chatgpt-plan.profile"
const CREDENTIALS_KEY = "twinny.chatgpt-plan.credentials"
const REQUIRED_SCOPE = "chatgpt.tokens.use.direct"
const SCOPES = [
  REQUIRED_SCOPE,
  "email",
  "offline_access",
  "openid",
  "profile",
  "resource.invoke"
]
const REFRESH_SKEW_MS = 60_000
const CALLBACK_TIMEOUT_MS = 5 * 60_000

interface OpenIdConfiguration {
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  revocation_endpoint?: string
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  id_token?: string
  token_type?: string
  expires_in: number
  scope?: string
  earliest_refresh_at?: number
}

interface ChatGPTPlanProfile {
  clientId: string
  subject: string
  email?: string
  name?: string
}

interface ChatGPTPlanCredentials {
  accessToken: string
  refreshToken: string
  idToken: string
  expiresAt: number
  earliestRefreshAt?: number
  scopes: string[]
}

export interface ChatGPTPlanStatus {
  connected: boolean
  sharing: boolean
  email?: string
  name?: string
  clientId?: string
}

export interface ChatGPTPlanSessionDependencies {
  fetch?: typeof fetch
  now?: () => number
}

export class ChatGPTPlanSessionError extends Error {
  constructor(
    public readonly code:
      | "not-signed-in"
      | "plan-not-enabled"
      | "reauthentication-required"
      | "oauth-failed",
    message: string
  ) {
    super(message)
    this.name = "ChatGPTPlanSessionError"
  }
}

interface CallbackResult {
  code: string
  clientId?: string
}

const shared = new WeakMap<ExtensionContext, ChatGPTPlanSession>()

const base64Url = (input: Buffer) =>
  input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")

const fromBase64Url = (input: string) => {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (input.length % 4)) % 4)
  return Buffer.from(padded, "base64")
}

const randomValue = (bytes = 32) => base64Url(crypto.randomBytes(bytes))
const challengeFor = (verifier: string) =>
  base64Url(crypto.createHash("sha256").update(verifier).digest())

const scopesOf = (scope: string | undefined) =>
  (scope || "")
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean)

const json = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim().slice(0, 500)
    throw new ChatGPTPlanSessionError(
      response.status === 400 || response.status === 401
        ? "reauthentication-required"
        : "oauth-failed",
      `OpenAI OAuth request failed (${response.status})${detail ? `: ${detail}` : ""}`
    )
  }
  return (await response.json()) as T
}

export class ChatGPTPlanSession {
  private _discovery?: Promise<OpenIdConfiguration>
  private _refresh?: Promise<ChatGPTPlanCredentials>

  public static shared(context: ExtensionContext) {
    const existing = shared.get(context)
    if (existing) return existing
    const created = new ChatGPTPlanSession(context)
    shared.set(context, created)
    return created
  }

  constructor(
    private readonly _context: ExtensionContext,
    private readonly _dependencies: ChatGPTPlanSessionDependencies = {}
  ) {}

  private request(input: RequestInfo | URL, init?: RequestInit) {
    return (this._dependencies.fetch || fetch)(input, init)
  }

  private now() {
    return this._dependencies.now ? this._dependencies.now() : Date.now()
  }

  public async status(): Promise<ChatGPTPlanStatus> {
    const profile = this._context.globalState.get<ChatGPTPlanProfile>(PROFILE_KEY)
    const credentials = await this.readCredentials()
    return {
      connected: !!profile && !!credentials,
      sharing: !!credentials?.scopes.includes(REQUIRED_SCOPE),
      email: profile?.email,
      name: profile?.name,
      clientId: profile?.clientId
    }
  }

  public async getAccessToken(): Promise<string> {
    const credentials = await this.readCredentials()
    if (!credentials) {
      throw new ChatGPTPlanSessionError(
        "not-signed-in",
        "Sign in with ChatGPT before using this provider."
      )
    }
    if (!credentials.scopes.includes(REQUIRED_SCOPE)) {
      throw new ChatGPTPlanSessionError(
        "plan-not-enabled",
        "ChatGPT plan usage was not authorized for Twinny."
      )
    }

    const now = this.now()
    if (credentials.expiresAt - now > REFRESH_SKEW_MS) {
      return credentials.accessToken
    }
    if (
      credentials.earliestRefreshAt &&
      now < credentials.earliestRefreshAt &&
      now < credentials.expiresAt
    ) {
      return credentials.accessToken
    }

    const refreshed = await this.refresh(credentials)
    return refreshed.accessToken
  }

  public async signIn(): Promise<ChatGPTPlanStatus> {
    const discovery = await this.discovery()
    const profile = this._context.globalState.get<ChatGPTPlanProfile>(PROFILE_KEY)
    const previous = await this.readCredentials()
    const hostId = await this.hostId()

    const state = randomValue()
    const nonce = randomValue()
    const verifier = randomValue(48)
    const callback = await this.callback(state)

    const initial = !profile?.clientId
    const clientId = profile?.clientId || DYNAMIC_CLIENT_ID
    const authorize = new URL(discovery.authorization_endpoint)
    authorize.searchParams.set("client_id", clientId)
    authorize.searchParams.set("ext_agent_host_id", hostId)
    if (initial) authorize.searchParams.set("agent_name_hint", AGENT_NAME)
    if (!initial && previous?.idToken) {
      authorize.searchParams.set("id_token_hint", previous.idToken)
    }
    if (!initial && profile?.email) {
      authorize.searchParams.set("login_hint", profile.email)
    }
    authorize.searchParams.set("response_type", "code")
    authorize.searchParams.set("redirect_uri", callback.redirectUri)
    authorize.searchParams.set("scope", SCOPES.join(" "))
    authorize.searchParams.set("resource", RESOURCE)
    authorize.searchParams.set("state", state)
    authorize.searchParams.set("nonce", nonce)
    authorize.searchParams.set("code_challenge_method", "S256")
    authorize.searchParams.set("code_challenge", challengeFor(verifier))

    const opened = await env.openExternal(Uri.parse(authorize.toString()))
    if (!opened) {
      callback.cancel()
      throw new ChatGPTPlanSessionError(
        "oauth-failed",
        "VS Code could not open the ChatGPT sign-in page."
      )
    }

    const returned = await callback.result
    const issuedClientId = initial
      ? returned.clientId
      : profile?.clientId

    if (!issuedClientId) {
      throw new ChatGPTPlanSessionError(
        "oauth-failed",
        "OpenAI did not return an issued client ID for this registration."
      )
    }
    if (!initial && returned.clientId && returned.clientId !== issuedClientId) {
      throw new ChatGPTPlanSessionError(
        "oauth-failed",
        "OpenAI returned a different client ID for the existing ChatGPT account."
      )
    }

    const token = await this.exchangeCode(
      discovery.token_endpoint,
      issuedClientId,
      returned.code,
      verifier,
      callback.redirectUri
    )
    if (!token.id_token || !token.refresh_token) {
      throw new ChatGPTPlanSessionError(
        "oauth-failed",
        "OpenAI did not return the identity and renewable session credentials."
      )
    }

    const identity = await this.verifyIdToken(
      token.id_token,
      issuedClientId,
      nonce,
      discovery.jwks_uri
    )
    if (profile && identity.subject !== profile.subject) {
      throw new ChatGPTPlanSessionError(
        "oauth-failed",
        "The returned ChatGPT identity does not match the selected account."
      )
    }

    const scopes = scopesOf(token.scope)
    const credentials: ChatGPTPlanCredentials = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      idToken: token.id_token,
      expiresAt: this.now() + token.expires_in * 1000,
      earliestRefreshAt:
        typeof token.earliest_refresh_at === "number"
          ? token.earliest_refresh_at * 1000
          : undefined,
      scopes
    }
    await this.writeCredentials(credentials)
    await this._context.globalState.update(PROFILE_KEY, {
      clientId: issuedClientId,
      subject: identity.subject,
      email: identity.email,
      name: identity.name
    } as ChatGPTPlanProfile)

    return this.status()
  }

  public async signOut(): Promise<void> {
    const profile = this._context.globalState.get<ChatGPTPlanProfile>(PROFILE_KEY)
    const credentials = await this.readCredentials()
    if (profile && credentials) {
      try {
        const discovery = await this.discovery()
        if (discovery.revocation_endpoint) {
          const body = new URLSearchParams({
            token: credentials.refreshToken,
            token_type_hint: "refresh_token",
            client_id: profile.clientId
          })
          await this.request(discovery.revocation_endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString()
          })
        }
      } catch {
        // Signing out locally must still succeed. The retained registration
        // lets the user reconnect later with the same issued client ID.
      }
    }
    await this._context.secrets.delete(CREDENTIALS_KEY)
  }

  private async hostId(): Promise<string> {
    const existing = this._context.globalState.get<string>(HOST_ID_KEY)
    if (existing) return existing
    const id = `urn:uuid:${crypto.randomUUID()}`
    await this._context.globalState.update(HOST_ID_KEY, id)
    return id
  }

  private discovery() {
    if (!this._discovery) {
      this._discovery = this.request(
        `${ISSUER}/.well-known/openid-configuration`
      ).then((response) => json<OpenIdConfiguration>(response))
    }
    return this._discovery
  }

  private async readCredentials(): Promise<ChatGPTPlanCredentials | undefined> {
    const raw = await this._context.secrets.get(CREDENTIALS_KEY)
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as ChatGPTPlanCredentials
    } catch {
      await this._context.secrets.delete(CREDENTIALS_KEY)
      return undefined
    }
  }

  private writeCredentials(credentials: ChatGPTPlanCredentials) {
    return this._context.secrets.store(CREDENTIALS_KEY, JSON.stringify(credentials))
  }

  private async refresh(
    current: ChatGPTPlanCredentials
  ): Promise<ChatGPTPlanCredentials> {
    if (this._refresh) return this._refresh
    this._refresh = (async () => {
      const profile = this._context.globalState.get<ChatGPTPlanProfile>(PROFILE_KEY)
      if (!profile) {
        throw new ChatGPTPlanSessionError(
          "reauthentication-required",
          "The ChatGPT registration is missing. Sign in again."
        )
      }
      const discovery = await this.discovery()
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: profile.clientId,
        refresh_token: current.refreshToken,
        resource: RESOURCE
      })
      const token = await json<TokenResponse>(
        await this.request(discovery.token_endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString()
        })
      )
      if (!token.refresh_token) {
        throw new ChatGPTPlanSessionError(
          "reauthentication-required",
          "OpenAI did not return the rotated refresh token. Sign in again."
        )
      }
      const scopes = token.scope ? scopesOf(token.scope) : current.scopes
      const next: ChatGPTPlanCredentials = {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        idToken: token.id_token || current.idToken,
        expiresAt: this.now() + token.expires_in * 1000,
        earliestRefreshAt:
          typeof token.earliest_refresh_at === "number"
            ? token.earliest_refresh_at * 1000
            : undefined,
        scopes
      }
      await this.writeCredentials(next)
      return next
    })()
    try {
      return await this._refresh
    } finally {
      this._refresh = undefined
    }
  }

  private async exchangeCode(
    endpoint: string,
    clientId: string,
    code: string,
    verifier: string,
    redirectUri: string
  ) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: RESOURCE
    })
    return json<TokenResponse>(
      await this.request(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString()
      })
    )
  }

  private async callback(state: string): Promise<{
    redirectUri: string
    result: Promise<CallbackResult>
    cancel(): void
  }> {
    let settle: ((value: CallbackResult) => void) | undefined
    let reject: ((error: Error) => void) | undefined
    const result = new Promise<CallbackResult>((resolve, fail) => {
      settle = resolve
      reject = fail
    })

    const server = http.createServer((request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1")
      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404)
        response.end("Not found")
        return
      }
      const returnedState = url.searchParams.get("state")
      if (returnedState !== state) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
        response.end("Invalid OAuth state. Return to VS Code and try again.")
        reject?.(
          new ChatGPTPlanSessionError(
            "oauth-failed",
            "ChatGPT sign-in returned an invalid OAuth state."
          )
        )
        server.close()
        return
      }
      const oauthError = url.searchParams.get("error")
      const code = url.searchParams.get("code")
      if (oauthError || !code) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
        response.end("ChatGPT sign-in was not completed. Return to VS Code.")
        reject?.(
          new ChatGPTPlanSessionError(
            "oauth-failed",
            `ChatGPT sign-in failed: ${oauthError || "authorization code missing"}.`
          )
        )
        server.close()
        return
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      response.end(
        "<!doctype html><title>Twinny connected</title><p>ChatGPT is connected to Twinny. You can close this tab and return to VS Code.</p>"
      )
      settle?.({
        code,
        clientId: url.searchParams.get("client_id") || undefined
      })
      server.close()
    })

    await new Promise<void>((resolve, rejectListen) => {
      server.once("error", rejectListen)
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address() as AddressInfo
    const redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`
    const timer = setTimeout(() => {
      reject?.(
        new ChatGPTPlanSessionError(
          "oauth-failed",
          "ChatGPT sign-in timed out."
        )
      )
      server.close()
    }, CALLBACK_TIMEOUT_MS)

    return {
      redirectUri,
      result: result.finally(() => clearTimeout(timer)),
      cancel: () => {
        clearTimeout(timer)
        server.close()
      }
    }
  }

  private async verifyIdToken(
    token: string,
    clientId: string,
    nonce: string,
    jwksUri: string
  ): Promise<{ subject: string; email?: string; name?: string }> {
    const parts = token.split(".")
    if (parts.length !== 3) {
      throw new ChatGPTPlanSessionError("oauth-failed", "OpenAI returned an invalid ID token.")
    }
    const header = JSON.parse(fromBase64Url(parts[0]).toString("utf8")) as {
      alg?: string
      kid?: string
    }
    if (header.alg !== "RS256" || !header.kid) {
      throw new ChatGPTPlanSessionError(
        "oauth-failed",
        "OpenAI returned an unsupported ID-token signature."
      )
    }
    type OpenAIJwk = crypto.JsonWebKey & { kid?: string }
    const jwks = await json<{ keys: OpenAIJwk[] }>(await this.request(jwksUri))
    const jwk = jwks.keys.find((candidate) => candidate.kid === header.kid)
    if (!jwk) {
      throw new ChatGPTPlanSessionError("oauth-failed", "OpenAI ID-token signing key was not found.")
    }
    const key = crypto.createPublicKey({ key: jwk, format: "jwk" })
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`)
    const signature = fromBase64Url(parts[2])
    if (!crypto.verify("RSA-SHA256", signed, key, signature)) {
      throw new ChatGPTPlanSessionError("oauth-failed", "OpenAI ID-token signature validation failed.")
    }

    const claims = JSON.parse(fromBase64Url(parts[1]).toString("utf8")) as {
      iss?: string
      aud?: string | string[]
      exp?: number
      nonce?: string
      sub?: string
      email?: string
      name?: string
    }
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (
      claims.iss !== ISSUER ||
      !audience.includes(clientId) ||
      !claims.exp ||
      claims.exp * 1000 <= this.now() ||
      claims.nonce !== nonce ||
      !claims.sub
    ) {
      throw new ChatGPTPlanSessionError("oauth-failed", "OpenAI ID-token claims validation failed.")
    }
    return {
      subject: claims.sub,
      email: claims.email,
      name: claims.name
    }
  }
}
