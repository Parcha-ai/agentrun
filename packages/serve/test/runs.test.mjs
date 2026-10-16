// Runs end to end: a child process per run on the faux model, read through its door and then from its released store.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { readAgentHome } from "@parcha/pi-durable-agent";
import { startServe } from "../dist/index.js";
import { client, FAUX, follow, scratch, serve, startRun } from "./support.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a run starts queued, its timeline follows it to completed and final, and the runs index and the home record it", async (t) => {
  const { api, data } = await serve(t);
  const started = await startRun(api, "calc", "What is six times seven?");
  const etag = (await api("GET", "/agents/calc")).headers.get("etag");
  assert.match(etag, /^"\d+"$/, "the home's revision");
  assert.deepEqual([started.status, started.state, started.result, started.agent_version], ["queued", "working", null, 1]);
  const { rows, pages, last } = await follow(api, started.run_id, ["completed"]);
  assert.equal(pages[0].reset, true);
  assert.equal(last.final, true);
  assert.deepEqual(rows.map((r) => r.kind), ["user_message", "thinking", "final_answer", "usage"]);
  assert.ok(rows.every((r, i) => i === 0 || r.seq > rows[i - 1].seq), "rows sort by seq");
  const run = (await api("GET", `/runs/${started.run_id}`)).body;
  assert.equal(run.status, "completed");
  assert.equal(run.state, "idle");
  assert.equal(run.result.final_answer, "The answer is 42.");
  assert.equal(run.result.output, null, "no output_schema, no output");
  assert.equal(run.cost.basis, "estimate");
  assert.equal(typeof run.ended_at, "string");
  const index = (await api("GET", "/agents/calc/runs")).body.runs;
  assert.deepEqual(index.map((r) => [r.run_id, r.status]), [[started.run_id, "completed"]]);
  const carried = await api("GET", "/agents/calc");
  assert.notEqual(carried.headers.get("etag"), etag, "the carry back is a write, so the revision moved");
  assert.equal(carried.headers.get("etag"), carried.body.home_etag);
  assert.deepEqual(carried.body.runs, { count: 1, live: 0 });
  const home = await readAgentHome({ dir: join(data, "calc") });
  assert.equal(home.runs[started.run_id].outcome, "completed");
  assert.equal(home.runs[started.run_id].finalAnswer, "The answer is 42.");
  const after = await api("POST", `/runs/${started.run_id}/messages`, { content: "again" });
  assert.equal(after.status, 409);
  assert.equal(after.body.error.code, "not_continuable");
  assert.deepEqual(after.body.error.next_action, { type: "request", method: "POST", path: "/agents/calc/runs", caller_supplies: ["input", "Idempotency-Key"] });
});

test("the change cursor: a saved cursor resumes onto the rows held, 0 resets, and the final cursor answers unchanged", async (t) => {
  const { api } = await serve(t);
  const { run_id } = await startRun(api, "calc", "What is six times seven?");
  const first = await follow(api, run_id, ["completed"]);
  const mid = first.pages[0].next_after;
  const resumed = await follow(api, run_id, ["completed"], { after: mid });
  assert.equal(resumed.pages.filter((p) => p.reset).length, 0);
  const fresh = await follow(api, run_id, ["completed"]);
  assert.deepEqual(fresh.rows, first.rows);
  const end = await api("GET", `/runs/${run_id}/timeline?after=${first.after}`);
  assert.deepEqual([end.body.reset, end.body.rows, end.body.drop, end.body.unchanged, end.body.has_more, end.body.final], [false, [], [], true, false, true]);
  const ahead = await api("GET", `/runs/${run_id}/timeline?after=${first.after + 1}`);
  assert.equal(ahead.body.reset, true, "a cursor ahead of the run answers every row");
  assert.equal((await api("GET", `/runs/${run_id}/timeline?after=-1`)).status, 400);
});

