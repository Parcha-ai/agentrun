// AES-256-GCM sealing (sealing.ts), the primitive every secret this server keeps at rest is sealed with: the format is
// IV, ciphertext and tag, opened by the test's own reading, and a sealing opens only under its own key and aad. Copied
// with sealing.ts from @parcha/pi-durable-agent's vault.test.mjs ("seal and unseal, shared with a host, ...").
import assert from "node:assert/strict";
import { createDecipheriv, randomBytes } from "node:crypto";
import { test } from "node:test";
import { seal, unseal } from "../dist/sealing.js";

const marker = (name) => `vault-secret-${name}-7f3a`;
const holds = (bytes, text) => [Buffer.from(text, "utf8"), Buffer.from(text, "utf16le")].some((needle) => bytes.includes(needle));

test("seal and unseal, shared with a host, are the vault's format: IV, ciphertext and tag, opened by the test's own reading, and bound to their key and aad", () => {
  const key = randomBytes(32);
  const sealed = seal(key, Buffer.from(marker("shared")), "host|v1|NAME");
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12)).setAAD(Buffer.from("host|v1|NAME"));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  assert.equal(Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]).toString(), marker("shared"));
  assert.equal(unseal(key, sealed, "host|v1|NAME").toString(), marker("shared"));
  assert.throws(() => unseal(key, sealed, "host|v1|OTHER"), "another aad does not open it");
  assert.throws(() => unseal(randomBytes(32), sealed, "host|v1|NAME"), "nor another key");
  assert.ok(!holds(sealed, marker("shared")));
});

test("a sealing changed in any byte, or cut short, never opens", () => {
  const key = randomBytes(32);
  const sealed = seal(key, Buffer.from(marker("bytes")), "host|v1|NAME");
  for (const at of [0, 12, sealed.length - 1]) {
    const changed = Buffer.from(sealed);
    changed[at] ^= 0x01;
    assert.throws(() => unseal(key, changed, "host|v1|NAME"), `byte ${at}`);
  }
  assert.throws(() => unseal(key, sealed.subarray(0, 27), "host|v1|NAME"), /too short/);
});
