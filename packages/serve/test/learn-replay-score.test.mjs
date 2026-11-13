// Promotion by replay and threshold refit, the arithmetic (learn/promote.ts, learn/refit.ts): a replayed input the
// workflow hands back counts as the agent's recorded answer, never as a failure; a revision clears the bar within 2 points
// of the agent path on the same inputs; a refit picks each guard's cheapest threshold that keeps the bar, and fits a
// `both` guard only on 30 rows with 5 wrong.
import assert from "node:assert/strict";
import { test } from "node:test";
import { answerCorrect, clears, escalates, putGrade, gradesOf, promotionOf, recordOnly, recordPromotion, promotionsOf, replayScore, sameAnswer, thresholdsOf } from "../dist/learn/promote.js";
import { FIT_MIN_ROWS, fitLogistic, refitGuards } from "../dist/learn/refit.js";

const guard = (node, p, threshold = 0) => ({ node, signal: "self", self: p ?? undefined, p, threshold, escalated: false });
const row = (of, { answer, recorded = answer, correct = true, outcome = "answered", guards = [], expected } = {}) => ({ of, recorded: { answer: recorded, correct, ...(expected ? { expected } : {}) }, outcome, answer: outcome === "answered" ? answer : null, guards });

test("answers are the same as JSON values; a replay's answer takes the agent's grade when it says the same, its expected fields when given", () => {
  assert.equal(sameAnswer('{"a":1,"b":2}', ' {"b":2,"a":1} '), true);
  assert.equal(sameAnswer("5", "5\n"), true);
  assert.equal(sameAnswer("Paris", "paris"), false);
  assert.equal(answerCorrect("5", { answer: "5", correct: true }), true);
  assert.equal(answerCorrect("5", { answer: "5", correct: false }), false);
  assert.equal(answerCorrect("6", { answer: "5", correct: false }), false, "differs from a wrong answer: unknown, counted wrong");
  assert.equal(answerCorrect('{"mcc":"5812","why":"x"}', { answer: "zzz", correct: false, expected: { mcc: "5812" } }), true, "expected fields decide");
  assert.equal(answerCorrect('{"mcc":"5813"}', { answer: '{"mcc":"5812"}', correct: true, expected: { mcc: "5812" } }), false);
  assert.equal(answerCorrect(null, { answer: "5", correct: true }), false);
});

test("a hand-back in replay is the agent's recorded answer, never a failure: escalations do not lower the workflow's accuracy", () => {
  const rows = [
    row("r1", { answer: "a", guards: [guard("pick", 0.9)] }),
    row("r2", { answer: "b", guards: [guard("pick", 0.2)] }),
    row("r3", { answer: "c", outcome: "handed_back" }),
    row("r4", { answer: "d", recorded: "d", correct: false, guards: [guard("pick", 0.95)] }),
    row("r5", { answer: "x", recorded: "e", correct: true, guards: [guard("pick", 0.1)] }),
  ];
  const at = new Map([["pick", 0.5]]);
  assert.equal(escalates(rows[1], at), true);
  assert.equal(escalates(rows[0], at), false);
  const score = replayScore(rows, at);
  assert.deepEqual(score, { n: 5, agree: 2, agent_acc: 0.8, wf_acc: 0.8, delta: 0, handed_back: 3 });
  assert.equal(clears(score), true);
  // At threshold 0 the low-confidence wrong answer (r5) serves: 2 points under is the bar, 20 is not.
  const loose = replayScore(rows, new Map([["pick", 0]]));
  assert.equal(loose.wf_acc, 0.6);
  assert.equal(clears(loose), false);
  assert.equal(clears({ delta: -0.02 }), true, "exactly 2 points under clears");
  assert.equal(clears({ delta: -0.0201 }), false);
  // A guard that read no p hands back whatever its threshold.
  assert.equal(escalates(row("r6", { answer: "a", guards: [guard("pick", null)] }), new Map([["pick", 0]])), true);
});

const FLOW = { v: 2, name: "pick", schemas: {}, input: { schemaId: "In" }, output: { schemaId: "Out", path: "r" }, root: { node: "seq", label: "all", steps: [
  { node: "extract", label: "read", guard: { signal: "self", threshold: 0.7 } },
  { node: "agent", label: "pick", guard: { signal: "both", threshold: 0.6 } },
] } };

test("record-only text puts every guard's threshold at the least the DSL takes; thresholdsOf reads them by step label", () => {
  const text = JSON.stringify(FLOW);
  assert.deepEqual([...thresholdsOf(text)], [["read", 0.7], ["pick", 0.6]]);
  assert.deepEqual([...thresholdsOf(recordOnly(text))], [["read", 1e-9], ["pick", 1e-9]], "the least threshold the DSL takes");
  assert.equal(recordOnly('{"v":2,"root":{"node":"code","label":"x"}}'), '{"v":2,"root":{"node":"code","label":"x"}}', "no guard: unchanged");
});

