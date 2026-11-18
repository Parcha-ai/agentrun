// The shadow audit over HTTP v2, API first: what an owner reads of the runs a promoted learned workflow serves and of
// their audits, with nothing console-only. A served run (answered by the workflow alone, or handed back to the agent)
// reads like any run: its answer text in GET /runs/{id}, its timeline in the documented row kinds, its path, its cost.usd
// its own requests (its hand-back's among them), its shadow's (when it has one: only a run the workflow answered is
// drawn) on cost.learning_usd and both in cost.all_in_usd. The shadow reads as the audit of its run (`audit_of`), is no
// row of the owner's run lists and sends no webhook (w): a host never sees it but as the run's learning_usd. The
// workflow's state (serving, checking, held, stopped), its check's numbers and its audit
// line are in GET /agents/{id}/learning/promotions; the rows are GET /agents/{id}/learning/audits. And (f): an owner's
// grade on a served run is a row of the same ledger (source grade, agreed = the grade), opening no round and asking no
// compile by itself.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { agentFolderOf } from "../dist/files.js";
import { shadowRunId } from "../dist/learn/audit.js";
import { seedOf } from "../dist/learning.js";
import { git, resnap } from "./learn-support.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { agent, follow, serve, withEnv } from "./support.mjs";
import { outboxOf, PRIVATE_OK, receiver } from "./webhook-support.mjs";

/** The faux model at $100 per million output tokens, 400 a request: every model request costs $0.04. */
const PRICED = new URL("./fixtures/faux-workflow-priced.mjs", import.meta.url).pathname;
/** A learned workflow on the agent's own input (`content`): one model node answers a number, then it hands the run back
 *  to the agent when the input is HAND_BACK. */
