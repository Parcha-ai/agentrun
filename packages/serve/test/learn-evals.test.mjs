// An agent's recorded held-out tests (POST and GET /v2/agents/{id}/learning/evals): only what was posted, newest first,
// the latest 20; each field checked (422 by field, nothing kept); a retry under one Idempotency-Key kept once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EVALS_KEPT, evalOf } from "../dist/learning-evals.js";
import { agent, serve } from "./support.mjs";

const RESULT = {
  source: "invoice bench, sealed test",
  n: 200,
  learned: { accuracy: 0.94, ci: [0.9, 0.97], usd_per_job: 0.12 },
  by_hand: { accuracy: 0.81, ci: [0.75, 0.86], usd_per_job: 0.89 },
  learned_revision: "a1b2c3d4e5",
  measured_at: "2026-11-13T04:00:00Z",
};

test("a held-out result is checked field by field: shares from 0 to 1, an interval that holds its accuracy, whole jobs, one line of source", () => {
  const now = new Date("2026-11-13T05:00:00Z");
  const kept = evalOf(RESULT, now);
  assert.match(kept.id, /^eval_/);
  assert.deepEqual({ ...kept, id: undefined }, { ...RESULT, id: undefined, measured_at: "2026-11-13T04:00:00.000Z", recorded_at: "2026-11-13T05:00:00.000Z" });
  const bare = evalOf({ source: "s", n: 1, learned: { accuracy: 1, ci: [1, 1] }, by_hand: { accuracy: 0, ci: [0, 0] } }, now);
  assert.deepEqual([bare.learned.usd_per_job, bare.learned_revision, bare.measured_at], [null, null, now.toISOString()], "cost, revision and time are optional");
  const fields = (body) => {
    try {
      evalOf(body, now);
    } catch (error) {
      return error.extra.fields.map((f) => f.field);
    }
    return [];
  };
  assert.deepEqual(fields({ ...RESULT, n: 0, source: "two\nlines" }), ["source", "n"]);
  assert.deepEqual(fields({ ...RESULT, learned: { accuracy: 0.94, ci: [0.95, 0.97] } }), ["learned.ci"], "the interval holds the accuracy");
  assert.deepEqual(fields({ ...RESULT, by_hand: { accuracy: 1.2, ci: [0, 1], usd_per_job: -1 } }), ["by_hand.accuracy", "by_hand.usd_per_job"]);
  assert.deepEqual(fields({ ...RESULT, stream: true, learned_revision: "main", measured_at: "yesterday" }), ["stream", "learned_revision", "measured_at"]);
  assert.deepEqual(fields({ ...RESULT, learned: undefined }), ["learned"]);
});

test("POST /agents/{id}/learning/evals keeps a result, GET lists them newest first, the latest 20; a bad one is 422 and nothing is kept", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, {});
  const id = "eval-kept";
  assert.equal((await api("POST", "/agents", agent(id))).status, 201);
  assert.deepEqual((await api("GET", `/agents/${id}/learning/evals`)).body, { agent: id, evals: [] }, "none recorded: none shown, never one from its runs");

  const made = await api("POST", `/agents/${id}/learning/evals`, RESULT, { "idempotency-key": "k1" });
  assert.equal(made.status, 201);
  assert.equal(made.body.n, 200);
  const again = await api("POST", `/agents/${id}/learning/evals`, RESULT, { "idempotency-key": "k1" });
  assert.equal(again.body.id, made.body.id, "a retry answers the first result");
  assert.equal((await api("GET", `/agents/${id}/learning/evals`)).body.evals.length, 1, "kept once");

  const bad = await api("POST", `/agents/${id}/learning/evals`, { ...RESULT, n: -3 });
  assert.equal(bad.status, 422);
  assert.deepEqual(bad.body.error.fields.map((f) => f.field), ["n"]);

  for (let i = 0; i < EVALS_KEPT + 2; i++) assert.equal((await api("POST", `/agents/${id}/learning/evals`, { ...RESULT, n: 1000 + i })).status, 201);
  const { evals } = (await api("GET", `/agents/${id}/learning/evals`)).body;
  assert.equal(evals.length, EVALS_KEPT);
  assert.deepEqual([evals[0].n, evals.at(-1).n], [1000 + EVALS_KEPT + 1, 1002], "newest first, the oldest dropped");

  assert.equal((await api("GET", "/agents/nobody/learning/evals")).status, 404);
  assert.equal((await api("POST", "/agents/nobody/learning/evals", RESULT)).status, 404);
});
