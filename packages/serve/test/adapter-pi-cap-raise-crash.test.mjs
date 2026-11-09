// pi through the adapter, parked at its cap and raised, its runner lost before the raise's follow-up turn is done: the
// next claim sends the follow-up once and the run ends with it answered. Mirrors serve cap-raise.test.mjs:201 ("a raise
// taken, then the server killed before its follow-up went: the next server sends it, once, and the run completes") and
// :368 ("a raise whose follow-up's process came up, then its server was killed before the follow-up went: the next server
// sends it to that process, once").
//
// The first runner's journal stops at a named write and never returns from it, so the loss lands at that exact point:
// (a) the follow-up's submission, after the raise entry's commit took the row and resumed the pause; (b) the first
// commit after that submission landed (the follow-up's request record, before the request leaves). The runner is then
// killed and a second one claims the run once its lease has run out.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { beforeRequestOf, cap, quiet, rootEntries, SONNET, sleep, STEADY } from "./adapter-pi-cap-support.mjs";

after(closeOpenSessions);
const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");

const CAP = 0.01;
const RAISED = 5;
const FOLLOW_UP = cap.followUpOf(RAISED).text;
const isFollowUp = (write) => write.type === "submission" && String(write.value?.requestId ?? "").startsWith("agentrun:raise:");

/** `journal` whose commits stop for good at `point`: "submission" stops the follow-up's own commit, "after" every commit
 *  once that one landed. `stopped` resolves when it stops; `release()` lets the held commit fail, at the test's end. */
function stoppingAt(point) {
  let said = () => {};
  const stopped = new Promise((resolve) => (said = resolve));
  let fail = () => {};
  const held = new Promise((_, reject) => (fail = reject));
  held.catch(() => undefined);
  let landed = false;
  const wrap = (journal) =>
    new Proxy(journal, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key !== "commit" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
        return async (batches, receive, context) => {
          const followUp = batches.some((batch) => batch.some(isFollowUp));
          if ((point === "submission" && followUp) || (point === "after" && landed)) {
            said();
            return held;
          }
          const result = await value.call(target, batches, receive, context);
          if (followUp) landed = true;
          return result;
        };
      },
    });
  return { wrap, stopped, release: () => fail(new Error("the test ended")) };
}

