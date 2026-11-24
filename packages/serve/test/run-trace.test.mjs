// A run's trace (GET /runs/{id}/trace, run-trace.ts): each model request and each tool call as one span. What a span says
// is the run's own record: a request's tokens and cost are its answer's, the costs sum to the run's cost, a call hangs
// under the request that made it and takes no longer than its result says, and what a record does not keep is said so
// (a CLI harness's requests), never filled in.
import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { traceApprovals, traceSpans, TRACE_SPANS_MAX } from "../dist/run-trace.js";
import { answersOf, asksOf, withApprovalRows } from "../dist/run-view.js";
import { piShaped, withPaidCosts } from "../dist/store-reads/journal.js";
import { timelineOf } from "../dist/timeline/index.js";
import { agent, follow, serve } from "./support.mjs";

const FAUX = new URL("./fixtures/faux-read-notes-priced.mjs", import.meta.url).pathname;
const T0 = Date.parse("2026-11-17T20:00:00.000Z");
const at = (ms) => new Date(T0 + ms).toISOString();

/** The Timeline rows of `entries`, as a run's read renders them (store-reads/journal.ts runTimeline, with no store). */
const rowsOf = (entries) => timelineOf(withPaidCosts(piShaped(entries)), { settled: true });

const usage = (input, output, cacheRead, cacheWrite, total, parts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, more = {}) => ({ input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { ...parts, total }, ...more });
const answer = (id, ms, took, content, use, extra = {}) => ({ id, conversationId: 0, kind: "pi.assistant", model: [{ role: "assistant", provider: "agentrun-session", model: "claude-sonnet-5-5", content, usage: use, stopReason: content.some((c) => c.type === "toolCall") ? "toolUse" : "stop", timestamp: T0 + ms, ...(took === undefined ? {} : { durationMs: took }), ...extra }] });
const result = (id, ms, callId, text, extra = {}) => ({ id, conversationId: 0, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: callId, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: T0 + ms, ...extra }] });
const call = (id, name, args = {}) => ({ type: "toolCall", id, name, arguments: args });

test("a pi run's trace: each answered request with its tokens, cost and time; each call under its request, as long as its result says", () => {
  const entries = [
    { id: 1, conversationId: 0, kind: "pi.user", model: [{ role: "user", content: "Read the notes.", timestamp: T0 }] },
    answer(2, 100, 900, [call("c1", "read", { path: "notes.txt" }), call("c2", "read", { path: "more.txt" })], usage(1200, 40, 0, 800, 0.0123)),
    // c1's result keeps how long the tool ran; c2's does not (a legacy result).
    result(3, 1400, "c1", "The notes.", { durationMs: 250 }),
    result(4, 1600, "c2", "More."),
    answer(5, 1700, 500, [{ type: "text", text: "Done." }], usage(2, 12, 2040, 60, 0.0011)),
  ];
  const trace = traceSpans(rowsOf(entries), entries);
  assert.equal(trace.model_requests, "priced");
  assert.equal(trace.dropped, 0);
  assert.deepEqual(trace.spans.map((s) => `${s.kind} ${s.name} ${s.status}`), ["model claude-sonnet-5-5 ok", "tool read ok", "tool read ok", "model claude-sonnet-5-5 ok"]);
  const [first, c2, c1, last] = [trace.spans[0], trace.spans.find((s) => s.tool_use_id === "c2"), trace.spans.find((s) => s.tool_use_id === "c1"), trace.spans[3]];
  assert.deepEqual([first.started_at, first.ended_at, first.stop_reason, first.usd], [at(100), at(1000), "toolUse", 0.0123]);
  assert.deepEqual(first.tokens, { input: 1200, cache_read: 0, cache_write: 800, output: 40 });
  assert.deepEqual(last.tokens, { input: 2, cache_read: 2040, cache_write: 60, output: 12 });
  assert.equal(last.parent_id, null);
  // c1 ran for the 250 ms its result says, ending when the result was written; c2 from its request's end to its result.
  assert.deepEqual([c1.parent_id, c1.started_at, c1.ended_at], [first.id, at(1150), at(1400)]);
  assert.deepEqual([c2.parent_id, c2.started_at, c2.ended_at], [first.id, at(1000), at(1600)]);
  assert.deepEqual([c1.usd, c1.charged, c1.not_metered, c1.result_size_bytes], [null, false, false, Buffer.byteLength("The notes.")]);
  assert.equal(new Set(trace.spans.map((s) => s.id)).size, 4, "each span has its own id");
});

