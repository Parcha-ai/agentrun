// The wrap-up end to end. pi: near its cap the run's model is told once, inside the request it is about to send ("About
// $X left of this run's budget: finish now with your answer."), and one row of the server's says so; pi's transcript never
// holds it and no input is queued, so the model's answer ends the turn. A next turn under the same cap is told nothing
// again. Another harness (the faux harness standing in for claude-agent): the same words go in a main-model request (the
// model proxy adds them to its body), once, worked out with what is left as the request takes them, and the row is
// written only once a request carrying them is admitted: never for a note no request carried, across a crash or a
// turn's end.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { agent, follow, letGo, runDir, runRecordOf, scratch, serve, withEnv } from "./support.mjs";

const WRAPUP = new URL("./fixtures/faux-wrapup.mjs", import.meta.url).pathname;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
/** The tests' faux model priced on output only, $100 a million: what the faux harness's requests are held at. */
const OUTPUT_PRICED = new URL("./fixtures/faux-output-priced.mjs", import.meta.url).pathname;
/** The wrap-up's words with `left` of the cap (cap.ts wrapUpWords). */
const WRAP_UP = (left) => `About ${left} left of this run's budget: finish now with your answer.`;
/** The faux harness's notes taken into its requests (FAUX_RECORDS.note), once the run's process has let it go. */
const notesOf = (data, runId) => entries(data, runId).filter((record) => record.kind === "faux.note").map((record) => record.data.text);
/** The run's messages in order: the person's and the server's own rows. */
const said = (rows) => rows.filter((row) => row.kind === "user_message" || (row.kind === "phase" && row.summary?.startsWith("AgentRun:"))).map((row) => row.text);
const WORDS = /^AgentRun: About \$\d+(?:\.\d\d)? left of this run's budget: finish now with your answer\.$/;
const rowsOf = async (api, runId) => (await api("GET", `/runs/${runId}/timeline`)).body.rows.filter((row) => row.kind === "phase" && WORDS.test(row.summary ?? ""));
/** The run's root entries, read once its process has let it go. */
const entries = (data, runId) => {
  const db = new DatabaseSync(join(runDir(data, runId), "store", "run.sqlite"), { readOnly: true });
  try { return db.prepare("SELECT record FROM entries ORDER BY rowid").all().map((row) => JSON.parse(String(row.record))); } finally { db.close(); }
};

test("pi: near its cap the model is told once, in the request it is sent, to finish; it answers, the turn ends under the cap, one row says so, and the transcript never holds the note", { timeout: 180_000 }, async (t) => {
  const calls = join(await scratch(t), "calls.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_CALLS: calls });
  const { api, data } = await serve(t, { faux: WRAPUP });
  assert.equal((await api("POST", "/agents", agent("wrap", { instructions: "Write the pages.", tools: ["write"] }))).status, 201);
  const started = await api("POST", "/agents/wrap/runs", { input: { content: "go" }, max_cost_usd: 0.5 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 150_000 });
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([run.status, run.result?.final_answer], ["completed", "Wrapping up: the pages so far are the answer."], JSON.stringify(run.pending ?? run.error));
  assert.ok(run.cost.usd <= 0.5, `under its cap: $${run.cost.usd}`);
  const rows = await rowsOf(api, runId);
  assert.equal(rows.length, 1, `one row: ${JSON.stringify(rows.map((r) => r.summary))}`);
  const seen = readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((call) => call.note);
  assert.equal(seen.length, 1, "the model saw the note in one request");
  assert.equal(`AgentRun: ${seen[0].note.replace(/^<system-reminder>|<\/system-reminder>$/g, "")}`, rows[0].summary, "the words it saw are the row's");
  await letGo(data, runId);
  assert.ok(!entries(data, runId).some((entry) => JSON.stringify(entry.model ?? []).includes("left of this run's budget")), "no entry of pi's transcript holds it");
});

test("pi: the final-answer request that carries the note is the run's last: no further request is sent, live or after a restart that comes after the answer", { timeout: 240_000 }, async (t) => {
  const dir = await scratch(t);
  const calls = join(dir, "calls.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_CALLS: calls });
  const data = join(dir, "agents");
  let stopFirst;
  const { api } = await serve({ after: (stop) => void (stopFirst = stop) }, { faux: WRAPUP, data });
  assert.equal((await api("POST", "/agents", agent("wrap-last", { instructions: "Write the pages.", tools: ["write"] }))).status, 201);
  const runId = (await api("POST", "/agents/wrap-last/runs", { input: { content: "go" }, max_cost_usd: 0.5 })).body.run_id;
  await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 150_000 });
  assert.equal((await api("GET", `/runs/${runId}`)).body.status, "completed");
  const requests = () => readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const answered = requests();
  assert.ok(answered.at(-1).note, "the run's last request carried the note: its answer ended the turn");
  // Live: whatever would follow the answer (a queued steer runs one more request after a request with no tool call,
  // pi-agent-core's loop) has had its chance.
  await letGo(data, runId);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  assert.equal(requests().length, answered.length, "no request after the answer");
  // After a restart: a server started again on the same data reads the run whole, and sends nothing for it.
  await stopFirst();
  const again = await serve(t, { faux: WRAPUP, data });
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  assert.equal((await again.api("GET", `/runs/${runId}`)).body.status, "completed");
  assert.equal(requests().length, answered.length, "none after the restart either");
});

