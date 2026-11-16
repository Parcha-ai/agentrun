// Guards that keep their value (learn/refit.ts, learn/promote.ts inheritGuards, learn/compile.ts, runner/promotion.ts):
// a refit switches a guard off (or an escalate) only when it caught none of at least DROP_MIN_WRONG wrong answers past
// its step, never on rows with fewer (where off always looks free): on those a guard only comes down to just under the
// lowest p a right answer read at its step (lowerFloor); a refit
// that is written is fit on one half of its rows and must clear the bar on the other half too; and a new revision of a
// workflow with a champion takes the champion's fitted guards, so a compile never resets them to the defaults.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { landWorkflows } from "./learned-workflow-seed-support.mjs";

const { DROP_MIN_WRONG, halvesOf, lowerFloor, mayLower, REFIT_MIN, refitGuards, refitHeldOut, scoreRows, UNDER_RIGHT } = await import("../dist/learn/refit.js");
const { clears, guardsOffOf, inheritGuards, putGrade, promotionsOf, putGuardsOff, recordPromotion, REFIT_EVERY, REPLAY_MIN, SOFT_ESCALATE_THRESHOLD, switchedOffOf } = await import("../dist/learn/promote.js");
const { createReflectHook } = await import("../dist/runner/reflect-hook.js");
const compile = await import("../dist/learn/compile.js");
const { parseReflection } = await import("../dist/learn/reflect.js");
const { draftFiles } = await import("../dist/learn/skills.js");
const { championFor } = await import("../dist/runner/learning-end.js");
const { promotionGate } = await import("../dist/runner/promotion.js");
const { workflowDigest } = await import("../dist/runner/workflow-first.js");
const { secretsShown } = await import("../dist/learning.js");
const { learningWorkspace } = await import("../dist/workspace/index.js");

const NOW = "2026-11-16T00:00:00.000Z";
/** A workflow of two guarded agent steps, `facts` then `check`, each guard on its own confidence at its threshold. */
const twoSteps = (facts, check) => JSON.stringify({ v: 2, name: "answer", schemas: {}, root: { node: "chain", steps: [
  { node: "agent", label: "facts", guard: { signal: "self", threshold: facts } },
  { node: "agent", label: "check", guard: { signal: "self", threshold: check } },
] } });
/** A guard row as a replay records it (record-only: its threshold the least the DSL takes). */
const g = (node, p, threshold = 1e-9) => ({ node, signal: "self", self: p, p, threshold, escalated: false });
const answered = (guards, right, agent = 1) => ({ guards, answered: true, wfCorrect: right, agentCorrect: agent });

test("mayLower: leave to come down takes at least DROP_MIN_WRONG wrong answers past the step, not one of them caught", () => {
  const wrong = (p) => answered([g("check", p)], false);
  assert.equal(DROP_MIN_WRONG, 3);
  assert.equal(mayLower([wrong(0.9), wrong(0.9)], "check", 0.5), false, "two wrong answers show nothing");
  assert.equal(mayLower([wrong(0.9), wrong(0.9), wrong(0.8)], "check", 0.5), true, "three let through, none caught");
  assert.equal(mayLower([wrong(0.9), wrong(0.9), wrong(0.8), wrong(0.2)], "check", 0.5), false, "one caught: it earns its keep");
  assert.equal(mayLower([wrong(0.9), wrong(0.9), answered([g("facts", 0.9)], false)], "check", 0.5), false, "a wrong answer whose step it never reached is no evidence");
  assert.equal(mayLower(Array.from({ length: 20 }, () => answered([g("check", 0.3)], true)), "check", 0.5), false, "no wrong answers: nothing to show");
});

// (a) Red on main: 3 wrong of 150 is within PROMOTE_BAR, so the in-sample refit switched off the one guard that caught them.
test("a planted guard that alone flags the wrong answers survives the refit; a guard that caught none of them goes", () => {
  const rows = Array.from({ length: 150 }, (_, i) => {
    if (i < 3) return answered([g("facts", 0.9), g("check", 0.1)], false);
    return answered([g("facts", i < 13 ? 0.3 : 0.9), g("check", 0.9)], true);
  });
  const refit = refitGuards(twoSteps(0.7, 0.5), rows, NOW);
  assert.deepEqual(refit.guards, [{ node: "facts", was: 0.7, threshold: null }], "facts let the three wrong answers through and handed back right ones: off; check stays");
  const doc = JSON.parse(refit.text);
  assert.equal("guard" in doc.root.steps[0], false);
  assert.deepEqual(doc.root.steps[1].guard, { signal: "self", threshold: 0.5 }, "check keeps its threshold");
  assert.deepEqual({ handed_back: refit.handed_back, wf_acc: refit.wf_acc }, { handed_back: 3, wf_acc: 1 }, "the three wrong answers still go back");
});

