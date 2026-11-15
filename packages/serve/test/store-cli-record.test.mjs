// A CLI harness's run (claude-agent, codex, opencode: record "loop") viewed over the one store. The runner's adapter loop
// writes the run's visible record as agentrun.message / agentrun.call.start / agentrun.call.end entries (adapter-loop.ts
// openCliRecord), not pi's own entries. The store readers render that record as the pi-shaped entries the timeline renderer
// reads, so the run reads the same rows, words and final answer as a pi run of the same conversation. These tests pin that
// equivalence, the end status and output of a call, and that a pi run is untouched.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { storeOn, T0 } from "./store-helpers.mjs";

const { servedTimelineRows } = await import("../dist/run-timeline-served.js");

const { runTimeline } = await import("../dist/store-reads/journal.js");
const { timelineOverStore, viewOverStore } = await import("../dist/store-view.js");
const { spentOverStore } = await import("../dist/store-reads/cap.js");
const { runGraphView } = await import("../dist/run-reads-over-store.js");

const context = BACKGROUND_CONTEXT;
const ROOT = 1;
const deps = { origin: "https://run.test", serverSecrets: () => [] };
/** The timeline rows a person reads, with the ids and seq (which differ by how many entries carry a turn) left out. */
const shown = (rows) => rows.map((r) => ({ kind: r.kind, tool_name: r.tool_name, tool_status: r.tool_status, summary: r.summary, text: r.text, preview: r.tool_result_preview }));

/** An agent on `harness`, and a run of it claimed, ready for its journal. */
async function claimed(store, { harness = "claude-agent", runId = "run-1" } = {}) {
  if (!(await store.agents.get("agent-1"))) await store.agents.create({ id: "agent-1", name: "First agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", harness } });
  await store.runs.create({ id: runId, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Hi" }, title: "CLI run", place: { mode: "runner" } } });
  return store.claim(runId, "runner-a", { leaseMs: 60_000 });
}

const entry = (id, kind, data) => ({ type: "entry", value: { id, conversationId: ROOT, kind, data } });

test("a claude-agent run reads the same rows and final answer over the store as a pi run of the same conversation", async (t) => {
  const { store } = await storeOn(t);

  // The CLI record the adapter loop writes: a person turn, the model's words, a tool call and its result, a final answer.
  const cli = await claimed(store, { runId: "cli" });
  const jc = store.journal(cli);
  await commitWrites(jc, [
    { type: "conversation", value: { id: ROOT } },
    entry(await jc.mintId(), "agentrun.message", { role: "person", text: "List the files." }),
    entry(await jc.mintId(), "agentrun.message", { role: "model", text: "Let me look." }),
    entry(await jc.mintId(), "agentrun.call.start", { callId: "t1", tool: "bash", input: { command: "ls" }, replaySafe: true }),
    entry(await jc.mintId(), "agentrun.call.end", { callId: "t1", status: "done", output: "one.txt\ntwo.txt" }),
    entry(await jc.mintId(), "agentrun.message", { role: "model", text: "There are two files." }),
  ], context);
  await store.runs.update(cli, { state: "ended", outcome: "completed", summary: "There are two files.", costUsd: 0.42, endedAt: T0 + 10 });

  // The same conversation as pi's own entries (a text block and the tool call in one assistant turn, the result, the answer).
  const pi = await claimed(store, { runId: "pi" });
  const jp = store.journal(pi);
  await commitWrites(jp, [
    { type: "conversation", value: { id: ROOT } },
    { type: "entry", value: { id: await jp.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "List the files." }] } },
    { type: "entry", value: { id: await jp.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "tool_use", content: [{ type: "text", text: "Let me look." }, { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }] }] } },
    { type: "entry", value: { id: await jp.mintId(), conversationId: ROOT, kind: "pi.tool-result", model: [{ role: "tool", toolCallId: "t1", content: "one.txt\ntwo.txt" }] } },
    { type: "entry", value: { id: await jp.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "There are two files." }] }] } },
  ], context);
  await store.runs.update(pi, { state: "ended", outcome: "completed", summary: "There are two files.", costUsd: 0.42, endedAt: T0 + 10 });

  // Usage rows aside: this record has no booking, which the CLI run's own usage row reads as unknown (below).
  const cliRows = (await runTimeline(store, "cli", context, { settled: true })).filter((r) => r.kind !== "usage");
  const piRows = (await runTimeline(store, "pi", context, { settled: true })).filter((r) => r.kind !== "usage");
  // The CLI record reads the same person/model/call rows, in the same order, with the same words, as the pi run.
  assert.deepEqual(shown(cliRows), shown(piRows));
  assert.deepEqual(shown(cliRows).map((r) => r.kind), ["user_message", "text_block", "tool_use", "tool_result", "final_answer"]);

  // The run read's final answer is the last model message. Its model worked with no request booked (this record has no
  // runner.request or runner.turn), so its cost reads unknown from its usage row, never a total its booking can't show.
  const view = await viewOverStore(store, "cli", deps);
  assert.deepEqual(view.result, { output: null, final_answer: "There are two files." });
  assert.equal(view.status, "completed");
  assert.deepEqual(view.cost, { usd: null, basis: "estimate", charge_state: null, cap_usd: null, so_far_usd: 0, unpriced: 1 });
});

