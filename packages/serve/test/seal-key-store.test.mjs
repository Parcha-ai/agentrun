// The seal key lives with the data, and the store knows it (seal-key.ts bootSealKey). AGENTRUN_SEAL_KEY when it is
// handed; else the key file in the data directory, beside the store (seal/seal.key, 0600 in a 0700 directory), made at
// the first start. The store records the key's fingerprint (an HMAC of a fixed label under the key, never the key), and
// every process that opens it (the server, a runner, the import) checks the key it holds against that record: a store
// whose secrets were sealed with another key refuses to start, in words, and no key is ever made over sealed secrets. A
// fresh store records the fingerprint at its first start. On Postgres a second machine with another key refuses the same
// way. Only the server's start makes and records a key; a runner never does. Two data directories in one process each
// keep their own key.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { scratch, withEnv } from "./support.mjs";
import { dropSchema, freshSchema, PG_URL, postgresOnly } from "./store-target.mjs";

const { startServe } = await import("../dist/server.js");
const { openSqliteStore, openPostgresStore, sealColumn, sealedAt } = await import("../dist/store/index.js");
const { startRunnerProcess } = await import("../dist/runner/main.js");
const { importCommand } = await import("../dist/import.js");

/** The refusal, word for word: a store whose secrets another key sealed. */
const WORDS = "this store's secrets were sealed with another key; hand the server the original AGENTRUN_SEAL_KEY";
const refusedInWords = (error) => String(error?.message ?? error).includes(WORDS);
const newKey = () => randomBytes(32).toString("base64");
const keyFile = (data) => join(data, "seal", "seal.key");

/** A test's own environment: no seal key handed, a config home of its own (none of this machine's). */
async function cleanEnv(t, vars = {}) {
  const config = await scratch(t);
  withEnv(t, { XDG_CONFIG_HOME: config, ...vars }, ["AGENTRUN_SEAL_KEY"]);
  return config;
}

/** A start that must be refused in the words: one that starts after all is closed, then fails the test. */
async function refuses(starting, words) {
  let started;
  try {
    started = await starting;
  } catch (error) {
    assert.ok(words ? words.test(String(error?.message)) : refusedInWords(error), `refused in other words: ${error?.message}`);
    return;
  }
  await started.close();
  assert.fail("it started over secrets sealed with another key");
}

/** Starts a server on `data` and closes it. */
async function startAndStop(data) {
  const server = await startServe({ data, port: 0 });
  await server.close();
}

/** A sealed tool key put in the store at `data` under `key` (the server's own rows hold the same). */
async function plantSecret(data, key) {
  const store = await openSqliteStore({ dataDir: data, role: "server" });
  try {
    await store.sealedKeys.put("OPENAI_API_KEY", sealColumn(Buffer.from(key, "base64"), sealedAt.sealedKey("OPENAI_API_KEY"), "sk-planted-value-0123456789"));
  } finally {
    await store.close();
  }
}

/** The fingerprint the store at `data` records, as its settings row holds it (undefined with none). */
function recorded(data) {
  const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'seal_key'").get();
    return row === undefined ? undefined : JSON.parse(row.value);
  } finally {
    db.close();
  }
}

test("(c) a fresh store: the first start makes the key in the data directory (0600, its directory 0700) and records its fingerprint; the next start with no key handed opens it", { timeout: 60_000 }, async (t) => {
  const config = await cleanEnv(t);
  const data = join(await scratch(t), "data");
  await startAndStop(data);
  const file = keyFile(data);
  assert.ok(existsSync(file), "the key is made in the data directory");
  assert.equal(statSync(file).mode & 0o777, 0o600, "the key file is 0600");
  assert.equal(statSync(join(data, "seal")).mode & 0o777, 0o700, "its directory is 0700");
  assert.equal(existsSync(join(config, "agentrun", "seal.key")), false, "nothing is kept under the config home");
  const text = readFileSync(file, "utf8").trim();
  const fingerprint = recorded(data);
  assert.ok(fingerprint, "the store records the key's fingerprint");
  const held = JSON.stringify(fingerprint);
  assert.ok(!held.includes(text) && !held.includes(Buffer.from(text, "base64").toString("hex")), "the record is never the key");
  assert.equal(fingerprint.fingerprint, createHmac("sha256", Buffer.from(text, "base64")).update("agentrun seal key fingerprint v1").digest("base64url"), "an HMAC of the fixed label under the key");
  await startAndStop(data);
  assert.equal(readFileSync(file, "utf8").trim(), text, "the second start reads the same key; none is made");
  assert.deepEqual(recorded(data), fingerprint);
});

