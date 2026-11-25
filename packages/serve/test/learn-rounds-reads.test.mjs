// Reads over a run a follow-up opened again: a run that only uses learning shows the seed that failed (usedOnly), and the
// impact's figures hold the job's own cost from its first round and every round's look-back (roundsSpendOf).
import assert from "node:assert/strict";
import { test } from "node:test";
import { roundsSpendOf, usedOnly } from "../dist/store-reads/learning.js";
import { figuresOf, lookedOf, record, roundsLooked } from "../dist/learn/ledger.js";

/** A run's series figures as its ledger row gives them (learn/ledger.ts record, figuresOf): its row's cost `costUsd` and
 *  the rounds it kept. */
const runCostOf = (costUsd, rounds) => {
  const { row } = record({ id: "r", agentId: "a", startedAt: 0, costUsd, costAtMostUsd: null, metrics: { path: "agent" }, rounds: rounds.map(({ round, proposal }) => ({ round, proposal })) });
  const figures = figuresOf(row, { compile: 0, shadow: 0, share: 0 });
  return { cost_usd: figures.usd, learning_usd: figures.series_learning_usd, total_usd: figures.series_total_usd };
};

test("a run that only uses learning shows a seed that failed, from its start", () => {
  const started = { seed: null, section: "", seedFailed: "unreadable", use: true };
  for (const terminal of [false, true]) {
    const end = usedOnly(started, terminal, "2026-11-13T00:00:00.000Z");
    assert.deepEqual([end.state, end.reason], ["dropped", "seed_failed"]);
  }
  assert.deepEqual(usedOnly({ seed: "abc", section: "", use: true }, false, "2026-11-13T00:00:00.000Z").state, "seeded");
});

test("a followed-up run's impact figures: the first round's job cost, every round's look-back", async () => {
  const kept = (round, row) => ({ runId: "r", round, agentId: "a", turn: null, proposal: row, createdAt: 0 });
  const rounds = [
    kept(1, { answered_at: "2026-11-13T00:00:00.000Z", job_cost_usd: 0.5, look_back_usd: 0.1 }),
    kept(2, { answered_at: "2026-11-13T01:00:00.000Z", job_cost_usd: 0.9, look_back_usd: 0.2 }),
  ];
  const store = {
    learning: { proposal: async (_id, round) => (round === undefined ? rounds[1] : rounds[round - 1]) },
    runs: { get: async () => ({ state: "ended", costUsd: 0.01 }) },
  };
  const spend = await roundsSpendOf(store, "r");
  assert.equal(spend.answered_at, "2026-11-13T00:00:00.000Z");
  assert.equal(spend.job_cost_usd, 0.5);
  assert.ok(Math.abs(spend.look_back_usd - 0.3) < 1e-9);
  assert.equal(await roundsSpendOf({ ...store, learning: { proposal: async () => rounds[0] } }, "r"), undefined, "one round: nothing to add up");
});

test("a later round stopped in its model request: the run's cost is unknown, and so is its learning spend, never the earlier rounds' sum (#2648 review)", async () => {
  const kept = (round, row) => ({ runId: "r", round, agentId: "a", turn: null, proposal: row, createdAt: 0 });
  // Round 2 was stopped mid-request: its proposal dropped with no figures, and the run's row cost reads unknown (null).
  const rounds = [kept(1, { answered_at: "2026-11-13T00:00:00.000Z", job_cost_usd: 0.5, look_back_usd: 0.1 }), kept(2, { state: "dropped" })];
  const store = {
    learning: { proposal: async (_id, round) => (round === undefined ? rounds[1] : rounds[round - 1]) },
    runs: { get: async () => ({ state: "ended", costUsd: 0.01 }) },
  };
  const spend = await roundsSpendOf(store, "r");
  const looked = roundsLooked(spend, null);
  assert.equal(looked.job_cost_usd, 0.5, "the job's own cost is known: it answered before the unknown request");
  assert.equal(looked.look_back_usd, null, "what the row spent after the job is unknown");
  assert.deepEqual(runCostOf(null, rounds), { cost_usd: 0.5, learning_usd: null, total_usd: null });
  // A known row still reads its learning as the row less the job.
  assert.ok(Math.abs(roundsLooked(spend, 0.75).look_back_usd - 0.25) < 1e-9);
  // A job whose own cost is unknown leaves the rounds' look-backs added up, as before.
  assert.ok(Math.abs(roundsLooked({ ...spend, job_cost_usd: null }, null).look_back_usd - 0.1) < 1e-9);
});

test("a followed-up run's cost per run: every round's look-back and follow-up turn are its learning, the first round's job figure its job", async () => {
  const kept = (round, row) => ({ runId: "r", round, agentId: "a", turn: null, proposal: row, createdAt: 0 });
  const rounds = [
    kept(1, { answered_at: "2026-11-13T00:00:00.000Z", job_cost_usd: 0.5, look_back_usd: 0.1 }),
    kept(2, { answered_at: "2026-11-13T01:00:00.000Z", job_cost_usd: 0.9, look_back_usd: 0.2 }),
  ];
  // The run's row: the job 0.5, both look-backs 0.3, a follow-up turn 0.4 (feedback the run was given: learning, #2648).
  const looked = lookedOf(rounds.map((one) => one.proposal), 1.2);
  assert.equal(looked.job_cost_usd, 0.5, "the job's figure is the first round's: round 2's holds round 1's look-back");
  assert.ok(Math.abs(looked.look_back_usd - 0.7) < 1e-9, "every round's look-back and the follow-up turn: the row less the job");
  const cost = runCostOf(1.2, rounds);
  assert.deepEqual([cost.cost_usd, cost.learning_usd, cost.total_usd], [0.5, 0.7, 1.2]);
  assert.deepEqual(lookedOf([rounds[0].proposal], 0.6), { answered_at: "2026-11-13T00:00:00.000Z", job_cost_usd: 0.5, look_back_usd: 0.1 }, "one round reads its own figures");
});