test("a CLI record's rows are dated by when each entry was written; an entry with no time of its own reads the run's start, never epoch 0", async (t) => {
  const { store } = await storeOn(t);
  const cli = await claimed(store, { harness: "codex", runId: "run-1" });
  const j = store.journal(cli);
  const at = (ms) => new Date(ms).toISOString();
  await commitWrites(j, [
    { type: "conversation", value: { id: ROOT } },
    entry(await j.mintId(), "agentrun.message", { role: "person", text: "Build it.", at: T0 + 1_000 }),
    entry(await j.mintId(), "agentrun.call.start", { callId: "c1", tool: "bash", input: { command: "make" }, replaySafe: false, at: T0 + 2_000 }),
    entry(await j.mintId(), "agentrun.call.end", { callId: "c1", status: "done", output: "build ok", at: T0 + 3_000 }),
    entry(await j.mintId(), "agentrun.message", { role: "model", text: "Built.", at: T0 + 4_000 }),
  ], context);
  const dated = shownAt(await runTimeline(store, "run-1", context, { settled: true }));
  assert.deepEqual(dated, [["user_message", at(T0 + 1_000)], ["tool_use", at(T0 + 2_000)], ["tool_result", at(T0 + 3_000)], ["final_answer", at(T0 + 4_000)]]);

  // A record written before its entries carried `at`: no row reads 1970; each reads the run's start.
  const old = await claimed(store, { harness: "codex", runId: "run-2" });
  const k = store.journal(old);
  await commitWrites(k, [
    { type: "conversation", value: { id: ROOT } },
    entry(await k.mintId(), "agentrun.message", { role: "person", text: "Build it." }),
    entry(await k.mintId(), "agentrun.message", { role: "model", text: "Built." }),
  ], context);
  const started = at((await store.runs.get("run-2")).startedAt);
  for (const [kind, when] of shownAt(await runTimeline(store, "run-2", context, { settled: true }))) {
    assert.notEqual(Date.parse(when), 0, `${kind}: never epoch 0`);
    assert.equal(when, started, `${kind}: the run's start`);
  }
});

/** Each row's kind and time, its timestamp and created_at checked to agree. */
const shownAt = (rows) => rows.filter((row) => row.kind !== "usage").map((row) => (assert.equal(row.created_at, row.timestamp, row.kind), [row.kind, row.timestamp]));

test("a codex run's calls read their end status and output: a success ok, a failure as an error with its output", async (t) => {
  const { store } = await storeOn(t);
  const cli = await claimed(store, { harness: "codex", runId: "run-1" });
  const j = store.journal(cli);
  await commitWrites(j, [
    { type: "conversation", value: { id: ROOT } },
    entry(await j.mintId(), "agentrun.message", { role: "person", text: "Build it." }),
    entry(await j.mintId(), "agentrun.call.start", { callId: "c1", tool: "bash", input: { command: "make" }, replaySafe: false }),
    entry(await j.mintId(), "agentrun.call.end", { callId: "c1", status: "done", output: "build ok" }),
    entry(await j.mintId(), "agentrun.call.start", { callId: "c2", tool: "bash", input: { command: "make test" }, replaySafe: false }),
    entry(await j.mintId(), "agentrun.call.end", { callId: "c2", status: "failed", output: "1 test failed" }),
    entry(await j.mintId(), "agentrun.message", { role: "model", text: "A test is failing." }),
  ], context);
  await store.runs.update(cli, { state: "ended", outcome: "completed", summary: "A test is failing.", costUsd: 0.1, endedAt: T0 + 10 });

  const rows = shown((await runTimeline(store, "run-1", context, { settled: true })).filter((r) => r.kind !== "usage"));
  assert.deepEqual(rows.map((r) => r.kind), ["user_message", "tool_use", "tool_result", "tool_use", "tool_result", "final_answer"]);
  // The successful call's result reads ok, with its output; the failed one reads an error, with its output.
  const [okUse, okResult, failUse, failResult] = rows.slice(1, 5);
  assert.equal(okUse.summary, "Ran `make`");
  assert.equal(okResult.tool_status, "success");
  assert.equal(okResult.preview, "build ok");
  assert.equal(failUse.summary, "Ran `make test`");
  assert.equal(failResult.tool_status, "failed");
  assert.match(failResult.summary, /failed:/);
  assert.equal(failResult.preview, "1 test failed");
  // The final answer is the last model message.
  assert.equal((await viewOverStore(store, "run-1", deps)).result.final_answer, "A test is failing.");
});