test("ask_person makes the run input_required and waiting; a message answers it (mode answer) and the run completes", async (t) => {
  const { api } = await serve(t);
  const { run_id } = await startRun(api, "regions", "Pick a region.", { tools: ["ask_person"] });
  const waiting = await follow(api, run_id, ["input_required"]);
  assert.equal(waiting.last.state, "waiting");
  const row = waiting.rows.find((r) => r.kind === "waiting");
  assert.equal(row.summary, "Waiting for you: Which region should I use?");
  assert.deepEqual([(await api("GET", `/runs/${run_id}`)).body.status, (await api("GET", `/runs/${run_id}`)).body.ended_at], ["input_required", null]);
  const answer = await api("POST", `/runs/${run_id}/messages`, { content: "EU" });
  assert.equal(answer.status, 202);
  assert.equal(answer.body.mode, "answer");
  const done = await follow(api, run_id, ["completed"], { after: waiting.after });
  assert.equal(done.pages.filter((p) => p.reset).length, 0);
  assert.deepEqual((await api("GET", `/runs/${run_id}`)).body.result, { output: null, final_answer: '{"region":"EU"}' }, "no output_schema, no output");
});

test("stop ends the turn and leaves the run input_required and idle; a message then is a follow-up and the run goes on", async (t) => {
  const { api } = await serve(t);
  const { run_id } = await startRun(api, "slow", "Take your time.");
  for (let i = 0; (await api("GET", `/runs/${run_id}`)).body.state !== "working" || (await api("GET", `/runs/${run_id}`)).body.status !== "working"; i++) {
    assert.ok(i < 200, "the run starts working");
    await sleep(50);
  }
  const stop = await api("POST", `/runs/${run_id}/stop`);
  assert.deepEqual(stop.body, { run_id, stopped: true, status: "input_required", state: "idle" });
  const stopped = await follow(api, run_id, ["input_required"]);
  assert.equal(stopped.last.state, "idle");
  assert.deepEqual((await api("POST", `/runs/${run_id}/stop`)).body.stopped, false, "nothing to stop");
  const next = await api("POST", `/runs/${run_id}/messages`, { content: "go on" });
  assert.equal(next.body.mode, "follow_up");
  await follow(api, run_id, ["completed"]);
  assert.equal((await api("GET", `/runs/${run_id}`)).body.result.final_answer, "On go on: done.");
});

test("cancel ends a working run cancelled once its process has exited; a second cancel says it already ended", async (t) => {
  const { api } = await serve(t);
  const { run_id } = await startRun(api, "slow", "Take your time.");
  const cancel = await api("POST", `/runs/${run_id}/cancel`);
  assert.equal(cancel.status, 202);
  assert.deepEqual([cancel.body.cancel_requested, cancel.body.already_terminal], [true, false]);
  const { last } = await follow(api, run_id, ["cancelled"]);
  assert.equal(last.final, true);
  const again = await api("POST", `/runs/${run_id}/cancel`);
  assert.deepEqual([again.body.cancel_requested, again.body.already_terminal, again.body.status], [false, true, "cancelled"]);
  assert.equal((await api("POST", `/runs/${run_id}/messages`, { content: "x" })).body.error.code, "not_continuable");
});

test("a model failure ends the run failed with run_failed", async (t) => {
  const { api } = await serve(t);
  const failed = await startRun(api, "broken", "Fail now.");
  await follow(api, failed.run_id, ["failed"]);
  const run = (await api("GET", `/runs/${failed.run_id}`)).body;
  assert.equal(run.error.code, "run_failed");
  assert.match(run.error.message, /failed on purpose/);
  assert.equal(run.result, null);
});

test("with an output_schema the output is the final answer parsed as a JSON object; an answer that misses the schema ends output_invalid", async (t) => {
  const { api } = await serve(t);
  const schema = { output_schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] } };
  const typed = await startRun(api, "typed", "Answer as JSON.", schema);
  await follow(api, typed.run_id, ["completed"]);
  assert.deepEqual((await api("GET", `/runs/${typed.run_id}`)).body.result.output, { answer: 42 });
  for (const content of ["Answer wrongly as JSON.", "What is six times seven?"]) {
    const run = (await api("POST", "/agents/typed/runs", { input: { content } })).body;
    await follow(api, run.run_id, ["failed"]);
    const failed = (await api("GET", `/runs/${run.run_id}`)).body;
    assert.equal(failed.error.code, "output_invalid", content);
    assert.equal(failed.result, null);
  }
  const untyped = await startRun(api, "untyped", "Answer as JSON.");
  await follow(api, untyped.run_id, ["completed"]);
  assert.equal((await api("GET", `/runs/${untyped.run_id}`)).body.result.output, null, "no output_schema, no output");
});

