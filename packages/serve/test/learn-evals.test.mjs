// An agent's eval records (POST and GET /v2/agents/{id}/learning/evals): a held-out test's counts as posted (n jobs,
// `correct` of them right, the cost a task with learning and by hand), the server's accuracy and 95% Wilson interval
// from those counts (a caller never sends either), append-only with the latest first, the latest 20 kept; a bad count
// is 422 by field and nothing is kept; a retry under one Idempotency-Key is kept once. Aggregates only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EVALS_KEPT, evalOf, wilsonOf } from "../dist/learning-evals.js";
import { agent, serve } from "./support.mjs";

const RECORD = {
  name: "invoice bench, sealed test",
  label_source: "teacher labels, 87% strict vs people",
  n: 200,
  correct: 188,
  cost_per_task_usd: 0.12,
  baseline_cost_per_task_usd: 0.89,
  learned_revision: "a1b2c3d4e5",
};

test("the 95% Wilson interval from n and correct: inside 0 to 1 at both ends, and the textbook figures", () => {
  assert.deepEqual(wilsonOf(10, 8), [0.4902, 0.9433], "8 of 10");
  assert.deepEqual(wilsonOf(10, 0), [0, 0.2775], "none right: from 0, never below");
  assert.deepEqual(wilsonOf(10, 10), [0.7225, 1], "all right: up to 1, never above");
  assert.deepEqual(wilsonOf(200, 188), [0.8981, 0.9653], "188 of 200");
  assert.deepEqual(wilsonOf(1, 1), [0.2065, 1], "one job says little");
});

test("a record's counts are checked: whole n from 1, correct from 0 to n, costs 0 or more or left out; a caller never sends an accuracy or an interval", () => {
  const now = new Date("2026-11-13T05:00:00Z");
  const kept = evalOf(RECORD, now);
  assert.match(kept.id, /^eval_/);
  assert.deepEqual({ ...kept, id: undefined }, { ...RECORD, id: undefined, accuracy: 0.94, ci: [0.8981, 0.9653], recorded_at: "2026-11-13T05:00:00.000Z" });
  const bare = evalOf({ name: "s", n: 1, correct: 0 }, now);
  assert.deepEqual([bare.label_source, bare.cost_per_task_usd, bare.baseline_cost_per_task_usd, bare.learned_revision], [null, null, null, null], "label source, costs and revision are optional");
  const fields = (body) => {
    try {
      evalOf(body, now);
    } catch (error) {
      return error.extra.fields.map((f) => f.field);
    }
    return [];
  };
  assert.deepEqual(fields({ ...RECORD, correct: 201 }), ["correct"], "correct over n");
  assert.deepEqual(fields({ ...RECORD, n: 0, correct: 0 }), ["n"], "no jobs");
  assert.deepEqual(fields({ ...RECORD, correct: -1 }), ["correct"], "a negative count");
  assert.deepEqual(fields({ ...RECORD, n: 2.5 }), ["n"], "a part of a job");
  assert.deepEqual(fields({ ...RECORD, n: "200" }), ["n"], "a count is a number");
  assert.deepEqual(fields({ ...RECORD, accuracy: 0.94, ci: [0.9, 0.97] }), ["accuracy", "ci"], "the server computes them");
  assert.deepEqual(fields({ ...RECORD, cost_per_task_usd: -1, baseline_cost_per_task_usd: "free" }), ["cost_per_task_usd", "baseline_cost_per_task_usd"]);
  assert.deepEqual(fields({ ...RECORD, name: "two\nlines", label_source: "x".repeat(500), learned_revision: "main" }), ["name", "label_source", "learned_revision"]);
  assert.deepEqual(fields({ ...RECORD, rows: [] }), ["rows"], "aggregates only: no rows");
});

test("POST /agents/{id}/learning/evals appends a record, GET answers the latest and the list newest first, the latest 20; a bad one is 422 and nothing is kept", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, {});
  const id = "eval-kept";
  assert.equal((await api("POST", "/agents", agent(id))).status, 201);
  assert.deepEqual((await api("GET", `/agents/${id}/learning/evals`)).body, { agent: id, latest: null, evals: [] }, "none recorded: none shown, never one from its runs");

  const made = await api("POST", `/agents/${id}/learning/evals`, RECORD, { "idempotency-key": "k1" });
  assert.equal(made.status, 201);
  assert.deepEqual([made.body.accuracy, made.body.ci], [0.94, [0.8981, 0.9653]], "the server's figures from the counts");
  const again = await api("POST", `/agents/${id}/learning/evals`, RECORD, { "idempotency-key": "k1" });
  assert.equal(again.body.id, made.body.id, "a retry answers the first record");
  const one = (await api("GET", `/agents/${id}/learning/evals`)).body;
  assert.equal(one.evals.length, 1, "kept once");
  assert.deepEqual(one.latest, one.evals[0]);

  const bad = await api("POST", `/agents/${id}/learning/evals`, { ...RECORD, correct: 300 });
  assert.equal(bad.status, 422);
  assert.deepEqual(bad.body.error.fields.map((f) => f.field), ["correct"]);

  for (let i = 0; i < EVALS_KEPT + 2; i++) assert.equal((await api("POST", `/agents/${id}/learning/evals`, { ...RECORD, n: 1000 + i, correct: 900 })).status, 201);
  const { latest, evals } = (await api("GET", `/agents/${id}/learning/evals`)).body;
  assert.equal(evals.length, EVALS_KEPT);
  assert.deepEqual([latest.n, evals[0].n, evals.at(-1).n], [1000 + EVALS_KEPT + 1, 1000 + EVALS_KEPT + 1, 1002], "the latest wins; the oldest dropped");

  assert.equal((await api("GET", "/agents/nobody/learning/evals")).status, 404);
  assert.equal((await api("POST", "/agents/nobody/learning/evals", RECORD)).status, 404);
});
