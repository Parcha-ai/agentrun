// runMetricsOf: what a run that ended used, from the entries of all its conversations. Its requests are the usage row's
// count; a request whose tokens are unknown (cut before its end, or a cost written with no usage) is counted and kept out
// of every token sum; each tool's calls pair with their results by conversation and call id, as the timeline's do.
import assert from "node:assert/strict";
import { test } from "node:test";
import { METRIC_NAMES, REQUEST_CONTINUED, REQUEST_COST, REQUEST_COST_LATE, REQUEST_COST_PENDING, REQUEST_ENDED, REQUEST_REFUSED, REQUEST_STARTED, runMetricsOf, timelineOf } from "../dist/timeline/index.js";
import { assistant, call, custom, inConv, result, user } from "./timeline-support.mjs";

const usage = (input, output, cacheRead = 0, cacheWrite = 0, total = 0.01) => ({ input, output, cacheRead, cacheWrite, totalTokens: input + output, cost: { total } });
const answer = (blocks, tokens, extra = {}) => assistant(blocks, 0, { provider: "anthropic", model: "claude-opus-5-5", usage: tokens, ...extra });
const ZERO = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
const tokensOf = ({ input, cacheRead, cacheWrite, output }) => ({ input, cacheRead, cacheWrite, output });
/** The usage row of the same entries, settled: runMetricsOf counts requests as it does. */
const rowCount = (entries) => timelineOf(entries, { settled: true }).find((row) => row.kind === "usage")?.usage.requests ?? 0;

test("no entries: nothing used, nothing named", () => {
  assert.deepEqual(runMetricsOf([]), { ...ZERO, requests: 0, unmetered: 0, models: {}, tools: {} });
});

test("tokens are summed as pi reports them: input without the cache, cache reads and writes apart, a cache count it omits as 0", () => {
  const entries = [user("hi"), answer([{ type: "text", text: "a" }], usage(100, 20, 5000, 300)), answer([{ type: "text", text: "b" }], { input: 7, output: 3, cost: { total: 0.001 } })];
  const m = runMetricsOf(entries);
  assert.deepEqual(tokensOf(m), { input: 107, cacheRead: 5000, cacheWrite: 300, output: 23 });
  assert.deepEqual([m.requests, m.unmetered], [2, 0]);
  assert.deepEqual([m.models, m.model], [{ "anthropic/claude-opus-5-5": 2 }, "anthropic/claude-opus-5-5"]);
});

test("an aborted response is a request of unknown tokens: its partial usage is in no sum, as its cost is in no cost", () => {
  const done = answer([{ type: "text", text: "a" }], usage(100, 20));
  const partial = answer([{ type: "text", text: "Half an ans" }, call("c9", "read")], usage(900, 1), { stopReason: "aborted" });
  const m = runMetricsOf([done, partial]);
  assert.deepEqual(tokensOf(m), { input: 100, cacheRead: 0, cacheWrite: 0, output: 20 });
  assert.deepEqual([m.requests, m.unmetered], [2, 1]);
  assert.equal(m.models["anthropic/claude-opus-5-5"], 2, "it was still a request to that model");
  assert.deepEqual(m.tools, {}, "an aborted response's calls never ran, as the timeline shows none");
  assert.equal(m.requests, rowCount([done, partial]));
});

test("a response with no token counts is a request of unknown tokens", () => {
  const m = runMetricsOf([answer([{ type: "text", text: "a" }], { cost: { total: 0.01 } }), answer([{ type: "text", text: "b" }], usage(1, 2))]);
  assert.deepEqual([m.requests, m.unmetered, m.input, m.output], [2, 1, 1, 2]);
});

test("a response that reports no input at all was not measured: an import's zeros and a harness answer's with no booking are unknown, never 0 tokens", () => {
  const zeros = (total) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: total === undefined ? {} : { total } });
  const entries = [
    // As the importer writes a session's answers: priced by the source, no token counts.
    assistant([call("c1", "Read")], 0, { api: "imported", provider: "anthropic", model: "claude-opus-5-5", usage: zeros(0.03) }),
    result("c1", "Read", "file text"),
    assistant([{ type: "text", text: "done" }], 0, { api: "imported", provider: "anthropic", model: "claude-opus-5-5", usage: zeros(0.01) }),
    // As a harness answer is written when no booking came for it.
    assistant([{ type: "text", text: "partial" }], 0, { api: "agentrun-adapter", provider: "codex", model: "codex", usage: zeros() }),
    // A failed request's zeros are what it used, as its $0 is what it cost; a cached read with no fresh input was measured.
    answer([], zeros(0), { stopReason: "error", errorMessage: "529 overloaded" }),
    answer([{ type: "text", text: "cached" }], usage(0, 12, 5000)),
  ];
  const m = runMetricsOf(entries);
  assert.deepEqual([m.requests, m.unmetered], [5, 3]);
  assert.deepEqual(tokensOf(m), { input: 0, cacheRead: 5000, cacheWrite: 0, output: 12 });
  assert.deepEqual(m.tools, { Read: { calls: 1, errors: 0 } }, "its calls still count");
});

