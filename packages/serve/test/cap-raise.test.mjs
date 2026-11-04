// PATCH /runs/{id} {max_cost_usd} raises a run's spend cap, and only raises it. A run paused at its cap goes on: the
// server sends it one follow-up turn, "The cap was raised to $X; continue the task.", which its new process runs under
// the new cap; the refused request was never sent, so nothing is paid for twice. A working run's live process keeps
// its cap until its next process, and the answer says so. A server started again raises a paused run's cap the same.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { REQUEST_STARTED } from "@parcha/pi-durable-agent/timeline";
import { spentIn } from "../dist/cap.js";
import { startServe } from "../dist/index.js";
import { agent, client, follow, scratch, serve } from "./support.mjs";
import { DatabaseSync } from "node:sqlite";

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
