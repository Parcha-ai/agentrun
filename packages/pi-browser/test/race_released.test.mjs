import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import * as faux from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createBrowserExtension } from "@parcha/pi-browser/durable";
import { FakeBackend, fakeDriver, fixturePage } from "@parcha/pi-browser/testing";

// A release by a session's tag that ends sessions besides the session's own (a create race of the tag left one running,
// which no record bills): the host hears their ids (`onRaceReleased`), once each release answered, and never the
// session's own, which its record bills. A host whose hook throws never fails the release.

const START = "https://example.test/start";

async function run(t, onRaceReleased) {
  const backend = new FakeBackend({ start: START, pages: { [START]: fixturePage(START, "The start page.") } });
  // Each create of a tag also leaves a second session under it, which nobody's answer names.
  const left = [];
  const provider = {
    ...backend.provider,
    async create(spec, signal) {
      const made = await backend.provider.create(spec, signal);
      left.push((await backend.provider.create(spec, signal)).id);
      return made;
    },
  };
  const browser = createBrowserExtension({
    provider: () => provider, driver: fakeDriver(backend), evidence: { file: async () => null }, onRaceReleased,
    tools: { browser_read: async (_args, port) => { const s = await port.session(); await s.driver.page(); return { content: [{ type: "text", text: "read" }] }; } },
  });
  const model = faux.fauxProvider({ models: [{ id: "faux-1" }] });
  model.setResponses(Array.from({ length: 4 }, () => (context) => {
    if (context.messages.some((m) => m.role === "toolResult")) return faux.fauxAssistantMessage([faux.fauxText("done")], { stopReason: "stop" });
    return faux.fauxAssistantMessage([faux.fauxToolCall("browser_read", {})], { stopReason: "toolUse" });
  }));
  const models = createModels();
  models.setProvider(model.provider);
  const registry = createRegistry();
  registry.install(browser.extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry, onReport: () => {} }, ctx);
  t.after(async () => { await harness.close(ctx).catch(() => undefined); await browser.close(); });
  const config = { label: "node-a", run: "run-race", policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0, batchTimeoutMs: 60_000 } };
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), config); } });
  await browser.reconcile(harness, () => true, ctx);
  await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
  await browser.release(root, "close", ctx);
  await browser.drain(harness, ctx);
  const [record] = (await harness.snapshot(browser.docs.Sessions, root.id, ctx)).sessions;
  return { record, left, backend, rootId: root.id };
}

test("a release by the session's tag that ends a session a create race left: the host hears that one's id, once, and never the session's own", async (t) => {
  const heard = [];
  const { record, left, backend, rootId } = await run(t, (released) => { heard.push(released); });
  assert.equal(record.state, "released");
  assert.equal(left.length, 1);
  assert.equal(backend.sessions.get(left[0]).state, "stopped", "the release by its tag ended it");
  assert.deepEqual(heard, [{ conversationId: rootId, tag: record.tag, ids: [left[0]] }]);
});

test("a host whose onRaceReleased throws never fails the release: the session's record ends released and both sessions end", async (t) => {
  let calls = 0;
  const { record, left, backend } = await run(t, () => { calls += 1; throw new Error("the host could not book it"); });
  assert.equal(calls, 1);
  assert.equal(record.state, "released");
  assert.equal(backend.sessions.get(record.resourceId).state, "stopped");
  assert.equal(backend.sessions.get(left[0]).state, "stopped");
});

