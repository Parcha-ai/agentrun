// A take-over that changed the page (QA, run 01a1c256): the person takes the browser, navigates, and hands it back; the
// agent's call that waited then acts on the snapshot their hand made stale. That call answers no error: nothing was done,
// the model is told to take a snapshot first, and its result is marked page_changed_while_held so its timeline row reads
// neutral. A stale snapshot with no take answers the stale failure as before. A take the person did not use (no input
// reached the page) keeps the agent's snapshot: the page is as the agent left it, so its next act just works. Over
// the real page driver on a stand-in page (live_view_take_over.test.mjs's rig), and the real driving gate: no browser.
import assert from "node:assert/strict";
import test from "node:test";
import { createDrivingGates } from "../dist/core/driving.js";
import { drivingGuard, PAGE_CHANGED_FOR_MODEL, PAGE_CHANGED_WHILE_HELD } from "../dist/core/driving-guard.js";
import { classifyBrowserError } from "../dist/core/failures.js";

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

/** The run tool as pi-browser's tools answer it: the actions with the session's notice, or the classified failure as JSON
 *  with the notice, an error. `pause`, when given, is awaited between taking the session and acting on it. */
const runTool = (gates, pause) => drivingGuard(async (_a, port) => {
  const s = await port.session();
  if (pause) await pause;
  try {
    const done = await s.driver.run({ actions: [{ op: "click", id: "1-1" }] });
    return { content: [{ type: "text", text: JSON.stringify(s.notice ? { notice: s.notice, ...done } : done) }] };
  } catch (error) {
    const failure = error?.failure ?? classifyBrowserError(error, true, {});
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

test("a take with no input, then hand-back: the held act runs against the kept snapshot and succeeds, unmarked, with no word that the page changed", async () => {
  const gates = createDrivingGates();
  const tag = "ar-run-stale-3";
  const { driver, acts } = await rig();
  await driver.snapshot({});
  gates(tag).take();
  const running = runTool(gates)({}, portOf(tag, driver), {});
  await new Promise((go) => setImmediate(go));
  gates(tag).give();
  const out = await running;
  assert.notEqual(out.isError, true, JSON.stringify(out.content));
  assert.deepEqual(acts, ["1-1"], "the act reached the page by the snapshot's own id");
  assert.equal(out.details?.[PAGE_CHANGED_WHILE_HELD], undefined);
  const told = JSON.parse(out.content[0].text);
  assert.doesNotMatch(told.notice ?? "", /may have changed|take a snapshot/i, "nothing tells the agent the page moved: it did not");
  // And the take is used up: the next act is told nothing.
  const next = JSON.parse((await runTool(gates)({}, portOf(tag, driver), {})).content[0].text);
  assert.equal(next.notice, undefined);
  assert.deepEqual(acts, ["1-1", "1-1"]);
});

test("a take WITH input, the page's address unchanged: the snapshot is still dropped, and the held act takes the page-changed path", async () => {
  const gates = createDrivingGates();
  const tag = "ar-run-stale-4";
  const { driver, acts } = await rig();
  await driver.snapshot({});
  const gate = gates(tag);
  gate.take();
  const running = runTool(gates)({}, portOf(tag, driver), {});
  await new Promise((go) => setImmediate(go));
  assert.equal(gate.input(), "driving", "the person's hand, on the same page");
  gate.give();
  const out = await running;
  assert.notEqual(out.isError, true);
  assert.equal(out.details?.[PAGE_CHANGED_WHILE_HELD], true);
  assert.equal(JSON.parse(out.content[0].text).message, PAGE_CHANGED_FOR_MODEL);
  assert.deepEqual(acts, []);
});

/** A call under way when the person takes over (driving-guard's mid-call cut): it is refused at its act, typed, and told to
 *  take a snapshot before it acts again; the hold then starts once it returns. */
async function cutMidCall(gates, tag, driver) {
  let go;
  const pause = new Promise((resolve) => { go = resolve; });
  const running = runTool(gates, pause)({}, portOf(tag, driver), {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gates(tag).take(), true, "taken while the call runs");
  go();
  const cut = await running;
  assert.equal(cut.isError, true);
  const failure = JSON.parse(cut.content[0].text);
  assert.equal(failure.code, "refused");
  assert.match(failure.message, /The person took over this browser.*take a snapshot before you act/);
  assert.equal(cut.details?.[PAGE_CHANGED_WHILE_HELD], undefined, "the cut call is the fence's refusal, as before");
  return failure;
}

test("the mid-call cut with ids kept: the call under way is refused as before; handed back with no input, the next act on the old id goes through", async () => {
  const gates = createDrivingGates();
  const tag = "ar-run-stale-5";
  const { driver, acts } = await rig();
  await driver.snapshot({});
  await cutMidCall(gates, tag, driver);
  assert.deepEqual(acts, [], "the cut act never reached the page");
  gates(tag).give();
  const out = await runTool(gates)({}, portOf(tag, driver), {});
  assert.notEqual(out.isError, true, JSON.stringify(out.content));
  assert.deepEqual(acts, ["1-1"]);
  assert.equal(out.details?.[PAGE_CHANGED_WHILE_HELD], undefined);
});

test("the mid-call cut, then the person's input: the next act on the old id takes the page-changed path", async () => {
  const gates = createDrivingGates();
  const tag = "ar-run-stale-6";
  const { driver, acts } = await rig();
  await driver.snapshot({});
  await cutMidCall(gates, tag, driver);
  assert.equal(gates(tag).input(), "driving", "the hold started once the cut call returned; the person's hand");
  gates(tag).give();
  const out = await runTool(gates)({}, portOf(tag, driver), {});
  assert.notEqual(out.isError, true);
  assert.equal(out.details?.[PAGE_CHANGED_WHILE_HELD], true);
  assert.deepEqual(acts, []);
});

test("the gate: a take alone is `drove` without `handled`; the person's input is both; told() clears both", () => {
  const gates = createDrivingGates();
  const gate = gates("ar-run-stale-7");
  gate.take();
  gate.give();
  let entered = gate.model();
  assert.equal(entered.drove, true);
  assert.equal(entered.handled, false);
  entered.release();
  gate.take();
  gate.input();
  gate.give();
  entered = gate.model();
  assert.deepEqual([entered.drove, entered.handled], [true, true]);
  entered.release();
  gate.told();
  entered = gate.model();
  assert.deepEqual([entered.drove, entered.handled], [false, false]);
  entered.release();
  gates("ar-run-stale-7").end?.();
});
