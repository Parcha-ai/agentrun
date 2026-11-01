// A run's end writes its metrics to the agent store: its tokens, requests, models and tool calls over every
// conversation of its store, the effort it ran at, and on a harness other than pi the model its revision names. A
// follow-up's end writes them again, and a run whose process died gets them from what its store holds.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { processAlive } from "@parcha/agentrun-kernel/host";
import { openStoreReader } from "@parcha/pi-durable-agent";
import { startServe } from "../dist/index.js";
import { agent, answerFlow, client, FAUX, flowAgent, follow, scratch, serve, startRun, storeRun, withEnv } from "./support.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const EFFORT_NAMES = ["AGENT_THINKING", "AGENTRUN_SERVE_EFFORT"];
const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const usageOf = (rows) => rows.findLast((r) => r.kind === "usage")?.usage;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function metricsOf(data, runId) {
  const reader = openStoreReader(data);
  try {
    return reader.runMetrics(runId);
  } finally {
    reader.close();
  }
}

/** The run's store entries, each with its conversation. */
function entriesOf(data, runId) {
  const db = new DatabaseSync(join(data, "runs", runId, "store", "run.sqlite"), { readOnly: true, timeout: 2_000 });
  try {
    return db.prepare("SELECT conversation_id, record FROM entries ORDER BY id").all().map((row) => ({ conversation: row.conversation_id, ...JSON.parse(String(row.record)) }));
  } finally {
    db.close();
  }
}

async function started(api, id, definition, body) {
  assert.equal((await api("POST", "/agents", agent(id, definition))).status, 201);
  const run = await api("POST", `/agents/${id}/runs`, body);
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body.run_id;
}

test("a pi run's end writes its tokens, requests, tool calls and errors, model and effort", async (t) => {
  withEnv(t, {}, EFFORT_NAMES);
  const { api, data } = await serve(t);
  const runId = await started(api, "notes", { tools: ["write", "read"] }, { input: { content: "Write a note, then read a missing one." }, effort: "high" });
  const { rows } = await follow(api, runId, ["completed"]);
  const m = metricsOf(data, runId);
  assert.ok(m, "the run has metrics");
  assert.ok(m.input > 0 && m.output > 0, `tokens counted: ${JSON.stringify(m)}`);
  assert.equal(m.requests, 3);
  assert.equal(m.requests, usageOf(rows).requests, "as many requests as the usage row says");
  assert.equal(m.unmetered, 0);
  assert.deepEqual(m.tools, { read: { calls: 1, errors: 1 }, write: { calls: 1, errors: 0 } });
  assert.deepEqual([m.model, m.models], ["faux/faux-1", { "faux/faux-1": 3 }]);
  assert.equal(m.effort, "high");
  assert.equal(m.activeMs, undefined, "a live run's active time is its end less its start, never stored");
});

test("the effort stored is the one the run's process took: the run's, else its revision's thinking, else the host's", async (t) => {
  withEnv(t, { AGENT_THINKING: "xhigh" }, EFFORT_NAMES);
  const { api, data } = await serve(t);
  const host = await started(api, "plain", {}, { input: { content: "hi" } });
  const revision = await started(api, "low", { thinking: "low" }, { input: { content: "hi" } });
  const run = await api("POST", "/agents/low/runs", { input: { content: "hi" }, effort: "medium" });
  for (const id of [host, revision, run.body.run_id]) await follow(api, id, ["completed"]);
  assert.deepEqual([host, revision, run.body.run_id].map((id) => metricsOf(data, id).effort), ["xhigh", "low", "medium"]);
});

test("a run its server's successor ends keeps the effort its process ran at, not the successor's host level", async (t) => {
  withEnv(t, { AGENT_THINKING: "low" }, EFFORT_NAMES);
  const dir = await scratch(t);
  const data = join(dir, "agents");
  // The first server in a process of its own, at the host level high, so it can die as a crash kills it.
  const first = spawn(process.execPath, [CLI, "--data", data, "--port", "0", "--faux", FAUX], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AGENT_THINKING: "high" } });
  t.after(() => first.kill("SIGKILL"));
  let out = "";
  first.stdout.on("data", (chunk) => (out += chunk));
  for (let i = 0; !/AGENTRUN_API_KEY=/.test(out); i++) {
    assert.ok(i < 200, `the server did not start: ${out}`);
    await sleep(50);
  }
  const api = client(/AGENTRUN_BASE_URL=(\S+)/.exec(out)[1], (await readFile(join(data, ".token"), "utf8")).trim());
  const go = join(dir, "go");
  const runId = await started(api, "later", {}, { input: { content: `Answer once ${go} exists.` } });
  for (let i = 0; (await api("GET", `/runs/${runId}`)).body.status !== "working"; i++) {
    assert.ok(i < 200, "the run works");
    await sleep(50);
  }
  first.kill("SIGKILL");
  await new Promise((resolve) => first.once("exit", resolve));
  const { holder } = JSON.parse(await readFile(join(data, "runs", runId, "run.json"), "utf8"));
  t.after(() => processAlive(holder.pid) && process.kill(holder.pid, "SIGKILL"));
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  await writeFile(go, "");
  await follow(client(next.baseUrl, next.token), runId, ["completed"]);
  assert.equal(JSON.parse(await readFile(join(data, "runs", runId, "run.json"), "utf8")).generation, 1, "the first process finished it");
  assert.equal(metricsOf(data, runId).effort, "high");
});

