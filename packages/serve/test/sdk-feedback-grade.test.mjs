import assert from "node:assert/strict";
import { test } from "node:test";
import { serve, client, follow } from "./support.mjs";
import { gradesOf } from "../dist/learn/promote.js";

// A completed SDK task belongs to its application. A retained grade must not reopen it onto a managed feedback
// steer that the SDK loop cannot consume, or change its settled execution and learning beyond the grade readback.
for (const runtime of ["claude-agent-sdk", "codex-sdk"]) test(`${runtime} retains grades without reopening SDK execution`, async t => {
  const server = await serve(t);
  const { api, store } = server, id = "sdk-feedback";
  const created = await api("POST", "/agents", { definition: { id, name: id, instructions: "Retain the application policy.", sdk: { runtime }, learning: true, tools: [] } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const started = await api("POST", `/agents/${id}/sdk-runs`, { runtime, input: "Remember: begin every answer with Verified. Report release status.", instructions: "Retain application-owned execution." }, { "Idempotency-Key": "feedback" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const runId = started.body.run_id, sdk = client(server.baseUrl, started.body.token), path = `/sdk-runs/${runId}`;
  const completion = { status: "completed", answer: "Verified: ready", usage: { cost_usd: 0.25, input_tokens: 20, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 } };
  assert.equal((await sdk("POST", `${path}/complete`, completion)).status, 200);
  await follow(api, runId, ["completed"]);
  let receipt;
  for (let n = 0; n < 200; n++) {
    receipt = (await sdk("GET", path)).body;
    if (["merged", "dropped"].includes(receipt.learning?.state)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(receipt.state, "completed");
  // No owner words and no compile due: the first round keeps nothing, settled before the grade.
  assert.equal(receipt.learning.state, "dropped", JSON.stringify(receipt));
  const before = await store.runs.get(runId), firstRound = await store.learning.proposal(runId, 1);
  const graded = await api("PUT", `/runs/${runId}/grade`, { correct: false, label: "Retain this reviewer feedback without starting another SDK task." });
  assert.equal(graded.status, 200, JSON.stringify(graded.body));
  assert.equal(graded.body.feedback, null, "the application SDK has no managed feedback consumer");
  assert.equal((await gradesOf(store.learning, id)).find(grade => grade.run === runId)?.correct, false, "the grade remains durable evidence");
  const after = await store.runs.get(runId);
  assert.deepEqual([after.state, after.endedAt, after.costUsd, after.metrics], [before.state, before.endedAt, before.costUsd, before.metrics]);
  const reread = (await sdk("GET", path)).body;
  const { graded: retainedGrade, ...learning } = reread.learning;
  assert.deepEqual(retainedGrade, { ...graded.body, feedback_status: null }, "the retained grade opens no feedback round");
  assert.deepEqual({ ...reread, learning }, receipt, "the scoped completion and settled learning receipt stay unchanged apart from grade readback");
  assert.deepEqual(await store.learning.proposal(runId, 1), firstRound);
  assert.equal(await store.learning.proposal(runId, 2), undefined, "no stranded extra learning round");
  assert.equal((await sdk("POST", `${path}/events`, { sequence: 1, events: [] })).status, 409, "grading does not admit late application evidence");
  assert.equal((await sdk("POST", `${path}/complete`, completion)).status, 200, "original completion remains idempotent");
});
