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

const { runTimeline } = await import("../dist/store-reads/journal.js");
const { viewOverStore } = await import("../dist/store-view.js");

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
  // A CLI run drops the usage row, so the charge shows only on its Tool cost line.
  assert.equal(rows.filter((x) => x.kind === "usage").length, 0);
});