test("a request cut before its end has no tokens and no cost; one the cap refused before it left is no span; a call with no result is running", () => {
  const entries = [
    { id: 1, conversationId: 0, kind: "pi.user", model: [{ role: "user", content: "Go.", timestamp: T0 }] },
    answer(2, 100, 300, [{ type: "text", text: "partial" }], usage(900, 5, 0, 0, 0.004), { stopReason: "aborted" }),
    { id: 3, conversationId: 0, kind: "agentrun.request_started", data: { capRefused: true } },
    answer(4, 500, undefined, [], usage(0, 0, 0, 0, 0), { stopReason: "error", errorMessage: "spend_cap_reached: Not sent: the run's spend cap refused the request." }),
    answer(6, 900, 200, [call("c9", "read", { path: "notes.txt" })], usage(900, 5, 0, 0, 0.004)),
  ];
  const trace = traceSpans(timelineOf(piShaped(entries), {}), entries);
  assert.deepEqual(trace.spans.map((s) => [s.kind, s.status, s.tokens, s.usd, s.ended_at]), [
    ["model", "interrupted", null, null, at(400)],
    ["model", "ok", { input: 900, cache_read: 0, cache_write: 0, output: 5 }, 0.004, at(1100)],
    ["tool", "running", null, null, null],
  ]);
});

/** A run whose one call asked for approval: its entries, then its trace as served (the Timeline's approval rows over the
 *  rendered rows, and the approvals read from the journal), for a run `settled` or not and `final` in a state. */
const heldRun = (after, { settled = false, final } = {}) => {
  const entries = [
    answer(2, 0, 100, [call("held", "write", { path: "a.md" })], usage(10, 1, 0, 0, 0.001)),
    { id: 3, conversationId: 0, kind: "agentrun.ask", data: { callId: "held", tool: "write", args: { path: "a.md" }, requestedAt: at(200) } },
    ...after,
  ];
  const rows = withApprovalRows(timelineOf(piShaped(entries), { settled }), asksOf(entries), answersOf(entries, final ? { final } : {}), (text) => text);
  return traceSpans(rows, entries, { approvals: traceApprovals(entries, final) }).spans.find((s) => s.kind === "tool");
};
const answered = (id, ms, data) => ({ id, conversationId: 0, kind: "agentrun.answer", data: { callId: "held", answeredAt: at(ms), ...data } });

test("a call that asked for approval ends as its approval did: it waits, it ran once allowed, it was refused, or it was withdrawn with its run", () => {
  const span = (after, options) => { const s = heldRun(after, options); return [s.id, s.status, s.ended_at, s.result_preview]; };
  // No answer yet: it waits, with no end.
  assert.deepEqual(span([]), ["t:0:held", "waiting", null, null]);
  // Allowed, not run yet: it runs. Allowed and run: the same span, ended when its result was written.
  assert.deepEqual(span([answered(4, 5000, { approved: true })]), ["t:0:held", "running", null, null]);
  assert.deepEqual(span([answered(4, 5000, { approved: true }), result(5, 5200, "held", "Wrote a.md")]), ["t:0:held", "ok", at(5200), "Wrote a.md"]);
  // Denied: refused, when the answer was given.
  assert.deepEqual(span([answered(4, 6000, { approved: false })]).slice(0, 3), ["t:0:held", "refused", at(6000)]);
  // Withdrawn when the run was cancelled or stopped: it never ran, and ended then. Never left waiting.
  assert.deepEqual(span([answered(4, 7000, { decision: "canceled" })], { settled: true }), ["t:0:held", "interrupted", at(7000), null]);
  assert.deepEqual(span([answered(4, 8000, { decision: "withdrawn" })], { settled: true }), ["t:0:held", "interrupted", at(8000), null]);
  // A run that ended with the call unanswered (no answer in its journal): withdrawn at a time the record does not keep.
  assert.deepEqual(span([{ id: 4, conversationId: 0, kind: "agentrun.end", data: { state: "failed" } }], { settled: true }), ["t:0:held", "interrupted", null, null]);
  assert.deepEqual(span([], { settled: true, final: "stopped" }), ["t:0:held", "interrupted", null, null]);
});

