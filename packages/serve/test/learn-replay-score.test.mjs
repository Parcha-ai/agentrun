// Promotion by replay and threshold refit, the arithmetic (learn/promote.ts, learn/refit.ts): a replayed input the
// workflow hands back counts as the agent's recorded answer, never as a failure; a revision clears the bar within 2 points
// of the agent path on the same inputs; a refit picks each guard's cheapest threshold that keeps the bar, and fits a
// `both` guard only on 30 rows with 5 wrong.
import assert from "node:assert/strict";
import { test } from "node:test";
import { answerCorrect, championOf, clears, escalates, GRADES_KEPT, putGrade, PROMOTIONS_KEPT, servingOf, gradesOf, promotionOf, recordOnly, recordPromotion, promotionsOf, replayScore, sameAnswer, thresholdsOf, trimPromotions } from "../dist/learn/promote.js";
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

test("a workflow whose output is one text field answers that text (learnedOutput): its expected field reads the bare answer", () => {
  // A workflow with output {mcc} is served as "5999", not {"mcc":"5999"}: the one expected field is the answer itself.
  assert.equal(answerCorrect("5812", { answer: '{"mcc":"5812","why":"x"}', correct: true, expected: { mcc: "5812" } }), true);
  assert.equal(answerCorrect(" 5812\n", { answer: "x", correct: false, expected: { mcc: "5812" } }), true, "trimmed");
  assert.equal(answerCorrect("5999", { answer: "x", correct: true, expected: { mcc: "5812" } }), false);
  assert.equal(answerCorrect("5812", { answer: "x", correct: true, expected: { mcc: "5812", tier: "low" } }), false, "two fields: a bare text holds neither");
  assert.equal(answerCorrect("[\"5812\"]", { answer: "x", correct: true, expected: { mcc: "5812" } }), false);
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

test("refit raises the guard that catches the wrong answers, not the first one: never a hand-back of every input when one step's guard does it", () => {
  // The walk's case: read's p is 0.9 on every row (never wrong); pick's p is 0.3 on the two rows it gets wrong, else 0.9.
  // Taking the steps in order, read alone could only meet the bar at 0.999 (every row back to the agent), and pick then
  // fell to the bottom: the refit served a workflow that hands back everything. Both start under every p they see.
  const text = JSON.stringify({ ...FLOW, root: { ...FLOW.root, steps: [{ ...FLOW.root.steps[0], guard: { signal: "jev", threshold: 0.5 } }, { ...FLOW.root.steps[1], guard: { signal: "jev", threshold: 0.2 } }] } });
  const rows = [];
  for (let i = 0; i < 8; i++) {
    const wrong = i < 2;
    rows.push({ guards: [{ node: "read", signal: "jev", jev: 0.9, p: 0.9, threshold: 0.5, escalated: false }, { node: "pick", signal: "jev", jev: wrong ? 0.3 : 0.9, p: wrong ? 0.3 : 0.9, threshold: 0.2, escalated: false }], answered: true, wfCorrect: !wrong, agentCorrect: 1 });
  }
  const refit = refitGuards(text, rows, "2026-11-13T00:00:00.000Z");
  const by = Object.fromEntries(refit.guards.map((one) => [one.node, one]));
  assert.equal(by.pick.threshold, 0.9, "pick goes up past its wrong rows' 0.3");
  assert.equal(by.read.threshold, 0.001, "read never hurt: it comes down");
  assert.equal(refit.handed_back, 2, "only the two wrong rows go back");
  assert.equal(refit.delta, 0);
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
  const first = await recordPromotion(settings, "a", replaying, (now) => now === undefined);
  assert.deepEqual([first.won, first.record.decided], [true, "replaying"]);
  const second = await recordPromotion(settings, "a", { ...replaying, runs: ["y"] }, (now) => now === undefined);
  assert.deepEqual([second.won, second.record.runs], [false, ["x"]], "the first claim's replay stands; the second claim lost the write");
  await recordPromotion(settings, "a", { ...replaying, decided: "promote" }, (now) => now?.decided === "replaying");
  assert.equal(promotionOf(await promotionsOf(settings, "a"), "w", "d1").decided, "promote");
});

test("champion/challenger: the digest promoted last serves while a newer revision replays or is held; its own graded hold stops it; a promoted challenger takes over", () => {
  const rec = (digest, decided, source = "replay", extra = {}) => ({ workflow: "answer", digest, at: "t", decided, source, reason: "r", ...extra });
  const champion = rec("c1", "promote", "dry_run", { commit: "s1" });
  // A wrong served grade asked for a revision: c2 replays. The champion serves; c2 is replaying.
  let records = [champion, rec("c2", "replaying")];
  assert.equal(championOf(records, "answer"), champion);
  assert.deepEqual(servingOf(records), [{ workflow: "answer", digest: "c1", replaying: "c2" }]);
  // The champion's graded check marks it again (a newer record of the same digest): still the champion.
  const marked = { ...champion, checked: 20 };
  records = [champion, rec("c2", "replaying"), marked];
  assert.equal(championOf(records, "answer"), marked);
  assert.deepEqual(servingOf(records), [{ workflow: "answer", digest: "c1", replaying: "c2" }]);
  // c2's replay holds it: the champion keeps serving, nothing replays.
  records = [champion, rec("c2", "replaying"), rec("c2", "hold")];
  assert.equal(championOf(records, "answer")?.digest, "c1");
  assert.deepEqual(servingOf(records), [{ workflow: "answer", digest: "c1", replaying: null }]);
  // c2's replay promotes it: c2 is the champion from here on, even when c1 is marked checked after.
  records = [champion, rec("c2", "replaying"), rec("c2", "promote"), marked];
  assert.equal(championOf(records, "answer")?.digest, "c2");
  assert.deepEqual(servingOf(records), [{ workflow: "answer", digest: "c2", replaying: null }]);
  // The champion's own graded runs hold it (source graded): no champion; never the one before it.
  records = [champion, rec("c2", "replaying"), rec("c2", "promote"), rec("c2", "hold", "graded")];
  assert.equal(championOf(records, "answer"), undefined);
  assert.deepEqual(servingOf(records), [{ workflow: "answer", digest: null, replaying: null }]);
  // A refit's new revision is promoted on its rows: the champion. Another workflow's records are its own.
  records = [champion, rec("c3", "promote", "refit", { refit: { from: "c1", guards: [] } }), { ...rec("x1", "replaying"), workflow: "other" }];
  assert.equal(championOf(records, "answer")?.digest, "c3");
  assert.deepEqual(servingOf(records), [{ workflow: "answer", digest: "c3", replaying: null }, { workflow: "other", digest: null, replaying: "x1" }]);
});

test("a replay row its workflow failed on (a step failed: a credential or tool the replay lacked) is no evidence: never scored, never the agent's answer", () => {
  const rows = [
    row("r1", { answer: "a", guards: [guard("pick", 0.9)] }),
    row("r2", { answer: "b", outcome: "handed_back" }),
    ...Array.from({ length: 8 }, (_, i) => row(`f${i}`, { answer: "z", outcome: "failed" })),
  ];
  const score = replayScore(rows, new Map([["pick", 0.5]]));
  assert.deepEqual(score, { n: 2, agree: 1, agent_acc: 1, wf_acc: 1, delta: 0, handed_back: 1 }, "the eight failed rows are left out");
});

test("a refit never brings a guard down past hand-backs whose answer nobody read: 20 graded hand-backs at p 0.2 keep a 0.5 guard", () => {
  const text = JSON.stringify({ ...FLOW, root: { ...FLOW.root, steps: [FLOW.root.steps[0], { ...FLOW.root.steps[1], guard: { signal: "self", threshold: 0.5 } }] } });
  // Served runs its guard handed back (escalated at p 0.2), the agent's answer graded right: what the workflow would have
  // said past 0.2 is unknown, so a threshold under 0.2 serves answers nobody checked.
  const handed = Array.from({ length: 20 }, () => ({ guards: [{ node: "pick", signal: "self", self: 0.2, p: 0.2, threshold: 0.5, escalated: true }], answered: false, wfCorrect: null, agentCorrect: 1 }));
  const kept = refitGuards(text, handed, "2026-11-13T00:00:00.000Z");
  assert.equal(kept.text, undefined, `the guard stays at 0.5: ${JSON.stringify(kept.guards)}`);
  // A hand-back on a failed step (no guard escalated) says nothing of the thresholds: it never moves one either way.
  const failed = Array.from({ length: 20 }, () => ({ guards: [{ node: "pick", signal: "self", self: 0.9, p: 0.9, threshold: 0.5, escalated: false }], answered: false, wfCorrect: null, agentCorrect: 1 }));
  assert.equal(refitGuards(text, [...handed, ...failed], "t").text, undefined);
  // Rows that answered alone still bring it down where their answers say so.
  const right = Array.from({ length: 20 }, () => ({ guards: [{ node: "pick", signal: "self", self: 0.3, p: 0.3, threshold: 0.1, escalated: false }], answered: true, wfCorrect: true, agentCorrect: 1 }));
  const low = refitGuards(text, right, "t");
  assert.equal(low.guards.find((one) => one.node === "pick")?.threshold, 0.001);
});

test("each grade takes the next seq, a re-grade a new one, and the seq keeps climbing past the grades kept", async () => {
  const kv = new Map();
  const settings = {
    get: async (key) => (kv.has(key) ? structuredClone(kv.get(key)) : undefined),
    putIfAbsent: async (key, value) => (kv.has(key) ? kv.get(key) : (kv.set(key, structuredClone(value)), value)),
    replaceIf: async (key, was, value) => (JSON.stringify(kv.get(key)) === JSON.stringify(was) ? (kv.set(key, structuredClone(value)), true) : false),
  };
  for (let i = 0; i < GRADES_KEPT + 5; i++) await putGrade(settings, "a", { run: `r${i}`, correct: true, source: "eval", at: `t${i}`, path: "agent" });
  const again = await putGrade(settings, "a", { run: `r${GRADES_KEPT + 4}`, correct: false, source: "eval", at: "t", path: "agent" });
  const grades = await gradesOf(settings, "a");
  assert.equal(grades.length, GRADES_KEPT);
  assert.equal(again.seq, GRADES_KEPT + 6);
  assert.deepEqual(grades.slice(-2).map(({ run, seq }) => [run, seq]), [[`r${GRADES_KEPT + 3}`, GRADES_KEPT + 4], [`r${GRADES_KEPT + 4}`, GRADES_KEPT + 6]]);
});

test("the promotion history trim never drops a champion: newer revisions replaying and held past PROMOTIONS_KEPT leave it serving", async () => {
  const kv = new Map();
  const settings = {
    get: async (key) => (kv.has(key) ? structuredClone(kv.get(key)) : undefined),
    putIfAbsent: async (key, value) => (kv.has(key) ? kv.get(key) : (kv.set(key, structuredClone(value)), value)),
    replaceIf: async (key, was, value) => (JSON.stringify(kv.get(key)) === JSON.stringify(was) ? (kv.set(key, structuredClone(value)), true) : false),
  };
  const rec = (digest, decided, extra = {}) => ({ workflow: "answer", digest, at: "t", decided, source: "replay", reason: "r", ...extra });
  await recordPromotion(settings, "a", rec("champ", "promote", { commit: "s1" }), (was) => was === undefined);
  for (let i = 0; i < PROMOTIONS_KEPT; i++) {
    await recordPromotion(settings, "a", rec(`c${i}`, "replaying"), (was) => was === undefined);
    await recordPromotion(settings, "a", rec(`c${i}`, "hold"), (was) => was?.decided === "replaying");
  }
  const records = await promotionsOf(settings, "a");
  assert.equal(records.length, PROMOTIONS_KEPT);
  assert.equal(championOf(records, "answer")?.digest, "champ", "the champion still serves");
  assert.deepEqual(records.at(-1), rec(`c${PROMOTIONS_KEPT - 1}`, "hold"), "the newest kept");
});

// Review on #2644 (round 4): the champion never depends on which records the trim keeps. A late graded check of an
// older champion (A promoted, B promoted, A checked) must not make A the champion once A's first promote record is trimmed;
// nor may a held last revision's records trimmed away hand the champion back to the one before it.
test("the promotion history trim never changes the champion: an older revision's late check, or a held last revision, survive any trim", () => {
  const rec = (workflow, digest, decided, extra = {}) => ({ workflow, digest, at: "t", decided, source: "replay", reason: "r", ...extra });
  const filler = (n) => Array.from({ length: n }, (_, i) => rec("other", `o${i}`, "replaying"));
  // A promoted, B promoted, then A's graded check (still promote): B is the champion, before and after the trim.
  let items = [rec("answer", "A", "promote"), rec("answer", "B", "promote"), rec("answer", "A", "promote", { checked: 20 }), ...filler(PROMOTIONS_KEPT - 2)];
  assert.equal(championOf(items, "answer")?.digest, "B");
  assert.equal(championOf(trimPromotions(items), "answer")?.digest, "B", "the older revision's late check never makes it champion");
  // D promoted, L promoted then held by its graded runs, then D's late check: no champion, before and after the trim.
  items = [rec("answer", "D", "promote"), rec("answer", "L", "promote"), rec("answer", "L", "hold", { source: "graded" }), rec("answer", "D", "promote", { checked: 20 }), ...filler(PROMOTIONS_KEPT - 1)];
  assert.equal(championOf(items, "answer"), undefined);
  assert.equal(championOf(trimPromotions(items), "answer"), undefined, "a held last revision trimmed away never hands the champion back");
  // Any order of promotes, checks, replays and holds over a few revisions: the trim keeps the champion, and the cap.
  let seed = 7;
  const next = (n) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  for (let round = 0; round < 40; round++) {
    items = Array.from({ length: PROMOTIONS_KEPT + 1 + next(60) }, () => rec(next(4) ? "answer" : "other", `d${next(6)}`, ["promote", "promote", "hold", "replaying", "superseded"][next(5)], { checked: next(9) }));
    const kept = trimPromotions(items);
    assert.ok(kept.length <= PROMOTIONS_KEPT, `round ${round}: ${kept.length} kept`);
    for (const workflow of ["answer", "other"]) assert.equal(championOf(kept, workflow)?.digest, championOf(items, workflow)?.digest, `round ${round} ${workflow}`);
  }
});

// Review on #2644 (child guard names): the DSL names a step of a child workflow `parent/child` (its guard row's `node`
// too), so the serving thresholds, the record-only replay and the refit read a nested guard by that name.
test("a guard in a child workflow is read by its prefixed name: served at its own threshold, and refit", () => {
  const child = { v: 2, name: "inner", schemas: { In: { type: "object" } }, input: { schemaId: "In" }, output: { schemaId: "In", path: "pick" },
    root: { node: "workflow", label: "deeper", input: {}, out: "In", as: "x", workflow: { v: 2, name: "deepest", schemas: {}, root: { node: "agent", label: "leaf", guard: { signal: "self", threshold: 0.3 } } } } };
  const flow = { v: 2, name: "outer", schemas: {}, root: { node: "chain", steps: [
    { node: "workflow", label: "sub", input: {}, out: "In", as: "sub", workflow: { ...child, root: { node: "chain", steps: [{ node: "agent", label: "pick", guard: { signal: "self", threshold: 0.8 } }, child.root] } }, guard: { signal: "self", threshold: 0.5 } },
  ] } };
  const text = JSON.stringify(flow);
  assert.deepEqual([...thresholdsOf(text)], [["sub", 0.5], ["sub/pick", 0.8], ["sub/deeper/leaf", 0.3]]);
  // A row at p 0.6 on sub/pick, record-only: served at 0.8, it hands back (never the replay's 1e-9).
  const row = { of: "g", recorded: { answer: "a", correct: true }, outcome: "answered", answer: "b", guards: [{ node: "sub/pick", signal: "self", self: 0.6, p: 0.6, threshold: 1e-9, escalated: false }] };
  assert.equal(escalates(row, thresholdsOf(text)), true);
  // The refit moves the nested guard it has rows for: wrong exactly under 0.5.
  const rows = Array.from({ length: 20 }, (_, i) => { const p = i / 20; return { guards: [{ node: "sub/pick", signal: "self", self: p, p, threshold: 0, escalated: false }], answered: true, wfCorrect: p >= 0.5, agentCorrect: 1 }; });
  const refit = refitGuards(text, rows, "2026-11-13T00:00:00.000Z");
  assert.deepEqual(refit.guards.map(({ node, was, threshold }) => [node, was, threshold]), [["sub/pick", 0.8, 0.5]]);
  assert.equal(JSON.parse(refit.text).root.steps[0].workflow.root.steps[0].guard.threshold, 0.5);
});
