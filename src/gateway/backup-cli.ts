/**
 * `twinny-server backup …`: the Backups plugin from the shell, for a
 * restore (done with the server stopped) and for cron-driven copies.
 *
 *   twinny-server backup now                  [--config <file>]
 *   twinny-server backup list                 [--config <file>]
 *   twinny-server backup restore <archive>    [--config <file>] [--yes] [--passphrase-env NAME]
 *
 * <archive> is a file, or the name of an archive at the configured
 * destination (a directory or an S3 bucket, as set on the admin page).
 * The passphrase for an encrypted archive comes from the environment
 * variable named by --passphrase-env (default TWINNY_BACKUP_PASSPHRASE),
 * else from the plugin's own settings when restoring on the same machine.
 */
import fs from "node:fs"
import path from "node:path"

import { messageOf } from "../common/errors"
import { providerRegistry } from "../extension/inference/registry"

import {
  BackupSettings,
  backupSettingsFile,
  destinationFor,
  readBackupSettings
} from "./plugins/backups"
import { buildArchive, openArchive, planRestore, restoreArchive } from "./plugins/backups/archive"
import type { GatewayPaths } from "./plugins/host"
import {
  DEFAULT_KEYS_FILE,
  DEFAULT_LICENSE_FILE,
  DEFAULT_RECORDING,
  DEFAULT_USAGE,
  GatewayConfigError,
  loadGatewayConfig
} from "./config"
import { EXIT_CODE } from "./serve"

export const BACKUP_HELP = `Usage: twinny-server backup <command> [--config <file>]

  now                        Make a backup at the configured destination, as the nightly run would.
  list                       Show the archives at the destination.
  restore <archive> --yes    Put an archive's files back. Stop the gateway first.
    --passphrase-env NAME    Where the passphrase of an encrypted archive is (default TWINNY_BACKUP_PASSPHRASE).

<archive> is a path to a file, or the name of one at the destination. The
destination, retention and encryption are set on the admin page under
Plugins → Backups, and kept in <data dir>/plugins/backups/settings.json.
Pass --config so keys, usage and recordings are found where the
configuration puts them; a restore then also puts the configuration back.
`

export interface BackupIo {
  out(line: string): void
  err(line: string): void
  env: NodeJS.ProcessEnv
}

const takeOptions = (argv: string[]) => {
  const rest: string[] = []
  let configFile: string | undefined
  let yes = false
  let passphraseEnv = "TWINNY_BACKUP_PASSPHRASE"
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--config" || arg === "-c") {
      configFile = argv[++i]
      if (!configFile) throw new Error(`${arg} needs a file path.`)
    } else if (arg.startsWith("--config=")) configFile = arg.slice("--config=".length)
    else if (arg === "--yes" || arg === "-y") yes = true
    else if (arg === "--passphrase-env") {
      passphraseEnv = argv[++i]
      if (!passphraseEnv) throw new Error("--passphrase-env needs a variable name.")
    } else rest.push(arg)
  }
  return { rest, configFile, yes, passphraseEnv }
}

const pathsFor = (configFile: string | undefined): GatewayPaths => {
  if (!configFile)
    return {
      dataDir: path.dirname(DEFAULT_KEYS_FILE),
      keysFile: DEFAULT_KEYS_FILE,
      licenseFile: DEFAULT_LICENSE_FILE,
      usageDir: DEFAULT_USAGE.dir,
      recordingsDir: DEFAULT_RECORDING.dir
    }
  const resolved = path.resolve(configFile)
  const config = loadGatewayConfig(resolved, providerRegistry.providerIds())
  return {
    configFile: resolved,
    dataDir: path.dirname(config.auth.keysFile),
    keysFile: config.auth.keysFile,
    licenseFile: config.auth.licenseFile,
    usageDir: config.usage.dir,
    recordingsDir: config.recording.dir
  }
}

const settingsFor = (paths: GatewayPaths): BackupSettings =>
  readBackupSettings(backupSettingsFile(path.join(paths.dataDir, "plugins", "backups")))

const size = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`

export const runBackup = async (argv: string[], io: BackupIo): Promise<number> => {
  let options: ReturnType<typeof takeOptions>
  try {
    options = takeOptions(argv)
  } catch (error) {
    io.err(messageOf(error))
    return EXIT_CODE.config
  }
  const [command, ...args] = options.rest
  if (!command || command === "--help" || command === "-h") {
    io.out(BACKUP_HELP)
    return command ? EXIT_CODE.ok : EXIT_CODE.config
  }
  let paths: GatewayPaths
  try {
    paths = pathsFor(options.configFile)
  } catch (error) {
    if (error instanceof GatewayConfigError) {
      io.err(`Cannot read the configuration (${error.code}):`)
      for (const problem of error.problems) io.err(`  - ${problem}`)
    } else io.err(messageOf(error))
    return EXIT_CODE.config
  }
  const settings = settingsFor(paths)
  try {
    switch (command) {
      case "now": {
        const destination = destinationFor(settings)
        const built = buildArchive(paths, { includeRecordings: settings.includeRecordings, passphrase: settings.passphrase })
        await destination.put(built.name, built.data)
        io.out(`Backed up ${built.manifest.files.length} files (${size(built.data.length)}${built.encrypted ? ", encrypted" : ""}) as ${built.name} to ${destination.describe()}.`)
        return EXIT_CODE.ok
      }
      case "list": {
        const destination = destinationFor(settings)
        const archives = await destination.list()
        if (archives.length === 0) {
          io.out(`No backups at ${destination.describe()}.`)
          return EXIT_CODE.ok
        }
        io.out(`Backups at ${destination.describe()}:`)
        for (const archive of archives) io.out(`  ${archive.name}  ${size(archive.size).padStart(10)}${archive.encrypted ? "  encrypted" : ""}`)
        return EXIT_CODE.ok
      }
      case "restore": {
        const [source] = args
        if (!source) {
          io.err("Say which archive to restore: a file, or a name from `backup list`.")
          return EXIT_CODE.config
        }
        let data: Buffer
        if (fs.existsSync(source)) data = fs.readFileSync(source)
        else {
          const destination = destinationFor(settings)
          data = await destination.get(path.basename(source))
        }
        const passphrase = io.env[options.passphraseEnv] || settings.passphrase
        const opened = openArchive(data, passphrase)
        const plan = planRestore(opened, paths)
        io.out(`Backup made ${opened.manifest.createdAt} on ${opened.manifest.host} by twinny-server ${opened.manifest.server}: ${plan.writes.length} files.`)
        for (const write of plan.writes) io.out(`  ${write.exists ? "overwrite" : "create   "}  ${write.to}  (${size(write.size)})`)
        for (const skipped of plan.skipped) io.out(`  skip       ${skipped}${skipped.startsWith("config/") ? "  (pass --config to put the configuration back)" : ""}`)
        if (!options.yes) {
          io.out("")
          io.out("Nothing written. Stop the gateway, then run again with --yes to restore these files.")
          return EXIT_CODE.ok
        }
        const written = restoreArchive(opened, paths)
        io.out(`Restored ${written.length} files. Start the gateway again.`)
        return EXIT_CODE.ok
      }
      default:
        io.err(`Unknown backup command "${command}". Try: twinny-server backup --help`)
        return EXIT_CODE.config
    }
  } catch (error) {
    io.err(messageOf(error))
    return EXIT_CODE.failure
  }
}
