// The owner's Archil routes (archil-routes.ts), which turn Mode 2 on and off: GET /v2/workspace/archil (on or off, the
// settings, and each key saved or not, never a value), PUT (the settings row saved and the keys sealed into the store's
// archil.api_key and archil.disk_token rows; an image must be pinned by digest), DELETE (off), and POST .../test (one
// listing of the disk's root through its file API, with the key opened as a claim opens it). Driven at the handler as
// serve's dispatch calls it, over a real store on a temp file and the Archil fake; nothing leaves this machine.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { ARCHIL_ROUTES, archilRoute, createArchilRoutes } from "../dist/archil-routes.js";
import { inArchilMode, loadArchilSettings } from "../dist/archil-settings.js";
import { ApiError } from "../dist/errors.js";
import { getSealedKey } from "../dist/server-keys.js";
import { FakeArchilDisk, FakeDiskError } from "./fixtures/archil-fake.mjs";
import { storeOn } from "./store-helpers.mjs";

const PINNED = `ghcr.io/agentrun/exec@sha256:${"a".repeat(64)}`;
const SETTINGS = { diskId: "dsk-00000000000fake0", region: "aws-us-east-1", s3Url: "https://s3.archil.example" };
const API = "archil-account-secret-0001";
const TOKEN = "archil-disk-token-secret-0002";

async function setup(t, { disk = new FakeArchilDisk(), ...given } = {}) {
  const sealKey = "sealKey" in given ? given.sealKey : randomBytes(32);
  const { store } = await storeOn(t);
  const made = [];
  const routes = createArchilRoutes({ store, sealKey, makeDisk: (options) => { made.push(options); return disk; } });
  const call = (name, body) => archilRoute(routes, name, body === undefined ? {} : { body });
  return { store, sealKey, disk, made, call };
}
const refused = (promise, field) => assert.rejects(promise, (error) => error instanceof ApiError && error.code === "input_invalid" && (field === undefined || error.extra.fields?.some((one) => one.field === field)), field);

test("the four routes by their operation names", () => {
  assert.deepEqual([...ARCHIL_ROUTES], ["getWorkspaceArchil", "putWorkspaceArchil", "deleteWorkspaceArchil", "testWorkspaceArchil"]);
});

test("off at first; a PUT saves the settings and seals the keys, never echoed; GET shows them saved; DELETE turns Mode 2 off", async (t) => {
  const { store, sealKey, call } = await setup(t);
  assert.deepEqual(await call("getWorkspaceArchil"), { on: false, keys: [{ name: "ARCHIL_API_KEY", saved: false }, { name: "ARCHIL_DISK_TOKEN", saved: false }] });
  const saved = await call("putWorkspaceArchil", { ...SETTINGS, image: PINNED, keys: { ARCHIL_API_KEY: API, ARCHIL_DISK_TOKEN: TOKEN } });
  assert.deepEqual(saved, { on: true, ...SETTINGS, image: PINNED, keys: [{ name: "ARCHIL_API_KEY", saved: true }, { name: "ARCHIL_DISK_TOKEN", saved: true }] });
  assert.ok(!JSON.stringify(saved).includes(API) && !JSON.stringify(saved).includes(TOKEN), "never echoed");
  assert.deepEqual(await call("getWorkspaceArchil"), saved);
  assert.deepEqual(await loadArchilSettings(store), { ...SETTINGS, image: PINNED }, "the settings row E1's readers load");
  assert.equal(await inArchilMode(store), true, "Mode 2");
  assert.equal(await getSealedKey(store, sealKey, "archil.api_key"), API, "sealed into the claim's row");
  assert.equal(await getSealedKey(store, sealKey, "archil.disk_token"), TOKEN);
  assert.ok(!Buffer.from(await store.sealedKeys.get("archil.api_key")).toString("latin1").includes(API), "ciphertext only");
  const again = await call("putWorkspaceArchil", { ...SETTINGS, region: "aws-eu-west-1" });
  assert.deepEqual([again.region, again.image, again.keys.every((key) => key.saved)], ["aws-eu-west-1", undefined, true], "a PUT replaces the settings; keys not given are kept");
  await call("putWorkspaceArchil", { ...SETTINGS, keys: { ARCHIL_DISK_TOKEN: null } });
  assert.equal(await getSealedKey(store, sealKey, "archil.disk_token"), undefined, "null removes a key");
  assert.deepEqual(await call("deleteWorkspaceArchil"), { on: false, keys: [{ name: "ARCHIL_API_KEY", saved: true }, { name: "ARCHIL_DISK_TOKEN", saved: false }] });
  assert.equal(await inArchilMode(store), false, "Mode 1 again");
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

test("with no seal key, keys are refused in words, and settings with no key are kept", async (t) => {
  const { call } = await setup(t, { sealKey: undefined });
  await assert.rejects(call("putWorkspaceArchil", { ...SETTINGS, keys: { ARCHIL_API_KEY: API } }), (error) => error instanceof ApiError && error.code === "input_invalid" && /AGENTRUN_SEAL_KEY/.test(error.message));
  assert.equal((await call("putWorkspaceArchil", SETTINGS)).on, true);
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
