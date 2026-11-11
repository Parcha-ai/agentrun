// PATCH /runs/{id} {max_cost_usd} raises a run's spend cap, and only raises it. A run paused at its cap goes on: its
// runner sends it one follow-up turn, "The cap was raised to $X; continue the task.", the server's row in the Timeline,
// under the id the answer names (message_id), and runs it under the new cap. A step a working run's runner has under way
// keeps the cap it was admitted at, and the answer says so. A server started again raises a paused run's cap the same.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { journalRecords } from "../dist/runner/journal-reader.js";
import { agent, follow, serve, startInProcessRunner } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

/** The tests' faux model priced on output only, $100 a million: a request's least (1,024 tokens) is $0.1024. */
const OUTPUT_PRICED = new URL("./fixtures/faux-output-priced.mjs", import.meta.url).pathname;
const SETTLED = ["input_required", "completed", "failed", "cancelled"];
const view = async (api, runId) => (await api("GET", `/runs/${runId}`)).body;
const raise = (api, runId, body) => api("PATCH", `/runs/${runId}`, body);
/** The same told while nothing is priced (step 0, cap.ts wrapUpWords' `nonePriced`): a run paused at its first request
 *  has none, so its raised follow-up is told in these words, on pi in that request, on a faux CLI in the next (its proxy
 *  places the note before the guard has priced anything), in the same words: the note came due at step 0. Under a $2
 *  raise none is due at step 0 (the typical request is its input and a 4,096-token answer, $0.41, not its hold). */
const WRAP_UP_FIRST = (left) => `This run's budget is about ${left}, enough for little work: answer as soon as you can.`;

/** A run under a $0.05 cap, paused at it: its first request (least $0.1024) is refused. */
async function paused(api, id) {
  assert.equal((await api("POST", "/agents", agent(id))).status, 201);
  const { run_id } = (await api("POST", `/agents/${id}/runs`, { input: { content: "Write one.md" }, max_cost_usd: 0.05 })).body;
  await follow(api, run_id, SETTLED);
  assert.equal((await view(api, run_id)).pending?.kind, "budget");
  return run_id;
}

test("a run paused at its cap, its cap raised, goes on: one follow-up turn in the server's words runs under the new cap and completes, and the answer names that turn", async (t) => {
  const { api, store } = await serve(t, { faux: OUTPUT_PRICED });
  const runId = await paused(api, "raised");
  const raised = await raise(api, runId, { max_cost_usd: 1 });
  assert.deepEqual([raised.status, raised.body.max_cost_usd, raised.body.resumed], [200, 1, true], JSON.stringify(raised.body));
  assert.match(String(raised.body.message_id), /^agentrun:raise:/, JSON.stringify(raised.body));
  const { rows } = await follow(api, runId, ["completed", "failed", "cancelled"], { deadlineMs: 60_000 });
  // The answer names the follow-up the runner sent for this pause: the request id of a submission in the run's journal.
  const { submissions = [] } = await journalRecords(store.readJournal(runId), BACKGROUND_CONTEXT);
  const followUps = submissions.map((submission) => submission.requestId ?? submission.value?.requestId).filter((id) => String(id).startsWith("agentrun:raise:"));
  assert.deepEqual(followUps, [raised.body.message_id], `the one follow-up's submission is under the id the answer named: ${JSON.stringify(submissions.map((s) => Object.keys(s)))}`);
  const run = await view(api, runId);
  assert.deepEqual([run.status, run.error, run.pending, run.cost.cap_usd], ["completed", null, null, 1], JSON.stringify(run));
  // The server's line after the person's message, as the server's row ("AgentRun: …"), never as the person's.
  assert.deepEqual(said(rows).slice(0, 2), ["Write one.md", CONTINUE("$1")], JSON.stringify(said(rows)));
  assert.ok(!rows.some((row) => row.kind === "user_message" && row.text === CONTINUE("$1")), "the follow-up is never the person's message");
  assert.equal(run.result.final_answer, "On The cap was raised to $1; continue the task.: done.");
  // The claim that took the raise admitted the follow-up's request at the raise: the cap holds its least, $0.1024, over the
  // launch's $0.05, so a gate still reading the launch's cap in that claim would refuse it and pause the run again
  // (Manuel's beta.32 run read $0.001 there). One cap park in its journal, the first, and the run completed.
  assert.equal(await parksOf(store, runId), 1, "one pause, the first: the follow-up was never refused");
  assert.ok(run.cost.usd <= 1, `within the new cap: ${run.cost.usd}`);
});