test("a call cut with no result is interrupted, with no end: the row the Timeline closes it with gives it neither a failure nor a time", () => {
  const entries = [
    answer(2, 0, 100, [call("cut", "read", { path: "a.txt" })], usage(10, 1, 0, 0, 0.001)),
    // The run went on an hour later, with no result for the call ever written.
    { id: 3, conversationId: 0, kind: "pi.user", model: [{ role: "user", content: "Go on.", timestamp: T0 + 3_600_000 }] },
    answer(4, 3_600_100, 100, [{ type: "text", text: "Done." }], usage(10, 1, 0, 0, 0.001)),
  ];
  // Not settled, the call still runs; settled, the Timeline closes it with a row of its own.
  assert.equal(traceSpans(timelineOf(piShaped(entries), {}), entries).spans.find((s) => s.kind === "tool").status, "running");
  const cut = traceSpans(rowsOf(entries), entries).spans.find((s) => s.kind === "tool");
  assert.deepEqual([cut.status, cut.started_at, cut.ended_at, cut.result_preview, cut.result_size_bytes], ["interrupted", at(100), null, null, null]);
});

test("a span's parent is its own conversation's: a nested call under the call it ran in, a subagent's requests under the call that started it, though another conversation made a call of the same id", () => {
  const inConv = (entry, conversationId) => ({ ...entry, conversationId });
  const entries = [
    answer(1, 0, 100, [call("p", "codemode", { script: "1" })], usage(10, 1, 0, 0, 0.001)),
    // A call the script made, kept by the loop's record: nested under conversation 0's `p`.
    { id: 2, conversationId: 0, kind: "agentrun.call.start", data: { callId: "p/n1", tool: "read", input: { path: "a.txt" }, replaySafe: true, at: T0 + 150 } },
    { id: 3, conversationId: 0, kind: "agentrun.call.end", data: { callId: "p/n1", status: "done", output: "a", at: T0 + 180 } },
    // The call started a subagent (conversation 7), whose own first call has the same id.
    result(4, 900, "p", "done", { details: { conversationId: 7 } }),
    inConv(answer(5, 300, 100, [call("p", "read", { path: "b.txt" })], usage(10, 1, 0, 0, 0.001)), 7),
    inConv(result(6, 500, "p", "b"), 7),
  ];
  const spans = Object.fromEntries(traceSpans(rowsOf(entries), entries).spans.map((s) => [s.id, s.parent_id]));
  assert.deepEqual(spans, { "m:0:1": null, "t:0:p": "m:0:1", "t:0:p/n1": "t:0:p", "m:7:5": "t:0:p", "t:7:p": "m:7:5" });
});

test("a conversation that made two calls of one id has a span for each, each with its own result", () => {
  const entries = [
    answer(1, 0, 100, [call("dup", "read", { path: "a.txt" })], usage(10, 1, 0, 0, 0.001)),
    result(2, 300, "dup", "first"),
    answer(3, 400, 100, [call("dup", "read", { path: "b.txt" })], usage(10, 1, 0, 0, 0.001)),
    result(4, 900, "dup", "second"),
  ];
  const tools = traceSpans(rowsOf(entries), entries).spans.filter((s) => s.kind === "tool");
  assert.deepEqual(tools.map((s) => [s.id, s.status, s.ended_at, s.result_preview]), [["t:0:dup", "ok", at(300), "first"], ["t:0:dup#2", "ok", at(900), "second"]]);
  // Each has its own charge: a fee after the first call's result is the first's, one after the second's the second's.
  const charged = [
    entries[0], entries[1], { id: 5, conversationId: 0, kind: "agentrun.tool_cost", data: { tool: "read", charged_by: "parallel", call: "dup", usd: 0.001 } },
    entries[2], entries[3], { id: 6, conversationId: 0, kind: "agentrun.tool_cost", data: { tool: "read", charged_by: "parallel", call: "dup", usd: 0.004 } },
  ];
  const fees = traceSpans(timelineOf(piShaped(charged), { settled: true }), charged).spans.filter((s) => s.kind === "tool").map((s) => [s.id, s.usd, s.charged]);
  assert.deepEqual(fees, [["t:0:dup", 0.001, true], ["t:0:dup#2", 0.004, true]]);
  // Each takes as long as its own result says: 250 ms and 2 s are two durations, never the last one for both.
  const timed = [entries[0], result(2, 1000, "dup", "first", { durationMs: 250 }), answer(3, 1100, 100, [call("dup", "read", { path: "b.txt" })], usage(10, 1, 0, 0, 0.001)), result(4, 4000, "dup", "second", { durationMs: 2000 })];
  assert.deepEqual(traceSpans(rowsOf(timed), timed).spans.filter((s) => s.kind === "tool").map((s) => [s.started_at, s.ended_at]), [[at(750), at(1000)], [at(2000), at(4000)]]);
});

