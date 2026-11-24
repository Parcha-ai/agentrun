// The field-by-field check (learn/field-check.ts check): a learned workflow's answers judged per field against each
// field's best known answer (a label, else a grade's expected answer, else the agent's own), the agent's self-agreement
// less the margin as the floor of a field known only from the agent. Table tests: rows and a bar in, a verdict out, no
// store and no run. Synthetic data only.
import assert from "node:assert/strict";
import { test } from "node:test";

const { check, DEFAULT_MARGIN, tallyOf } = await import("../dist/learn/field-check.js");

const BAR = { alone_min: 0.7, agree_min: 0.8 };
const ids = (n, from = 0) => Array.from({ length: n }, (_, i) => `in-${from + i}`);
const answered = (input_id, fields) => ({ input_id, outcome: "answered", fields });
const counts = (verdict) => Object.fromEntries(Object.entries(verdict.fields).map(([name, one]) => [name, [one.known, one.n, one.workflow_right, one.agent_right, one.pass]]));

test("S6-shaped: mcc within one answer of the agent passes, riskTier 3 to 8 of 20 off holds; the verdict names riskTier and its inputs", () => {
  const bar = { ...BAR, self_agreement: { mcc: 0.92, riskTier: 0.97 } };
  for (const off of [3, 5, 8]) {
    const rows = ids(20).map((id, i) => answered(id, {
      mcc: { workflow: i === 19 ? "5999" : "5411", agent: "5411" },
      riskTier: { workflow: i < off ? "low" : "high", agent: "high" },
    }));
    const verdict = check(rows, bar);
    assert.equal(verdict.verdict, "hold", `riskTier ${off} of 20 off`);
    assert.deepEqual(verdict.failing, ["riskTier"]);
    assert.deepEqual(counts(verdict), { mcc: ["agent", 20, 19, 20, true], riskTier: ["agent", 20, 20 - off, 20, false] });
    assert.deepEqual(verdict.misses.filter((miss) => miss.field === "riskTier").map((miss) => miss.input_id), ids(off));
    assert.deepEqual(verdict.misses.filter((miss) => miss.field === "mcc"), [{ field: "mcc", input_id: "in-19", workflow: "5999", expected: "5411", known: "agent" }]);
    assert.match(verdict.fields.riskTier.reason, /^riskTier: \d+ of 20 said what the agent said \(\d+\.0%, the floor 95\.0%: the agent agrees with itself on it 97\.0%, less 2\.0%\)$/);
    assert.equal(verdict.tally.agreed, 20 - off - 1, "agreed: right on every field");
  }
});

test("the same rows on one combined number would pass: riskTier alone fails, mcc alone passes", () => {
  const bar = { ...BAR, self_agreement: { mcc: 0.92, riskTier: 0.97 } };
  const rows = ids(20).map((id, i) => answered(id, { mcc: { workflow: "5411", agent: "5411" }, riskTier: { workflow: i < 3 ? "low" : "high", agent: "high" } }));
  const verdict = check(rows, bar);
  assert.deepEqual([verdict.verdict, verdict.failing, verdict.tally.agreed], ["hold", ["riskTier"], 17], "17 of 20 (85%) clears the combined 0.8 bar; the field does not");
});

test("a field known only from the agent: its floor is the self-agreement less the margin, else agree_min", () => {
  const rows = (right) => ids(20).map((id, i) => answered(id, { x: { workflow: i < right ? "a" : "b", agent: "a" } }));
  const cases = [
    // [self agreement, right of 20, pass]
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
    assert.equal(verdict.verdict, pass ? "serve" : "hold");
  }
  assert.match(check(rows(16), BAR).fields.x.reason, /^x: 16 of 20 said what the agent said \(80\.0%, the bar 80\.0%\)$/);
});

test("a field known from grades passes within the margin of the agent's accuracy on the same inputs", () => {
  const rows = (workflowRight, agentRight, n = 50) => ids(n).map((id, i) => answered(id, { x: { workflow: i < workflowRight ? "yes" : "no", agent: i < agentRight ? "yes" : "no", grade: "yes" } }));
  const cases = [
    // [workflow right, agent right, pass] of 50: the margin is 0.02 of 50 = 1 input
    [40, 40, true],
    [39, 40, true],
    [38, 40, false],
    [45, 30, true],
    [0, 0, true],
  ];
  for (const [workflowRight, agentRight, pass] of cases) {
    const verdict = check(rows(workflowRight, agentRight), BAR);
    assert.deepEqual(counts(verdict).x, ["grade", 50, workflowRight, agentRight, pass], `${workflowRight} vs ${agentRight}`);
  }
  assert.equal(check(rows(38, 40), { ...BAR, margin: 0.04 }).fields.x.pass, true, "a wider margin");
  assert.equal(DEFAULT_MARGIN, 0.02);
  assert.match(check(rows(39, 40), BAR).fields.x.reason, /^x: 39 of 50 right against the grades' expected answers \(78\.0%\), the agent 40 \(80\.0%; at most 2\.0% under it\)$/);
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
  assert.equal(verdict.fields.x.known, "label", "the strongest source it was known from");
  const wrong = check([answered("in-0", { x: { workflow: "G", agent: "G", grade: "G", label: "L" } })], BAR);
  assert.deepEqual(wrong.misses, [{ field: "x", input_id: "in-0", workflow: "G", expected: "L", known: "label" }], "the label decides, not the grade");
  assert.equal(wrong.fields.x.pass, true, "wrong where the agent was wrong too: within the margin");
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
    grade: { n: 2, workflow_right: 1, agent_right: 1, pass: true },
    agent: { n: 2, workflow_right: 0, agent_right: 2, pass: false },
  });
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
  assert.deepEqual(before, { n: 6, alone: 6, agreed: 6, fields: { x: { agent: { n: 6, workflow_right: 6, agent_right: 6 } } } });
  const split = check(rows.slice(6), BAR, before);
  const whole = check(rows, BAR);
  assert.deepEqual(split.tally, whole.tally);
  assert.deepEqual(split.fields, whole.fields);
  assert.deepEqual(split.misses, whole.misses, "the one miss is in the later rows");
  assert.deepEqual(before.fields.x.agent.n, 6, "the earlier tally is not changed");
});