/** How many times the run parked at its cap: its journal's agentrun.budget entries, from the store. */
const parksOf = async (store, runId) => (await journalRecords(store.readJournal(runId), BACKGROUND_CONTEXT)).entries.filter((entry) => entry.kind === "agentrun.budget").length;

test("a raise of a paused run, its server restarted before any runner takes it, resumes the run at the raised cap: the gate, the run view and its card read one cap throughout", { timeout: 120_000 }, async (t) => {
  // The first server's runner pauses the run at $0.05 (its first request's least is $0.1024), then stops: the raise is
  // written with no runner to take it.
  const first = await serve(t, { faux: OUTPUT_PRICED, runner: false });
  const stopRunner = await startInProcessRunner(first.data, { faux: OUTPUT_PRICED });
  const runId = await paused(first.api, "restarted-raise");
  await stopRunner();
  const raised = await raise(first.api, runId, { max_cost_usd: 1 });
  assert.deepEqual([raised.status, raised.body.resumed], [200, true], JSON.stringify(raised.body));
  // Untaken, the raise is not yet the run's cap anywhere: the view reads the launch's, as the runner's gate would.
  assert.equal((await view(first.api, runId)).cost.cap_usd, 0.05, "the raise holds once its runner takes it");
  await first.close();
  // Started again with a runner: it claims the run, takes the raise, and admits the follow-up's request at $1, which a
  // gate still reading the launch's $0.05 would refuse (its least is $0.1024) and park the run again.
  const { api, store } = await serve(t, { data: first.data, faux: OUTPUT_PRICED });
  await follow(api, runId, ["completed", "failed", "cancelled", "input_required"], { deadlineMs: 60_000 });
  const run = await view(api, runId);
  assert.deepEqual([run.status, run.pending, run.cost.cap_usd], ["completed", null, 1], JSON.stringify(run));
  // The follow-up's request, held at its least ($0.1024, over the launch's $0.05), was admitted: one pause, the first.
  assert.equal(await parksOf(store, runId), 1, "one pause, the first: the follow-up was never refused");
  assert.ok(run.cost.usd <= 1, `within the raised cap: ${run.cost.usd}`);
});

test("a paused workflow run's raise names no message: it sends no follow-up, its waiting step is judged again; an agentic run's names its follow-up", async () => {
  const { raiseCap } = await import("../dist/runs-over-store.js");
  const rows = [];
  const store = { commands: async () => rows, command: async (_runId, command) => (rows.push({ ...command, takenAt: null }), { id: rows.length }) };
  const moment = (kind) => ({ id: "run-1", agentId: "agent-1", kind, cancelled: false, terminal: false, working: false, awaitingAnswer: false, steers: true, maxCostUsd: 0.05, pausedWords: "Out of budget.", paused: true, pause: "7", live: false });
  assert.deepEqual(await raiseCap(store, moment("workflow"), 1), { resumed: true });
  rows.length = 0;
  assert.deepEqual(await raiseCap(store, moment("agentic"), 1), { resumed: true, messageId: "agentrun:raise:7" });
});

