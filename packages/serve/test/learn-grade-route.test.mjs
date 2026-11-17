// A run's grade and an agent's promotion records over the API (learn/promote.ts): PUT /runs/{id}/grade on an ended run
// keeps {correct, expected?, source} with the path it took, a newer grade replacing the older (a label on a run that
// does not learn asks no feedback round: `feedback` null); a run under way, a bad
// body or an unknown run is refused. GET /agents/{id}/learning/promotions lists the records, none before any replay.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ended, LEARN, learner, made, started } from "./learn-support.mjs";
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

// The console's Grade control reads a run's grade back from GET /runs/{id}/learning (`graded`): absent before one, then
// the newest, a later grade replacing it, in the PUT's answer's shape without `expected`. A wrong grade with words on a
// run the agent finished opens a correction round, and the read keeps which (`feedback`), so a page read again still says
// it, and how that round stands (`feedback_status`).
test("a run's learning read says its grade and the round it opened: none before one, then the newest, never its expected", async (t) => {
  const { api, baseUrl } = await serve(t, { learning: "on", faux: LEARN });
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const meets = (value) => assert.deepEqual(schemaProblems(doc, doc.paths["/runs/{run_id}/learning"].get.responses["200"].content["application/json"].schema, value), [], JSON.stringify(value));
  await made(api, learner("graded-read"));
  const run = await started(api, "graded-read", "What is 6 times 7?");
  await ended(api, run);
  const before = await api("GET", `/runs/${run}/learning`);
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.ok(!("graded" in before.body), JSON.stringify(before.body));
  meets(before.body);

  const right = await api("PUT", `/runs/${run}/grade`, { correct: true, expected: { answer: 42 } });
  assert.deepEqual([right.status, right.body.feedback], [200, null], "a right grade with no words asks nothing more");
  const read = (await api("GET", `/runs/${run}/learning`)).body;
  const { expected: _, ...rightShown } = right.body;
  assert.deepEqual(read.graded, { ...rightShown, feedback_status: null }, "the PUT's answer, without expected");
  assert.deepEqual([read.graded.feedback, "expected" in read.graded], [null, false], "a right grade opened no round");
  meets(read);

  const wrong = await api("PUT", `/runs/${run}/grade`, { correct: false, label: "Review: the answer is 42, said as a number." });
  assert.deepEqual([wrong.status, wrong.body.feedback], [200, "correction"], JSON.stringify(wrong.body));
  await ended(api, run);
  const again = (await api("GET", `/runs/${run}/learning`)).body;
  assert.deepEqual(again.graded, { ...wrong.body, feedback_status: "ended" }, "the newer grade replaces the older, its round read ended");
  assert.equal(again.graded.feedback, "correction", "after the round ended, the read still says the grade opened a correction round");
  assert.deepEqual([again.state, again.corrections], ["merged", 1], `the round kept the reviewer's words as a correction: ${JSON.stringify(again)}`);
  meets(again);
});

// Review on #2644 (round 4, security): every text of a promotion record the route returns is cut of the host's secrets as
// the other learning reads cut them, its reason and a check's disagreement text as well as its workflow's name.
test("the promotions list cuts a known secret from every text of a record: its workflow, its reason, a check's disagreement", async (t) => {
  const value = ["promo", "pass", process.pid, Date.now().toString(36)].join("-");
  withEnv(t, { PROMO_TEST_TOKEN: value });
  const { api, store } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("promoted"))).status, 201);
  const record = { workflow: `answer-${value}`, digest: "d2", at: "2026-11-14T00:00:00.000Z", decided: "hold", reason: `check of answer-${value}: held, it disagreed on check-${value}`, check: { compile_after: 20, agree_min: 0.9, alone_min: 0.5, attempt: 1, n: 4, agreed: 1, alone: 2, of: ["g-0"], disagreements: [{ run: "g-0", input: `ask ${value}`, agent: "no" }] } };
  await store.settings.put("learning.promotions.promoted", { v: 1, items: [record] });
  const read = await api("GET", "/agents/promoted/learning/promotions");
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.promotions.length, 1);
  assert.ok(!JSON.stringify(read.body).includes(value), `the secret shows: ${JSON.stringify(read.body)}`);
  assert.deepEqual([read.body.promotions[0].workflow, read.body.serving[0].workflow], ["[redacted]", "[redacted]"]);
  assert.equal(read.body.promotions[0].check.alone, 2, "numbers are kept");
});

// A hold for never answering alone, a promote on its dry run and a replaying record, as the route answers them, in the
// closed schema of the check-only record.
test("the promotions list answers a hold, a promote on its dry run and a replaying record in its closed schema, and refuses a field it does not name", async (t) => {
  const { api, store, baseUrl } = await serve(t);
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const schema = doc.paths["/agents/{agent_id}/learning/promotions"].get.responses["200"].content["application/json"].schema;
  assert.equal((await api("POST", "/agents", agent("switched"))).status, 201);
  const bar = { compile_after: 20, agree_min: 0.9, alone_min: 0.5, attempt: 1 };
  const dry = { workflow: "answer", digest: "d0", at: "2026-11-13T00:00:00.000Z", decided: "promote", reason: "nothing to replay on: promoted on its passing dry run", check: { ...bar, n: 0, agreed: 0, alone: 0, of: [] } };
  const held = { workflow: "answer", digest: "d1", at: "2026-11-14T00:00:00.000Z", decided: "hold", reason: "it handed back every one of its 6 replayed inputs: it would never answer alone", check: { ...bar, n: 6, agreed: 0, alone: 0, of: ["g-0"], stopped: true } };
  const replaying = { workflow: "answer", digest: "d2", at: "2026-11-14T00:00:01.000Z", decided: "replaying", reason: "its check is replaying", check: bar, runs: ["r-1"], inputs: ["g-0"], replay_id: "rp-1" };
  await store.settings.put("learning.promotions.switched", { v: 1, items: [dry, held, replaying] });
  const read = await api("GET", "/agents/switched/learning/promotions");
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(schemaProblems(doc, schema, read.body), [], JSON.stringify(read.body));
  assert.deepEqual(read.body.promotions.map((one) => one.decided), ["promote", "hold", "replaying"]);
  assert.deepEqual(read.body.promotions[1].check, held.check);
  assert.deepEqual(read.body.serving, [{ workflow: "answer", digest: "d0", replaying: "d2" }]);
  // The schema closes a record: a field it does not name is refused.
  const extra = structuredClone(read.body);
  extra.promotions[0].source = "replay";
  assert.notDeepEqual(schemaProblems(doc, schema, extra), []);
});
