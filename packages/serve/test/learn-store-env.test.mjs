// Which learning store an agent's learning is in (learn/store-of.ts): the local folder under the data directory with no
// setting at all; code.storage only when the start is keyed with both AGENTRUN_CODE_STORAGE_NAME and
// AGENTRUN_CODE_STORAGE_KEY (the key read by name, as every secret is), each set wrong stopping the start in words that
// name the variable; and refused, every call failing closed, for a runner apart from its server's disk without them. A
// reset or an agent's delete while code.storage can't be reached is 503 unavailable, the agent's learning and its records
// kept, and the next call finishes it.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { made, learner } from "./learn-support.mjs";
import { serve } from "./support.mjs";

const { CODE_STORAGE_ENV, CodeStorageEnvInvalid, codeStorageFromEnv, LEARNING_APART, learningGenerations, learningStoreFromEnv, learningStoreOf, useLearningStore } = await import("../dist/learn/store-of.js");
const { learningInit } = await import("../dist/learn/folder.js");
const { runFacing } = await import("../dist/runner/runner-check.js");
const { RUN_SECRETS } = await import("../dist/run-secrets.js");
const { SECRET_NAMES } = await import("../dist/secrets.js");

const PEM = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" });
/** A PEM's armor (its first and last lines, the generated key's) around `body` in place of its own. */
const withBody = (pem, body) => { const lines = pem.trim().split("\n"); return `${lines[0]}\n${body}\n${lines.at(-1)}\n`; };
/** The settings an environment gives, its key read by name from `keys`. */
const fromEnv = (env, keys = {}) => codeStorageFromEnv(env, (name) => keys[name]);

test("no code.storage name is the local folder, a key or URL set alone said and ignored; name and key set is code.storage, its key read by name and never from the environment's values", () => {
  const said = [];
  const warn = (message) => said.push(message);
  assert.equal(codeStorageFromEnv({}, () => undefined, warn), undefined);
  assert.deepEqual(said, [], "nothing set, nothing said");
  // A launcher that holds every secret it knows of hands the key over unasked: no name, nothing turns on.
  assert.equal(codeStorageFromEnv({}, (name) => (name === CODE_STORAGE_ENV.key ? PEM : undefined), warn), undefined);
  assert.equal(codeStorageFromEnv({ [CODE_STORAGE_ENV.apiUrl]: "https://api.example-org.code.storage.invalid" }, () => undefined, warn), undefined);
  assert.deepEqual(said, [
    "AGENTRUN_CODE_STORAGE_KEY is set without AGENTRUN_CODE_STORAGE_NAME, so learning stays in the local folder: set AGENTRUN_CODE_STORAGE_NAME to keep it on code.storage.",
    "AGENTRUN_CODE_STORAGE_API_URL is set without AGENTRUN_CODE_STORAGE_NAME, so learning stays in the local folder: set AGENTRUN_CODE_STORAGE_NAME to keep it on code.storage.",
  ]);
  assert.ok(!said.join("\n").includes("PRIVATE KEY"), "the key is never said");
  assert.deepEqual(fromEnv({ [CODE_STORAGE_ENV.name]: "example-org" }, { [CODE_STORAGE_ENV.key]: PEM }), { name: "example-org", key: PEM.trim() });
  assert.deepEqual(fromEnv({ [CODE_STORAGE_ENV.name]: "example-org", [CODE_STORAGE_ENV.apiUrl]: "https://api.example-org.code.storage.invalid" }, { [CODE_STORAGE_ENV.key]: PEM }), { name: "example-org", key: PEM.trim(), apiUrl: "https://api.example-org.code.storage.invalid" });
  assert.throws(() => fromEnv({ [CODE_STORAGE_ENV.name]: "example-org", [CODE_STORAGE_ENV.key]: PEM }), CodeStorageEnvInvalid, "a key in the environment's values but not read by name is no key");
});

