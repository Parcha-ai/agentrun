// One scorer (learn/refit.ts scoreRows): a replay's score, a refit's, and a serving check's read the same rows the same
// way. Red first: on the replay fixtures, scoreRows over the replay's refit rows (refitRowsOf) gives what replayScore gave,
// at the serving thresholds, with a switched-off guard, and with a soft escalate that fired.
import assert from "node:assert/strict";
import { test } from "node:test";
import { replayScore, SOFT_ESCALATE_THRESHOLD, thresholdsOf } from "../dist/learn/promote.js";
import { OFF, refitGuards, refitRowsOf, scoreRows } from "../dist/learn/refit.js";

const NOW = "2026-11-14T00:00:00.000Z";
const RECORD_ONLY = 1e-9;
const guard = (node, p, threshold = RECORD_ONLY, extra = {}) => ({ node, signal: "self", self: p ?? undefined, p, threshold, escalated: false, ...extra });
const row = (of, { answer, recorded = answer, correct = true, outcome = "answered", guards = [], expected } = {}) => ({ of, recorded: { answer: recorded, correct, ...(expected ? { expected } : {}) }, outcome, answer: outcome === "answered" ? answer : null, guards });
const esc = (fired) => ({ node: "unsupported", signal: "escalate", p: fired ? 0 : 1, threshold: SOFT_ESCALATE_THRESHOLD, escalated: false });
const both = (rows, thresholds) => [replayScore(rows, thresholds), scoreRows(refitRowsOf(rows), thresholds)];

test("at the serving thresholds: a hand-back is the agent's answer, a low p under its guard hands back, a failed row is left out", () => {
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
  for (const at of [new Map([["pick", 0.5]]), new Map([["pick", 0.15]]), new Map([["pick", 0.99]])]) {
    const [was, now] = both(rows, at);
    assert.deepEqual(now, was, `at ${JSON.stringify([...at])}`);
  }
  assert.deepEqual(scoreRows(refitRowsOf(rows), new Map([["pick", 0.5]])), { n: 7, agree: 2, agent_acc: 0.7143, wf_acc: 0.8571, delta: 0.1428, handed_back: 4 });
  // No rows: nothing scored.
  assert.deepEqual(scoreRows([], new Map()), { n: 0, agree: 0, agent_acc: 0, wf_acc: 0, delta: 0, handed_back: 0 });
});

test("a nested guard is read by its prefixed name at the workflow's serving thresholds", () => {
  const text = JSON.stringify({ v: 2, name: "outer", schemas: {}, root: { node: "chain", steps: [
    { node: "workflow", label: "sub", input: {}, out: "In", as: "sub", workflow: { v: 2, name: "inner", schemas: {}, root: { node: "agent", label: "pick", guard: { signal: "self", threshold: 0.8 } } } },
  ] } });
  const rows = [0.6, 0.85, 0.9].map((p, i) => row(`g${i}`, { answer: "a", recorded: i ? "a" : "b", correct: i !== 2, guards: [guard("sub/pick", p)] }));
  const [was, now] = both(rows, thresholdsOf(text));
  assert.deepEqual(now, was);
  assert.equal(now.handed_back, 1);
});

test("a soft escalate that fired scores as a hand-back at its serving setting; one that never fired lets the draft answer", () => {
  const rows = [
    ...Array.from({ length: 3 }, (_, i) => row(`f${i}`, { answer: "42", guards: [esc(true)] })),
    row("n1", { answer: "42", guards: [esc(false)] }),
    row("n2", { answer: "41", recorded: "42", guards: [esc(false)] }),
    row("n3", { answer: "40", recorded: "40", correct: false, guards: [esc(false)] }),
  ];
  const [was, now] = both(rows, new Map());
  assert.deepEqual(now, was);
  assert.deepEqual(now, { n: 6, agree: 2, agent_acc: 0.8333, wf_acc: 0.6667, delta: -0.1666, handed_back: 3 });
  // Every input handed back: none answered alone.
  const all = rows.slice(0, 3);
  assert.deepEqual(both(all, new Map())[1], both(all, new Map())[0]);
  assert.equal(scoreRows(refitRowsOf(all), new Map()).handed_back, 3);
});

/** The refit's score read the old way: its own numbers, and #2815's agree (replayScore over the rows with every switched-off
 *  guard's and escalate's row filtered out, at the refit's thresholds). */
const oldRefitScore = (rows, refit) => {
  const off = new Set(refit.guards.filter((one) => one.threshold === null).map((one) => one.node));
  const kept = rows.map((r) => ({ ...r, guards: r.guards.filter((g) => !off.has(g.node)) }));
  const agree = replayScore(kept, new Map(refit.guards.flatMap((one) => (one.threshold === null ? [] : [[one.node, one.threshold]])))).agree;
  return { n: refit.n, agree, agent_acc: refit.agent_acc, wf_acc: refit.wf_acc, handed_back: refit.handed_back };
};
/** The thresholds a refit chose, as scoreRows reads them: a switched-off guard or escalate OFF, a moved one its new threshold. */
const chosen = (text, refit) => new Map([...thresholdsOf(text), ...refit.guards.map((one) => [one.node, one.threshold ?? OFF])]);

test("a switched-off guard: the refit's chosen thresholds score the same as the refit and #2815's filtered agree", () => {
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
  const now = scoreRows(refitRowsOf(rows), chosen(text, refit));
  const was = oldRefitScore(rows, refit);
  assert.deepEqual({ n: now.n, agree: now.agree, agent_acc: now.agent_acc, wf_acc: now.wf_acc, handed_back: now.handed_back }, was);
  assert.equal(now.agree, 8, "the eight right drafts the off guard no longer hands back");
});

test("a soft escalate switched off: the refit's chosen thresholds score the same as the refit and #2815's filtered agree", () => {
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
  const [before] = both(rows, new Map());
  assert.equal(before.handed_back, 8);
  const refit = refitGuards(text, refitRowsOf(rows), NOW);
  assert.deepEqual(refit.guards, [{ node: "unsupported", was: null, threshold: null, escalate: true }]);
  const now = scoreRows(refitRowsOf(rows), chosen(text, refit));
  const was = oldRefitScore(rows, refit);
  assert.deepEqual({ n: now.n, agree: now.agree, agent_acc: now.agent_acc, wf_acc: now.wf_acc, handed_back: now.handed_back }, was);
  assert.deepEqual([now.agree, now.handed_back], [9, 0]);
});
