/**
 * Where a node keeps its identity and settings on disk.
 *
 *   ~/.twinny/node/identity.json       the seed its key pair comes from
 *   ~/.twinny/node/trusted-peers.json  the devices allowed to use it
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createSeed, SEED_BYTES } from "../p2p/identity"

export const DEFAULT_NODE_DIR = path.join(os.homedir(), ".twinny", "node")
export const DEFAULT_OLLAMA_URL = "http://localhost:11434"
/**
 * The UDP port a node listens on. Fixed rather than random so a firewall
 * rule for it can be permanent; hyperdht's own default, so a node started
 * by an older build sits on the same port.
 */
export const DEFAULT_NODE_PORT = 49737

export const IDENTITY_FILE = "identity.json"
export const TRUSTED_PEERS_FILE = "trusted-peers.json"

export interface NodeConfig {
  dir: string
  name: string
  ollamaUrl: string
  /** UDP port to listen on. */
  port: number
  /** Open a pairing window as soon as the node starts. */
  pairOnStart: boolean
}

/** Reads the seed, or makes one and writes it with owner-only permissions. */
export const loadOrCreateSeed = (dir: string): Buffer => {
  const file = path.join(dir, IDENTITY_FILE)
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { seed?: string }
      const seed = Buffer.from(parsed.seed || "", "hex")
      if (seed.length === SEED_BYTES) return seed
    } catch {
      // Fall through and replace it; a broken identity file is no identity.
    }
    throw new Error(
      `${file} does not contain a valid identity. Delete it to create a new one (paired devices will need to pair again).`
    )
  }
  const seed = createSeed()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ seed: seed.toString("hex") }), {
    mode: 0o600
  })
  return seed
}

export const parseArgs = (argv: string[], env = process.env): NodeConfig | "help" => {
  const config: NodeConfig = {
    dir: env.TWINNY_NODE_DIR || DEFAULT_NODE_DIR,
    name: env.TWINNY_NODE_NAME || os.hostname(),
    ollamaUrl: env.OLLAMA_HOST
      ? normaliseOllamaUrl(env.OLLAMA_HOST)
      : DEFAULT_OLLAMA_URL,
    port: parsePort(env.TWINNY_NODE_PORT) ?? DEFAULT_NODE_PORT,
    pairOnStart: true
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${arg} needs a value`)
      return value
    }
    switch (arg) {
      case "node":
        break
      case "--name":
      case "-n":
        config.name = next()
        break
      case "--ollama":
      case "-o":
        config.ollamaUrl = normaliseOllamaUrl(next())
        break
      case "--dir":
      case "-d":
        config.dir = next()
        break
      case "--port":
      case "-p": {
        const raw = next()
        const port = parsePort(raw)
        if (port === undefined) throw new Error(`${arg} needs a port between 1 and 65535, not "${raw}"`)
        config.port = port
        break
      }
      case "--no-pair":
        config.pairOnStart = false
        break
      case "--help":
      case "-h":
        return "help"
      default:
        throw new Error(`Unknown option ${arg}. Try --help.`)
    }
  }
  return config
}

const parsePort = (value: string | undefined): number | undefined => {
  if (!value) return undefined
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined
}

/** `OLLAMA_HOST` may be `host:port` or a full URL; a node wants a URL. */
const normaliseOllamaUrl = (value: string) =>
  /^https?:\/\//i.test(value) ? value : `http://${value}`

export const HELP = `Twinny node — share this machine's Ollama with your other devices.

Usage: twinny-node [options]

  -n, --name <name>     What paired devices see this machine as (default: hostname)
  -o, --ollama <url>    Ollama address (default: ${DEFAULT_OLLAMA_URL}, or $OLLAMA_HOST)
  -d, --dir <path>      Where to keep the node identity and trusted devices
                        (default: ${DEFAULT_NODE_DIR})
  -p, --port <port>     UDP port to listen on (default: ${DEFAULT_NODE_PORT}, or $TWINNY_NODE_PORT).
                        Devices on your network reach the node on this port, so a
                        firewall must allow it, e.g. \`sudo ufw allow ${DEFAULT_NODE_PORT}/udp\`.
      --no-pair         Start without opening a pairing window
  -h, --help            Show this help

While running:
  p  show a new pairing code      l  list paired devices
  r  remove a paired device       q  quit
`
