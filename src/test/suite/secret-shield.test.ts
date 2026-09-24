import * as assert from "assert"

import { SecretShield } from "../../common/secret-shield"
import { TwinnyProvider } from "../../common/types"
import { ChatChunk, InferenceClient, leavesMachine, shieldClient, shouldShield } from "../../extension/inference"

// Built at runtime so the repository never holds anything a secret scanner
// would flag.
const GITHUB = "ghp_" + "a1B2c3D4e5".repeat(4)
const AWS = "AKIA" + "Q7XK2M9P4R8T6W3Z"
const ANTHROPIC = "sk-" + "ant-api03-" + "Zq8Lr2Nx5Vb7Kd1Hm4Tf"
const PEM = ["-----BEGIN RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEA7x", "-----END RSA PRIVATE KEY-----"].join("\n")

const provider = (overrides: Partial<TwinnyProvider>): TwinnyProvider => ({
  id: "p",
  label: "Test",
  modelName: "m",
  provider: "ollama",
  type: "chat",
  apiHostname: "localhost",
  ...overrides
})

suite("Secret shield", () => {
  test("well-known tokens become numbered placeholders", () => {
    const shield = new SecretShield()
    const out = shield.redact(`token ${GITHUB} and ${AWS} and again ${GITHUB}`)
    assert.strictEqual(
      out,
      "token REDACTED_GITHUB_TOKEN_1 and REDACTED_AWS_ACCESS_KEY_1 and again REDACTED_GITHUB_TOKEN_1"
    )
    assert.deepStrictEqual(
      shield.report().map(({ kind, count }) => [kind, count]),
      [["aws-access-key", 1], ["github-token", 1]]
    )
  })

  test("an Anthropic key is named as one, not as an OpenAI key", () => {
    assert.strictEqual(new SecretShield().redact(ANTHROPIC), "REDACTED_ANTHROPIC_KEY_1")
  })

  test("private key blocks, URL passwords and secret-named values", () => {
    const shield = new SecretShield()
    assert.strictEqual(shield.redact(PEM), "REDACTED_PRIVATE_KEY_1")
    assert.strictEqual(
      shield.redact("postgres://app:Xk9#pLq2vR@db:5432/main"),
      "postgres://app:REDACTED_URL_PASSWORD_1@db:5432/main"
    )
    assert.strictEqual(
      shield.redact("DB_PASSWORD=Tr0ub4dor&3x\nPORT=5432"),
      "DB_PASSWORD=REDACTED_ENV_SECRET_1\nPORT=5432"
    )
    assert.strictEqual(
      shield.redact("const config = { apiKey: \"9fQz2LmX8vKp4Rt7\" }"),
      "const config = { apiKey: \"REDACTED_ASSIGNED_SECRET_1\" }"
    )
  })

  test("placeholders and ordinary code are left alone", () => {
    const shield = new SecretShield()
    const code = [
      "const apiKey = process.env.OPENAI_API_KEY",
      "password: \"<your-password>\"",
      "token = \"changeme\"",
      "API_KEY=xxxxxxxxxxxx",
      "const tokenizer = new Tokenizer(\"gpt-4\")",
      "sk-learn is a library"
    ].join("\n")
    assert.strictEqual(shield.redact(code), code)
    assert.strictEqual(shield.withheld, false)
  })

  test("restore puts real values back, even split across chunks", () => {
    const shield = new SecretShield()
    shield.redact(`key ${GITHUB}`)
    assert.strictEqual(shield.restore("use REDACTED_GITHUB_TOKEN_1 here"), `use ${GITHUB} here`)
    const stream = shield.restoreStream()
    const out =
      stream.push("const t = \"REDAC") +
      stream.push("TED_GITHUB_TO") +
      stream.push("KEN_1\"") +
      stream.flush()
    assert.strictEqual(out, `const t = "${GITHUB}"`)
  })

  test("only requests that leave the machine are shielded by default", () => {
    assert.strictEqual(leavesMachine(provider({})), false)
    assert.strictEqual(leavesMachine(provider({ apiHostname: "127.0.0.1" })), false)
    assert.strictEqual(leavesMachine(provider({ apiHostname: "192.168.1.20" })), true)
    assert.strictEqual(leavesMachine(provider({ provider: "anthropic", apiHostname: "api.anthropic.com" })), true)
    assert.strictEqual(leavesMachine(provider({ provider: "twinny-p2p", apiHostname: "127.0.0.1" })), true)
    assert.strictEqual(shouldShield(provider({}), "always"), true)
    assert.strictEqual(shouldShield(provider({ apiHostname: "gpu.lan" }), "off"), false)
  })

  test("the client sends placeholders and hands back real values", async () => {
    let sent = ""
    const inner = {
      id: "fake",
      capabilities: () => ["chat"],
      models: async () => [],
      fim: () => (async function* () {})(),
      embeddings: async () => ({ vectors: [] }),
      chat: (request) => {
        sent = JSON.stringify(request.messages)
        return (async function* (): AsyncGenerator<ChatChunk> {
          yield { content: "Rotate REDACTED_AWS_" }
          yield { content: "ACCESS_KEY_1 now." }
        })()
      }
    } as InferenceClient
    let reported = 0
    const client = shieldClient(inner, provider({ provider: "openai" }))
    let reply = ""
    for await (const chunk of client.chat(
      { model: "m", messages: [{ role: "user", content: `Is ${AWS} safe to commit?` }] },
      { onShield: (report) => (reported = report.length) }
    )) {
      reply += chunk.content
    }
    assert.ok(!sent.includes(AWS), "the key was sent")
    assert.ok(sent.includes("REDACTED_AWS_ACCESS_KEY_1"))
    assert.strictEqual(reply, `Rotate ${AWS} now.`)
    assert.strictEqual(reported, 1)
  })
})