test("a raise is checked: only above the run's own cap, a number, nothing else named; a run with no cap and an ended run take none; an unknown run is 404", async (t) => {
  const { api } = await serve(t, { faux: OUTPUT_PRICED });
  const runId = await paused(api, "checked");
  for (const [body, field, reason] of [[{ max_cost_usd: 0.05 }, "max_cost_usd", "invalid"], [{ max_cost_usd: 0.01 }, "max_cost_usd", "invalid"], [{}, "max_cost_usd", "missing"], [{ max_cost_usd: "2" }, "max_cost_usd", "wrong_type"], [{ max_cost_usd: 2, effort: "high" }, "effort", "not_allowed"]]) {
    const answer = await raise(api, runId, body);
    assert.equal(answer.status, 422, JSON.stringify([body, answer.body]));
    assert.deepEqual(answer.body.error.fields?.map((p) => [p.field, p.reason]), [[field, reason]], JSON.stringify(answer.body));
  }
  assert.equal((await view(api, runId)).pending?.kind, "budget", "a refused raise changes nothing");
  // A run that named no cap.
  assert.equal((await api("POST", "/agents", agent("uncapped"))).status, 201);
  const { run_id: uncapped } = (await api("POST", "/agents/uncapped/runs", { input: { content: "hi" } })).body;
  await follow(api, uncapped, SETTLED);
  const none = await raise(api, uncapped, { max_cost_usd: 1 });
  assert.equal(none.status, 422, JSON.stringify(none.body));
  // An ended run: completed, then cancelled-proof by status.
  assert.equal((await view(api, uncapped)).status, "completed");
  assert.equal((await api("POST", "/agents", agent("capped-done"))).status, 201);
  const { run_id: done } = (await api("POST", "/agents/capped-done/runs", { input: { content: "hi" }, max_cost_usd: 5 })).body;
  await follow(api, done, SETTLED);
  assert.equal((await view(api, done)).status, "completed");
  const ended = await raise(api, done, { max_cost_usd: 6 });
  assert.deepEqual([ended.status, ended.body.error?.code], [409, "not_continuable"], JSON.stringify(ended.body));
  assert.equal((await raise(api, "run-not-here", { max_cost_usd: 1 })).status, 404);
});

test("a working run's cap raised is kept and named on the run, and the step its runner has under way keeps the cap it was admitted at, which the answer says", async (t) => {
  const { api, store } = await serve(t, { faux: OUTPUT_PRICED });
  assert.equal((await api("POST", "/agents", agent("working"))).status, 201);
  const { run_id } = (await api("POST", "/agents/working/runs", { input: { content: "Take your time." }, max_cost_usd: 10 })).body;
  // Held by its runner (a queued run reads working too, and has no step under way to keep a cap).
  for (let i = 0; !(await store.runs.get(run_id))?.runner; i++) {
    assert.ok(i < 200, "a runner claims the run");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const raised = await raise(api, run_id, { max_cost_usd: 11 });
  assert.deepEqual([raised.status, raised.body.resumed, raised.body.message_id], [200, false, undefined], JSON.stringify(raised.body));
  assert.equal(raised.body.note, "The $11 cap holds from the run's next step; a step already under way keeps the $10 cap it was admitted at.");
  // Kept and named on the run once its runner takes the raise, its next command.
  for (let i = 0; (await view(api, run_id)).cost.cap_usd !== 11; i++) {
    assert.ok(i < 200, `the raised cap is named on the run: ${JSON.stringify((await view(api, run_id)).cost)}`);
    await sleep(50);
  }
  assert.equal((await api("POST", `/runs/${run_id}/cancel`)).status, 202);
});

test("a server started again raises a paused run's cap the same: the run goes on under it and completes", async (t) => {
  const first = await serve(t, { faux: OUTPUT_PRICED });
  const runId = await paused(first.api, "restarted");
  await first.close();
  const { api } = await serve(t, { data: first.data, faux: OUTPUT_PRICED });
  const raised = await raise(api, runId, { max_cost_usd: 2 });
  assert.deepEqual([raised.status, raised.body.resumed], [200, true], JSON.stringify(raised.body));
  await follow(api, runId, ["completed", "failed", "cancelled"], { deadlineMs: 60_000 });
  const run = await view(api, runId);
  assert.deepEqual([run.status, run.cost.cap_usd, run.result.final_answer], ["completed", 2, "On The cap was raised to $2; continue the task.: done."], JSON.stringify(run));
});

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const CONTINUE = (cap) => `The cap was raised to ${cap}; continue the task.`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** What the person's side of the run says, in order: its user messages' text. */
/** The run's messages in order: the person's (user_message) and the server's own (its "AgentRun: …" row, MessageOrigin). */
const said = (rows) => rows.filter((row) => row.kind === "user_message" || (row.kind === "phase" && row.summary?.startsWith("AgentRun:"))).map((row) => row.text);

test("two raises of a paused run at once (a retry) resume it once: both answered 200, one follow-up", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { faux: OUTPUT_PRICED });
  const runId = await paused(api, "twice");
  const answers = await Promise.all([raise(api, runId, { max_cost_usd: 1 }), raise(api, runId, { max_cost_usd: 1 })]);
  assert.deepEqual(answers.map((a) => a.status), [200, 200], JSON.stringify(answers.map((a) => a.body)));
  assert.match(String(answers[0].body.message_id), /^agentrun:raise:/, JSON.stringify(answers[0].body));
  assert.equal(answers[0].body.message_id, answers[1].body.message_id, "the same follow-up");
  const { rows } = await follow(api, runId, ["completed", "failed", "cancelled"], { deadlineMs: 60_000 });
  // One follow-up, the server's. (The wrap-up told in its request after it comes with the cap's note on the runner, #2080.)
  assert.deepEqual(said(rows).slice(0, 2), ["Write one.md", CONTINUE("$1")], JSON.stringify(said(rows)));
  assert.equal(said(rows).filter((line) => line === CONTINUE("$1")).length, 1, "one follow-up");
  assert.equal((await view(api, runId)).status, "completed");
});

