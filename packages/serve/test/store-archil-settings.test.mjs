// The Archil disk's Mode 2 configuration as a store row (archil-settings.ts over store.settings): the owner's disk id,
// region, S3 URL and an optional image. Present = Mode 2; absent or not the expected shape = Mode 1. The server's
// environment can set the same settings instead (archilSettingsFromEnv), over the row and never written to it. The disk's
// credentials are sealed keys (store-server-keys.test.mjs), not here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";

const { ARCHIL_SETTINGS_KEY, clearArchilSettings, inArchilMode, loadArchilSettings, saveArchilSettings } = await import("../dist/archil-settings.js");

test("no settings is Mode 1; saved settings read back and make Mode 2; clear returns to Mode 1", async (t) => {
  const { store } = await storeOn(t);
  assert.equal(await loadArchilSettings(store), undefined, "none saved");
  assert.equal(await inArchilMode(store), false, "Mode 1");
  await saveArchilSettings(store, { diskId: "disk-abc", region: "us-east-1", s3Url: "https://s3.example.com/bucket", image: "debian:trixie" });
  assert.deepEqual(await loadArchilSettings(store), { diskId: "disk-abc", region: "us-east-1", s3Url: "https://s3.example.com/bucket", image: "debian:trixie" });
  assert.equal(await inArchilMode(store), true, "Mode 2 once present");
  await clearArchilSettings(store);
  assert.equal(await loadArchilSettings(store), undefined, "cleared");
  assert.equal(await inArchilMode(store), false, "back to Mode 1");
});

test("the optional image is left out when not set, and a replace overwrites in place", async (t) => {
  const { store } = await storeOn(t);
  await saveArchilSettings(store, { diskId: "d1", region: "eu-west-1", s3Url: "https://s3.example/eu" });
  assert.deepEqual(await loadArchilSettings(store), { diskId: "d1", region: "eu-west-1", s3Url: "https://s3.example/eu" }, "no image key");
  await saveArchilSettings(store, { diskId: "d2", region: "eu-west-1", s3Url: "https://s3.example/eu" });
  assert.equal((await loadArchilSettings(store)).diskId, "d2", "replaced in place");
});

test("a row that is not the expected shape reads as Mode 1 (never a half-configured Mode 2)", async (t) => {
  const { store } = await storeOn(t);
  await store.settings.put(ARCHIL_SETTINGS_KEY, { diskId: "only-this" });
  assert.equal(await loadArchilSettings(store), undefined, "missing region/s3Url: Mode 1");
  await store.settings.put(ARCHIL_SETTINGS_KEY, "not-an-object");
  assert.equal(await loadArchilSettings(store), undefined, "not an object: Mode 1");
});

// The same settings from the server's environment (ARCHIL_SETTINGS_ENV), for a server whose operator sets the disk where
// it is started: all three required variables or none, each value by the PUT's own rule, and over a saved row while set.
const { ArchilSettingsEnvInvalid, archilSettingsFromEnv } = await import("../dist/archil-settings.js");
const ENV = { AGENTRUN_ARCHIL_DISK: "dsk-env", AGENTRUN_ARCHIL_REGION: "aws-us-east-1", AGENTRUN_ARCHIL_S3_URL: "https://s3.env.example" };
const PINNED = `ghcr.io/agentrun/exec@sha256:${"b".repeat(64)}`;

test("the environment's settings: none set is none; all three are the settings, trimmed; the image is optional and pinned", () => {
  assert.equal(archilSettingsFromEnv({}), undefined);
  assert.equal(archilSettingsFromEnv({ AGENTRUN_ARCHIL_DISK: "  ", AGENTRUN_ARCHIL_REGION: "" }), undefined, "empty is unset, as for a key");
  assert.deepEqual(archilSettingsFromEnv({ ...ENV, AGENTRUN_ARCHIL_DISK: " dsk-env " }), { diskId: "dsk-env", region: "aws-us-east-1", s3Url: "https://s3.env.example" });
  assert.deepEqual(archilSettingsFromEnv({ ...ENV, AGENTRUN_ARCHIL_IMAGE: PINNED }), { diskId: "dsk-env", region: "aws-us-east-1", s3Url: "https://s3.env.example", image: PINNED });
});

test("some of the environment's settings but not all is refused naming what is missing, never a half-configured Mode 2", () => {
  assert.throws(() => archilSettingsFromEnv({ AGENTRUN_ARCHIL_DISK: "dsk-env", AGENTRUN_ARCHIL_REGION: "aws-us-east-1" }), (error) =>
    error instanceof ArchilSettingsEnvInvalid && /started with AGENTRUN_ARCHIL_DISK, AGENTRUN_ARCHIL_REGION but not AGENTRUN_ARCHIL_S3_URL/.test(error.message));
  assert.throws(() => archilSettingsFromEnv({ AGENTRUN_ARCHIL_IMAGE: PINNED }), (error) =>
    error instanceof ArchilSettingsEnvInvalid && /but not AGENTRUN_ARCHIL_DISK, AGENTRUN_ARCHIL_REGION, AGENTRUN_ARCHIL_S3_URL/.test(error.message), "the image alone is not a disk");
});

test("an environment value the PUT would refuse is refused by the same rule, naming its variable", () => {
  assert.throws(() => archilSettingsFromEnv({ ...ENV, AGENTRUN_ARCHIL_S3_URL: "http://s3.env.example" }), (error) =>
    error instanceof ArchilSettingsEnvInvalid && /AGENTRUN_ARCHIL_S3_URL is the disk's S3 endpoint, an https URL/.test(error.message));
  assert.throws(() => archilSettingsFromEnv({ ...ENV, AGENTRUN_ARCHIL_IMAGE: "ghcr.io/agentrun/exec:latest" }), (error) =>
    error instanceof ArchilSettingsEnvInvalid && /AGENTRUN_ARCHIL_IMAGE is pinned by digest/.test(error.message));
});

test("the environment's settings win over a saved row and write none; unset again, the saved row is back", async (t) => {
  const { store } = await storeOn(t);
  assert.equal(await inArchilMode(store, ENV), true, "Mode 2 from the environment alone, nothing saved");
  assert.equal(await store.settings.get(ARCHIL_SETTINGS_KEY), undefined, "nothing written to the store");
  await saveArchilSettings(store, { diskId: "dsk-saved", region: "eu-west-1", s3Url: "https://s3.saved.example" });
  assert.equal((await loadArchilSettings(store, ENV)).diskId, "dsk-env", "the environment wins");
  assert.equal((await loadArchilSettings(store, {})).diskId, "dsk-saved", "without it, the saved row, as before");
});
