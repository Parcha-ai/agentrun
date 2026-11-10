// The server's tool settings read and written as a store row (store.settings), the store-backed replacement for the
// tool-settings.json file (tool-plane.ts loadToolSettings / saveToolSettings). The cut wires these; they fail closed as the
// file path did: no row is every default, a permission that is not offered reads as a marked stand-in (ask), never allow.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";

const { loadToolSettings, saveToolSettings, TOOL_SETTINGS_KEY, ToolSettings } = await import("../dist/tool-plane.js");
const { pinRefusal } = await import("../dist/tool-gate.js");

/** An MCP tool a server pins: a pin is a gate fence (pinRefusal), so a save must never lose it. */
const SEND = "mcp:fake/send_message";

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

test("a server pin round-trips through the store, and the gate refuses a call outside it", async (t) => {
  const { store } = await storeOn(t);
  const served = await saveToolSettings(store, { [SEND]: { permission: "allow", pin: { channel_id: "C0123" } } });
  assert.deepEqual(served, { [SEND]: { permission: "allow", pin: { channel_id: "C0123" } } }, "the save answers the pin");
  assert.deepEqual(await store.settings.get(TOOL_SETTINGS_KEY), { [SEND]: { permission: "allow", pin: { channel_id: "C0123" } } }, "the row holds the pin");
  const { settings } = await loadToolSettings(store);
  assert.deepEqual(settings[SEND], { permission: "allow", pin: { channel_id: "C0123" } }, "it reads back");
  assert.ok(pinRefusal(SEND, { channel_id: "C0999" }, settings), "a call outside the pin is refused");
  assert.equal(pinRefusal(SEND, { channel_id: "C0123" }, settings), undefined, "a call as pinned is let through");
});

test("a stored pin that does not read keeps refusing, survives a whole-map save without a pin, and is cleared only by a valid pin or the key left out", async (t) => {
  const { store } = await storeOn(t);
  await store.settings.put(TOOL_SETTINGS_KEY, { [SEND]: { permission: "allow", pin: 42 } });
  const { settings } = await loadToolSettings(store);
  assert.equal(settings[SEND].brokenPin, true, "it loads as a broken pin");
  assert.ok(pinRefusal(SEND, { channel_id: "C0123" }, settings), "a broken pin refuses every call");
  // A console sends the whole served map back, the tool's key with no pin of its own: the broken pin stays.
  await saveToolSettings(store, { [SEND]: { permission: "allow" } });
  assert.deepEqual(await store.settings.get(TOOL_SETTINGS_KEY), { [SEND]: { permission: "allow", pin: 42 } }, "written back as its raw value");
  assert.ok(pinRefusal(SEND, { channel_id: "C0123" }, (await loadToolSettings(store)).settings), "it still refuses");
  // A valid pin replaces it.
  await saveToolSettings(store, { [SEND]: { permission: "allow", pin: { channel_id: "C0123" } } });
  const fixed = (await loadToolSettings(store)).settings[SEND];
  assert.deepEqual(fixed, { permission: "allow", pin: { channel_id: "C0123" } }, "a valid pin clears the broken one");
  // Broken again, then the key left out: no setting, no pin.
  await store.settings.put(TOOL_SETTINGS_KEY, { [SEND]: { pin: 42 } });
  await saveToolSettings(store, {});
  assert.deepEqual(await store.settings.get(TOOL_SETTINGS_KEY), {}, "the key left out clears it");
});

test("the store's save and the file's save agree: the same map over the same state answers and writes the same", async (t) => {
  const before = { [SEND]: { permission: "allow", pin: 42 }, bash: { permission: "whenever" }, web_search: { provider: "parallel" } };
  const map = { [SEND]: { permission: "allow" }, bash: { permission: "ask" }, web_search: { provider: "parallel" }, read: { permission: "deny" } };
  const { store } = await storeOn(t);
  await store.settings.put(TOOL_SETTINGS_KEY, before);
  const dir = await mkdtemp(join(tmpdir(), "tool-settings-parity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, ToolSettings.FILE), JSON.stringify(before));
  const file = new ToolSettings(dir, () => {});
  // The store's load reads the same state the file's constructor did.
  assert.deepEqual((await loadToolSettings(store)).settings, file.get(), "the same state before the save");
  const fromStore = await saveToolSettings(store, map);
  const fromFile = file.put(map);
  assert.deepEqual(fromStore, fromFile, "the same served map");
  assert.deepEqual(await store.settings.get(TOOL_SETTINGS_KEY), JSON.parse(await readFile(join(dir, ToolSettings.FILE), "utf8")), "the same written object");
});