for (const harness of ["claude-agent", "codex"]) {
  test(`${harness}: a run paused at its cap, its cap raised, goes on: the follow-up runs under the new cap and the run completes`, { timeout: 120_000 }, async (t) => {
    const { api } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), faux: OUTPUT_PRICED });
    assert.equal((await api("POST", "/agents", agent(`raise-${harness}`, { harness, instructions: "Make three requests." }))).status, 201);
    const { run_id } = (await api("POST", `/agents/raise-${harness}/runs`, { input: { content: "go" }, max_cost_usd: 0.05 })).body;
    await follow(api, run_id, SETTLED, { deadlineMs: 60_000 });
    assert.equal((await view(api, run_id)).pending?.kind, "budget", "paused at its cap");
    const raised = await raise(api, run_id, { max_cost_usd: 1 });
    assert.deepEqual([raised.status, raised.body.resumed], [200, true], JSON.stringify(raised.body));
    const { rows } = await follow(api, run_id, ["completed", "failed", "cancelled"], { deadlineMs: 60_000 });
    const run = await view(api, run_id);
    assert.deepEqual([run.status, run.error, run.cost.cap_usd, run.result?.final_answer], ["completed", null, 1, "Read it."], JSON.stringify(run));
    // The person's message first. (The server's follow-up row on a CLI's run comes with #2430's per-request record; the
    // wrap-up after it with the cap's note on the runner, #2080.)
    assert.equal(said(rows)[0], "go", JSON.stringify(said(rows)));
  });
}

test("a paused run's pending suggests a raise, spent + 10 × the refused request's least rounded up to a whole dollar and above its cap, and PATCHing it resumes the run", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { faux: OUTPUT_PRICED });
  const runId = await paused(api, "suggested");
  const { pending } = await view(api, runId);
  // Nothing spent, a least of $0.1024: $0 + $1.024, up to $2, above the $0.05 cap.
  assert.deepEqual([pending.spent_usd, pending.suggested_cap_usd], [0, 2], JSON.stringify(pending));
  const raised = await raise(api, runId, { max_cost_usd: pending.suggested_cap_usd });
  assert.deepEqual([raised.status, raised.body.max_cost_usd, raised.body.resumed], [200, 2, true], JSON.stringify(raised.body));
  const { rows } = await follow(api, runId, ["completed", "failed", "cancelled"], { deadlineMs: 60_000 });
  const run = await view(api, runId);
  assert.deepEqual([run.status, run.error, run.cost.cap_usd, said(rows)], ["completed", null, 2, ["Write one.md", CONTINUE("$2")]], JSON.stringify(run));
});