/** answer-shaped flow with a judge and an escalate on its field: a soft escalate a replay records (DSL softEscalates). */
const judged = () => JSON.stringify({ v: 2, name: "answer",
  schemas: { In: { type: "object" }, Answer: { type: "object", properties: { answer: { type: "number" } } }, Check: { type: "object", properties: { unsupported: { type: "boolean" } } } },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [
    { node: "agent", label: "draft", instructions: "Answer.", out: "Answer", as: "answer", guard: { signal: "self", threshold: 0.7 } },
    { node: "judge", label: "check", state: { answer: "{answer.answer}" }, out: "Check", as: "check" },
    { node: "escalate", label: "unsupported", when: { predicate: "field_equals", path: "check.unsupported", value: true }, kind: "unsupported", stage: "check", summary: "unsupported" },
  ] } });
const esc = (fired) => ({ node: "unsupported", signal: "escalate", p: fired ? 0 : 1, threshold: SOFT_ESCALATE_THRESHOLD, escalated: false });

// (b) Red on main: with every answer right, the refit switched every guard off (and an escalate that fired) for free.
// Amended (r2): on rows with fewer than DROP_MIN_WRONG wrong answers a guard comes down to just under the lowest p a
// right answer read at its step (UNDER_RIGHT under it), never off.
test("rows with no wrong answer switch nothing off: each guard comes down to just under its right answers' lowest p, an escalate stays", () => {
  const rows = Array.from({ length: 20 }, (_, i) => answered([g("facts", i % 2 ? 0.3 : 0.9), g("check", i % 3 ? 0.6 : 0.95)], true));
  const refit = refitGuards(twoSteps(0.7, 0.7), rows, NOW);
  assert.deepEqual(refit.guards, [{ node: "facts", was: 0.7, threshold: 0.299999 }, { node: "check", was: 0.7, threshold: 0.599999 }]);
  assert.equal(refit.handed_back, 0, "no right answer the rows saw goes back");
  assert.equal(UNDER_RIGHT, 1e-6);
  assert.deepEqual([lowerFloor(rows, "facts", 0.7), lowerFloor(rows, "check", 0.7), lowerFloor(rows, "check", 0.5)], [0.299999, 0.599999, 0.5], "never above its own threshold");
  const held = refitHeldOut(twoSteps(0.7, 0.7), rows, NOW);
  assert.ok(held.guards.length > 0 && held.guards.every((one) => one.threshold !== null && one.threshold < 0.7), `fit on half, each comes down and none goes off: ${JSON.stringify(held.guards)}`);
  // A recorded escalate that fired on right drafts shows nothing of what it is worth: it stays. The guard comes down.
  const escalated = Array.from({ length: 20 }, (_, i) => answered([g("draft", 0.5), esc(i < 12)], true));
  const kept = refitGuards(judged(), escalated, NOW);
  assert.deepEqual(kept.guards, [{ node: "draft", was: 0.7, threshold: 0.499999 }], "the escalate stays");
  assert.equal(JSON.parse(kept.text).root.steps.at(-1).node, "escalate");
  // Fewer than DROP_MIN_WRONG wrong answers, one let through above the right answers' lowest p: still just under it.
  const two = [...rows, answered([g("facts", 0.95), g("check", 0.95)], false), answered([g("facts", 0.95), g("check", 0.95)], false)];
  assert.deepEqual([lowerFloor(two, "facts", 0.7), mayLower(two, "facts", 0.7)], [0.299999, false]);
  // No right answer reached the step: it keeps its threshold.
  assert.equal(lowerFloor([answered([g("facts", 0.9)], false)], "check", 0.7), 0.7);
  // Raising stays allowed: a guard set too low goes up past the wrong answers it let through (and facts, which let all
  // four through and caught none, goes).
  const low = Array.from({ length: 20 }, (_, i) => answered([g("facts", 0.9), g("check", i < 4 ? 0.3 : 0.9)], i >= 4));
  assert.deepEqual(refitGuards(twoSteps(0.7, 0.2), low, NOW).guards, [{ node: "facts", was: 0.7, threshold: null }, { node: "check", was: 0.2, threshold: 0.9 }]);
});

