/**
 * Who holds a seat on the plan.
 *
 * A key is a seat; the licence says how many there may be. A demo's
 * guests are the exception: their keys come and go without holding one,
 * are revoked after their hour and are forgotten a day later. Every place
 * the server asks "may another key be made?" or "how many seats are
 * taken?" asks here, so the guest rule lives in one place.
 */
import { messageOf } from "../common/errors"

import type { DemoOptions } from "./demo"
import { isGuestName } from "./demo"
import type { InviteStore } from "./invites"
import type { KeyRecord, KeyStore } from "./keys"
import type { LicenseStore, LicenseSummary } from "./license"
import type { GatewayLog } from "./log"

export interface SeatBookOptions {
  keys: KeyStore
  license?: LicenseStore
  /** Set on a demo gateway; without it nobody is a guest. */
  demo?: DemoOptions
  log: GatewayLog
}

export class SeatBook {
  constructor(private readonly _options: SeatBookOptions) {}

  /** A guest of the demo: holds no seat, expires on its own. */
  public isGuest(name: string): boolean {
    return !!this._options.demo && isGuestName(name)
  }

  /** The active keys the plan counts. */
  public holders(): KeyRecord[] {
    return this._options.keys
      .active()
      .filter((key) => !this.isGuest(key.name))
  }

  /**
   * Why a key named `name` cannot be made right now, or nothing. A guest
   * never needs a seat. With `replace`, the active key of that name is
   * about to be revoked in the same step and does not count.
   */
  public refuse(
    name: string,
    options: { replace?: boolean } = {}
  ): string | undefined {
    const license = this._options.license
    if (!license || this.isGuest(name)) return undefined
    const seated = this.holders().filter(
      (key) => !(options.replace && key.name === name)
    )
    return license.refuseNewKey(seated)
  }

  /**
   * Whether a key presenting itself may hold its seat: the reason it may
   * not, or nothing. Guests are always let through.
   */
  public seat(record: KeyRecord): string | undefined {
    const license = this._options.license
    if (!license || this.isGuest(record.name)) return undefined
    license.refresh()
    return license.seat(record, this.holders())
  }

  /** The plan as the licence describes it, or nothing without a licence. */
  public summary(): LicenseSummary | undefined {
    return this._options.license?.summary(this.holders())
  }

  /** Guest keys in use plus guest invites still open. */
  public guests(invites: InviteStore): number {
    return (
      this._options.keys.active().filter((key) => isGuestName(key.name))
        .length +
      invites.pending().filter((invite) => isGuestName(invite.name)).length
    )
  }

  /** Revokes guest keys past their hour and forgets the ones revoked long ago. */
  public sweepGuests(now = Date.now()): void {
    const demo = this._options.demo
    if (!demo) return
    const { keys, log } = this._options
    try {
      keys.reload()
      for (const guest of keys.list()) {
        if (!isGuestName(guest.name) || guest.revokedAt) continue
        if (now - Date.parse(guest.createdAt) < demo.guestTtlMs) continue
        keys.revoke(guest.id)
        log.info({ event: "demo.guest-expired", key: guest.name })
      }
      keys.forget(
        keys
          .list()
          .filter(
            (key) =>
              isGuestName(key.name) &&
              key.revokedAt !== undefined &&
              now - Date.parse(key.revokedAt) >= demo.forgetGuestsAfterMs
          )
          .map((key) => key.id)
      )
    } catch (error) {
      log.warn({
        event: "demo.sweep-failed",
        reason: messageOf(error)
      })
    }
  }
}
