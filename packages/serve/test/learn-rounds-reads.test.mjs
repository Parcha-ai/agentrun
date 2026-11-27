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

test("a later round stopped in its model request: the run's cost is unknown, and so is its job's, never the first round's figure (#2648 review)", async () => {
  const kept = (round, row) => ({ runId: "r", round, agentId: "a", turn: null, proposal: row, createdAt: 0 });
  // Round 2 was stopped mid-request: its proposal dropped with no figures, and the run's row cost reads unknown (null).
  const rounds = [kept(1, { answered_at: "2026-11-13T00:00:00.000Z", job_cost_usd: 0.5, look_back_usd: 0.1 }), kept(2, { state: "dropped" })];
  const store = {
    learning: { proposal: async (_id, round) => (round === undefined ? rounds[1] : rounds[round - 1]) },
    runs: { get: async () => ({ state: "ended", costUsd: 0.01 }) },
  };
  const spend = await roundsSpendOf(store, "r");
  const looked = roundsLooked(spend, null);
  assert.equal(looked.job_cost_usd, null, "the job holds the follow-up's turns, whose cost is unknown");
  assert.ok(Math.abs(looked.look_back_usd - 0.1) < 1e-9, "the look-backs kept: round 2 asked none");
  assert.deepEqual(runCostOf(null, rounds), { cost_usd: null, learning_usd: 0.1, total_usd: null });
  // A known row reads its job as the row less the look-backs.
  assert.ok(Math.abs(roundsLooked(spend, 0.75).job_cost_usd - 0.65) < 1e-9);
  // A look-back whose cost is unknown leaves the job unknown too: the two can't be told apart.
  assert.equal(roundsLooked({ ...spend, look_back_usd: null }, 0.75).job_cost_usd, null);
});

test("a followed-up run's cost per run: its follow-up turn is its job's, every round's look-back its learning", async () => {
  const kept = (round, row) => ({ runId: "r", round, agentId: "a", turn: null, proposal: row, createdAt: 0 });
  const rounds = [
    kept(1, { answered_at: "2026-11-13T00:00:00.000Z", job_cost_usd: 0.5, look_back_usd: 0.1 }),
    kept(2, { answered_at: "2026-11-13T01:00:00.000Z", job_cost_usd: 0.9, look_back_usd: 0.2 }),
  ];
  // The run's row: the job 0.5, both look-backs 0.3, a follow-up turn 0.4 (more of the job the person asked for).
  const looked = lookedOf(rounds.map((one) => one.proposal), 1.2);
  assert.ok(Math.abs(looked.job_cost_usd - 0.9) < 1e-9, "the job and its follow-up turn: the row less the look-backs");
  assert.ok(Math.abs(looked.look_back_usd - 0.3) < 1e-9, "every round's look-back");
  const cost = runCostOf(1.2, rounds);
  assert.deepEqual([cost.cost_usd, cost.learning_usd, cost.total_usd].map((usd) => Math.round(usd * 1e6)), [900000, 300000, 1200000]);
  assert.deepEqual(lookedOf([rounds[0].proposal], 0.6), { answered_at: "2026-11-13T00:00:00.000Z", job_cost_usd: 0.5, look_back_usd: 0.1 }, "one round reads its own figures");
});
