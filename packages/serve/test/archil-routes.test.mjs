// The owner's Archil routes (archil-routes.ts), which turn Mode 2 on and off: GET /v2/workspace/archil (on or off, the
// settings, and whether the account key is saved, never a value), PUT (the settings row saved and the account key sealed
// into the store's archil.api_key row; an image must be pinned by digest), DELETE (off), and POST .../test (one listing
// of the disk's root through its file API, with the key opened as a claim opens it). No disk token is kept: a computer's
// mount credential is minted per run from the account key. Driven at the handler as serve's dispatch calls it, over a
// real store on a temp file and the Archil fake; nothing leaves this machine.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { ARCHIL_ROUTES, archilRoute, createArchilRoutes } from "../dist/archil-routes.js";
import { inArchilMode, loadArchilSettings } from "../dist/archil-settings.js";
import { ApiError } from "../dist/errors.js";
import { getSealedKey } from "../dist/server-keys.js";
import { FakeArchilDisk, FakeDiskError } from "./fixtures/archil-fake.mjs";
import { storeOn, T0 } from "./store-helpers.mjs";

/** The environment's Archil key in the override case: a dummy built at run time, so no line reads as a credential. */
const ARCHIL_ENV_KEY = `not-a-secret-${"archil-env"}`;

/** The shared secret shape for the account key: not set, and set from the console at the store's clock. */
const UNSET = { name: "ARCHIL_API_KEY", set: false, source: null, changed_at: null };
const FROM_CONSOLE = { name: "ARCHIL_API_KEY", set: true, source: "console", changed_at: new Date(T0).toISOString() };
const PINNED = `ghcr.io/agentrun/exec@sha256:${"a".repeat(64)}`;
const SETTINGS = { diskId: "dsk-00000000000fake0", region: "aws-us-east-1", s3Url: "https://s3.archil.example" };
const API = "archil-account-secret-0001";

async function setup(t, { disk = new FakeArchilDisk(), ...given } = {}) {
  const sealKey = randomBytes(32);
  const { store } = await storeOn(t);
  const made = [];
  const routes = createArchilRoutes({ store, sealKey, ...(given.env ? { env: given.env } : {}), makeDisk: (options) => { made.push(options); return disk; } });
  const call = (name, body) => archilRoute(routes, name, body === undefined ? {} : { body });
  return { store, sealKey, disk, made, call };
}

test("an ARCHIL_API_KEY environment variable overrides the saved key: source env, and the test lists the disk with it", async (t) => {
  const disk = new FakeArchilDisk();
  const { made, call } = await setup(t, { disk, env: { ARCHIL_API_KEY: ARCHIL_ENV_KEY } });
  assert.deepEqual((await call("getWorkspaceArchil")).keys, [{ name: "ARCHIL_API_KEY", set: true, source: "env", changed_at: null }]);
  await call("putWorkspaceArchil", { ...SETTINGS, keys: { ARCHIL_API_KEY: API } });
  assert.equal((await call("getWorkspaceArchil")).keys[0].source, "env", "the environment still wins over a saved value");
  const keys = [];
  const list = disk.listPage.bind(disk);
  disk.listPage = async (...args) => { keys.push(made.at(-1).key()); return list(...args); };
  assert.equal((await call("testWorkspaceArchil")).ok, true);
  assert.deepEqual(keys, [ARCHIL_ENV_KEY], "the environment's value is the one used");
});
const refused = (promise, field) => assert.rejects(promise, (error) => error instanceof ApiError && error.code === "input_invalid" && (field === undefined || error.extra.fields?.some((one) => one.field === field)), field);

test("the four routes by their operation names", () => {
  assert.deepEqual([...ARCHIL_ROUTES], ["getWorkspaceArchil", "putWorkspaceArchil", "deleteWorkspaceArchil", "testWorkspaceArchil"]);
});

test("off at first; a PUT saves the settings and seals the account key, never echoed; GET shows it saved; DELETE turns Mode 2 off", async (t) => {
  const { store, sealKey, call } = await setup(t);
  assert.deepEqual(await call("getWorkspaceArchil"), { on: false, keys: [UNSET] });
  const saved = await call("putWorkspaceArchil", { ...SETTINGS, image: PINNED, keys: { ARCHIL_API_KEY: API } });
  assert.deepEqual(saved, { on: true, ...SETTINGS, image: PINNED, keys: [FROM_CONSOLE] }, "the shared secret shape: set, where from, when changed; never a value");
  assert.ok(!JSON.stringify(saved).includes(API), "never echoed");
  assert.deepEqual(await call("getWorkspaceArchil"), saved);
  assert.deepEqual(await loadArchilSettings(store), { ...SETTINGS, image: PINNED }, "the settings row E1's readers load");
  assert.equal(await inArchilMode(store), true, "Mode 2");
  assert.equal(await getSealedKey(store, sealKey, "archil.api_key"), API, "sealed into the claim's row");
  assert.deepEqual((await store.sealedKeys.all()).map((row) => row.name), ["archil.api_key"], "no disk token row");
  assert.ok(!Buffer.from(await store.sealedKeys.get("archil.api_key")).toString("latin1").includes(API), "ciphertext only");
  const again = await call("putWorkspaceArchil", { ...SETTINGS, region: "aws-eu-west-1" });
  assert.deepEqual([again.region, again.image, again.keys.every((key) => key.set)], ["aws-eu-west-1", undefined, true], "a PUT replaces the settings; a key not given is kept");
  assert.deepEqual(await call("deleteWorkspaceArchil"), { on: false, keys: [FROM_CONSOLE] });
  assert.equal(await inArchilMode(store), false, "Mode 1 again");
  await call("putWorkspaceArchil", { ...SETTINGS, keys: { ARCHIL_API_KEY: null } });
  assert.equal(await getSealedKey(store, sealKey, "archil.api_key"), undefined, "null removes the key");
});

