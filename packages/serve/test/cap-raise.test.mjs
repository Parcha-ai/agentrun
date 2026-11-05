// PATCH /runs/{id} {max_cost_usd} raises a run's spend cap, and only raises it. A run paused at its cap goes on: the
// server sends it one follow-up turn, "The cap was raised to $X; continue the task.", which its new process runs under
// the new cap; the refused request was never sent, so nothing is paid for twice. A working run's live process keeps
// its cap until its next process, and the answer says so. A server started again raises a paused run's cap the same.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { processAlive } from "@parcha/agentrun-kernel/host";
import { REQUEST_STARTED } from "@parcha/pi-durable-agent/timeline";
import { spentIn } from "../dist/cap.js";
import { startServe } from "../dist/index.js";
import { agent, client, follow, letGo, scratch, serve, withEnv } from "./support.mjs";

/** The tests' faux model priced on output only, $100 a million: a request's least (1,024 tokens) is $0.1024. */
const OUTPUT_PRICED = new URL("./fixtures/faux-output-priced.mjs", import.meta.url).pathname;
const SETTLED = ["input_required", "completed", "failed", "cancelled"];
const view = async (api, runId) => (await api("GET", `/runs/${runId}`)).body;
const raise = (api, runId, body) => api("PATCH", `/runs/${runId}`, body);

/** A run under a $0.05 cap, paused at it: its first request (least $0.1024) is refused. */
async function paused(api, id) {
  assert.equal((await api("POST", "/agents", agent(id))).status, 201);
  const { run_id } = (await api("POST", `/agents/${id}/runs`, { input: { content: "Write one.md" }, max_cost_usd: 0.05 })).body;
  await follow(api, run_id, SETTLED);
  assert.equal((await view(api, run_id)).pending?.kind, "budget");
  return run_id;
}

/** The run's store entries, once its process has let it go. */
function entriesOf(data, runId) {
  const db = new DatabaseSync(join(data, "runs", runId, "store", "run.sqlite"), { readOnly: true, timeout: 5_000 });
  try {
    return db.prepare("SELECT record FROM entries ORDER BY id").all().map((row) => JSON.parse(row.record));
  } finally {
    db.close();
  }
}