test("a workflow's decisions are requests too: each receipt is a span with its node, its model, how long it took, its tokens and its own cost", () => {
  const receipt = (id, ms, more) => ({ id, at: at(ms), node: "is it urgent?", kind: "judge", model: "typesafe/jev-1", provider: "jev", usage: { input_tokens: 420, output_tokens: 6 }, cost_usd: 0.0003, latency_ms: 800, status: "answered", request: { index: 0, count: 1 }, ...more });
  const decisions = [
    receipt("dec_1", 2000, {}),
    // One that failed, with no model named and no cost: the provider is its name, its cost unknown.
    receipt("dec_2", 5000, { model: null, usage: null, cost_usd: null, status: "failed", error: "503 upstream", latency_ms: 1500 }),
    receipt("dec_3", 9000, { status: "cancelled", request: { index: 2, count: 3 } }),
  ];
  const trace = traceSpans([], [], { decisions, redact: (text) => text.replace("urgent", "[redacted]") });
  assert.deepEqual(trace.spans.map((s) => [s.id, s.kind, s.decision, s.name, s.agent_label, s.status, s.started_at, s.ended_at, s.tokens, s.usd]), [
    ["d:dec_1:0", "model", true, "typesafe/jev-1", "is it [redacted]?", "ok", at(1200), at(2000), { input: 420, cache_read: 0, cache_write: 0, output: 6 }, 0.0003],
    ["d:dec_2:0", "model", true, "jev", "is it [redacted]?", "failed", at(3500), at(5000), null, null],
    ["d:dec_3:2", "model", true, "typesafe/jev-1", "is it [redacted]?", "interrupted", at(8200), at(9000), { input: 420, cache_read: 0, cache_write: 0, output: 6 }, 0.0003],
  ]);
  // A request of pi's and a tool call are no decisions.
  const mixed = [answer(1, 0, 100, [call("c", "read", { path: "a.txt" })], usage(10, 1, 0, 0, 0.001)), result(2, 300, "c", "a")];
  assert.deepEqual(traceSpans(rowsOf(mixed), mixed).spans.map((s) => s.decision), [false, false]);
});

test("a span's cost carries no floating-point noise: a request's and a decision's are written as a tool call's charges are", () => {
  // A request's cost is its answer's sum of parts, and a provider's own figure can be one too: 0.1 + 0.2 is
  // 0.30000000000000004 as a double. A reader of the API or the CLI is shown the amount, not the sum's last bit.
  const noisy = 0.1 + 0.2;
  assert.notEqual(noisy, 0.3);
  const entries = [
    { id: 1, conversationId: 0, kind: "pi.user", model: [{ role: "user", content: "Go.", timestamp: T0 }] },
    answer(2, 100, 400, [{ type: "text", text: "Done." }], usage(900, 20, 0, 0, noisy)),
  ];
  const decisions = [{ id: "dec_1", at: at(2000), node: "ask", kind: "judge", model: "parallel-fast", provider: "parallel", usage: { input_tokens: 400, output_tokens: 0 }, cost_usd: noisy, latency_ms: 300, status: "answered", request: { index: 0, count: 1 } }];
  const trace = traceSpans(rowsOf(entries), entries, { decisions });
  assert.deepEqual(trace.spans.map((s) => [s.decision, s.usd]), [[false, 0.3], [true, 0.3]]);
  // A cost far below a cent is kept, not rounded away.
  const small = [entries[0], answer(2, 100, 400, [{ type: "text", text: "Done." }], usage(1, 1, 0, 0, 0.000000018))];
  assert.equal(traceSpans(rowsOf(small), small).spans[0].usd, 0.000000018);
});

