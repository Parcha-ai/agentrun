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

// A refit that switched an escalate and a guard off, and a hold for never answering alone, as the route answers them: the
// closed schema takes a refit guard with no threshold, and an escalate's. A replay keeps no `alone` (a reader counts it,
// n - handed_back), so a record stored before any replay said one reads through the route as it was kept, in the schema.
test("the promotions list answers a refit's switched-off escalate and guard, and a record kept before `alone`, in its closed schema", async (t) => {
  const { api, store, baseUrl } = await serve(t);
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const schema = doc.paths["/agents/{agent_id}/learning/promotions"].get.responses["200"].content["application/json"].schema;
  assert.equal((await api("POST", "/agents", agent("switched"))).status, 201);
  const replay = { n: 6, agree: 0, agent_acc: 1, wf_acc: 1, delta: 0, handed_back: 6, of: ["g-0"] };
  const held = { workflow: "answer", digest: "d1", at: "2026-11-14T00:00:00.000Z", decided: "hold", source: "replay", reason: "it handed back every one of its 6 replayed inputs: it would never answer alone", replay };
  const refit = { workflow: "answer", digest: "d2", at: "2026-11-14T00:00:01.000Z", decided: "promote", source: "refit", reason: "refit answer's guards: unsupported escalate off, read guard off", replay: { ...replay, handed_back: 0 }, refit: { from: "d1", guards: [{ node: "read", was: 0.7, threshold: null }, { node: "unsupported", was: null, threshold: null, escalate: true }] } };
  // Kept before #2815, as `learning.promotions.<agent>` holds it today: a replay of {n, agree, accuracies, delta, handed_back, of}.
  const old = { workflow: "answer", digest: "d0", at: "2026-11-13T00:00:00.000Z", decided: "promote", source: "replay", reason: "replayed on 18 graded inputs: within 2 pts", replay: { n: 18, agree: 14, agent_acc: 0.9, wf_acc: 0.9, delta: 0, handed_back: 3, of: Array.from({ length: 20 }, (_, i) => `g-${i}`) } };
  await store.settings.put("learning.promotions.switched", { v: 1, items: [old, held, refit] });
  const read = await api("GET", "/agents/switched/learning/promotions");
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(schemaProblems(doc, schema, read.body), [], JSON.stringify(read.body));
  assert.deepEqual(read.body.promotions[0].replay, old.replay, "the old record reads as it was kept");
  assert.ok(read.body.promotions.every((one) => !("alone" in one.replay)), JSON.stringify(read.body.promotions));
  assert.deepEqual(read.body.promotions[2].refit.guards, refit.refit.guards);
  // The schema still closes a replay: a field it does not name is refused.
  const extra = structuredClone(read.body);
  extra.promotions[0].replay.alone = 15;
  assert.notDeepEqual(schemaProblems(doc, schema, extra), []);
});
