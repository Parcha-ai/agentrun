// A paid tool call the cap refuses for room pauses the run, as a refused model request does: the call is not sent, its
// result says so, and the model's next request is refused in the paid call's words, so the turn ends there and the run
// waits on a raise (input_required, waiting, pending kind budget) with the call's figures: what was taken, and the
// call's hold as what it needs. A raise sends the run on (#1642), and the model calls again: each call the model makes is
// one call, none of ours on top. Faux model and harness, faux monid: no key, no network.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { capModels, paidCall, useSpend } from "../dist/cap.js";
import { join } from "node:path";
import { test } from "node:test";
import { KEY } from "./fixtures/faux-monid.mjs";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const SETTLED = ["input_required", "completed", "failed", "cancelled"];
const ENDED = ["completed", "failed", "cancelled"];
const ASK = "Run monid's /person/enrich, called again after a raise.";
/** monid's run allowed: a catalog tool asks by default (tool-gate.ts), and these runs are about the cap, not the gate. */
const ALLOWED = { "monid.run": { permission: "allow" } };
/** The paid call's refusal, held at monid's run allowance ($1, no inspect quoted it), of a $0.5 cap: what the run has
 *  spent (the faux harness's requests cost $0.001 each, pi's faux model nothing) and any model request still held. */
const WORDS = /^Not sent: the run has spent \$[\d.]+( and holds \$[\d.]+ for calls still answering)? of its \$0\.50 cap, and monid_run could cost up to \$1 \(no monid_inspect in this run quoted its price, so it is held at the \$1 allowance; monid_inspect gives its quote\)\. Raise the cap to at least \$1\.\d\d to run it\.$/;
const view = async (api, runId) => (await api("GET", `/runs/${runId}`)).body;
const monidRuns = async (log) => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((call) => call.path === "/v1/run").length;

for (const harness of ["pi", "claude-agent", "codex"]) {
  test(`${harness}: a paid call the cap refuses for room pauses the run, its result saying it was not sent; a raise sends it on and the model's next call is made, once`, { timeout: 120_000 }, async (t) => {
    const log = join(await scratch(t), "monid-calls.jsonl");
    withEnv(t, { MONID_API_KEY: KEY, AGENTRUN_TEST_FAUX_MONID_CALLS: log });
    const { api } = await serve(t, { fauxMonid: FAUX_MONID, ...(harness === "pi" ? {} : { fauxHarness: FAUX_HARNESS }) });
    const id = `paid-${harness}`;
    assert.equal((await api("POST", "/agents", agent(id, { ...(harness === "pi" ? {} : { harness, instructions: ASK }), tools: ["monid.run"], tool_settings: ALLOWED }))).status, 201);
    const started = await api("POST", `/agents/${id}/runs`, { input: { content: ASK }, max_cost_usd: 0.5 });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const runId = started.body.run_id;
    const { rows } = await follow(api, runId, SETTLED, { deadlineMs: 60_000 });
    const paused = await view(api, runId);
    assert.deepEqual([paused.status, paused.state, paused.error, paused.pending?.kind], ["input_required", "waiting", null, "budget"], JSON.stringify(paused));
    const spent = paused.pending.spent_usd;
    assert.ok(spent >= 0 && spent < 0.01, `what was taken: ${spent}`);
    // Its figures: the cap, what was taken, the call's hold as its need, and the raise offered (spent + 10 x needs, up).
    assert.deepEqual([paused.pending.cap_usd, paused.pending.needs_usd, paused.pending.suggested_cap_usd], [0.5, 1, Math.ceil(spent + 10 - 1e-9)], JSON.stringify(paused.pending));
    assert.match(paused.pending.said, WORDS);
    assert.equal(await monidRuns(log), 0, "the refused call was not sent");
    const result = rows.find((row) => row.kind === "tool_result");
    assert.match(result?.text ?? result?.summary ?? "", /Not sent: .*monid_run could cost up to \$1/, JSON.stringify(result));
    // The suggested raise sends the run on, and the model calls again: that call is made, once.
    const raised = await api("PATCH", `/runs/${runId}`, { max_cost_usd: paused.pending.suggested_cap_usd });
    assert.deepEqual([raised.status, raised.body.resumed], [200, true], JSON.stringify(raised.body));
    await follow(api, runId, ENDED, { deadlineMs: 60_000 });
    const done = await view(api, runId);
    assert.deepEqual([done.status, done.error, done.cost.cap_usd], ["completed", null, paused.pending.suggested_cap_usd], JSON.stringify(done));
    assert.equal(await monidRuns(log), 1, "the call made after the raise, once");
  });
}

