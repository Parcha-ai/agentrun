// A replay records an escalate that reads a judge's field instead of obeying it (learn/promote.ts softEscalatesOf,
// WorkflowDeps.softEscalate): the workflow goes on to its draft, and the escalate's row (signal `escalate`, p 0 when it
// fired) scores as a hand-back where it fired at the serving setting. The refit (learn/refit.ts) may switch it off, and
// any guard too: an escalate or a guard that stops right drafts goes, one that stops wrong ones stays. A replay that
// hands back every input never clears the bar: it would never answer alone. Every other escalate stays hard in a replay,
// and serving obeys every escalate.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as dsl from "@parcha/agentrun-dsl";
import { CANARY } from "./fixtures/faux-jev.mjs";
import { scratch, withEnv } from "./support.mjs";
import { learnedWorkflowTool } from "../dist/learned-workflow.js";
import { guardsOf } from "../dist/learned-nodes.js";
import { clears, escalates, replayScore, SOFT_ESCALATE_THRESHOLD, softEscalatesOf } from "../dist/learn/promote.js";
import { refitGuards } from "../dist/learn/refit.js";
import { replayCalls } from "../dist/learn/replay-calls.js";
import { decisionProvidersIn } from "../dist/decisions.js";

const FAUX_JEV = new URL("./fixtures/faux-jev.mjs", import.meta.url).pathname;
const NOW = "2026-11-14T00:00:00.000Z";

const schemas = {
  In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
  Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
  Check: { type: "object", required: ["unsupported"], properties: { unsupported: { type: "boolean", description: "Is the answer unsupported by the question?" } } },
};
/** The MCC shape: a draft, a judge of it, an escalate on the judge's field; `big`, an escalate on the draft itself. */
const judged = (extra = []) => ({
  v: 2, name: "answer", schemas, input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [
    { node: "extract", label: "draft", instructions: "Answer the question.", out: "Answer", as: "answer" },
    { node: "judge", label: "check", state: { answer: "{answer.answer}", question: "{question}" }, out: "Check", as: "check" },
    { node: "escalate", label: "unsupported", when: { predicate: "field_equals", path: "check.unsupported", value: true }, kind: "unsupported", stage: "check", summary: "the check says {answer.answer} is unsupported" },
    ...extra,
  ] },
});
const BIG = { node: "escalate", label: "big", when: { predicate: "gte", path: "answer.answer", n: 40 }, kind: "review", stage: "draft", summary: "{answer.answer} is big" };

test("softEscalatesOf: an escalate whose `when` reads a judge's field, its `not` too, a child's by its prefixed label; never one on a draft or the input", () => {
  assert.deepEqual([...softEscalatesOf(judged([BIG]))], ["unsupported"]);
  const not = judged([{ ...BIG, label: "supported", when: { predicate: "not", of: { predicate: "field_true", path: "check.unsupported" } } }]);
  assert.deepEqual([...softEscalatesOf(not)].sort(), ["supported", "unsupported"]);
  const parent = { v: 2, name: "outer", schemas, root: { node: "chain", steps: [
    { node: "workflow", label: "inner", workflow: judged(), input: { question: "{question}" }, out: "Answer", as: "out" },
    // The parent has no judge named `check`: its escalate on that path is not a judge's.
    { node: "escalate", label: "outer-check", when: { predicate: "field_equals", path: "check.unsupported", value: true }, kind: "k", stage: "s", summary: "x" },
  ] } };
  assert.deepEqual([...softEscalatesOf(parent)], ["inner/unsupported"]);
});

/** The run's decisions on the faux Jev (every yes 0.92: `unsupported` true, so the escalate fires). */
async function decisionsOf(t) {
  const calls = join(await scratch(t), "jev.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_JEV_CALLS: calls }, ["AGENTRUN_TEST_FAUX_JEV_STATUS", "AGENTRUN_TEST_FAUX_JEV_HANG", "AGENTRUN_TEST_FAUX_JEV_NO_USAGE", "AGENTRUN_TEST_FAUX_JEV_COST"]);
  const providers = await decisionProvidersIn({ TYPESAFE_API_KEY: CANARY, AGENTRUN_SERVE_FAUX: "1", AGENTRUN_SERVE_FAUX_JEV: FAUX_JEV });
  const book = { async admit() { return { holdUsd: 0.001 }; }, async settle(_id, how) { return how.usd ?? null; }, spentUsd: () => 0, heldUsd: () => 0 };
  return { providers, book, pause: async () => assert.fail("no pause"), sent: () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0) };
}

