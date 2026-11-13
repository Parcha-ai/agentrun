// The server's sealed keys in the one store (server-keys.ts over store.sealedKeys), sealed under the seal key with
// store/seal.ts (AAD sealed_keys|<name>|sealed): the store-backed replacement for the tool-keys.json field store. A value
// opens only under the seal key it was sealed with; another key, or none saved, reads as not set.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";

const { getSealedKey, putSealedKey, removeSealedKey, sealedKeyNames } = await import("../dist/server-keys.js");

const KEY = Buffer.from(randomBytes(32));
const OTHER = Buffer.from(randomBytes(32));

test("a key saved sealed reads back under the same seal key; another key reads it as not set", async (t) => {
  const { store } = await storeOn(t);
  assert.equal(await getSealedKey(store, KEY, "ANTHROPIC_API_KEY"), undefined, "none saved");
  await putSealedKey(store, KEY, "ANTHROPIC_API_KEY", "sk-ant-secret");
  assert.equal(await getSealedKey(store, KEY, "ANTHROPIC_API_KEY"), "sk-ant-secret", "opens under its seal key");
  assert.equal(await getSealedKey(store, OTHER, "ANTHROPIC_API_KEY"), undefined, "another seal key reads it as not set");
  // The store holds only bytes, sealed: not the value.
  const bytes = await store.sealedKeys.get("ANTHROPIC_API_KEY");
  assert.ok(bytes instanceof Uint8Array && !Buffer.from(bytes).toString("utf8").includes("sk-ant-secret"), "stored sealed, not in the clear");
});

test("a value sealed for one name does not open under another (the AAD binds it to its name)", async (t) => {
  const { store } = await storeOn(t);
  await putSealedKey(store, KEY, "archil.api_key", "disk-key-123");
  // Copy the bytes to another name's row and try to open there: the AAD (sealed_keys|<name>|sealed) refuses it.
  const bytes = await store.sealedKeys.get("archil.api_key");
  await store.sealedKeys.put("E2B_API_KEY", bytes);
  assert.equal(await getSealedKey(store, KEY, "E2B_API_KEY"), undefined, "moved to another name, it does not open");
  assert.equal(await getSealedKey(store, KEY, "archil.api_key"), "disk-key-123", "at its own name it opens");
});

test("names lists saved keys; remove drops one", async (t) => {
  const { store } = await storeOn(t);
  await putSealedKey(store, KEY, "archil.api_key", "a");
  await putSealedKey(store, KEY, "E2B_API_KEY", "b");
  assert.deepEqual(await sealedKeyNames(store), ["E2B_API_KEY", "archil.api_key"]);
  await removeSealedKey(store, "archil.api_key");
  assert.deepEqual(await sealedKeyNames(store), ["E2B_API_KEY"]);
  assert.equal(await getSealedKey(store, KEY, "archil.api_key"), undefined, "removed");
});