// The case that made the amendment: a first draft (no champion to inherit from) at the compiled defaults hands back every
// input, its replay rows all right. Not lowering it on clean rows would keep it held for good; switching its guards off
// (main) serves it with no guard left. Now it comes down to just under its right answers, serves, every guard on.
test("a first draft whose default guards hand back every input comes down on clean rows far enough to serve, every guard kept on", () => {
  const text = twoSteps(0.7, 0.7);
  const rows = Array.from({ length: 20 }, (_, i) => ({ of: `graded-${i}`, ...answered([g("facts", 0.4 + (i % 5) * 0.05), g("check", 0.5 + (i % 4) * 0.1)], true) }));
  assert.equal(clears(scoreRows(rows, new Map([["facts", 0.7], ["check", 0.7]]))), false, "at its defaults it hands back every input");
  const all = refitGuards(text, rows, NOW);
  assert.deepEqual(all.guards, [{ node: "facts", was: 0.7, threshold: 0.399999 }, { node: "check", was: 0.7, threshold: 0.499999 }], "down, never off");
  const refit = refitHeldOut(text, rows, NOW);
  assert.ok(refit.guards.length === 2 && refit.guards.every((one) => one.threshold !== null && one.threshold < 0.7), JSON.stringify(refit.guards));
  assert.deepEqual([clears(refit.fitted), clears(refit.held_out)], [true, true], `serves: ${JSON.stringify({ fitted: refit.fitted, held_out: refit.held_out })}`);
  const doc = JSON.parse(refit.text);
  assert.deepEqual(doc.root.steps.map((step) => typeof step.guard?.threshold), ["number", "number"], "every guard on");
});

test("halvesOf: the same rows split the same way whatever their order, half and half, never by position", () => {
  const rows = Array.from({ length: 21 }, (_, i) => ({ of: `graded-${i}` }));
  const { fit, held } = halvesOf(rows);
  assert.deepEqual([fit.length, held.length], [11, 10]);
  const again = halvesOf([...rows].reverse());
  assert.deepEqual(new Set(again.fit.map((row) => row.of)), new Set(fit.map((row) => row.of)), "the order of the rows never moves one");
  assert.notDeepEqual(fit.map((row) => row.of).sort(), rows.filter((_, i) => i % 2 === 0).map((row) => row.of).sort(), "not by parity of place");
  assert.equal(REFIT_MIN, 2 * REPLAY_MIN);
  // A served run's row is keyed by its run.
  const served = halvesOf(Array.from({ length: 10 }, (_, i) => ({ run: `served-${i}` })));
  assert.deepEqual([served.fit.length, served.held.length], [5, 5]);
});