test("a run on the claude-agent or codex harness ends with metrics: its model the revision's, its effort the harness's", { timeout: 90_000 }, async (t) => {
  withEnv(t, {}, EFFORT_NAMES);
  const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS });
  const claude = await started(api, "claude", { harness: "claude-agent", model: "anthropic/claude-opus-5-5", instructions: "Make three requests." }, { input: { content: "hi" } });
  await follow(api, claude, ["completed"], { deadlineMs: 55_000 });
  const m = metricsOf(data, claude);
  // The faux harness books 10 input and 5 output tokens a request; the journal names the harness, not the model.
  assert.deepEqual([m.input, m.output, m.requests, m.unmetered], [30, 15, 3, 0]);
  assert.deepEqual([m.model, m.models], ["anthropic/claude-opus-5-5", { "claude-agent/claude-agent": 3 }]);
  assert.equal(m.tools.read.calls, 2);
  assert.equal(m.effort, "medium");
  // Codex takes no max: its process runs at xhigh, and the stored effort says so.
  const codex = await started(api, "codex", { harness: "codex", thinking: "max", instructions: "Say your thinking." }, { input: { content: "hi" } });
  await follow(api, codex, ["completed"], { deadlineMs: 55_000 });
  assert.equal((await api("GET", `/runs/${codex}`)).body.result.final_answer, "Thinking xhigh.");
  const c = metricsOf(data, codex);
  assert.deepEqual([c.effort, c.requests, c.model], ["xhigh", 1, "codex/codex"], "no model named: the journal's");
});

test("a follow-up on a completed run carries it back again with its counts updated", async (t) => {
  withEnv(t, {}, EFFORT_NAMES);
  const { api, data } = await serve(t);
  const { run_id: runId } = await startRun(api, "chat", "hi");
  await follow(api, runId, ["completed"]);
  const first = metricsOf(data, runId);
  assert.deepEqual([first.requests, first.effort], [1, "medium"]);
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "and then?" })).status, 202);
  const { rows } = await follow(api, runId, ["completed"]);
  const second = metricsOf(data, runId);
  assert.equal(second.requests, 2);
  assert.equal(second.requests, usageOf(rows).requests);
  assert.ok(second.input > first.input && second.output > first.output, "the follow-up's tokens are added");
  assert.ok(second.at > first.at, "written at the second end");
});

test("a run whose process died before it released the run gets its metrics from what its store holds", async (t) => {
  const { api, data } = await serve(t);
  const runId = await started(api, "crash", { tools: ["write"] }, { input: { content: "Crash after one request." } });
  await follow(api, runId, ["failed"]);
  assert.match((await api("GET", `/runs/${runId}`)).body.error.message, /exited \(3\) without releasing/);
  assert.equal(storeRun(data, runId).state, "failed");
  const m = metricsOf(data, runId);
  assert.ok(m, "the failed run has metrics");
  const answered = entriesOf(data, runId).filter((e) => e.kind === "pi.assistant");
  assert.equal(answered.length, 1, "one request answered before the process went");
  // The request it was making when it went was marked as it left and never answered: counted, its tokens unknown.
  assert.deepEqual([m.requests, m.unmetered], [2, 1]);
  assert.deepEqual([m.input, m.output], [answered[0].model[0].usage.input, answered[0].model[0].usage.output]);
  assert.deepEqual(m.tools, { write: { calls: 1, errors: 0 } });
  assert.equal(JSON.parse(await readFile(join(data, "runs", runId, "run.json"), "utf8")).generation, 1, "never opened again");
});

test("a workflow run's metrics count every model node's conversation", async (t) => {
  const { api, data } = await serve(t);
  const flow = answerFlow();
  flow.root.steps = [
    { node: "extract", label: "first", instructions: "Answer the question.", out: "Answer", as: "first" },
    { node: "extract", label: "answer", instructions: "Answer it again.", out: "Answer", as: "answer" },
  ];
  assert.equal((await api("POST", "/agents", flowAgent("twice", flow))).status, 201);
  const { body: run } = await api("POST", "/agents/twice/runs", { input: { question: "What is six times seven?" } });
  await follow(api, run.run_id, ["completed"]);
  const answers = entriesOf(data, run.run_id).filter((e) => e.kind === "pi.assistant");
  assert.ok(new Set(answers.map((e) => e.conversation)).size >= 2, "the nodes' requests are in conversations of their own");
  const m = metricsOf(data, run.run_id);
  assert.equal(m.requests, answers.length);
  assert.deepEqual(m.tools, { submit: { calls: 2, errors: 0 } });
});

test("metrics the store refuses never hold up a run's end: it ends without them", async (t) => {
  const { api, data } = await serve(t);
  const { run_id: runId } = await startRun(api, "long", "Call a tool with a long name.");
  await follow(api, runId, ["completed"]);
  assert.equal(storeRun(data, runId).state, "completed");
  assert.equal(metricsOf(data, runId), undefined);
});
