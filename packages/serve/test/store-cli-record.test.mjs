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
const { viewOverStore } = await import("../dist/store-view.js");
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

  const cliRows = await runTimeline(store, "cli", context, { settled: true });
  const piRows = (await runTimeline(store, "pi", context, { settled: true })).filter((r) => r.kind !== "usage");
  // The CLI record reads the same person/model/call rows, in the same order, with the same words, as the pi run.
  assert.deepEqual(shown(cliRows), shown(piRows));
  assert.deepEqual(shown(cliRows).map((r) => r.kind), ["user_message", "text_block", "tool_use", "tool_result", "final_answer"]);

  // The run read's final answer is the last model message, and its cost its stored total (no $0/unknown usage row).
  const view = await viewOverStore(store, "cli", deps);
  assert.deepEqual(view.result, { output: null, final_answer: "There are two files." });
  assert.equal(view.status, "completed");
  assert.deepEqual(view.cost, { usd: 0.42, basis: "estimate", charge_state: null, cap_usd: null });
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
const shownAt = (rows) => rows.map((row) => (assert.equal(row.created_at, row.timestamp, row.kind), [row.kind, row.timestamp]));

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

  const rows = shown(await runTimeline(store, "run-1", context, { settled: true }));
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
// row the file path had on the run's root. The session's runner.request names the tool (model "paid:<name>") and the call
// it ran under, and who charged for it (charged_by); its runner.turn carries the cost; the charge is placed under that
// call, joined by `call`.
const paidSession = (convId, skId, reqId, turnId, { name = "mcp:fake/paid", call = "c1", usd = 0.05, chargedBy = "fake", turn = {} } = {}) => [
  { type: "conversation", value: { id: convId } },
  { type: "entry", value: { id: skId, conversationId: ROOT, kind: "agentrun.session.key", data: { key: "paid-tools", conversation: convId } } },
  { type: "entry", value: { id: reqId, conversationId: convId, kind: "runner.request", data: { turn: 1, model: `paid:${name}`, call, heldUsd: usd, charged_by: chargedBy } } },
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

test("a paid web_search charge's Tool cost row names who charged, from its record's charged_by", async (t) => {
  const { store } = await storeOn(t);
  const claim = await claimed(store, { harness: "pi", runId: "run-1" });
  const j = store.journal(claim);
  await commitWrites(j, [
    { type: "conversation", value: { id: ROOT } },
    { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "search", timestamp: T0 }] } },
    { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "tool_use", content: [{ type: "toolCall", id: "c1", name: "web_search", arguments: {} }], timestamp: T0 + 1 }] } },
    ...paidSession(await j.mintId(), await j.mintId(), await j.mintId(), await j.mintId(), { name: "web_search", usd: 0.005, chargedBy: "parallel" }),
    { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "pi.tool-result", model: [{ role: "tool", toolCallId: "c1", content: "ok", timestamp: T0 + 2 }] } },
    { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }], timestamp: T0 + 3 }] } },
  ], context);
  await store.runs.update(claim, { state: "ended", outcome: "completed", summary: "Done.", costUsd: 0.005, endedAt: T0 + 9 });

  const rows = await runTimeline(store, "run-1", context, { settled: true });
  const cost = rows.find((x) => x.kind === "phase" && /^Tool cost:/.test(x.summary ?? ""));
  assert.equal(cost?.summary, "Tool cost: parallel charged $0.0050 for web_search", JSON.stringify(shown(rows)));
});

/** A pi run with one web_search call whose paid-tools turn is `usd` (with `turn`'s other fields), ended; its charge rows. */
async function chargeRowsFor(t, usd, turn = {}) {
  const { store } = await storeOn(t);
  const claim = await claimed(store, { harness: "pi", runId: "run-1" });
  const j = store.journal(claim);
  await commitWrites(j, [
    { type: "conversation", value: { id: ROOT } },
    { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "search", timestamp: T0 }] } },
    { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "tool_use", content: [{ type: "toolCall", id: "c1", name: "web_search", arguments: {} }], timestamp: T0 + 1 }] } },
    ...paidSession(await j.mintId(), await j.mintId(), await j.mintId(), await j.mintId(), { name: "web_search", usd, chargedBy: "parallel", turn }),
    { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "pi.tool-result", model: [{ role: "tool", toolCallId: "c1", content: "ok", timestamp: T0 + 2 }] } },
    { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }], timestamp: T0 + 3 }] } },
  ], context);
  await store.runs.update(claim, { state: "ended", outcome: "completed", summary: "Done.", costUsd: 0, endedAt: T0 + 9 });
  const rows = await runTimeline(store, "run-1", context, { settled: true });
  return rows.filter((x) => x.kind === "phase" && /^(Tool cost|Not metered):/.test(x.summary ?? "")).map((x) => x.summary);
}

// A paid record's outcomes, each as main's timeline renders it (pi-durable-agent timeline.ts, the TOOL_COST row).
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
  // A CLI run's usage row says what its sessions booked (#2205): here the charge alone, its one paid tool call.
  const usage = rows.filter((x) => x.kind === "usage");
  assert.deepEqual(usage.map((x) => [x.summary, x.usage]), [["Cost so far: $0.0500 over 0 model requests and 1 paid tool call", { usd: 0.05, requests: 0 }]], `its usage row: ${JSON.stringify(usage)}`);
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
    { type: "entry", value: { id: req, conversationId: conv, kind: "runner.request", data: { turn: 1, model: "claude-sonnet-4-5" } } },
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
  const view = { kind: "workflow", status: "completed", agent_id: "agent-w", revision: "rev-w", created_at: new Date(T0).toISOString(), ended_at: new Date(T0 + 9).toISOString() };
  const graph = await runGraphView(store, "run-w", { env: {}, runWorkspace: async () => null, runView: async () => view, withheld: async () => false, cutValues: async () => ({ values: [] }), context });
  // No receipt here, so the graph's total is its model-node part alone: 0, never the decisions' $0.01 again.
  assert.equal(graph.totals.cost_usd, 0, `the graph's model-node cost leaves the decisions out: ${JSON.stringify(graph.totals)}`);
});
