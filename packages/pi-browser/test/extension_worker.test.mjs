import assert from "node:assert/strict";
import test from "node:test";
import { installedExtension, STAGEHAND_EXTENSION } from "../dist/driver/extension-worker.js";
import { fakeCdp, NO_REPLY } from "./fixtures/fake-cdp-worker.mjs";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const WAKE = `chrome-extension://${ID}/wake-service-worker.html`;
const worker = (n) => ({ targetId: `worker-${n}`, type: "service_worker", url: `chrome-extension://${ID}/service-worker.js` });

/** `listing`: "now" answers Target.getTargets at once, "never" never answers it, a number answers it that many ms late. */
function browser({ workers = [worker(1)], wakeThatStarts = 1, replies = true, dropOnWake = false, listing = "now", wakeReplyAt = 0 } = {}) {
  const state = { workers, wakes: 0, pages: new Set(), closedWorkers: [], held: true, firstCall: 0 };
  const handle = (method, params, { sessionId, emit, drop }) => {
    state.firstCall ||= Date.now();
    if (method === "Extensions.getExtensions") return { extensions: [{ id: ID, name: STAGEHAND_EXTENSION, enabled: true }] };
    if (method === "Target.getTargets") {
      if (listing === "never") return NO_REPLY;
      const list = { targetInfos: [...state.workers, ...[...state.pages].map((targetId) => ({ targetId, type: "page", url: WAKE }))] };
      return listing === "now" ? list : new Promise((resolve) => setTimeout(() => resolve(list), listing));
    }
    if (method === "Target.attachToTarget") return { sessionId: `session-${params.targetId}` };
    if (method === "Runtime.evaluate") {
      const close = JSON.parse(JSON.parse(/__stagehandReceiveFromHost\((".*")\)/.exec(params.expression)[1]));
      if (close.method === "stagehand.close") state.held = false;
      if (replies) emit("Runtime.bindingCalled", { name: "__stagehandSendToHost", payload: JSON.stringify({ jsonrpc: "2.0", id: close.id, result: { closed: true } }), executionContextId: 1 }, sessionId);
      return { result: { type: "boolean", value: true } };
    }
    if (method === "Target.closeTarget") {
      if (state.workers.some((target) => target.targetId === params.targetId)) state.closedWorkers.push(params.targetId);
      state.pages.delete(params.targetId);
      return { success: true };
    }
    if (method === "Target.createTarget") {
      if (dropOnWake) drop();
      state.wakes += 1;
      state.pages.add(`wake-${state.wakes}`);
      if (state.wakes === wakeThatStarts) state.workers = [worker(2)];
      const opened = { targetId: `wake-${state.wakes}` };
      // wakeReplyAt: the opening is answered that many ms after the reset's first command.
      return wakeReplyAt ? new Promise((resolve) => setTimeout(() => resolve(opened), state.firstCall + wakeReplyAt - Date.now())) : opened;
    }
    return {};
  };
  return { state, handle };
}

test("a held runtime is released by its own close RPC, and its worker keeps running", async (t) => {
  const { state, handle } = browser();
  const cdp = await fakeCdp(handle);
  t.after(() => cdp.close());
  assert.equal(await installedExtension(cdp.url), ID);
  assert.equal(state.held, false, "stagehand.close reached the runtime");
  assert.deepEqual(state.closedWorkers, [], "the worker is never closed");
  assert.deepEqual(state.workers.map((target) => target.targetId), ["worker-1"]);
  const sent = cdp.calls.filter((call) => call.sessionId === "session-worker-1").map((call) => call.method);
  assert.deepEqual(sent, ["Runtime.enable", "Runtime.addBinding", "Runtime.evaluate"]);
  assert.ok(cdp.calls.some((call) => call.method === "Target.detachFromTarget" && call.params.sessionId === "session-worker-1"), "the reset's session is let go");
});

test("with no worker running nothing is held: the extension is woken until a worker is listed, a lost wake is sent again, and every wake page is closed", async (t) => {
  const { state, handle } = browser({ workers: [], wakeThatStarts: 2 });
  const cdp = await fakeCdp(handle);
  t.after(() => cdp.close());
  const started = Date.now();
  assert.equal(await installedExtension(cdp.url), ID);
  assert.deepEqual(state.workers.map((target) => target.targetId), ["worker-2"], "a worker is listed before Stagehand looks for one");
  assert.deepEqual(cdp.calls.filter((call) => call.method === "Target.createTarget").map((call) => call.params.url), [WAKE, WAKE], "the lost first wake was sent again");
  assert.deepEqual([...state.pages], [], "every wake page is closed");
  assert.ok(Date.now() - started < 5_000, `${Date.now() - started} ms`);
});