// A CLI's MCP call is a host tool through its tool bridge (adapter-loop.ts bridgeGate): parked at its gate, the bridge holds
// it and hands the CLI nothing, so no waiting result shows for it while it waits, as on pi; its end is its one result.
test("a CLI's parked MCP call shows no result row while it waits, asked or sent; ended, only its outcome", async (t) => {
  const { store } = await storeOn(t);
  const cli = await claimed(store);
  const j = store.journal(cli);
  await commitWrites(j, [
    { type: "conversation", value: { id: ROOT } },
    entry(await j.mintId(), "agentrun.message", { role: "person", text: "Add 2 and 3." }),
    entry(await j.mintId(), "agentrun.call.start", { callId: "c1", tool: "mcp__fake__add", input: { a: 2, b: 3 }, replaySafe: false, parked: true }),
  ], context);
  const kinds = async () => shown(await runTimeline(store, "run-1", context)).filter((r) => r.kind === "tool_use" || r.kind === "tool_result");
  assert.deepEqual((await kinds()).map((r) => r.kind), ["tool_use"], "at its gate: the call's row only");
  // Asked, twice (a resume, a cap raised meanwhile): still no result.
  for (let i = 0; i < 2; i++) await commitWrites(j, [entry(await j.mintId(), "agentrun.ask", { callId: "c1", tool: "mcp:fake/add", args: { a: 2, b: 3 }, requestedAt: new Date(T0).toISOString() })], context);
  assert.deepEqual((await kinds()).map((r) => r.kind), ["tool_use"], "asked: no waiting words, no result");
  // Allowed and sent: in flight, no result until its end.
  await commitWrites(j, [entry(await j.mintId(), "agentrun.answer", { callId: "c1", decision: "allow" }), entry(await j.mintId(), "agentrun.call.sent", { callId: "c1" })], context);
  assert.deepEqual((await kinds()).map((r) => r.kind), ["tool_use"], "sent: no result yet");
  // Ended: its outcome, once.
  await commitWrites(j, [entry(await j.mintId(), "agentrun.call.end", { callId: "c1", status: "done", output: "5" })], context);
  const ended = await kinds();
  assert.deepEqual(ended.map((r) => [r.kind, r.tool_name, r.preview ?? null]), [["tool_use", "mcp__fake__add", null], ["tool_result", "mcp__fake__add", "5"]]);
});

test("a CLI's parked MCP call ended without being sent (refused, or withdrawn by a stop) shows its end's words, never the waiting words too", async (t) => {
  const { store } = await storeOn(t);
  const cli = await claimed(store);
  const j = store.journal(cli);
  await commitWrites(j, [
    { type: "conversation", value: { id: ROOT } },
    entry(await j.mintId(), "agentrun.message", { role: "person", text: "Add 2 and 3." }),
    entry(await j.mintId(), "agentrun.call.start", { callId: "c1", tool: "mcp__fake__add", input: { a: 2, b: 3 }, replaySafe: false, parked: true }),
    entry(await j.mintId(), "agentrun.ask", { callId: "c1", tool: "mcp:fake/add", args: { a: 2, b: 3 }, requestedAt: new Date(T0).toISOString() }),
    entry(await j.mintId(), "agentrun.answer", { callId: "c1", decision: "deny", note: "not now" }),
    entry(await j.mintId(), "agentrun.call.end", { callId: "c1", status: "refused", output: "Denied: not now" }),
  ], context);
  const rows = await runTimeline(store, "run-1", context);
  const results = shown(rows).filter((r) => r.kind === "tool_result");
  assert.deepEqual(results.map((r) => r.preview), ["Denied: not now"]);
  // Refused, as pi's refused call reads: marked `refused` (the console's neutral chip, never its red Error), named so.
  const result = rows.find((r) => r.kind === "tool_result");
  assert.equal(result.refused, true, JSON.stringify(result));
  assert.match(result.summary, /^Refused: /);
});

