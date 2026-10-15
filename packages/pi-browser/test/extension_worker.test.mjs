import assert from "node:assert/strict";
import test from "node:test";
import { installedExtension, STAGEHAND_EXTENSION } from "../dist/driver/extension-worker.js";
import { fakeCdp } from "./fixtures/fake-cdp-worker.mjs";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const WAKE = `chrome-extension://${ID}/wake-service-worker.html`;
const worker = (n) => ({ targetId: `worker-${n}`, type: "service_worker", url: `chrome-extension://${ID}/service-worker.js` });

function browser({ workers = [worker(1)], wakeThatStarts = 1, replies = true, dropOnWake = false } = {}) {
  const state = { workers, wakes: 0, pages: new Set(), closedWorkers: [], held: true };
  const handle = (method, params, { sessionId, emit, drop }) => {
    if (method === "Extensions.getExtensions") return { extensions: [{ id: ID, name: STAGEHAND_EXTENSION, enabled: true }] };
    if (method === "Target.getTargets") return { targetInfos: state.workers };
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
      return { targetId: `wake-${state.wakes}` };
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
