/**
 * The gateway's log: one line per event, fields from an allow-list, to
 * stderr. There is no way to log a whole request or error object, so a
 * prompt, a reply, a header or a backend body cannot end up here.
 */
import { redact } from "../common/logger"

type Fields = Record<string, string | number | boolean | undefined>

const ALLOWED_FIELDS = [
  "event",
  "id",
  "key",
  "keys",
  "route",
  "alias",
  "outcome",
  "kind",
  "status",
  "ms",
  "chunks",
  "active",
  "host",
  "port",
  "protocol",
  "models",
  "code",
  "reason",
  "message",
  "signal",
  "grace",
  "provider",
  "ok",
  "plan",
  "seats",
  "used",
  "peer",
  "peers"
]

const MAX_FIELD_CHARS = 200

const clean = (value: string | number | boolean): string => {
  const text = String(value)
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, MAX_FIELD_CHARS)
  return /[\s"=]/.test(text) ? JSON.stringify(text) : text
}

export interface GatewayLog {
  info(fields: Fields): void
  warn(fields: Fields): void
  error(fields: Fields): void
}

/** Turns the allow-listed, cleaned fields into one line. */
export type LogFormat = (level: string, fields: Array<[string, string]>) => string

/** The machine format: ISO time, level, `name=value` pairs. */
export const machineLogLine: LogFormat = (level, fields) =>
  [new Date().toISOString(), level, ...fields.map(([name, value]) => `${name}=${value}`)].join(" ")

export const createGatewayLog = (
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  format: LogFormat = machineLogLine
): GatewayLog => {
  const emit = (level: string, fields: Fields) => {
    const kept: Array<[string, string]> = []
    for (const name of ALLOWED_FIELDS) {
      const value = fields[name]
      if (value === undefined) continue
      kept.push([name, clean(value)])
    }
    write(redact(format(level, kept)))
  }
  return {
    info: (fields) => emit("info", fields),
    warn: (fields) => emit("warn", fields),
    error: (fields) => emit("error", fields)
  }
}
