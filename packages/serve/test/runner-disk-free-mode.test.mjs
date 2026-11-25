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

const { DATA_ROOT_FILE, DATA_ROOT_KEY, DISK_FREE_MODE_1, DISK_FREE_NO_ARCHIL, diskFreeRefusal } = await import("../dist/runner/disk-free.js");
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
