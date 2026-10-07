import * as assert from "assert"
import * as crypto from "crypto"
import * as http from "http"
import { ExtensionContext, Uri } from "vscode"

import {
  ChatGPTPlanSession,
  ChatGPTPlanSessionDependencies,
  ChatGPTPlanSessionError} from "../../extension/chatgpt-plan/session"

const CREDENTIALS_KEY = "twinny.chatgpt-plan.credentials"
const PROFILE_KEY = "twinny.chatgpt-plan.profile"
const REQUIRED_SCOPE = "chatgpt.tokens.use.direct"
const NOW = 1_800_000_000_000

interface StoredContext {
  context: ExtensionContext
  state: Map<string, unknown>
  readCredentials(): string | undefined
}

const contextWith = (
  credentials?: Record<string, unknown>,
  profile?: Record<string, unknown>
): StoredContext => {
  let stored = credentials
    ? JSON.stringify({
        clientId: profile?.clientId,
        subject: profile?.subject,
        ...credentials
      })
    : undefined
  const state = new Map<string, unknown>()
  if (profile) state.set(PROFILE_KEY, profile)
  return {
    context: {
      globalState: {
        get: <T>(key: string) => state.get(key) as T | undefined,
        update: async (key: string, value: unknown) => {
          if (value === undefined) state.delete(key)
          else state.set(key, value)
        }
      },
      secrets: {
        get: async (key: string) =>
          key === CREDENTIALS_KEY ? stored : undefined,
        store: async (key: string, value: string) => {
          if (key === CREDENTIALS_KEY) stored = value
        },
        delete: async (key: string) => {
          if (key === CREDENTIALS_KEY) stored = undefined
        }
      }
    } as unknown as ExtensionContext,
    state,
    readCredentials: () => stored
  }
}

const discovery = (revocation = false) =>
  new Response(
    JSON.stringify({
      authorization_endpoint: "https://auth.openai.com/api/accounts/authorize",
      token_endpoint: "https://auth.openai.com/api/accounts/oauth/token",
      jwks_uri: "https://auth.openai.com/.well-known/jwks.json",
      ...(revocation
        ? {
            revocation_endpoint:
              "https://auth.openai.com/api/accounts/oauth/revoke"
          }
        : {})
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  )

const get = (url: string) =>
  new Promise<void>((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.resume()
      response.once("end", resolve)
    })
    request.once("error", reject)
  })

const base64Url = (value: Buffer | string) =>
  Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")

const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
const otherKeys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
const publicJwk = keys.publicKey.export({ format: "jwk" }) as crypto.JsonWebKey

const idToken = (
  claims: Record<string, unknown>,
  privateKey: crypto.KeyObject = keys.privateKey,
  kid = "test-key"
) => {
  const header = base64Url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }))
  const payload = base64Url(JSON.stringify(claims))
  const signature = crypto.sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    privateKey
  )
  return `${header}.${payload}.${base64Url(signature)}`
}

type CallbackKind =
  | "success"
  | "invalid-state"
  | "missing-code"
  | "oauth-error"
  | "timeout"

interface SignInOptions {
  callback?: CallbackKind
  claims?: Record<string, unknown>
  scope?: string
  refreshToken?: string | null
  signingKey?: crypto.KeyObject
  jwksKid?: string
}