// A create whose answer was lost and whose tag lookup found nothing yet: the row has no id, and its release task looks
// again by tag after the create deadline. By then the create left two sessions under the tag, A and B. The release's
// first attempt finds [A, B], releases A (the row's own, the first found) and fails on B; the next look finds only B,
// either the task's retry or (`abort`) the abort handler of a task aborted while it waits to retry.
async function lostCreate(t, { abort = false } = {}) {
  const backend = new FakeBackend({ start: START, pages: { [START]: fixturePage(START, "The start page.") } });
  const made = [];
  let lookups = 0;
  let failB = true;
  let failedB;
  const bFailed = new Promise((resolve) => { failedB = resolve; });
  const provider = {
    ...backend.provider,
    async create(spec, signal) {
      made.push((await backend.provider.create(spec, signal)).id, (await backend.provider.create(spec, signal)).id);
      throw new Error("the create's answer was lost");
    },
    async findByTag(tag, signal) {
      return ++lookups === 1 ? [] : backend.provider.findByTag(tag, signal);
    },
    async release(ref, signal) {
      if (ref.id === made[1] && failB) { failB = false; failedB(); throw new Error("the release of B failed"); }
      return backend.provider.release(ref, signal);
    },
  };
  const heard = [];
  const browser = createBrowserExtension({
    provider: () => provider, driver: fakeDriver(backend), evidence: { file: async () => null }, createDeadlineMs: 50,
    onRaceReleased: (released) => { heard.push(released); },
    tools: { browser_read: async (_args, port) => { const s = await port.session(); await s.driver.page(); return { content: [{ type: "text", text: "read" }] }; } },
  });
  const model = faux.fauxProvider({ models: [{ id: "faux-1" }] });
  model.setResponses(Array.from({ length: 4 }, () => (context) => {
    if (context.messages.some((m) => m.role === "toolResult")) return faux.fauxAssistantMessage([faux.fauxText("done")], { stopReason: "stop" });
    return faux.fauxAssistantMessage([faux.fauxToolCall("browser_read", {})], { stopReason: "toolUse" });
  }));
  const models = createModels();
  models.setProvider(model.provider);
  const registry = createRegistry();
  registry.install(browser.extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry, onReport: () => {} }, ctx);
  t.after(async () => { await harness.close(ctx).catch(() => undefined); await browser.close(); });
  const config = { label: "node-a", run: "run-race", policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0, batchTimeoutMs: 60_000 } };
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), config); } });
  await browser.reconcile(harness, () => true, ctx);
  await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
  if (abort) {
    // The retry waits backoffMs(0), 500 ms, after the failed attempt: the abort lands inside that wait.
    await bFailed;
    await root.abort(ctx, { background: true });
  }
  await browser.drain(harness, ctx);
  const tasks = (await harness.commit((tx) => tx.scanTasks({}, 50), ctx)).items.filter((task) => task.kind === "browser.release");
  const [a, b] = made;
  assert.equal(made.length, 2, "one create, two sessions under its tag");
  assert.equal(failB, false, "the first attempt's release of B failed");
  const [record] = (await harness.snapshot(browser.docs.Sessions, root.id, ctx)).sessions;
  return { a, b, record, heard, backend, rootId: root.id, outcomes: tasks.map((task) => task.state.outcome?.status) };
}

const raceRetryHolds = ({ a, b, record, heard, backend, rootId }) => {
  assert.equal(record.state, "released");
  assert.equal(record.resourceId, a, "the record bills the first session its tag found, A");
  assert.equal(backend.sessions.get(a).state, "stopped");
  assert.equal(backend.sessions.get(b).state, "stopped");
  assert.deepEqual(heard, [{ conversationId: rootId, tag: record.tag, ids: [b] }], "B, released by the next look, is told as raced, once; A, the record's own, never");
};

test("a release that retries after its first attempt released the row's own session and failed on the other: the retry tells the other as raced, once, and the record bills the own one", async (t) => {
  const seen = await lostCreate(t);
  assert.deepEqual(seen.outcomes, ["completed"], "the task's own retry released B");
  raceRetryHolds(seen);
});

test("a release aborted while it waits to retry, after its first attempt released the row's own session and failed on the other: the abort handler tells the other as raced, once, and the record bills the own one", async (t) => {
  const seen = await lostCreate(t, { abort: true });
  assert.deepEqual(seen.outcomes, ["aborted"], "the abort handler released B");
  raceRetryHolds(seen);
});

