// What a run shows of its learned workflows at work, from the one store (LS-10's server half):
//   - its impact counts a run started from a learned workflow its claim laid, so a workflow-only agent has one
//     (learning-run.ts learningImpact, store-reads/learning.ts impactLearningOf);
//   - GET /runs/{id}/learning says which learned workflows its job called, how often, and how many of those failed
//     (store-reads/learning.ts learnedUseOf);
//   - a learned_workflow call's timeline row carries the nodes its workflow ran (learned_nodes), from the entry the call
//     kept beside itself (learned-nodes.ts LEARNED_NODES), each text through the run's cut.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { storeOn, T0 } from "./store-helpers.mjs";

const reads = await import("../dist/store-reads/learning.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { secretsShown } = await import("../dist/learning.js");
const nodesModule = await import("../dist/learned-nodes.js").catch(() => ({}));
const LEARNED_NODES = nodesModule.LEARNED_NODES ?? "agentrun.learned_nodes";

const ROOT = 1;
const iso = (ms) => new Date(ms).toISOString();
const HELD = `not-a-secret-node-${process.pid}-held`;

/** Run `id` of agent-1 started at `start`, ended `seconds` later at `usd`: `learning` its launch's learning start, `calls`
 *  its job's tool calls ([name, args, ok]), `extra` more entries after them, `kept` its kept learning row's proposal. */
async function run(store, clock, { id, start, seconds = 10, usd = 0.1, learning, calls = [], extra = [], kept, open = false }) {
  clock.now = start;
  await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Go." }, title: id, place: { mode: "runner" }, ...(learning ? { learning } : {}) } });
  const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
  if (calls.length || extra.length) {
    const journal = store.journal(claim);
    const writes = [{ type: "conversation", value: { id: ROOT } }];
    for (const [i, [name, args, ok]] of calls.entries()) {
      const call = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: `c${i}`, name, arguments: args }], timestamp: start + i }] };
      const result = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: `c${i}`, toolName: name, content: [{ type: "text", text: ok ? "done" : "it failed" }], isError: !ok, timestamp: start + i }] };
      // `ok` null: a call still running, with no result yet.
      writes.push({ type: "entry", value: call }, ...(ok === null ? [] : [{ type: "entry", value: result }]));
    }
    for (const entry of extra) writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, ...entry } });
    await commitWrites(journal, writes, context);
  }
  const also = kept ? [{ table: "learning_proposals", row: { turn: {}, proposal: kept } }] : [];
  // `open`: a run still at work (a completed run resumed for a follow-up keeps its learning record): not settled.
  await store.runs.update(claim, open ? { state: "running" } : { state: "ended", costUsd: usd, endedAt: start + seconds * 1000 }, { also });
}
/** The entry a claim writes of what it laid (KINDS.learningLaid). */
const laid = (workflows = []) => ({ kind: "agentrun.learning.laid", data: { workflows } });
const lookedBack = (start, seconds) => ({ state: "dropped", reason: "empty", detail: "Nothing to keep.", answered_at: iso(start + seconds * 1000), job_cost_usd: 0.1, look_back_usd: 0.01 });
const start = (extra) => ({ seed: "a".repeat(40), section: "", ...extra });

test("a workflow-only agent has an impact: its runs whose claim laid a learned workflow are on the after side", async (t) => {
  const { store, clock } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  await run(store, clock, { id: "r1", start: T0, seconds: 10 });
  await run(store, clock, { id: "r2", start: T0 + 100_000, seconds: 20 });
  await run(store, clock, { id: "r3", start: T0 + 1_000_000, seconds: 40, learning: start({ workflows: ["answer"] }), extra: [laid(["answer"])], kept: lookedBack(T0 + 1_000_000, 30) });
  await run(store, clock, { id: "r4", start: T0 + 2_000_000, seconds: 60, learning: start({ workflows: ["answer"] }), extra: [laid(["answer"])], kept: lookedBack(T0 + 2_000_000, 50) });
  const { impact } = await reads.agentLearningOverStore(store, "agent-1");
  assert.ok(impact, `an impact: ${JSON.stringify(impact)}`);
  assert.deepEqual([impact.before.runs, impact.after.runs, impact.after.median_duration_s], [2, 2, 40]);
});

