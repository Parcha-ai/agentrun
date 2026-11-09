// A take-over that changed the page (QA, run 01a1c256): the person takes the browser, navigates, and hands it back; the
// agent's call that waited then acts on the snapshot their hand made stale. That call answers no error: nothing was done,
// the model is told to take a snapshot first, and its result is marked page_changed_while_held so its timeline row reads
// neutral. A stale snapshot with no take, or a take the person did not drive, answers the stale failure as before. Over
// the real page driver on a stand-in page (live_view_take_over.test.mjs's rig), and the real driving gate: no browser.
import assert from "node:assert/strict";
import test from "node:test";
import { createDrivingGates } from "../dist/core/driving.js";
import { drivingGuard, PAGE_CHANGED_FOR_MODEL, PAGE_CHANGED_WHILE_HELD } from "../dist/core/driving-guard.js";
import { classifyBrowserError, NO_HYDRATED_SNAPSHOT_ERROR } from "../dist/core/failures.js";

/** The real page driver over a stand-in page: one snapshot of two elements; `acts` lists each action that reached it. */
async function rig() {
  const { pageDriver } = await import("../dist/driver/page-driver.js");
  const acts = [];
  const page = { pageId: "page-1", at: "https://example.test/page", doc: 1000.25, evaluate: async (expression) => (String(expression).includes("performance.timeOrigin") ? page.doc : undefined), url: async () => page.at, snapshot: async () => ({ formattedTree: "[1-1] link: Details\n[1-2] textbox: Name", xpathMap: { "1-1": "/html/body/a", "1-2": "/html/body/input" } }), screenshot: async () => new Uint8Array() };
  const stagehand = {
    browser: { context: { activePage: async () => page } },
    experimentalBatch: async (_callback, input) => { for (const action of input?.actions ?? []) acts.push(action.id); return { completed: input?.actions?.length ?? 0 }; },
    close: async () => {},
  };
  return { driver: pageDriver(stagehand, { batchMs: 5_000 }), page, acts };
}

/** The run tool as pi-browser's tools answer it: the actions, or the classified failure as JSON with the session's notice, an error. */
const runTool = (gates) => drivingGuard(async (_a, port) => {
  const s = await port.session();
  try {
    return { content: [{ type: "text", text: JSON.stringify(await s.driver.run({ actions: [{ op: "click", id: "1-1" }] })) }] };
  } catch (error) {
    const failure = classifyBrowserError(error, true, {});
    return { content: [{ type: "text", text: JSON.stringify(s.notice ? { notice: s.notice, ...failure } : failure) }], isError: true };
  }
}, gates);

const portOf = (tag, driver) => ({ session: async () => ({ tag, driver, notice: null }), relaunch: async () => ({ tag, driver }), release: async () => ({ released: true, sessionId: null }) });

test("the person takes over, navigates and hands back: the held act on the stale snapshot answers no error, does nothing, tells the model to snapshot first, and is marked for its timeline row", async () => {
  const gates = createDrivingGates();
  const tag = "ar-run-stale-1";
  const { driver, page, acts } = await rig();
  await driver.snapshot({});
  const gate = gates(tag);
  gate.take();
  // The agent's act comes while the person holds the browser: it waits.
  const running = runTool(gates)({}, portOf(tag, driver), {});
  await new Promise((go) => setImmediate(go));
  // The person's hand: their input, a navigation to another page.
  assert.equal(gate.input(), "driving");
  page.at = "https://example.test/elsewhere";
  page.doc = 2000.5;
  gate.give();
  const out = await running;
  assert.notEqual(out.isError, true, "no error");
  assert.equal(PAGE_CHANGED_WHILE_HELD, "page_changed_while_held", "the mark pi-durable-agent's timeline reads, by this name");
  assert.equal(out.details?.[PAGE_CHANGED_WHILE_HELD], true, "marked for its row");
  const told = JSON.parse(out.content[0].text);
  assert.equal(told.message, PAGE_CHANGED_FOR_MODEL);
  assert.equal(told.next, "snapshot");
  assert.match(PAGE_CHANGED_FOR_MODEL, /Take a snapshot first/);
  assert.ok(told.notice, "with the notice that the person had the browser");
  assert.deepEqual(acts, [], "nothing reached the page");
});

test("a stale snapshot with no take answers the stale failure as before, an error, unmarked", async () => {
  const gates = createDrivingGates();
  const { driver, page, acts } = await rig();
  await driver.snapshot({});
  page.at = "https://example.test/elsewhere";
  page.doc = 2000.5;
  const out = await runTool(gates)({}, portOf("ar-run-stale-2", driver), {});
  assert.equal(out.isError, true);
  assert.equal(JSON.parse(out.content[0].text).code, "stale_snapshot");
  assert.equal(out.details?.[PAGE_CHANGED_WHILE_HELD], undefined);
  assert.deepEqual(acts, []);
});

test("a take the person did not drive (taken and handed back with no input) answers the stale failure as before: their hand changed nothing", async () => {
  const gates = createDrivingGates();
  const tag = "ar-run-stale-3";
  const { driver, acts } = await rig();
  await driver.snapshot({});
  gates(tag).take();
  const running = runTool(gates)({}, portOf(tag, driver), {});
  await new Promise((go) => setImmediate(go));
  gates(tag).give();
  const out = await running;
  assert.equal(out.isError, true);
  assert.equal(JSON.parse(out.content[0].text).message, NO_HYDRATED_SNAPSHOT_ERROR);
  assert.equal(out.details?.[PAGE_CHANGED_WHILE_HELD], undefined);
  assert.deepEqual(acts, []);
});