test("the suggested raise is a whole dollar, always above the cap, and a float just past a dollar stays that dollar", async () => {
  const { suggestedCap } = await import("../dist/run-view.js");
  assert.equal(typeof suggestedCap, "function", "runs.js offers suggestedCap");
  assert.equal(suggestedCap(0.05, 0, 0.1024), 2);
  assert.equal(suggestedCap(0.5, 0.4, 0.2), 3, "$0.40 + $2.00, up to $3");
  assert.equal(suggestedCap(2, 0.1, 0.1), 3, "$1.10 is up to $2, not above the $2 cap: the next dollar");
  assert.equal(suggestedCap(2.5, 0, 0), 3, "nothing needed: the next dollar above the cap");
  assert.equal(suggestedCap(0.05, 0.2, 0.28), 3, "0.2 + 10 × 0.28 is 3.0000000000000004 in a float: $3, not $4");
});

for (const harness of ["claude-agent", "codex"]) {
  // SKIP (#2430): a message to a raised run that went on and completed answers 409 until a completed run reopens on a message.
  test.skip(`${harness}: a run raised past its pause and gone on, then sent a message, ends that turn completed: the refusal is the paused turn's only`, { timeout: 120_000 }, async (t) => {
    const { api } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), faux: OUTPUT_PRICED });
    assert.equal((await api("POST", "/agents", agent(`after-${harness}`, { harness, instructions: "Make three requests." }))).status, 201);
    const { run_id } = (await api("POST", `/agents/after-${harness}/runs`, { input: { content: "go" }, max_cost_usd: 0.05 })).body;
    await follow(api, run_id, SETTLED, { deadlineMs: 60_000 });
    assert.equal((await view(api, run_id)).pending?.kind, "budget", "paused at its cap");
    assert.equal((await raise(api, run_id, { max_cost_usd: 1 })).status, 200);
    await follow(api, run_id, ["completed", "failed", "cancelled"], { deadlineMs: 60_000 });
    assert.equal((await view(api, run_id)).status, "completed", "gone on");
    assert.equal((await api("POST", `/runs/${run_id}/messages`, { content: "Once more." })).status, 202);
    const { rows } = await follow(api, run_id, ["completed", "failed", "cancelled"], { deadlineMs: 60_000 });
    const run = await view(api, run_id);
    assert.deepEqual([run.status, run.error, run.pending], ["completed", null, null], JSON.stringify(run));
    assert.deepEqual(said(rows), ["go", CONTINUE("$1"), WRAP_UP_FIRST("$1"), "Once more."]);
    assert.deepEqual(rows.filter((row) => row.kind === "error" || row.paused === true).map((row) => row.kind), ["phase"], `no error row, and one pause row, the paused turn's refusal: ${JSON.stringify(rows.filter((row) => row.kind === "error" || row.paused === true))}`);
  });
}

const ENDED = ["completed", "failed", "cancelled"];

test("a paused run's figures are shown as cost.usd is, to a millionth of a dollar", async () => {
  const { budgetOf } = await import("../dist/run-view.js");
  // The cap park as the kernel cap writes it, its least a sum of floats: $0.1024 and a float's tail.
  const park = { id: 7, kind: "agentrun.budget", data: { pending: { kind: "budget", cap_usd: 0.05, spent_usd: 0, needs_usd: 0.10240000000000002 }, words: "The run's next request could cost up to $0.1024." } };
  const pending = budgetOf([park], { meta: { max_cost_usd: 0.05 }, rows: [], updatedAt: new Date(0).toISOString() });
  assert.deepEqual([pending.spent_usd, pending.needs_usd, pending.suggested_cap_usd], [0, 0.1024, 2], JSON.stringify(pending));
});

