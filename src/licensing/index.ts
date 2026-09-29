/**
 * Twinny licensing: the parts a gateway needs to verify a licence and
 * decide what it allows. Everything here is pure `node:crypto` and has no
 * imports from the rest of the repository. The issuer, which signs
 * tokens, is not here: it lives in the private twinny-licence repository,
 * which keeps a copy of these files so the two sides agree.
 */
export {
  Entitlements,
  entitlementsFor,
  FREE_SEATS,
  GRACE_DAYS,
  LicenseInput,
  PlanStatus,
  RENEWAL_NOTICE_DAYS,
  seatedKeyIds,
  SeatHolder,
  seatRefusal,
  unseatedRefusal
} from "./entitlements"
export {
  decodeLicenseToken,
  describeLicense,
  LICENSE_TOKEN_PREFIX,
  LicenseClaims,
  LicenseError,
  LicenseProblem,
  VerifiedLicense,
  verifyLicenseToken
} from "./format"
export { TRUSTED_LICENSE_KEYS } from "./trusted-keys"
