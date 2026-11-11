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

test("a run resumed on a second claim keeps what its first claim laid: the resume finds the skill there and lays none again, and the run still counts on the after side", async (t) => {
  const { store, clock } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  await run(store, clock, { id: "r1", start: T0, seconds: 10 });
  await run(store, clock, { id: "r2", start: T0 + 100_000, seconds: 20 });
  for (const [id, at] of [["r3", T0 + 1_000_000], ["r4", T0 + 2_000_000]]) await run(store, clock, { id, start: at, seconds: 40, learning: start({ skills: ["weekly-report"] }), extra: [laid(["weekly-report"]), laid([])], kept: lookedBack(at, 30) });
  const { impact } = await reads.agentLearningOverStore(store, "agent-1");
  assert.ok(impact, "the skill its first claim laid counts");
  assert.equal(impact.after.runs, 2);
});

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
    id: "r1", start: T0, learning: start({ skills: ["weekly-report", "find-policies"], workflows: ["answer"] }), kept: lookedBack(T0, 5), extra: [laid(["weekly-report", "find-policies"], ["answer"])],
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
  await run(store, clock, { id: "r2", start: T0 + 10_000, learning: start({ skills: ["weekly-report", "find-policies", "keep-dates", "unread"] }), kept: lookedBack(T0 + 10_000, 5), extra: [laid(["weekly-report", "find-policies"]), laid(["keep-dates", "unread"])], calls: [["read_skill_file", { skill: "find-policies", path: "SKILL.md" }, true], ["Skill", { skill: "keep-dates" }, true]] });
  const learning = await reads.runLearningOverStore(store, "r1", secretsShown([]), []);
  assert.deepEqual(learning.used, { skills: [{ name: "weekly-report", read: true }, { name: "find-policies", read: true }], workflows: [{ name: "answer", calls: 2, failed: 1 }] });
  const second = await reads.runLearningOverStore(store, "r2", secretsShown([]), []);
  assert.deepEqual(second.used.skills, [{ name: "weekly-report", read: false }, { name: "find-policies", read: true }, { name: "keep-dates", read: true }, { name: "unread", read: false }], "read_skill_file and Skill by their arguments; another file of a skill is no read of its SKILL.md");
});

