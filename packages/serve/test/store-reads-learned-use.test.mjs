// What a run shows of its learned skills and workflows at work, from the one store (LS-10's server half):
//   - its impact counts a run started from a learned skill or a learned workflow, not only a note, so a skill-only or a
//     workflow-only agent has one (learning-run.ts learningImpact, store-reads/learning.ts impactLearningOf);
//   - GET /runs/{id}/learning says which offered skills its job read, and which learned workflows it called, how often,
//     and how many of those failed (store-reads/learning.ts learnedUseOf), the end-of-run turn's own left out;
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
async function run(store, clock, { id, start, seconds = 10, usd = 0.1, learning, calls = [], extra = [], kept }) {
  clock.now = start;
  await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Go." }, title: id, place: { mode: "runner" }, ...(learning ? { learning } : {}) } });
  const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
  if (calls.length || extra.length) {
    const journal = store.journal(claim);
    const writes = [{ type: "conversation", value: { id: ROOT } }];
    for (const [i, [name, args, ok]] of calls.entries()) {
      const call = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: `c${i}`, name, arguments: args }], timestamp: start + i }] };
      const result = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: `c${i}`, toolName: name, content: [{ type: "text", text: ok ? "done" : "it failed" }], isError: !ok, timestamp: start + i }] };
      writes.push({ type: "entry", value: call }, { type: "entry", value: result });
    }
    for (const entry of extra) writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, ...entry } });
    await commitWrites(journal, writes, context);
  }
  const also = kept ? [{ table: "learning_proposals", row: { turn: {}, proposal: kept } }] : [];
  await store.runs.update(claim, { state: "ended", costUsd: usd, endedAt: start + seconds * 1000 }, { also });
}
/** The entry a claim writes of what it laid (KINDS.learningLaid). */
const laid = (skills = [], workflows = []) => ({ kind: "agentrun.learning.laid", data: { skills, workflows } });
const lookedBack = (start, seconds) => ({ state: "dropped", reason: "empty", detail: "Nothing to keep.", answered_at: iso(start + seconds * 1000), job_cost_usd: 0.1, look_back_usd: 0.01 });
const start = (extra) => ({ given: [], seed: "a".repeat(40), section: "", seedNotes: 0, ...extra });

for (const [what, offered, given] of [["skill", { skills: ["weekly-report"] }, laid(["weekly-report"])], ["workflow", { workflows: ["answer"] }, laid([], ["answer"])]]) {
  test(`a ${what}-only agent has an impact: its runs whose claim laid a learned ${what} are on the after side`, async (t) => {
    const { store, clock } = await storeOn(t);
    await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
    await run(store, clock, { id: "r1", start: T0, seconds: 10 });
    await run(store, clock, { id: "r2", start: T0 + 100_000, seconds: 20 });
    await run(store, clock, { id: "r3", start: T0 + 1_000_000, seconds: 40, learning: start(offered), extra: [given], kept: lookedBack(T0 + 1_000_000, 30) });
    await run(store, clock, { id: "r4", start: T0 + 2_000_000, seconds: 60, learning: start(offered), extra: [given], kept: lookedBack(T0 + 2_000_000, 50) });
    const { impact } = await reads.agentLearningOverStore(store, "agent-1");
    assert.ok(impact, `an impact: ${JSON.stringify(impact)}`);
    assert.deepEqual([impact.before.runs, impact.after.runs, impact.after.median_duration_s], [2, 2, 40]);
  });
}

test("a skill a run was offered but its claim did not lay (over the budget, a name the revision holds) does not put it on the after side", async (t) => {
  const { store, clock } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  await run(store, clock, { id: "r1", start: T0, seconds: 10 });
  await run(store, clock, { id: "r2", start: T0 + 100_000, seconds: 20 });
  for (const [id, at] of [["r3", T0 + 1_000_000], ["r4", T0 + 2_000_000]]) await run(store, clock, { id, start: at, seconds: 40, learning: start({ skills: ["weekly-report"] }), extra: [laid([])], kept: lookedBack(at, 30) });
  assert.equal((await reads.agentLearningOverStore(store, "agent-1")).impact, null, "no run started from a laid item");
});