test("ask_person reaches only an agent that names it: one that does not goes on without asking", async (t) => {
  const { api } = await serve(t);
  const { run_id } = await startRun(api, "silent", "Pick a region.");
  const { rows } = await follow(api, run_id, ["completed"]);
  assert.equal(rows.some((r) => r.kind === "waiting"), false);
  assert.equal((await api("GET", `/runs/${run_id}`)).body.result.final_answer, '{"region":"us"}');
});

test("a run whose cost estimate passes its max_cost_usd ends failed with spend_cap_reached", async (t) => {
  const { api } = await serve(t, { faux: new URL("./fixtures/faux-priced.mjs", import.meta.url).pathname });
  assert.equal((await api("POST", "/agents", { definition: { id: "pricey", version: 1, name: "pricey", instructions: "Answer.", skills: [], tools: [] } })).status, 201);
  const started = await api("POST", "/agents/pricey/runs", { input: { content: "What is six times seven?" }, max_cost_usd: 0.01 });
  assert.equal(started.body.cost.cap_usd, 0.01);
  await follow(api, started.body.run_id, ["failed"]);
  const run = (await api("GET", `/runs/${started.body.run_id}`)).body;
  assert.equal(run.error.code, "spend_cap_reached");
  assert.ok(run.cost.usd > 0.01);
});

test("the timeline as server-sent events: one rows event per change with id = next_after, then end terminal", async (t) => {
  const { baseUrl, token, api } = await serve(t);
  const { run_id } = await startRun(api, "calc", "What is six times seven?");
  const res = await fetch(`${baseUrl}/runs/${run_id}/timeline`, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" } });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const text = await res.text();
  const frames = text.split("\n\n").filter((f) => f.startsWith("event:"));
  const rows = frames.filter((f) => f.startsWith("event: rows"));
  assert.ok(rows.length >= 1);
  for (const frame of rows) {
    const id = Number(/^id: (\d+)$/m.exec(frame)[1]);
    const page = JSON.parse(/^data: (.*)$/m.exec(frame)[1]);
    assert.equal(page.next_after, id);
    assert.equal(page.poll_after_ms, undefined);
  }
  assert.equal(JSON.parse(/^data: (.*)$/m.exec(rows.at(-1))[1]).final, true);
  assert.equal(frames.at(-1), 'event: end\ndata: {"reason":"terminal"}');
  const resumed = await fetch(`${baseUrl}/runs/${run_id}/timeline`, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream", "last-event-id": /^id: (\d+)$/m.exec(rows.at(-1))[1] } });
  const tail = (await resumed.text()).split("\n\n").filter(Boolean);
  assert.equal(JSON.parse(/^data: (.*)$/m.exec(tail[0])[1]).unchanged, true, "Last-Event-ID resumes after the last change");
});

test("after a restart the runs are read from the agent home: status, result and rows, and an old cursor resets", async (t) => {
  const data = join(await scratch(t), "agents");
  const one = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  const api = client(one.baseUrl, one.token);
  const { run_id } = await startRun(api, "calc", "What is six times seven?");
  const before = await follow(api, run_id, ["completed"]);
  await one.close();
  const two = await startServe({ data, port: 0, faux: FAUX });
  t.after(() => two.close());
  const again = client(two.baseUrl, two.token);
  const run = (await again("GET", `/runs/${run_id}`)).body;
  assert.deepEqual([run.status, run.result.final_answer], ["completed", "The answer is 42."]);
  const page = (await again("GET", `/runs/${run_id}/timeline?after=${before.after}`)).body;
  assert.equal(page.reset, true);
  assert.equal(page.final, true);
  assert.deepEqual(page.rows.map((r) => r.kind), before.rows.map((r) => r.kind));
  assert.equal(JSON.parse(await readFile(join(data, "calc", "runs", run_id, "serve.json"), "utf8")).title, "What is six times seven?");
});
