// The seal key lives with the data, and the store knows it (seal-key.ts bootSealKey). AGENTRUN_SEAL_KEY when it is
// handed; else the key file in the data directory, beside the store (seal/seal.key, 0600 in a 0700 directory), made at
// the first start. The store records the key's fingerprint (an HMAC of a fixed label under the key, never the key), and
// every process that opens it (the server, a runner, the import) checks the key it holds against that record: a store
// whose secrets were sealed with another key refuses to start, in words, and no key is ever made over sealed secrets. A
// fresh store records the fingerprint at its first start. On Postgres a second machine with another key refuses the same
// way. An install that kept its key under the config home (~/.config/agentrun/seal.key) has it moved into the data
// directory at its next start, only when that key is the store's.
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
async function refuses(starting) {
  let started;
  try {
    started = await starting;
  } catch (error) {
    assert.ok(refusedInWords(error), `refused in other words: ${error?.message}`);
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

test("an install that kept its key under the config home has it moved into the data directory when it is the store's, never when it is not", { timeout: 60_000 }, async (t) => {
  const config = await cleanEnv(t);
  const legacyDir = join(config, "agentrun");
  mkdirSync(legacyDir, { mode: 0o700 });
  chmodSync(legacyDir, 0o700);
  const legacy = newKey();
  writeFileSync(join(legacyDir, "seal.key"), `${legacy}\n`, { mode: 0o600 });
  // The store an earlier build sealed under the config home's key: secrets, and no fingerprint.
  const data = join(await scratch(t), "data");
  mkdirSync(data, { recursive: true, mode: 0o700 });
  await plantSecret(data, legacy);
  await startAndStop(data);
  assert.equal(readFileSync(keyFile(data), "utf8").trim(), legacy, "the store's key, moved into the data directory");
  assert.equal(statSync(keyFile(data)).mode & 0o777, 0o600);
  assert.ok(recorded(data), "and its fingerprint recorded");
  // A config home key that is not the store's is never copied: refused, nothing made.
  const other = join(await scratch(t), "other");
  mkdirSync(other, { recursive: true, mode: 0o700 });
  await plantSecret(other, newKey());
  await refuses(startServe({ data: other, port: 0 }));
  assert.equal(existsSync(keyFile(other)), false);
});

test("(d) Postgres: a second process with another key on the same database refuses; one with the recorded key starts", { ...postgresOnly("a shared Postgres store"), timeout: 60_000 }, async (t) => {
  await cleanEnv(t);
  const schema = await freshSchema();
  t.after(() => dropSchema(schema));
  const { bootSealKey } = await import("../dist/seal-key.js");
  const first = newKey();
  const server = await openPostgresStore({ url: PG_URL, schema });
  t.after(() => server.close());
  await bootSealKey(server, await scratch(t), { given: first });
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

test("an earlier build's key is moved in for a store whose only secret is kept beside it (the outbound webhook's signing secret), and a new key is never made over that secret", { timeout: 60_000 }, async (t) => {
  const config = await cleanEnv(t);
  const legacy = newKey();
  // A server of the earlier build's kind: its key handed, a webhook set (its secret sealed in webhook.json, not the
  // store), then the store's record of the key dropped, as a store that build left has none.
  const data = join(await scratch(t), "data");
  process.env.AGENTRUN_SEAL_KEY = legacy;
  const server = await startServe({ data, port: 0 });
  const { client } = await import("./support.mjs");
  assert.equal((await client(server.baseUrl, server.token)("PUT", "/settings/webhook", { url: "http://127.0.0.1:9/hook" })).status, 201);
  await server.close();
  delete process.env.AGENTRUN_SEAL_KEY;
  const db = new DatabaseSync(join(data, "store.sqlite"));
  db.prepare("DELETE FROM settings WHERE key = 'seal_key'").run();
  assert.equal(db.prepare("SELECT count(*) AS n FROM sealed_keys").get().n, 0, "no secret in the store");
  db.close();
  // No key under the config home either: refused, nothing made over the webhook's secret.
  await refuses(startServe({ data, port: 0 }));
  assert.equal(existsSync(keyFile(data)), false, "no key is made over the webhook's secret");
  // The earlier build's key under the config home: it opens the webhook's secret, so it is moved in.
  mkdirSync(join(config, "agentrun"), { mode: 0o700 });
  writeFileSync(join(config, "agentrun", "seal.key"), `${legacy}\n`, { mode: 0o600 });
  await startAndStop(data);
  assert.equal(readFileSync(keyFile(data), "utf8").trim(), legacy, "the webhook's key, moved into the data directory");
});

test("two servers on two data directories in one process each keep their own key: what each saves opens under its own at its next start", { timeout: 120_000 }, async (t) => {
  await cleanEnv(t);
  const { client } = await import("./support.mjs");
  const [a, b] = [join(await scratch(t), "a"), join(await scratch(t), "b")];
  // Both boot at once, each making a key of its own in its data directory.
  const [first, second] = await Promise.all([startServe({ data: a, port: 0 }), startServe({ data: b, port: 0 })]);
  assert.notEqual(readFileSync(keyFile(a), "utf8"), readFileSync(keyFile(b), "utf8"), "two keys");
  for (const [server, url] of [[first, "http://127.0.0.1:9/a"], [second, "http://127.0.0.1:9/b"]]) assert.equal((await client(server.baseUrl, server.token)("PUT", "/settings/webhook", { url })).status, 201);
  await Promise.all([first.close(), second.close()]);
  for (const data of [a, b]) {
    const again = await startServe({ data, port: 0 });
    const read = (await client(again.baseUrl, again.token)("GET", "/settings/webhook")).body;
    await again.close();
    assert.equal(read.signing, "sealed", `${data}: its webhook's secret opens under its own key: ${JSON.stringify(read)}`);
  }
});
