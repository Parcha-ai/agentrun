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

const { CODE_STORAGE_ENV, CodeStorageEnvInvalid, codeStorageFromEnv, LEARNING_APART, learningStoreOf, useLearningStore } = await import("../dist/learn/store-of.js");
const { learningInit } = await import("../dist/learn/folder.js");
const { runFacing } = await import("../dist/runner/runner-check.js");
const { RUN_SECRETS } = await import("../dist/run-secrets.js");
const { SECRET_NAMES } = await import("../dist/secrets.js");

const PEM = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" });
/** The settings an environment gives, its key read by name from `keys`. */
const fromEnv = (env, keys = {}) => codeStorageFromEnv(env, (name) => keys[name]);

test("no code.storage setting is the local folder; both set is code.storage, its key read by name and never from the environment's values", () => {
  assert.equal(fromEnv({}), undefined);
  assert.deepEqual(fromEnv({ [CODE_STORAGE_ENV.name]: "example-org" }, { [CODE_STORAGE_ENV.key]: PEM }), { name: "example-org", key: PEM.trim() });
  assert.deepEqual(fromEnv({ [CODE_STORAGE_ENV.name]: "example-org", [CODE_STORAGE_ENV.apiUrl]: "https://api.example-org.code.storage.invalid" }, { [CODE_STORAGE_ENV.key]: PEM }), { name: "example-org", key: PEM.trim(), apiUrl: "https://api.example-org.code.storage.invalid" });
  assert.throws(() => fromEnv({ [CODE_STORAGE_ENV.name]: "example-org", [CODE_STORAGE_ENV.key]: PEM }), CodeStorageEnvInvalid, "a key in the environment's values but not read by name is no key");
});

test("code.storage set wrong stops the start, naming the variable, and never says the key", () => {
  const refused = (env, keys, words) => assert.throws(() => fromEnv(env, keys), (error) => error instanceof CodeStorageEnvInvalid && words.test(error.message) && !error.message.includes("PRIVATE KEY-----\n"));
  refused({ [CODE_STORAGE_ENV.name]: "example-org" }, {}, /AGENTRUN_CODE_STORAGE_NAME is set without AGENTRUN_CODE_STORAGE_KEY/);
  refused({}, { [CODE_STORAGE_ENV.key]: PEM }, /AGENTRUN_CODE_STORAGE_KEY is set without AGENTRUN_CODE_STORAGE_NAME/);
  refused({ [CODE_STORAGE_ENV.apiUrl]: "https://api.example-org.code.storage.invalid" }, {}, /AGENTRUN_CODE_STORAGE_API_URL is set without/);
  refused({ [CODE_STORAGE_ENV.name]: "Example Org" }, { [CODE_STORAGE_ENV.key]: PEM }, /AGENTRUN_CODE_STORAGE_NAME is a code\.storage org name/);
  refused({ [CODE_STORAGE_ENV.name]: "example-org" }, { [CODE_STORAGE_ENV.key]: "not a key" }, /AGENTRUN_CODE_STORAGE_KEY is not a private key in PEM form/);
  refused({ [CODE_STORAGE_ENV.name]: "example-org", [CODE_STORAGE_ENV.apiUrl]: "http://api.example-org.code.storage.invalid" }, { [CODE_STORAGE_ENV.key]: PEM }, /AGENTRUN_CODE_STORAGE_API_URL is an https URL/);
});

test("a runner reads code.storage's settings from its environment (each name is run-facing); its key is a secret, held by name, and never handed to a run", () => {
  for (const name of Object.values(CODE_STORAGE_ENV)) assert.equal(runFacing(name), true, name);
  assert.ok(SECRET_NAMES.includes(CODE_STORAGE_ENV.key), "the launcher holds the key as a secret");
  assert.ok(!RUN_SECRETS.includes(CODE_STORAGE_ENV.key), "a run's tools are never handed it");
});

test("a data directory's store: the local folder by default, code.storage when set, refused (failing closed in words naming the settings) for a runner apart from its server's disk, the local folder again when unset", async (t) => {
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-store-of-"));
  t.after(() => (useLearningStore(data, undefined), rmSync(data, { recursive: true, force: true })));
  assert.match(learningStoreOf(data, "agent-one").id, /^local:/);
  await learningInit(learningStoreOf(data, "agent-one"));
  useLearningStore(data, { name: "example-org", key: PEM, apiUrl: "https://api.example-org.code.storage.invalid", serverId: async () => "srv1", fetch: async () => { throw new Error("not reached"); } });
  assert.equal(learningStoreOf(data, "agent-one").id, "code.storage:example-org:agent-one");
  // A key that reads as a PEM but is no key: making the store never throws (every run makes one), each call fails closed.
  useLearningStore(data, { name: "example-org", key: "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n", serverId: async () => "srv1", fetch: async () => { throw new Error("not reached"); } });
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
  useLearningStore(server.data, { name: "example-org", key: PEM, apiUrl: "https://api.example-org.code.storage.invalid", serverId: async () => "srv1", fetch: async () => { throw new TypeError("fetch failed: connect ECONNREFUSED"); } });
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
