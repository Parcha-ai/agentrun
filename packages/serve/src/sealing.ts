// AES-256-GCM sealing, the one primitive every secret this server keeps at rest is sealed with (copied from
// @parcha/pi-durable-agent's vault.ts, which serve no longer imports): the store's sealed columns (store/seal.ts), the
// trigger settings, the outbound webhook's secret, and what a runner opens under the server's seal key.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM over `plain`, bound to `aad`: the IV, the ciphertext and the tag, in that order. */
export function seal(key: Buffer, plain: Buffer, aad: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(Buffer.from(aad, "utf8"));
  return Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

/** `seal`'s inverse; it throws when the bytes, the key or the `aad` differ from the sealing's. */
export function unseal(key: Buffer, sealed: Buffer, aad: string): Buffer {
  if (sealed.length < IV_BYTES + TAG_BYTES) throw new Error("too short");
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, IV_BYTES)).setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  return Buffer.concat([decipher.update(sealed.subarray(IV_BYTES, sealed.length - TAG_BYTES)), decipher.final()]);
}
