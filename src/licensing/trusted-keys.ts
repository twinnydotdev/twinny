/**
 * The public keys a gateway trusts to have signed a licence. Raw Ed25519
 * public keys, base64. Ships inside twinny-server; there is nothing secret
 * here.
 *
 * Rotation: add the new key, rebuild and release, reissue licences with
 * the new signing key over the following releases, then remove the old
 * key. A licence signed by any listed key is accepted.
 *
 * The matching private key is made with `twinny-license keygen` (the
 * private twinny-licence repository) and lives outside every repository
 * (default: ~/.twinny/license-signing/private.pem). After changing this
 * list, run `npm run sync` there so the issuer trusts the same keys.
 */
export const TRUSTED_LICENSE_KEYS: readonly string[] = [
  // twinny-license signing key, generated 2026-09-17 on the licence service.
  // The same key signs checkout licences there and hand-issued ones locally.
  "S4LXKedyDVC8lobYX8MMFiZIAjf/lQxhNlfKJry0wIM="
]
