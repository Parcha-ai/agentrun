// The field-by-field check (learn/field-check.ts check): a learned workflow's answers judged per field against each
// field's best known answer (a label, else a grade's expected answer, else the agent's own), and every field together
// (right on all of them on the same input) at agree_min. A field known only from the agent needs its measured
// self-agreement less the margin, or agree_min where none is measured (the shipped bar: nothing measures it yet); one
// known from a label or grade needs agree_min of its inputs right and at most the margin under the agent's accuracy.
// Table tests: rows and a bar in, a verdict out, no store and no run. Synthetic data only.
import assert from "node:assert/strict";
import { test } from "node:test";

const { check, DEFAULT_MARGIN, tallyOf } = await import("../dist/learn/field-check.js");

const BAR = { alone_min: 0.7, agree_min: 0.8 };
const ids = (n, from = 0) => Array.from({ length: n }, (_, i) => `in-${from + i}`);
const answered = (input_id, fields) => ({ input_id, outcome: "answered", fields });
const counts = (verdict) => Object.fromEntries(Object.entries(verdict.fields).map(([name, one]) => [name, [one.known, one.n, one.workflow_right, one.agent_right, one.pass]]));
/** 20 inputs: mcc wrong on the last, riskTier wrong on the first `off`. */
const twoFields = (off) => ids(20).map((id, i) => answered(id, {
  mcc: { workflow: i === 19 ? "5999" : "5411", agent: "5411" },
  riskTier: { workflow: i < off ? "low" : "high", agent: "high" },
}));

test("on the shipped bar (agree_min 0.8, no self-agreement measured): riskTier wrong on 3 of 20 serves (85%, and 16 of 20 right on both fields); wrong on 5 holds and names riskTier and its inputs", () => {
  const served = check(twoFields(3), BAR);
  assert.deepEqual([served.verdict, served.failing, served.joint], ["serve", [], { agreed: 16, alone: 20, pass: true }]);
  assert.deepEqual(counts(served), { mcc: ["agent", 20, 19, 0, true], riskTier: ["agent", 20, 17, 0, true] }, "agent_right counts only inputs with a label or grade");
  const held = check(twoFields(5), BAR);
  assert.deepEqual([held.verdict, held.failing], ["hold", ["riskTier"]]);
  assert.deepEqual(held.misses.filter((miss) => miss.field === "riskTier").map((miss) => miss.input_id), ids(5));
  assert.match(held.fields.riskTier.reason, /^riskTier: 15 of 20 said what the agent said \(75\.0%, the bar 80\.0%\)$/);
});