test("a run resumed on a second claim keeps what its first claim laid: the resume lays none again, and the run still counts on the after side", async (t) => {
  const { store, clock } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  await run(store, clock, { id: "r1", start: T0, seconds: 10 });
  await run(store, clock, { id: "r2", start: T0 + 100_000, seconds: 20 });
  for (const [id, at] of [["r3", T0 + 1_000_000], ["r4", T0 + 2_000_000]]) await run(store, clock, { id, start: at, seconds: 40, learning: start({ workflows: ["answer"] }), extra: [laid(["answer"]), laid([])], kept: lookedBack(at, 30) });
  const { impact } = await reads.agentLearningOverStore(store, "agent-1");
  assert.ok(impact, "the workflow its first claim laid counts");
  assert.equal(impact.after.runs, 2);
});

test("a workflow a run was offered but its claim did not lay does not put it on the after side", async (t) => {
  const { store, clock } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  await run(store, clock, { id: "r1", start: T0, seconds: 10 });
  await run(store, clock, { id: "r2", start: T0 + 100_000, seconds: 20 });
  for (const [id, at] of [["r3", T0 + 1_000_000], ["r4", T0 + 2_000_000]]) await run(store, clock, { id, start: at, seconds: 40, learning: start({ workflows: ["answer"] }), extra: [laid([])], kept: lookedBack(at, 30) });
  assert.equal((await reads.agentLearningOverStore(store, "agent-1")).impact, null, "no run started from a laid item");
});

test("a run's learning says which learned workflows its job called, how often, and how many failed", async (t) => {
  const { store, clock } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  await run(store, clock, {
    id: "r1", start: T0, learning: start({ workflows: ["answer", "unused"] }), kept: lookedBack(T0, 5), extra: [laid(["answer", "unused"])],
    calls: [
      ["read", { path: "notes.md" }, true],
      ["learned_workflow", { name: "answer", input: { question: "six times seven" } }, true],
      ["learned_workflow", { name: "answer", input: { question: "two" } }, false],
    ],
  });
  const learning = await reads.runLearningOverStore(store, "r1", secretsShown([]), []);
  assert.deepEqual(learning.used, { workflows: [{ name: "answer", calls: 2, failed: 1 }] });
});

// Review on #2337: a learned_workflow call still running (no result yet, e.g. a resumed run's follow-up) is not a failure.
// (Once the run settles, a call with no result was cut, and its row reads failed: that one counts.)
test("a learned workflow call with no result yet, on a run still at work, counts as a call, never as failed", async (t) => {
  const { store, clock } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  await run(store, clock, {
    id: "r1", start: T0, learning: start({ workflows: ["answer"] }), kept: lookedBack(T0, 5), extra: [laid([], ["answer"])],
    calls: [["learned_workflow", { name: "answer", input: { question: "one" } }, true], ["learned_workflow", { name: "answer", input: { question: "two" } }, false], ["learned_workflow", { name: "answer", input: { question: "three" } }, null]], open: true,
  });
  const learning = await reads.runLearningOverStore(store, "r1", secretsShown([]), []);
  assert.deepEqual(learning.used.workflows, [{ name: "answer", calls: 3, failed: 1 }], JSON.stringify(learning.used));
});

// Review on #2337 (perf): the agent's learning page reads a settled run's journal once per claim, not on every request:
// what it reads there (what its claims laid) is kept by run id and epoch, and read again only once a new claim moves the
// epoch.
test("an agent's learning view reads a settled run's journal once, not on every request", async (t) => {
  const { store, clock } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  await run(store, clock, { id: "r1", start: T0, seconds: 10 });
  await run(store, clock, { id: "r2", start: T0 + 100_000, seconds: 20 });
  for (const [id, at] of [["r3", T0 + 1_000_000], ["r4", T0 + 2_000_000]]) await run(store, clock, { id, start: at, seconds: 40, learning: start({ workflows: ["answer"] }), extra: [laid(["answer"])], kept: lookedBack(at, 30) });
  const opened = [];
  const readJournal = store.readJournal.bind(store);
  store.readJournal = (id, ...rest) => { opened.push(id); return readJournal(id, ...rest); };
  const first = await reads.agentLearningOverStore(store, "agent-1");
  assert.ok(first.impact, JSON.stringify(first.impact));
  const once = opened.filter((id) => id === "r3").length;
  assert.ok(once > 0, "the first read opens r3's journal");
  opened.length = 0;
  const second = await reads.agentLearningOverStore(store, "agent-1");
  assert.deepEqual(second.impact, first.impact);
  assert.deepEqual(opened.filter((id) => id === "r3" || id === "r4"), [], "a second read opens neither settled run's journal");
});