test("a CLI call that ran and failed is not marked refused: it keeps its failure's words and status", async (t) => {
  const { store } = await storeOn(t);
  const cli = await claimed(store);
  const j = store.journal(cli);
  await commitWrites(j, [
    { type: "conversation", value: { id: ROOT } },
    entry(await j.mintId(), "agentrun.message", { role: "person", text: "Add 2 and 3." }),
    entry(await j.mintId(), "agentrun.call.start", { callId: "c1", tool: "mcp__fake__add", input: { a: 2, b: 3 }, replaySafe: false }),
    entry(await j.mintId(), "agentrun.call.end", { callId: "c1", status: "failed", output: "add: the server is down" }),
  ], context);
  const result = (await runTimeline(store, "run-1", context)).find((r) => r.kind === "tool_result");
  assert.equal(result.tool_status, "failed");
  assert.equal(result.refused, undefined, JSON.stringify(result));
  assert.doesNotMatch(result.summary, /^Refused: /);
});

test("a pi run is untouched: it still folds its usage row, which a CLI run has none of", async (t) => {
  const { store } = await storeOn(t);
  const pi = await claimed(store, { runId: "run-1" });
  const j = store.journal(pi);
  await commitWrites(j, [
    { type: "conversation", value: { id: ROOT } },
    { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "Hi" }] } },
    { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Hello." }], usage: { cost: { total: 0.03 } } }] } },
  ], context);
  await store.runs.update(pi, { state: "ended", outcome: "completed", summary: "Hello.", costUsd: 0.03, endedAt: T0 + 5 });

  const rows = await runTimeline(store, "run-1", context, { settled: true });
  assert.ok(rows.some((r) => r.kind === "usage"), "a pi run keeps its usage row");
  assert.equal(rows.at(-1).kind, "usage");
  assert.equal(rows.find((r) => r.kind === "final_answer")?.summary, "Hello.");
});

// A paid MCP tool charge the runner books in the kernel cap's paid-tools session (TOOL_SESSION), read back as the Tool cost
// row the file path had on the run's root. The session's runner.request names what was paid for (model "paid:<name>":
// a fee's name, Parallel's search, or an MCP tool's catalog name), the call it ran under, who charged for it (charged_by),
// and the tool it names of its own where it names one (`tool`); its runner.turn carries the cost; the charge is placed
// under that call, joined by `call`, and named for the tool that call ran unless its request names its own.
const paidSession = (convId, skId, reqId, turnId, { name = "mcp:fake/paid", call = "c1", usd = 0.05, chargedBy = "fake", tool, turn = {} } = {}) => [
  { type: "conversation", value: { id: convId } },
  { type: "entry", value: { id: skId, conversationId: ROOT, kind: "agentrun.session.key", data: { key: "paid-tools", conversation: convId } } },
  { type: "entry", value: { id: reqId, conversationId: convId, kind: "runner.request", data: { turn: 1, model: `paid:${name}`, call, heldUsd: usd, charged_by: chargedBy, ...(tool ? { tool } : {}) } } },
  { type: "entry", value: { id: turnId, conversationId: convId, kind: "runner.turn", data: { turn: 1, usd, ...turn } } },
];

test("a pi run's paid MCP charge renders a Tool cost row under its call, from the paid-tools session", async (t) => {
  const { store } = await storeOn(t);
  const claim = await claimed(store, { harness: "pi", runId: "run-1" });
  const j = store.journal(claim);
  await commitWrites(j, [
    { type: "conversation", value: { id: ROOT } },
    { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "fetch", timestamp: T0 }] } },
    { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "tool_use", content: [{ type: "toolCall", id: "c1", name: "mcp:fake/paid", arguments: {} }], usage: { cost: { total: 0.01 } }, timestamp: T0 + 1 }] } },
    ...paidSession(await j.mintId(), await j.mintId(), await j.mintId(), await j.mintId()),
    { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "pi.tool-result", model: [{ role: "tool", toolCallId: "c1", content: "ok", timestamp: T0 + 2 }] } },
    { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }], timestamp: T0 + 3 }] } },
  ], context);
  await store.runs.update(claim, { state: "ended", outcome: "completed", summary: "Done.", costUsd: 0.06, endedAt: T0 + 9 });

  const rows = await runTimeline(store, "run-1", context, { settled: true });
  const result = rows.findIndex((x) => x.kind === "tool_result" && x.tool_use_id === "c1");
  const cost = rows.findIndex((x) => x.kind === "phase" && /^Tool cost:/.test(x.summary ?? ""));
  const final = rows.findIndex((x) => x.kind === "final_answer");
  assert.ok(result >= 0 && result < cost && cost < final, `the Tool cost row follows its call's result, before the answer: ${JSON.stringify(shown(rows))}`);
  assert.equal(rows[cost].summary, "Tool cost: fake charged $0.0500 for mcp:fake/paid");
  assert.equal(rows[cost].tool_use_id, "c1");
});