async function crashedRaise(t, point, { short = false } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-adapter-raise-crash-"));
  // The stores' clock: real time plus `clock.skewMs`, so the killed runner's claim runs out when the case moves the
  // store's now past its until, never by waiting for a short real lease.
  const clock = { skewMs: 0 };
  const now = () => Date.now() + clock.skewMs;
  const server = await openSqliteStore({ dataDir: dir, role: "server", now });
  const stores = [await openSqliteStore({ dataDir: dir, role: "runner", now }), await openSqliteStore({ dataDir: dir, role: "runner", now })];
  const runners = [];
  const stop = stoppingAt(point);
  t.after(async () => {
    stop.release();
    for (const runner of runners) await runner.close().catch(() => {});
    for (const store of stores) await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Raise crash" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  let capUsd = CAP;
  const sent = [];
  const script = [{ say: "done" }];
  const spec = piAdapterSpec({ script, tools: {}, hooks: quiet }, { fetch: scriptedOrigin(script, sent) });
  const runCap = { get capUsd() { return capUsd; }, park: (refusal) => cap.parkOf(refusal, capUsd), checkRaise: cap.checkRaise, followUpOf: cap.followUpOf };
  const loop = createAdapterLoop(async (claim, run) => ({
    ...(await spec(claim, run)),
    cap: runCap,
    runCap: ({ capUsd: () => capUsd, modelOf: () => SONNET }),
  }), { restartLimit: MAX_RESTARTS });
  // The first runner's journal stops at the point; the second's is the store's own.
  const first = (deps) => loop({ ...deps, journal: (claim) => stop.wrap(deps.journal(claim)) });
  runners.push(startRunner({ store: stores[0], createLoop: first, name: "runner-a", ...STEADY }));
  const settled = async (state, ms = 20_000) => {
    const from = Date.now();
    for (;;) {
      const row = await server.runs.get("run-1");
      if (row.state === state && row.runner === null) return row;
      // A final state other than the one waited for fails at once; the one waited for waits for its release too.
      if ((row.state !== state && ["ended", "stopped", "failed"].includes(row.state)) || Date.now() - from > ms) throw new Error(`not ${state} within ${ms} ms: ${JSON.stringify(row)}; ${sent.length} requests sent`);
      await sleep(20);
    }
  };
  await settled("parked");
  assert.equal(sent.length, 0, "the refused request never reached the provider");
  // `short`: above the cap, below the request's least cap: it resumes the run, and the follow-up's request is refused.
  const [budget] = await rootEntries(stores[0], "agentrun.budget");
  const to = short ? Number(((CAP + budget.pending.least_cap_usd) / 2).toFixed(6)) : RAISED;
  capUsd = to;
  const raise = await sendCommand(server, "run-1", { kind: "raise", body: { capUsd: to } });
  await stop.stopped;
  runners[0].kill();
  // The second runner on a lease no stall of a loaded machine outlasts: the run moves from the first runner to it by the
  // first's loss alone. On the short lease a stall could lose its own claim while its follow-up's request was out, and
  // the claim that took it again would send that request once more (the lost one booked cut): a second request this
  // test would read as a follow-up sent twice. That path is its own case below, forced, never left to the clock.
  runners.push(startRunner({ store: stores[1], createLoop: loop, name: "runner-b", ...STEADY }));
  const row = await settled(short ? "parked" : "ended").catch(async (error) => {
    throw new Error(`${error.message}; raises ${JSON.stringify(await rootEntries(stores[1], "agentrun.raise"))}`);
  });
  return { row, sent, server, raise, to, store: stores[1] };
}

const followUpsIn = (body) => JSON.stringify(body.messages ?? []).split(FOLLOW_UP).length - 1;

for (const [point, words] of [["submission", "before its follow-up's submission landed"], ["after", "after its follow-up's submission landed, before that turn's request left"]]) {
  test(`a raised run whose runner is lost ${words}: the next claim sends the follow-up once, and the run ends with it answered`, async (t) => {
    const w = await crashedRaise(t, point);
    assert.equal(w.row.summary, null, `ended with no words: ${JSON.stringify(w.row)}`);
    const followUps = w.sent.filter((body) => followUpsIn(body) > 0);
    assert.equal(followUps.length, 1, `one follow-up request reached the provider: ${JSON.stringify(w.sent.map((body) => body.messages))}`);
    assert.equal(followUpsIn(followUps[0]), 1, `the follow-up is in the conversation once: ${JSON.stringify(followUps[0].messages)}`);
    const taken = (await w.server.commands("run-1", w.raise.id - 1)).find((command) => command.id === w.raise.id);
    assert.ok(taken.takenAt !== null && taken.refused === null, `the raise row is taken, not refused: ${JSON.stringify(taken)}`);
    const raises = await rootEntries(w.store, "agentrun.raise");
    assert.deepEqual(raises.map((data) => [data.capUsd, data.takes]), [[RAISED, [w.raise.id]]], "one raise entry, never a second");
  });
}

// A follow-up whose request is out when its runner is lost: that request may have been billed, so it is booked cut (its
// hold and its bound) and the next claim sends the follow-up's request again. Two requests reach the provider, both on
// the run's books, and the follow-up is in the conversation once. Forced by events: the provider holds the first
// follow-up request until the first runner is gone and the second has sent its own.
test("a raised run whose runner is lost while its follow-up's request is out: that request is booked cut, the next claim sends it once more, and the run ends", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-adapter-raise-lost-request-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const stores = [await openSqliteStore({ dataDir: dir, role: "runner" }), await openSqliteStore({ dataDir: dir, role: "runner" })];
  const runners = [];
  let release = () => {};
  const held = new Promise((resolve) => (release = resolve));
  t.after(async () => {
    release();
    for (const runner of runners) await runner.close().catch(() => {});
    for (const store of stores) await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Raise lost request" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  let capUsd = CAP;
  const sent = [];
  const script = [{ say: "done" }];
  const origin = scriptedOrigin(script, sent);
  let followUpOut = () => {};
  const out = new Promise((resolve) => (followUpOut = resolve));
  let first = true;
  // The provider: the first follow-up request is held (its runner is lost meanwhile), every other answered at once.
  const fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (first && followUpsIn(body) > 0) {
      first = false;
      sent.push(body);
      followUpOut();
      await held;
      throw new Error("the provider's connection went with its runner");
    }
    return origin(url, init);
  };
  const spec = piAdapterSpec({ script, tools: {}, hooks: quiet }, { fetch });
  const parkRule = { get capUsd() { return capUsd; }, park: (refusal) => cap.parkOf(refusal, capUsd), checkRaise: cap.checkRaise, followUpOf: cap.followUpOf };
  const loop = createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), cap: parkRule, runCap: { capUsd: () => capUsd, modelOf: () => SONNET } }), { restartLimit: MAX_RESTARTS });
  runners.push(startRunner({ store: stores[0], createLoop: loop, name: "runner-a", ...TIMING }));
  const settled = async (state, ms = 20_000) => {
    const from = Date.now();
    for (;;) {
      const row = await server.runs.get("run-1");
      if (row.state === state && row.runner === null) return row;
      if ((row.state !== state && ["ended", "stopped", "failed"].includes(row.state)) || Date.now() - from > ms) throw new Error(`not ${state} within ${ms} ms: ${JSON.stringify(row)}; ${sent.length} requests sent`);
      await sleep(20);
    }
  };
  await settled("parked");
  capUsd = RAISED;
  await sendCommand(server, "run-1", { kind: "raise", body: { capUsd: RAISED } });
  // The first runner's follow-up request is out (held at the provider): the runner is lost there.
  await out;
  runners[0].kill();
  runners.push(startRunner({ store: stores[1], createLoop: loop, name: "runner-b", ...STEADY }));
  const row = await settled("ended");
  release();
  assert.equal(row.summary, null, `ended with no words: ${JSON.stringify(row)}`);
  const followUps = sent.filter((body) => followUpsIn(body) > 0);
  assert.equal(followUps.length, 2, `the lost request and the next claim's, no more: ${JSON.stringify(sent.map((body) => body.messages))}`);
  for (const body of followUps) assert.equal(followUpsIn(body), 1, `the follow-up is in the conversation once: ${JSON.stringify(body.messages)}`);
  // On the run's books: the lost request booked cut, at its hold and bound, beside the one that was answered.
  const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");
  const { createModels } = await import("@earendil-works/pi-ai/models");
  const { createRegistry, Harness } = await import("@earendil-works/pi-durable");
  const { journalSessions } = await import("../dist/runner/sessions.js");
  const now = await stores[1].runs.get("run-1");
  const reader = await Harness.open(stores[1].journal({ runId: "run-1", runner: "test-reader", epoch: now.epoch, until: 0, from: now.state }), { models: createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  try {
    const records = await journalSessions(reader, ctx, stores[1]).read("root");
    const turns = records.filter((r) => r.kind === "runner.turn").map((r) => r.data);
    assert.equal(turns.filter((data) => data.cut === true).length, 1, `the lost request booked cut: ${JSON.stringify(records.map((r) => [r.kind, r.data]))}`);
    assert.equal(records.filter((r) => r.kind === "runner.request").length, turns.length, `every request booked: ${JSON.stringify(records.map((r) => [r.kind, r.data]))}`);
  } finally {
    await reader.close(ctx);
  }
});

// Mirrors kernel-cap-park "a parked run's next step stays refused until the cap is raised, then goes", across a lost
// runner: the run's end is the follow-up turn's, never the first input's.
test("a raise short of the need whose runner is lost after its follow-up's submission landed: the next claim's follow-up is refused, and the run parks again with a fresh pending budget, never ended", async (t) => {
  const w = await crashedRaise(t, "after", { short: true });
  assert.equal(w.sent.length, 0, `no request reached the provider: ${JSON.stringify(w.sent.map((body) => body.messages))}`);
  const budgets = await rootEntries(w.store, "agentrun.budget");
  assert.equal(budgets.length, 2, `parked again on a fresh budget: ${JSON.stringify(budgets)}`);
  assert.ok(budgets[1].pending.cap_usd === w.to, `the fresh budget is at the raised cap ${w.to}: ${JSON.stringify(budgets[1].pending)}`);
});
