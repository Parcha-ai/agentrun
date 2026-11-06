// The wrap-up end to end. pi: near its cap the run's model is told once, inside the request it is about to send ("About
// $X left of this run's budget: finish now with your answer."), and one row of the server's says so; pi's transcript never
// holds it and no input is queued, so the model's answer ends the turn. A next turn under the same cap is told nothing
// again. Another harness (the faux harness standing in for claude-agent): its guard arms the same words for the
// session's next main-model request, taken once (the model proxy adds them to its body), with the same row.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { agent, follow, letGo, runDir, scratch, serve, withEnv } from "./support.mjs";

const WRAPUP = new URL("./fixtures/faux-wrapup.mjs", import.meta.url).pathname;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const WORDS = /^AgentRun: About \$\d+\.\d\d left of this run's budget: finish now with your answer\.$/;
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

test("claude-agent on the faux harness: near its cap the guard arms the words for the session's next main-model request, taken once, and one row says so", { timeout: 180_000 }, async (t) => {
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
