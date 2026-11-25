// The field-by-field check (learn/field-check.ts check): a learned workflow's answers judged per field against each
// field's best known answer (a grade's expected answer, else the agent's own), and every field together (right on all
// of them on the same input) at agree_min. A field needs agree_min of its inputs right; its graded inputs also need
// agree_min right and at most 2 points under the agent's accuracy there, one miss allowed in each.
// Table tests: rows and a bar in, a verdict out, no store and no run. Synthetic data only.
import assert from "node:assert/strict";
import { test } from "node:test";

const { check, tallyOf } = await import("../dist/learn/field-check.js");

const BAR = { alone_min: 0.7, agree_min: 0.8 };
const ids = (n, from = 0) => Array.from({ length: n }, (_, i) => `in-${from + i}`);
const answered = (input_id, fields) => ({ input_id, outcome: "answered", fields });
const counts = (verdict) => Object.fromEntries(Object.entries(verdict.fields).map(([name, one]) => [name, [one.known, one.n, one.workflow_right, one.agent_right, one.pass]]));
/** 20 inputs: mcc wrong on the last, riskTier wrong on the first `off`. */
const twoFields = (off) => ids(20).map((id, i) => answered(id, {
  mcc: { workflow: i === 19 ? "5999" : "5411", agent: "5411" },
  riskTier: { workflow: i < off ? "low" : "high", agent: "high" },
}));

test("on the shipped bar (agree_min 0.8): riskTier wrong on 3 of 20 serves (85%, and 16 of 20 right on both fields); wrong on 5 holds and names riskTier and its inputs", () => {
  const served = check(twoFields(3), BAR);
  assert.deepEqual([served.verdict, served.failing, served.joint], ["serve", [], { agreed: 16, alone: 20, pass: true }]);
  assert.deepEqual(counts(served), { mcc: ["agent", 20, 19, 0, true], riskTier: ["agent", 20, 17, 0, true] }, "agent_right counts only inputs with a label or grade");
  const held = check(twoFields(5), BAR);
  assert.deepEqual([held.verdict, held.failing], ["hold", ["riskTier"]]);
  assert.deepEqual(held.misses.filter((miss) => miss.field === "riskTier").map((miss) => miss.input_id), ids(5));
  assert.match(held.fields.riskTier.reason, /^riskTier: 15 of 20 said what the agent said \(75\.0%, the bar 80\.0%\)$/);
});

test("every field together: two fields each right on 16 of 20, wrong on different inputs (12 of 20 right on both), holds on the joint floor", () => {
  const rows = ids(20).map((id, i) => answered(id, {
    mcc: { workflow: i < 4 ? "5999" : "5411", agent: "5411" },
    riskTier: { workflow: i >= 4 && i < 8 ? "low" : "high", agent: "high" },
  }));
  const verdict = check(rows, BAR);
  assert.deepEqual([verdict.fields.mcc.pass, verdict.fields.riskTier.pass, verdict.failing], [true, true, []], "each field alone clears 80%");
  assert.deepEqual([verdict.verdict, verdict.joint], ["hold", { agreed: 12, alone: 20, pass: false }], "12 of 20 right on both: under 80%");
  assert.equal(check(rows, { ...BAR, agree_min: 0.6 }).verdict, "serve", "at agree_min 0.6, 12 of 20 is enough");
});

test("a field known only from the agent: its floor is agree_min, never off by float noise", () => {
  const rows = (right) => ids(20).map((id, i) => answered(id, { x: { workflow: i < right ? "a" : "b", agent: "a" } }));
  for (const [right, pass] of [[16, true], [15, false]]) assert.equal(check(rows(right), BAR).fields.x.pass, pass, `${right} of 20 right`);
  assert.equal(check(rows(18), { ...BAR, agree_min: 0.9 }).fields.x.pass, true, "0.9 of 20 needs 18, never 19");
  assert.match(check(rows(16), BAR).fields.x.reason, /^x: 16 of 20 said what the agent said \(80\.0%, the bar 80\.0%\)$/);
});

