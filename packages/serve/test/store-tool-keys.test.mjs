// The tool keys over the one store (tool-keys-store.ts): a value is a sealed row in store.sealedKeys, read through an
// in-memory snapshot the server loads once; GET names each field and where it is set, never a value; a value that does not
// open (another seal key, a damaged row) is asked for again, told apart. A real store on a temp file.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";
import { toolKeysOverStore, sealedToolKeyBytes, TOOL_KEY_CHECKS_KEY } from "../dist/tool-keys-store.js";
import { TOOL_KEYS, SEAL_KEY_ENV } from "../dist/tool-keys.js";
import { ApiError } from "../dist/errors.js";

const KEY = randomBytes(32);
const sealEnv = (key = KEY, extra = {}) => ({ [SEAL_KEY_ENV]: Buffer.from(key).toString("base64"), ...extra });
const quiet = () => {};
const TOOL_ROW = TOOL_KEYS.find((r) => r.kind === "tool");
const MODEL_ROW = TOOL_KEYS.find((r) => r.kind === "model");
const FIELD = TOOL_ROW.fields[0];
const OTHER_FIELD = (MODEL_ROW ?? TOOL_KEYS.find((r) => r.id !== TOOL_ROW.id)).fields[0];

/** A loaded store-backed ToolKeys on a fresh store. */
async function storeKeys(t, { env = sealEnv(), clock } = {}) {
  const { store } = await storeOn(t, clock ? { clock } : {});
  const keys = toolKeysOverStore(store, env, quiet);
  await keys.load();
  return { store, keys };
}

test("a tool key saved is kept sealed at rest and read back by name; the view says set/stored, never the value", async (t) => {
  const { store, keys } = await storeKeys(t);
  assert.equal(keys.value(FIELD), undefined, "none saved");
  await keys.save(TOOL_ROW.id, { values: { [FIELD]: "sk-secret-123" } });
  assert.equal(keys.value(FIELD), "sk-secret-123", "read back by name");
  assert.deepEqual(keys.values(), { [FIELD]: "sk-secret-123" });
  const bytes = await store.sealedKeys.get(FIELD);
  assert.ok(bytes instanceof Uint8Array && !Buffer.from(bytes).toString("utf8").includes("sk-secret-123"), "sealed at rest, not in the clear");
  const field = keys.view().keys.find((k) => k.id === TOOL_ROW.id).fields.find((f) => f.name === FIELD);
  assert.deepEqual(field, { name: FIELD, set: true, source: "stored" });
  assert.ok(!JSON.stringify(keys.view()).includes("sk-secret-123"), "the view never holds the value");
});

test("a reload reads the saved value back from the store (the snapshot is the store's)", async (t) => {
  const { store, keys } = await storeKeys(t);
  await keys.save(TOOL_ROW.id, { values: { [FIELD]: "sk-persisted" } });
  const again = toolKeysOverStore(store, sealEnv(), quiet);
  await again.load();
  assert.equal(again.value(FIELD), "sk-persisted", "a second instance loads it from the store");
});

