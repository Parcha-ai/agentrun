// The owner's Archil routes (archil-routes.ts), which turn Mode 2 on and off: GET /v2/workspace/archil (on or off, the
// settings, and whether the account key is saved, never a value), PUT (the settings row saved and the account key sealed
// into the store's archil.api_key row; an image must be pinned by digest; no server-wide disk), DELETE (off), and POST
// .../test (one listing of the account's disks at the region's control plane, with the key opened as a claim opens it).
// No disk token is kept: a computer's mount credential is minted per run from the account key. Driven at the handler as
// serve's dispatch calls it, over a real store on a temp file and the control-plane fake; nothing leaves this machine.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { ARCHIL_ROUTES, archilRoute, createArchilRoutes } from "../dist/archil-routes.js";
import { inArchilMode, loadArchilSettings } from "../dist/archil-settings.js";
import { ApiError } from "../dist/errors.js";
import { getSealedKey } from "../dist/server-keys.js";
import { archilControlFetch } from "./archil-control-fake.mjs";
import { storeOn, T0 } from "./store-helpers.mjs";

/** The account key as the one SecretMeta, "workspace:archil": not set, and set from the console at the store's clock. */
const UNSET = { name: "workspace:archil", set: false, source: null, changed_at: null };
const FROM_CONSOLE = { name: "workspace:archil", set: true, source: "console", changed_at: new Date(T0).toISOString() };
const PINNED = `ghcr.io/agentrun/exec@sha256:${"a".repeat(64)}`;
const SETTINGS = { region: "aws-us-east-1", s3Url: "https://s3.archil.example" };
const API = "archil-account-secret-0001";

async function setup(t, { answer, ...given } = {}) {
  const sealKey = randomBytes(32);
  const { store } = await storeOn(t);
  const control = archilControlFetch({ disks: [{ id: "dsk-0000000000000001" }, { id: "dsk-0000000000000002" }], ...(answer ? { answer } : {}) });
  const routes = createArchilRoutes({ store, sealKey, ...(given.env ? { env: given.env } : {}), control: { baseUrl: control.baseUrl, fetch: control.fetch } });
  const call = (name, body) => archilRoute(routes, name, body === undefined ? {} : { body });
  return { store, sealKey, control, call };
}

test("an ARCHIL_API_KEY environment variable overrides the saved key: source env, and the test lists the account's disks with it", async (t) => {
  const { control, call } = await setup(t, { env: { ARCHIL_API_KEY: "test-key" } });
  assert.deepEqual((await call("getWorkspaceArchil")).secret, { name: "workspace:archil", set: true, source: "env", changed_at: null });
  await call("putWorkspaceArchil", { ...SETTINGS, keys: { ARCHIL_API_KEY: API } });
  assert.equal((await call("getWorkspaceArchil")).secret.source, "env", "the environment still wins over a saved value");
  assert.equal((await call("testWorkspaceArchil")).ok, true);
  assert.deepEqual(control.requests.map((one) => one.authorization), ["Bearer test-key"], "the environment's value is the one used");
});
const refused = (promise, field) => assert.rejects(promise, (error) => error instanceof ApiError && error.code === "input_invalid" && (field === undefined || error.extra.fields?.some((one) => one.field === field)), field);

test("the routes by their operation names", () => {
  assert.deepEqual([...ARCHIL_ROUTES], ["getWorkspaceArchil", "putWorkspaceArchil", "deleteWorkspaceArchil", "testWorkspaceArchil", "getAgentArchil", "deleteAgentArchil"]);
});

test("off at first; a PUT saves the settings and seals the account key, never echoed; GET shows it saved; DELETE turns Mode 2 off", async (t) => {
  const { store, sealKey, call } = await setup(t);
  assert.deepEqual(await call("getWorkspaceArchil"), { on: false, secret: UNSET });
  const saved = await call("putWorkspaceArchil", { ...SETTINGS, image: PINNED, keys: { ARCHIL_API_KEY: API } });
  assert.deepEqual(saved, { on: true, ...SETTINGS, image: PINNED, secret: FROM_CONSOLE }, "the one SecretMeta: set, where from, when changed; never a value");
  assert.ok(!JSON.stringify(saved).includes(API), "never echoed");
  assert.deepEqual(await call("getWorkspaceArchil"), saved);
  assert.deepEqual(await loadArchilSettings(store), { ...SETTINGS, image: PINNED }, "the settings row E1's readers load");
  assert.equal(await inArchilMode(store), true, "Mode 2");
  assert.equal(await getSealedKey(store, sealKey, "archil.api_key"), API, "sealed into the claim's row");
  assert.deepEqual((await store.sealedKeys.all()).map((row) => row.name), ["archil.api_key"], "no disk token row");
  assert.ok(!Buffer.from(await store.sealedKeys.get("archil.api_key")).toString("latin1").includes(API), "ciphertext only");
  const again = await call("putWorkspaceArchil", { ...SETTINGS, region: "aws-eu-west-1" });
  assert.deepEqual([again.region, again.image, again.secret.set], ["aws-eu-west-1", undefined, true], "a PUT replaces the settings; a key not given is kept");
  assert.deepEqual(await call("deleteWorkspaceArchil"), { on: false, secret: FROM_CONSOLE });
  assert.equal(await inArchilMode(store), false, "Mode 1 again");
  await call("putWorkspaceArchil", { ...SETTINGS, keys: { ARCHIL_API_KEY: null } });
  assert.equal(await getSealedKey(store, sealKey, "archil.api_key"), undefined, "null removes the key");
});