test("code.storage named but set wrong stops the start, naming the variable, and never says the key", () => {
  const refused = (env, keys, words) => assert.throws(() => fromEnv(env, keys), (error) => error instanceof CodeStorageEnvInvalid && words.test(error.message) && !error.message.includes("PRIVATE KEY"));
  refused({ [CODE_STORAGE_ENV.name]: "example-org" }, {}, /AGENTRUN_CODE_STORAGE_NAME is set without AGENTRUN_CODE_STORAGE_KEY/);
  refused({ [CODE_STORAGE_ENV.name]: "Example Org" }, { [CODE_STORAGE_ENV.key]: PEM }, /AGENTRUN_CODE_STORAGE_NAME is a code\.storage org name/);
  refused({ [CODE_STORAGE_ENV.name]: "example-org" }, { [CODE_STORAGE_ENV.key]: "not a key" }, /AGENTRUN_CODE_STORAGE_KEY is not a private key in PEM form/);
  refused({ [CODE_STORAGE_ENV.name]: "example-org", [CODE_STORAGE_ENV.apiUrl]: "http://api.example-org.code.storage.invalid" }, { [CODE_STORAGE_ENV.key]: PEM }, /AGENTRUN_CODE_STORAGE_API_URL is an https URL/);
});

test("a runner reads code.storage's settings from its environment (each name is run-facing); its key is a secret, held by name, and never handed to a run", () => {
  for (const name of Object.values(CODE_STORAGE_ENV)) assert.equal(runFacing(name), true, name);
  assert.ok(SECRET_NAMES.includes(CODE_STORAGE_ENV.key), "the launcher holds the key as a secret");
  assert.ok(!RUN_SECRETS.includes(CODE_STORAGE_ENV.key), "a run's tools are never handed it");
});

/** A server store's settings in memory (store/store.ts Settings: get, putIfAbsent, replaceIf, remove). */
function memorySettings() {
  const rows = new Map();
  return {
    rows,
    get: async (key) => (rows.has(key) ? structuredClone(rows.get(key)) : undefined),
    putIfAbsent: async (key, value) => (rows.has(key) ? structuredClone(rows.get(key)) : (rows.set(key, structuredClone(value)), structuredClone(value))),
    replaceIf: async (key, was, value) => (rows.has(key) && JSON.stringify(rows.get(key)) === JSON.stringify(was) ? (rows.set(key, structuredClone(value)), true) : false),
    remove: async (key) => void rows.delete(key),
  };
}

test("a start keyed for code.storage says so in one line: its org and how its repositories are named, never its key, a token or a URL", async (t) => {
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-store-of-"));
  t.after(() => (useLearningStore(data, undefined), rmSync(data, { recursive: true, force: true })));
  const said = [];
  const settings = memorySettings();
  learningStoreFromEnv(data, { [CODE_STORAGE_ENV.name]: "example-org", [CODE_STORAGE_ENV.apiUrl]: "https://api.example-org.code.storage.invalid" }, settings, { key: (name) => (name === CODE_STORAGE_ENV.key ? PEM : undefined), warn: (line) => said.push(line) });
  for (let i = 0; i < 20 && !said.length; i++) await new Promise((resolve) => setImmediate(resolve));
  const server = settings.rows.get("server_id")?.id;
  assert.match(server, /^[0-9a-f]{12}$/, "the server's id, made once in its store");
  assert.deepEqual(said, [`learning: on code.storage (org example-org), one repository per agent: agentrun-${server}-<agent>-g<generation>`]);
  assert.ok(!/PRIVATE|BEGIN|https?:|Bearer|eyJ/.test(said[0]), said[0]);
  assert.equal(learningStoreOf(data, "agent-one").id, "code.storage:example-org:agent-one");
  // The local folder's start says nothing.
  const quiet = [];
  learningStoreFromEnv(data, {}, memorySettings(), { key: () => undefined, warn: (line) => quiet.push(line) });
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(quiet, []);
});