test("a paid web_search charge's Tool cost row names who charged, from its record's charged_by, and the tool its call ran, not the fee's name", async (t) => {
  const { store } = await storeOn(t);
  const claim = await claimed(store, { harness: "pi", runId: "run-1" });
  const j = store.journal(claim);
  await commitWrites(j, [
    { type: "conversation", value: { id: ROOT } },
    { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "search", timestamp: T0 }] } },
    { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "tool_use", content: [{ type: "toolCall", id: "c1", name: "web_search", arguments: {} }], timestamp: T0 + 1 }] } },
    ...paidSession(await j.mintId(), await j.mintId(), await j.mintId(), await j.mintId(), { name: "Parallel's search", usd: 0.005, chargedBy: "parallel" }),
    { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "pi.tool-result", model: [{ role: "tool", toolCallId: "c1", content: "ok", timestamp: T0 + 2 }] } },
    { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }], timestamp: T0 + 3 }] } },
  ], context);
  await store.runs.update(claim, { state: "ended", outcome: "completed", summary: "Done.", costUsd: 0.005, endedAt: T0 + 9 });

  const rows = await runTimeline(store, "run-1", context, { settled: true });
  const cost = rows.find((x) => x.kind === "phase" && /^Tool cost:/.test(x.summary ?? ""));
  assert.equal(cost?.summary, "Tool cost: parallel charged $0.0050 for web_search", JSON.stringify(shown(rows)));
});

/** A pi run with one web_search call whose paid-tools turn, Parallel's search, is `usd` (with `turn`'s other fields),
 *  booked under `tool` where given; ended. Its charge rows. */
async function chargeRowsFor(t, usd, turn = {}, tool) {
  const { store } = await storeOn(t);
  const claim = await claimed(store, { harness: "pi", runId: "run-1" });
  const j = store.journal(claim);
  await commitWrites(j, [
    { type: "conversation", value: { id: ROOT } },
    { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "search", timestamp: T0 }] } },
    { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "tool_use", content: [{ type: "toolCall", id: "c1", name: "web_search", arguments: {} }], timestamp: T0 + 1 }] } },
    ...paidSession(await j.mintId(), await j.mintId(), await j.mintId(), await j.mintId(), { name: "Parallel's search", usd, chargedBy: "parallel", turn, tool }),
    { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "pi.tool-result", model: [{ role: "tool", toolCallId: "c1", content: "ok", timestamp: T0 + 2 }] } },
    { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }], timestamp: T0 + 3 }] } },
  ], context);
  await store.runs.update(claim, { state: "ended", outcome: "completed", summary: "Done.", costUsd: 0, endedAt: T0 + 9 });
  const rows = await runTimeline(store, "run-1", context, { settled: true });
  return rows.filter((x) => x.kind === "phase" && /^(Tool cost|Not metered):/.test(x.summary ?? "")).map((x) => x.summary);
}

// A paid record's outcomes, each as main's timeline renders it (the TOOL_COST row).
test("a paid charge whose request names a tool of its own keeps it: the call's tool names only a charge that names none", async (t) => {
  assert.deepEqual(await chargeRowsFor(t, 0.005, {}, "web_fetch"), ["Tool cost: parallel charged $0.0050 for web_fetch"]);
});

test("a paid hold given back unused shows no charge row", async (t) => {
  assert.deepEqual(await chargeRowsFor(t, 0, { givenBack: true }), [], "nothing sent, no row");
});

test("a paid request that ran and charged $0 shows a $0 charge, as main's TOOL_COST of usd 0", async (t) => {
  assert.deepEqual(await chargeRowsFor(t, 0), ["Tool cost: parallel charged $0 for web_search"], "an unbilled 4xx: a $0 charge");
});