test("a cost written apart from a response:its tokens are summed when it carries usage, and unknown when it does not", () => {
  const a = answer([{ type: "text", text: "a" }], usage(100, 20));
  const compacted = custom(REQUEST_COST, { request: "compaction", usd: 0.005, usage: { input: 3000, output: 400, cacheRead: 0, cacheWrite: 0 } });
  const bare = custom(REQUEST_COST, { request: "compaction", usd: 0.004 });
  const m = runMetricsOf([a, compacted, bare]);
  assert.deepEqual(tokensOf(m), { input: 3100, cacheRead: 0, cacheWrite: 0, output: 420 });
  assert.deepEqual([m.requests, m.unmetered], [3, 1]);
  assert.deepEqual(m.models, { "anthropic/claude-opus-5-5": 1 }, "a compaction's cost names no model");
  assert.equal(m.requests, rowCount([a, compacted, bare]));
});

test("a harness answer written before its usage came in: its late cost's usage counts, once; with none, or never come, its tokens are unknown", () => {
  // As a harness writes one: the answer with zero counts and no cost, then a pending mark, then the late cost.
  const early = (text) => assistant([{ type: "text", text }], 0, { provider: "codex", model: "codex", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: {} } });
  const pending = custom(REQUEST_COST_PENDING, { key: "k", request: 1 });
  const late = (data) => custom(REQUEST_COST_LATE, { key: "k", request: 1, usd: 0.02, ...data });
  const priced = runMetricsOf([early("a"), pending, late({ usage: { input: 500, output: 60, cacheRead: 9000, cacheWrite: 0 } })]);
  assert.deepEqual(tokensOf(priced), { input: 500, cacheRead: 9000, cacheWrite: 0, output: 60 });
  assert.deepEqual([priced.requests, priced.unmetered], [1, 0], "a late cost is not a request of its own");
  const bare = runMetricsOf([early("a"), pending, late({})]);
  assert.deepEqual([tokensOf(bare), bare.requests, bare.unmetered], [ZERO, 1, 1]);
  const never = runMetricsOf([early("a"), pending]);
  assert.deepEqual([never.requests, never.unmetered], [1, 1]);
  assert.deepEqual(never.models, { "codex/codex": 1 });
});

test("a request cut before its answer counts, at unknown tokens; one the host refused before it left is no request", () => {
  const started = () => custom(REQUEST_STARTED, {});
  const a = answer([{ type: "text", text: "a" }], usage(10, 1));
  const cut = [started(), custom(REQUEST_ENDED, {}), a, started()];
  const m = runMetricsOf(cut);
  assert.deepEqual([m.requests, m.unmetered, m.input], [2, 1, 10]);
  assert.equal(m.requests, rowCount(cut));
  const refused = [user("hi"), started(), a, custom(REQUEST_REFUSED, {}), assistant([], 0, { stopReason: "error", errorMessage: "the run was cancelled", usage: usage(0, 0) })];
  const r = runMetricsOf(refused);
  assert.deepEqual([r.requests, r.unmetered, r.models], [1, 0, { "anthropic/claude-opus-5-5": 1 }]);
  assert.equal(r.requests, rowCount(refused));
});

test("a call a harness answer asked for, written after that answer as its continuation: shown under the answer and counted as a call, never as a request", () => {
  // As serve writes an answer that asks for two tools: the answer at its first call's end, then the second call.
  const first = answer([{ type: "text", text: "Writing both." }, call("c1", "write", { path: "a.md" })], usage(100, 20));
  const entries = [
    user("Write two files."),
    first,
    result("c1", "write", "ok"),
    custom(REQUEST_CONTINUED, { key: "k", request: 1 }),
    assistant([call("c2", "write", { path: "b.md" })], 0, { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: {} } }),
    result("c2", "write", "ok"),
    answer([{ type: "text", text: "Wrote both." }], usage(140, 5)),
  ];
  const m = runMetricsOf(entries);
  assert.deepEqual([m.requests, m.unmetered, m.input, m.output, m.tools, m.models], [2, 0, 240, 25, { write: { calls: 2, errors: 0 } }, { "anthropic/claude-opus-5-5": 2 }]);
  assert.equal(m.requests, rowCount(entries));
  const rows = timelineOf(entries, { settled: true });
  assert.deepEqual(rows.filter((r) => r.kind === "tool_use").map((r) => [r.tool_use_id, r.round]), [["c1", first.id], ["c2", first.id]], "the continuation's call shows under the answer it continues");
  assert.deepEqual(rows.findLast((r) => r.kind === "usage")?.usage, { usd: 0.02, requests: 2 }, "no request, and no unknown cost, of its own");
  assert.deepEqual(rows.filter((r) => r.kind === "tool_result" && r.tool_status !== "success"), [], "no call reads as interrupted");
  assert.equal(rows.find((r) => r.kind === "final_answer")?.text, "Wrote both.");
});

