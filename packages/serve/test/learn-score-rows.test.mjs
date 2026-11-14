// One scorer (learn/refit.ts scoreRows): a replay's score, a refit's and a serving check's read the same rows the same way.
// The numbers below are what the replay scorer this one replaced (learn/promote.ts replayScore, and #2815's filtered agree
// after a refit) gave on the same fixtures: at the serving thresholds, with a switched-off guard, and with a soft escalate
// that fired. A change here is a change in what promotes or holds.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SOFT_ESCALATE_THRESHOLD, thresholdsOf } from "../dist/learn/promote.js";
import { OFF, refitGuards, refitRowsOf, scoreRows } from "../dist/learn/refit.js";

const NOW = "2026-11-14T00:00:00.000Z";
const RECORD_ONLY = 1e-9;
const guard = (node, p, threshold = RECORD_ONLY, extra = {}) => ({ node, signal: "self", self: p ?? undefined, p, threshold, escalated: false, ...extra });
const row = (of, { answer, recorded = answer, correct = true, outcome = "answered", guards = [], expected } = {}) => ({ of, recorded: { answer: recorded, correct, ...(expected ? { expected } : {}) }, outcome, answer: outcome === "answered" ? answer : null, guards });
const esc = (fired) => ({ node: "unsupported", signal: "escalate", p: fired ? 0 : 1, threshold: SOFT_ESCALATE_THRESHOLD, escalated: false });
const score = (rows, thresholds) => scoreRows(refitRowsOf(rows), thresholds);

test("at the serving thresholds: a hand-back is the agent's answer, a low p under its guard hands back, a failed or skipped row is left out", () => {
  const rows = [
    row("r1", { answer: "a", guards: [guard("pick", 0.9)] }),
    row("r2", { answer: "b", guards: [guard("pick", 0.2)] }),
    row("r3", { answer: "c", outcome: "handed_back", guards: [guard("pick", null, RECORD_ONLY, { escalated: true })] }),
    row("r4", { answer: "d", recorded: "d", correct: false, guards: [guard("pick", 0.95)] }),
    row("r5", { answer: "x", recorded: "e", correct: true, guards: [guard("pick", 0.1)] }),
    row("r6", { answer: "y", outcome: "handed_back" }),
    row("r7", { answer: '{"mcc":"5812"}', recorded: "zzz", correct: false, expected: { mcc: "5812" }, guards: [guard("pick", 0.7)] }),
    ...Array.from({ length: 4 }, (_, i) => row(`f${i}`, { answer: "z", outcome: "failed" })),
    row("s1", { answer: "z", outcome: "skipped_write" }),
  ];
  assert.deepEqual(refitRowsOf(rows).map((one) => one.of), ["r1", "r2", "r3", "r4", "r5", "r6", "r7"]);
  assert.deepEqual(score(rows, new Map([["pick", 0.5]])), { n: 7, agree: 2, agent_acc: 0.7143, wf_acc: 0.8571, delta: 0.1428, handed_back: 4 });
  assert.deepEqual(score(rows, new Map([["pick", 0.15]])), { n: 7, agree: 3, agent_acc: 0.7143, wf_acc: 0.8571, delta: 0.1428, handed_back: 3 });
  assert.deepEqual(score(rows, new Map([["pick", 0.99]])), { n: 7, agree: 0, agent_acc: 0.7143, wf_acc: 0.7143, delta: 0, handed_back: 7 });
  // No rows: nothing scored.
  assert.deepEqual(scoreRows([], new Map()), { n: 0, agree: 0, agent_acc: 0, wf_acc: 0, delta: 0, handed_back: 0 });
});

test("a nested guard is read by its prefixed name at the workflow's serving thresholds", () => {
  const text = JSON.stringify({ v: 2, name: "outer", schemas: {}, root: { node: "chain", steps: [
    { node: "workflow", label: "sub", input: {}, out: "In", as: "sub", workflow: { v: 2, name: "inner", schemas: {}, root: { node: "agent", label: "pick", guard: { signal: "self", threshold: 0.8 } } } },
  ] } });
  const rows = [0.6, 0.85, 0.9].map((p, i) => row(`g${i}`, { answer: "a", recorded: i ? "a" : "b", correct: i !== 2, guards: [guard("sub/pick", p)] }));
  assert.deepEqual(score(rows, thresholdsOf(text)), { n: 3, agree: 2, agent_acc: 0.6667, wf_acc: 0.6667, delta: 0, handed_back: 1 });
});