test("a tool call's charges are its span's cost: a paid tool's fee by its call, two fees their sum, an unknown amount as unknown, a tool with no price as not metered", () => {
  const entries = [
    answer(2, 0, 100, [call("a", "web_search"), call("b", "web_search"), call("c", "mcp__crm__lookup")], usage(10, 1, 0, 0, 0.001)),
    result(3, 200, "a", "one"),
    { id: 4, conversationId: 0, kind: "agentrun.tool_cost", data: { tool: "web_search", charged_by: "parallel", call: "a", usd: 0.005 } },
    result(5, 300, "b", "two"),
    { id: 6, conversationId: 0, kind: "agentrun.tool_cost", data: { tool: "web_search", charged_by: "parallel", call: "b" } },
    result(7, 400, "c", "three"),
    { id: 8, conversationId: 0, kind: "agentrun.tool_unmetered", data: { tool: "mcp__crm__lookup", charged_by: "crm", call: "c" } },
    { id: 9, conversationId: 0, kind: "agentrun.tool_cost", data: { tool: "web_search", charged_by: "parallel", call: "a", usd: 0.002 } },
  ];
  const byCall = Object.fromEntries(traceSpans(rowsOf(entries), entries).spans.filter((s) => s.kind === "tool").map((s) => [s.tool_use_id, [s.usd, s.charged, s.not_metered]]));
  assert.deepEqual(byCall, { a: [0.007, true, false], b: [null, true, false], c: [null, false, true] });
});

test("a request's thinking tokens are said where its answer reports them, and only then", () => {
  const entries = [
    answer(1, 0, 100, [{ type: "text", text: "." }], usage(1000, 200, 5000, 400, 0.0081, undefined, { reasoning: 120 })),
    answer(2, 200, 100, [{ type: "text", text: "." }], usage(1000, 200, 5000, 400, 0.02)),
  ];
  const [thought, plain] = traceSpans(rowsOf(entries), entries).spans;
  assert.deepEqual(thought.tokens, { input: 1000, cache_read: 5000, cache_write: 400, output: 200, reasoning: 120 });
  assert.equal("reasoning" in plain.tokens, false);
});

test("two conversations that each made a call of one id are two spans, each with its own result", () => {
  const inConv = (entry, conversationId) => ({ ...entry, conversationId });
  const entries = [
    answer(1, 0, 100, [call("same", "read", { path: "a.txt" })], usage(10, 1, 0, 0, 0.001)),
    result(2, 300, "same", "first"),
    inConv(answer(3, 400, 100, [call("same", "read", { path: "b.txt" })], usage(10, 1, 0, 0, 0.001)), 7),
    inConv(result(4, 900, "same", "second, and longer"), 7),
  ];
  const tools = traceSpans(rowsOf(entries), entries).spans.filter((s) => s.kind === "tool");
  assert.deepEqual(tools.map((s) => [s.id, s.status, s.ended_at, s.result_preview]), [["t:0:same", "ok", at(300), "first"], ["t:7:same", "ok", at(900), "second, and longer"]]);
});

test("a CLI harness's record keeps no model request: its trace is its tool calls, by the times its record wrote, and says so", () => {
  const entries = [
    { id: 1, conversationId: 0, kind: "agentrun.message", data: { role: "person", text: "List the files.", at: T0 } },
    { id: 2, conversationId: 0, kind: "agentrun.call.start", data: { callId: "k1", tool: "Bash", input: { command: "ls" }, replaySafe: false, at: T0 + 1000 } },
    { id: 3, conversationId: 0, kind: "agentrun.call.end", data: { callId: "k1", status: "done", output: "a.txt", at: T0 + 1750 } },
    { id: 4, conversationId: 0, kind: "agentrun.call.start", data: { callId: "k2", tool: "Bash", input: { command: "false" }, replaySafe: false, at: T0 + 2000 } },
    { id: 5, conversationId: 0, kind: "agentrun.call.end", data: { callId: "k2", status: "failed", output: "exit 1", at: T0 + 2100 } },
    { id: 6, conversationId: 0, kind: "agentrun.message", data: { role: "model", text: "One file.", at: T0 + 3000 } },
  ];
  const trace = traceSpans(rowsOf(entries), entries);
  assert.equal(trace.model_requests, "not_recorded");
  assert.deepEqual(trace.spans.map((s) => [s.kind, s.name, s.status, s.parent_id, s.started_at, s.ended_at]), [
    ["tool", "Bash", "ok", null, at(1000), at(1750)],
    ["tool", "Bash", "failed", null, at(2000), at(2100)],
  ]);
});

