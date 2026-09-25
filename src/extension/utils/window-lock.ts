/**
 * One VS Code window per machine for a job that must not run twice: a
 * lock file in global storage names the process that holds it. Other
 * windows see it is taken and wait; a lock left by a process that died
 * is taken over.
 */
import fs from "node:fs"
import path from "node:path"

import { messageOf } from "../../common/errors"

export interface WindowLockOptions {
  /** Where the lock file lives; usually the extension's global storage. */
  dir: string
  /** The file name; one per job. */
  name: string
  /** Where to say the file system refused to play; sharing goes ahead unguarded then. */
  warn?(message: string): void
}

export class WindowLock {
  private _held = false

  constructor(private readonly _options: WindowLockOptions) {}

  public get path(): string {
    return path.join(this._options.dir, this._options.name)
  }

  public get held(): boolean {
    return this._held
  }

  /**
   * Claims the lock. Returns false when a live process in another window
   * holds it. If the file system refuses, the claim is granted anyway.
   */
  public acquire(): boolean {
    if (this._held) return true
    const file = this.path
    const claim = JSON.stringify({ pid: process.pid, since: Date.now() })
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      try {
        fs.writeFileSync(file, claim, { flag: "wx" })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        const holder = readLockPid(file)
        if (holder !== undefined && holder !== process.pid && isAlive(holder)) {
          return false
        }
        fs.writeFileSync(file, claim)
      }
    } catch (error) {
      this._options.warn?.(
        `${this._options.name} lock unavailable, continuing without it: ${messageOf(error)}`
      )
    }
    this._held = true
    return true
  }

  public release(): void {
    if (!this._held) return
    this._held = false
    try {
      if (readLockPid(this.path) === process.pid) fs.unlinkSync(this.path)
    } catch {
      // Nothing to release, or not ours any more.
    }
  }
}

const readLockPid = (file: string): number | undefined => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"))
    return Number.isInteger(parsed?.pid) ? Number(parsed.pid) : undefined
  } catch {
    return undefined
  }
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // No permission to signal it means it exists and is someone else's.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}