test("no disk token is kept: a PUT naming ARCHIL_DISK_TOKEN is refused as a field Archil does not take", async (t) => {
  const { store, call } = await setup(t);
  await refused(call("putWorkspaceArchil", { ...SETTINGS, keys: { ARCHIL_API_KEY: API, ARCHIL_DISK_TOKEN: "archil-disk-token-0002" } }), "keys.ARCHIL_DISK_TOKEN");
  assert.deepEqual(await store.sealedKeys.all(), [], "nothing saved");
});

test("a PUT that is not right is refused before anything is saved, field by field", async (t) => {
  const { store, call } = await setup(t);
  await refused(call("putWorkspaceArchil", { ...SETTINGS, image: "ghcr.io/agentrun/exec:latest" }), "image");
  await refused(call("putWorkspaceArchil", { ...SETTINGS, diskId: "" }), "diskId");
  await refused(call("putWorkspaceArchil", { region: "r", s3Url: SETTINGS.s3Url }), "diskId");
  await refused(call("putWorkspaceArchil", { ...SETTINGS, s3Url: "s3.archil.example" }), "s3Url");
  await refused(call("putWorkspaceArchil", { ...SETTINGS, s3Url: "http://s3.archil.example" }), "s3Url");
  await refused(call("putWorkspaceArchil", { ...SETTINGS, keys: { OPENAI_API_KEY: "sk" } }), "keys.OPENAI_API_KEY");
  await refused(call("putWorkspaceArchil", { ...SETTINGS, keys: { ARCHIL_API_KEY: 7 } }), "keys.ARCHIL_API_KEY");
  await refused(call("putWorkspaceArchil", { ...SETTINGS, mode: 2 }), "mode");
  await refused(call("putWorkspaceArchil", []));
  assert.equal(await inArchilMode(store), false, "nothing saved");
  assert.deepEqual(await store.sealedKeys.all(), []);
});

test("the test lists the disk's root once with the sealed key, and says why it can't in plain words, never the key", async (t) => {
  const disk = new FakeArchilDisk();
  const { made, call } = await setup(t, { disk });
  assert.deepEqual(await call("testWorkspaceArchil"), { ok: false, why: "Archil is off on this server: save its disk, region and S3 URL (PUT /v2/workspace/archil)" });
  await call("putWorkspaceArchil", SETTINGS);
  const missing = await call("testWorkspaceArchil");
  assert.equal(missing.ok, false);
  assert.match(missing.why, /archil\.api_key/, "names the key to save");
  await call("putWorkspaceArchil", { ...SETTINGS, keys: { ARCHIL_API_KEY: API } });
  const before = disk.calls.length;
  const keys = [];
  const list = disk.listPage.bind(disk);
  disk.listPage = async (...args) => { keys.push(made.at(-1).key()); return list(...args); };
  assert.deepEqual(await call("testWorkspaceArchil"), { ok: true, detail: "the disk dsk-00000000000fake0 answered its root listing" });
  assert.deepEqual(disk.calls.slice(before).map((one) => one.op), ["listPage"], "one listing, nothing written");
  assert.deepEqual(keys, [API], "the key the claim opens");
  assert.throws(() => made.at(-1).key(), /released/, "and dropped once the test is done");
  disk.listPage = async () => { throw new FakeDiskError(403, "AccessDenied", `bad key ${API}`); };
  const denied = await call("testWorkspaceArchil");
  assert.equal(denied.ok, false);
  assert.match(denied.why, /^Archil refused the key: check ARCHIL_API_KEY/);
  assert.ok(!denied.why.includes(API), "never the key");
  disk.listPage = async () => { throw new Error(`getaddrinfo ENOTFOUND s3.archil.example ${API}`); };
  const down = await call("testWorkspaceArchil");
  assert.match(down.why, /^Archil could not be reached/);
  assert.ok(!down.why.includes(API));
});