test("a paid request whose charge is unknown shows main's charge of an unknown amount, never Not metered", async (t) => {
  assert.deepEqual(await chargeRowsFor(t, null), ["Tool cost: parallel charged an unknown amount for web_search"], "settled at its hold (null): an unknown amount");
});

test("a claude-agent run's paid MCP charge renders a Tool cost row under its call, from the paid-tools session", async (t) => {
  const { store } = await storeOn(t);
  const claim = await claimed(store, { harness: "claude-agent", runId: "run-1" });
  const j = store.journal(claim);
  await commitWrites(j, [
    { type: "conversation", value: { id: ROOT } },
    entry(await j.mintId(), "agentrun.message", { role: "person", text: "Fetch it." }),
    entry(await j.mintId(), "agentrun.call.start", { callId: "c1", tool: "mcp:fake/paid", input: {}, replaySafe: false }),
    ...paidSession(await j.mintId(), await j.mintId(), await j.mintId(), await j.mintId()),
    entry(await j.mintId(), "agentrun.call.end", { callId: "c1", status: "done", output: "ok" }),
    entry(await j.mintId(), "agentrun.message", { role: "model", text: "Fetched." }),
  ], context);
  await store.runs.update(claim, { state: "ended", outcome: "completed", summary: "Fetched.", costUsd: 0.06, endedAt: T0 + 9 });

  const rows = await runTimeline(store, "run-1", context, { settled: true });
  const result = rows.findIndex((x) => x.kind === "tool_result" && x.tool_use_id === "c1");
  const cost = rows.findIndex((x) => x.kind === "phase" && /^Tool cost:/.test(x.summary ?? ""));
  assert.ok(result >= 0 && cost === result + 1, `the Tool cost row follows its call's result: ${JSON.stringify(shown(rows))}`);
  assert.equal(rows[cost].summary, "Tool cost: fake charged $0.0500 for mcp:fake/paid");
  // A CLI run's usage row is its booking's (#2275): here its model answered with no request booked, so its cost is
  // unknown, the paid call's charge the part known.
  const usage = rows.filter((x) => x.kind === "usage");
  assert.equal(usage.length, 1);
  assert.deepEqual([usage[0].usage, usage[0].summary], [{ usd: null, requests: 0, so_far_usd: 0.05, unpriced: 1 }, "Cost so far: unknown, its model's requests were not metered and 1 paid tool call"]);
});

test("an ended CLI run that left a request unanswered serves its Timeline cost unknown, with the known part: never a known total", async (t) => {
  const { store } = await storeOn(t);
  const claim = await claimed(store, { harness: "codex", runId: "run-1" });
  const j = store.journal(claim);
  const [conv, key] = [await j.mintId(), await j.mintId()];
  const [req1, turn1, req2] = [await j.mintId(), await j.mintId(), await j.mintId()];
  await commitWrites(j, [
    { type: "conversation", value: { id: ROOT } },
    entry(await j.mintId(), "agentrun.message", { role: "person", text: "Go." }),
    { type: "conversation", value: { id: conv } },
    entry(key, "agentrun.session.key", { key: "run:run-1", conversation: conv }),
    // One request answered at $0.01, one admitted whose answer was never booked (its end came first).
    { type: "entry", value: { id: req1, conversationId: conv, kind: "runner.request", data: { turn: 1, model: "gpt-test", heldUsd: 0.02 } } },
    { type: "entry", value: { id: turn1, conversationId: conv, kind: "runner.turn", data: { turn: 1, usd: 0.01 } } },
    { type: "entry", value: { id: req2, conversationId: conv, kind: "runner.request", data: { turn: 2, model: "gpt-test", heldUsd: 0.02 } } },
    entry(await j.mintId(), "agentrun.message", { role: "model", text: "Done." }),
  ], context);
  await store.runs.update(claim, { state: "ended", outcome: "completed", summary: "Done.", endedAt: T0 + 9 });
  const usage = (await servedTimelineRows({ serverSecrets: () => [], keyEnv: () => ({}) }, store, "run-1", context)).filter((row) => row.kind === "usage");
  assert.deepEqual(usage.map((row) => row.usage), [{ usd: null, requests: 2, so_far_usd: 0.01, unpriced: 1 }], `the unanswered request is a cost unknown on an ended run: ${JSON.stringify(usage)}`);
});

