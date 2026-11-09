// The Archil claim step (workspace/archil-claim.ts): a claim's Archil account key comes from the store's sealed_keys row,
// opened with the runner's seal key into the claim's memory only, never from the environment, and dropped at release. No
// disk token is kept or opened: a computer's mount credential is minted per run from the account key.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { sealColumn, sealedAt } from "../dist/store/seal.js";
import * as archilSettings from "../dist/archil-settings.js";
import * as workspaceIndex from "../dist/workspace/index.js";
import { storeOn } from "./store-helpers.mjs";

const { ARCHIL_API_KEY_ROW: SETTINGS_API_ROW, loadArchilSettings, saveArchilSettings } = archilSettings;
const { ARCHIL_API_KEY_ROW, ArchilClaimRefused, archilClaim } = workspaceIndex;
const KEY = randomBytes(32);
const API = "fake-test-key-api-0001";
/** The Archil settings as the store keeps them (archil-settings.ts). */
const SETTINGS = { diskId: "dsk-0000000000000001", region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" };
const PINNED = `docker.io/library/debian@sha256:${"9e".repeat(32)}`;

/** The sealed_keys rows as the store holds them: each sealed under `key` for its own row. */
const rowsOf = (key = KEY, values = { [ARCHIL_API_KEY_ROW]: API }) =>
  new Map(Object.entries(values).map(([name, value]) => [name, sealColumn(key, sealedAt.sealedKey(name), value)]));

/** A claim over `rows`, with the disk it makes captured instead of made (no call leaves the process). */
async function claimOf({ rows = rowsOf(), settings = SETTINGS, sealKey = KEY, signal = new AbortController().signal } = {}) {
  const asked = [];
  const made = [];
  const claim = await archilClaim({
    settings,
    keys: { get: async (name) => { asked.push(name); return rows.get(name); } },
    sealKey,
    signal,
    makeDisk: (options) => { made.push(options); return { id: options.disk, made: true }; },
  });
  return { claim, asked, made };
}

test("archil claim: the disk is made from the settings, and its key is the sealed api key row, opened with the seal key", async () => {
  const { claim, asked, made } = await claimOf();
  assert.equal(made.length, 1);
  assert.deepEqual([made[0].disk, made[0].region, made[0].s3BaseUrl], [SETTINGS.diskId, SETTINGS.region, SETTINGS.s3Url]);
  assert.equal(typeof made[0].key, "function", "the key is a function the seam asks on every call");
  assert.equal(await made[0].key(), API);
  assert.equal(claim.disk.id, SETTINGS.diskId);
  assert.deepEqual([claim.region, claim.image], [SETTINGS.region, undefined], "no image: Archil's default");
  assert.deepEqual(asked, [ARCHIL_API_KEY_ROW], "the account key's row alone");
  assert.deepEqual([...claim.secrets], [API], "the one value held, in the redaction set");
});

test("archil claim: no disk token is kept: no row, no export, no token on the claim", async () => {
  assert.equal("ARCHIL_DISK_TOKEN_ROW" in archilSettings, false);
  assert.equal("ARCHIL_DISK_TOKEN_ROW" in workspaceIndex, false);
  const { claim } = await claimOf();
  assert.equal("token" in claim, false);
});

test("archil claim: the key row is the store's one name, and a saved image is pinned by digest or refused", async () => {
  assert.deepEqual([ARCHIL_API_KEY_ROW, SETTINGS_API_ROW], ["archil.api_key", "archil.api_key"]);
  const { claim } = await claimOf({ settings: { ...SETTINGS, image: PINNED } });
  assert.deepEqual(claim.image, { baseImage: PINNED });
  for (const image of ["debian:trixie", "debian@sha256:short", ""]) {
    await assert.rejects(claimOf({ settings: { ...SETTINGS, image } }), (error) => error instanceof ArchilClaimRefused && /pinned by digest/.test(error.message), image);
  }
});

test("archil claim: over the settings row the server saved (archil-settings.ts)", async (t) => {
  const { store } = await storeOn(t);
  await saveArchilSettings(store, { ...SETTINGS, image: PINNED });
  const { claim, made } = await claimOf({ settings: await loadArchilSettings(store) });
  assert.deepEqual([made[0].disk, made[0].region, made[0].s3BaseUrl, claim.image], [SETTINGS.diskId, SETTINGS.region, SETTINGS.s3Url, { baseImage: PINNED }]);
});

test("archil claim: a claim that cannot open its key is refused in words, before any disk is made", async () => {
  const refused = async (options, words) => {
    const made = [];
    await assert.rejects(
      archilClaim({ settings: SETTINGS, keys: { get: async (name) => options.rows?.get(name) }, sealKey: KEY, signal: new AbortController().signal, ...options, makeDisk: (o) => { made.push(o); return { id: o.disk }; } }),
      (error) => error instanceof ArchilClaimRefused && words.test(error.message) && !error.message.includes(API),
    );
    assert.deepEqual(made, [], "no disk was made");
  };
  await refused({ settings: undefined, rows: rowsOf() }, /Archil disk is not set up/);
  await refused({ sealKey: undefined, rows: rowsOf(), keys: { get: async () => assert.fail("no row is read without a seal key") } }, /seal key/);
  await refused({ rows: new Map() }, new RegExp(`no ${ARCHIL_API_KEY_ROW.replace(".", "\\.")} key is saved`));
  await refused({ rows: rowsOf(randomBytes(32)) }, /does not open/);
  // A value sealed for another row does not open as this one.
  const moved = new Map([[ARCHIL_API_KEY_ROW, sealColumn(KEY, sealedAt.sealedKey("E2B_API_KEY"), API)]]);
  await refused({ rows: moved }, /does not open/);
  // The real disk checks its S3 endpoint when it is made (no call is sent): a bad one refuses the claim.
  await assert.rejects(
    archilClaim({ settings: { ...SETTINGS, s3Url: "http://s3.example.com" }, keys: { get: async (name) => rowsOf().get(name) }, sealKey: KEY, signal: new AbortController().signal }),
    (error) => error instanceof ArchilClaimRefused && /S3 endpoint/.test(error.message) && !error.message.includes(API),
  );
});

test("archil claim: over the store's own sealed_keys rows, as the server saved them", async (t) => {
  const { store } = await storeOn(t);
  for (const [name, sealed] of rowsOf()) await store.sealedKeys.put(name, sealed);
  const made = [];
  await archilClaim({ settings: SETTINGS, keys: store.sealedKeys, sealKey: KEY, signal: new AbortController().signal, makeDisk: (options) => { made.push(options); return { id: options.disk }; } });
  assert.equal(await made[0].key(), API);
  await store.sealedKeys.remove(ARCHIL_API_KEY_ROW);
  await assert.rejects(
    archilClaim({ settings: SETTINGS, keys: store.sealedKeys, sealKey: KEY, signal: new AbortController().signal, makeDisk: () => assert.fail("no disk") }),
    (error) => error instanceof ArchilClaimRefused && /no archil\.api_key key is saved/.test(error.message),
  );
});

test("archil claim: release(), or the claim's signal aborting, drops the key: the disk's key is refused after", async () => {
  for (const end of ["release", "abort"]) {
    const controller = new AbortController();
    const { claim, made } = await claimOf({ signal: controller.signal });
    if (end === "release") claim.release();
    else controller.abort();
    await assert.rejects(Promise.resolve().then(() => made[0].key()), /released/, `${end}: the key`);
    assert.equal(claim.secrets.size, 0, `${end}: nothing held`);
  }
});

test("archil claim: no Archil or agentrun setting is read from the environment", async () => {
  const realEnv = process.env;
  const readNames = [];
  process.env = new Proxy(realEnv, { get: (target, name) => { if (typeof name === "string") readNames.push(name); return Reflect.get(target, name); } });
  try {
    const { claim, made } = await claimOf();
    await made[0].key();
    claim.release();
  } finally {
    process.env = realEnv;
  }
  assert.deepEqual(readNames.filter((name) => /ARCHIL|AGENTRUN/i.test(name)), []);
});