const signInFixture = (options: SignInOptions = {}) => {
  const stored = contextWith()
  let authorize: URL | undefined
  let nonce = ""
  const callbackKind = options.callback || "success"
  const openExternal = async (uri: Uri) => {
    authorize = new URL(uri.toString(true))
    nonce = authorize.searchParams.get("nonce") || ""
    if (callbackKind === "timeout") return true
    const callback = new URL(authorize.searchParams.get("redirect_uri") || "")
    callback.searchParams.set(
      "state",
      callbackKind === "invalid-state"
        ? "wrong-state"
        : authorize.searchParams.get("state") || ""
    )
    if (callbackKind === "oauth-error") {
      callback.searchParams.set("error", "access_denied")
    } else if (callbackKind !== "missing-code") {
      callback.searchParams.set("code", "authorization-code")
      callback.searchParams.set("client_id", "oaiapp_test")
    }
    setTimeout(() => void get(callback.toString()), 0)
    return true
  }

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith("/.well-known/openid-configuration")) {
      return discovery()
    }
    if (url.endsWith("/api/accounts/oauth/token")) {
      const claims = {
        iss: "https://auth.openai.com",
        aud: "oaiapp_test",
        exp: Math.floor(NOW / 1000) + 3600,
        nonce,
        sub: "subject-1",
        email: "dev@example.com",
        name: "Dev",
        ...options.claims
      }
      const token: Record<string, unknown> = {
        access_token: "access-token",
        id_token: idToken(
          claims,
          options.signingKey || keys.privateKey
        ),
        expires_in: 3600,
        scope:
          options.scope === undefined
            ? `${REQUIRED_SCOPE} email offline_access openid profile resource.invoke`
            : options.scope
      }
      if (options.refreshToken !== null) {
        token.refresh_token = options.refreshToken || "refresh-token"
      }
      assert.match(String(init?.body), /code_verifier=/)
      return new Response(JSON.stringify(token), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    }
    if (url.endsWith("/.well-known/jwks.json")) {
      return new Response(
        JSON.stringify({
          keys: [
            {
              ...publicJwk,
              kid: options.jwksKid || "test-key",
              use: "sig",
              alg: "RS256"
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    }
    throw new Error(`Unexpected request: ${url}`)
  }

  const dependencies: ChatGPTPlanSessionDependencies = {
    fetch: fakeFetch,
    now: () => NOW,
    openExternal,
    callbackTimeoutMs: 20
  }
  return {
    ...stored,
    session: new ChatGPTPlanSession(stored.context, dependencies),
    authorize: () => authorize
  }
}

const isSessionError = (
  code: ChatGPTPlanSessionError["code"],
  message?: RegExp
) => (error: unknown) =>
  error instanceof ChatGPTPlanSessionError &&
  error.code === code &&
  (!message || message.test(error.message))

suite("ChatGPT Plan session", () => {
  test("serializes concurrent refreshes and persists the rotated refresh token", async () => {
    const stored = contextWith(
      {
        accessToken: "expired-access",
        refreshToken: "refresh-old",
        idToken: "id-old",
        expiresAt: NOW - 1,
        scopes: [REQUIRED_SCOPE, "offline_access"]
      },
      {
        clientId: "oaiapp_test",
        subject: "subject-1",
        email: "dev@example.com"
      }
    )
    let refreshCalls = 0
    let refreshBody = ""
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith("/.well-known/openid-configuration")) {
        return discovery()
      }
      if (url.endsWith("/api/accounts/oauth/token")) {
        refreshCalls++
        refreshBody = String(init?.body || "")
        await new Promise((resolve) => setTimeout(resolve, 20))
        return new Response(
          JSON.stringify({
            access_token: "access-new",
            refresh_token: "refresh-new",
            id_token: "id-new",
            token_type: "Bearer",
            expires_in: 3600,
            scope: `${REQUIRED_SCOPE} offline_access`
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    }
    const session = new ChatGPTPlanSession(stored.context, {
      fetch: fakeFetch,
      now: () => NOW
    })

    const tokens = await Promise.all([
      session.getAccessToken(),
      session.getAccessToken(),
      session.getAccessToken()
    ])

    assert.deepStrictEqual(tokens, ["access-new", "access-new", "access-new"])
    assert.strictEqual(refreshCalls, 1)
    assert.match(refreshBody, /grant_type=refresh_token/)
    assert.match(refreshBody, /client_id=oaiapp_test/)
    assert.match(refreshBody, /refresh_token=refresh-old/)
    assert.match(
      refreshBody,
      /resource=https%3A%2F%2Fapi.openai.com%2Fv1/
    )
    assert.doesNotMatch(refreshBody, /scope=/)

    const persisted = JSON.parse(stored.readCredentials() || "{}") as {
      accessToken: string
      refreshToken: string
      idToken: string
      expiresAt: number
    }
    assert.strictEqual(persisted.accessToken, "access-new")
    assert.strictEqual(persisted.refreshToken, "refresh-new")
    assert.strictEqual(persisted.idToken, "id-new")
    assert.strictEqual(persisted.expiresAt, NOW + 3_600_000)
  })

  test("does not refresh a still-valid token", async () => {
    const stored = contextWith(
      {
        accessToken: "access-valid",
        refreshToken: "refresh-valid",
        idToken: "id-valid",
        expiresAt: NOW + 30 * 60_000,
        scopes: [REQUIRED_SCOPE]
      },
      { clientId: "oaiapp_test", subject: "subject-1" }
    )
    let requests = 0
    const session = new ChatGPTPlanSession(stored.context, {
      fetch: async () => {
        requests++
        throw new Error("A valid access token must not hit OAuth.")
      },
      now: () => NOW
    })
    assert.strictEqual(await session.getAccessToken(), "access-valid")
    assert.strictEqual(requests, 0)
  })

  test("does not return a refreshed token after plan sharing is removed", async () => {
    const stored = contextWith(
      {
        accessToken: "expired-access",
        refreshToken: "refresh-old",
        idToken: "id-old",
        expiresAt: NOW - 1,
        scopes: [REQUIRED_SCOPE, "offline_access"]
      },
      { clientId: "oaiapp_test", subject: "subject-1" }
    )
    const session = new ChatGPTPlanSession(stored.context, {
      now: () => NOW,
      fetch: async (input) => {
        const url = String(input)
        if (url.endsWith("/.well-known/openid-configuration")) {
          return discovery()
        }
        return new Response(
          JSON.stringify({
            access_token: "access-without-plan",
            refresh_token: "refresh-new",
            expires_in: 3600,
            scope: "offline_access openid"
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      }
    })

    await assert.rejects(
      session.getAccessToken(),
      isSessionError("plan-not-enabled", /no longer authorized/)
    )
    assert.deepStrictEqual(await session.status(), {
      connected: true,
      sharing: false,
      email: undefined,
      name: undefined,
      clientId: "oaiapp_test"
    })
  })

  test("rejects credentials bound to another account registration", async () => {
    const stored = contextWith(
      {
        clientId: "oaiapp_other",
        subject: "subject-2",
        accessToken: "access",
        refreshToken: "refresh",
        idToken: "id",
        expiresAt: NOW + 3600_000,
        scopes: [REQUIRED_SCOPE]
      },
      { clientId: "oaiapp_test", subject: "subject-1" }
    )
    const session = new ChatGPTPlanSession(stored.context, { now: () => NOW })
    await assert.rejects(
      session.getAccessToken(),
      isSessionError("reauthentication-required", /do not match/)
    )
    assert.strictEqual(stored.readCredentials(), undefined)
  })

  test("signs in with state, nonce and PKCE and stores only credentials in SecretStorage", async () => {
    const fixture = signInFixture()
    const status = await fixture.session.signIn()
    assert.deepStrictEqual(status, {
      connected: true,
      sharing: true,
      email: "dev@example.com",
      name: "Dev",
      clientId: "oaiapp_test"
    })
    const authorize = fixture.authorize()
    assert.ok(authorize)
    assert.strictEqual(authorize?.searchParams.get("client_id"), "dynamic_agent_client")
    assert.strictEqual(authorize?.searchParams.get("code_challenge_method"), "S256")
    assert.ok(authorize?.searchParams.get("code_challenge"))
    assert.ok(authorize?.searchParams.get("state"))
    assert.ok(authorize?.searchParams.get("nonce"))
    assert.ok(fixture.readCredentials()?.includes("refresh-token"))
    assert.doesNotMatch(JSON.stringify([...fixture.state.entries()]), /access-token|refresh-token/)
  })

  for (const [name, callback, message] of [
    ["invalid state", "invalid-state", /invalid OAuth state/],
    ["missing authorization code", "missing-code", /authorization code missing/],
    ["OAuth error callback", "oauth-error", /access_denied/]
  ] as Array<[string, CallbackKind, RegExp]>) {
    test(`rejects ${name}`, async () => {
      const fixture = signInFixture({ callback })
      await assert.rejects(
        fixture.session.signIn(),
        isSessionError("oauth-failed", message)
      )
      assert.strictEqual(fixture.readCredentials(), undefined)
    })
  }

  test("rejects a callback timeout", async () => {
    const fixture = signInFixture({ callback: "timeout" })
    await assert.rejects(
      fixture.session.signIn(),
      isSessionError("oauth-failed", /timed out/)
    )
  })

  for (const [name, claims] of [
    ["wrong nonce", { nonce: "wrong-nonce" }],
    ["expired ID token", { exp: Math.floor(NOW / 1000) - 1 }],
    ["wrong issuer", { iss: "https://example.invalid" }],
    ["wrong audience", { aud: "another-client" }]
  ] as Array<[string, Record<string, unknown>]>) {
    test(`rejects ${name}`, async () => {
      const fixture = signInFixture({ claims })
      await assert.rejects(
        fixture.session.signIn(),
        isSessionError("oauth-failed", /claims validation failed/)
      )
      assert.strictEqual(fixture.readCredentials(), undefined)
    })
  }

  test("rejects an invalid ID-token signature", async () => {
    const fixture = signInFixture({ signingKey: otherKeys.privateKey })
    await assert.rejects(
      fixture.session.signIn(),
      isSessionError("oauth-failed", /signature validation failed/)
    )
  })

  test("rejects JWKS without the token kid", async () => {
    const fixture = signInFixture({ jwksKid: "another-key" })
    await assert.rejects(
      fixture.session.signIn(),
      isSessionError("oauth-failed", /signing key was not found/)
    )
  })

  test("keeps identity but blocks inference when plan sharing was not granted", async () => {
    const fixture = signInFixture({
      scope: "email offline_access openid profile resource.invoke"
    })
    const status = await fixture.session.signIn()
    assert.strictEqual(status.connected, true)
    assert.strictEqual(status.sharing, false)
    await assert.rejects(
      fixture.session.getAccessToken(),
      isSessionError("plan-not-enabled", /was not authorized/)
    )
  })

  test("rejects a sign-in response without a refresh token", async () => {
    const fixture = signInFixture({ refreshToken: null })
    await assert.rejects(
      fixture.session.signIn(),
      isSessionError("oauth-failed", /renewable session credentials/)
    )
    assert.strictEqual(fixture.readCredentials(), undefined)
  })

  test("clears unusable tokens after a refresh 401", async () => {
    const stored = contextWith(
      {
        accessToken: "expired-access",
        refreshToken: "refresh-dead",
        idToken: "id-old",
        expiresAt: NOW - 1,
        scopes: [REQUIRED_SCOPE, "offline_access"]
      },
      { clientId: "oaiapp_test", subject: "subject-1" }
    )
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input)
      if (url.endsWith("/.well-known/openid-configuration")) {
        return discovery()
      }
      if (url.endsWith("/api/accounts/oauth/token")) {
        return new Response(
          JSON.stringify({ error: "invalid_refresh_token" }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    }
    const session = new ChatGPTPlanSession(stored.context, {
      fetch: fakeFetch,
      now: () => NOW
    })

    await assert.rejects(
      session.getAccessToken(),
      (error: unknown) =>
        error instanceof ChatGPTPlanSessionError &&
        error.code === "reauthentication-required" &&
        error.oauthCode === "invalid_refresh_token" &&
        error.status === 401
    )
    assert.strictEqual(stored.readCredentials(), undefined)
    assert.strictEqual((await session.status()).connected, false)
    assert.ok(stored.state.has(PROFILE_KEY))
  })

  test("requires reauthentication when refresh omits its rotated token", async () => {
    const stored = contextWith(
      {
        accessToken: "expired-access",
        refreshToken: "refresh-old",
        idToken: "id-old",
        expiresAt: NOW - 1,
        scopes: [REQUIRED_SCOPE]
      },
      { clientId: "oaiapp_test", subject: "subject-1" }
    )
    const session = new ChatGPTPlanSession(stored.context, {
      now: () => NOW,
      fetch: async (input) => {
        const url = String(input)
        if (url.endsWith("/.well-known/openid-configuration")) {
          return discovery()
        }
        return new Response(
          JSON.stringify({ access_token: "new", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      }
    })
    await assert.rejects(
      session.getAccessToken(),
      isSessionError("reauthentication-required", /rotated refresh token/)
    )
  })

  test("signs out locally even when remote revocation is unavailable", async () => {
    const stored = contextWith(
      {
        accessToken: "access",
        refreshToken: "refresh",
        idToken: "id",
        expiresAt: NOW + 3600_000,
        scopes: [REQUIRED_SCOPE, "offline_access"]
      },
      { clientId: "oaiapp_test", subject: "subject-1" }
    )
    const session = new ChatGPTPlanSession(stored.context, {
      fetch: async (input) => {
        const url = String(input)
        if (url.endsWith("/.well-known/openid-configuration")) {
          return discovery(true)
        }
        if (url.endsWith("/api/accounts/oauth/revoke")) {
          throw new Error("network unavailable")
        }
        throw new Error(`Unexpected request: ${url}`)
      }
    })
    assert.strictEqual(await session.signOut(), false)
    assert.strictEqual(stored.readCredentials(), undefined)
    assert.strictEqual((await session.status()).connected, false)
  })

  test("waits for a rotating refresh before revoking and cannot resurrect sign-out", async () => {
    const stored = contextWith(
      {
        accessToken: "expired-access",
        refreshToken: "refresh-old",
        idToken: "id-old",
        expiresAt: NOW - 1,
        scopes: [REQUIRED_SCOPE, "offline_access"]
      },
      { clientId: "oaiapp_test", subject: "subject-1" }
    )
    let refreshStarted!: () => void
    const started = new Promise<void>((resolve) => (refreshStarted = resolve))
    let finishRefresh!: (response: Response) => void
    const refreshResponse = new Promise<Response>(
      (resolve) => (finishRefresh = resolve)
    )
    let revokedBody = ""
    const session = new ChatGPTPlanSession(stored.context, {
      now: () => NOW,
      fetch: async (input, init) => {
        const url = String(input)
        if (url.endsWith("/.well-known/openid-configuration")) {
          return discovery(true)
        }
        if (url.endsWith("/api/accounts/oauth/token")) {
          refreshStarted()
          return refreshResponse
        }
        if (url.endsWith("/api/accounts/oauth/revoke")) {
          revokedBody = String(init?.body || "")
          return new Response("", { status: 200 })
        }
        throw new Error(`Unexpected request: ${url}`)
      }
    })

    const token = session.getAccessToken()
    await started
    const signedOut = session.signOut()
    finishRefresh(
      new Response(
        JSON.stringify({
          access_token: "access-new",
          refresh_token: "refresh-new",
          expires_in: 3600,
          scope: `${REQUIRED_SCOPE} offline_access`
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    )

    await assert.rejects(token, isSessionError("not-signed-in", /signing out/))
    assert.strictEqual(await signedOut, true)
    assert.match(revokedBody, /token=refresh-new/)
    assert.strictEqual(stored.readCredentials(), undefined)
    assert.strictEqual((await session.status()).connected, false)
  })
})