test("a running CLI run whose booked request has no figure lists its spend unknown (null), never $0", async (t) => {
  const { store } = await storeOn(t);
  const claim = await claimed(store, { harness: "claude-agent", runId: "run-1" });
  const j = store.journal(claim);
  const [conv, key, req, turn] = [await j.mintId(), await j.mintId(), await j.mintId(), await j.mintId()];
  await commitWrites(j, [
    { type: "conversation", value: { id: ROOT } },
    entry(await j.mintId(), "agentrun.message", { role: "person", text: "Go." }),
    { type: "conversation", value: { id: conv } },
    entry(key, "agentrun.session.key", { key: "run:run-1", conversation: conv }),
    { type: "entry", value: { id: req, conversationId: conv, kind: "runner.request", data: { turn: 1, model: "claude-sonnet-5-5" } } },
    { type: "entry", value: { id: turn, conversationId: conv, kind: "runner.turn", data: { turn: 1, usd: null } } },
    entry(await j.mintId(), "agentrun.message", { role: "model", text: "Working." }),
  ], context);
  assert.equal(await spentOverStore(store, "run-1", context), null, "its booked spend is unknown");
});

test("a workflow whose only bookings are decisions has a graph model-node cost of 0: its decisions are counted from their receipts alone", async (t) => {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-w", name: "Flow" }, { id: "rev-w", kind: "workflow", body: { workflow: { v: 2, name: "decide", root: { node: "chain", steps: [] } } } });
  await store.runs.create({ id: "run-w", agentId: "agent-w", revisionId: "rev-w" }, { body: { input: {}, title: "t", place: { mode: "runner" } } });
  const claim = await store.claim("run-w", "runner-a", { leaseMs: 60_000 });
  const j = store.journal(claim);
  const [flow, flowKey, dec, decKey, req, turn] = [await j.mintId(), await j.mintId(), await j.mintId(), await j.mintId(), await j.mintId(), await j.mintId()];
  await commitWrites(j, [
    { type: "conversation", value: { id: ROOT } },
    { type: "conversation", value: { id: flow } },
    entry(flowKey, "agentrun.session.key", { key: "workflow", conversation: flow }),
    { type: "conversation", value: { id: dec } },
    entry(decKey, "agentrun.session.key", { key: "decisions", conversation: dec }),
    { type: "entry", value: { id: req, conversationId: dec, kind: "runner.request", data: { turn: 1, model: "jev", heldUsd: 0.01 } } },
    { type: "entry", value: { id: turn, conversationId: dec, kind: "runner.turn", data: { turn: 1, usd: 0.01 } } },
  ], context);
  await store.runs.update(claim, { state: "ended", outcome: "completed", summary: "Decided.", costUsd: 0.01, endedAt: T0 + 9 });
  const facts = { kind: "workflow", status: "completed", agentId: "agent-w", revision: "rev-w", createdAt: new Date(T0).toISOString(), endedAt: new Date(T0 + 9).toISOString(), unshown: false };
  const graph = await runGraphView(store, "run-w", { env: {}, runWorkspace: async () => null, runFacts: async () => facts, withheld: async () => false, cutValues: async () => ({ values: [] }), context });
  // No receipt here, so the graph's total is its model-node part alone: 0, never the decisions' $0.01 again.
  assert.equal(graph.totals.cost_usd, 0, `the graph's model-node cost leaves the decisions out: ${JSON.stringify(graph.totals)}`);
});

/** A run on `harness` that made two model requests at $0.01 each and one call to an MCP tool with no price (the gateway's
 *  agentrun.tool_unmetered on the root), as pi writes it or as a CLI harness's record and booking do; ended unless
 *  `running`. */
