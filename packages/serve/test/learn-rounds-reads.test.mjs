// Reads over a run a follow-up opened again: a restarted round-2 merge reads its own diff (mergedAt with the round), a
// run that only uses learning shows the seed that failed (usedOnly), and the impact's figures hold the job's own cost
// from its first round and every round's look-back and grade (roundsSpendOf).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { learningCommit, mergedAt } from "../dist/learn/commit.js";
import { learningWorkspace } from "../dist/workspace/index.js";
import { roundsLooked, roundsSpendOf, usedOnly } from "../dist/store-reads/learning.js";
import { runCostOf } from "../dist/learning-cost.js";
import { note } from "./learn-format-support.mjs";

test("a round-2 merge already on main is read back by its round, never as the first round's", async (t) => {
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "learn-rounds-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const text = note({ name: "Units", description: "Units", body: "Convert every amount to one unit first.\n" });
  const landing = learningWorkspace({ mode: "local", data, agentId: "agent-1" });
  try {
    const done = await learningCommit(landing.workspace, { kind: "merge", runId: "run-1", round: 2, reason: "a review", files: [{ path: "units.md", text }], graded: {} });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(await mergedAt(landing.workspace, "run-1", ["units.md"]), undefined, "round 1 merged nothing");
    assert.deepEqual(await mergedAt(landing.workspace, "run-1", ["units.md"], 2), { texts: { "units.md": text } });
  } finally {
    await landing.end();
  }
});

test("a run that only uses learning shows a seed that failed, from its start", () => {
  const started = { given: [], seed: null, section: "", seedFailed: "unreadable", use: true };
  for (const terminal of [false, true]) {
    const end = usedOnly(started, terminal, "2026-11-13T00:00:00.000Z");
    assert.deepEqual([end.state, end.reason], ["dropped", "seed_failed"]);
  }
  assert.deepEqual(usedOnly({ given: [], seed: "abc", section: "", use: true }, false, "2026-11-13T00:00:00.000Z").state, "seeded");
});

test("a followed-up run's impact figures: the first round's job cost, every round's look-back and grade", async () => {
  const kept = (round, row) => ({ runId: "r", round, agentId: "a", turn: {}, proposal: row, learningRunId: `r-learning-${round}`, createdAt: 0 });
  const rounds = [
    kept(1, { answered_at: "2026-11-13T00:00:00.000Z", job_cost_usd: 0.5, look_back_usd: 0.1 }),
    kept(2, { answered_at: "2026-11-13T01:00:00.000Z", job_cost_usd: 0.9, look_back_usd: 0.2 }),
  ];
  const store = {
    learning: { proposal: async (_id, round) => (round === undefined ? rounds[1] : rounds[round - 1]) },
    runs: { get: async (id) => ({ state: "ended", costUsd: id.endsWith("1") ? 0.01 : 0.02 }) },
  };
  const spend = await roundsSpendOf(store, "r");
  assert.equal(spend.answered_at, "2026-11-13T00:00:00.000Z");
  assert.equal(spend.job_cost_usd, 0.5);
  assert.ok(Math.abs(spend.look_back_usd - 0.3) < 1e-9);
  assert.ok(Math.abs(spend.grade_usd - 0.03) < 1e-9);
  assert.equal(await roundsSpendOf({ ...store, learning: { proposal: async () => rounds[0] } }, "r"), undefined, "one round: nothing to add up");
});

test("a later round stopped in its model request: the run's cost is unknown, and so is its learning spend, never the earlier rounds' sum (#2648 review)", async () => {
  const kept = (round, row, learningRunId) => ({ runId: "r", round, agentId: "a", turn: {}, proposal: row, ...(learningRunId ? { learningRunId } : {}), createdAt: 0 });
  // Round 2 was stopped mid-request: its proposal dropped with no figures, and the run's row cost reads unknown (null).
  const rounds = [kept(1, { answered_at: "2026-11-13T00:00:00.000Z", job_cost_usd: 0.5, look_back_usd: 0.1 }, "r-learning-1"), kept(2, { state: "dropped" })];
  const store = {
    learning: { proposal: async (_id, round) => (round === undefined ? rounds[1] : rounds[round - 1]) },
    runs: { get: async () => ({ state: "ended", costUsd: 0.01 }) },
  };
  const spend = await roundsSpendOf(store, "r");
  const looked = roundsLooked(spend, null);
  assert.equal(looked.job_cost_usd, 0.5, "the job's own cost is known: it answered before the unknown request");
  assert.equal(looked.look_back_usd, null, "what the row spent after the job is unknown");
  assert.deepEqual(runCostOf(null, looked, spend.grade_usd), { cost_usd: 0.5, learning_usd: null, total_usd: null });
  // A known row still reads its learning as the row less the job.
  assert.ok(Math.abs(roundsLooked(spend, 0.75).look_back_usd - 0.25) < 1e-9);
  // A job whose own cost is unknown leaves the rounds' look-backs added up, as before.
  assert.ok(Math.abs(roundsLooked({ ...spend, job_cost_usd: null }, null).look_back_usd - 0.1) < 1e-9);
});