test("a soft escalate that fired scores as a hand-back at its serving setting; one that never fired lets the draft answer", () => {
  const rows = [
    ...Array.from({ length: 3 }, (_, i) => row(`f${i}`, { answer: "42", guards: [esc(true)] })),
    row("n1", { answer: "42", guards: [esc(false)] }),
    row("n2", { answer: "41", recorded: "42", guards: [esc(false)] }),
    row("n3", { answer: "40", recorded: "40", correct: false, guards: [esc(false)] }),
  ];
  assert.deepEqual(score(rows, new Map()), { n: 6, agree: 2, agent_acc: 0.8333, wf_acc: 0.6667, delta: -0.1666, handed_back: 3 });
  assert.deepEqual(score(rows.slice(0, 3), new Map()), { n: 3, agree: 0, agent_acc: 1, wf_acc: 1, delta: 0, handed_back: 3 }, "every input handed back");
});

/** The thresholds a refit chose, as scoreRows reads them: a switched-off guard or escalate OFF, a moved one its new threshold. */
const chosen = (text, refit) => new Map([...thresholdsOf(text), ...refit.guards.map((one) => [one.node, one.threshold ?? OFF])]);
const scoreOf = ({ n, agree, agent_acc, wf_acc, delta, handed_back }) => ({ n, agree, agent_acc, wf_acc, delta, handed_back });

test("a switched-off guard: the refit's score is the one scorer's at its chosen thresholds, the off guard's rows read as never handing back", () => {
  const text = JSON.stringify({ v: 2, name: "pick", schemas: {}, root: { node: "chain", steps: [
    { node: "extract", label: "facts", guard: { signal: "jev", threshold: 0.7 } },
    { node: "agent", label: "answer", guard: { signal: "jev", threshold: 0.2 } },
  ] } });
  // facts says nothing of right and wrong (off); answer is 0.3 on the two wrong drafts (raised past them).
  const rows = Array.from({ length: 10 }, (_, i) => {
    const wrong = i < 2;
    const facts = i % 2 ? 0.9 : 0.06;
    return row(`g${i}`, { answer: wrong ? "no" : "yes", recorded: "yes", guards: [guard("facts", facts), guard("answer", wrong ? 0.3 : 0.9)] });
  });
  const refit = refitGuards(text, refitRowsOf(rows), NOW);
  assert.deepEqual(refit.guards.map(({ node, threshold }) => [node, threshold]), [["facts", null], ["answer", 0.9]]);
  assert.deepEqual(scoreOf(refit), score(rows, chosen(text, refit)));
  assert.deepEqual(scoreOf(refit), { n: 10, agree: 8, agent_acc: 1, wf_acc: 1, delta: 0, handed_back: 2 }, "the eight right drafts the off guard no longer hands back agree");
});

test("a soft escalate switched off: the refit's score is the one scorer's at its chosen thresholds", () => {
  const schemas = { In: { type: "object" }, Answer: { type: "object", properties: { answer: { type: "number" } } }, Check: { type: "object", properties: { unsupported: { type: "boolean" } } } };
  const text = JSON.stringify({ v: 2, name: "answer", schemas, input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" }, root: { node: "chain", steps: [
    { node: "extract", label: "draft", instructions: "Answer.", out: "Answer", as: "answer" },
    { node: "judge", label: "check", state: { answer: "{answer.answer}" }, out: "Check", as: "check" },
    { node: "escalate", label: "unsupported", when: { predicate: "field_equals", path: "check.unsupported", value: true }, kind: "unsupported", stage: "check", summary: "unsupported" },
  ] } });
  // The check fires on most inputs, and the drafts it stops are right as often as the agent is: switched off.
  const rows = [
    ...Array.from({ length: 8 }, (_, i) => row(`f${i}`, { answer: "42", guards: [esc(true)] })),
    row("n1", { answer: "42", guards: [esc(false)] }),
    row("n2", { answer: "41", recorded: "42", correct: false, guards: [esc(false)] }),
  ];
  assert.equal(score(rows, new Map()).handed_back, 8, "served as it is, the check hands back eight");
  const refit = refitGuards(text, refitRowsOf(rows), NOW);
  assert.deepEqual(refit.guards, [{ node: "unsupported", was: null, threshold: null, escalate: true }]);
  assert.deepEqual(scoreOf(refit), score(rows, chosen(text, refit)));
  assert.deepEqual(scoreOf(refit), { n: 10, agree: 9, agent_acc: 0.9, wf_acc: 0.9, delta: 0, handed_back: 0 });
});