const MODEL = { id: "stand-in", provider: "stand-in", api: "stand-in", name: "stand-in", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4_000 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message = (content, stopReason) => ({ role: "assistant", content, stopReason, api: MODEL.api, provider: MODEL.provider, model: MODEL.id, usage, timestamp: Date.now() });

/** One learned_workflow call of `flow` (its draft submits {answer: 42}), a replay's when `replay`: what it said and its
 *  guard rows. */
async function call(t, flow, { replay = false } = {}) {
  const work = mkdtempSync(join(tmpdir(), "learned-soft-escalate-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const models = {
    getModel: () => MODEL,
    getModels: () => [MODEL],
    completeSimple: async (_model, context) => {
      const answered = (context?.messages ?? []).some((m) => m.role === "toolResult");
      return answered ? message([{ type: "text", text: "Done." }], "stop") : message([{ type: "toolCall", id: "submit-1", name: "submit", arguments: { value: { answer: 42 } } }], "toolUse");
    },
  };
  const decisions = await decisionsOf(t);
  const tool = learnedWorkflowTool({
    workflows: [{ name: "answer", description: "Answers a question", workflow: JSON.stringify(flow) }], granted: [], env: {}, work, models,
    modelOf: () => ({ provider: "stand-in", modelId: "stand-in" }), policy: () => "allow", denyFrom: () => "agent", decisions,
    ...(replay ? { replay: replayCalls(new Map(), () => "read") } : {}),
  });
  const kept = [];
  const api = { callId: "call-1", commit: async (change) => change({ appendEntry: async (_conversation, entry) => void kept.push(entry) }) };
  const said = await tool.execute({ name: "answer", input: { question: "six times seven" } }, api, { abortSignal: new AbortController().signal });
  return { said, text: (said.output ?? []).map((part) => part.text ?? "").join(""), rows: guardsOf(kept), ended: kept.at(-1)?.data?.ended, asked: decisions.sent() };
}

test("a replay goes on past an escalate on a judge's field to the draft, and records that it fired; serving hands back there", { timeout: 60_000 }, async (t) => {
  const replayed = await call(t, judged(), { replay: true });
  assert.equal(replayed.said.isError, false, replayed.text);
  assert.equal(replayed.ended, "complete");
  assert.match(replayed.text, /42/, "the draft is the replay's answer");
  assert.equal(replayed.asked, 1, "the judge was asked");
  assert.deepEqual(replayed.rows, [{ node: "unsupported", signal: "escalate", p: 0, threshold: SOFT_ESCALATE_THRESHOLD, escalated: false, workflow: "answer" }]);
  // Scored at the serving setting, it is a hand-back: the replay records it, it does not take it away.
  const row = { of: "g1", recorded: { answer: "42", correct: true }, outcome: "answered", answer: "42", guards: replayed.rows };
  assert.equal(escalates(row, new Map()), true);
  const served = await call(t, judged());
  assert.equal(served.said.isError, true, served.text);
  assert.equal(served.ended, "escalated", "serving obeys it");
  assert.deepEqual(served.rows, []);
});

test("an escalate on the draft itself stays hard in a replay: it stops the run as serving does", { timeout: 60_000 }, async (t) => {
  // `big` fires on 42 and reads the extract's field, not a judge's.
  const flow = judged();
  flow.root.steps.splice(1, 0, BIG);
  const replayed = await call(t, flow, { replay: true });
  assert.equal(replayed.ended, "escalated", replayed.text);
  assert.equal(replayed.asked, 0, "it stopped before the judge");
  assert.deepEqual(replayed.rows, []);
});

/** A refit row of one replayed input: its draft right or wrong, the agent's grade, and whether `unsupported` fired. */
const esc = (fired) => ({ node: "unsupported", signal: "escalate", p: fired ? 0 : 1, threshold: SOFT_ESCALATE_THRESHOLD, escalated: false });
const draftRow = ({ right, fired, agent = 1 }) => ({ guards: [esc(fired)], answered: true, wfCorrect: right, agentCorrect: agent });

test("refit: an escalate that stops right drafts is switched off, its node dropped; the new text runs and answers alone", () => {
  // The calibration's shape: the check fires on most inputs, and the drafts it stops are right as often as the agent is.
  const rows = [
    ...Array.from({ length: 8 }, () => draftRow({ right: true, fired: true })),
    draftRow({ right: true, fired: false }),
    draftRow({ right: false, fired: false, agent: 0 }),
  ];
  const text = JSON.stringify(judged());
  const before = replayScore(rows.map((r, i) => ({ of: `g${i}`, recorded: { answer: "x", correct: r.agentCorrect === 1 }, outcome: "answered", answer: null, guards: r.guards })), new Map());
  assert.equal(before.handed_back, 8);
  const refit = refitGuards(text, rows, NOW);
  assert.deepEqual(refit.guards, [{ node: "unsupported", was: null, threshold: null, escalate: true }]);
  assert.deepEqual({ handed_back: refit.handed_back, delta: refit.delta, wf_acc: refit.wf_acc }, { handed_back: 0, delta: 0, wf_acc: 0.9 });
  assert.equal(clears(refit), true);
  const doc = JSON.parse(refit.text);
  assert.deepEqual(doc.root.steps.map((step) => step.label), ["draft", "check"], "the escalate is gone; the rest as it was");
  assert.deepEqual(dsl.validateWorkflow(doc), { ok: true });
});

test("refit: an escalate that stops wrong drafts stays; nothing changes", () => {
  const rows = [
    ...Array.from({ length: 4 }, () => draftRow({ right: false, fired: true })),
    draftRow({ right: true, fired: true }),
    ...Array.from({ length: 5 }, () => draftRow({ right: true, fired: false })),
  ];
  const refit = refitGuards(JSON.stringify(judged()), rows, NOW);
  assert.equal(refit.text, undefined, JSON.stringify(refit.guards));
  assert.deepEqual(refit.guards, []);
  assert.deepEqual({ handed_back: refit.handed_back, wf_acc: refit.wf_acc }, { handed_back: 5, wf_acc: 1 });
});

test("refit: a guard whose p says nothing of right and wrong is switched off; a guard that tells them apart keeps a threshold", () => {
  const flow = { v: 2, name: "pick", schemas: {}, root: { node: "chain", steps: [
    { node: "extract", label: "facts", guard: { signal: "jev", threshold: 0.7 } },
    { node: "agent", label: "answer", guard: { signal: "jev", threshold: 0.2 } },
  ] } };
  // facts: p 0.06 or 0.9 whatever the answer (no signal; at 0.7 it hands back half); answer: 0.3 on the two wrong rows.
  const rows = Array.from({ length: 10 }, (_, i) => {
    const wrong = i < 2;
    const facts = i % 2 ? 0.9 : 0.06;
    return { guards: [{ node: "facts", signal: "jev", jev: facts, p: facts, threshold: 0.7, escalated: false }, { node: "answer", signal: "jev", jev: wrong ? 0.3 : 0.9, p: wrong ? 0.3 : 0.9, threshold: 0.2, escalated: false }], answered: true, wfCorrect: !wrong, agentCorrect: 1 };
  });
  const refit = refitGuards(JSON.stringify(flow), rows, NOW);
  const by = Object.fromEntries(refit.guards.map((one) => [one.node, one]));
  assert.deepEqual(by.facts, { node: "facts", was: 0.7, threshold: null }, "off");
  assert.equal(by.answer.threshold, 0.9, "past its wrong rows' 0.3");
  assert.equal(refit.handed_back, 2);
  const doc = JSON.parse(refit.text);
  assert.equal("guard" in doc.root.steps[0], false, "the revision has no guard on facts");
  assert.equal(doc.root.steps[1].guard.threshold, 0.9);
});

test("a replay that hands back every input never clears the bar, however close its accuracy: it would never answer alone", () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ of: `g${i}`, recorded: { answer: "42", correct: true }, outcome: "answered", answer: "42", guards: [esc(true)] }));
  const score = replayScore(rows, new Map());
  assert.deepEqual(score, { n: 6, agree: 0, agent_acc: 1, wf_acc: 1, delta: 0, handed_back: 6, alone: 0 });
  assert.equal(clears(score), false);
  assert.equal(clears({ ...score, handed_back: 5 }), true, "one answered alone");
});
