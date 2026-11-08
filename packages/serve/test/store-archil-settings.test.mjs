// The Archil disk's Mode 2 configuration as a store row (archil-settings.ts over store.settings): the owner's disk id,
// region, S3 URL and an optional image. Present = Mode 2; absent or not the expected shape = Mode 1. The disk's credentials
// are sealed keys (store-server-keys.test.mjs), not here.
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