test("pi: after a raise, a model that calls twice makes two calls: none is added, and none retried", { timeout: 120_000 }, async (t) => {
  const log = join(await scratch(t), "monid-calls.jsonl");
  withEnv(t, { MONID_API_KEY: KEY, AGENTRUN_TEST_FAUX_MONID_CALLS: log });
  const { api } = await serve(t, { fauxMonid: FAUX_MONID });
  assert.equal((await api("POST", "/agents", agent("paid-twice", { tools: ["monid.run"], tool_settings: ALLOWED }))).status, 201);
  const started = await api("POST", "/agents/paid-twice/runs", { input: { content: "Run monid's /person/enrich, called again after a raise, twice." }, max_cost_usd: 0.5 });
  const runId = started.body.run_id;
  await follow(api, runId, SETTLED, { deadlineMs: 60_000 });
  assert.equal((await view(api, runId)).pending?.kind, "budget", "paused at its refused call");
  assert.equal((await api("PATCH", `/runs/${runId}`, { max_cost_usd: 10 })).status, 200);
  await follow(api, runId, ENDED, { deadlineMs: 60_000 });
  assert.equal((await view(api, runId)).status, "completed");
  assert.equal(await monidRuns(log), 2, "the model's two calls after the raise, and the refused one never sent");
});

/** serve's gateway for an opencode run, on loopback: its Responses requests answered in order by `answers` (a call of
 *  monid's run, or text), each with a little usage; `outputs`, each request's tool results as the model reads them. */
async function gateway(t, answers) {
  const seen = [];
  const outputs = [];
  const server = createServer(async (req, res) => {
    if (!req.url?.startsWith("/v1/")) return void res.writeHead(404).end();
    let body = "";
    for await (const chunk of req) body += chunk;
    outputs.push((JSON.parse(body).input ?? []).filter((item) => item.type === "function_call_output").map((item) => item.output));
    const answer = answers[Math.min(seen.length, answers.length - 1)];
    seen.push(req.url);
    const item = answer === "call" ? { type: "function_call", call_id: `call_${seen.length}`, name: "hands_monid_run", arguments: JSON.stringify({ provider: "faux", endpoint: "/person/enrich", input: { name: "Ada" } }) } : undefined;
    const events = [...(item ? [{ type: "response.output_item.done", item }] : [{ type: "response.output_text.delta", delta: answer }]), { type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 10 } } }];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { seen, outputs, origin: `http://127.0.0.1:${server.address().port}` };
}

