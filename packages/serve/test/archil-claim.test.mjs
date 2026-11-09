// The Archil claim step (workspace/archil-claim.ts): a claim's Archil key comes from the store's sealed_keys row, opened
// with the runner's seal key into the claim's memory only, never from the environment, and dropped at release. The disk
// token a mount takes is no saved row: it is minted per run at Archil's control API (a loopback fake here) when a mount
// first asks, and revoked by its identifier.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { sealColumn, sealedAt } from "../dist/store/seal.js";
import * as archilSettings from "../dist/archil-settings.js";
import { ARCHIL_API_KEY_ROW, ArchilClaimRefused, archilClaim } from "../dist/workspace/index.js";

const { ARCHIL_API_KEY_ROW: SETTINGS_API_ROW, loadArchilSettings, saveArchilSettings } = archilSettings;
import { archilControlFake } from "./archil-control-fake.mjs";
import { storeOn } from "./store-helpers.mjs";

const KEY = randomBytes(32);
const API = "fake-test-key-api-0001";
/** The token the fake control API mints first. */
const TOKEN = "fake-minted-token-1";

/** A loopback fake of Archil's control API, closed with the test: the claim's mount option points at it. */
async function controlOn(t, options) {
  const fake = await archilControlFake(options);
  t.after(() => fake.close());
  return { fake, mount: { runId: "run-1", epoch: 3, ttlMs: 86_400_000, baseUrl: fake.baseUrl } };
}
/** The Archil settings as the store keeps them (archil-settings.ts). */
const SETTINGS = { diskId: "dsk-0000000000000001", region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" };
const PINNED = `docker.io/library/debian@sha256:${"9e".repeat(32)}`;

/** The sealed_keys rows as the store holds them: each sealed under `key` for its own row. */
const rowsOf = (key = KEY, values = { [ARCHIL_API_KEY_ROW]: API }) =>
  new Map(Object.entries(values).map(([name, value]) => [name, sealColumn(key, sealedAt.sealedKey(name), value)]));

/** A claim over `rows`, with the disk it makes captured instead of made (no call leaves the process). */
async function claimOf({ rows = rowsOf(), settings = SETTINGS, sealKey = KEY, signal = new AbortController().signal, mount, env } = {}) {
  const asked = [];
  const made = [];
  const claim = await archilClaim({
    settings,
    keys: { get: async (name) => { asked.push(name); return rows.get(name); } },
    sealKey,
    signal,
    makeDisk: (options) => { made.push(options); return { id: options.disk, made: true }; },
    ...(mount ? { mount } : {}),
    ...(env ? { env } : {}),
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
  assert.deepEqual(asked, [ARCHIL_API_KEY_ROW], "only the account key: no disk token row is read");
});

test("archil claim: the key rows are the store's one set of names, and a saved image is pinned by digest or refused", async () => {
  assert.equal(ARCHIL_API_KEY_ROW, SETTINGS_API_ROW);
  assert.equal(ARCHIL_API_KEY_ROW, "archil.api_key");
  assert.equal(archilSettings.ARCHIL_DISK_TOKEN_ROW, undefined, "no disk token row: the mount credential is minted per run");
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

test("archil claim: the mount credential is minted when a mount first asks, once, held in the redaction set, and revoked by its identifier", async (t) => {
  const { fake, mount } = await controlOn(t);
  const { claim, asked } = await claimOf({ mount });
  assert.equal(fake.requests.length, 0, "nothing minted before a mount asks");
  assert.equal(await claim.token(), TOKEN);
  assert.equal(await claim.token(), TOKEN);
  assert.deepEqual(fake.requests.map((one) => [one.method, one.body?.nickname, one.body?.ttl]), [["GET", undefined, undefined], ["POST", "agentrun:run-1:3", "86400s"]], "the disk's users read, then minted once, named for the run and its epoch, with its lifetime bound");
  assert.deepEqual(asked, [ARCHIL_API_KEY_ROW], "no disk token row is read");
  assert.deepEqual([...claim.secrets].sort(), [API, TOKEN].sort());
  await claim.revoke();
  await claim.revoke();
  assert.deepEqual(fake.requests.slice(2).map((one) => [one.method, one.query.identifier]), [["DELETE", "tok-1"], ["GET", undefined]], "removed once by its identifier, then the run's earlier epochs looked for; a second revoke has nothing to remove");
  assert.equal(fake.users.size, 0);
  assert.ok(!claim.secrets.has(TOKEN), "the token is no longer held");
});

test("archil claim: an ARCHIL_API_KEY in the server's environment is the account key, for the disk and the mint alike; no row is read", async (t) => {
  const { fake, mount } = await controlOn(t);
  const ENV_KEY = "fake-test-key-archil-from-env-0001";
  const { claim, asked, made } = await claimOf({ mount, rows: new Map(), env: { ARCHIL_API_KEY: ENV_KEY } });
  assert.equal(await made[0].key(), ENV_KEY, "the disk's key");
  await claim.token();
  assert.deepEqual(fake.requests.map((one) => one.authorization), [`Bearer ${ENV_KEY}`, `Bearer ${ENV_KEY}`], "the same key lists and mints");
  assert.deepEqual(asked, [], "no saved row is read");
  // An empty variable is no key: the saved one is read.
  const saved = await claimOf({ mount, env: { ARCHIL_API_KEY: "  " } });
  assert.equal(await saved.made[0].key(), API);
});

test("archil claim: a revoke with nothing minted removes nothing", async (t) => {
  const { fake, mount } = await controlOn(t);
  const { claim } = await claimOf({ mount });
  await claim.revoke();
  assert.deepEqual(fake.requests, []);
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
  const moved = new Map([[ARCHIL_API_KEY_ROW, sealColumn(KEY, sealedAt.sealedKey("archil.other"), API)]]);
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
  const claim = await archilClaim({ settings: SETTINGS, keys: store.sealedKeys, sealKey: KEY, signal: new AbortController().signal, makeDisk: (options) => { made.push(options); return { id: options.disk }; } });
  assert.equal(await made[0].key(), API);
  assert.equal(claim.disk.id, SETTINGS.diskId);
  await store.sealedKeys.remove(ARCHIL_API_KEY_ROW);
  await assert.rejects(
    archilClaim({ settings: SETTINGS, keys: store.sealedKeys, sealKey: KEY, signal: new AbortController().signal, makeDisk: () => assert.fail("no disk") }),
    (error) => error instanceof ArchilClaimRefused && /no archil\.api_key key is saved/.test(error.message),
  );
});

test("archil claim: a failed mint refuses the mount that asks for it in words, not the claim, and holds nothing", async (t) => {
  const { fake, mount } = await controlOn(t, { answer: ({ method }) => (method === "POST" ? { status: 403, body: { error: "the account may not add users to this disk", code: "forbidden" } } : undefined) });
  const { claim } = await claimOf({ mount });
  await assert.rejects(claim.token(), (error) => error instanceof ArchilClaimRefused && /This run's folder can't be mounted in its computer: Archil refused to mint the run's mount credential \(403\): the account may not add users to this disk/.test(error.message) && !error.message.includes(API));
  assert.deepEqual(fake.requests.map((one) => one.method), ["GET", "POST"]);
  assert.deepEqual([...claim.secrets], [API], "no token held");
});

test("archil claim: a reclaim removes the run's token users of an earlier epoch before it mints; another run's and others are left", async (t) => {
  const existing = [
    { identifier: "tok-old", nickname: "agentrun:run-1:2" },
    { identifier: "tok-older", nickname: "agentrun:run-1:1" },
    { identifier: "tok-other-run", nickname: "agentrun:run-2:1" },
    { identifier: "tok-person", nickname: "a person's own mount" },
  ];
  const { fake, mount } = await controlOn(t, { existing });
  const { claim } = await claimOf({ mount });
  assert.equal(await claim.token(), TOKEN);
  assert.deepEqual(fake.requests.map((one) => [one.method, one.query.identifier ?? one.body?.nickname]), [
    ["GET", undefined],
    ["DELETE", "tok-old"],
    ["DELETE", "tok-older"],
    ["POST", "agentrun:run-1:3"],
  ], "the earlier claims' removed first, then this claim's minted");
  assert.deepEqual([...fake.users.keys()].sort(), ["tok-1", "tok-other-run", "tok-person"]);
});

test("archil claim: a reclaim whose list lags the earlier epoch's mint misses its user; the newer claim's revoke removes it with its own", async (t) => {
  // Archil's list, read right after a mint, may not hold that user yet (the live reclaim of mint-3; mint-4 saw it lag).
  const { fake, mount } = await controlOn(t, { lagging: true });
  const first = await claimOf({ mount: { ...mount, epoch: 1 } });
  await first.claim.token();
  // A crashed runner: epoch 1's claim is neither revoked nor released. Epoch 2's list is the first read after its mint.
  const second = await claimOf({ mount: { ...mount, epoch: 2 } });
  await second.claim.token();
  assert.deepEqual([...fake.users.values()].map((one) => one.nickname).sort(), ["agentrun:run-1:1", "agentrun:run-1:2"], "the reclaim's list missed epoch 1's user, as live");
  // By the run's end the list holds it: the newer claim's revoke removes its own, then the run's earlier epochs.
  await second.claim.revoke();
  assert.deepEqual([...fake.users.keys()], [], "epoch 2's user and epoch 1's are both gone");
  assert.deepEqual(fake.requests.filter((one) => one.method === "DELETE").map((one) => one.query.identifier), ["tok-2", "tok-1"]);
});

test("archil claim: a lost claim removes the run's mount credential at once, not at its ttl", async (t) => {
  const { fake, mount } = await controlOn(t);
  const controller = new AbortController();
  const { claim } = await claimOf({ signal: controller.signal, mount });
  await claim.token();
  assert.equal(fake.users.size, 1);
  controller.abort(new Error("the claim was fenced"));
  // The remove, and the list read after it, are requests on their way: wait for both to land (bounded), not for a time.
  const settled = () => fake.users.size === 0 && fake.requests.at(-1)?.method === "GET";
  for (let tries = 0; !settled() && tries < 2000; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(fake.users.size, 0, "removed when the claim was lost");
  assert.deepEqual(fake.requests.slice(-2).map((one) => one.method), ["DELETE", "GET"], "its own removed, then the run's earlier epochs looked for");
  assert.equal(claim.secrets.size, 0);
});

test("archil claim: a claim made with no mount credential to mint refuses a mount in words", async () => {
  const { claim } = await claimOf();
  await assert.rejects(claim.token(), (error) => error instanceof ArchilClaimRefused && /without a mount credential to mint/.test(error.message));
});

test("archil claim: release(), or the claim's signal aborting, drops both values: the disk's key and the token are refused after", async (t) => {
  for (const end of ["release", "abort"]) {
    const controller = new AbortController();
    const { mount } = await controlOn(t);
    const { claim, made } = await claimOf({ signal: controller.signal, mount });
    await claim.token();
    if (end === "release") claim.release();
    else controller.abort();
    await assert.rejects(Promise.resolve().then(() => made[0].key()), /released/, `${end}: the key`);
    await assert.rejects(claim.token(), /released/, `${end}: the token`);
    assert.equal(claim.secrets.size, 0, `${end}: nothing held`);
  }
});

test("archil claim: no Archil or agentrun setting is read from the environment", async (t) => {
  const { mount } = await controlOn(t);
  const realEnv = process.env;
  const readNames = [];
  process.env = new Proxy(realEnv, { get: (target, name) => { if (typeof name === "string") readNames.push(name); return Reflect.get(target, name); } });
  try {
    const { claim, made } = await claimOf({ mount });
    await made[0].key();
    await claim.token();
    claim.release();
  } finally {
    process.env = realEnv;
  }
  assert.deepEqual(readNames.filter((name) => /ARCHIL|AGENTRUN/i.test(name)), []);
});
