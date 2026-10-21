// A person who drove the live view can change the page without changing its URL: the model's next action by an old snapshot id must not land on
// whatever element now sits at that place. Once a person has driven the session, the model's next call is told so, and the session's snapshot ids
// are dropped, so an old id fails as a stale snapshot whatever the URL.
import assert from "node:assert/strict";
import test from "node:test";
import { classifyBrowserError } from "../dist/core/failures.js";
import { drivingGuard } from "../dist/core/driving-guard.js";
import { createDrivingGates } from "../dist/core/driving.js";
import { pageDriver } from "../dist/driver/page-driver.js";
import { NO_HYDRATED_SNAPSHOT_ERROR } from "../dist/core/failures.js";
import { fakeStagehand } from "./fixtures/fake-stagehand.mjs";

/** Timers a test moves by hand. */
function manualTimers() {
  const pending = new Set();
  return { set: (run) => { const handle = { run }; pending.add(handle); return handle; }, clear: (handle) => pending.delete(handle), fire: () => { for (const handle of [...pending]) { pending.delete(handle); handle.run(); } } };
}

/** A page at one URL whose elements a person can swap, and a driver that acts by the ids of its last snapshot, as the facade does. */
function samePage() {
  const page = { url: "https://shop.example.test/checkout", elements: ["Keep my order", "Delete my account"] };
  let ids = null;
  const clicked = [];
  const driver = {
    async close() {},
    async url() { return page.url; },
    async snapshot() { ids = { url: page.url, byId: Object.fromEntries(page.elements.map((name, i) => [`0-${i}`, i])) }; return { text: page.elements.map((name, i) => `[0-${i}] button: ${name}`).join("\n") }; },
    async run({ actions }) {
      if (!ids) throw new Error(NO_HYDRATED_SNAPSHOT_ERROR);
      if (page.url !== ids.url) throw new Error("The active page navigated after its snapshot; call snapshot again.");
      for (const action of actions) clicked.push(page.elements[ids.byId[action.id]]);
      return { completed: actions.length };
    },
    forgetSnapshots() { ids = null; },
  };
  return { page, driver, clicked };
}

/** The tool as the model calls it: the session (and any notice the guard gives it), then the action. */
const act = (attachedDriver) => async (args, port) => {
  const session = await port.session();
  try { return { notice: session.notice ?? null, result: await session.driver.run(args) }; } catch (error) { return { notice: session.notice ?? null, failure: classifyBrowserError(error, false).code }; }
};

test("after a person drives the live view (same URL, the page changed), the model's next action by an old snapshot id is refused as stale and told why", async () => {
  const timers = manualTimers();
  const gates = createDrivingGates({ idleMs: 3000, timers });
  const tag = "ar-run-drove-7-1";
  const { page, driver, clicked } = samePage();
  const port = { session: async () => ({ tag, driver, notice: null }) };
  // The model takes a snapshot: "Keep my order" is 0-0.
  await drivingGuard(async (args, p) => { const s = await p.session(); return s.driver.snapshot(); }, gates)({}, port, { callId: "c1" });
  // A person drives through the live view and swaps the buttons in place, then idles past the window.
  assert.equal(gates(tag).input(), "driving");
  page.elements.reverse();
  timers.fire();
  assert.equal(gates(tag).state(), "idle");
  const out = await drivingGuard(act(driver), gates)({ actions: [{ op: "click", id: "0-0" }] }, port, { callId: "c2" });
  assert.deepEqual(clicked, [], "the old id did not land on the element now in its place");
  assert.equal(out.failure, "stale_snapshot");
  assert.match(out.notice ?? "", /A person used this browser/);
  // A fresh snapshot, then the same action, lands where the model now sees it; no notice once it has been told.
  await drivingGuard(async (args, p) => { const s = await p.session(); return s.driver.snapshot(); }, gates)({}, port, { callId: "c3" });
  const again = await drivingGuard(act(driver), gates)({ actions: [{ op: "click", id: "0-1" }] }, port, { callId: "c4" });
  assert.deepEqual([again.result?.completed, clicked, again.notice], [1, ["Keep my order"], null]);
});

test("with no person since its last call, the model's action by id goes through as before, with no notice", async () => {
  const gates = createDrivingGates({ timers: manualTimers() });
  const { driver, clicked } = samePage();
  const port = { session: async () => ({ tag: "ar-run-drove-7-2", driver, notice: null }) };
  await drivingGuard(async (args, p) => (await p.session()).driver.snapshot(), gates)({}, port, { callId: "c1" });
  const out = await drivingGuard(act(driver), gates)({ actions: [{ op: "click", id: "0-1" }] }, port, { callId: "c2" });
  assert.deepEqual([out.result?.completed, clicked, out.notice], [1, ["Delete my account"], null]);
});

test("a gate a person drove is kept until the model's next call has been told, even after the person and the viewer are gone", async () => {
  const timers = manualTimers();
  const gates = createDrivingGates({ timers });
  const first = gates("ar-run-drove-7-3");
  first.input();
  timers.fire();
  assert.equal(gates("ar-run-drove-7-3"), first, "not forgotten while the model has not been told");
  const entered = first.model();
  assert.equal(entered.drove, true);
  entered.release();
  assert.equal(gates("ar-run-drove-7-3"), first, "a call that was not told keeps it");
  first.told();
  const next = gates("ar-run-drove-7-3").model();
  assert.equal(next.drove, false, "told once");
  next.release();
});

test("pageDriver.forgetSnapshots drops the page's snapshot ids: an old id then fails as a stale snapshot", async () => {
  const driver = pageDriver(fakeStagehand(), { batchMs: 2_000 });
  await driver.snapshot({});
  driver.forgetSnapshots();
  await assert.rejects(driver.run({ actions: [{ op: "click", id: "0-1" }] }), (error) => error.message === NO_HYDRATED_SNAPSHOT_ERROR && classifyBrowserError(error, false).code === "stale_snapshot");
});

test("a call that only took the gate (a relaunch the session refused) does not use up the notice: the next action still gets it, and an old id still fails as stale", async () => {
  const timers = manualTimers();
  const gates = createDrivingGates({ idleMs: 3000, timers });
  const tag = "ar-run-drove-7-5";
  const { page, driver, clicked } = samePage();
  const port = { session: async () => ({ tag, driver, notice: null }), current: async () => tag, relaunch: async () => { throw new Error("this session is fixed: it cannot be relaunched"); } };
  await drivingGuard(async (args, p) => (await p.session()).driver.snapshot(), gates)({}, port, { callId: "c1" });
  gates(tag).input();
  page.elements.reverse();
  timers.fire();
  // browser_relaunch takes the gate early (before its own session call) and is refused: the old session and its ids stay live.
  await assert.rejects(drivingGuard(async (args, p) => p.relaunch({}), gates, { early: true })({}, port, { callId: "c2" }));
  const out = await drivingGuard(act(driver), gates)({ actions: [{ op: "click", id: "0-0" }] }, port, { callId: "c3" });
  assert.deepEqual([clicked, out.failure], [[], "stale_snapshot"]);
  assert.match(out.notice ?? "", /A person used this browser/);
});
