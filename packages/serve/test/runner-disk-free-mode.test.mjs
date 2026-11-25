// Which mode a disk-free runner's claim gate reads (runner/disk-free.ts diskFreeRefusal): the server's, never the runner's.
// The server's Archil settings are saved in the store, or set in the server's own environment, whose names it says in the
// store at its start (runner-check.ts RUN_ENV_KEY). A runner whose environment alone holds Archil settings would keep a
// run's folder on Archil while the server looks for it on its own disk, so it claims nothing; a runner that lacks them
// while the server has them in its environment would keep the folder on its own disk, so it claims nothing either.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { ARCHIL_S3_URL_NOT_HELD, DATA_ROOT_FILE, DATA_ROOT_KEY, DISK_FREE_MODE_1, DISK_FREE_NO_ARCHIL, diskFreeGate, diskFreeRefusal } = await import("../dist/runner/disk-free.js");
const { ARCHIL_SETTINGS_KEY, ARCHIL_SETTINGS_ENV } = await import("../dist/archil-settings.js");
const { RUN_ENV_KEY } = await import("../dist/runner/runner-check.js");

const SERVER_ROOT = "a".repeat(32);
const REGION = "aws-us-east-1";
const S3 = "https://s3.green.us-east-1.aws.prod.archil.com";
const ARCHIL_ENV = { [ARCHIL_SETTINGS_ENV.region]: REGION, [ARCHIL_SETTINGS_ENV.s3Url]: S3 };

/** A store's settings holding `rows` (the server's data root's id always among them). */
const storeWith = (rows = {}) => {
  const all = { [DATA_ROOT_KEY]: { v: 1, id: SERVER_ROOT }, ...rows };
  return { settings: { get: async (key) => all[key] ?? null } };
};

/** A runner's data directory: its own (no id), or the server's (`shared`). */
function dataDir(t, shared = false) {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-disk-free-mode-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (shared) writeFileSync(join(dir, DATA_ROOT_FILE), `${SERVER_ROOT}\n`);
  return dir;
}

test("a disk-free runner whose environment alone holds Archil settings claims nothing while the server is in Mode 1", async (t) => {
  assert.equal(await diskFreeRefusal(storeWith(), dataDir(t), ARCHIL_ENV, "postgres"), DISK_FREE_MODE_1);
  // The server said its run-facing names, and no Archil name is among them: still the server's Mode 1.
  assert.equal(await diskFreeRefusal(storeWith({ [RUN_ENV_KEY]: { v: 1, names: ["MONID_API_KEY"] } }), dataDir(t), ARCHIL_ENV, "postgres"), DISK_FREE_MODE_1);
});

test("the server in Mode 2 by its environment: a disk-free runner that holds the settings claims, one that lacks them claims nothing and says to hand them over", async (t) => {
  const store = storeWith({ [RUN_ENV_KEY]: { v: 1, names: [ARCHIL_SETTINGS_ENV.region, ARCHIL_SETTINGS_ENV.s3Url] } });
  assert.equal(await diskFreeRefusal(store, dataDir(t), ARCHIL_ENV, "postgres"), undefined);
  const words = await diskFreeRefusal(store, dataDir(t), {}, "postgres");
  assert.equal(words, DISK_FREE_NO_ARCHIL);
  assert.match(words, new RegExp(`the server's ${ARCHIL_SETTINGS_ENV.region} \\(and ${ARCHIL_SETTINGS_ENV.s3Url} and ${ARCHIL_SETTINGS_ENV.image} when the server has them\\)`));
});

test("the server in Mode 2 by a known region alone in its environment (its S3 URL the region's): a runner given the region claims, one without it claims nothing", async (t) => {
  const store = storeWith({ [RUN_ENV_KEY]: { v: 1, names: [ARCHIL_SETTINGS_ENV.region] } });
  assert.equal(await diskFreeRefusal(store, dataDir(t), { [ARCHIL_SETTINGS_ENV.region]: REGION }, "postgres"), undefined);
  assert.equal(await diskFreeRefusal(store, dataDir(t), {}, "postgres"), DISK_FREE_NO_ARCHIL);
});

test("the server in Mode 2 by saved settings: a disk-free runner claims with no Archil settings of its own", async (t) => {
  assert.equal(await diskFreeRefusal(storeWith({ [ARCHIL_SETTINGS_KEY]: { region: REGION, s3Url: S3 } }), dataDir(t), {}, "postgres"), undefined);
});