test("a run's use of learned workflows sits apart from what it learned: a run that learned a workflow keeps its learned list", async () => {
  const { runLearningBody } = await import("../dist/learning-routes.js");
  const learning = { state: "merged", reason: null, at: iso(T0), workflows: [{ file: "workflows/new-flow/workflow.json", name: "new-flow" }] };
  const body = runLearningBody({ id: "r1", learning, seed: "a".repeat(40), settled: true, used: { workflows: [{ name: "answer", calls: 1, failed: 0 }] } }, secretsShown([]), []);
  assert.deepEqual(body.workflows, [{ file: "workflows/new-flow/workflow.json", name: "new-flow" }], "what it learned");
  assert.deepEqual(body.used, { workflows: [{ name: "answer", calls: 1, failed: 0 }] }, "what it used");
});

test("a learned_workflow call's result row carries the nodes its workflow ran, each label through the run's cut, and never a node's error text", async (t) => {
  const { store, clock } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  const nodes = [{ label: "fetch", kind: "call", status: "ok", duration_ms: 12 }, { label: "answer", kind: "extract", status: "failed", duration_ms: 30, model: "gpt-6-luna", tier: "fast", error: `the model said ${HELD}` }];
  await run(store, clock, { id: "r1", start: T0, calls: [["learned_workflow", { name: "answer", input: {} }, false], ["read", { path: "x" }, true]], extra: [{ kind: LEARNED_NODES, data: { call: "c0", workflow: "answer", nodes } }] });
  const rows = await runTimeline(store, "r1", context, { settled: true, redact: (text) => text.replaceAll(HELD, "[redacted]") });
  const result = rows.find((row) => row.kind === "tool_result" && row.tool_use_id === "c0");
  // A model node's model and tier come through (the model through the run's cut, as every text); a call node has neither.
  assert.deepEqual(result?.learned_nodes, [nodes[0], { label: "answer", kind: "extract", status: "failed", duration_ms: 30, model: "gpt-6-luna", tier: "fast" }], JSON.stringify(result));
  assert.ok(!JSON.stringify(rows).includes(HELD.slice(0, 12)), "no part of the error's text, a secret's start among it");
  assert.equal(rows.find((row) => row.kind === "tool_result" && row.tool_use_id === "c1")?.learned_nodes, undefined, "another call's row carries none");
});

// A replay run's call rerun after a park and refused before any node ran keeps an entry of its own (nodes [], ended
// failed). The call's row shows the nodes of its last entry that ran a node, so the owner still sees what the workflow did.
test("a learned_workflow call rerun and refused before any node ran still shows its earlier attempt's nodes", async (t) => {
  const { store, clock } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  const nodes = [{ label: "fetch", kind: "call", status: "ok", duration_ms: 12 }];
  await run(store, clock, { id: "r1", start: T0, calls: [["learned_workflow", { name: "answer", input: {} }, false]], extra: [
    { kind: LEARNED_NODES, data: { call: "c0", workflow: "answer", nodes } },
    { kind: LEARNED_NODES, data: { call: "c0", workflow: "answer", nodes: [], ended: "failed" } },
  ] });
  const rows = await runTimeline(store, "r1", context, { settled: true });
  const result = rows.find((row) => row.kind === "tool_result" && row.tool_use_id === "c0");
  assert.deepEqual(result?.learned_nodes, nodes, JSON.stringify(result));
});
