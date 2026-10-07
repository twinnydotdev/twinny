import * as assert from "assert"
import { ExtensionContext } from "vscode"

import { ChatGPTPlanSession, ChatGPTPlanSessionError } from "../../extension/chatgpt-plan/session"

const CREDENTIALS_KEY = "twinny.chatgpt-plan.credentials"
const PROFILE_KEY = "twinny.chatgpt-plan.profile"

suite("ChatGPT Plan session", () => {
  test("serializes concurrent refreshes and persists the rotated refresh token", async () => {
    const now = 1_800_000_000_000
    let stored = JSON.stringify({
      accessToken: "expired-access",
      refreshToken: "refresh-old",
      idToken: "id-old",
      expiresAt: now - 1,
      scopes: [
        "chatgpt.tokens.use.direct",
        "email",
        "offline_access",
        "openid",
        "profile",
        "resource.invoke"
      ]
    })
    const state = new Map<string, unknown>([
      [
        PROFILE_KEY,
        {
          clientId: "oaiapp_test",
          subject: "subject-1",
          email: "dev@example.com"
        }
      ]
    ])

    const context = {
      globalState: {
        get: <T>(key: string) => state.get(key) as T | undefined,
        update: async (key: string, value: unknown) => {
          state.set(key, value)
        }
      },
      secrets: {
        get: async (key: string) =>
          key === CREDENTIALS_KEY ? stored : undefined,
        store: async (key: string, value: string) => {
          if (key === CREDENTIALS_KEY) stored = value
        },
        delete: async (key: string) => {
          if (key === CREDENTIALS_KEY) stored = ""
        }
      }
    } as unknown as ExtensionContext

    let refreshCalls = 0
    let refreshBody = ""
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith("/.well-known/openid-configuration")) {
        return new Response(
          JSON.stringify({
            authorization_endpoint:
              "https://auth.openai.com/api/accounts/authorize",
            token_endpoint:
              "https://auth.openai.com/api/accounts/oauth/token",
            jwks_uri: "https://auth.openai.com/.well-known/jwks.json"
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        )
      }

      if (url.endsWith("/api/accounts/oauth/token")) {
        refreshCalls++
        refreshBody = String(init?.body || "")
        // Keep the exchange in flight long enough for all callers to join
        // the same single-flight promise.
        await new Promise((resolve) => setTimeout(resolve, 20))
        return new Response(
          JSON.stringify({
            access_token: "access-new",
            refresh_token: "refresh-new",
            id_token: "id-new",
            token_type: "Bearer",
            expires_in: 3600,
            scope:
              "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke"
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        )
      }

      throw new Error(`Unexpected request: ${url}`)
    }

    const session = new ChatGPTPlanSession(context, {
      fetch: fakeFetch,
      now: () => now
    })

    const tokens = await Promise.all([
      session.getAccessToken(),
      session.getAccessToken(),
      session.getAccessToken()
    ])

    assert.deepStrictEqual(tokens, [
      "access-new",
      "access-new",
      "access-new"
    ])
    assert.strictEqual(refreshCalls, 1)
    assert.ok(refreshBody.includes("grant_type=refresh_token"))
    assert.ok(refreshBody.includes("client_id=oaiapp_test"))
    assert.ok(refreshBody.includes("refresh_token=refresh-old"))
    assert.ok(
      refreshBody.includes(
        "resource=https%3A%2F%2Fapi.openai.com%2Fv1"
      )
    )
    assert.ok(!refreshBody.includes("scope="))

    const persisted = JSON.parse(stored) as {
      accessToken: string
      refreshToken: string
      idToken: string
      expiresAt: number
    }
    assert.strictEqual(persisted.accessToken, "access-new")
    assert.strictEqual(persisted.refreshToken, "refresh-new")
    assert.strictEqual(persisted.idToken, "id-new")
    assert.strictEqual(persisted.expiresAt, now + 3_600_000)
  })

  test("does not refresh a still-valid token", async () => {
    const now = 1_800_000_000_000
    const credentials = JSON.stringify({
      accessToken: "access-valid",
      refreshToken: "refresh-valid",
      idToken: "id-valid",
      expiresAt: now + 30 * 60_000,
      scopes: ["chatgpt.tokens.use.direct"]
    })
    const context = {
      globalState: {
        get: <T>() =>
          ({
            clientId: "oaiapp_test",
            subject: "subject-1"
          }) as T,
        update: async () => undefined
      },
      secrets: {
        get: async () => credentials,
        store: async () => undefined,
        delete: async () => undefined
      }
    } as unknown as ExtensionContext

    let requests = 0
    const fakeFetch: typeof fetch = async () => {
      requests++
      throw new Error("A valid access token must not hit OAuth.")
    }

    const session = new ChatGPTPlanSession(context, {
      fetch: fakeFetch,
      now: () => now
    })
    assert.strictEqual(await session.getAccessToken(), "access-valid")
    assert.strictEqual(requests, 0)
  })
})


  test("clears unusable tokens after a terminal refresh error", async () => {
    const now = 1_800_000_000_000
    let stored: string | undefined = JSON.stringify({
      accessToken: "expired-access",
      refreshToken: "refresh-dead",
      idToken: "id-old",
      expiresAt: now - 1,
      scopes: ["chatgpt.tokens.use.direct", "offline_access"]
    })
    const state = new Map<string, unknown>([
      [
        PROFILE_KEY,
        {
          clientId: "oaiapp_test",
          subject: "subject-1"
        }
      ]
    ])
    const context = {
      globalState: {
        get: <T>(key: string) => state.get(key) as T | undefined,
        update: async (key: string, value: unknown) => {
          state.set(key, value)
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
    } as unknown as ExtensionContext

    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input)
      if (url.endsWith("/.well-known/openid-configuration")) {
        return new Response(
          JSON.stringify({
            authorization_endpoint:
              "https://auth.openai.com/api/accounts/authorize",
            token_endpoint:
              "https://auth.openai.com/api/accounts/oauth/token",
            jwks_uri: "https://auth.openai.com/.well-known/jwks.json"
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        )
      }
      if (url.endsWith("/api/accounts/oauth/token")) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }

    const session = new ChatGPTPlanSession(context, {
      fetch: fakeFetch,
      now: () => now
    })

    await assert.rejects(
      session.getAccessToken(),
      (error: unknown) =>
        error instanceof ChatGPTPlanSessionError &&
        error.code === "reauthentication-required" &&
        error.oauthCode === "invalid_grant"
    )
    assert.strictEqual(stored, undefined)
    assert.strictEqual((await session.status()).connected, false)
    assert.strictEqual(
      state.get(PROFILE_KEY) !== undefined,
      true,
      "issued client/account mapping is retained for reauthorization"
    )
  })

  test("signs out locally even when remote revocation is unavailable", async () => {
    let stored: string | undefined = JSON.stringify({
      accessToken: "access",
      refreshToken: "refresh",
      idToken: "id",
      expiresAt: 1_900_000_000_000,
      scopes: ["chatgpt.tokens.use.direct", "offline_access"]
    })
    const state = new Map<string, unknown>([
      [
        PROFILE_KEY,
        {
          clientId: "oaiapp_test",
          subject: "subject-1"
        }
      ]
    ])
    const context = {
      globalState: {
        get: <T>(key: string) => state.get(key) as T | undefined,
        update: async (key: string, value: unknown) => {
          state.set(key, value)
        }
      },
      secrets: {
        get: async () => stored,
        store: async (_key: string, value: string) => {
          stored = value
        },
        delete: async () => {
          stored = undefined
        }
      }
    } as unknown as ExtensionContext

    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input)
      if (url.endsWith("/.well-known/openid-configuration")) {
        return new Response(
          JSON.stringify({
            authorization_endpoint:
              "https://auth.openai.com/api/accounts/authorize",
            token_endpoint:
              "https://auth.openai.com/api/accounts/oauth/token",
            jwks_uri: "https://auth.openai.com/.well-known/jwks.json",
            revocation_endpoint:
              "https://auth.openai.com/api/accounts/oauth/revoke"
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        )
      }
      if (url.endsWith("/api/accounts/oauth/revoke")) {
        throw new Error("network unavailable")
      }
      throw new Error(`Unexpected request: ${url}`)
    }

    const session = new ChatGPTPlanSession(context, {
      fetch: fakeFetch
    })
    assert.strictEqual(await session.signOut(), false)
    assert.strictEqual(stored, undefined)
    assert.strictEqual((await session.status()).connected, false)
  })