// (c) Red on main: a revision compiled while a champion serves came out at the compiled defaults.
test("a revision compiled after a champion takes its fitted thresholds, fit and off switch; a new step keeps the default", async () => {
  const fit = { w: [1.5, 2.25], b: -1.75, n: 30, fitted_at: "2026-11-15T00:00:00.000Z" };
  const champion = { v: 2, name: "refund", schemas: {}, root: { node: "chain", steps: [
    { node: "extract", label: "read", instructions: "Read.", out: "Facts", as: "facts", guard: { signal: "jev", threshold: 0.55 } },
    { node: "agent", label: "pick", instructions: "Pick.", out: "Pick", as: "pick", guard: { signal: "both", threshold: 0.35, fit } },
    { node: "decide", label: "answer", instructions: "Answer.", out: "Answer", as: "answer" },
  ] } };
  const championText = JSON.stringify(champion);
  const D = compile.GUARD_THRESHOLD;
  const draft = { v: 2, name: "refund", schemas: {}, root: { node: "chain", steps: [
    { node: "extract", label: "read", instructions: "Read, again.", out: "Facts", as: "facts", guard: { signal: "jev", threshold: D } },
    { node: "agent", label: "pick", instructions: "Pick, again.", out: "Pick", as: "pick", guard: { signal: "both", threshold: D } },
    { node: "decide", label: "answer", instructions: "Answer, again.", out: "Answer", as: "answer", guard: { signal: "both", threshold: D } },
    { node: "agent", label: "extra", instructions: "A new step.", out: "Pick", as: "extra", guard: { signal: "both", threshold: D } },
  ] } };
  const digest = workflowDigest({ workflow: championText });
  const ask = { mode: "revise", workflow: "refund", current: championText, champion: { digest, text: championText, off: ["answer"] }, reference: "", notes: [], traces: [], tools: [], judges: false, jev: true };
  // The checks keep the draft's workflow.json as the answer gives it.
  const check = async (answer) => {
    const [one] = parseReflection(answer).workflows;
    return { state: "proposed", workflows: 1, proposal: { files: [{ file: "workflows/refund/workflow.json", text: draftFiles("refund", one.text).json }] } };
  };
  const result = await compile.compileTurn({ ask: async () => ({ answer: `\`\`\`\`workflow refund\n---\ndescription: d\n---\n${JSON.stringify(draft)}\n\`\`\`\`` }), compile: ask, answer: "", check });
  assert.ok(result.kept, JSON.stringify(result.record));
  const kept = JSON.parse(result.kept.checked.proposal.files[0].text);
  const by = Object.fromEntries(kept.root.steps.map((step) => [step.label, step.guard]));
  assert.deepEqual(by.read, { signal: "jev", threshold: 0.55 }, "read takes the champion's threshold");
  assert.deepEqual(by.pick, { signal: "both", threshold: 0.35, fit }, "pick takes its threshold and fit");
  assert.equal(by.answer, undefined, "answer's guard a refit switched off stays off, and the guard check takes that");
  assert.deepEqual(by.extra, { signal: "both", threshold: D }, "a new step keeps the compiled default");
  assert.equal(kept.root.steps[0].instructions, "Read, again.", "the rest is the draft's");
  assert.deepEqual(result.record.inherited, { from: digest, guards: [{ node: "read", threshold: 0.55 }, { node: "pick", threshold: 0.35 }, { node: "answer", threshold: null }] });
  assert.equal(result.record.digest, workflowDigest({ workflow: result.kept.checked.proposal.files[0].text }), "its digest is the text that serves");
  // A compile with no champion keeps the defaults, and records nothing inherited.
  const fresh = await compile.compileTurn({ ask: async () => ({ answer: `\`\`\`\`workflow refund\n---\ndescription: d\n---\n${JSON.stringify(draft)}\n\`\`\`\`` }), compile: { ...ask, champion: undefined }, answer: "", check });
  assert.equal(JSON.parse(fresh.kept.checked.proposal.files[0].text).root.steps[1].guard.threshold, D);
  assert.equal(fresh.record.inherited, undefined);
});

test("inheritGuards: a guard reading another signal keeps its default; an off step of another kind keeps its guard; unchanged text stays byte-identical", () => {
  const champion = JSON.stringify({ v: 2, name: "w", schemas: {}, root: { node: "chain", steps: [
    { node: "agent", label: "a", guard: { signal: "self", threshold: 0.4 } },
    { node: "extract", label: "b" },
  ] } });
  const draft = JSON.stringify({ v: 2, name: "w", schemas: {}, root: { node: "chain", steps: [
    { node: "agent", label: "a", guard: { signal: "both", threshold: 0.7 } },
    { node: "agent", label: "b", guard: { signal: "both", threshold: 0.7 } },
  ] } });
  assert.deepEqual(inheritGuards(draft, champion, new Set(["b"])), { text: draft, inherited: [] });
  const same = '{ "v": 2, "root": { "node": "agent", "label": "a", "guard": { "signal": "self", "threshold": 0.4 } } }';
  assert.deepEqual(inheritGuards(same, champion, new Set()), { text: same, inherited: [{ node: "a", threshold: 0.4 }] }, "the champion's own setting: the text as given");
});