test("a run paused at its cap, its cap raised, goes on: one follow-up turn in the server's words runs under the new cap and completes, and the refused request was never sent", async (t) => {
  const { api, data } = await serve(t, { faux: OUTPUT_PRICED });
  const runId = await paused(api, "raised");
  const raised = await raise(api, runId, { max_cost_usd: 1 });
  assert.deepEqual([raised.status, raised.body.max_cost_usd, raised.body.resumed, typeof raised.body.message_id], [200, 1, true, "string"], JSON.stringify(raised.body));
  const { rows } = await follow(api, runId, ["completed", "failed", "cancelled"], { deadlineMs: 60_000 });
  const run = await view(api, runId);
  assert.deepEqual([run.status, run.error, run.pending, run.cost.cap_usd], ["completed", null, null, 1], JSON.stringify(run));
  const said = rows.filter((row) => row.kind === "user_message").map((row) => row.text);
  assert.deepEqual(said, ["Write one.md", "The cap was raised to $1; continue the task."], "the server's one line, after the person's message");
  assert.equal(run.result.final_answer, "On The cap was raised to $1; continue the task.: done.");
  // The refused request has its own start mark and was never sent: the one request sent is the follow-up's answer.
  const entries = entriesOf(data, runId);
  assert.equal(entries.filter((entry) => entry.kind === REQUEST_STARTED && entry.data?.capRefused === true).length, 1);
  assert.equal(entries.filter((entry) => entry.kind === REQUEST_STARTED && entry.data?.capRefused !== true).length, 1);
  assert.ok(spentIn(join(data, "runs", runId, "store", "run.sqlite")) <= 1, "within the new cap");
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

test("a working run's cap raised is kept and named on the run, and its live process keeps the cap it opened with, which the answer says", async (t) => {
  const { api } = await serve(t, { faux: OUTPUT_PRICED });
  assert.equal((await api("POST", "/agents", agent("working"))).status, 201);
  const { run_id } = (await api("POST", "/agents/working/runs", { input: { content: "Take your time." }, max_cost_usd: 10 })).body;
  for (let i = 0; (await view(api, run_id)).state !== "working"; i++) {
    assert.ok(i < 200, "the run starts working");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const raised = await raise(api, run_id, { max_cost_usd: 11 });
  assert.deepEqual([raised.status, raised.body.resumed, raised.body.message_id], [200, false, undefined], JSON.stringify(raised.body));
  assert.match(raised.body.note, /^The run's process keeps the \$10 cap it was opened with; the \$11 cap holds from its next process\.$/);
  assert.equal((await view(api, run_id)).cost.cap_usd, 11);
  assert.equal((await api("POST", `/runs/${run_id}/cancel`)).status, 202);
});

test("a server started again raises a paused run's cap the same: the run goes on under it and completes", async (t) => {
  const data = join(await scratch(t), "agents");
  let server = await startServe({ data, port: 0, faux: OUTPUT_PRICED, drainTimeout: "5s" });
  t.after(() => server?.close());
  const runId = await paused(client(server.baseUrl, server.token), "restarted");
  await server.close();
  server = await startServe({ data, port: 0, faux: OUTPUT_PRICED, drainTimeout: "5s" });
  const api = client(server.baseUrl, server.token);
  const raised = await raise(api, runId, { max_cost_usd: 2 });
  assert.deepEqual([raised.status, raised.body.resumed], [200, true], JSON.stringify(raised.body));
  await follow(api, runId, ["completed", "failed", "cancelled"], { deadlineMs: 60_000 });
  const run = await view(api, runId);
  assert.deepEqual([run.status, run.cost.cap_usd, run.result.final_answer], ["completed", 2, "On The cap was raised to $2; continue the task.: done."], JSON.stringify(run));
});

/** The output-priced faux model in a process that cannot exit until EXIT_GATE exists: a paused run's let-go held open. */
const SLOW_EXIT = new URL("./fixtures/faux-output-priced-slow-exit.mjs", import.meta.url).pathname;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const CONTINUE = (cap) => `The cap was raised to ${cap}; continue the task.`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const holderPid = (data, runId) => JSON.parse(readFileSync(join(data, "runs", runId, "run.json"), "utf8")).holder.pid;
/** What the person's side of the run says, in order: its user messages' text. */
const said = (rows) => rows.filter((row) => row.kind === "user_message").map((row) => row.text);

test("a raise sent while the paused run's process is still being let go is taken at once, and the run goes on once that process is gone: under the new cap, one follow-up, no locked store and no failed run", { timeout: 120_000 }, async (t) => {
  const gate = join(await scratch(t), "exit");
  withEnv(t, { EXIT_GATE: gate });
  const { api, data } = await serve(t, { faux: SLOW_EXIT });
  const runId = await paused(api, "racing");
  // Paused, its process was told to go and is held there: the let-go window is open.
  const pid = holderPid(data, runId);
  assert.ok(processAlive(pid), "the paused run's process is still being let go");
  const raised = await raise(api, runId, { max_cost_usd: 1 });
  assert.deepEqual([raised.status, raised.body.resumed, typeof raised.body.message_id], [200, true, "string"], JSON.stringify(raised.body));
  assert.ok(processAlive(pid), "the raise was taken inside the let-go window");
  await sleep(500);
  assert.equal(said((await follow(api, runId, SETTLED)).rows).length, 1, "no follow-up while the old process still holds the run");
  await writeFile(gate, "");
  const { rows } = await follow(api, runId, ["completed", "failed", "cancelled"], { deadlineMs: 60_000 });
  const run = await view(api, runId);
  assert.deepEqual([run.status, run.error, run.cost.cap_usd], ["completed", null, 1], JSON.stringify(run));
  assert.deepEqual(said(rows), ["Write one.md", CONTINUE("$1")], "one follow-up, after the old process was gone");
  assert.ok(!JSON.stringify(rows).includes("database is locked"), "no locked store");
});

test("two raises of a paused run at once (a retry) resume it once: both answered 200, one follow-up", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { faux: OUTPUT_PRICED });
  const runId = await paused(api, "twice");
  const answers = await Promise.all([raise(api, runId, { max_cost_usd: 1 }), raise(api, runId, { max_cost_usd: 1 })]);
  assert.deepEqual(answers.map((a) => a.status), [200, 200], JSON.stringify(answers.map((a) => a.body)));
  assert.equal(answers[0].body.message_id, answers[1].body.message_id, "the same follow-up");
  const { rows } = await follow(api, runId, ["completed", "failed", "cancelled"], { deadlineMs: 60_000 });
  assert.deepEqual(said(rows), ["Write one.md", CONTINUE("$1")]);
  assert.equal((await view(api, runId)).status, "completed");
});

for (const harness of ["claude-agent", "codex"]) {
  test(`${harness}: a run paused at its cap, its cap raised, goes on: the follow-up runs under the new cap and the run completes`, { timeout: 120_000 }, async (t) => {
    const { api } = await serve(t, { fauxHarness: FAUX_HARNESS, faux: OUTPUT_PRICED });
    assert.equal((await api("POST", "/agents", agent(`raise-${harness}`, { harness, instructions: "Make three requests." }))).status, 201);
    const { run_id } = (await api("POST", `/agents/raise-${harness}/runs`, { input: { content: "go" }, max_cost_usd: 0.05 })).body;
    await follow(api, run_id, SETTLED, { deadlineMs: 60_000 });
    assert.equal((await view(api, run_id)).pending?.kind, "budget", "paused at its cap");
    const raised = await raise(api, run_id, { max_cost_usd: 1 });
    assert.deepEqual([raised.status, raised.body.resumed], [200, true], JSON.stringify(raised.body));
    const { rows } = await follow(api, run_id, ["completed", "failed", "cancelled"], { deadlineMs: 60_000 });
    const run = await view(api, run_id);
    assert.deepEqual([run.status, run.error, run.cost.cap_usd, run.result?.final_answer], ["completed", null, 1, "Read it."], JSON.stringify(run));
    assert.deepEqual(said(rows), ["go", CONTINUE("$1")]);
  });
}

/** The bin on `data`, as an operator starts it, in a process this test can kill. */
async function serverProcess(data, env) {
  const child = spawn(process.execPath, [CLI, "--data", data, "--port", "0", "--faux", SLOW_EXIT], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AGENTRUN_ACCOUNTS: "0", ...env } });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  for (let i = 0; !/AGENTRUN_BASE_URL=/.test(out); i++) {
    assert.ok(i < 400 && child.exitCode === null, `the server did not start: ${out}`);
    await sleep(50);
  }
  return { child, api: client(/AGENTRUN_BASE_URL=(\S+)/.exec(out)[1], (await readFile(join(data, ".token"), "utf8")).trim()) };
}