test("with no seal key there are no tool keys: they are never kept or read in the clear (the server starts with its key)", async (t) => {
  const { store } = await storeOn(t);
  assert.throws(() => toolKeysOverStore(store, {}, quiet), /kept under the server's seal key \(AGENTRUN_SEAL_KEY\)/);
});

test("PUT refuses an unknown key, an unknown field, empty values, a control character and an over-long value", async (t) => {
  const { keys } = await storeKeys(t);
  await assert.rejects(() => keys.save("not-a-key", { values: { [FIELD]: "x" } }), (e) => e instanceof ApiError && e.extra.fields?.[0]?.field === "key_id");
  await assert.rejects(() => keys.save(TOOL_ROW.id, { values: { nope: "x" } }), (e) => e.extra.fields?.some((i) => i.field === "values.nope" && i.reason === "not_allowed"));
  await assert.rejects(() => keys.save(TOOL_ROW.id, { values: {} }), (e) => e.extra.fields?.some((i) => i.field === "values" && i.reason === "wrong_type"));
  await assert.rejects(() => keys.save(TOOL_ROW.id, { values: { [FIELD]: "a\u0007b" } }), (e) => e.extra.fields?.some((i) => i.reason === "invalid"));
  await assert.rejects(() => keys.save(TOOL_ROW.id, { values: { [FIELD]: "x".repeat(2000) } }), (e) => e.extra.fields?.some((i) => i.reason === "too_long"));
});

test("a field the server is started with is the server's: GET says source server, and a save or delete of it is 409", async (t) => {
  const env = sealEnv(KEY, { [FIELD]: "from-launcher" });
  const { keys } = await storeKeys(t, { env });
  const field = keys.view().keys.find((k) => k.id === TOOL_ROW.id).fields.find((f) => f.name === FIELD);
  assert.deepEqual(field, { name: FIELD, set: true, source: "server" });
  await assert.rejects(() => keys.save(TOOL_ROW.id, { values: { [FIELD]: "x" } }), (e) => e instanceof ApiError && e.code === "key_set_by_server");
  if (TOOL_ROW.fields.length === 1) await assert.rejects(() => keys.remove(TOOL_ROW.id), (e) => e instanceof ApiError && e.code === "key_set_by_server");
});

test("remove drops the stored fields and the check; a remove of a key with nothing stored writes nothing", async (t) => {
  const { store, keys } = await storeKeys(t);
  await keys.remove(TOOL_ROW.id); // nothing stored
  assert.equal(await store.settings.get(TOOL_KEY_CHECKS_KEY), undefined, "no write when nothing was stored");
  await keys.save(TOOL_ROW.id, { values: { [FIELD]: "sk-x" } }, { state: "accepted", at: "2026-11-09T00:00:00.000Z" });
  await keys.remove(TOOL_ROW.id);
  assert.equal(keys.value(FIELD), undefined, "stored field gone");
  assert.equal(await store.sealedKeys.get(FIELD), undefined, "row gone");
  const key = keys.view().keys.find((k) => k.id === TOOL_ROW.id);
  assert.equal(key.check, null, "the check is gone");
});

test("a save with a check shows it; a stored key with no check reads as not checked (saved before a check)", async (t) => {
  const { store, keys } = await storeKeys(t);
  await keys.save(TOOL_ROW.id, { values: { [FIELD]: "sk-x" } }, { state: "accepted", at: "2026-11-09T01:00:00.000Z" });
  assert.deepEqual(keys.view().keys.find((k) => k.id === TOOL_ROW.id).check, { state: "accepted", at: "2026-11-09T01:00:00.000Z" });
  // A field written straight to the store with no check row: reads as not_checked (UNCHECKED).
  await store.sealedKeys.put(OTHER_FIELD, sealedToolKeyBytes(KEY, OTHER_FIELD, "sk-raw"));
  const fresh = toolKeysOverStore(store, sealEnv(), quiet);
  await fresh.load();
  const otherKey = fresh.view().keys.find((k) => k.fields.some((f) => f.name === OTHER_FIELD));
  assert.equal(otherKey.check.state, "not_checked", "no check row reads as not checked");
});

test("a value that does not open is asked for again, told apart: another key, a damaged row", async (t) => {
  // Another seal key: the fingerprint no longer matches -> seal_key_changed.
  const saved = await storeKeys(t);
  await saved.keys.save(TOOL_ROW.id, { values: { [FIELD]: "sk-x" } });
  const changed = toolKeysOverStore(saved.store, sealEnv(randomBytes(32)), quiet);
  await changed.load();
  assert.equal(changed.value(FIELD), undefined);
  assert.equal(changed.view().reenter.reason, "seal_key_changed");
  assert.ok(changed.view().keys.find((k) => k.id === TOOL_ROW.id).fields[0].stored_unreadable);

  // A damaged row under the right key and matching fingerprint -> file_unreadable.
  const dmg = await storeKeys(t);
  await dmg.keys.save(TOOL_ROW.id, { values: { [FIELD]: "sk-x" } });
  await dmg.store.sealedKeys.put(FIELD, Uint8Array.from(Buffer.from("garbage-not-sealed")));
  const reopened = toolKeysOverStore(dmg.store, sealEnv(), quiet);
  await reopened.load();
  assert.equal(reopened.value(FIELD), undefined);
  assert.equal(reopened.view().reenter.reason, "file_unreadable");
});

test("a sealed value moved to another field's name does not open there (the AAD binds it to its name)", async (t) => {
  const { store, keys } = await storeKeys(t);
  await keys.save(TOOL_ROW.id, { values: { [FIELD]: "sk-bound" } });
  const bytes = await store.sealedKeys.get(FIELD);
  await store.sealedKeys.put(OTHER_FIELD, bytes); // same bytes, another name
  const fresh = toolKeysOverStore(store, sealEnv(), quiet);
  await fresh.load();
  assert.equal(fresh.value(OTHER_FIELD), undefined, "moved to another name, it does not open");
  assert.equal(fresh.value(FIELD), "sk-bound", "at its own name it opens");
});

test("each key row's secrets are SecretMeta, named <kind>:<FIELD>; saving one key moves no other key's changed_at", async (t) => {
  const env = sealEnv();
  const clock = { now: Date.parse("2026-11-09T03:00:00.000Z") };
  const store = await storeKeys(t, { env, clock });
  const secretOf = (keys, field) => keys.view().keys.flatMap((k) => k.secrets).find((meta) => meta.name.endsWith(`:${field}`));
  const row = store.keys.view().keys.find((k) => k.id === TOOL_ROW.id);
  assert.deepEqual(row.secrets.map((meta) => meta.name), TOOL_ROW.fields.map((name) => `tool:${name}`), "named tool:<FIELD>, in fields' order");
  assert.deepEqual(secretOf(store.keys, FIELD), { name: `tool:${FIELD}`, set: false, source: null, changed_at: null }, "unset: no source, no time");
  const modelRow = store.keys.view().keys.find((k) => k.kind === "model");
  assert.ok(modelRow.secrets.every((meta) => meta.name.startsWith("model:")), "a model key's are model:<FIELD>");
  await store.keys.save(TOOL_ROW.id, { values: { [FIELD]: "sk-first" } });
  const first = secretOf(store.keys, FIELD);
  assert.deepEqual(first, { name: `tool:${FIELD}`, set: true, source: "console", changed_at: "2026-11-09T03:00:00.000Z" }, "saved here by the owner, at its own row's time");
  clock.now += 60_000;
  await store.keys.save(MODEL_ROW.id, { values: { [MODEL_ROW.fields[0]]: "sk-second" } });
  assert.deepEqual(secretOf(store.keys, FIELD), first, "another key's save leaves this one's time");
  assert.equal(secretOf(store.keys, MODEL_ROW.fields[0]).changed_at, "2026-11-09T03:01:00.000Z", "and the saved one's is its own");
  // After a restart, the store's time is read back from the row.
  const again = toolKeysOverStore(store.store, env, quiet);
  await again.load();
  assert.deepEqual(secretOf(again, FIELD), first, "read back whole");
  // A key the server is started with is env's, with no time here.
  const started = toolKeysOverStore(store.store, sealEnv(KEY, { [FIELD]: "sk-env" }), quiet);
  await started.load();
  assert.deepEqual(secretOf(started, FIELD), { name: `tool:${FIELD}`, set: true, source: "env", changed_at: null });
  assert.ok(!JSON.stringify(store.keys.view()).includes("sk-first"), "never the value");
});