test("championFor: the champion's text at its record's commit, its digest checked, and the steps refits switched off on its way", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "guard-keep-value-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const flow = (threshold, extra = {}) => ({ v: 2, name: "answer", schemas: { In: { type: "object", required: ["question"], properties: { question: { type: "string" } } } }, input: { schemaId: "In" }, output: { schemaId: "In", path: "question" },
    root: { node: "chain", steps: [{ node: "agent", label: "pick", instructions: "Pick.", out: "In", as: "pick", tools: [], guard: { signal: "self", threshold } }, { node: "agent", label: "answer", instructions: "Answer.", out: "In", as: "answer", tools: [], ...extra }] } });
  const compiled = JSON.stringify(flow(0.7, { guard: { signal: "self", threshold: 0.7 } }));
  const refit = flow(0.35);
  const championCommit = await landWorkflows(data, "agent-1", [{ name: "answer", description: "Answers", workflow: refit }]);
  const held = flow(0.7, { guard: { signal: "self", threshold: 0.7 }, instructions: "Answer, revised." });
  await landWorkflows(data, "agent-1", [{ name: "answer", description: "Answers", workflow: held }]);
  const at = new Date(0).toISOString();
  const [d0, d1, d2] = [compiled, JSON.stringify(refit), JSON.stringify(held)].map((workflow) => workflowDigest({ workflow }));
  const records = [
    { workflow: "answer", digest: d0, at, decided: "promote", source: "dry_run", reason: "r" },
    { workflow: "answer", digest: d0, at, decided: "hold", source: "graded", reason: "r" },
    { workflow: "answer", digest: d1, at, decided: "promote", source: "refit", reason: "r", refit: { from: d0, guards: [{ node: "pick", was: 0.7, threshold: 0.35 }, { node: "answer", was: 0.7, threshold: null }] }, commit: championCommit },
    { workflow: "answer", digest: d2, at, decided: "hold", source: "replay", reason: "r" },
  ];
  assert.deepEqual([...switchedOffOf(records, "answer", d1)], ["answer"]);
  const deps = { learningFolder: (agentId) => learningWorkspace({ mode: "local", data, agentId }) };
  const got = await championFor(deps, "agent-1", records, "answer", JSON.stringify(held), secretsShown([]));
  assert.deepEqual(got, { digest: d1, text: JSON.stringify(refit), off: ["answer"] }, "read at the champion's commit, never main's held revision");
  assert.equal(await championFor(deps, "agent-1", records.slice(0, 1).map((one) => ({ ...one, decided: "hold" })), "answer", JSON.stringify(held), secretsShown([])), undefined, "no champion: nothing to take");
});

/** A two-step `answer` workflow of agent steps, `facts` and `check`, each guard on its own confidence (`undefined`: none). */
const answerFlow = (facts, check, words = "") => ({ v: 2, name: "answer", schemas: {}, root: { node: "chain", steps: [
  { node: "agent", label: "facts", instructions: `Read the facts.${words}`, ...(facts === undefined ? {} : { guard: { signal: "self", threshold: facts } }) },
  { node: "agent", label: "check", instructions: `Check them.${words}`, ...(check === undefined ? {} : { guard: { signal: "self", threshold: check } }) },
] } });
const blockOf = (flow) => `\`\`\`\`workflow answer\n---\ndescription: d\n---\n${JSON.stringify(flow)}\n\`\`\`\``;
/** The checks keep the draft's workflow.json as the answer gives it. */
const keepDraft = (answer) => ({ state: "proposed", notes: 0, skills: 0, workflows: 1, proposal: { seed: "abc", files: [{ file: "workflows/answer/workflow.json", text: draftFiles("answer", parseReflection(answer).workflows[0].text).json }] } });
const reviseAsk = (champion) => ({ mode: "revise", workflow: "answer", current: champion.text, champion, held: { workflow: "answer", digest: champion.digest, source: "replay", reason: "r" }, reference: "", notes: [], traces: [], tools: [], judges: false, jev: false });

// r3 (review on #3017, P2): a draft that keeps its champion's off step as it is (unguarded) was never visited by
// inheritGuards (it walked guarded steps only), so the guard check refused a correct draft.
test("a draft that keeps a champion's off step unguarded, as the champion has it, compiles cleanly and says the step is off", async () => {
  const championText = JSON.stringify(answerFlow(undefined, 0.4));
  const champion = { digest: workflowDigest({ workflow: championText }), text: championText, off: ["facts"] };
  const result = await compile.compileTurn({ ask: async () => ({ answer: blockOf(answerFlow(undefined, 0.7, " Again.")) }), compile: reviseAsk(champion), answer: "", check: async (answer) => keepDraft(answer) });
  assert.ok(result.kept, `kept, no guard error: ${JSON.stringify(result.record?.attempts)}`);
  assert.deepEqual(result.record.inherited, { from: champion.digest, guards: [{ node: "facts", threshold: null }, { node: "check", threshold: 0.4 }] });
  const kept = JSON.parse(result.kept.checked.proposal.files[0].text);
  assert.deepEqual(kept.root.steps.map((step) => step.guard), [undefined, { signal: "self", threshold: 0.4 }]);
  // inheritGuards alone: the unguarded off step is named, and nothing of the text moves for it.
  const draft = JSON.stringify(answerFlow(undefined, 0.4));
  assert.deepEqual(inheritGuards(draft, championText, new Set(["facts"])), { text: draft, inherited: [{ node: "facts", threshold: null }, { node: "check", threshold: 0.4 }] });
  assert.deepEqual(inheritGuards(draft, championText, new Set()).inherited, [{ node: "check", threshold: 0.4 }], "a step not off on the champion's way is not named");
});