test("each agent's repository generation is a setting of the server's store, moved by compare and swap; none is generation 0; dropped with the agent", async () => {
  const settings = memorySettings();
  const generations = learningGenerations(settings);
  assert.deepEqual(await generations.get("agent-one"), { n: 0 });
  assert.equal(await generations.set("agent-one", { n: 0 }, { n: 1, drop: [0] }), true);
  assert.equal(await generations.set("agent-one", { n: 0 }, { n: 1 }), false, "a stale generation moves nothing");
  assert.deepEqual(await generations.get("agent-one"), { n: 1, drop: [0] });
  assert.equal(await generations.set("agent-one", { n: 1, drop: [0] }, { n: 1 }), true);
  assert.deepEqual(settings.rows.get("learning-generation:agent-one"), { v: 1, n: 1 });
  assert.deepEqual(await generations.get("agent-two"), { n: 0 }, "each agent its own");
  await generations.drop("agent-one");
  assert.deepEqual(await generations.get("agent-one"), { n: 0 });
  settings.rows.set("learning-generation:agent-one", { v: 1, n: -1 });
  await assert.rejects(generations.get("agent-one"), (error) => error.name === "FolderUnreadable");
});

test("a data directory's store: the local folder by default, code.storage when set, refused (failing closed in words naming the settings) for a runner apart from its server's disk, the local folder again when unset", async (t) => {
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-store-of-"));
  t.after(() => (useLearningStore(data, undefined), rmSync(data, { recursive: true, force: true })));
  assert.match(learningStoreOf(data, "agent-one").id, /^local:/);
  await learningInit(learningStoreOf(data, "agent-one"));
  useLearningStore(data, { name: "example-org", key: PEM, apiUrl: "https://api.example-org.code.storage.invalid", serverId: async () => "0123456789ab", fetch: async () => { throw new Error("not reached"); } });
  assert.equal(learningStoreOf(data, "agent-one").id, "code.storage:example-org:agent-one");
  // A key that reads as a PEM but is no key: making the store never throws (every run makes one), each call fails closed.
  useLearningStore(data, { name: "example-org", key: withBody(PEM, "not-a-key"), serverId: async () => "0123456789ab", fetch: async () => { throw new Error("not reached"); } });
  const unkeyed = learningStoreOf(data, "agent-one");
  await assert.rejects(unkeyed.head(), (error) => error.name === "FolderUnreadable" && /AGENTRUN_CODE_STORAGE_KEY is not a private key/.test(error.message) && !error.message.includes("not-a-key"));
  useLearningStore(data, { refused: LEARNING_APART });
  const refused = learningStoreOf(data, "agent-one");
  for (const call of [() => refused.head(), () => refused.read("0".repeat(40)), () => refused.save({ old: null, message: "x", at: 1, writes: [] }), () => refused.remove()]) {
    await assert.rejects(call(), (error) => error.name === "FolderUnreadable" && error.link === false && error.message.includes(CODE_STORAGE_ENV.name) && error.message.includes(CODE_STORAGE_ENV.key));
  }
  useLearningStore(data, undefined);
  assert.notEqual(await learningStoreOf(data, "agent-one").head(), null, "the local folder, as it was");
});

test("a reset while code.storage can't be reached is 503 unavailable, retryable, the learning kept; the next call finishes it", async (t) => {
  const server = await serve(t, { runner: false });
  await made(server.api, learner("keeper"));
  // code.storage unreachable: every call fails as a refused connection does (no network is touched).
  useLearningStore(server.data, { name: "example-org", key: PEM, apiUrl: "https://api.example-org.code.storage.invalid", serverId: async () => "0123456789ab", fetch: async () => { throw new TypeError("fetch failed: connect ECONNREFUSED"); } });
  t.after(() => useLearningStore(server.data, undefined));
  const failed = await server.api("DELETE", "/agents/keeper/learning");
  assert.equal(failed.status, 503, JSON.stringify(failed.body));
  assert.equal(failed.body.error.code, "unavailable");
  assert.match(failed.body.error.message, /code\.storage can't be reached right now/);
  assert.equal(failed.body.error.retryable, true);
  assert.ok(failed.body.error.retry_after_ms > 0, JSON.stringify(failed.body.error));
  // Reached again (here, the local folder): the call sent again finishes it.
  useLearningStore(server.data, undefined);
  assert.equal((await server.api("DELETE", "/agents/keeper/learning")).status, 204);
});