async function unmeteredRun(t, harness, { running = false, stopped = false, aggregate = false } = {}) {
  const { store } = await storeOn(t);
  const claim = await claimed(store, { harness, runId: "run-1" });
  const j = store.journal(claim);
  const unmetered = entry(await j.mintId(), "agentrun.tool_unmetered", { tool: "mcp:hn/item", charged_by: "hn", call: "c1" });
  if (harness === "pi") {
    await commitWrites(j, [
      { type: "conversation", value: { id: ROOT } },
      { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "Read item 1.", timestamp: T0 }] } },
      { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "tool_use", content: [{ type: "toolCall", id: "c1", name: "mcp:hn/item", arguments: {} }], usage: { cost: { total: 0.01 } }, timestamp: T0 + 1 }] } },
      unmetered,
      { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "pi.tool-result", model: [{ role: "tool", toolCallId: "c1", content: "ok", timestamp: T0 + 2 }] } },
      { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }], usage: { cost: { total: 0.01 } }, timestamp: T0 + 3 }] } },
    ], context);
  } else {
    const [conv, key, req1, turn1, req2, turn2] = [await j.mintId(), await j.mintId(), await j.mintId(), await j.mintId(), await j.mintId(), await j.mintId()];
    await commitWrites(j, [
      { type: "conversation", value: { id: ROOT } },
      entry(await j.mintId(), "agentrun.message", { role: "person", text: "Read item 1." }),
      { type: "conversation", value: { id: conv } },
      entry(key, "agentrun.session.key", { key: "run:run-1", conversation: conv }),
      { type: "entry", value: { id: req1, conversationId: conv, kind: "runner.request", data: { turn: 1, model: "gpt-test", heldUsd: 0.02, ...(aggregate ? { aggregate: true } : {}) } } },
      { type: "entry", value: { id: turn1, conversationId: conv, kind: "runner.turn", data: { turn: 1, usd: 0.01 } } },
      entry(await j.mintId(), "agentrun.call.start", { callId: "c1", tool: "mcp:hn/item", input: {}, replaySafe: false }),
      unmetered,
      entry(await j.mintId(), "agentrun.call.end", { callId: "c1", status: "done", output: "ok" }),
      { type: "entry", value: { id: req2, conversationId: conv, kind: "runner.request", data: { turn: 2, model: "gpt-test", heldUsd: 0.02, ...(aggregate ? { aggregate: true } : {}) } } },
      { type: "entry", value: { id: turn2, conversationId: conv, kind: "runner.turn", data: { turn: 2, usd: 0.01 } } },
      entry(await j.mintId(), "agentrun.message", { role: "model", text: "Done." }),
    ], context);
  }
  if (stopped) await store.runs.update(claim, { state: "stopped", outcome: "stopped", summary: "Stopped.", costUsd: 0.02, endedAt: T0 + 9 });
  else if (!running) await store.runs.update(claim, { state: "ended", outcome: "completed", summary: "Done.", costUsd: 0.02, endedAt: T0 + 9 });
  return store;
}

/** The usage rows a run's served Timeline (the /timeline route) and its view's rows carry: [usage, summary] each. */
async function usageRowsOf(store) {
  const served = await servedTimelineRows({ serverSecrets: () => [], keyEnv: () => ({}) }, store, "run-1", context);
  const view = await timelineOverStore(store, "run-1", deps);
  return [served, view].map((rows) => rows.filter((row) => row.kind === "usage").map((row) => [row.usage, row.summary]));
}

for (const harness of ["pi", "codex", "claude-agent"]) {
  test(`a ${harness} run's usage row counts its tool calls not metered and, once ended, says its cost, never "so far": in the served Timeline and the view alike`, async (t) => {
    const ended = [[{ usd: 0.02, requests: 2, not_metered: 1 }, "Cost: $0.0200 over 2 model requests; 1 tool call not metered"]];
    assert.deepEqual(await usageRowsOf(await unmeteredRun(t, harness)), [ended, ended]);
  });
}

test("an agentic run a person stopped (its turn over, the run can go on) says its cost so far in the served Timeline and the view alike", async (t) => {
  for (const harness of ["pi", "codex"]) {
    const live = [[{ usd: 0.02, requests: 2, not_metered: 1 }, "Cost so far: $0.0200 over 2 model requests; 1 tool call not metered"]];
    assert.deepEqual(await usageRowsOf(await unmeteredRun(t, harness, { stopped: true })), [live, live], harness);
  }
});

test("a running run's usage row says what it has cost so far, on pi and a CLI harness alike", async (t) => {
  for (const harness of ["pi", "codex"]) {
    const live = [[{ usd: 0.02, requests: 2, not_metered: 1 }, "Cost so far: $0.0200 over 2 model requests; 1 tool call not metered"]];
    assert.deepEqual(await usageRowsOf(await unmeteredRun(t, harness, { running: true })), [live, live], harness);
  }
});

for (const harness of ["codex", "claude-agent"]) {
  test(`a native ${harness} aggregate keeps unknown request count and unmetered tool coverage in the ended usage row`, async (t) => {
    const ended = [[{ usd: 0.02, requests: null, not_metered: 1 }, "Cost: $0.0200; native model request count unavailable; 1 tool call not metered"]];
    assert.deepEqual(await usageRowsOf(await unmeteredRun(t, harness, { aggregate: true })), [ended, ended]);
  });
}