test("a run's learning says which offered skills its job read and which learned workflows it called, how often, and how many failed", async (t) => {
  const { store, clock } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  await run(store, clock, {
    id: "r1", start: T0, learning: start({ skills: ["weekly-report", "find-policies"], workflows: ["answer"] }), kept: lookedBack(T0, 5),
    calls: [
      ["read", { path: ".agents/skills/weekly-report/SKILL.md" }, true],
      // A CLI adapter's read of a skill's file, and claude-agent's Skill tool: read from the call's recorded arguments,
      // which a timeline row's input preview leaves out.
      ["read_skill_file", { skill: "find-policies", path: "SKILL.md" }, true],
      ["Skill", { skill: "keep-dates" }, true],
      ["read_skill_file", { skill: "weekly-report", path: "reference.md" }, true],
      ["learned_workflow", { name: "answer", input: { question: "six times seven" } }, true],
      ["learned_workflow", { name: "answer", input: { question: "two" } }, false],
    ],
  });
  await run(store, clock, { id: "r2", start: T0 + 10_000, learning: start({ skills: ["weekly-report", "find-policies", "keep-dates", "unread"] }), kept: lookedBack(T0 + 10_000, 5), calls: [["read_skill_file", { skill: "find-policies", path: "SKILL.md" }, true], ["Skill", { skill: "keep-dates" }, true]] });
  const learning = await reads.runLearningOverStore(store, "r1", secretsShown([]), []);
  assert.deepEqual(learning.used, { skills: [{ name: "weekly-report", read: true }, { name: "find-policies", read: true }], workflows: [{ name: "answer", calls: 2, failed: 1 }] });
  const second = await reads.runLearningOverStore(store, "r2", secretsShown([]), []);
  assert.deepEqual(second.used.skills, [{ name: "weekly-report", read: false }, { name: "find-policies", read: true }, { name: "keep-dates", read: true }, { name: "unread", read: false }], "read_skill_file and Skill by their arguments; another file of a skill is no read of its SKILL.md");
});

test("a run's use of learned skills and workflows sits apart from what it learned: a run that learned a skill keeps its learned list", async () => {
  const { runLearningBody } = await import("../dist/learning-routes.js");
  const learning = { state: "merged", reason: null, at: iso(T0), skills: [{ file: "skills/new-skill/SKILL.md", name: "new-skill" }], workflows: [{ file: "workflows/new-flow/workflow.json", name: "new-flow" }] };
  const body = runLearningBody({ id: "r1", learning, seed: "a".repeat(40), settled: true, used: { skills: [{ name: "weekly-report", read: true }], workflows: [{ name: "answer", calls: 1, failed: 0 }] } }, secretsShown([]), []);
  assert.deepEqual(body.skills, [{ file: "skills/new-skill/SKILL.md", name: "new-skill" }], "what it learned");
  assert.deepEqual(body.workflows, [{ file: "workflows/new-flow/workflow.json", name: "new-flow" }]);
  assert.deepEqual(body.used, { skills: [{ name: "weekly-report", read: true }], workflows: [{ name: "answer", calls: 1, failed: 0 }] }, "what it used");
});

test("a learned_workflow call's result row carries the nodes its workflow ran, each label through the run's cut, and never a node's error text", async (t) => {
  const { store, clock } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  const nodes = [{ label: "fetch", kind: "call", status: "ok", duration_ms: 12 }, { label: "answer", kind: "extract", status: "failed", duration_ms: 30, error: `the model said ${HELD}` }];
  await run(store, clock, { id: "r1", start: T0, calls: [["learned_workflow", { name: "answer", input: {} }, false], ["read", { path: "x" }, true]], extra: [{ kind: LEARNED_NODES, data: { call: "c0", workflow: "answer", nodes } }] });
  const rows = await runTimeline(store, "r1", context, { settled: true, redact: (text) => text.replaceAll(HELD, "[redacted]") });
  const result = rows.find((row) => row.kind === "tool_result" && row.tool_use_id === "c0");
  assert.deepEqual(result?.learned_nodes, [nodes[0], { label: "answer", kind: "extract", status: "failed", duration_ms: 30 }], JSON.stringify(result));
  assert.ok(!JSON.stringify(rows).includes(HELD.slice(0, 12)), "no part of the error's text, a secret's start among it");
  assert.equal(rows.find((row) => row.kind === "tool_result" && row.tool_use_id === "c1")?.learned_nodes, undefined, "another call's row carries none");
});