// Review on #2337: a learned skill the claim did not lay (the revision holds a skill of that name, so only the revision's
// copy is installed) is not credited, even when the job read that path: `used.skills` is what the run's claims laid.
test("a run's used skills are the ones its claims laid: an offered skill a claim left out, the revision's own of that name read, is not credited", async (t) => {
  const { store, clock } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  await run(store, clock, {
    id: "r1", start: T0, learning: start({ skills: ["weekly-report", "find-policies"] }), kept: lookedBack(T0, 5), extra: [laid(["find-policies"])],
    calls: [["read", { path: ".agents/skills/weekly-report/SKILL.md" }, true], ["read", { path: ".agents/skills/find-policies/SKILL.md" }, true]],
  });
  const learning = await reads.runLearningOverStore(store, "r1", secretsShown([]), []);
  assert.deepEqual(learning.used.skills, [{ name: "find-policies", read: true }], JSON.stringify(learning.used));
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

// Review on #2337: claude-agent's own Skill tool is a native call: its session records it as a kernel step (tool.Skill),
// never as a host tool's call record. A load that completed reads the skill, by `agentrun:<name>` or its bare name; a
// load that failed, a load of another skill, and one in the end-of-run turn do not.
test("a skill loaded with claude-agent's own Skill tool reads as read: by its plugin name or its bare one, once its step completed, before the end-of-run turn", async (t) => {
  const { store, clock } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  const step = (call, skill, status) => [
    { kind: "kernel.start", data: { key: `tool:${call}`, stepId: `tool:${call}#0`, name: "tool.Skill", replay: "safe", input: { skill } } },
    { kind: "kernel.end", data: { stepId: `tool:${call}#0`, status } },
  ];
  await run(store, clock, {
    id: "r1", start: T0, learning: start({ skills: ["check-units", "find-policies", "keep-dates", "weekly-report"] }), kept: lookedBack(T0, 5),
    extra: [laid(["check-units", "find-policies", "keep-dates", "weekly-report"]), ...step("a", "agentrun:check-units", "completed"), ...step("b", "find-policies", "completed"), ...step("c", "agentrun:keep-dates", "failed"),
      { kind: "agentrun.end-of-run.turn", data: { role: "person", text: "The task is done." } }, ...step("d", "agentrun:weekly-report", "completed")],
  });
  const learning = await reads.runLearningOverStore(store, "r1", secretsShown([]), []);
  assert.deepEqual(learning.used.skills, [{ name: "check-units", read: true }, { name: "find-policies", read: true }, { name: "keep-dates", read: false }, { name: "weekly-report", read: false }], JSON.stringify(learning.used));
});

// Review on #2337: a reopened run has more than one end-of-run turn. A load in the job between them (the follow-up's) is
// the job's; only loads inside an end-of-run turn (its prompt to its answer) are left out.
test("a skill loaded with claude-agent's Skill tool after a reopened run's first end-of-run turn reads as read; one inside either turn does not", async (t) => {
  const { store, clock } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  const step = (call, skill) => [
    { kind: "kernel.start", data: { key: `tool:${call}`, stepId: `tool:${call}#0`, name: "tool.Skill", replay: "safe", input: { skill } } },
    { kind: "kernel.end", data: { stepId: `tool:${call}#0`, status: "completed" } },
  ];
  const turn = (role) => ({ kind: "agentrun.end-of-run.turn", data: { role, text: role === "person" ? "The task is done." : "Nothing to keep." } });
  await run(store, clock, {
    id: "r1", start: T0, learning: start({ skills: ["check-units", "find-policies", "keep-dates", "weekly-report"] }), kept: lookedBack(T0, 5),
    extra: [laid(["check-units", "find-policies", "keep-dates", "weekly-report"]), ...step("a", "agentrun:check-units"), turn("person"), ...step("b", "agentrun:find-policies"), turn("model"),
      { kind: "agentrun.message", data: { role: "person", text: "One more thing." } }, ...step("c", "agentrun:keep-dates"), turn("person"), ...step("d", "agentrun:weekly-report"), turn("model")],
  });
  const learning = await reads.runLearningOverStore(store, "r1", secretsShown([]), []);
  assert.deepEqual(learning.used.skills, [{ name: "check-units", read: true }, { name: "find-policies", read: false }, { name: "keep-dates", read: true }, { name: "weekly-report", read: false }], JSON.stringify(learning.used));
});

// Review on #2337: a read credits a learned skill only at the path the claim laid it, `.agents/skills/<name>/SKILL.md` in
// the run's work (relative, or absolute under it), never another file whose path merely ends the same way.
test("a read of a learned skill's SKILL.md is credited at its laid path only, never at another path ending in skills/<name>/SKILL.md", async (t) => {
  const { store, clock } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  const names = ["in-notes", "in-learning", "relative", "absolute", "dotted"];
  await run(store, clock, {
    id: "r1", start: T0, learning: start({ skills: names }), kept: lookedBack(T0, 5), extra: [laid(names)],
    calls: [
      ["read", { path: "notes/skills/in-notes/SKILL.md" }, true],
      ["read", { path: ".learning/skills/in-learning/SKILL.md" }, true],
      ["read", { path: ".agents/skills/relative/SKILL.md" }, true],
      ["read", { path: "/var/agentrun/runs/r1/work/.agents/skills/absolute/SKILL.md" }, true],
      ["read", { path: "./.agents/skills/dotted/SKILL.md" }, true],
    ],
  });
  const learning = await reads.runLearningOverStore(store, "r1", secretsShown([]), []);
  assert.deepEqual(learning.used.skills, [{ name: "in-notes", read: false }, { name: "in-learning", read: false }, { name: "relative", read: true }, { name: "absolute", read: true }, { name: "dotted", read: true }], JSON.stringify(learning.used));
});

// Review on #2337 (perf): the agent's learning page reads a settled run's journal once per claim, not on every request:
// what it reads there (the notes its job opened, what its claims laid) is kept by run id and epoch, and read again only
// once a new claim moves the epoch.
test("an agent's learning view reads a settled run's journal once, not on every request", async (t) => {
  const { store, clock } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  await run(store, clock, { id: "r1", start: T0, seconds: 10 });
  await run(store, clock, { id: "r2", start: T0 + 100_000, seconds: 20 });
  for (const [id, at] of [["r3", T0 + 1_000_000], ["r4", T0 + 2_000_000]]) await run(store, clock, { id, start: at, seconds: 40, learning: start({ skills: ["weekly-report"], given: [{ file: "a.md", name: "A" }] }), extra: [laid(["weekly-report"])], kept: lookedBack(at, 30) });
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