test("with a measured self-agreement (none is measured yet): mcc within one answer passes, riskTier 3 to 8 of 20 off holds; the verdict names riskTier and its inputs", () => {
  const bar = { ...BAR, self_agreement: { mcc: 0.92, riskTier: 0.97 } };
  for (const off of [3, 5, 8]) {
    const verdict = check(twoFields(off), bar);
    assert.equal(verdict.verdict, "hold", `riskTier ${off} of 20 off`);
    assert.deepEqual(verdict.failing, ["riskTier"]);
    assert.deepEqual(counts(verdict), { mcc: ["agent", 20, 19, 0, true], riskTier: ["agent", 20, 20 - off, 0, false] });
    assert.deepEqual(verdict.misses.filter((miss) => miss.field === "riskTier").map((miss) => miss.input_id), ids(off));
    assert.deepEqual(verdict.misses.filter((miss) => miss.field === "mcc"), [{ field: "mcc", input_id: "in-19", workflow: "5999", expected: "5411", known: "agent" }]);
    assert.match(verdict.fields.riskTier.reason, /^riskTier: \d+ of 20 said what the agent said \(\d+\.0%, the floor 95\.0%: the agent agrees with itself on it 97\.0%, less 2\.0%\)$/);
    assert.equal(verdict.tally.agreed, 20 - off - 1, "agreed: right on every field");
  }
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

test("a field known only from the agent: its floor is the self-agreement less the margin, else agree_min", () => {
  const rows = (right) => ids(20).map((id, i) => answered(id, { x: { workflow: i < right ? "a" : "b", agent: "a" } }));
  const cases = [
    // [self agreement, right of 20, the field passes]
    [0.92, 18, true], // floor 0.90 of 20 = 18, never 19 by float noise
    [0.92, 17, false],
    [0.5, 10, true],
    [0.01, 0, true], // floor max(0, -0.01)
    [undefined, 16, true], // agree_min 0.8 of 20 = 16
    [undefined, 15, false],
  ];
  for (const [self, right, pass] of cases) {
    const verdict = check(rows(right), { ...BAR, ...(self === undefined ? {} : { self_agreement: { x: self } }) });
    assert.equal(verdict.fields.x.pass, pass, `self ${self}, ${right} of 20 right`);
    assert.equal(verdict.verdict, pass && right >= 16 ? "serve" : "hold", "and every field together at agree_min");
  }
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
  assert.equal(check(rows(43, 45), { ...BAR, margin: 0.04 }).fields.x.pass, true, "a wider margin");
  assert.equal(DEFAULT_MARGIN, 0.02);
  assert.match(check(rows(44, 45), BAR).fields.x.reason, /^x: 44 of 50 right against the grades' expected answers \(88\.0%, the bar 80\.0%\), the agent 45 \(90\.0%; at most 2\.0% under it\)$/);
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
    grade: { n: 1, workflow_right: 0, agent_right: 0, pass: false },
    agent: { n: 1, workflow_right: 1, agent_right: 1, pass: true },
  }, "in-0 repeats an answer graded wrong; in-1 differs from it, which no known answer judges");
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
  assert.deepEqual(verdict.fields.answer.by, { grade: { n: 2, workflow_right: 1, agent_right: 1, pass: false } });
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
  assert.match(verdict.fields.answer.reason, /^answer: 1 of 1 said what the agent said \(100\.0%, the bar 80\.0%\); judged on 1 of 20 \(5\.0%, the bar 70\.0%\): 19 had no known answer \(graded wrong, none given, and the workflow said another\)$/);
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

test("a label beats a grade, which beats the agent's answer", () => {
  const verdict = check([
    answered("in-0", { x: { workflow: "L", agent: "A", grade: "G", label: "L" } }),
    answered("in-1", { x: { workflow: "G", agent: "G", grade: "G" } }),
    answered("in-2", { x: { workflow: "A", agent: "A" } }),
  ], { ...BAR, agree_min: 1 });
  assert.deepEqual(verdict.fields.x.by, {
    label: { n: 1, workflow_right: 1, agent_right: 0, pass: true },
    grade: { n: 1, workflow_right: 1, agent_right: 1, pass: true },
    agent: { n: 1, workflow_right: 1, agent_right: 1, pass: true },
  });
  assert.deepEqual([verdict.fields.x.known, verdict.fields.x.agent_right], ["label", 1], "the strongest source it was known from; the agent right on 1 of the 2 labelled or graded");
  const wrong = check([answered("in-0", { x: { workflow: "G", agent: "G", grade: "G", label: "L" } })], BAR);
  assert.deepEqual(wrong.misses, [{ field: "x", input_id: "in-0", workflow: "G", expected: "L", known: "label" }], "the label decides, not the grade");
  assert.equal(wrong.fields.x.pass, false, "wrong against the label: held, though the agent was wrong too");
});

test("a field known from more than one source must pass each", () => {
  const graded = ids(10).map((id) => answered(id, { x: { workflow: "yes", agent: "yes", grade: "yes" } }));
  const ungraded = ids(10, 10).map((id, i) => answered(id, { x: { workflow: i < 5 ? "yes" : "no", agent: "yes" } }));
  const verdict = check([...graded, ...ungraded], BAR);
  assert.deepEqual([verdict.fields.x.by.grade.pass, verdict.fields.x.by.agent.pass, verdict.fields.x.pass], [true, false, false], "15 of 20 overall, yet 5 of 10 against the agent");
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
    grade: { n: 2, workflow_right: 1, agent_right: 1, pass: false },
    agent: { n: 2, workflow_right: 0, agent_right: 1, pass: false },
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

test("field names that are Object.prototype's own (__proto__, constructor, toString) are fields like any other: counted, gating, and nothing leaks onto every object", () => {
  const names = ["__proto__", "constructor", "toString"];
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

test("agree_min is the field's, over all its known inputs pooled across sources: 19 agent-known inputs right and 1 graded one missed (the agent wrong there too) serve at 19 of 20; the margin stays on the graded inputs alone", () => {
  const agentKnown = ids(19).map((id) => answered(id, { x: { workflow: "a", agent: "a" } }));
  const pooled = check([...agentKnown, answered("in-19", { x: { workflow: "b", agent: "c", grade: "d" } })], BAR);
  assert.deepEqual([pooled.verdict, pooled.fields.x.pass, pooled.failing], ["serve", true, []], pooled.fields.x.reason);
  assert.deepEqual([pooled.fields.x.n, pooled.fields.x.workflow_right], [20, 19]);
  assert.match(pooled.fields.x.reason, /in all: 19 of 20 right \(95\.0%, the bar 80\.0%\)/);
  const under = check([...agentKnown, answered("in-19", { x: { workflow: "b", agent: "d", grade: "d" } })], BAR);
  assert.deepEqual([under.verdict, under.fields.x.pass, under.failing], ["hold", false, ["x"]], "the agent right on its graded input and the draft wrong: under the agent by more than the margin");
  const short = check([...ids(19).map((id, i) => answered(id, { x: { workflow: i < 15 ? "a" : "z", agent: "a" } })), answered("in-19", { x: { workflow: "d", agent: "c", grade: "d" } })], BAR);
  assert.deepEqual([short.fields.x.workflow_right, short.fields.x.pass], [16, true], "16 of 20 pooled is agree_min");
  const shorter = check([...ids(19).map((id, i) => answered(id, { x: { workflow: i < 14 ? "a" : "z", agent: "a" } })), answered("in-19", { x: { workflow: "d", agent: "c", grade: "d" } })], BAR);
  assert.deepEqual([shorter.fields.x.workflow_right, shorter.fields.x.pass], [15, false], "15 of 20 pooled is under it");
});

test("an agent-known field the agent's answer lacks is not the agent's right answer there: agent_agreed leaves that input out", () => {
  const tally = tallyOf([answered("in-0", { x: { workflow: "a", agent: undefined } }), answered("in-1", { x: { workflow: "a", agent: "a" } })]);
  assert.deepEqual([tally.agent_agreed, tally.fields.x.agent.agent_right], [1, 1]);
});