test("claude-agent on the faux harness: near its cap a main-model request carries the words, once, and one row says so", { timeout: 180_000 }, async (t) => {
  const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS, faux: WRAPUP });
  assert.equal((await api("POST", "/agents", agent("wrap-h", { harness: "claude-agent", instructions: "Grow a cached context." }))).status, 201);
  const started = await api("POST", "/agents/wrap-h/runs", { input: { content: "go" }, max_cost_usd: 0.5 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 150_000 });
  const rows = await rowsOf(api, runId);
  assert.equal(rows.length, 1, `one row: ${JSON.stringify(rows.map((r) => r.summary))}`);
  await letGo(data, runId);
  const db = new DatabaseSync(join(runDir(data, runId), "store", "run.sqlite"), { readOnly: true });
  const notes = db.prepare("SELECT record FROM entries").all().map((row) => JSON.parse(String(row.record))).filter((record) => record.kind === "faux.note");
  db.close();
  assert.deepEqual(notes.map((record) => `AgentRun: ${record.data.text}`), [rows[0].summary], "the session's next main-model request took the words, once");
});

test("claude-agent on the faux harness: a crash after the wrap-up came due and before the next request: the process that opens the run again sends the note in its first request, once, with what is left then", { timeout: 180_000 }, async (t) => {
  const go = join(await scratch(t), "go");
  const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS, faux: OUTPUT_PRICED });
  assert.equal((await api("POST", "/agents", agent("crash-h", { harness: "claude-agent", instructions: `Wrap up across a crash at ${go}.` }))).status, 201);
  const started = await api("POST", "/agents/crash-h/runs", { input: { content: "go" }, max_cost_usd: 1 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  // The $0.30 request is answered and booked; the turn holds with no request open: $0.70 left, under 3 x $0.30.
  for (const end = Date.now() + 60_000; !existsSync(`${go}.held`); await new Promise((resolve) => setTimeout(resolve, 50))) assert.ok(Date.now() < end, "the turn reached its hold");
  await writeFile(go, "");
  process.kill(runRecordOf(data, runId).holder.pid, "SIGKILL");
  await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 150_000 });
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([run.status, run.result?.final_answer], ["completed", "Done."], JSON.stringify(run.pending ?? run.error));
  const rows = await rowsOf(api, runId);
  assert.deepEqual(rows.map((row) => row.text), [WRAP_UP("$0.70")], "one row, in the words the request carried");
  await letGo(data, runId);
  assert.deepEqual(notesOf(data, runId), [WRAP_UP("$0.70")], "the next request, in the process opened again, carried the note, once");
});

test("claude-agent on the faux harness: a turn that ends on the request after which the wrap-up comes due: the next turn's first request carries the note, with what is left then, and its row follows that turn's message", { timeout: 180_000 }, async (t) => {
  const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS, faux: OUTPUT_PRICED });
  assert.equal((await api("POST", "/agents", agent("next-h", { harness: "claude-agent", instructions: "Wrap up in the next turn." }))).status, 201);
  const started = await api("POST", "/agents/next-h/runs", { input: { content: "go" }, max_cost_usd: 1 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 60_000 });
  assert.deepEqual(await rowsOf(api, runId), [], "no row while no request has carried the note");
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "go on" })).status, 202);
  const { rows } = await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 60_000 });
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([run.status, run.result?.final_answer], ["completed", "Second."], JSON.stringify(run.pending ?? run.error));
  // $0.40 spent: $0.60 left, under 3 x $0.40, read as the follow-up's first request takes the note.
  assert.deepEqual(said(rows), ["go", "go on", WRAP_UP("$0.60")], "the row after the turn's message, in the words it carried");
  await letGo(data, runId);
  assert.deepEqual(notesOf(data, runId), [WRAP_UP("$0.60")], "the follow-up's first request carried the note, once");
});

test("claude-agent on the faux harness: a request that fits what is left of the cap only without the note's bytes is sent without it, never refused, and the note stays untold", { timeout: 180_000 }, async (t) => {
  const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS, faux: new URL("./fixtures/faux-input-priced.mjs", import.meta.url).pathname });
  assert.equal((await api("POST", "/agents", agent("room-h", { harness: "claude-agent", instructions: "Wrap up with no room for the note." }))).status, 201);
  // Strict: every input priced uncached, so the answer's 5,990 tokens hold $0.599 of the $0.60 left after the $0.40 request.
  const started = await api("POST", "/agents/room-h/runs", { input: { content: "go" }, max_cost_usd: 1, cap_mode: "strict" });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 60_000 });
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([run.status, run.pending?.kind ?? null, run.result?.final_answer], ["completed", null, "Answered."], `the answer that fits is sent: ${JSON.stringify(run.pending ?? run.error)}`);
  assert.deepEqual(await rowsOf(api, runId), [], "no row: no request carried the note");
  await letGo(data, runId);
  assert.deepEqual(notesOf(data, runId), [], "the answer went without the note");
});

test("claude-agent on the faux harness: a side call admitted between the note's take and the admission of the request carrying it leaves the note told once, with one row", { timeout: 180_000 }, async (t) => {
  const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS, faux: OUTPUT_PRICED });
  assert.equal((await api("POST", "/agents", agent("side-h", { harness: "claude-agent", instructions: "Wrap up with a side call in between." }))).status, 201);
  const started = await api("POST", "/agents/side-h/runs", { input: { content: "go" }, max_cost_usd: 1 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 60_000 });
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([run.status, run.result?.final_answer], ["completed", "Done."], JSON.stringify(run.pending ?? run.error));
  // $0.40 spent: $0.60 left, under 3 x $0.40, as request 1 takes the note; the side call's admission comes before its own.
  assert.deepEqual((await rowsOf(api, runId)).map((row) => row.text), [WRAP_UP("$0.60")], "one row");
  await letGo(data, runId);
  assert.deepEqual(notesOf(data, runId), [WRAP_UP("$0.60")], "the note went once: request 2 did not take it again");
});
