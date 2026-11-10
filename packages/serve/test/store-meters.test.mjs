// /usage's per-run meters over the one store (store-reads/cap.ts metersOverStore), the figures server.ts's /usage route
// reads for a run that ended. Parity target: cap.ts meterFiguresIn, which the file-backed path read from a settled run's own
// database — metersOverStore computes the same figures over A's journal (cap.ts meterFiguresFrom), with the run's paid tool
// charges folded back from its paid-tools session (store-reads/journal.ts withPaidCosts) as the file-backed run held each on
// its root. One fixture run carries every meter kind; a red per meter, each citing cap.ts for its figure.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { storeOn, T0 } from "./store-helpers.mjs";

const { metersOverStore } = await import("../dist/store-reads/cap.js");

const context = BACKGROUND_CONTEXT;
const ROOT = 1;

/** An agent and a run of it claimed, ready for its journal. */
async function claimed(store, { harness = "pi", runId = "run-1" } = {}) {
  if (!(await store.agents.get("agent-1"))) await store.agents.create({ id: "agent-1", name: "First agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", harness } });
  await store.runs.create({ id: runId, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Hi" }, title: "Run", place: { mode: "runner" } } });
  return store.claim(runId, "runner-a", { leaseMs: 60_000 });
}

const piEntry = (id, kind, model) => ({ type: "entry", value: { id, conversationId: ROOT, kind, model } });

test("metersOverStore reads every meter of a run over its journal, matching the file path's meterFiguresIn figures", async (t) => {
  const { store } = await storeOn(t);
  const claim = await claimed(store, { harness: "pi", runId: "run-1" });
  const j = store.journal(claim);
  // The paid-tools session (kernel cap's TOOL_SESSION): one priced call (c1, $0.05) and one unpriced call (c2, not metered),
  // read back as the TOOL_COST / TOOL_UNMETERED the file path held on the run's root (store-reads/journal withPaidCosts).
  const conv = await j.mintId();
  await commitWrites(j, [
    { type: "conversation", value: { id: ROOT } },
    piEntry(await j.mintId(), "pi.user", [{ role: "user", content: "do things", timestamp: T0 }]),
    // One model request of known cost: $0.02 of tokens (the only entry on the tokens meter).
    piEntry(await j.mintId(), "pi.assistant", [{ role: "assistant", stopReason: "tool_use", content: [{ type: "text", text: "Working." }, { type: "toolCall", id: "c1", name: "mcp:fake/paid", arguments: {} }], usage: { cost: { total: 0.02 } }, timestamp: T0 + 1 }]),
    // The paid-tools session, on its own minted conversation (its session.key points to it from the root).
    { type: "conversation", value: { id: conv } },
    { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "agentrun.session.key", data: { key: "paid-tools", conversation: conv } } },
    { type: "entry", value: { id: await j.mintId(), conversationId: conv, kind: "runner.request", data: { turn: 1, model: "paid:mcp:fake/paid", call: "c1", heldUsd: 0.05 } } },
    { type: "entry", value: { id: await j.mintId(), conversationId: conv, kind: "runner.turn", data: { turn: 1, usd: 0.05 } } },
    { type: "entry", value: { id: await j.mintId(), conversationId: conv, kind: "runner.request", data: { turn: 2, model: "paid:mcp:other/free", call: "c2", heldUsd: 0 } } },
    { type: "entry", value: { id: await j.mintId(), conversationId: conv, kind: "runner.turn", data: { turn: 2, usd: 0 } } },
    piEntry(await j.mintId(), "pi.tool-result", [{ role: "tool", toolCallId: "c1", content: "ok", timestamp: T0 + 2 }]),
    // The unpriced paid call's own model request: $0 of tokens (a known cost, so the tokens meter stays known at $0.02).
    piEntry(await j.mintId(), "pi.assistant", [{ role: "assistant", stopReason: "tool_use", content: [{ type: "toolCall", id: "c2", name: "mcp:other/free", arguments: {} }], usage: { cost: { total: 0 } }, timestamp: T0 + 3 }]),
    piEntry(await j.mintId(), "pi.tool-result", [{ role: "tool", toolCallId: "c2", content: "free", timestamp: T0 + 4 }]),
    // A browser session charge, native TOOL_COST on the root (browser-cost.ts writes it there): $0.03 over 120 seconds.
    { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "agentrun.tool_cost", data: { tool: "browser", usd: 0.03, seconds: 120, call: "b1" } } },
    piEntry(await j.mintId(), "pi.assistant", [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }], usage: { cost: { total: 0 } }, timestamp: T0 + 5 }]),
  ], context);
  await store.runs.update(claim, { state: "ended", outcome: "completed", summary: "Done.", costUsd: 0.1, endedAt: T0 + 9 });

  const m = await metersOverStore(store, "run-1", context);

  // tools: every TOOL_COST's usd summed — the mcp charge and the browser charge both (cap.ts:676 `charges`, which pushes
  // every TOOL_COST including browser; cap.ts:668 keeps only non-browser out of `others`).
  assert.equal(m.tools, 0.05 + 0.03);
  // others: the non-browser paid charges alone (cap.ts:679 `otherTools`).
  assert.equal(m.others, 0.05);
  // browser: its own charge and seconds (cap.ts:673-674).
  assert.equal(m.browser.usd, 0.03);
  assert.equal(m.browser.seconds, 120);
  // tokens: the root conversation's settled usage row usd — model requests only, no tool charge (cap.ts:682, usage over
  // `rest` which excludes TOOL_COST).
  assert.equal(m.tokens, 0.02);
  // notMetered: the unpriced paid call, counted once as the usage row's not_metered (cap.ts:681; timeline folds each
  // TOOL_UNMETERED in). The next priced charge never joins it.
  assert.equal(m.notMetered, 1);
  // known: each meter's settled dollars, whatever else is unknown (cap.ts:664-680).
  assert.deepEqual(m.known, { tokens: 0.02, browser: 0.03, others: 0.05 });
});

test("a run with no journal reads as a store that was never there: every figure 0, tokens unknown (cap.ts meterFiguresIn's absent-store return)", async (t) => {
  const { store } = await storeOn(t);
  await claimed(store, { runId: "empty" });
  const m = await metersOverStore(store, "empty", context);
  assert.deepEqual(m, { tools: 0, tokens: null, browser: { usd: 0, seconds: 0 }, others: 0, known: { tokens: 0, browser: 0, others: 0 } });
});
