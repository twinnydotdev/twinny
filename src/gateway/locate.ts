/**
 * Which configuration a command means when it names none, so a bare
 * `twinny-server` starts the gateway this machine already has.
 *
 *   1. `$TWINNY_CONFIG`, when set (even if the file is missing: it was asked for)
 *   2. `./twinny.gateway.json`
 *   3. the configuration this machine served last, remembered on start
 *   4. `~/twinny.gateway.json`
 *
 * The memory is one small file beside the data directory, never inside it:
 * the data directory has a format marker of its own and may be anywhere.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { DEFAULT_CONFIG_FILE } from "./init"

export type ConfigSource = "env" | "cwd" | "remembered" | "home"

export interface LocatedConfig {
  file: string
  source: ConfigSource
}

/** `~/.twinny/twinny-server.json`; read when the home directory is, so tests with their own HOME get their own. */
export const rememberedConfigPath = (home = os.homedir()): string => path.join(home, ".twinny", "twinny-server.json")

/** The configuration served last, if it is still there. */
export const rememberedConfig = (home = os.homedir()): string | undefined => {
  try {
    const parsed = JSON.parse(fs.readFileSync(rememberedConfigPath(home), "utf8")) as { config?: unknown }
    const file = typeof parsed.config === "string" ? parsed.config : undefined
    return file && path.isAbsolute(file) && fs.existsSync(file) ? file : undefined
  } catch {
    return undefined
  }
}

/** Notes the configuration a gateway started with. Best effort: a read-only home only loses the shortcut. */
export const rememberConfig = (file: string, home = os.homedir()): void => {
  const target = rememberedConfigPath(home)
  const config = path.resolve(file)
  try {
    if (rememberedConfig(home) === config) return
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `${JSON.stringify({ config, servedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
  } catch {
    // Nothing depends on it.
  }
}

/** The first configuration in the order above, or `undefined` when there is none to start. */
export const locateConfig = (cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env, home = os.homedir()): LocatedConfig | undefined => {
  const named = env.TWINNY_CONFIG?.trim()
  if (named) return { file: path.resolve(cwd, named), source: "env" }
  const here = path.resolve(cwd, DEFAULT_CONFIG_FILE)
  if (fs.existsSync(here)) return { file: here, source: "cwd" }
  const remembered = rememberedConfig(home)
  if (remembered) return { file: remembered, source: "remembered" }
  const inHome = path.join(home, DEFAULT_CONFIG_FILE)
  if (fs.existsSync(inHome)) return { file: inHome, source: "home" }
  return undefined
}

/** Where the search looked, for the message when it found nothing. */
export const searchedPlaces = (cwd = process.cwd(), home = os.homedir()): string[] => [
  "$TWINNY_CONFIG",
  tildify(path.resolve(cwd, DEFAULT_CONFIG_FILE), home),
  `the last configuration served (${tildify(rememberedConfigPath(home), home)})`,
  tildify(path.join(home, DEFAULT_CONFIG_FILE), home)
]

export const SOURCE_LABEL: Record<ConfigSource, string> = {
  env: "named by TWINNY_CONFIG",
  cwd: "in this directory",
  remembered: "the one served last",
  home: "in your home directory"
}

/** One line for errors about a configuration nobody named: which file it was and how to pick another. */
export const describeLocated = (located: LocatedConfig, home = os.homedir()): string =>
  `Using ${tildify(located.file, home)} (${SOURCE_LABEL[located.source]}); pass --config <file> for another.`

/** `/home/me/x` → `~/x`, for showing paths; never for using them. */
export const tildify = (file: string, home = os.homedir()): string =>
  home && (file === home || file.startsWith(home + path.sep)) ? `~${file.slice(home.length)}` : file