test("a trace serves the run's first spans and counts the rest; a model's name goes through the run's cut", () => {
  const entries = Array.from({ length: TRACE_SPANS_MAX + 3 }, (_, i) => answer(i + 1, i * 10, 5, [{ type: "text", text: "." }], usage(1, 1, 0, 0, 0)));
  const trace = traceSpans(rowsOf(entries), entries, { redact: (text) => text.replace("sonnet", "[redacted]") });
  assert.equal(trace.spans.length, TRACE_SPANS_MAX);
  assert.equal(trace.dropped, 3);
  assert.equal(trace.spans[0].started_at, at(0));
  assert.equal(trace.spans[0].name, "claude-[redacted]-5-5");
});

/** A file reserved and sent with the server's token: its id. */
async function uploaded(server, path, text) {
  const bytes = Buffer.from(text);
  const made = await server.api("POST", "/files", { path, size_bytes: bytes.length, content_type: "text/plain" });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const sent = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, method: "PUT", path: made.body.upload.url, agent: false, headers: { authorization: `Bearer ${server.token}`, "content-type": "application/octet-stream" } }, (res) => {
      res.resume().on("end", () => resolve(res.statusCode));
    });
    req.once("error", reject).end(bytes);
  });
  assert.equal(sent, 200);
  return made.body.file?.file_id ?? made.body.file_id;
}

test("GET /runs/{id}/trace: a run that read a file is two requests and the call between them, and its requests' costs are the run's cost", { timeout: 90_000 }, async (t) => {
  const server = await serve(t, { faux: FAUX });
  const { api } = server;
  assert.equal((await api("POST", "/agents", agent("tracer", { tools: ["read"] }))).status, 201);
  const file = await uploaded(server, "notes.txt", "The notes: forty-two.\n");
  const started = await api("POST", "/agents/tracer/runs", { input: { content: "Read the notes." }, file_ids: [file] });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const id = started.body.run_id;
  await follow(api, id, ["completed"], { deadlineMs: 60_000 });

  const read = await api("GET", `/runs/${id}/trace`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const trace = read.body;
  assert.deepEqual([trace.run_id, trace.model_requests, trace.dropped], [id, "priced", 0]);
  assert.deepEqual(trace.spans.map((s) => [s.kind, s.status]), [["model", "ok"], ["tool", "ok"], ["model", "ok"]], JSON.stringify(trace.spans));
  const [asked, tool, answered] = trace.spans;
  assert.deepEqual([tool.name, tool.parent_id, tool.usd, tool.charged], ["read", asked.id, null, false]);
  assert.match(tool.result_preview, /forty-two/);
  assert.deepEqual([asked.stop_reason, answered.stop_reason], ["toolUse", "stop"]);
  for (const span of [asked, answered]) {
    assert.ok(span.tokens.input + span.tokens.cache_read + span.tokens.cache_write > 0, JSON.stringify(span));
    assert.ok(span.usd > 0, JSON.stringify(span));
  }
  for (const span of trace.spans) assert.ok(span.ended_at !== null && Date.parse(span.started_at) <= Date.parse(span.ended_at), JSON.stringify(span));
  assert.ok(Date.parse(asked.started_at) <= Date.parse(tool.started_at) && Date.parse(tool.ended_at) <= Date.parse(answered.ended_at), "the call ran between its request and the answer");
  // The run's cost, as its own read says it, is its requests' costs: the trace prices nothing itself.
  const run = (await api("GET", `/runs/${id}`)).body;
  assert.ok(Math.abs(run.cost.usd - (asked.usd + answered.usd)) < 1e-9, `${run.cost.usd} is not ${asked.usd} + ${answered.usd}`);

  assert.equal((await api("GET", "/runs/run_none/trace")).status, 404);
});