test("tools: each result counts a call of its call's tool, an error result a failure; a call with no result was interrupted, a failure", () => {
  const entries = [
    answer([call("c1", "read"), call("c2", "read"), call("c3", "write")], usage(1, 1)),
    result("c1", "read", "ok"),
    result("c2", "read", "no such file", 0, { isError: true }),
    answer([call("c4", "bash")], usage(1, 1)),
    result("c4", "bash", "exit 0"),
    answer([{ type: "text", text: "done" }], usage(1, 1)),
  ];
  assert.deepEqual(runMetricsOf(entries).tools, { read: { calls: 2, errors: 1 }, write: { calls: 1, errors: 1 }, bash: { calls: 1, errors: 0 } });
  // The timeline reads the same: c3 interrupted, c2 failed.
  const failed = timelineOf(entries, { settled: true }).filter((row) => row.kind === "tool_result" && row.tool_status === "failed").map((row) => row.tool_use_id);
  assert.deepEqual(failed.sort(), ["c2", "c3"]);
});

test("a failed model request is a request with its tokens; it ran no calls", () => {
  const m = runMetricsOf([answer([], usage(40, 0), { stopReason: "error", errorMessage: "529 overloaded" }), answer([{ type: "text", text: "ok" }], usage(40, 5))]);
  assert.deepEqual([m.requests, m.unmetered, m.input, m.output, m.tools], [2, 0, 80, 5, {}]);
});

test("several conversations: every one's requests and tokens are summed, its calls paired in its own conversation, and the busiest model named", () => {
  const sub = (entry) => inConv(entry, 2);
  const entries = [
    user("research it"),
    answer([call("c1", "spawn")], usage(100, 10, 2000)),
    sub(assistant([call("c1", "search")], 0, { provider: "anthropic", model: "claude-haiku-5-5", usage: usage(30, 3) })),
    sub(result("c1", undefined, "3 hits")),
    sub(assistant([call("c2", "search")], 0, { provider: "anthropic", model: "claude-haiku-5-5", usage: usage(40, 4) })),
    sub(result("c2", "search", "rate limited", 0, { isError: true })),
    sub(assistant([{ type: "text", text: "found it" }], 0, { provider: "anthropic", model: "claude-haiku-5-5", usage: usage(50, 5) })),
    result("c1", undefined, "found it"),
    answer([{ type: "text", text: "It is X." }], usage(200, 20, 2100)),
  ];
  const m = runMetricsOf(entries);
  assert.deepEqual(tokensOf(m), { input: 420, cacheRead: 4100, cacheWrite: 0, output: 42 });
  assert.deepEqual([m.requests, m.unmetered], [5, 0]);
  assert.deepEqual(m.models, { "anthropic/claude-opus-5-5": 2, "anthropic/claude-haiku-5-5": 3 });
  assert.equal(m.model, "anthropic/claude-haiku-5-5");
  assert.deepEqual(m.tools, { spawn: { calls: 1, errors: 0 }, search: { calls: 2, errors: 1 } }, "each c1 is its own conversation's");
});

test("an entry read twice counts once, by conversation and id", () => {
  const a = answer([call("c1", "read")], usage(10, 1));
  const r = result("c1", "read", "ok");
  const m = runMetricsOf([a, r, a, r]);
  assert.deepEqual([m.requests, m.input, m.tools], [1, 10, { read: { calls: 1, errors: 0 } }]);
});

test("a tool name past 256 characters is cut to its first 255 and \"…\": the same name is always the same key", () => {
  const long = `${"x".repeat(250)}_${"y".repeat(49)}`;
  const entries = [answer([call("c1", long), call("c2", long), call("c3", `${long}z`)], usage(1, 1)), result("c1", long, "ok"), result("c2", long, "no", 0, { isError: true }), result("c3", `${long}z`, "ok")];
  const key = `${long.slice(0, 255)}…`;
  assert.deepEqual(runMetricsOf(entries).tools, { [key]: { calls: 3, errors: 1 } }, "two names that differ only past the cut share its key");
  assert.equal(key.length, METRIC_NAMES.max);
  // A cut that would end inside a surrogate pair drops its first half, so the key stays well formed.
  const emoji = `${"x".repeat(254)}😀${"x".repeat(10)}`;
  const [cut] = Object.keys(runMetricsOf([answer([call("c1", emoji)], usage(1, 1)), result("c1", emoji, "ok")]).tools);
  assert.equal(cut, `${"x".repeat(254)}…`);
});