// A row that owns A, whose tag also finds B, a session a create race left. B's release reaches the provider: it stops B
// and then fails (its status read after the stop), so no later lookup by tag finds B. The release's checkpoint keeps
// every id it found, and the step that confirms the release tells B, once its stop is confirmed. `lateStop`: B's release
// answers with B still running, and B stops only after the first status read of it. `restart`: the process ends while
// the task waits to retry, and the next process over the same storage resumes it.
async function stoppedThenFailed(t, { lateStop = false, restart = false } = {}) {
  const backend = new FakeBackend({ start: START, pages: { [START]: fixturePage(START, "The start page.") } });
  const left = [];
  let failB = !lateStop;
  let stopLate = lateStop;
  let failedB;
  const bFailed = new Promise((resolve) => { failedB = resolve; });
  const provider = {
    ...backend.provider,
    async create(spec, signal) {
      const made = await backend.provider.create(spec, signal);
      left.push((await backend.provider.create(spec, signal)).id);
      return made;
    },
    async release(ref, signal) {
      if (ref.id === left[0] && stopLate) return undefined;
      const out = await backend.provider.release(ref, signal);
      if (ref.id === left[0] && failB) { failB = false; failedB(); throw new Error("the status read after B's stop failed"); }
      return out;
    },
    async status(ref, signal) {
      const read = await backend.provider.status(ref, signal);
      if (ref.id === left[0] && stopLate) { stopLate = false; await backend.provider.release(ref, signal); }
      return read;
    },
  };
  const heard = [];
  const storage = new MemoryStorage();
  // One process's custody over the shared storage; a process that ends leaves the storage open, as a file would be.
  const view = (lasts) => new Proxy(storage, { get: (target, prop) => (prop === "close" && !lasts ? async () => {} : typeof target[prop] === "function" ? target[prop].bind(target) : target[prop]) });
  let processes = 0;
  const open = async (lasts) => {
    const by = (processes += 1);
    const browser = createBrowserExtension({
      provider: () => provider, driver: fakeDriver(backend), evidence: { file: async () => null },
      onRaceReleased: (released) => { heard.push({ ...released, by, stopped: released.ids.map((id) => backend.sessions.get(id).state) }); },
      tools: { browser_read: async (_args, port) => { const s = await port.session(); await s.driver.page(); return { content: [{ type: "text", text: "read" }] }; } },
    });
    const model = faux.fauxProvider({ models: [{ id: "faux-1" }] });
    model.setResponses(Array.from({ length: 4 }, () => (context) => {
      if (context.messages.some((m) => m.role === "toolResult")) return faux.fauxAssistantMessage([faux.fauxText("done")], { stopReason: "stop" });
      return faux.fauxAssistantMessage([faux.fauxToolCall("browser_read", {})], { stopReason: "toolUse" });
    }));
    const models = createModels();
    models.setProvider(model.provider);
    const registry = createRegistry();
    registry.install(browser.extension);
    const harness = await Harness.open(view(lasts), { models, registry, onReport: () => {} }, ctx);
    const config = { label: "node-a", run: "run-race", policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0, batchTimeoutMs: 60_000 } };
    const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), config); } });
    await browser.reconcile(harness, () => true, ctx);
    return { browser, harness, root };
  };
  const first = await open(!restart);
  let last = first;
  t.after(async () => { await last.harness.close(ctx).catch(() => undefined); await last.browser.close(); });
  await (await first.root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
  await first.browser.release(first.root, "close", ctx);
  if (restart) {
    // The retry waits backoffMs(0), 500 ms, after the failed attempt: the process ends inside that wait.
    await bFailed;
    await first.browser.close();
    await first.harness.close(ctx);
    last = await open(true);
  }
  await last.browser.drain(last.harness, ctx);
  const tasks = (await last.harness.commit((tx) => tx.scanTasks({}, 50), ctx)).items.filter((task) => task.kind === "browser.release");
  const [record] = (await last.harness.snapshot(last.browser.docs.Sessions, last.root.id, ctx)).sessions;
  return { b: left[0], record, heard, backend, rootId: last.root.id, failB, stopLate, outcomes: tasks.map((task) => task.state.outcome?.status) };
}

test("a release that stops the other session and then fails on it (its status read): the retry, which no longer finds it by its tag, confirms its stop and tells it as raced, once", async (t) => {
  const { b, record, heard, backend, rootId, failB, outcomes } = await stoppedThenFailed(t);
  assert.equal(failB, false, "B's release stopped it and then failed");
  assert.deepEqual(outcomes, ["completed"]);
  assert.equal(record.state, "released");
  assert.equal(backend.sessions.get(b).state, "stopped");
  assert.deepEqual(heard, [{ conversationId: rootId, tag: record.tag, ids: [b], by: 1, stopped: ["stopped"] }], "B is told once, and the record's own never");
});

test("the other session's release answers while it still runs: it is told as raced only once a status read confirms its stop, and once", async (t) => {
  const { b, record, heard, rootId, stopLate, outcomes } = await stoppedThenFailed(t, { lateStop: true });
  assert.equal(stopLate, false, "B ran past its release's answer, and stopped after the first status read");
  assert.deepEqual(outcomes, ["completed"]);
  assert.deepEqual(heard, [{ conversationId: rootId, tag: record.tag, ids: [b], by: 1, stopped: ["stopped"] }], "told once, after its stop");
});

test("a release that stops the other session and then fails on it, its process ending while it waits to retry: the next process resumes the task, confirms the stop and tells it as raced, once", async (t) => {
  const { b, record, heard, backend, rootId, failB, outcomes } = await stoppedThenFailed(t, { restart: true });
  assert.equal(failB, false, "B's release stopped it and then failed");
  assert.deepEqual(outcomes, ["completed"], "the resumed task completed");
  assert.equal(record.state, "released");
  assert.equal(backend.sessions.get(b).state, "stopped");
  assert.deepEqual(heard, [{ conversationId: rootId, tag: record.tag, ids: [b], by: 2, stopped: ["stopped"] }], "B is told once across both processes, by the one that resumed the task");
});