const HAND_BACK = "Hand this one back.";
const FLOW = {
  v: 2, name: "answer",
  schemas: {
    In: { type: "object", required: ["content"], properties: { content: { type: "string" } } },
    Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [
    { node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" },
    { node: "escalate", label: "asked", when: { predicate: "field_equals", path: "content", value: HAND_BACK }, kind: "asked", stage: "answer", summary: "asked to hand it back" },
  ] },
};
const TEXT = JSON.stringify(FLOW);
const DIGEST = createHash("sha256").update(TEXT).digest("hex").slice(0, 16);

/** The runner's claims outlive every test here (each test's timeout is at most 300 s). With the default 30 s lease, a
 *  store stalled on a loaded disk let a served run's claim run out mid-workflow; its re-claim found the learned_workflow
 *  call cut, which is never run again but handed back (runner/adapter-loop.ts serveFirst), so the run read `handed_back`
 *  and was never audited. No test here waits on a lease. */
const LONG_LEASE = { leaseMs: 600_000, renewEveryMs: 10_000 };

/** Agent `source` learning with `learning` (granted `tools`: none by default, so every tool it can call reads), the
 *  workflow landed on its learning folder's main and promoted by its check. */
async function world(t, learning, tools = [], options = {}) {
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "AGENTRUN_TEST_FAUX_CALLS", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const server = await serve(t, { learning: "on", faux: PRICED, runnerTiming: LONG_LEASE, ...options });
  const { api, data, baseUrl, store } = server;
  assert.equal((await api("POST", "/agents", agent("source", { learning, tools }))).status, 201);
  await seedOf(data, "source");
  const repo = join(agentFolderOf(data, "source"), "learning");
  const files = { "workflows/answer/workflow.json": TEXT, "workflows/answer/README.md": "---\nname: answer\ndescription: Answers a question as a number; use when the person asks for the answer\n---\n" };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ["add", "--", ...Object.keys(files)]);
  git(repo, ["commit", "-q", "-m", "learned"]);
  await resnap(data, "source");
  const main = git(repo, ["rev-parse", "main"]);
  await store.settings.put("learning.promotions.source", { v: 1, items: [{ workflow: "answer", digest: DIGEST, at: new Date().toISOString(), decided: "promote", reason: "checked: promoted", check: { compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 5, agreed: 5, alone: 5, of: [] }, commit: main }] });
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const meets = (path, value, method = "get", status = "200") => assert.deepEqual(schemaProblems(doc, doc.paths[path][method].responses[status].content["application/json"].schema, value), [], `${path}: ${JSON.stringify(value)}`);
  /** Starts a run of `input` that learns nothing new (`use`) and follows it to its end. */
  const run = async (input) => {
    const started = await api("POST", "/agents/source/runs", { input, learning: "use" });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await follow(api, started.body.run_id, ["completed", "failed", "escalated"], { deadlineMs: 90_000 });
    return started.body.run_id;
  };
  /** The shadow run auditing `id`, once it ended: found in the store, never in the owner's run list. */
  const shadowOf = async (id) => {
    const end = Date.now() + 90_000;
    for (;;) {
      for (const row of await store.runs.list({ agentId: "source" })) {
        const launch = (await store.runs.launch(row.id))?.body;
        if (launch?.audit?.of === id && ["ended", "failed", "stopped"].includes(row.state) && row.runner === null) return row;
      }
      assert.ok(Date.now() < end, `no shadow of ${id} ended`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  return { ...server, doc, meets, run, shadowOf, main };
}

test("(h$) the money of (h) on runs the store holds: GET /runs/{id} of a served run its shadow audited reads cost.usd its own, its shadow's cost on learning_usd and the two on all_in_usd; the shadow reads audit_of the run, path audit, and carries none", async (t) => {
  // No runner: the two runs are ended in the store as a runner ends them, so nothing here waits on a claim or a model.
  const { api, store } = await serve(t, { learning: "on", runner: false });
  assert.equal((await api("POST", "/agents", agent("source", { learning: { audit_every: 1 } }))).status, 201);
  const revisionId = (await store.agents.get("source")).currentRevision;
  const end = async (id, costUsd, body, metrics) => {
    await store.runs.create({ id, agentId: "source", revisionId }, { body });
    const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
    await store.runs.update(claim, { state: "ended", costUsd, metrics });
  };
  const learns = { input: { content: "What is 1 plus 41?" }, title: "t", place: { mode: "runner" }, learning: { given: [], seed: "a".repeat(40), section: "", seedNotes: 0, workflows: ["answer"] } };
  await end("served-1", 0.04, learns, { path: "workflow", workflow: "answer", workflow_digest: DIGEST });
  const shadowId = shadowRunId("served-1");
  await end(shadowId, 0.12, { input: learns.input, title: "t", place: { mode: "runner" }, audit: { of: "served-1", workflow: "answer", digest: DIGEST } }, { path: "audit", audit: { of: "served-1", workflow: "answer", digest: DIGEST } });

  const served = (await api("GET", "/runs/served-1")).body;
  assert.equal(served.path, "workflow", JSON.stringify(served));
  assert.deepEqual([served.cost.usd, served.cost.learning_usd, served.cost.all_in_usd], [0.04, 0.12, 0.16], `its own, its shadow's, all in: ${JSON.stringify(served.cost)}`);
  assert.equal(served.audit_of, null, "a served run audits nothing");
  const shadow = (await api("GET", `/runs/${shadowId}`)).body;
  assert.equal(shadow.audit_of, "served-1", JSON.stringify(shadow));
  assert.equal(shadow.path, "audit");
  assert.deepEqual([shadow.cost.usd, shadow.cost.learning_usd, shadow.cost.all_in_usd], [0.12, 0, 0], `its spend is the served run's learning: ${JSON.stringify(shadow.cost)}`);
});

test("(h) served runs over v2 read like any run: the answer text, documented timeline kinds in the documented order, its path, cost.usd its own and the shadow's on learning_usd; the shadow is the audit of its run and no row of the list; the workflow's state, check numbers, audit line and rows are v2 reads", { timeout: 300_000 }, async (t) => {
  const { api, store, doc, meets, run, shadowOf } = await world(t, { audit_every: 1 });
  const alone = await run({ content: "What is 1 plus 41?" });
  // Its path before its shadow is waited on: one handed back is never drawn, and its timeline says why it was.
  assert.equal((await store.runs.get(alone)).metrics?.path, "workflow", JSON.stringify((await api("GET", `/runs/${alone}/timeline`)).body.rows));
  const escalated = await run({ content: HAND_BACK });
  // Only a run the workflow answered is drawn: the one it handed back has no shadow (path handed_back).
  const shadows = { [alone]: await shadowOf(alone) };
  // A later run's claim writes the finished audit's row.
  const later = await run({ content: "What is 3 plus 39?" });
  await shadowOf(later);
  for (const row of await store.runs.list({ agentId: "source" })) assert.notEqual((await store.runs.launch(row.id))?.body?.audit?.of, escalated, "the handed-back run is never audited");

  for (const [id, path] of [[alone, "workflow"], [escalated, "handed_back"]]) {
    const view = (await api("GET", `/runs/${id}`)).body;
    meets("/runs/{run_id}", view);
    assert.equal(view.status, "completed", JSON.stringify(view));
    assert.equal((await store.runs.get(id)).metrics.path, path, "served alone, then handed back");
    assert.equal(typeof view.result?.final_answer, "string", `the answer text is set: ${JSON.stringify(view.result)}`);
    assert.ok(view.result.final_answer.length > 0);
    // Its timeline: only documented kinds, every row as the spec has it.
    const rows = (await api("GET", `/runs/${id}/timeline`)).body.rows;
    assert.ok(rows.length > 0);
    for (const row of rows) assert.deepEqual(schemaProblems(doc, { $ref: "#/components/schemas/TimelineRow" }, row), [], JSON.stringify(row));
    // Its row sequence, as openapi's learned_nodes and llms.txt say: the message, the learned_workflow call and its result,
    // then the answer and the usage; a hand-back puts a phase row and the agent's own rows between the two.
    const kinds = rows.map((row) => row.kind);
    assert.deepEqual(kinds.slice(0, 3), ["user_message", "tool_use", "tool_result"], JSON.stringify(kinds));
    assert.deepEqual(rows.slice(1, 3).map((row) => row.tool_name), ["learned_workflow", "learned_workflow"]);
    assert.deepEqual(kinds.slice(-2), ["final_answer", "usage"], JSON.stringify(kinds));
    if (path === "workflow") assert.equal(kinds.length, 5, `served alone, nothing else: ${JSON.stringify(kinds)}`);
    else assert.equal(kinds[3], "phase", `a hand-back opens with a phase row: ${JSON.stringify(kinds)}`);
    // Its path; cost.usd its own requests (its hand-back's among them); its shadow's, when it has one, on learning_usd
    // (its revision's check ran no replay run here: nothing else to pass on), all_in_usd the two.
    assert.equal(view.path, path);
    const own = (await store.runs.get(id)).costUsd;
    const shadow = shadows[id];
    const shadowUsd = shadow?.costUsd ?? 0;
    assert.ok(own > 0 && (shadow === undefined || shadowUsd > 0), `${own} ${shadowUsd}`);
    assert.equal(Math.round(view.cost.usd * 1e6), Math.round(own * 1e6), `its own: ${JSON.stringify(view.cost)}`);
    assert.equal(Math.round(view.cost.learning_usd * 1e6), Math.round(shadowUsd * 1e6), `its shadow's: ${JSON.stringify(view.cost)}`);
    assert.equal(Math.round(view.cost.all_in_usd * 1e6), Math.round((own + shadowUsd) * 1e6), `all in: ${JSON.stringify(view.cost)}`);
    assert.equal(view.audit_of, null, "a served run audits nothing");
    if (!shadow) continue;
    // The shadow reads as the audit of its run, at its own cost, carried by the run it audits.
    const audit = (await api("GET", `/runs/${shadow.id}`)).body;
    meets("/runs/{run_id}", audit);
    assert.equal(audit.audit_of, id);
    assert.equal(audit.path, "audit");
    assert.equal(Math.round(audit.cost.usd * 1e6), Math.round(shadow.costUsd * 1e6));
    assert.deepEqual([audit.cost.learning_usd, audit.cost.all_in_usd], [0, 0], "its spend is on the run it audits");
  }
  // No shadow is a row of the owner's run lists, the agent's or every agent's.
  const listed = (await api("GET", "/agents/source/runs")).body.runs.map((one) => one.run_id);
  assert.deepEqual([...listed].sort(), [alone, escalated, later].sort(), JSON.stringify(listed));
  const everyone = (await api("GET", "/runs?agent=source")).body.runs.map((one) => one.run_id);
  assert.deepEqual([...everyone].sort(), [alone, escalated, later].sort(), JSON.stringify(everyone));

  // The rows: one per finished audit, both costs; none for the handed-back run.
  const audits = (await api("GET", "/agents/source/learning/audits")).body;
  meets("/agents/{agent_id}/learning/audits", audits);
  assert.equal(audits.audits.some((one) => one.run === escalated), false, JSON.stringify(audits));
  for (const id of [alone]) {
    const row = audits.audits.find((one) => one.run === id);
    assert.ok(row, JSON.stringify(audits));
    assert.deepEqual([row.shadow_run, row.workflow, row.digest, row.source, typeof row.agreed], [shadows[id].id, "answer", DIGEST, "shadow", "boolean"]);
    assert.equal(Math.round(row.shadow_cost * 1e6), Math.round(shadows[id].costUsd * 1e6));
    assert.equal(Math.round(row.served_cost * 1e6), Math.round((await store.runs.get(id)).costUsd * 1e6));
  }
  // The workflow's state, its check's numbers and its audit line.
  const promotions = (await api("GET", "/agents/source/learning/promotions")).body;
  meets("/agents/{agent_id}/learning/promotions", promotions);
  const serving = promotions.serving.find((one) => one.workflow === "answer");
  assert.deepEqual([serving.state, serving.digest, serving.check.n, serving.check.agreed, serving.check.alone], ["serving", DIGEST, 5, 5, 5], JSON.stringify(serving));
  const counted = audits.audits.filter((one) => one.digest === DIGEST && one.agreed !== null);
  assert.deepEqual(serving.audit, { window: 10, disagree: 3, rows: counted.length, disagreed: counted.filter((one) => one.agreed === false).length }, JSON.stringify(serving));
  // Every tool it can call reads: audits are on, and no run of it was left unaudited.
  assert.deepEqual([serving.audits_off, serving.not_auditable], [null, 0], JSON.stringify(serving));
});

test("(r2) an agent that can call a tool that writes is never audited: its served runs start no shadow, and the promotions read says why", { timeout: 240_000 }, async (t) => {
  const { api, store, meets, run } = await world(t, { audit_every: 1 }, ["write"]);
  const served = [await run({ content: "What is 1 plus 41?" }), await run({ content: "What is 2 plus 40?" })];
  for (const id of served) assert.equal((await store.runs.get(id)).metrics.path, "workflow", "served first");
  // Drawn at 1 in 1, yet no shadow: a second run of the agent could write again what the first wrote.
  for (const row of await store.runs.list({ agentId: "source" })) assert.equal((await store.runs.launch(row.id))?.body?.audit, undefined, `${row.id} is no shadow`);
  assert.deepEqual((await api("GET", "/agents/source/learning/audits")).body.audits, []);
  const promotions = (await api("GET", "/agents/source/learning/promotions")).body;
  meets("/agents/{agent_id}/learning/promotions", promotions);
  assert.deepEqual([promotions.serving[0].state, promotions.serving[0].audits_off], ["serving", "audits off: write can write"], JSON.stringify(promotions.serving));
});

test("(f) an owner's grade (wrong) on a served run writes a disagreeing row of source grade: no round opens, no hold, no compile is asked by it alone", { timeout: 240_000 }, async (t) => {
  const { api, store, run } = await world(t, {});
  const served = await run({ content: "What is 4 plus 38?" });
  const graded = await api("PUT", `/runs/${served}/grade`, { correct: false, source: "feedback", label: "it is 42" });
  assert.equal(graded.status, 200, JSON.stringify(graded.body));
  assert.deepEqual([graded.body.path, graded.body.workflow, graded.body.feedback], ["workflow", "answer", null], `no feedback round: ${JSON.stringify(graded.body)}`);
  const audits = (await api("GET", "/agents/source/learning/audits")).body.audits;
  const row = audits.find((one) => one.run === served);
  assert.ok(row, JSON.stringify(audits));
  assert.deepEqual([row.source, row.agreed, row.shadow_run, row.workflow, row.digest], ["grade", false, null, "answer", DIGEST]);
  // At most 2 disagreements of the default 3 in 10 (the grade's, and the run's shadow's should its id be drawn): still
  // serving, nothing held, so nothing compiles.
  const promotions = (await api("GET", "/agents/source/learning/promotions")).body;
  assert.deepEqual(promotions.promotions.map((one) => one.decided), ["promote"], JSON.stringify(promotions.promotions));
  assert.equal(promotions.serving[0].state, "serving");
  const counted = audits.filter((one) => one.agreed !== null);
  assert.deepEqual(promotions.serving[0].audit, { window: 10, disagree: 3, rows: counted.length, disagreed: counted.filter((one) => one.agreed === false).length });
  // The next run is served again: nothing held it.
  const next = await run({ content: "What is 5 plus 37?" });
  assert.equal((await store.runs.get(next)).metrics.path, "workflow");
});

test("(w) a shadow run sends no webhook of any kind and is in no run list: the host sees the served run's ends alone", { timeout: 300_000 }, async (t) => {
  const { api, data, run, shadowOf } = await world(t, { audit_every: 1 }, [], PRIVATE_OK);
  const hook = await receiver(t);
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const served = await run({ content: "What is 1 plus 41?" });
  const shadow = await shadowOf(served);
  // A run after the shadow ended: its end is told after the shadow's end was read off the run-change feed, in order.
  const later = await run({ content: "What is 3 plus 39?" });
  const told = (id) => hook.got.some((one) => JSON.parse(one.body).data?.run_id === id && JSON.parse(one.body).type === "run.ended");
  await hook.when(() => told(served) && told(later), "the run.ended of the served run and the later one", data);
  const shadowsOf = (body) => JSON.stringify(body).includes(shadow.id);
  assert.deepEqual(hook.got.filter((one) => shadowsOf(one.body)).map((one) => JSON.parse(one.body).type), [], "no message names the shadow");
  const outbox = outboxOf(data);
  assert.deepEqual(outbox.messages.filter((one) => shadowsOf(one.body)), [], "none is queued for it");
  assert.equal(outbox.notices[shadow.id], undefined, "nothing of it in the ledger");
  for (const path of ["/agents/source/runs", "/runs", "/runs?agent=source"]) {
    const ids = (await api("GET", path)).body.runs.map((one) => one.run_id);
    assert.ok(ids.includes(served) && !ids.includes(shadow.id), `${path}: ${JSON.stringify(ids)}`);
  }
});