test("a raise taken, then the server killed before its follow-up went: the next server sends it, once, and the run completes; the same raise again changes nothing", { timeout: 150_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const gate = join(await scratch(t), "exit");
  const first = await serverProcess(data, { EXIT_GATE: gate });
  t.after(() => first.child.kill("SIGKILL"));
  const runId = await paused(first.api, "crashed");
  const pid = holderPid(data, runId);
  assert.ok(processAlive(pid), "the paused process is held, so the follow-up waits");
  const raised = await raise(first.api, runId, { max_cost_usd: 1 });
  assert.deepEqual([raised.status, raised.body.resumed], [200, true], JSON.stringify(raised.body));
  first.child.kill("SIGKILL");
  await new Promise((resolve) => first.child.once("exit", resolve));
  // The old run process lets go once its gate opens; the next server finds the raise taken and its follow-up not sent.
  await writeFile(gate, "");
  await letGo(data, runId);
  const next = await startServe({ data, port: 0, faux: SLOW_EXIT, drainTimeout: "5s" });
  t.after(() => next.close());
  const api = client(next.baseUrl, next.token);
  const { rows } = await follow(api, runId, ["completed", "failed", "cancelled"], { deadlineMs: 60_000 });
  assert.deepEqual([(await view(api, runId)).status, said(rows)], ["completed", ["Write one.md", CONTINUE("$1")]], "one follow-up across the restart");
  const again = await raise(api, runId, { max_cost_usd: 1 });
  assert.equal(again.status, 409, `an ended run takes no raise: ${JSON.stringify(again.body)}`);
  const db = new DatabaseSync(join(data, "runs", runId, "store", "run.sqlite"), { readOnly: true, timeout: 5_000 });
  try {
    const marks = db.prepare("SELECT record FROM entries ORDER BY id").all().map((row) => JSON.parse(row.record)).filter((entry) => entry.kind === REQUEST_STARTED && entry.data?.capRefused === true);
    assert.equal(marks.length, 1, "one refusal booked, never a second");
  } finally {
    db.close();
  }
});

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
  const { suggestedCap } = await import("../dist/runs.js");
  assert.equal(typeof suggestedCap, "function", "runs.js offers suggestedCap");
  assert.equal(suggestedCap(0.05, 0, 0.1024), 2);
  assert.equal(suggestedCap(0.5, 0.4, 0.2), 3, "$0.40 + $2.00, up to $3");
  assert.equal(suggestedCap(2, 0.1, 0.1), 3, "$1.10 is up to $2, not above the $2 cap: the next dollar");
  assert.equal(suggestedCap(2.5, 0, 0), 3, "nothing needed: the next dollar above the cap");
  assert.equal(suggestedCap(0.05, 0.2, 0.28), 3, "0.2 + 10 × 0.28 is 3.0000000000000004 in a float: $3, not $4");
});