// r3 (review on #3017, P1): the off set came from refit records alone, so a revision that inherited an off and was
// promoted by its replay had no refit record: the next revision of it took that step's guard back at its default.
test("refit, then a revision that keeps the off and promotes by replay, then a revision of that: the guard stays off", async () => {
  const at = new Date(0).toISOString();
  const c0 = JSON.stringify(answerFlow(0.7, 0.7));
  const r = JSON.stringify(answerFlow(undefined, 0.4));
  const [d0, dr] = [c0, r].map((workflow) => workflowDigest({ workflow }));
  const records = [
    { workflow: "answer", digest: d0, at, decided: "promote", source: "dry_run", reason: "r" },
    { workflow: "answer", digest: dr, at, decided: "promote", source: "refit", reason: "r", refit: { from: d0, guards: [{ node: "facts", was: 0.7, threshold: null }, { node: "check", was: 0.7, threshold: 0.4 }] } },
  ];
  // Compile A, through the end-of-run hook, revises the refit champion: the model gives facts a guard again; it goes off.
  const written = [];
  const hookOf = (champion, draft) => createReflectHook({
    facts: async () => ({ learns: true, costUsd: 0.01 }), promptFacts: async () => ({ active: 0 }), asked: async () => ({ asked: [] }), nothingNew: async () => true,
    check: async ({ turn }) => keepDraft(turn.answer), newRunId: () => "learn-1", now: () => 0,
    compileFacts: async () => reviseAsk(champion),
    compiledOff: async (agentId, entry) => void written.push({ agentId, entry }),
  })({ runId: "run-a", agentId: "agent-1", claim: { runId: "run-a", runner: "r", epoch: 1, until: 0, from: "running" }, outcome: "completed", signal: new AbortController().signal, ask: async () => ({ ended: true, answer: blockOf(draft) }) });
  const keptA = (await hookOf({ digest: dr, text: r, off: [...switchedOffOf(records, "answer", dr)] }, answerFlow(0.7, 0.7, " A."))).also.find((row) => row.table === "learning_proposals").row.proposal;
  assert.equal(keptA.state, "proposed");
  const textA = keptA.proposal.files[0].text;
  const da = keptA.compiled.digest;
  assert.equal(JSON.parse(textA).root.steps[0].guard, undefined, "A keeps facts off");
  assert.deepEqual(written.map(({ agentId, entry }) => [agentId, entry]), [["agent-1", { workflow: "answer", digest: da, off: ["facts"] }]], "A's steps kept off are kept by its digest");
  // A promotes by its replay: no refit record names it. Its off set is still read, from what its compile kept.
  records.push({ workflow: "answer", digest: da, at, decided: "promote", source: "replay", reason: "r" });
  const offA = [...switchedOffOf(records, "answer", da, written.map(({ entry }) => entry))];
  assert.deepEqual(offA, ["facts"]);
  // Compile B revises A: the model gives facts a guard again; it stays off.
  const keptB = (await hookOf({ digest: da, text: textA, off: offA }, answerFlow(0.7, 0.7, " B."))).also.find((row) => row.table === "learning_proposals").row.proposal;
  assert.equal(keptB.state, "proposed");
  const textB = keptB.proposal.files[0].text;
  assert.equal(JSON.parse(textB).root.steps[0].guard, undefined, "B keeps facts off");
  // Kept by the store across a restart: putGuardsOff and guardsOffOf, newest per digest, none when it names none.
  const kv = new Map();
  const settings = {
    get: async (key) => (kv.has(key) ? structuredClone(kv.get(key)) : undefined),
    putIfAbsent: async (key, value) => (kv.has(key) ? kv.get(key) : (kv.set(key, structuredClone(value)), value)),
    replaceIf: async (key, was, value) => (JSON.stringify(kv.get(key)) === JSON.stringify(was) ? (kv.set(key, structuredClone(value)), true) : false),
  };
  await putGuardsOff(settings, "agent-1", { workflow: "answer", digest: da, off: ["facts"] });
  await putGuardsOff(settings, "agent-1", { workflow: "answer", digest: da, off: ["facts"] });
  await putGuardsOff(settings, "agent-1", { workflow: "answer", digest: "other", off: [] });
  assert.deepEqual(await guardsOffOf(settings, "agent-1"), [{ workflow: "answer", digest: da, off: ["facts"] }]);
});