test("past 100 distinct tools a run keeps the 100 with the most calls and sums the rest under \"…other tools\"", () => {
  const entries = [];
  for (let i = 0; i < 150; i++) {
    // Tool t0 is called 3 times, t1 to t99 twice, t100 to t149 once; one of t100's calls failed.
    const times = i === 0 ? 3 : i < 100 ? 2 : 1;
    for (let n = 0; n < times; n++) entries.push(answer([call(`c${i}-${n}`, `t${i}`)], usage(1, 1)), result(`c${i}-${n}`, `t${i}`, "ok", 0, { isError: i >= 100 && n === 0 && i % 10 === 0 }));
  }
  const { tools } = runMetricsOf(entries);
  assert.equal(Object.keys(tools).length, METRIC_NAMES.kept + 1);
  assert.deepEqual(tools.t0, { calls: 3, errors: 0 });
  assert.deepEqual(tools.t99, { calls: 2, errors: 0 });
  assert.equal(tools.t100, undefined);
  assert.deepEqual(tools[METRIC_NAMES.otherTools], { calls: 50, errors: 5 });
  assert.equal(Object.values(tools).reduce((sum, t) => sum + t.calls, 0), 3 + 99 * 2 + 50, "every call is still counted");
  // At the bound exactly, nothing is folded.
  assert.equal(Object.keys(runMetricsOf(entries.slice(0, 2 * (3 + 99 * 2))).tools).length, 100);
});

test("a tie for the last kept place goes to the tool called first, though its call never returned", () => {
  const names = Array.from({ length: 101 }, (_, i) => `t${i}`);
  // One answer calls t0 to t100; t0's call is interrupted, so it is tallied only at the end, after every other result.
  const entries = [answer(names.map((name) => call(`k-${name}`, name)), usage(1, 1)), ...names.slice(1).map((name) => result(`k-${name}`, name, "ok"))];
  const { tools } = runMetricsOf(entries);
  assert.deepEqual(tools.t0, { calls: 1, errors: 1 }, "kept: called first");
  assert.equal(tools.t100, undefined);
  assert.deepEqual(tools[METRIC_NAMES.otherTools], { calls: 1, errors: 0 });
});

test("an empty or missing tool name counts under \"…unnamed tool\"; a name that starts with \"…\" gets another, so it is never one of those", () => {
  const entries = [
    answer([call("c1", "")], usage(1, 1)), result("c1", "", "no such tool", 0, { isError: true }),
    custom("pi.tool-result", undefined, { model: [{ role: "toolResult", toolCallId: "lost", content: [], isError: false }] }),
    answer([call("c2", METRIC_NAMES.otherTools), call("c3", "…")], usage(1, 1)), result("c2", METRIC_NAMES.otherTools, "ok"), result("c3", "…", "ok"),
    // A lone surrogate is no text the store keeps the same: it reads as U+FFFD.
    answer([call("c4", "bad\uD800name")], usage(1, 1)), result("c4", "bad\uD800name", "ok"),
    answer([call("c5", "  ")], usage(1, 1)), result("c5", "  ", "ok"),
  ];
  assert.deepEqual(runMetricsOf(entries).tools, {
    [METRIC_NAMES.unnamedTool]: { calls: 2, errors: 1 },
    [`…${METRIC_NAMES.otherTools}`]: { calls: 1, errors: 0 },
    "……": { calls: 1, errors: 0 },
    "bad\uFFFDname": { calls: 1, errors: 0 },
    "  ": { calls: 1, errors: 0 },
  });
});

test("model names are kept the same way: cut past 256 characters, the 100 busiest kept and the rest summed under \"…other models\"", () => {
  const long = "m".repeat(300);
  const entries = [answer([{ type: "text", text: "a" }], usage(1, 1), { provider: "gateway", model: long }), answer([{ type: "text", text: "b" }], usage(1, 1), { provider: "gateway", model: long })];
  for (let i = 0; i < 120; i++) entries.push(answer([{ type: "text", text: `${i}` }], usage(1, 1), { provider: "p", model: `m${i}` }));
  const m = runMetricsOf(entries);
  const key = `gateway/${"m".repeat(METRIC_NAMES.max - 1 - "gateway/".length)}…`;
  assert.equal(m.model, key);
  assert.equal(m.models[key], 2);
  assert.equal(Object.keys(m.models).length, METRIC_NAMES.kept + 1);
  assert.equal(m.models[METRIC_NAMES.otherModels], 21, "p/m0 to p/m98 are kept beside the busiest; the last 21 are summed");
  assert.equal(Object.values(m.models).reduce((a, b) => a + b, 0), m.requests);
});
