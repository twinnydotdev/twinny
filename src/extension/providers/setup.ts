/**
 * First run. Twinny used to write three Ollama providers on start whether
 * or not Ollama existed, so the first thing a new user saw was an error.
 * Now: if nothing is configured, look for whatever local server is
 * actually running and use that; if none is, say so once and point at
 * the providers tab, where the person picks.
 */
import { commands, ExtensionContext, window } from "vscode"

import { TWINNY_COMMAND_NAME } from "../../common/constants"
import { logger } from "../../common/logger"
import { describeServer } from "../../common/provider-discovery"
import { TwinnyProvider } from "../../common/types"

import { applyDiscoveredServer, discoverLocalServers } from "./discovery"
import { ProviderStore } from "./store"

/** Set once the "nothing found" notice has been shown, so it is shown once. */
const SETUP_NOTICE_KEY = "twinny.provider-setup-notice-shown"

const JOB_NAMES: Record<string, string> = {
  chat: "chat",
  fim: "autocomplete",
  embedding: "embeddings"
}

const listJobs = (providers: TwinnyProvider[]) =>
  providers.map((p) => JOB_NAMES[p.type] || p.type).join(", ")

export const openProviderTab = async () => {
  await commands.executeCommand(TWINNY_COMMAND_NAME.focusSidebar)
  await commands.executeCommand(TWINNY_COMMAND_NAME.manageProviders)
}

let setupDone: Promise<void> = Promise.resolve()

/**
 * Anything that reads the provider list at start (the sidebar, when VS Code
 * restores it open) waits on this, so it never shows an empty list that
 * discovery is about to fill.
 */
export const whenProviderSetupDone = () => setupDone

export const setUpProvidersOnFirstRun = (
  context: ExtensionContext,
  store: ProviderStore
): Promise<void> => {
  setupDone = run(context, store).catch((error) => {
    logger.error(
      `Provider setup failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  })
  return setupDone
}

async function run(context: ExtensionContext, store: ProviderStore) {
  await store.migrateLegacy()
  if (await store.hasProviders()) {
    await store.repairActive()
    return
  }

  const servers = await discoverLocalServers()
  if (servers.length > 0) {
    const server = servers[0]
    const providers = await applyDiscoveredServer(store, server)
    logger.log(`Set up ${listJobs(providers)} from ${describeServer(server)}`)
    void window
      .showInformationMessage(
        `Twinny found ${describeServer(server)} and set it up for ${listJobs(
          providers
        )}.`,
        "Change providers"
      )
      .then((choice) => choice && openProviderTab())
    return
  }

  if (context.globalState.get<boolean>(SETUP_NOTICE_KEY)) return
  await context.globalState.update(SETUP_NOTICE_KEY, true)
  void window
    .showInformationMessage(
      "Twinny needs a model provider. No local server (Ollama, LM Studio, llama.cpp…) answered on the usual ports.",
      "Choose a provider"
    )
    .then((choice) => choice && openProviderTab())
}
