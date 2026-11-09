// The tool settings behaviour over the store (tool-settings-store.ts): a synchronous get() off a snapshot the server loads
// once, and a put() that writes the store and the snapshot, durable before it resolves. The surface the switch swaps
// `new ToolSettings(dir)` for. A real store on a temp file.
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";
import { toolSettingsOverStore } from "../dist/tool-settings-store.js";
import { TOOL_SETTINGS_KEY } from "../dist/tool-plane.js";

const warnings = () => { const lines = []; const warn = (l) => lines.push(l); return { lines, warn }; };

test("no row is every default; get() is synchronous off the snapshot and empty", async (t) => {
  const { store } = await storeOn(t);
  const settings = toolSettingsOverStore(store);
  await settings.load();
  assert.deepEqual(settings.get(), {});
});

test("put writes the store and the snapshot; get reads it back without a reload", async (t) => {
  const { store } = await storeOn(t);
  const settings = toolSettingsOverStore(store);
  await settings.load();
  const served = await settings.put({ web_search: { provider: "parallel" }, bash: { permission: "ask" } });
  assert.deepEqual(served, { web_search: { provider: "parallel" }, bash: { permission: "ask" } });
  assert.deepEqual(settings.get(), { web_search: { provider: "parallel" }, bash: { permission: "ask" } }, "the snapshot has it at once");
  assert.deepEqual(await store.settings.get(TOOL_SETTINGS_KEY), { web_search: { provider: "parallel" }, bash: { permission: "ask" } }, "the row has the written form");
});

test("a reload reads the stored settings back (the snapshot is the store's)", async (t) => {
  const { store } = await storeOn(t);
  const first = toolSettingsOverStore(store);
  await first.load();
  await first.put({ bash: { permission: "deny" } });
  const again = toolSettingsOverStore(store);
  await again.load();
  assert.deepEqual(again.get(), { bash: { permission: "deny" } });
});

test("a stored permission that is not offered loads as a marked ask stand-in, with a warning line", async (t) => {
  const { store } = await storeOn(t);
  await store.settings.put(TOOL_SETTINGS_KEY, { bash: { permission: "whenever" } });
  const { lines, warn } = warnings();
  const settings = toolSettingsOverStore(store, warn);
  await settings.load();
  assert.deepEqual(settings.get().bash, { permission: "ask", fallback: true, raw: "whenever" }, "ask, marked, the raw value kept");
  assert.equal(lines.length, 1, "one warning");
  assert.match(lines[0], /that entry is dropped|the stored tool settings/);
});

test("get returns a copy: a caller's edit does not change the snapshot", async (t) => {
  const { store } = await storeOn(t);
  const settings = toolSettingsOverStore(store);
  await settings.load();
  await settings.put({ bash: { permission: "deny" } });
  const got = settings.get();
  got.bash.permission = "allow";
  assert.equal(settings.get().bash.permission, "deny", "the snapshot is untouched");
});