test("a raise is the same cap within a float's tail: a cap a hair above the run's is no raise, and a retry that differs by a float's tail answers as the first did", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { faux: OUTPUT_PRICED });
  const runId = await paused(api, "tolerant");
  const hair = await raise(api, runId, { max_cost_usd: 0.05 + 1e-12 });
  assert.deepEqual([hair.status, hair.body.error?.fields?.map((f) => [f.field, f.reason])], [422, [["max_cost_usd", "invalid"]]], JSON.stringify(hair.body));
  const first = await raise(api, runId, { max_cost_usd: 0.1 + 0.2 });
  const retry = await raise(api, runId, { max_cost_usd: 0.3 });
  assert.deepEqual([first.status, retry.status, retry.body.resumed, retry.body.message_id], [200, 200, true, first.body.message_id], JSON.stringify([first.body, retry.body]));
});

for (const harness of ["pi", "claude-agent"]) {
  // A CLI's run records its follow-up through #2430's per-request record (CliRecord.followUp): skipped there until it lands.
  (harness === "pi" ? test : test.skip)(`${harness}: a raise's follow-up shows as the server's, "AgentRun: The cap was raised to $1; continue the task.", never as the person's "You: …"`, { timeout: 120_000 }, async (t) => {
    const { api } = await serve(t, { faux: OUTPUT_PRICED, ...(harness === "pi" ? {} : { harnessTable: fauxTable(FAUX_HARNESS) }) });
    assert.equal((await api("POST", "/agents", agent(`said-${harness}`, { ...(harness === "pi" ? {} : { harness }), instructions: "Make three requests." }))).status, 201);
    const { run_id } = (await api("POST", `/agents/said-${harness}/runs`, { input: { content: "go" }, max_cost_usd: 0.05 })).body;
    await follow(api, run_id, SETTLED, { deadlineMs: 60_000 });
    assert.equal((await view(api, run_id)).pending?.kind, "budget", "paused at its cap");
    assert.equal((await raise(api, run_id, { max_cost_usd: 1 })).status, 200);
    const { rows } = await follow(api, run_id, ENDED, { deadlineMs: 60_000 });
    assert.equal((await view(api, run_id)).status, "completed");
    assert.deepEqual(rows.filter((r) => r.kind === "user_message").map((r) => r.summary), ["You: go"], "the person's one message");
    // The server's first row is the raise's follow-up. (The wrap-up told in its request after it: #2080, with the cap's note.)
    assert.deepEqual(rows.filter((r) => r.kind === "phase" && r.summary?.startsWith("AgentRun:")).map((r) => [r.summary, r.text]).slice(0, 1), [[`AgentRun: ${CONTINUE("$1")}`, CONTINUE("$1")]], "the server's row: the raise's follow-up");
  });
}

test("the suggested raise is above the cap by more than a float's tail, so a PATCH with it is always a raise", async () => {
  const { suggestedCap } = await import("../dist/run-view.js");
  // $0.05 needed, nothing spent: 10 × $0.05 is $0.50, up to $1, a hair (5e-10) above a 0.9999999995 cap: no raise.
  assert.equal(suggestedCap(0.9999999995, 0, 0.05), 2);
  // The next dollar above a cap a hair under $2 is $3: $2 is within the tail of it, and no raise.
  assert.equal(suggestedCap(1.9999999995, 0, 0.01), 3);
});

test("a retry of a raise once the run has paused anew under it is no raise of the new pause: it answers resumed false, and the run stays paused", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { faux: OUTPUT_PRICED });
  const runId = await paused(api, "anew");
  const first = await raise(api, runId, { max_cost_usd: 0.06 });
  assert.deepEqual([first.status, first.body.resumed], [200, true], JSON.stringify(first.body));
  // $0.06 is short of a request's least too: its follow-up's request is refused, a pause of its own.
  for (let w = 0; ; w++) {
    const run = await view(api, runId);
    if (run.pending?.kind === "budget" && run.pending.cap_usd === 0.06) break;
    assert.ok(w < 600, `paused anew under $0.06: ${JSON.stringify(run)}`);
    await sleep(100);
  }
  const retry = await raise(api, runId, { max_cost_usd: 0.06 });
  assert.deepEqual([retry.status, retry.body.resumed, retry.body.message_id], [200, false, undefined], JSON.stringify(retry.body));
  assert.equal((await view(api, runId)).pending?.kind, "budget", "still paused, at its new refusal");
});
