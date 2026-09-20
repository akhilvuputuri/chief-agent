import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
/**
 * AES-256-GCM for runtime-obtained credentials that cannot live in the server environment.
 * Layout: version(1) | iv(12) | tag(16) | ciphertext. The key sits in the server .env; this
 * protects database dumps, backups, diagnostics and fixtures, not a compromised host.
 */
const VERSION = 1;
export function secretKey(hex: string) {
  if (!/^[0-9a-f]{64}$/i.test(hex))
    throw new Error("Secret key must be 64 hexadecimal characters");
  return Buffer.from(hex, "hex");
}
export function seal(key: Buffer, plaintext: string, aad: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}
export function open(key: Buffer, box: Uint8Array, aad: string) {
  const buffer = Buffer.from(box);
  if (key.length !== 32 || buffer.length < 29 || buffer[0] !== VERSION)
    throw new Error("Identity unreadable");
  const decipher = createDecipheriv("aes-256-gcm", key, buffer.subarray(1, 13));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(buffer.subarray(13, 29));
  try {
    return Buffer.concat([
      decipher.update(buffer.subarray(29)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Identity unreadable");
  }
}