test("no disk token is kept: a PUT naming ARCHIL_DISK_TOKEN is refused as a field Archil does not take", async (t) => {
  const { store, call } = await setup(t);
  await refused(call("putWorkspaceArchil", { ...SETTINGS, keys: { ARCHIL_API_KEY: API, ARCHIL_DISK_TOKEN: "archil-disk-token-0002" } }), "keys.ARCHIL_DISK_TOKEN");
  assert.deepEqual(await store.sealedKeys.all(), [], "nothing saved");
});

test("a PUT that is not right is refused before anything is saved, field by field; a server-wide disk is no setting", async (t) => {
  const { store, call } = await setup(t);
  await refused(call("putWorkspaceArchil", { ...SETTINGS, image: "ghcr.io/agentrun/exec:latest" }), "image");
  await assert.rejects(call("putWorkspaceArchil", { ...SETTINGS, diskId: "dsk-0000000000000001" }), (error) => error instanceof ApiError && error.extra.fields?.some((one) => one.field === "diskId" && /each agent has its own/.test(one.message)));
  await refused(call("putWorkspaceArchil", { s3Url: SETTINGS.s3Url }), "region");
  await refused(call("putWorkspaceArchil", { ...SETTINGS, s3Url: "s3.archil.example" }), "s3Url");
  await refused(call("putWorkspaceArchil", { ...SETTINGS, s3Url: "http://s3.archil.example" }), "s3Url");
  await refused(call("putWorkspaceArchil", { ...SETTINGS, keys: { OPENAI_API_KEY: "sk" } }), "keys.OPENAI_API_KEY");
  await refused(call("putWorkspaceArchil", { ...SETTINGS, keys: { ARCHIL_API_KEY: 7 } }), "keys.ARCHIL_API_KEY");
  await refused(call("putWorkspaceArchil", { ...SETTINGS, mode: 2 }), "mode");
  await refused(call("putWorkspaceArchil", []));
  assert.equal(await inArchilMode(store), false, "nothing saved");
  assert.deepEqual(await store.sealedKeys.all(), []);
});

test("the test lists the account's disks once with the sealed key, and says why it can't in plain words, never the key", async (t) => {
  let refuse;
  const { control, call } = await setup(t, { answer: () => refuse });
  assert.deepEqual(await call("testWorkspaceArchil"), { ok: false, why: "Archil is off on this server: save its region, S3 URL and account key (PUT /v2/workspace/archil)" });
  await call("putWorkspaceArchil", SETTINGS);
  const missing = await call("testWorkspaceArchil");
  assert.equal(missing.ok, false);
  assert.match(missing.why, /archil\.api_key/, "names the key to save");
  assert.equal(control.requests.length, 0, "nothing asked of Archil with no key");
  await call("putWorkspaceArchil", { ...SETTINGS, keys: { ARCHIL_API_KEY: API } });
  assert.deepEqual(await call("testWorkspaceArchil"), { ok: true, detail: "Archil's aws-us-east-1 control plane listed the account's disks (2 so far)" });
  assert.deepEqual(control.requests.map((one) => [one.method, one.path, one.authorization]), [["GET", "/api/disks", `Bearer ${API}`]], "one listing, nothing written");
  refuse = { status: 401, body: { success: false, error: `bad key ${API}` } };
  const denied = await call("testWorkspaceArchil");
  assert.equal(denied.ok, false);
  assert.match(denied.why, /^Archil refused the key: check ARCHIL_API_KEY/);
  assert.ok(!denied.why.includes(API), "never the key");
  refuse = { status: 500, body: { success: false, error: `upstream down ${API}` } };
  const down = await call("testWorkspaceArchil");
  assert.match(down.why, /^Archil could not be reached/);
  assert.ok(!down.why.includes(API));
});
