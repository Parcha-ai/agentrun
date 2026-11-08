// The Archil claim step (workspace/archil-claim.ts): a claim's Archil keys come from the store's sealed_keys rows, opened
// with the runner's seal key into the claim's memory only, never from the environment, and dropped at release.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { sealColumn, sealedAt } from "../dist/store/seal.js";
import { ARCHIL_API_KEY_ROW, ARCHIL_DISK_TOKEN_ROW, ArchilClaimRefused, archilClaim } from "../dist/workspace/index.js";

const KEY = randomBytes(32);
const API = "fake-test-key-api-0001";
const TOKEN = "fake-test-key-disk-token-0001";
const SETTINGS = { disk: "dsk-0000000000000001", region: "aws-us-east-1", s3BaseUrl: "https://s3.green.us-east-1.aws.prod.archil.com" };

/** The sealed_keys rows as the store holds them: each sealed under `key` for its own row. */
const rowsOf = (key = KEY, values = { [ARCHIL_API_KEY_ROW]: API, [ARCHIL_DISK_TOKEN_ROW]: TOKEN }) =>
  new Map(Object.entries(values).map(([name, value]) => [name, sealColumn(key, sealedAt.sealedKey(name), value)]));

/** A claim over `rows`, with the disk it makes captured instead of made (no call leaves the process). */
async function claimOf({ rows = rowsOf(), settings = SETTINGS, sealKey = KEY, signal = new AbortController().signal } = {}) {
  const asked = [];
  const made = [];
  const claim = await archilClaim({
    settings,
    sealedKey: async (name) => { asked.push(name); return rows.get(name); },
    sealKey,
    signal,
    makeDisk: (options) => { made.push(options); return { id: options.disk, made: true }; },
  });
  return { claim, asked, made };
}

test("archil claim: the disk is made from the settings, and its key is the sealed api key row, opened with the seal key", async () => {
  const { claim, asked, made } = await claimOf();
  assert.equal(made.length, 1);
  assert.deepEqual([made[0].disk, made[0].region, made[0].s3BaseUrl], [SETTINGS.disk, SETTINGS.region, SETTINGS.s3BaseUrl]);
  assert.equal(typeof made[0].key, "function", "the key is a function the seam asks on every call");
  assert.equal(await made[0].key(), API);
  assert.equal(claim.disk.id, SETTINGS.disk);
  assert.deepEqual(claim.settings, SETTINGS);
  assert.deepEqual(asked, [ARCHIL_API_KEY_ROW], "the disk token is not opened until a mount asks for it");
});

test("archil claim: the disk token is opened when a mount first asks, once, and both values are in the redaction set", async () => {
  const { claim, asked } = await claimOf();
  assert.equal(await claim.token(), TOKEN);
  assert.equal(await claim.token(), TOKEN);
  assert.deepEqual(asked, [ARCHIL_API_KEY_ROW, ARCHIL_DISK_TOKEN_ROW], "each row is read once");
  assert.deepEqual([...claim.secrets].sort(), [API, TOKEN].sort());
});

test("archil claim: a claim that cannot open its key is refused in words, before any disk is made", async () => {
  const refused = async (options, words) => {
    const made = [];
    await assert.rejects(
      archilClaim({ settings: SETTINGS, sealedKey: async (name) => options.rows?.get(name), sealKey: KEY, signal: new AbortController().signal, ...options, makeDisk: (o) => { made.push(o); return { id: o.disk }; } }),
      (error) => error instanceof ArchilClaimRefused && words.test(error.message) && !error.message.includes(API),
    );
    assert.deepEqual(made, [], "no disk was made");
  };
  await refused({ settings: undefined, rows: rowsOf() }, /Archil disk is not set up/);
  await refused({ sealKey: undefined, rows: rowsOf(), sealedKey: async () => assert.fail("no row is read without a seal key") }, /seal key/);
  await refused({ rows: new Map() }, new RegExp(`no ${ARCHIL_API_KEY_ROW.replace(".", "\\.")} key is saved`));
  await refused({ rows: rowsOf(randomBytes(32)) }, /does not open/);
  // A value sealed for another row does not open as this one.
  const moved = new Map([[ARCHIL_API_KEY_ROW, sealColumn(KEY, sealedAt.sealedKey(ARCHIL_DISK_TOKEN_ROW), API)]]);
  await refused({ rows: moved }, /does not open/);
  // The real disk checks its S3 endpoint when it is made (no call is sent): a bad one refuses the claim.
  await assert.rejects(
    archilClaim({ settings: { ...SETTINGS, s3BaseUrl: "http://s3.example.com" }, sealedKey: async (name) => rowsOf().get(name), sealKey: KEY, signal: new AbortController().signal }),
    (error) => error instanceof ArchilClaimRefused && /S3 endpoint/.test(error.message) && !error.message.includes(API),
  );
});

test("archil claim: a missing disk token refuses the mount that asks for it, not the claim", async () => {
  const { claim } = await claimOf({ rows: rowsOf(KEY, { [ARCHIL_API_KEY_ROW]: API }) });
  await assert.rejects(claim.token(), (error) => error instanceof ArchilClaimRefused && /no archil\.disk_token key is saved/.test(error.message));
});

test("archil claim: release(), or the claim's signal aborting, drops both values: the disk's key and the token are refused after", async () => {
  for (const end of ["release", "abort"]) {
    const controller = new AbortController();
    const { claim, made } = await claimOf({ signal: controller.signal });
    await claim.token();
    if (end === "release") claim.release();
    else controller.abort();
    await assert.rejects(Promise.resolve().then(() => made[0].key()), /released/, `${end}: the key`);
    await assert.rejects(claim.token(), /released/, `${end}: the token`);
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
    await claim.token();
    claim.release();
  } finally {
    process.env = realEnv;
  }
  assert.deepEqual(readNames.filter((name) => /ARCHIL|AGENTRUN/i.test(name)), []);
});