test("a paused run's figures, once its process is gone, are the store's spend: a hold its refusal counted that no request booked is not spent, and the suggested raise and a raise below the stale bar follow the store", { timeout: 120_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  let server = await startServe({ data, port: 0, faux: OUTPUT_PRICED, drainTimeout: "5s" });
  t.after(() => server?.close());
  const runId = await paused(client(server.baseUrl, server.token), "held");
  await server.close();
  // The refusal as the cap counted it with a $1.50 hold in flight (a request answering, its worst case held), which then
  // settled with nothing booked: its mark says $1.50 taken, the store says $0 spent.
  const db = new DatabaseSync(join(data, "runs", runId, "store", "run.sqlite"), { timeout: 5_000 });
  try {
    const marks = db.prepare("SELECT rowid AS at, record FROM entries ORDER BY rowid").all().filter((row) => { const e = JSON.parse(row.record); return e.kind === REQUEST_STARTED && e.data?.capRefused === true; });
    assert.equal(marks.length, 1, "one refusal mark");
    const record = JSON.parse(marks[0].record);
    db.prepare("UPDATE entries SET record = ? WHERE rowid = ?").run(JSON.stringify({ ...record, data: { ...record.data, spentUsd: 1.5 } }), marks[0].at);
  } finally {
    db.close();
  }
  assert.equal(spentIn(join(data, "runs", runId, "store", "run.sqlite")), 0, "the store's spend");
  server = await startServe({ data, port: 0, faux: OUTPUT_PRICED, drainTimeout: "5s" });
  const api = client(server.baseUrl, server.token);
  const { pending } = await view(api, runId);
  // The store's $0 and the least $0.1024: $1.024, up to $2. The mark's stale $1.50 would say $3.
  assert.deepEqual([pending.spent_usd, pending.suggested_cap_usd], [0, 2], JSON.stringify(pending));
  // $1 is above what the request needs on the store's figure ($0.1024), below the stale mark's ($1.6024): a raise.
  const raised = await raise(api, runId, { max_cost_usd: 1 });
  assert.deepEqual([raised.status, raised.body.resumed], [200, true], JSON.stringify(raised.body));
  const { rows } = await follow(api, runId, ["completed", "failed", "cancelled"], { deadlineMs: 60_000 });
  assert.deepEqual([(await view(api, runId)).status, said(rows)], ["completed", ["Write one.md", CONTINUE("$1")]]);
});

for (const harness of ["claude-agent", "codex"]) {
  test(`${harness}: a run raised past its pause and gone on, then sent a message, ends that turn completed: the refusal is the paused turn's only`, { timeout: 120_000 }, async (t) => {
    const { api } = await serve(t, { fauxHarness: FAUX_HARNESS, faux: OUTPUT_PRICED });
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
    assert.deepEqual(said(rows), ["go", CONTINUE("$1"), "Once more."]);
    assert.equal(rows.filter((row) => row.kind === "error").length, 1, `one error row, the paused turn's refusal: ${JSON.stringify(rows.filter((row) => row.kind === "error"))}`);
  });
}
