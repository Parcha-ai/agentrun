// The run's process's writes of who drives its browser (browser-hold.ts), over a stand-in of the server's settings whose
// write is slow, as a store's commit can be: a quick take and hand-back land in order, and a take an earlier process of
// the run left is gone once a new process starts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { browserHeld, browserHoldWriter, markBrowserHeld } from "../dist/browser-hold.js";

/** Settings whose put lands `putMs` after it is called; get and remove are at once. */
function slowSettings(putMs) {
  const rows = new Map();
  return {
    rows,
    get: async (key) => rows.get(key),
    put: (key, value) => new Promise((resolve) => setTimeout(() => { rows.set(key, value); resolve(); }, putMs)),
    remove: async (key) => void rows.delete(key),
  };
}

test("a take handed back at once leaves no take: the hand-back's removal waits for the take's write", async () => {
  const settings = slowSettings(20);
  const writer = browserHoldWriter(settings, "run-1", 1);
  const take = writer.held("ar-run-1-1", true, Date.now());
  const back = writer.held("ar-run-1-1", false, Date.now());
  await Promise.all([take, back]);
  assert.equal(await browserHeld(settings, "run-1"), false, "handed back: the agent drives");
  await writer.held("ar-run-1-1", true, Date.now());
  assert.equal(await browserHeld(settings, "run-1"), true, "taken again: the owner drives");
});

test("a new process of the run starts with nobody holding its browser: a take an earlier one left is gone", async () => {
  const settings = slowSettings(0);
  await markBrowserHeld(settings, "run-2", { session: "ar-run-2-1", at: new Date().toISOString() }, 1);
  const writer = browserHoldWriter(settings, "run-2", 1);
  await writer.held("ar-run-2-2", false, Date.now());
  assert.equal(await browserHeld(settings, "run-2"), false);
  await markBrowserHeld(settings, "run-2", { session: "ar-run-2-3", at: new Date().toISOString() }, 2);
  browserHoldWriter(settings, "run-2", 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await browserHeld(settings, "run-2"), true, "a later claim's take stays");
});