test("(a) the key file is lost and the store holds secrets: the start refuses in words, and no new key is made", { timeout: 60_000 }, async (t) => {
  await cleanEnv(t);
  const data = join(await scratch(t), "data");
  await startAndStop(data);
  await plantSecret(data, readFileSync(keyFile(data), "utf8").trim());
  rmSync(keyFile(data));
  await refuses(startServe({ data, port: 0 }));
  assert.equal(existsSync(keyFile(data)), false, "no key is made over the store's secrets");
  // A store that holds sealed secrets and no fingerprint (one an earlier build sealed): refused the same, nothing made.
  const old = join(await scratch(t), "old");
  mkdirSync(old, { recursive: true, mode: 0o700 });
  await plantSecret(old, newKey());
  await refuses(startServe({ data: old, port: 0 }));
  assert.equal(existsSync(keyFile(old)), false, "no key is made over secrets sealed under an unknown key");
  assert.equal(recorded(old), undefined, "and no fingerprint is recorded for a key that is not the store's");
});

test("(b) AGENTRUN_SEAL_KEY set to another valid key over a store with a fingerprint, or with secrets, refuses", { timeout: 60_000 }, async (t) => {
  await cleanEnv(t);
  const first = newKey();
  // A fingerprint and no secrets.
  const data = join(await scratch(t), "data");
  process.env.AGENTRUN_SEAL_KEY = first;
  await startAndStop(data);
  assert.equal(existsSync(keyFile(data)), false, "a handed key writes no key file");
  process.env.AGENTRUN_SEAL_KEY = newKey();
  await refuses(startServe({ data, port: 0 }));
  process.env.AGENTRUN_SEAL_KEY = first;
  await startAndStop(data);
  // Secrets sealed under the first and no fingerprint (an earlier build's store): a key that opens none of them is refused,
  // the one that opens them is taken and its fingerprint recorded.
  const old = join(await scratch(t), "old");
  mkdirSync(old, { recursive: true, mode: 0o700 });
  await plantSecret(old, first);
  process.env.AGENTRUN_SEAL_KEY = newKey();
  await refuses(startServe({ data: old, port: 0 }));
  process.env.AGENTRUN_SEAL_KEY = first;
  await startAndStop(old);
  assert.ok(recorded(old), "the store's own key is recorded");
  // A key file in the data directory that is not the store's: refused the same.
  delete process.env.AGENTRUN_SEAL_KEY;
  const kept = join(await scratch(t), "kept");
  await startAndStop(kept);
  writeFileSync(keyFile(kept), `${newKey()}\n`, { mode: 0o600 });
  await refuses(startServe({ data: kept, port: 0 }));
});

test("a runner refuses a store sealed with another key, as the server does; with the data directory's key it starts", { timeout: 60_000 }, async (t) => {
  await cleanEnv(t);
  const data = join(await scratch(t), "data");
  await startAndStop(data);
  const createLoop = () => assert.fail("no run is claimed");
  await refuses(startRunnerProcess({ dataDir: data, env: { ...process.env, AGENTRUN_SEAL_KEY: newKey() }, createLoop, name: "runner-wrong" }));
  // With no key handed it reads the data directory's, the server's, and starts.
  const runner = await startRunnerProcess({ dataDir: data, env: { ...process.env }, createLoop, name: "runner-right" });
  await runner.close();
  rmSync(keyFile(data));
  await refuses(startRunnerProcess({ dataDir: data, env: { ...process.env }, createLoop, name: "runner-none" }));
  assert.equal(existsSync(keyFile(data)), false, "a runner makes no key over the store's fingerprint");
});