test("a field known from grades: at least agree_min of its inputs right, and at most the margin under the agent's accuracy on them", () => {
  const rows = (workflowRight, agentRight, n = 50) => ids(n).map((id, i) => answered(id, { x: { workflow: i < workflowRight ? "yes" : "no", agent: i < agentRight ? "yes" : "no", grade: "yes" } }));
  const cases = [
    // [workflow right, agent right, pass] of 50: agree_min 0.8 is 40; the margin 0.02 of 50 is 1 input
    [45, 45, true],
    [44, 45, true],
    [43, 45, false],
    [45, 30, true],
    [40, 40, true],
    [39, 30, false], // over the agent, under 80%
    [0, 0, false], // the agent wrong everywhere too: no free pass
  ];
  for (const [workflowRight, agentRight, pass] of cases) {
    const verdict = check(rows(workflowRight, agentRight), BAR);
    assert.deepEqual(counts(verdict).x, ["grade", 50, workflowRight, agentRight, pass], `${workflowRight} vs ${agentRight}`);
  }
  assert.match(check(rows(44, 45), BAR).fields.x.reason, /^x: 44 of 50 right against the grades' expected answers \(88\.0%, the bar 80\.0%\), the agent 45 \(90\.0%; at most 2\.0% under it\), one miss allowed in each$/);
});

test("corrections: every input graded with the agent wrong; a workflow that answers anything else is held, one that says the expected answers serves", () => {
  const rows = (says) => ids(5).map((id) => answered(id, { answer: { workflow: says, agent: { answer: 42 }, grade: { answer: 41 } } }));
  const garbage = check(rows({ answer: 7 }), BAR);
  assert.deepEqual([garbage.verdict, counts(garbage).answer], ["hold", ["grade", 5, 0, 0, false]]);
  assert.equal(check(rows(undefined), BAR).verdict, "hold", "no answer to compare (not a JSON object): held");
  const right = check(rows({ answer: 41 }), BAR);
  assert.deepEqual([right.verdict, counts(right).answer], ["serve", ["grade", 5, 5, 0, true]]);
});

test("a grade with no expected answer: graded right, the agent's answer is known as any agent answer is (agree_min, no stricter); graded wrong, repeating it is wrong, and any other answer is unjudged", () => {
  const confirmed = (right) => check(ids(5).map((id, i) => answered(id, { x: { workflow: i < right ? "a" : "b", agent: "a", agent_correct: true } })), BAR);
  assert.deepEqual(counts(confirmed(5)).x, ["agent", 5, 5, 0, true]);
  assert.deepEqual(counts(confirmed(4)).x, ["agent", 5, 4, 0, true], "4 of 5 is agree_min, as with no grade: a thumbs-up never makes the bar 100%");
  const refuted = check([
    answered("in-0", { x: { workflow: "a", agent: "a", agent_correct: false } }),
    answered("in-1", { x: { workflow: "b", agent: "a", agent_correct: false } }),
    answered("in-2", { x: { workflow: "c", agent: "c" } }),
  ], BAR);
  assert.deepEqual(refuted.fields.x.by, {
    grade: { n: 1, workflow_right: 0, agent_right: 0 },
    agent: { n: 1, workflow_right: 1, agent_right: 1 },
  }, "in-0 repeats an answer graded wrong (its one miss, allowed there alone); in-1 differs from it, which no known answer judges");
  assert.equal(refuted.fields.x.pass, false, "1 of 2 right in all: under agree_min");
  assert.equal(refuted.fields.x.unjudged, 1, "in-1 is counted as unjudged");
  assert.deepEqual(refuted.misses, [
    { field: "x", input_id: "in-0", workflow: "a", expected: undefined, known: "unknown" },
    { field: "x", input_id: "in-1", workflow: "b", expected: undefined, known: "unknown" },
  ], "both are misses the recompile sees, marked wrong with no right answer given; none is made up");
  assert.deepEqual([refuted.verdict, refuted.joint.agreed], ["hold", 1], "only in-2 is right on every field");
});

test("a grade's known answer on a whole answer: `agrees` (the fast model's verdict on the workflow's answer and that one) decides where equal values do not, and the grade's own word decides the agent's", () => {
  const rows = [
    answered("in-0", { answer: { workflow: "w0", agent: "a0", grade: { k: 1 }, agrees: true, agent_correct: false } }),
    answered("in-1", { answer: { workflow: "w1", agent: "a1", grade: { k: 1 }, agrees: false, agent_correct: true } }),
  ];
  const verdict = check(rows, BAR);
  assert.deepEqual(verdict.fields.answer.by, { grade: { n: 2, workflow_right: 1, agent_right: 1 } });
  assert.equal(verdict.fields.answer.pass, false, "1 of 2 right: under agree_min");
  assert.deepEqual(verdict.misses, [{ field: "answer", input_id: "in-1", workflow: "w1", expected: { k: 1 }, known: "grade" }]);
});

test("unjudged inputs are never right: 19 answers graded wrong with no correction, where the draft says anything else, and 1 ungraded input it matches, hold on the joint floor and on the field's judged count", () => {
  const rows = [
    ...ids(19).map((id) => answered(id, { answer: { workflow: "", agent: "the agent's answer", agent_correct: false } })),
    answered("in-19", { answer: { workflow: "same", agent: "same" } }),
  ];
  const verdict = check(rows, BAR);
  assert.equal(verdict.verdict, "hold");
  assert.deepEqual(verdict.joint, { agreed: 1, alone: 20, pass: false }, "an unjudged input is not right on every field");
  assert.deepEqual([verdict.fields.answer.n, verdict.fields.answer.unjudged, verdict.fields.answer.pass], [1, 19, false], "judged on 1 of the 20 inputs it answered: under alone_min");
  assert.deepEqual(verdict.failing, ["answer"]);
  assert.match(verdict.fields.answer.reason, /^answer: 1 of 1 said what the agent said \(100\.0%, the bar 80\.0%\); judged on 1 of 20 \(5\.0%, the bar 70\.0%\): 19 had no known answer \(graded wrong with none given and the workflow said another, or a grade that contradicts itself\)$/);
  assert.deepEqual(tallyOf(rows).fields.answer, { agent: { n: 1, workflow_right: 1, agent_right: 1 }, unjudged: 19 }, "the tally keeps the unjudged count, so a check collected over time adds to it");
  const few = check([
    ...ids(2).map((id) => answered(id, { answer: { workflow: "", agent: "the agent's answer", agent_correct: false } })),
    ...ids(18, 2).map((id) => answered(id, { answer: { workflow: "same", agent: "same" } })),
  ], BAR);
  assert.deepEqual([few.verdict, few.joint, few.fields.answer.pass], ["serve", { agreed: 18, alone: 20, pass: true }, true], "2 unjudged of 20: judged on 18, right on 18 of 20 at once");
});

test("the agent right on every field at once (agent_agreed), counted on the same inputs and known answers as agreed", () => {
  assert.deepEqual([check(twoFields(3), BAR).tally.agent_agreed, check(twoFields(3), BAR).tally.agreed], [20, 16], "known only from the agent: the agent is right on all");
  const graded = (workflowRight, agentRight) => ids(10).map((id, i) => answered(id, { x: { workflow: i < workflowRight ? "yes" : "no", agent: i < agentRight ? "yes" : "no", grade: "yes" }, y: { workflow: 1, agent: 1 } }));
  assert.deepEqual([check(graded(9, 6), BAR).tally.agreed, check(graded(9, 6), BAR).tally.agent_agreed], [9, 6]);
  const refuted = check([answered("in-0", { x: { workflow: "b", agent: "a", agent_correct: false } }), answered("in-1", { x: { workflow: "a", agent: "a", agent_correct: false } }), answered("in-2", { x: { workflow: "c", agent: "c" } })], BAR);
  assert.equal(refuted.tally.agent_agreed, 1, "an answer graded wrong is the agent's miss, judged or not");
});

test("a grade beats the agent's answer: the field is known from the grade, and the agent measured there", () => {
  const verdict = check([
    answered("in-0", { x: { workflow: "G", agent: "A", grade: "G" } }),
    answered("in-1", { x: { workflow: "A", agent: "A" } }),
  ], { ...BAR, agree_min: 1 });
  assert.deepEqual(verdict.fields.x.by, { grade: { n: 1, workflow_right: 1, agent_right: 0 }, agent: { n: 1, workflow_right: 1, agent_right: 1 } });
  assert.deepEqual([verdict.fields.x.known, verdict.fields.x.agent_right], ["grade", 0], "the strongest source it was known from; the agent wrong on its graded input");
  const wrong = check([answered("in-0", { x: { workflow: "A", agent: "A", grade: "G" } })], BAR);
  assert.deepEqual(wrong.misses, [{ field: "x", input_id: "in-0", workflow: "A", expected: "G", known: "grade" }], "the grade decides, not the agent");
});

test("a field known from a grade and from the agent is pooled: 10 graded right and 5 of 10 agent-known hold at 15 of 20", () => {
  const graded = ids(10).map((id) => answered(id, { x: { workflow: "yes", agent: "yes", grade: "yes" } }));
  const ungraded = ids(10, 10).map((id, i) => answered(id, { x: { workflow: i < 5 ? "yes" : "no", agent: "yes" } }));
  const verdict = check([...graded, ...ungraded], BAR);
  assert.deepEqual([verdict.fields.x.n, verdict.fields.x.workflow_right, verdict.fields.x.pass], [20, 15, false]);
  assert.deepEqual(verdict.failing, ["x"]);
});

test("a missing value is never right: not the workflow's, and not against a missing agent answer", () => {
  const verdict = check([
    answered("in-0", { x: { workflow: undefined, agent: "a" } }),
    answered("in-1", { x: { workflow: undefined, agent: undefined } }),
    answered("in-2", { x: { workflow: "a", agent: "b", grade: "a" } }),
    answered("in-3", { x: { workflow: undefined, agent: "a", grade: "a" } }),
  ], BAR);
  assert.deepEqual(verdict.misses.map((miss) => miss.input_id), ["in-0", "in-1", "in-3"]);
  assert.deepEqual(verdict.fields.x.by, {
    grade: { n: 2, workflow_right: 1, agent_right: 1 },
    agent: { n: 2, workflow_right: 0, agent_right: 1 },
  }, "in-1's agent gave no value: it is not counted as the agent's right answer there");
});

test("values compare as JSON values: keys in any order, arrays in order; `agrees` decides a field known from the agent", () => {
  const verdict = check([
    answered("in-0", { x: { workflow: { a: 1, b: [1, 2] }, agent: { b: [1, 2], a: 1 } } }),
    answered("in-1", { y: { workflow: [2, 1], agent: [1, 2] } }),
    answered("in-2", { z: { workflow: "free text one way", agent: "free text another", agrees: true } }),
    answered("in-3", { z: { workflow: "same", agent: "same", agrees: false } }),
  ], BAR);
  assert.deepEqual(Object.fromEntries(Object.entries(verdict.fields).map(([name, one]) => [name, one.workflow_right])), { x: 1, y: 0, z: 1 });
});

test("field names that are Object.prototype's own (constructor, toString; agree_on never names __proto__) are fields like any other: counted, gating, and nothing leaks onto every object", () => {
  const names = ["constructor", "toString"];
  const row = (id, wrong) => answered(id, Object.fromEntries(names.map((name) => [name, { workflow: name === wrong ? "b" : "a", agent: "a" }])));
  try {
    const verdict = check([row("in-0"), row("in-1", "constructor")], { ...BAR, agree_min: 0.5 });
    assert.deepEqual(Object.keys(verdict.tally.fields), names);
    assert.deepEqual(Object.keys(verdict.fields), names);
    assert.deepEqual([verdict.verdict, verdict.fields.constructor.workflow_right, verdict.fields.constructor.n], ["serve", 1, 2]);
    assert.deepEqual(check([row("in-0"), row("in-1", "constructor")], BAR).failing, ["constructor"], "constructor gates: 1 of 2 under 80%");
    const before = tallyOf([row("in-0")]);
    assert.deepEqual(Object.keys(check([row("in-1", "toString")], BAR, before).tally.fields), names, "carried over in a tally too");
    assert.equal(Object.hasOwn(Object.prototype, "agent"), false, "Object.prototype untouched");
    assert.equal({}.agent, undefined);
  } finally {
    delete Object.prototype.agent;
  }
});

test("alone: not enough inputs answered alone holds though every field passes; skipped inputs are not counted", () => {
  const right = (id) => answered(id, { x: { workflow: 1, agent: 1 } });
  const handed = (input_id) => ({ input_id, outcome: "handed_back" });
  const failed = (input_id) => ({ input_id, outcome: "failed" });
  const skipped = (input_id) => ({ input_id, outcome: "skipped" });
  const held = check([right("a"), right("b"), handed("c"), failed("d")], BAR);
  assert.deepEqual([held.verdict, held.alone_pass, held.failing, held.tally.n, held.tally.alone], ["hold", false, [], 4, 2], "2 of 4 alone, under 0.7");
  const kept = check([right("a"), right("b"), right("c"), handed("d"), skipped("e"), skipped("f")], BAR);
  assert.deepEqual([kept.verdict, kept.tally.n, kept.tally.alone], ["serve", 4, 3], "3 of 4 alone: the skipped are no evidence");
  assert.deepEqual(check([handed("a"), failed("b")], { alone_min: 0, agree_min: 0 }).verdict, "hold", "none answered alone never serves");
  assert.deepEqual(check([], BAR).verdict, "hold", "no input never serves");
  assert.deepEqual(check([answered("a", {})], { alone_min: 0, agree_min: 0 }).verdict, "hold", "no field never serves");
});

test("a check that collects its inputs over time adds the next rows to what it counted before; misses are the new rows'", () => {
  const rows = ids(10).map((id, i) => answered(id, { x: { workflow: i < 9 ? "a" : "b", agent: "a" } }));
  const before = tallyOf(rows.slice(0, 6));
  assert.deepEqual(before, { n: 6, alone: 6, agreed: 6, agent_agreed: 6, fields: { x: { agent: { n: 6, workflow_right: 6, agent_right: 6 } } } });
  const split = check(rows.slice(6), BAR, before);
  const whole = check(rows, BAR);
  assert.deepEqual(split.tally, whole.tally);
  assert.deepEqual(split.fields, whole.fields);
  assert.deepEqual(split.misses, whole.misses, "the one miss is in the later rows");
  assert.deepEqual(before.fields.x.agent.n, 6, "the earlier tally is not changed");
});

test("a value equal to the agent's, where a grade marked the agent's answer wrong, is never right on that input, whatever `agrees` says", () => {
  const said = { decision: "approve", amount: 100 };
  const repeat = check([answered("in-0", { answer: { workflow: { ...said }, agent: said, grade: { amount: 120 }, agrees: true, agent_correct: false } })], BAR);
  assert.deepEqual([repeat.fields.answer.workflow_right, repeat.tally.agreed, repeat.verdict], [0, 0, "hold"]);
  assert.deepEqual(repeat.misses, [{ field: "answer", input_id: "in-0", workflow: said, expected: { amount: 120 }, known: "grade" }]);
  const other = check([answered("in-0", { answer: { workflow: { decision: "approve", amount: 120 }, agent: said, grade: { amount: 120 }, agrees: true, agent_correct: false } })], BAR);
  assert.equal(other.fields.answer.workflow_right, 1, "another answer the verdict calls the known one's decision stays right");
});

test("agree_min is the field's, over all its known inputs pooled across sources: 19 agent-known inputs right and 1 graded one missed (the agent wrong there too) serve at 19 of 20; the 2-point margin stays on the graded inputs alone", () => {
  const agentKnown = ids(19).map((id) => answered(id, { x: { workflow: "a", agent: "a" } }));
  const pooled = check([...agentKnown, answered("in-19", { x: { workflow: "b", agent: "c", grade: "d" } })], BAR);
  assert.deepEqual([pooled.verdict, pooled.fields.x.pass, pooled.failing], ["serve", true, []], pooled.fields.x.reason);
  assert.deepEqual([pooled.fields.x.n, pooled.fields.x.workflow_right], [20, 19]);
  assert.match(pooled.fields.x.reason, /in all: 19 of 20 right \(95\.0%, the bar 80\.0%\)/);
  const under = check([...agentKnown, answered("in-19", { x: { workflow: "b", agent: "d", grade: "d" } })], BAR);
  assert.deepEqual([under.verdict, under.fields.x.pass, under.failing], ["serve", true, []], "the agent right on its one graded input and the draft wrong: one miss is always allowed there");
  const short = check([...ids(19).map((id, i) => answered(id, { x: { workflow: i < 15 ? "a" : "z", agent: "a" } })), answered("in-19", { x: { workflow: "d", agent: "c", grade: "d" } })], BAR);
  assert.deepEqual([short.fields.x.workflow_right, short.fields.x.pass], [16, true], "16 of 20 pooled is agree_min");
  const shorter = check([...ids(19).map((id, i) => answered(id, { x: { workflow: i < 14 ? "a" : "z", agent: "a" } })), answered("in-19", { x: { workflow: "d", agent: "c", grade: "d" } })], BAR);
  assert.deepEqual([shorter.fields.x.workflow_right, shorter.fields.x.pass], [15, false], "15 of 20 pooled is under it");
});

test("an agent-known field the agent's answer lacks is not the agent's right answer there: agent_agreed leaves that input out", () => {
  const tally = tallyOf([answered("in-0", { x: { workflow: "a", agent: undefined } }), answered("in-1", { x: { workflow: "a", agent: "a" } })]);
  assert.deepEqual([tally.agent_agreed, tally.fields.x.agent.agent_right], [1, 1]);
});

test("the graded inputs keep their own floor and the margin, one miss always allowed: 80 agent-known right and 20 graded wrong, the draft repeating the agent there, hold; 97 agent-known and 3 graded, the agent 3 of 3 and the draft 2, serve; one correct-graded input missed among 19 serves", () => {
  const agentKnown = (n) => ids(n).map((id) => answered(id, { x: { workflow: "a", agent: "a" } }));
  const repeats = ids(20, 80).map((id) => answered(id, { x: { workflow: "w", agent: "w", grade: "d", agent_correct: false } }));
  const repeated = check([...agentKnown(80), ...repeats], BAR);
  assert.deepEqual([repeated.verdict, repeated.fields.x.n, repeated.fields.x.workflow_right, repeated.failing], ["hold", 100, 80, ["x"]], "0 of 20 graded right: far past one miss, and under agree_min there");
  const grades = ids(3, 97).map((id, i) => answered(id, { x: { workflow: i < 2 ? "G" : "z", agent: "G", grade: "G" } }));
  const graded = check([...agentKnown(97), ...grades], BAR);
  assert.deepEqual([graded.verdict, graded.fields.x.by.grade], ["serve", { n: 3, workflow_right: 2, agent_right: 3 }], graded.fields.x.reason);
  const thumbsUp = check([...agentKnown(19), answered("in-19", { x: { workflow: "b", agent: "d", grade: "d", agent_correct: true } })], BAR);
  assert.deepEqual([thumbsUp.verdict, thumbsUp.fields.x.by.grade], ["serve", { n: 1, workflow_right: 0, agent_right: 1 }], thumbsUp.fields.x.reason);
  // Past the one miss, the floor and the margin hold as they did.
  const twoMissed = check([...agentKnown(18), ...ids(2, 18).map((id) => answered(id, { x: { workflow: "b", agent: "d", grade: "d" } }))], BAR);
  assert.deepEqual([twoMissed.verdict, twoMissed.failing], ["hold", ["x"]], "2 of 2 graded missed: past one miss, and under agree_min there");
  const under = check(ids(100).map((id, i) => answered(id, { x: { workflow: i < 95 ? "d" : "b", agent: "d", grade: "d" } })), BAR);
  assert.deepEqual([under.verdict, under.fields.x.workflow_right, under.fields.x.agent_right], ["hold", 95, 100], "95 of 100 right, the agent 100: 5 under it, past the margin's 2");
});