// (d) Red on main: the in-sample refit wrote a revision (check raised) that the half held out of the fit never saw clear.
test("a refit that clears the half it was fit on but not the half held out writes nothing", async () => {
  const text = twoSteps(0.5, 0.5);
  const digest = workflowDigest({ workflow: text });
  const ids = Array.from({ length: REFIT_EVERY }, (_, i) => `served-${i}`);
  const { fit } = halvesOf(ids.map((run) => ({ run })));
  const fitIds = new Set(fit.map((one) => one.run));
  // Fit half: three wrong answers facts let through (and check's 0.6 too), so on it facts goes off and check goes up.
  // Held-out half: facts handed back two runs (the agent's answers, graded right). With facts off, nobody read what the
  // workflow would have said on them: the held-out half falls under the bar.
  let wrong = 0;
  let handed = 0;
  const served = ids.map((run) => {
    if (fitIds.has(run)) return wrong++ < 3 ? { run, correct: false, guards: [g("facts", 0.9, 0.5), g("check", 0.6, 0.5)] } : { run, correct: true, guards: [g("facts", 0.9, 0.5), g("check", 0.95, 0.5)] };
    return handed++ < 2 ? { run, correct: true, guards: [{ ...g("facts", 0.3, 0.5), escalated: true }] } : { run, correct: true, guards: [g("facts", 0.9, 0.5), g("check", 0.95, 0.5)] };
  });
  const kv = new Map();
  const settings = {
    get: async (key) => (kv.has(key) ? structuredClone(kv.get(key)) : undefined),
    putIfAbsent: async (key, value) => (kv.has(key) ? kv.get(key) : (kv.set(key, structuredClone(value)), value)),
    replaceIf: async (key, was, value) => (JSON.stringify(kv.get(key)) === JSON.stringify(was) ? (kv.set(key, structuredClone(value)), true) : false),
  };
  let seq = 0;
  for (let i = 0; i < 10; i++) await putGrade(settings, "a", { run: `hand-${i}`, correct: true, source: "eval", at: `t${seq++}`, path: "agent" });
  const runs = new Map();
  for (const { run, correct, guards } of served) {
    const path = guards.some((one) => one.escalated) ? "handed_back" : "workflow";
    runs.set(run, { id: run, state: "ended", metrics: { path, workflow: "answer", workflow_digest: digest, guards } });
    await putGrade(settings, "a", { run, correct, source: "eval", at: `t${seq++}`, path, workflow: "answer", digest });
  }
  await recordPromotion(settings, "a", { workflow: "answer", digest, at: new Date(0).toISOString(), decided: "promote", source: "dry_run", reason: "r" }, (was) => was === undefined);
  const commits = [];
  const logs = [];
  const gate = promotionGate({ store: { settings, runs: { get: async (id) => runs.get(id) } }, agentId: "a", runId: "now", revisionId: "rev", launch: { input: {}, title: "", place: { mode: "runner" } }, context: ctx, log: (line) => logs.push(line), commit: async (files, reason, id) => (commits.push({ files, reason, id }), `commit-${commits.length}`) });
  await gate({ name: "answer", workflow: text }, digest);
  assert.deepEqual(commits.map(({ reason }) => reason), [], logs.join("\n"));
  assert.ok(logs.some((line) => /answer's refit over 20 graded runs it served cleared the 10 rows it was fit on, but not the rest: on the 10 rows held out of the fit the workflow 80\.0%, the agent 100\.0%; it keeps its thresholds/.test(line)), logs.join("\n"));
  assert.equal((await promotionsOf(settings, "a")).some((one) => one.source === "refit"), false, "no refit revision");
});
