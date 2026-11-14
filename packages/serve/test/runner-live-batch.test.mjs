// Reds 7 and 8, the held path's cost (the lead's ruling: batched per RUNNER, not per run): a runner writes every changed
// run_live row in ONE store transaction per tick, so its rate of held-state writes stays at about one per tick whatever
// its loop count (300 runs at 4 a second each would fight the journal for SQLite's one writer). Counted at the store's
// put; the ceiling is the same for 30 loops and for 300. And a held-state write is never in a run's journal.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { openSqliteStore } from "../dist/store/index.js";
import { startRunner } from "../dist/runner/runner.js";
import { suiteTools } from "../dist/runner/conformance/harness.js";
import { after } from "node:test";
import { closeOpenSessions, piAdapterSubject } from "./conformance-pi-adapter.mjs";
import { quiet, sleep, until } from "./live-support.mjs";

after(closeOpenSessions);
const { withLiveTicker } = await import("../dist/runner/live-ticker.js");
const TICK_MS = 250;
// A lease no stall of a loaded machine outlasts: on a 5 s lease, 300 claims whose renews wait behind 300-row puts lapse,
// all 300 runs are taken again, and the new loops' reports fill the ticks the window counts. This file reads the
// ticker's batching, not leases.
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 50, commandPollMs: 200 };

/** `loops` runs each holding a slow tool for `holdMs`; the store's put calls counted per second while they all run. */
async function heldWrites(t, loops, holdMs = 2_000) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-live-batch-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  let ticker;
  t.after(async () => {
    await runner?.close();
    await ticker?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Batch" }, { id: "rev-1", kind: "agentic", body: {} });
  for (let i = 0; i < loops; i++) await server.runs.create({ id: `run-${i}`, agentId: "agent-1", revisionId: "rev-1" });
  const puts = [];
  const put = store.live.put.bind(store.live);
  store.live.put = async (rows) => (puts.push({ at: Date.now(), rows: rows.length }), put(rows));
  const { tools, letSlowGo } = suiteTools();
  ticker = withLiveTicker(store, piAdapterSubject.createLoop({ script: [{ call: "slow" }, { say: "done" }], tools, hooks: quiet }), { tickMs: TICK_MS });
  // The ticker wrapped here, counted per tick: the runner's own is off (live false).
  runner = startRunner({ store, createLoop: ticker.createLoop, live: false, name: "runner-a", loops: loops + 10, ...TIMING });
  await until(async () => (await server.live.read(Array.from({ length: loops }, (_, i) => `run-${i}`))).length === loops, `every one of ${loops} runs holding its running tool`, 60_000);
  const from = Date.now();
  await sleep(holdMs);
  const window = puts.filter((call) => call.at >= from && call.at < from + holdMs);
  // The slow tools are let go by the caller (`release`), so a check can look while they still run.
  t.after(() => letSlowGo());
  return { perSecond: (window.length * 1_000) / holdMs, rows: window.reduce((sum, call) => sum + call.rows, 0), server, release: letSlowGo };
}

test("a runner writes held states in one store transaction per tick, as many for 300 loops as for 30", { timeout: 240_000 }, async (t) => {
  const few = await heldWrites(t, 30);
  few.release();
  const many = await heldWrites(t, 300);
  many.release();
  const ceiling = 1_000 / TICK_MS + 1;
  assert.ok(few.perSecond <= ceiling, `30 loops: ${few.perSecond} puts a second, at most ${ceiling}`);
  assert.ok(many.perSecond <= ceiling, `300 loops: ${many.perSecond} puts a second, at most ${ceiling}`);
});

test("a held-state write is never in a run's journal: no commit, no seq", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-live-journal-"));
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  let ticker, end, started;
  t.after(async () => {
    end?.();
    await started;
    await ticker?.close();
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await store.agents.create({ id: "agent-1", name: "Held" }, { id: "rev-1", kind: "agentic", body: {} });
  await store.runs.create({ id: "run-0", agentId: "agent-1", revisionId: "rev-1" });
  const claim = await store.claim("run-0", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  await commitWrites(journal, [{ type: "conversation", value: { id: 1 } }], ctx);
  const seqs = async () => (await journal.commitsAfter(0, 10_000, ctx)).commits.map((commit) => commit.seq);
  const before = await seqs();
  assert.ok(before.length > 0, "a real committed journal exists before the held-state writes");
  const rowBefore = await store.runs.get("run-0");
  // Isolate live writes from Pi's legitimate startup commits; a quiet interval cannot prove that Pi has finished.
  // The batching case above still exercises real Pi loops. Here each observed update must come from the ticker.
  let report;
  ticker = withLiveTicker(store, (deps) => ({
    start: () => new Promise(resolve => { report = deps.live; end = () => resolve({ state: "ended" }); }),
    command: async () => ({ refused: "not in this test" }),
    stop: async () => end(),
  }), { tickMs: TICK_MS });
  const redact = Object.assign(text => text, { heldValues: () => [] });
  started = ticker.createLoop({ journal: () => journal, flush: async () => {}, signal: new AbortController().signal, redact }).start(claim);
  for (let tick = 1; tick <= 4; tick++) {
    const output = `held chunk ${tick}`;
    report(() => ({ tools: [{ callId: "slow-1", name: "slow", output }] }));
    await until(async () => (await store.live.read(["run-0"]))[0]?.state.tools[0]?.output === output, `held update ${tick} stored`, 3_000);
  }
  const after = await seqs();
  assert.deepEqual(after, before, "four actual held-state ticks added no commit to the run's journal");
  assert.deepEqual(await store.runs.get("run-0"), rowBefore, "held-state ticks leave the durable run row unchanged");
});