test("a close the runtime never answers holds the attach no longer than the reply deadline", async (t) => {
  const { state, handle } = browser({ replies: false });
  const cdp = await fakeCdp(handle);
  t.after(() => cdp.close());
  const started = Date.now();
  assert.equal(await installedExtension(cdp.url, undefined, ID), ID);
  const took = Date.now() - started;
  assert.ok(took >= 2_900 && took < 4_500, `${took} ms`);
  assert.deepEqual(state.closedWorkers, []);
});

test("an abort while the close's reply is awaited ends the attach at once instead of leaving it waiting", { timeout: 10_000 }, async (t) => {
  const { handle } = browser({ replies: false });
  const cdp = await fakeCdp(handle);
  t.after(() => cdp.close());
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const started = Date.now();
  assert.equal(await installedExtension(cdp.url, controller.signal, ID), ID);
  assert.ok(Date.now() - started < 1_500, `${Date.now() - started} ms`);
});

test("a browser that drops the connection while the worker is woken ends the attach at once", { timeout: 10_000 }, async (t) => {
  const { handle } = browser({ workers: [], wakeThatStarts: 99, dropOnWake: true });
  const cdp = await fakeCdp(handle);
  t.after(() => cdp.close());
  const started = Date.now();
  assert.equal(await installedExtension(cdp.url, undefined, ID), ID);
  assert.ok(Date.now() - started < 1_500, `${Date.now() - started} ms`);
});

test("a target list the browser never gives fails the attach by the deadline: it is not a list without a worker, so the reset is never skipped", { timeout: 30_000 }, async (t) => {
  const { state, handle } = browser({ listing: "never" });
  const cdp = await fakeCdp(handle);
  t.after(() => cdp.close());
  const started = Date.now();
  const error = await installedExtension(cdp.url, undefined, ID).then(() => null, (e) => e);
  const took = Date.now() - started;
  assert.match(error?.message ?? "", /did not list its targets within 10000 ms/);
  assert.ok(took >= 9_000 && took < 13_000, `failed after ${took} ms`);
  assert.equal(state.wakes, 0, "no worker was woken on a list it never had");
  assert.equal(state.held, true);
});

test("a list that answers late is still read: the held runtime gets its close", { timeout: 30_000 }, async (t) => {
  const { state, handle } = browser({ listing: 2_500 });
  const cdp = await fakeCdp(handle);
  t.after(() => cdp.close());
  assert.equal(await installedExtension(cdp.url, undefined, ID), ID);
  assert.equal(state.held, false, "stagehand.close reached the runtime");
});

test("a worker still not listed at the deadline: the wake loop stops there and its last wake page is closed on the same socket", { timeout: 30_000 }, async (t) => {
  // Each list comes 800 ms late and never holds a worker, so the wake loop is still running when the deadline comes.
  const { state, handle } = browser({ workers: [], wakeThatStarts: 99, listing: 800 });
  const cdp = await fakeCdp(handle);
  t.after(() => cdp.close());
  const started = Date.now();
  assert.equal(await installedExtension(cdp.url, undefined, ID), ID);
  const took = Date.now() - started;
  assert.ok(state.wakes >= 1, `woken ${state.wakes} times`);
  assert.deepEqual([...state.pages], [], "no wake page is left open");
  assert.ok(took < 12_000, `ended after ${took} ms`);
});

test("a wake page whose opening is answered only after the deadline is still closed, in the second the socket outlives it", { timeout: 30_000 }, async (t) => {
  // Lists come 800 ms late with no worker; the one wake page opens early, but its opening is answered 10.2 s after the
  // reset's first command, past its 10 s deadline.
  const { state, handle } = browser({ workers: [], wakeThatStarts: 99, listing: 800, wakeReplyAt: 10_200 });
  const cdp = await fakeCdp(handle);
  t.after(() => cdp.close());
  const started = Date.now();
  assert.equal(await installedExtension(cdp.url, undefined, ID), ID);
  assert.equal(state.wakes, 1);
  assert.ok(Date.now() - started > 10_000, "the opening's reply came after the deadline");
  assert.deepEqual([...state.pages], [], "the page is closed though its id came late");
});
