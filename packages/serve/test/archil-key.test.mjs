// The one Archil account-key resolver (workspace/archil-key.ts) every reader of the key goes through: the Archil routes'
// test, the server's read-only view of a run's folder, and the claim with its per-run mount credential. The server's
// environment first (ARCHIL_API_KEY, not empty), then the sealed "archil.api_key" row opened with the seal key; refused
// in words naming what to save, never a value. Over a real store on a temp file; nothing leaves this machine.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { putSealedKey } from "../dist/server-keys.js";
import { ARCHIL_API_KEY_ROW, ArchilClaimRefused, archilApiKey } from "../dist/workspace/index.js";
import { storeOn } from "./store-helpers.mjs";

const SAVED = "archil-saved-key-0001";
const FROM_ENV = "archil-env-key-0002";

test("the environment first, then the sealed row; an empty variable is not a key", async (t) => {
  const { store } = await storeOn(t);
  const sealKey = randomBytes(32);
  await putSealedKey(store, sealKey, ARCHIL_API_KEY_ROW, SAVED);
  assert.deepEqual(await archilApiKey({ env: { ARCHIL_API_KEY: FROM_ENV }, keys: store.sealedKeys, sealKey }), { value: FROM_ENV, source: "env" });
  assert.deepEqual(await archilApiKey({ env: { ARCHIL_API_KEY: "  " }, keys: store.sealedKeys, sealKey }), { value: SAVED, source: "console" });
  assert.deepEqual(await archilApiKey({ keys: store.sealedKeys, sealKey }), { value: SAVED, source: "console" });
  assert.deepEqual(await archilApiKey({ env: { ARCHIL_API_KEY: FROM_ENV }, keys: { get: () => assert.fail("the row is not read when the environment gives the key") }, sealKey: undefined }), { value: FROM_ENV, source: "env" }, "no seal key needed");
});

test("refused in words naming what to save, never a value: no key, no seal key, a row that does not open", async (t) => {
  const { store } = await storeOn(t);
  const refused = (promise, words) => assert.rejects(promise, (error) => error instanceof ArchilClaimRefused && words.test(error.message) && !error.message.includes(SAVED));
  await refused(archilApiKey({ keys: store.sealedKeys, sealKey: randomBytes(32) }), /no archil\.api_key key is saved.*ARCHIL_API_KEY/);
  await putSealedKey(store, randomBytes(32), ARCHIL_API_KEY_ROW, SAVED);
  await refused(archilApiKey({ keys: store.sealedKeys, sealKey: undefined }), /seal key/);
  await refused(archilApiKey({ keys: store.sealedKeys, sealKey: randomBytes(32) }), /does not open/);
});