test("the import refuses a store sealed with another key, in the same words", { timeout: 60_000 }, async (t) => {
  await cleanEnv(t);
  const data = join(await scratch(t), "data");
  await startAndStop(data);
  process.env.AGENTRUN_SEAL_KEY = newKey();
  const said = [];
  const error = console.error;
  console.error = (line) => void said.push(String(line));
  t.after(() => void (console.error = error));
  let code;
  try {
    code = await importCommand(["--data", data], "usage", { home: await scratch(t), out: () => {} });
  } catch (thrown) {
    said.push(String(thrown?.message));
  }
  console.error = error;
  assert.notEqual(code, 0, "the import does not go on");
  assert.ok(said.some((line) => line.includes(WORDS)), said.join("\n"));
});

test("(d) Postgres: a second process with another key on the same database refuses; one with the recorded key starts", { ...postgresOnly("a shared Postgres store"), timeout: 60_000 }, async (t) => {
  await cleanEnv(t);
  const schema = await freshSchema();
  t.after(() => dropSchema(schema));
  const { bootSealKey } = await import("../dist/seal-key.js");
  const first = newKey();
  const server = await openPostgresStore({ url: PG_URL, schema });
  t.after(() => server.close());
  (await bootSealKey(server, await scratch(t), { given: first })).release();
  // A second machine: its own data directory, the same database, another key handed.
  const elsewhere = await openPostgresStore({ url: PG_URL, schema, role: "runner" });
  t.after(() => elsewhere.close());
  await refuses(bootSealKey(elsewhere, await scratch(t), { given: newKey() }).then(() => ({ close: async () => {} })));
  // No key at all on that machine: refused, none made.
  const bare = await scratch(t);
  await refuses(bootSealKey(elsewhere, bare, { given: undefined }).then(() => ({ close: async () => {} })));
  assert.equal(existsSync(keyFile(bare)), false, "no key is made over a store that records another");
  // The runner process on that machine, handed another key: refused; handed the store's: it starts.
  const env = { ...process.env, AGENTRUN_STORE_SCHEMA: schema };
  const createLoop = () => assert.fail("no run is claimed");
  await refuses(startRunnerProcess({ dataDir: await scratch(t), storeUrl: PG_URL, env: { ...env, AGENTRUN_SEAL_KEY: newKey() }, createLoop, name: "pg-wrong" }));
  const runner = await startRunnerProcess({ dataDir: await scratch(t), storeUrl: PG_URL, env: { ...env, AGENTRUN_SEAL_KEY: first }, createLoop, name: "pg-right" });
  await runner.close();
});

test("a store whose only secret is kept beside it (the outbound webhook's signing secret, in webhook.json) and no record of its key: a start with no key refuses and makes none; with the key it opens and records it", { timeout: 60_000 }, async (t) => {
  await cleanEnv(t);
  const key = newKey();
  const data = join(await scratch(t), "data");
  process.env.AGENTRUN_SEAL_KEY = key;
  const server = await startServe({ data, port: 0 });
  const { client } = await import("./support.mjs");
  assert.equal((await client(server.baseUrl, server.token)("PUT", "/settings/webhook", { url: "http://127.0.0.1:9/hook" })).status, 201);
  await server.close();
  delete process.env.AGENTRUN_SEAL_KEY;
  // The store's record of its key gone, and no secret in the store itself: the webhook's is the only one.
  const db = new DatabaseSync(join(data, "store.sqlite"));
  db.prepare("DELETE FROM settings WHERE key = 'seal_key'").run();
  assert.equal(db.prepare("SELECT count(*) AS n FROM sealed_keys").get().n, 0, "no secret in the store");
  db.close();
  await refuses(startServe({ data, port: 0 }));
  assert.equal(existsSync(keyFile(data)), false, "no key is made over the webhook's secret");
  process.env.AGENTRUN_SEAL_KEY = newKey();
  await refuses(startServe({ data, port: 0 }));
  assert.equal(recorded(data), undefined, "a key that does not open it is never recorded");
  process.env.AGENTRUN_SEAL_KEY = key;
  await startAndStop(data);
  assert.ok(recorded(data), "the key that opens it is recorded");
});