test("refit: each guard's cheapest threshold that keeps the bar; a too-high guard comes down, a too-low one goes up", () => {
  const text = JSON.stringify(FLOW);
  // read: every row right whatever its p, so its guard can go to the bottom. pick: wrong exactly when its p is under 0.4.
  const rows = [];
  for (let i = 0; i < 20; i++) {
    const pick = i / 20;
    rows.push({ guards: [{ node: "read", signal: "self", self: 0.5, p: 0.5, threshold: 0, escalated: false }, { node: "pick", signal: "both", self: pick, jev: pick, p: pick, threshold: 0, escalated: false }], answered: true, wfCorrect: pick >= 0.4, agentCorrect: 1 });
  }
  const refit = refitGuards(text, rows, "2026-11-13T00:00:00.000Z");
  const by = Object.fromEntries(refit.guards.map((one) => [one.node, one]));
  assert.equal(by.read.threshold, 0.001, "read never hurt: its guard goes to the least threshold the DSL takes");
  assert.equal(by.read.was, 0.7);
  assert.equal(by.pick.threshold, 0.4, "pick's wrong answers fall under 0.4: the lowest threshold that hands them all back");
  assert.equal(by.pick.fit, undefined, "20 rows: no fit");
  assert.equal(refit.delta, 0);
  const doc = JSON.parse(refit.text);
  assert.equal(doc.root.steps[1].guard.threshold, 0.4);
  // Rows that keep the thresholds as they are change nothing.
  const same = refitGuards(refit.text, rows, "2026-11-13T00:00:00.000Z");
  assert.equal(same.text, undefined);
  assert.deepEqual(same.guards, []);
});

test("refit fits a `both` guard's logistic only on 30 rows with 5 wrong, else keeps it", () => {
  const text = JSON.stringify(FLOW);
  const rowsOf = (n, wrongEvery) => Array.from({ length: n }, (_, i) => {
    const wrong = i % wrongEvery === 0;
    const [self, jev] = wrong ? [0.3 + (i % 3) * 0.05, 0.2] : [0.8, 0.7 + (i % 4) * 0.05];
    return { guards: [{ node: "pick", signal: "both", self, jev, p: Math.min(self, jev), threshold: 0, escalated: false }], answered: true, wfCorrect: !wrong, agentCorrect: 1 };
  });
  assert.equal(refitGuards(text, rowsOf(FIT_MIN_ROWS - 1, 5), "t").guards.find((g) => g.node === "pick")?.fit, undefined, "29 rows: no fit");
  assert.equal(refitGuards(text, rowsOf(FIT_MIN_ROWS, 10), "t").guards.find((g) => g.node === "pick")?.fit, undefined, "3 wrong: no fit");
  const fitted = refitGuards(text, rowsOf(FIT_MIN_ROWS, 5), "2026-11-13T00:00:00.000Z").guards.find((g) => g.node === "pick");
  assert.equal(fitted.fit.n, FIT_MIN_ROWS);
  assert.equal(fitted.fit.w.length, 2);
  assert.equal(fitted.fit.fitted_at, "2026-11-13T00:00:00.000Z");
  assert.ok(fitted.fit.w[0] > 0 && fitted.fit.w[1] > 0, `higher signals, more often right: ${JSON.stringify(fitted.fit)}`);
  const { w, b } = fitLogistic([[0], [0.2], [0.8], [1]], [false, false, true, true]);
  assert.ok(w[0] > 0 && b < 0);
});

test("grades and promotion records over the settings table: a run's newer grade replaces its older; a decided digest is not decided twice", async () => {
  const kv = new Map();
  const settings = {
    get: async (key) => (kv.has(key) ? structuredClone(kv.get(key)) : undefined),
    putIfAbsent: async (key, value) => (kv.has(key) ? kv.get(key) : (kv.set(key, structuredClone(value)), value)),
    replaceIf: async (key, was, value) => (JSON.stringify(kv.get(key)) === JSON.stringify(was) ? (kv.set(key, structuredClone(value)), true) : false),
  };
  await putGrade(settings, "a", { run: "r1", correct: true, source: "feedback", at: "t1", path: "agent" });
  await putGrade(settings, "a", { run: "r2", correct: false, source: "eval", at: "t2", path: "agent" });
  await putGrade(settings, "a", { run: "r1", correct: false, source: "feedback", at: "t3", path: "agent" });
  assert.deepEqual((await gradesOf(settings, "a")).map(({ run, correct }) => [run, correct]), [["r2", false], ["r1", false]]);
  const replaying = { workflow: "w", digest: "d1", at: "t", decided: "replaying", source: "replay", reason: "r", runs: ["x"] };
  assert.equal((await recordPromotion(settings, "a", replaying, (now) => now === undefined)).decided, "replaying");
  const second = await recordPromotion(settings, "a", { ...replaying, runs: ["y"] }, (now) => now === undefined);
  assert.deepEqual(second.runs, ["x"], "the first claim's replay stands");
  await recordPromotion(settings, "a", { ...replaying, decided: "promote" }, (now) => now?.decided === "replaying");
  assert.equal(promotionOf(await promotionsOf(settings, "a"), "w", "d1").decided, "promote");
});
