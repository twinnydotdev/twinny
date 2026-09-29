/**
 * `twinny-server`: the Twinny inference gateway as an npm package.
 *
 *   twinny-server quickstart               config + admin key + serve, in one go
 *   twinny-server init [file]              write a starter configuration
 *   twinny-server serve --config <file>    run the gateway
 *   twinny-server reset --yes              remove keys, licence, usage, recordings
 *
 * Built by esbuild into `packages/twinny-server/cli.js` with no runtime
 * dependencies, so `npx twinny-server` needs nothing but Node.
 */
import { messageOf } from "../common/errors"

import { runInvites, runKeys, runLicense, runRecordings, runUsage } from "./admin"
import { runBackup } from "./backup-cli"
import { INIT_HELP, runInit } from "./init"
import { runQuickstart, runReset } from "./quickstart"
import { defaultServeIo, EXIT_CODE, runServe, SERVE_HELP } from "./serve"
import { SERVER_VERSION as VERSION } from "./version"

export const HELP = `twinny-server ${VERSION} — serve your models to Twinny extensions on other machines.

Usage: twinny-server <command> [options]

Commands:
  quickstart [--fresh]     Write the configuration, make an admin key and serve, in one go
  init [file]              Write a starter configuration (default: ./twinny.gateway.json)
  serve --config <file>    Start the gateway
                           (--port, --host: where to listen; --demo: a public, read-only demo)
  reset --yes              Remove keys, licence, usage and recordings (--all: the configuration too)
  keys create <name>       Make an access key for a developer (shown once)
  keys list                Show keys and whether they are active
  keys revoke <name|id>    Stop a key; takes effect without a restart
  backup now|list|restore  The Backups plugin from the shell; restore with the gateway stopped
  invites create <name>    Make an invite link; opening it in VS Code connects the developer
  usage [--since 7d]       Requests, failures and token counts by key and model
  license [set|remove]     Show the plan and seats; install or remove a licence token
  recordings export|stats  Recorded request content as training data (licence feature)
  --version                Print the version
  --help                   Show this help

Quick start (on the machine with the models):
  npx twinny-server quickstart

It prints an admin key once and the admin page address. Sign in there and
invite developers from People: each gets a link that opens VS Code and
connects them. Or from here: npx twinny-server invites create alice --url https://…
Step by step instead: init, edit the models, keys create, serve.
Commands that take --config use the key and usage paths that configuration names.
`

const out = (text: string) => process.stdout.write(`${text}\n`)
const err = (text: string) => process.stderr.write(`${text}\n`)

export const main = async (argv: string[]): Promise<number> => {
  const [command, ...rest] = argv
  switch (command) {
    case "serve":
      return runServe(rest)
    case "quickstart":
      return runQuickstart(rest, defaultServeIo())
    case "reset":
      return runReset(rest, { out, err })
    case "init": {
      try {
        const result = runInit(rest)
        if (result === "help") {
          out(INIT_HELP)
          return EXIT_CODE.ok
        }
        for (const line of result.next) out(line)
        return EXIT_CODE.ok
      } catch (error) {
        err(messageOf(error))
        return EXIT_CODE.config
      }
    }
    case "keys":
      return runKeys(rest, { out, err })
    case "invites":
    case "invite":
      return runInvites(rest, { out, err })
    case "usage":
      return runUsage(rest, { out, err })
    case "license":
    case "licence":
      return runLicense(rest, { out, err })
    case "recordings":
      return runRecordings(rest, { out, err })
    case "backup":
    case "backups":
      return runBackup(rest, { out, err, env: process.env })
    case "--version":
    case "-v":
      out(VERSION)
      return EXIT_CODE.ok
    case undefined:
    case "--help":
    case "-h":
      out(HELP)
      return command === undefined ? EXIT_CODE.config : EXIT_CODE.ok
    default:
      // `twinny-server --config x` is a common slip; treat it as serve.
      if (command === "--config" || command === "-c" || command.startsWith("--config=")) {
        return runServe(argv)
      }
      err(`Unknown command "${command}". Try: twinny-server --help`)
      return EXIT_CODE.config
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      err(messageOf(error))
      process.exit(EXIT_CODE.failure)
    }
  )
}

export { SERVE_HELP }
