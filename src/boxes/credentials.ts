import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const hashCredential = (credential: string) =>
  createHash("sha256").update(credential).digest("hex");

/** A fresh single-use bootstrap secret; only its hash is stored. */
export const bootstrapSecret = () => randomBytes(32).toString("base64url");

/**
 * The session credential for an epoch, derived rather than stored, so a retried hello with
 * the same predecessor receives the same replacement while the host keeps only hashes.
 */
export function deriveCredential(
  key: string,
  boxId: string,
  predecessorHash: string,
  epoch: number,
) {
  return createHmac("sha256", key)
    .update(`box:${boxId}:${predecessorHash}:${epoch}`)
    .digest("base64url");
}

export function sameHash(a: string | null | undefined, b: string) {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