test("a runner on the server's disk, on SQLite, or beside a server older than this claims in either mode, whatever its environment", async (t) => {
  assert.equal(await diskFreeRefusal(storeWith(), dataDir(t, true), {}, "postgres"), undefined);
  assert.equal(await diskFreeRefusal(storeWith(), dataDir(t, true), ARCHIL_ENV, "postgres"), undefined);
  assert.equal(await diskFreeRefusal(storeWith(), dataDir(t), ARCHIL_ENV, "sqlite"), undefined);
  assert.equal(await diskFreeRefusal({ settings: { get: async () => null } }, dataDir(t), ARCHIL_ENV, "postgres"), undefined);
});

// A runner given a region without an S3 URL reaches Archil at the region's (archil-settings.ts ARCHIL_S3_URLS). Its claim
// gate (diskFreeGate) refuses while the server's S3 URL may be another, so no run's folder is reached at two endpoints:
// the server started with AGENTRUN_ARCHIL_S3_URL (its names say so; never its value), or in Mode 2 by saved settings whose
// s3Url is not the runner's. This holds for any runner, on the server's disk or not, on either store.
const OTHER = "https://s3.other.example.test";
const REGION_ONLY = { [ARCHIL_SETTINGS_ENV.region]: REGION };
const NOT_HELD = new RegExp(`given ${ARCHIL_SETTINGS_ENV.region} without ${ARCHIL_SETTINGS_ENV.s3Url}.*Hand this runner the server's S3 URL as ${ARCHIL_SETTINGS_ENV.s3Url}\\.$`);
const gateOf = (t, store, env, { shared = false, kind = "postgres" } = {}) => diskFreeGate(store, dataDir(t, shared), env, kind)(true);

test("the server started with AGENTRUN_ARCHIL_S3_URL: a runner given the region alone claims nothing, on its disk or not, on either store; one given the S3 URL too claims", async (t) => {
  const store = storeWith({ [RUN_ENV_KEY]: { v: 1, names: [ARCHIL_SETTINGS_ENV.region, ARCHIL_SETTINGS_ENV.s3Url] } });
  for (const where of [{}, { shared: true }, { kind: "sqlite" }]) {
    const words = await gateOf(t, store, REGION_ONLY, where);
    assert.equal(typeof words, "string", `refused: ${JSON.stringify(where)}`);
    assert.match(words, NOT_HELD);
    assert.equal(words, ARCHIL_S3_URL_NOT_HELD);
  }
  assert.equal(await gateOf(t, store, ARCHIL_ENV), undefined);
  assert.equal(await gateOf(t, store, { ...REGION_ONLY, [ARCHIL_SETTINGS_ENV.s3Url]: OTHER }, { shared: true }), undefined);
});

test("the server in Mode 2 by saved settings whose S3 URL is not the region's: a runner given the region alone claims nothing; one given none, or the S3 URL too, claims", async (t) => {
  const store = storeWith({ [ARCHIL_SETTINGS_KEY]: { region: REGION, s3Url: OTHER } });
  assert.match(await gateOf(t, store, REGION_ONLY), NOT_HELD);
  assert.match(await gateOf(t, store, REGION_ONLY, { shared: true }), NOT_HELD);
  assert.equal(await gateOf(t, store, {}), undefined);
  assert.equal(await gateOf(t, store, { ...REGION_ONLY, [ARCHIL_SETTINGS_ENV.s3Url]: OTHER }), undefined);
});

test("the server's S3 URL the region's own: a runner given the region alone claims, whether the server has it by its environment (even over a saved row with another) or saved", async (t) => {
  const byEnv = storeWith({ [RUN_ENV_KEY]: { v: 1, names: [ARCHIL_SETTINGS_ENV.region] }, [ARCHIL_SETTINGS_KEY]: { region: REGION, s3Url: OTHER } });
  assert.equal(await gateOf(t, byEnv, REGION_ONLY), undefined);
  assert.equal(await gateOf(t, byEnv, REGION_ONLY, { shared: true }), undefined);
  const saved = storeWith({ [ARCHIL_SETTINGS_KEY]: { region: REGION, s3Url: S3 } });
  assert.equal(await gateOf(t, saved, REGION_ONLY), undefined);
});