test("opencode: a paid call the cap refuses for room pauses the run, its result saying it was not sent; a raise sends the request after it on", { timeout: 120_000 }, async (t) => {
  // The model calls monid's run, then (its next request refused, the run paused, its cap raised) answers. The stand-in
  // runs on a real gateway, so serve runs no faux module, faux monid's among them: nothing here may reach monid, and
  // what says the call was not sent is the result the model reads and a cost with no monid charge in it.
  const gw = await gateway(t, ["call", "Ran."]);
  const standIn = join(await scratch(t), "opencode-stand-in.mjs");
  await copyFile(fileURLToPath(new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url)), standIn);
  withEnv(t, {
    MONID_API_KEY: KEY,
    AGENTRUN_OPENCODE_STANDIN: "1", AGENTRUN_SERVE_OPENCODE_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn] }),
    AGENT_MODEL_BASE_URL: gw.origin, AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`, AGENT_MODEL_PRICE: "1,2,0.5",
  });
  const { api } = await serve(t, { faux: undefined });
  assert.equal((await api("POST", "/agents", agent("paid-opencode", { harness: "opencode", tools: ["monid.run"], tool_settings: ALLOWED }))).status, 201);
  const started = await api("POST", "/agents/paid-opencode/runs", { input: { content: ASK }, max_cost_usd: 0.5 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, SETTLED, { deadlineMs: 60_000 });
  const paused = await view(api, runId);
  assert.deepEqual([paused.status, paused.state, paused.error, paused.pending?.kind, paused.pending?.needs_usd], ["input_required", "waiting", null, "budget", 1], JSON.stringify(paused));
  assert.match(paused.pending.said, WORDS);
  assert.equal(gw.seen.length, 1, "the request after the refused call refused before the gateway");
  const raised = await api("PATCH", `/runs/${runId}`, { max_cost_usd: paused.pending.suggested_cap_usd });
  assert.deepEqual([raised.status, raised.body.resumed], [200, true], JSON.stringify(raised.body));
  await follow(api, runId, ENDED, { deadlineMs: 60_000 });
  const done = await view(api, runId);
  assert.deepEqual([done.status, done.result?.final_answer, gw.seen.length], ["completed", "Ran.", 2], JSON.stringify(done));
  // What the model read of its call, in the request the raise sent on: the cap's refusal, the call not sent.
  assert.equal(gw.outputs[1].length, 1, JSON.stringify(gw.outputs));
  assert.match(JSON.parse(gw.outputs[1][0]).error, /^spend_cap_reached: Not sent: /);
  // Two requests at $0.00012 (100 in at $1/M, 10 out at $2/M), and no monid charge.
  assert.equal(Math.round(done.cost.usd * 1e6) / 1e6, 0.00024, JSON.stringify(done.cost));
});

test("claude-agent: a turn stopped between a refused paid call and its next request leaves no pause behind: the person's next message runs, never refused for the call they moved on from", { timeout: 120_000 }, async (t) => {
  const log = join(await scratch(t), "monid-calls.jsonl");
  const signal = join(await scratch(t), "held");
  withEnv(t, { MONID_API_KEY: KEY, AGENTRUN_TEST_FAUX_MONID_CALLS: log });
  const { api } = await serve(t, { fauxMonid: FAUX_MONID, fauxHarness: FAUX_HARNESS });
  const held = `Run monid's /person/enrich, then hold the turn (signal ${signal}).`;
  assert.equal((await api("POST", "/agents", agent("paid-stopped", { harness: "claude-agent", instructions: held, tools: ["monid.run"], tool_settings: ALLOWED }))).status, 201);
  const started = await api("POST", "/agents/paid-stopped/runs", { input: { content: "go" }, max_cost_usd: 0.5 });
  const runId = started.body.run_id;
  // The call refused (its result says so), the turn holding with no request open: the person stops it there.
  for (let i = 0; !existsSync(signal); i++) {
    assert.ok(i < 600, "the turn holds after the refused call");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok((await api("POST", `/runs/${runId}/stop`)).status < 300);
  await follow(api, runId, ["input_required", "completed", "failed", "cancelled"], { deadlineMs: 30_000 });
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "Go on without it." })).status, 202);
  await follow(api, runId, ENDED, { deadlineMs: 60_000 });
  const done = await view(api, runId);
  assert.deepEqual([done.status, done.error, done.pending, done.result?.final_answer], ["completed", null, null, "Ran."], JSON.stringify(done));
  assert.equal(await monidRuns(log), 0, "the refused call never sent");
});

test("pi: a paid call's refusal pauses only the turn's next request, the one after its result; a request after a message of the person's (a stop came first) is judged as any other", async (t) => {
  const sent = [];
  const send = () => {
    const events = createAssistantMessageEventStream();
    sent.push(events);
    queueMicrotask(() => {
      const message = { role: "assistant", content: [{ type: "text", text: "ok" }], api: "fake", provider: "fake", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
      events.push({ type: "done", reason: "stop", message });
      events.end(message);
    });
    return events;
  };
  const models = { stream: send, streamSimple: send, complete: (...a) => send(...a).result(), completeSimple: (...a) => send(...a).result(), streamDeferred: send, fetchDeferred: (...a) => send(...a).result() };
  const model = { id: "m", name: "m", api: "fake", provider: "fake", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 1_000 };
  t.after(() => useSpend(undefined));
  const capped = await capModels(models, 0.5, 0);
  const afterResult = { messages: [{ role: "user", content: "go", timestamp: 0 }, { role: "toolResult", toolCallId: "c1", toolName: "monid_run", content: [{ type: "text", text: "Not sent" }], isError: true, timestamp: 1 }] };
  const afterPerson = { messages: [...afterResult.messages, { role: "user", content: "Go on without it.", timestamp: 2 }] };
  const hold = { usd: 1, basis: "the allowance" };
  // The turn's next request, after the refused call's result: refused in the call's words.
  assert.ok("refused" in (await paidCall("monid_run", async () => 0, () => 0, hold)));
  const next = await capped.streamSimple(model, afterResult).result();
  assert.match(next.errorMessage ?? "", /^spend_cap_reached \(out of budget\): Not sent: the run has spent \$0 of its \$0\.50 cap, and monid_run could cost up to \$1 \(the allowance\)\./);
  assert.equal(sent.length, 0, "not sent");
  // A refusal a stop left behind, and the person's next message: that request goes.
  assert.ok("refused" in (await paidCall("monid_run", async () => 0, () => 0, hold)));
  const after = await capped.streamSimple(model, afterPerson).result();
  assert.deepEqual([after.stopReason, sent.length], ["stop", 1], JSON.stringify(after));
});
