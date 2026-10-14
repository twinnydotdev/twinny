/**
 * The team's rules for agent mode as the extension reads, describes and
 * applies them: parsed from the team route without cutting a developer
 * off over a rule this version does not know, said in sentences before
 * connecting, and blocked paths kept from every tool.
 */
import * as assert from "node:assert"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { describePolicy, policyIsEmpty } from "../../common/team-policy"
import { WorkspaceView } from "../../extension/tools/view"
import { workspaceTools } from "../../extension/tools/workspace"
import { parseTeam, parseTeamAgentPolicy } from "../../protocol/wire"

const workspace = (files: Record<string, string>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-team-agent-"))
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), content)
  }
  return root
}

const team = (policy: unknown) => ({
  protocol: 1,
  defaults: { chat: "coder" },
  models: [{ id: "coder", name: "coder", capabilities: ["chat"] }],
  policy
})

test("the agent rules are read from the team route; a rule from a newer gateway is passed over", () => {
  assert.deepStrictEqual(parseTeamAgentPolicy({ off: true }), { off: true })
  assert.deepStrictEqual(
    parseTeamAgentPolicy({ commands: "ask", edits: "review", blockedPaths: ["infra/", " ", "infra/"], maxSteps: 3 }),
    { commands: "ask", edits: "review", blockedPaths: ["infra/"] }
  )
  assert.deepStrictEqual(parseTeamAgentPolicy({ off: false }), {})
  assert.deepStrictEqual(
    parseTeamAgentPolicy({ commands: "allowlist", edits: "pairs" }),
    { commands: "ask", edits: "review" },
    "a value from a newer gateway reads as the strictest this version knows"
  )
  assert.strictEqual(parseTeamAgentPolicy({ commands: 3 }), undefined, "a value of the wrong kind is not a rule")
  assert.deepStrictEqual(parseTeamAgentPolicy({ mcp: "off" }), { mcp: "off" })
  assert.deepStrictEqual(parseTeamAgentPolicy({ mcp: "allowlist" }), { mcp: "off" }, "an MCP rule from a newer gateway reads as off")
  assert.strictEqual(parseTeamAgentPolicy({ blockedPaths: "infra/" }), undefined)
  assert.strictEqual(parseTeamAgentPolicy([]), undefined)

  assert.deepStrictEqual(parseTeam(team({ agent: { commands: "off" } })).policy, { agent: { commands: "off" } })
  assert.deepStrictEqual(parseTeam(team({ agent: { off: false } })).policy, {}, "rules that tighten nothing are left out")
  assert.deepStrictEqual(parseTeam(team({ agent: { edits: "apply" } })).policy, { agent: { edits: "review" } })
  assert.throws(() => parseTeam(team({ agent: { off: "yes" } })), /invalid team policy/)
})

test("the agent rules count as a policy and are said before connecting", () => {
  assert.ok(policyIsEmpty({ agent: {} }))
  assert.ok(!policyIsEmpty({ agent: { edits: "review" } }))
  assert.deepStrictEqual(describePolicy({ agent: { off: true, commands: "ask" } }), [
    "Agent mode is off: the chat cannot read or change your workspace."
  ])
  assert.deepStrictEqual(
    describePolicy({ agent: { commands: "ask", edits: "review", blockedPaths: ["a", "b", "c", "d", "e", "f", "g"] } }),
    [
      "Agent mode asks before every command it runs.",
      "Every change agent mode makes waits for your review.",
      "Agent mode cannot read or change a, b, c, d, e and 2 more."
    ]
  )
  assert.deepStrictEqual(describePolicy({ agent: { commands: "off" } }), ["Agent mode cannot run commands."])
  assert.deepStrictEqual(describePolicy({ agent: { mcp: "off" } }), ["Agent mode uses no MCP servers."])
  assert.deepStrictEqual(describePolicy({ agent: { commands: "off", mcp: "off" } }), ["Agent mode cannot run commands."], "said once")
  assert.ok(!policyIsEmpty({ agent: { mcp: "off" } }))
})

test("blocked paths are kept from every tool, and the agent is told why", async () => {
  const root = workspace({
    "src/app.ts": "export const token = readToken()\n",
    "infra/deploy.ts": "export const readToken = () => 'from vault'\n",
    ".env.production": "TOKEN=abc\n",
    "docs/a.md": "readToken is documented here\n"
  })
  const view = new WorkspaceView(root, [], undefined, ["infra/", ".env*"])
  const created: string[] = []
  const tools = workspaceTools(view, [], {
    edits: {
      mode: "apply",
      edit: async () => ({ ok: true, message: "Changed." }),
      create: async (file) => {
        created.push(file)
        return { ok: true, message: "Created." }
      }
    }
  })
  const run = (name: string, args: Record<string, string>) => tools.run({ name, args })

  const read = await run("read_file", { path: "infra/deploy.ts" })
  assert.ok(read.failed)
  assert.strictEqual(read.output, "infra/deploy.ts is kept from the agent by the team's rules and cannot be read.")
  assert.match((await run("read_file", { path: ".env.production" })).output, /kept from the agent by the team's rules/)
  assert.match((await run("list_dir", {})).output, /^src\/$/m)
  assert.doesNotMatch((await run("list_dir", {})).output, /infra|\.env/)
  const grep = await run("grep", { pattern: "readToken" })
  assert.match(grep.output, /src\/app\.ts/)
  assert.doesNotMatch(grep.output, /infra/)
  assert.doesNotMatch((await run("find_files", { pattern: "**/*.ts" })).output, /infra/)
  const refused = await run("create_file", { path: "infra/new.ts", content: "x" })
  assert.ok(refused.failed)
  assert.match(refused.output, /kept from the agent by the team's rules; twinny does not write there/)
  assert.match((await run("edit_file", { path: "infra/deploy.ts", find: "vault", replace: "env" })).output, /kept from the agent/)
  assert.deepStrictEqual(created, [], "nothing reached the editor")
  assert.ok(view.blocked("infra/deploy.ts") && !view.blocked("src/app.ts"))
  // Without the team's rules the same files are the agent's to read.
  assert.ok(!(await workspaceTools(new WorkspaceView(root)).run({ name: "read_file", args: { path: "infra/deploy.ts" } })).failed)
})

test("git keeps to the team's rules too: no diff, show or listing of a blocked path", async () => {
  const root = workspace({ "src/app.ts": "export const app = 1\n", "infra/deploy.ts": "export const vault = 'BLOCKED-1'\n" })
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" })
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "T")
  git("add", ".")
  git("commit", "-qm", "first")
  fs.writeFileSync(path.join(root, "infra/deploy.ts"), "export const vault = 'BLOCKED-2'\n")
  const tools = workspaceTools(new WorkspaceView(root, [], undefined, ["infra/"]))
  const run = (args: string) => tools.run({ name: "git", args: { args } })
  for (const args of ["show HEAD:infra/deploy.ts", "log -p -- infra", "blame infra/deploy.ts", "diff infra/deploy.ts"]) {
    const result = await run(args)
    assert.ok(result.failed, args)
    assert.doesNotMatch(result.output, /BLOCKED/, args)
  }
  for (const args of ["log -p", "diff", "show HEAD"]) {
    // A diff names the file it leaves out, and shows none of it.
    assert.doesNotMatch((await run(args)).output, /BLOCKED/, args)
  }
  assert.doesNotMatch((await run("ls-files")).output, /infra/)
  assert.match((await run("show HEAD")).output, /export const app = 1/)
})
