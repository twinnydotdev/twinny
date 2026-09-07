#!/usr/bin/env node
/**
 * `twinny-node`: run a Twinny node in a terminal on the machine with the GPU.
 */

import path from "node:path"
import readline from "node:readline"

import { shortKey } from "../p2p/identity"

import { HELP, loadOrCreateSeed, parseArgs, TRUSTED_PEERS_FILE } from "./config"
import { TrustStore } from "./peers"
import { NODE_EVENT, TwinnyNode } from "./server"

const out = (line = "") => process.stdout.write(`${line}\n`)
const timestamp = () => new Date().toLocaleTimeString()
const log = (line: string) => out(`  ${timestamp()}  ${line}`)

const describeModels = (models: Array<{ name: string; parameterSize?: string }>) =>
  models.length
    ? models.map((m) => `  ✓ ${m.name}${m.parameterSize ? `  (${m.parameterSize})` : ""}`).join("\n")
    : "  (no models installed — run `ollama pull <model>`)"

async function main() {
  let parsed
  try {
    parsed = parseArgs(process.argv.slice(2))
  } catch (error) {
    out(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
  if (parsed === "help") {
    out(HELP)
    return
  }
  const config = parsed

  const seed = loadOrCreateSeed(config.dir)
  const trust = new TrustStore(path.join(config.dir, TRUSTED_PEERS_FILE))
  const node = new TwinnyNode({
    seed,
    name: config.name,
    ollamaUrl: config.ollamaUrl,
    trust
  })

  out()
  out("Twinny Node")
  out()
  out(`Node:    ${config.name}`)
  out(`Ollama:  ${config.ollamaUrl}`)
  out()

  const up = await node.ollama.isUp()
  if (!up) {
    out("  ⚠ Ollama is not answering. Start it with `ollama serve`; the node")
    out("    will keep running and forward requests once it is up.")
  } else {
    out("Models:")
    try {
      out(describeModels(await node.ollama.listModels()))
    } catch (error) {
      out(`  (could not list models: ${error instanceof Error ? error.message : error})`)
    }
  }
  out()
  out("Peer ID:")
  out(`  ${node.publicKeyHex}`)
  out()

  node.on(NODE_EVENT.log, (message: string) => log(message))
  node.on(NODE_EVENT.peerConnected, ({ publicKey, trusted }) =>
    log(
      trusted
        ? `${trust.get(publicKey)?.name || shortKey(publicKey)} connected`
        : `unpaired peer ${shortKey(publicKey)} connected, waiting for pairing code`
    )
  )
  node.on(NODE_EVENT.peerDisconnected, ({ publicKey, trusted }) =>
    log(
      trusted
        ? `${trust.get(publicKey)?.name || shortKey(publicKey)} disconnected`
        : `unpaired peer ${shortKey(publicKey)} left`
    )
  )
  node.on(NODE_EVENT.paired, ({ publicKey, name }) =>
    log(`paired with "${name}" (${shortKey(publicKey)}). Press p to pair another device.`)
  )
  node.on(NODE_EVENT.pairingFailed, ({ publicKey }) =>
    log(`pairing attempt from ${shortKey(publicKey)} failed; the code is now void. Press p for a new one.`)
  )
  node.on(NODE_EVENT.pairingClosed, () => log("pairing window closed"))
  node.on(NODE_EVENT.request, ({ publicKey, kind, model }) =>
    log(`${trust.get(publicKey)?.name || shortKey(publicKey)} → ${kind} ${model}`)
  )

  const showPairingCode = () => {
    const code = node.openPairing()
    out()
    out("Pairing code (valid for 10 minutes, works once):")
    out()
    out(`  ${code}`)
    out()
    out("In VS Code: Twinny → Providers → Devices → Add device, and paste the code.")
    out()
  }

  const listPeers = () => {
    const peers = trust.list()
    out()
    if (!peers.length) {
      out("No paired devices yet. Press p to show a pairing code.")
    } else {
      out("Paired devices:")
      for (const peer of peers) {
        const online = node.connectedPeers.some((p) => p.publicKey === peer.publicKey)
        out(`  ${online ? "●" : "○"} ${peer.name}  ${shortKey(peer.publicKey)}  paired ${new Date(peer.pairedAt).toLocaleDateString()}`)
      }
    }
    out()
  }

  await node.start()
  out("Waiting for connections...  (p pair, l list, r remove, q quit)")
  out()

  if (config.pairOnStart) showPairingCode()
  else if (!trust.list().length) out("No paired devices yet. Press p to show a pairing code.")

  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  let removing = false
  rl.on("line", (line) => {
    const input = line.trim()
    if (removing) {
      removing = false
      const peers = trust.list()
      const index = Number(input) - 1
      const peer = peers[index]
      if (!peer) {
        out("Nothing removed.")
        return
      }
      trust.remove(peer.publicKey)
      out(`Removed ${peer.name}. It will need a new pairing code to connect again.`)
      return
    }
    switch (input.toLowerCase()) {
      case "p":
        showPairingCode()
        break
      case "l":
        listPeers()
        break
      case "r": {
        const peers = trust.list()
        if (!peers.length) {
          out("No paired devices to remove.")
          break
        }
        peers.forEach((peer, i) => out(`  ${i + 1}. ${peer.name}  ${shortKey(peer.publicKey)}`))
        out("Number of the device to remove (Enter to cancel): ")
        removing = true
        break
      }
      case "q":
        void shutdown()
        break
      case "":
        break
      default:
        out("Commands: p pair, l list, r remove, q quit")
    }
  })

  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    out("Stopping...")
    rl.close()
    await node.stop()
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : error}\n`)
  process.exit(1)
})