test("a runner never makes or records a key: on a store the server has not keyed, with none handed, it refuses in words", { timeout: 60_000 }, async (t) => {
  await cleanEnv(t);
  const data = join(await scratch(t), "data");
  // The store set up as a server sets it up, with no server start: no key, no record.
  const store = await openSqliteStore({ dataDir: data, role: "server" });
  await store.close();
  const createLoop = () => assert.fail("no run is claimed");
  await assert.rejects(startRunnerProcess({ dataDir: data, env: { ...process.env }, createLoop, name: "runner-first" }), (error) => /start the server on this data directory first/.test(String(error.message)));
  assert.equal(existsSync(keyFile(data)), false, "no key made by a runner");
  // Handed a key, it starts, and records nothing: the server's start records its key.
  const runner = await startRunnerProcess({ dataDir: data, env: { ...process.env, AGENTRUN_SEAL_KEY: newKey() }, createLoop, name: "runner-handed" });
  await runner.close();
  assert.equal(recorded(data), undefined, "a runner records no key");
});

test("two servers on two data directories in one process each keep their own key: each opens only its own sealed secrets, never the other's (handed the other's key, a store refuses in the words), and both keys are on the redaction list while open", { timeout: 120_000 }, async (t) => {
  await cleanEnv(t);
  const { client } = await import("./support.mjs");
  const { hostSecrets } = await import("../dist/secrets.js");
  const { webhookSecretIn } = await import("../dist/webhooks.js");
  const [a, b] = [join(await scratch(t), "a"), join(await scratch(t), "b")];
  // Both boot at once, each making a key of its own in its data directory.
  const [first, second] = await Promise.all([startServe({ data: a, port: 0 }), startServe({ data: b, port: 0 })]);
  const open = new Set([first, second]);
  t.after(() => Promise.all([...open].map((server) => server.close())));
  const [keyA, keyB] = [readFileSync(keyFile(a), "utf8").trim(), readFileSync(keyFile(b), "utf8").trim()];
  assert.notEqual(keyA, keyB, "two keys");
  // Each seals a secret while both are open, and reads it back under its own key.
  for (const [server, url] of [[first, "http://127.0.0.1:9/a"], [second, "http://127.0.0.1:9/b"]]) {
    const api = client(server.baseUrl, server.token);
    assert.equal((await api("PUT", "/settings/webhook", { url })).status, 201);
    assert.equal((await api("GET", "/settings/webhook")).body.signing, "sealed", `${url}: sealed under its own key and read back`);
  }
  // What each sealed opens under its own key alone, never the other's.
  for (const [data, own, other] of [[a, keyA, keyB], [b, keyB, keyA]]) {
    assert.ok("secret" in webhookSecretIn(data, { AGENTRUN_SEAL_KEY: own }), `${data}: its own key opens it`);
    assert.ok(!("secret" in webhookSecretIn(data, { AGENTRUN_SEAL_KEY: other })), `${data}: the other's key does not`);
  }
  // Both keys are cut from what a run writes while their servers are open.
  const listed = hostSecrets({});
  assert.ok(listed.includes(keyA) && listed.includes(keyB), "both keys on the redaction list");
  for (const server of [first, second]) {
    await server.close();
    open.delete(server);
  }
  assert.ok(!hostSecrets({}).some((value) => value === keyA || value === keyB), "closed, neither is held");
  // Each store opens with its own key alone: handed the other's, it refuses in the words.
  for (const [data, other] of [[a, keyB], [b, keyA]]) {
    process.env.AGENTRUN_SEAL_KEY = other;
    await refuses(startServe({ data, port: 0 }));
  }
  delete process.env.AGENTRUN_SEAL_KEY;
  // Each opens alone again under its own key.
  for (const data of [a, b]) {
    const again = await startServe({ data, port: 0 });
    const read = (await client(again.baseUrl, again.token)("GET", "/settings/webhook")).body;
    await again.close();
    assert.equal(read.signing, "sealed", `${data}: its webhook's secret opens under its own key`);
  }
});
