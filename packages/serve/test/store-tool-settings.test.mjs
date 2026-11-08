// The server's tool settings read and written as a store row (store.settings), the store-backed replacement for the
// tool-settings.json file (tool-plane.ts loadToolSettings / saveToolSettings). The cut wires these; they fail closed as the
// file path did: no row is every default, a permission that is not offered reads as a marked stand-in (ask), never allow.
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";

const { loadToolSettings, saveToolSettings, TOOL_SETTINGS_KEY } = await import("../dist/tool-plane.js");

test("no row is every default; a saved map reads back, and the row holds the served (raw) form", async (t) => {
  const { store } = await storeOn(t);
  assert.deepEqual(await loadToolSettings(store), { settings: {}, problems: [] }, "no row = every default");
  const served = await saveToolSettings(store, { web_search: { provider: "parallel" }, bash: { permission: "ask" } });
  assert.deepEqual(served, { web_search: { provider: "parallel" }, bash: { permission: "ask" } });
  assert.deepEqual((await loadToolSettings(store)).settings, { web_search: { provider: "parallel" }, bash: { permission: "ask" } }, "reads back");
  assert.deepEqual(await store.settings.get(TOOL_SETTINGS_KEY), { web_search: { provider: "parallel" }, bash: { permission: "ask" } }, "the row holds the written form");
});

test("a stored permission that is not offered reads closed as a marked ask stand-in, with a problem line", async (t) => {
  const { store } = await storeOn(t);
  // A row an older or hand-edited store holds: bash with a permission no tool offers.
  await store.settings.put(TOOL_SETTINGS_KEY, { bash: { permission: "whenever" } });
  const { settings, problems } = await loadToolSettings(store);
  assert.deepEqual(settings.bash, { permission: "ask", fallback: true, raw: "whenever" }, "ask, marked, the raw value kept");
  assert.equal(problems.length, 1, "one problem line");
  assert.match(problems[0], /the stored tool settings/);
});

test("a stand-in sent back unchanged stays a stand-in; a real choice is written as given", async (t) => {
  const { store } = await storeOn(t);
  await store.settings.put(TOOL_SETTINGS_KEY, { bash: { permission: "whenever" } });
  const { settings } = await loadToolSettings(store);
  // The client saves the whole served map back, the stand-in's ask among it: it stays a stand-in.
  await saveToolSettings(store, settings);
  assert.deepEqual(await store.settings.get(TOOL_SETTINGS_KEY), { bash: { permission: "whenever" } }, "the row keeps the value as written");
  assert.deepEqual((await loadToolSettings(store)).settings.bash, { permission: "ask", fallback: true, raw: "whenever" }, "still a stand-in");
  // A real choice replaces it.
  await saveToolSettings(store, { bash: { permission: "deny" } });
  assert.deepEqual(await store.settings.get(TOOL_SETTINGS_KEY), { bash: { permission: "deny" } });
  assert.deepEqual((await loadToolSettings(store)).settings.bash, { permission: "deny" }, "a choice, no stand-in");
});
