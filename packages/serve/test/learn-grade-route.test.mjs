// A run's grade and an agent's promotion records over the API (learn/promote.ts): PUT /runs/{id}/grade on an ended run
// keeps {correct, expected?, source} with the path it took, a newer grade replacing the older (a label on a run that
// does not learn asks no feedback round: `feedback` null); a run under way, a bad
// body or an unknown run is refused. GET /agents/{id}/learning/promotions lists the records, none before any replay.
import assert from "node:assert/strict";
import { test } from "node:test";
import { started } from "./learn-support.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { agent, follow, serve, withEnv } from "./support.mjs";

test("a person grades an ended run; the agent's promotions read empty until a learned workflow is replayed", async (t) => {
  const { api, baseUrl } = await serve(t);
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const meets = (path, method, value) => assert.deepEqual(schemaProblems(doc, doc.paths[path][method].responses["200"].content["application/json"].schema, value), [], `${path}: ${JSON.stringify(value)}`);
  assert.equal((await api("POST", "/agents", agent("grader"))).status, 201);
  const run = await started(api, "grader");
  await follow(api, run, ["completed"]);

  const graded = await api("PUT", `/runs/${run}/grade`, { correct: true, expected: { mcc: "5812" }, source: "eval" });
  assert.equal(graded.status, 200, JSON.stringify(graded.body));
  assert.deepEqual({ ...graded.body, graded_at: typeof graded.body.graded_at }, { run_id: run, correct: true, expected: { mcc: "5812" }, source: "eval", graded_at: "string", path: "agent", workflow: null, workflow_digest: null, feedback: null });
  meets("/runs/{run_id}/grade", "put", graded.body);
  const again = await api("PUT", `/runs/${run}/grade`, { correct: false });
  assert.deepEqual([again.status, again.body.correct, again.body.source, "expected" in again.body], [200, false, "feedback", false], "a newer grade replaces the older; source defaults to feedback");

  // A label on a run that does not learn is kept with nothing more: no feedback round.
  const labelled = await api("PUT", `/runs/${run}/grade`, { correct: false, label: "Review: the reference MCC is 5812." });
  assert.deepEqual([labelled.status, labelled.body.feedback], [200, null], JSON.stringify(labelled.body));
  meets("/runs/{run_id}/grade", "put", labelled.body);
  for (const [body, field] of [[{}, "correct"], [{ correct: "yes" }, "correct"], [{ correct: true, expected: "5812" }, "expected"], [{ correct: true, source: "vibes" }, "source"], [{ correct: true, score: 1 }, "score"], [{ correct: true, label: 5 }, "label"], [{ correct: true, label: "x".repeat(4001) }, "label"]]) {
    const bad = await api("PUT", `/runs/${run}/grade`, body);
    assert.equal(bad.status, 422, JSON.stringify(body));
    assert.ok(bad.body.error.fields.some((one) => one.field === field), JSON.stringify(bad.body.error.fields));
  }
  assert.equal((await api("PUT", "/runs/nope/grade", { correct: true })).status, 404);

  const promotions = await api("GET", "/agents/grader/learning/promotions");
  assert.deepEqual([promotions.status, promotions.body], [200, { agent: "grader", promotions: [], serving: [] }]);
  meets("/agents/{agent_id}/learning/promotions", "get", promotions.body);
  assert.equal((await api("GET", "/agents/nobody/learning/promotions")).status, 404);
});

// Review on #2644 (round 4, security): every text of a promotion record the route returns is cut of the host's secrets as
// the other learning reads cut them, its reason and each refit guard's label as well as its workflow's name.
test("the promotions list cuts a known secret from every text of a record: its workflow, its reason, a refit guard's label", async (t) => {
  const value = ["promo", "pass", process.pid, Date.now().toString(36)].join("-");
  withEnv(t, { PROMO_TEST_TOKEN: value });
  const { api, store } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("promoted"))).status, 201);
  const record = { workflow: `answer-${value}`, digest: "d2", at: "2026-11-14T00:00:00.000Z", decided: "promote", source: "refit", reason: `refit of answer-${value}: lowered guard check-${value}`, refit: { from: "d1", guards: [{ node: `check-${value}`, was: 0.5, threshold: 0.3 }] } };
  await store.settings.put("learning.promotions.promoted", { v: 1, items: [record] });
  const read = await api("GET", "/agents/promoted/learning/promotions");
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.promotions.length, 1);
  assert.ok(!JSON.stringify(read.body).includes(value), `the secret shows: ${JSON.stringify(read.body)}`);
  assert.deepEqual([read.body.promotions[0].workflow, read.body.serving[0].workflow], ["[redacted]", "[redacted]"]);
  assert.equal(read.body.promotions[0].refit.guards[0].threshold, 0.3, "numbers are kept");
});
