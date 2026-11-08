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
import { openSqliteStore } from "../dist/store/index.js";
import { startRunner } from "../dist/runner/runner.js";
import { suiteTools } from "../dist/runner/conformance/harness.js";
import { piSpec } from "./conformance-pi.mjs";
import { quiet, sleep, until } from "./live-support.mjs";

const { createPiLoop } = await import("../dist/runner/loop.js");
const { withLiveTicker } = await import("../dist/runner/live-ticker.js");
const TICK_MS = 250;
const TIMING = { leaseMs: 5_000, renewEveryMs: 1_000, stopMarginMs: 1_000, pollMs: 50, commandPollMs: 200 };

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
  ticker = withLiveTicker(store, createPiLoop(piSpec({ script: [{ call: "slow" }, { say: "done" }], tools, hooks: quiet })), { tickMs: TICK_MS });
  runner = startRunner({ store, createLoop: ticker.createLoop, name: "runner-a", loops: loops + 10, ...TIMING });
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
  const { server, release } = await heldWrites(t, 3, 1_000);
  const row = await server.runs.get("run-0");
  const journal = server.journal({ runId: "run-0", runner: "reader", epoch: row.epoch, until: 0, from: row.state });
  const seqs = async () => (await journal.commitsAfter(0, 10_000, ctx)).commits.map((commit) => commit.seq);
  // pi's own last write as the tool starts (its pi.live document marking it running) can land just after the held row is
  // seen: the count starts once the journal has been still for longer than two ticks, which a tick that wrote to the
  // journal would never allow.
  let before = await seqs();
  await until(async () => {
    await sleep(TICK_MS * 2 + 100);
    const now = await seqs();
    const still = now.length === before.length;
    before = now;
    return still;
  }, "the run's journal still for two ticks", 10_000);
  await sleep(1_000);
  const after = await seqs();
  assert.ok((await server.live.read(["run-0"])).length === 1, "the run's held row was written meanwhile");
  assert.deepEqual(after, before, "a second of held-state ticks added no commit to the run's journal");
  release();
});