/** A clock the Harness reads and arms its timers on: `advance` moves it on and fires what fell due. */
function fakeClock() {
  let now = Date.now();
  const due = new Set();
  return {
    now: () => now,
    setTimer: (callback, delayMs) => {
      const timer = { at: now + delayMs, callback };
      due.add(timer);
      return () => due.delete(timer);
    },
    advance(ms) {
      now += ms;
      for (const timer of [...due].sort((a, b) => a.at - b.at)) if (timer.at <= now) (due.delete(timer), timer.callback());
    },
  };
}

// A row that owns A, whose tag also finds B. A's release answers every time and A runs on, so each attempt's
// confirmation finds it running and the task ends lost after its last attempt. `bStops`: B's release stops it; else B
// runs on too. Then (`stuck` cleared) the next run open's reconcile releases what the lost row's tag still finds.
async function lostRelease(t, { bStops }) {
  const clock = fakeClock();
  const backend = new FakeBackend({ start: START, pages: { [START]: fixturePage(START, "The start page.") } });
  const made = [];
  let stuck = true;
  const provider = {
    ...backend.provider,
    async create(spec, signal) {
      const own = await backend.provider.create(spec, signal);
      made.push(own.id, (await backend.provider.create(spec, signal)).id);
      return own;
    },
    async release(ref, signal) {
      if (stuck && (ref.id === made[0] || (ref.id === made[1] && !bStops))) return undefined;
      return backend.provider.release(ref, signal);
    },
  };
  const heard = [];
  const browser = createBrowserExtension({
    provider: () => provider, driver: fakeDriver(backend), evidence: { file: async () => null },
    onRaceReleased: (released) => { heard.push({ ids: released.ids, stopped: released.ids.map((id) => backend.sessions.get(id).state) }); },
    tools: { browser_read: async (_args, port) => { const s = await port.session(); await s.driver.page(); return { content: [{ type: "text", text: "read" }] }; } },
  });
  const model = faux.fauxProvider({ models: [{ id: "faux-1" }] });
  model.setResponses(Array.from({ length: 4 }, () => (context) => {
    if (context.messages.some((m) => m.role === "toolResult")) return faux.fauxAssistantMessage([faux.fauxText("done")], { stopReason: "stop" });
    return faux.fauxAssistantMessage([faux.fauxToolCall("browser_read", {})], { stopReason: "toolUse" });
  }));
  const models = createModels();
  models.setProvider(model.provider);
  const registry = createRegistry();
  registry.install(browser.extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry, onReport: () => {}, now: clock.now, setTimer: clock.setTimer }, ctx);
  t.after(async () => { await harness.close(ctx).catch(() => undefined); await browser.close(); });
  const config = { label: "node-a", run: "run-race", policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0, batchTimeoutMs: 60_000 } };
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), config); } });
  await browser.reconcile(harness, () => true, ctx);
  await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
  await browser.release(root, "close", ctx);
  const outcome = async () => (await harness.commit((tx) => tx.scanTasks({}, 50), ctx)).items.find((task) => task.kind === "browser.release")?.state.outcome?.status;
  for (let i = 0; i < 2_000 && (await outcome()) === undefined; i += 1) {
    clock.advance(1_000);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const atLost = { outcome: await outcome(), heard: [...heard], state: (await harness.snapshot(browser.docs.Sessions, root.id, ctx)).sessions[0].state };
  stuck = false;
  await browser.reconcile(harness, () => false, ctx);
  return { b: made[1], atLost, heard, backend };
}

test("a release that ends lost tells the other session it stopped as raced, once its status read says so, and the reconcile after it tells nothing more", async (t) => {
  const { b, atLost, heard, backend } = await lostRelease(t, { bStops: true });
  assert.deepEqual([atLost.outcome, atLost.state], ["failed", "lost"], "the row's own session ran on through every attempt");
  assert.deepEqual(atLost.heard, [{ ids: [b], stopped: ["stopped"] }], "B, stopped, is told as the task ends lost");
  assert.equal(backend.sessions.get(b).state, "stopped");
  assert.deepEqual(heard, atLost.heard, "the reconcile, which no longer finds B, tells it no second time");
});

test("a release that ends lost with the other session still running tells it nothing; the next run open's reconcile releases it and tells it once its stop is confirmed", async (t) => {
  const { b, atLost, heard, backend } = await lostRelease(t, { bStops: false });
  assert.deepEqual([atLost.outcome, atLost.state], ["failed", "lost"]);
  assert.deepEqual(atLost.heard, [], "B still runs: nothing is told");
  assert.equal(backend.sessions.get(b).state, "stopped", "the reconcile released it");
  assert.deepEqual(heard, [{ ids: [b], stopped: ["stopped"] }], "told once, by the reconcile, after its stop");
});
