// learning.agree_on: the check (runner/promotion.ts decideCheck) and the audit (runner/audit.ts) compare two answers on
// the fields that say the decision, never on free text two real runs never repeat. A definition's `learning.agree_on`
// names them as dotted paths into the answer's JSON object (`verdict.decision`); absent, the whole answer, as before (no
// field is picked from the output schema: its enum can be an echo of the owner's setting, not the decision), and a check
// that agreed on none says to name the fields. Synthetic data only: an invented merchant on example.com.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { schemaProblems } from "./schema-support.mjs";
import { agent, serve } from "./support.mjs";

const { decideCheck, NEVER_WORD_FOR_WORD, replayView } = await import("../dist/runner/promotion.js");
const { answersPair, forgetRunCopies, knownAnswerText, promotionsOf, recordPromotion, sameAnswer } = await import("../dist/learn/promote.js");
const { learningSettingIssue, learningSettingOf, loopOf } = await import("../dist/learning-setting.js");
const { secretsShown } = await import("../dist/learning.js");
const { learningSettingForBody } = await import("../dist/store/agent-body.js");
const { openapiDocument } = await import("../dist/openapi.js");
const doc = openapiDocument(() => undefined);

/** The agent's answer as a real model writes it: prose, then one fenced json block. */
const agentSays = (fields) => `Example Cinema (example.com) sells film tickets and concessions.\n\n\`\`\`json\n${JSON.stringify(fields, null, 2)}\n\`\`\``;
/** The draft's answer: one bare fenced json block. */
const draftSays = (fields) => `\`\`\`json\n${JSON.stringify(fields)}\n\`\`\``;

const AGENT = { mcc: "7832", riskTier: "low", riskRationale: "A cinema with a public box office and a long trading history.", evidence: ["example.com/tickets lists showtimes"], confidence: 0.86 };
const DRAFT = { riskTier: "low", mcc: "7832", riskRationale: "Motion picture theatre; low chargeback exposure.", evidence: ["Showtimes page on example.com"], confidence: 0.74 };

/** The settings a promotion record is written through, in memory. */
function settingsOf() {
  const kv = new Map();
  return {
    get: async (key) => (kv.has(key) ? structuredClone(kv.get(key)) : undefined),
    putIfAbsent: async (key, value) => (kv.has(key) ? kv.get(key) : (kv.set(key, structuredClone(value)), value)),
    replaceIf: async (key, was, value) => (JSON.stringify(kv.get(key)) === JSON.stringify(was) ? (kv.set(key, structuredClone(value)), true) : false),
  };
}

/** A check's read of `rows` answered alone, each the agent's `agent`-shaped answer and the draft's `draft(i)`. */
const readOf = (draft, n = 5, said = AGENT) => {
  const rows = Array.from({ length: n }, (_, i) => ({ of: `r-${i}`, input: `{"merchant":"Example Cinema ${i}","site":"https://example.com/${i}"}`, agent: agentSays(said), outcome: "answered", answer: draft(i) }));
  return { rows, cost: 0, outcomes: { answered: n, handed_back: 0, skipped_write: 0, failed: 0 }, unstarted: 0 };
};

async function decide(bar, read) {
  const settings = settingsOf();
  const logs = [];
  const deps = { store: { settings }, agentId: "a", runId: "now", revisionId: "rev", launch: {}, context: ctx, log: (line) => logs.push(line), shown: async () => secretsShown([]) };
  const decided = await decideCheck(deps, "classify", "d1", { compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1, ...bar }, read, () => true, {});
  return { record: decided.record, stored: (await promotionsOf(settings, "a")).at(-1), logs, settings };
}

test("check on live-shaped answers: same mcc and riskTier, other rationale, evidence and confidence: agreed on agree_on, promoted; on the whole answer, held", async () => {
  const on = await decide({ agree_on: ["mcc", "riskTier"] }, readOf(() => draftSays(DRAFT)));
  assert.equal(on.record.decided, "promote", on.record.reason);
  assert.deepEqual([on.stored.check.agreed, on.stored.check.alone, on.stored.check.agree_on], [5, 5, ["mcc", "riskTier"]], "the record says what it compared");
  assert.equal(on.stored.check.joint, true, "the joint floor's verdict, kept as the check decided it");
  assert.deepEqual(Object.entries(on.stored.check.fields).map(([name, one]) => [name, one.workflow_right, one.n, one.pass]), [["mcc", 5, 5, true], ["riskTier", 5, 5, true]], "one verdict per field");

  const whole = await decide({}, readOf(() => draftSays(DRAFT)));
  assert.equal(whole.record.decided, "hold", "today's whole-answer rule stands with no agree_on");
  assert.deepEqual([whole.stored.check.agreed, whole.stored.check.joint], [0, false]);
  assert.equal(whole.stored.check.agree_on, undefined);
  assert.deepEqual(Object.entries(whole.stored.check.fields).map(([name, one]) => [name, one.workflow_right, one.n, one.pass]), [["answer", 0, 5, false]]);
  assert.ok(whole.record.reason.includes(NEVER_WORD_FOR_WORD), `compared whole and never once the same: the owner is told to name the fields: ${whole.record.reason}`);
});

test("a connected agent's turns counted before per-field tallies existed: each field counts from the same turns as alone does", async () => {
  // 19 turns kept with numbers only (no per-field tally), 10 of them agreeing, then one more that agrees: 11 of 20.
  const before = { n: 19, agreed: 10, alone: 19, of: Array.from({ length: 19 }, (_, i) => `t-${i}`), outcomes: { answered: 19, handed_back: 0, failed: 0, skipped_write: 0 } };
  const held = await decide({ compile_after: 20 }, { ...readOf(() => agentSays(AGENT), 1), before });
  assert.equal(held.record.decided, "hold", held.record.reason);
  const { answer } = held.stored.check.fields;
  assert.deepEqual([answer.n, answer.workflow_right, held.stored.check.alone, held.stored.check.agreed], [20, 11, 20, 11]);
});

/** The known answer of a row whose agent said AGENT and whose grade expects `expected`: AGENT with the grade's keys
 *  written over it, as JSON. */
const correctedText = (expected) => JSON.stringify({ ...AGENT, ...expected });
/** `read`'s rows graded: the agent's answer marked wrong (`correct`), `expected` the right one, and, with `compared`, the
 *  fast model's verdict on the draft and `against` (the corrected answer's text, correctedText, unless given). */
const gradedRead = (read, expected, compared, against) => ({ ...read, rows: read.rows.map((row) => ({ ...row, correct: false, expected, ...(compared ? { compared: { grader: "fast-model", pair: answersPair(row.answer, against?.(row) ?? correctedText(expected)), ...compared } } : {}) })) });

test("graded inputs with no agree_on: one field, the whole answer, judged against the agent's answer with the grade's expected keys written over it: equal, else the fast model's verdict on the draft and that answer", async () => {
  // A correction: the agent said riskTier low, the grade expects medium (one equal to the agent's answer contradicts
  // itself, the next test's).
  const expected = { mcc: "7832", riskTier: "medium" };
  const known = JSON.stringify(expected);
  // Right on mcc, another decision on riskTier: the whole answer differs from the expected one.
  const partly = { ...DRAFT, riskTier: "high" };
  const held = await decide({}, gradedRead(readOf(() => draftSays(partly)), expected, { same: false, differs_on: "riskTier" }));
  assert.equal(held.record.decided, "hold", held.record.reason);
  assert.deepEqual(Object.keys(held.stored.check.fields), ["answer"], "no field is made from a grade's keys");
  assert.deepEqual(held.stored.check.fields.answer.by, { grade: { n: 5, workflow_right: 0, agent_right: 0, pass: false } });
  assert.deepEqual(held.stored.check.disagreements[0].fields, ["answer"]);
  assert.deepEqual(held.stored.check.disagreements[0].expected, [{ field: "answer", known: "grade", value: known }], "the known answer the draft missed, whole, for the recompile");
  assert.equal(held.stored.check.grader, "fast-model");

  const same = await decide({}, gradedRead(readOf(() => draftSays(DRAFT)), expected, { same: true }));
  assert.equal(same.record.decided, "promote", `the same decisions as the expected answer by the fast model's verdict: ${same.record.reason}`);
  assert.deepEqual(same.stored.check.fields.answer.by, { grade: { n: 5, workflow_right: 5, agent_right: 0, pass: true } });

  const equal = await decide({}, gradedRead(readOf(() => draftSays({ ...AGENT, ...expected })), expected));
  assert.equal(equal.record.decided, "promote", `equal to the corrected answer, no model asked: ${equal.record.reason}`);

  // The expected keys alone leave out the rest of the agent's answer: another answer, with no verdict saying otherwise.
  const bare = await decide({}, gradedRead(readOf(() => draftSays(expected)), expected));
  assert.equal(bare.record.decided, "hold", bare.record.reason);

  // A verdict on the draft and the expected answer alone, or the agent's as written, says nothing of the corrected one:
  // the pair differs, as with none.
  for (const against of [() => known, (row) => row.agent]) {
    const other = await decide({}, gradedRead(readOf(() => draftSays(DRAFT)), expected, { same: true }, against));
    assert.equal(other.record.decided, "hold", other.record.reason);
    assert.equal(other.stored.check.fields.answer.workflow_right, 0);
  }
});

/** A check's read of 5 inputs graded as in Greptile's case: the agent said `agent`, its grade expects `expected` and
 *  says it was wrong, and the draft said `draft`, with the fast model's verdict `compared` on the draft and `against`. */
const partialRead = (agent, expected, draft, compared, against) => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ of: `r-${i}`, input: `{"question":"Question ${i}"}`, agent, outcome: "answered", answer: draft, correct: false, expected, ...(compared ? { compared: { grader: "fast-model", pair: answersPair(draft, against), ...compared } } : {}) }));
  return { rows, cost: 0, outcomes: { answered: 5, handed_back: 0, skipped_write: 0, failed: 0 }, unstarted: 0 };
};

test("a partial grade (the agent said 42 with a note, the grade expects 41): a draft of 41 with the note is right and serves; one that drops the note differs unless the fast model says the same decision; one that keeps 42 is wrong", async () => {
  const agentSaid = '{"answer":42,"note":"checked"}';
  const expected = { answer: 41 };
  const corrected = '{"answer":41,"note":"checked"}';
  const right = await decide({}, partialRead(agentSaid, expected, corrected));
  assert.equal(right.record.decided, "promote", right.record.reason);
  assert.deepEqual(right.stored.check.fields.answer.by, { grade: { n: 5, workflow_right: 5, agent_right: 0, pass: true } });

  const dropped = await decide({}, partialRead(agentSaid, expected, '{"answer":41}'));
  assert.equal(dropped.record.decided, "hold", dropped.record.reason);
  assert.deepEqual(dropped.stored.check.disagreements[0].expected, [{ field: "answer", known: "grade", value: JSON.stringify(expected) }], "the recompile is shown the grade's own expected answer, the part the owner gave");
  const sameDecision = await decide({}, partialRead(agentSaid, expected, '{"answer":41}', { same: true }, corrected));
  assert.equal(sameDecision.record.decided, "promote", `the fast model's verdict on the draft and the corrected answer: ${sameDecision.record.reason}`);

  const kept = await decide({}, partialRead(agentSaid, expected, agentSaid));
  assert.equal(kept.record.decided, "hold", kept.record.reason);
  assert.equal(kept.stored.check.fields.answer.workflow_right, 0);
  assert.equal(knownAnswerText(agentSaid, expected), corrected, "the agent's answer with the grade's keys written over it");
});

test("the known answer falls back to the grade's expected answer whole when it or the agent's answer is no JSON object; own keys only, `__proto__` never copied", async () => {
  const expected = { answer: 41 };
  for (const agentSaid of ["The answer is 42.", "[42]", "42", "null", null]) assert.equal(knownAnswerText(agentSaid, expected), '{"answer":41}', `agent ${agentSaid}`);
  assert.equal(knownAnswerText('{"answer":42}', "41"), '"41"', "an expected answer that is text is the known answer whole");
  assert.equal(knownAnswerText('{"answer":42}', [41]), "[41]");
  assert.equal(knownAnswerText(agentSays({ answer: 42, note: "checked" }), expected), '{"answer":41,"note":"checked"}', "the agent's json fence is its answer");
  assert.equal(knownAnswerText('{"__proto__":{"polluted":true},"answer":42}', JSON.parse('{"__proto__":{"also":true},"answer":41}')), '{"answer":41}');
  assert.equal({}.polluted ?? {}.also, undefined, "no prototype changed");

  // Judged whole: an agent whose answer is prose, and a draft that says the expected answer alone.
  const prose = await decide({}, partialRead("The answer is 42.", expected, '{"answer":41}'));
  assert.equal(prose.record.decided, "promote", prose.record.reason);
});

test("a purged run leaves no key or value of its grade's expected answer anywhere in the promotion record: its fields, reasons and disagreements", async () => {
  const expected = { "acct-7781-holder": "Pat Example 5532" };
  const held = await decide({}, gradedRead(readOf(() => draftSays(DRAFT)), expected, { same: false, differs_on: "acct-7781-holder: Pat Example 5532" }));
  assert.equal(held.record.decided, "hold", held.record.reason);
  assert.ok(JSON.stringify(await promotionsOf(held.settings, "a")).includes("Pat Example 5532"), "kept for the recompile while its run is");
  for (let i = 0; i < 5; i++) await forgetRunCopies(held.settings, "a", `r-${i}`);
  const kept = JSON.stringify(await promotionsOf(held.settings, "a"));
  for (const word of ["acct-7781-holder", "Pat Example 5532", "7781", "5532"]) assert.ok(!kept.includes(word), `${word} survived the purge: ${kept}`);
  assert.deepEqual((await promotionsOf(held.settings, "a")).at(-1).check.disagreements[0], { run: "r-0", input: "", agent: null, draft: "", fields: ["answer"], expected: [{ field: "answer", known: "grade", value: "" }] }, "a purge blanks the known answer's value, keeping its field and source");
});

test("a grade with no expected answer: graded wrong, a draft that repeats the agent's answer is wrong on it, and shown as marked wrong with no right answer; graded right, the agent's answer is known as with no grade", async () => {
  const read = readOf(() => agentSays(AGENT));
  const rows = read.rows.map((row) => ({ ...row, correct: false }));
  const held = await decide({}, { ...read, rows });
  assert.equal(held.record.decided, "hold", held.record.reason);
  assert.deepEqual(held.stored.check.fields.answer.by, { grade: { n: 5, workflow_right: 0, agent_right: 0, pass: false } });
  assert.deepEqual(held.stored.check.disagreements.map((one) => one.expected), Array.from({ length: 5 }, () => [{ field: "answer", known: "unknown" }]));
  const confirmed = await decide({}, { ...read, rows: read.rows.map((row) => ({ ...row, correct: true })) });
  assert.deepEqual([confirmed.record.decided, confirmed.stored.check.fields.answer.by], ["promote", { agent: { n: 5, workflow_right: 5, agent_right: 5, pass: true } }]);
});

test("19 inputs graded wrong with no correction, where the draft answers anything else, and 1 it matches: held (main held it at 1 of 20), and the 19 are shown for the recompile", async () => {
  const read = readOf((i) => (i < 19 ? "" : agentSays(AGENT)), 20);
  const rows = read.rows.map((row, i) => (i < 19 ? { ...row, correct: false } : row));
  const held = await decide({ compile_after: 20 }, { ...read, rows });
  assert.equal(held.record.decided, "hold", held.record.reason);
  const { answer } = held.stored.check.fields;
  assert.deepEqual([held.stored.check.agreed, held.stored.check.alone, answer.n, answer.unjudged, answer.pass], [1, 20, 1, 19, false]);
  assert.match(held.record.reason, /judged on 1 of 20 \(5\.0%, the bar 70\.0%\)/);
  const shown = held.stored.check.disagreements;
  assert.deepEqual(shown.map((one) => one.run), Array.from({ length: 19 }, (_, i) => `r-${i}`), "every input with no known answer, none left out");
  assert.ok(shown.every((one) => JSON.stringify(one.fields) === '["answer"]' && JSON.stringify(one.expected) === '[{"field":"answer","known":"unknown"}]'), JSON.stringify(shown[0]));
});

test("a decided check's record (its fields, its disagreements' fields and known answers) and a connected agent's turns meet the promotions read's schema", async () => {
  const agent = JSON.stringify({ answer: 42, note: "six sevens" });
  const draft = JSON.stringify({ answer: 7, note: "six sevens" });
  const rows = Array.from({ length: 5 }, (_, i) => ({ of: `r-${i}`, input: `Question ${i}`, agent, outcome: "answered", answer: draft, correct: false, ...(i < 4 ? { expected: { answer: 41, note: "six sevens" } } : {}) }));
  const { stored } = await decide({}, { rows, cost: 0, outcomes: { answered: 5, handed_back: 0, skipped_write: 0, failed: 0 }, unstarted: 0 });
  const schema = doc.paths["/agents/{agent_id}/learning/promotions"].get.responses["200"].content["application/json"].schema.properties.promotions.items;
  assert.deepEqual(stored.check.disagreements.map((one) => one.expected.map((known) => known.known)), [["grade"], ["grade"], ["grade"], ["grade"], ["unknown"]], JSON.stringify(stored.check));
  assert.deepEqual(schemaProblems(doc, schema, stored), []);
  const turns = { n: 5, agreed: 0, alone: 5, agent_agreed: 0, fields: { answer: { grade: { n: 4, workflow_right: 0, agent_right: 0 }, unjudged: 1 } }, of: ["r-0"], outcomes: { answered: 5, handed_back: 0, skipped_write: 0, failed: 0 }, disagreements: stored.check.disagreements };
  assert.deepEqual(schemaProblems(doc, schema, { ...stored, decided: "replaying", check: { ...stored.check, turns } }), []);
  assert.equal(stored.check.agent_agreed, 0, "the agent right on every field at once: on none (graded wrong on each)");
});

test("a decided replay's score: the agent's accuracy on the same inputs and known answers as the workflow's (agent_agreed), 1 on a record kept before it was counted", async () => {
  const settings = settingsOf();
  const check = { compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 5, agreed: 4, alone: 4, agent_agreed: 2, of: [], outcomes: { answered: 4, handed_back: 1, failed: 0, skipped_write: 0 } };
  await recordPromotion(settings, "a", { workflow: "classify", digest: "d1", at: new Date().toISOString(), decided: "promote", reason: "promoted", replay_id: "p1", check }, () => true);
  const view = await replayView({ store: { settings }, agentId: "a" }, "classify", "d1", "p1");
  assert.deepEqual(view.score, { n: 5, agree: 4, agent_acc: 0.6, wf_acc: 1, delta: 0.4, handed_back: 1 }, "the agent wrong on 2 of the 4 it answered alone: 3 of 5");
  const { agent_agreed: _, ...before } = check;
  await recordPromotion(settings, "a", { workflow: "classify", digest: "d2", at: new Date().toISOString(), decided: "promote", reason: "promoted", replay_id: "p2", check: before }, () => true);
  assert.equal((await replayView({ store: { settings }, agentId: "a" }, "classify", "d2", "p2")).score.agent_acc, 1);
});

test("check on dotted paths: verdict.decision agrees though the rationale differs; a draft that differs on it disagrees, counted per input", async () => {
  const said = { checked_on: "2026-11-18", risk_appetite: "medium", verdict: { decision: "approve", rationale: "Registered, no sanctions hit." }, report_markdown: "# Example Cinema\n..." };
  const draft = (decision) => ({ checked_on: "2026-11-18", risk_appetite: "medium", verdict: { decision, rationale: "Clean registry record." }, report_markdown: "# Report\n..." });
  const read = readOf((i) => draftSays(draft(i < 2 ? "decline" : "approve")), 5, said);
  const held = await decide({ agree_on: ["verdict.decision"] }, read);
  assert.equal(held.record.decided, "hold");
  assert.equal(held.stored.check.agreed, 3);
  assert.deepEqual(held.stored.check.disagreements.map((one) => [one.run, one.fields]), [["r-0", ["verdict.decision"]], ["r-1", ["verdict.decision"]]]);
  assert.deepEqual([held.stored.check.fields["verdict.decision"].workflow_right, held.stored.check.fields["verdict.decision"].pass], [3, false]);
  assert.ok(!held.record.reason.includes(NEVER_WORD_FOR_WORD), "compared on agree_on: no hint");
  const promoted = await decide({ agree_on: ["verdict.decision"] }, readOf(() => draftSays(draft("approve")), 5, said));
  assert.equal(promoted.record.decided, "promote", promoted.record.reason);
});

test("a path missing on either side, through a non-object, or an answer that is no JSON object, disagrees under agree_on", () => {
  const on = ["mcc", "riskTier"];
  assert.equal(sameAnswer(agentSays(AGENT), draftSays(DRAFT), on), true);
  assert.equal(sameAnswer(agentSays(AGENT), draftSays({ ...DRAFT, mcc: "7841" }), on), false, "a declared value differs");
  const { riskTier: _, ...noTier } = DRAFT;
  assert.equal(sameAnswer(agentSays(AGENT), draftSays(noTier), on), false, "missing on the draft's side");
  assert.equal(sameAnswer(agentSays(noTier), draftSays(DRAFT), on), false, "missing on the agent's side");
  assert.equal(sameAnswer(agentSays(noTier), draftSays(noTier), on), false, "missing on both: never agreement");
  assert.equal(sameAnswer(agentSays(AGENT), draftSays([AGENT]), on), false, "an array is no object");
  assert.equal(sameAnswer("mcc 7832, low risk", "mcc 7832, low risk", on), false, "text is no object, though the same");
  assert.equal(sameAnswer(agentSays(AGENT), null, on), false);
  assert.equal(sameAnswer(agentSays({ ...AGENT, tags: ["a", "b"] }), draftSays({ ...DRAFT, tags: ["b", "a"] }), ["tags"]), false, "arrays compare in order");
  assert.equal(sameAnswer(agentSays({ ...AGENT, site: { live: true, host: "example.com" } }), draftSays({ ...DRAFT, site: { host: "example.com", live: true } }), ["site"]), true, "an object's keys in any order");
  assert.equal(sameAnswer("same words", " same words "), true, "without on: as before, trimmed text");
  assert.equal(sameAnswer(agentSays(AGENT), draftSays(DRAFT)), false, "without on: the whole value");

  // Dotted paths: each segment a key of an object; one that does not resolve in both answers disagrees.
  const step = (action, why = "fits the profile") => ({ next_step: { action, reason: `${action}: ${why}` } });
  const path = ["next_step.action"];
  assert.equal(sameAnswer(agentSays(step("book_call")), draftSays(step("book_call", "a strong fit on size and region")), path), true, "the nested value agrees, the sibling reason does not count");
  assert.equal(sameAnswer(agentSays(step("book_call")), draftSays(step("nurture")), path), false);
  assert.equal(sameAnswer(agentSays(step("book_call")), draftSays({ next_step: { reason: "no action" } }), path), false, "the leaf missing on one side");
  assert.equal(sameAnswer(agentSays({ next_step: {} }), draftSays({ next_step: {} }), path), false, "missing on both: never agreement");
  assert.equal(sameAnswer(agentSays({ next_step: "book_call" }), draftSays({ next_step: "book_call" }), path), false, "a segment through a string does not resolve");
  assert.equal(sameAnswer(agentSays({ next_step: ["book_call"] }), draftSays({ next_step: ["book_call"] }), ["next_step.0"]), false, "a segment into an array does not resolve");
  assert.equal(sameAnswer(agentSays({ next_step: null }), draftSays({ next_step: null }), path), false, "a segment through null does not resolve");
  assert.equal(sameAnswer(agentSays({ a: { b: { c: null } } }), draftSays({ a: { b: { c: null } } }), ["a.b.c"]), true, "a present null is a value: equal");
  assert.equal(sameAnswer(agentSays({ a: { b: { c: 1 } } }), draftSays({ a: { b: { c: 1, d: 2 } } }), ["a.b"]), false, "a path to an object compares it whole");
  assert.equal(sameAnswer(agentSays({ "a.b": 1 }), draftSays({ "a.b": 1 }), ["a.b"]), false, "a dot always splits: a key holding a dot is never named");
  assert.equal(sameAnswer(agentSays({ constructor: 1 }), draftSays({}), ["constructor"]), false, "only own keys resolve");
  assert.equal(sameAnswer(agentSays({}), draftSays({}), ["toString"]), false, "an inherited key never resolves");
});

const LIST_WORDS = "learning.agree_on is a list of 1 to 16 distinct dotted paths into the answer's JSON object (e.g. verdict.decision)";
test("agree_on's shape: 1 to 16 distinct dotted paths, each up to 128 characters and 8 non-empty segments; kept in the owner's order", () => {
  for (const agree_on of [[], "mcc", ["mcc", "mcc"], [7], Array.from({ length: 17 }, (_, i) => `k${i}`), null, { mcc: true }]) {
    assert.equal(learningSettingIssue({ agree_on }), LIST_WORDS, JSON.stringify(agree_on));
  }
  for (const [path, why] of [
    ["", "an empty segment"],
    ["verdict..decision", "an empty segment"],
    [".verdict", "an empty segment"],
    ["verdict.", "an empty segment"],
    ["a.b.c.d.e.f.g.h.i", "more than 8 segments"],
    ["x".repeat(129), "over 128 characters"],
    ["__proto__", "a reserved segment (__proto__)"],
    ["verdict.__proto__", "a reserved segment (__proto__)"],
  ]) {
    assert.equal(learningSettingIssue({ agree_on: ["mcc", path] }), `learning.agree_on[1] is not a dotted path into the answer's JSON object (e.g. verdict.decision): ${why}`, JSON.stringify(path));
  }
  assert.equal(learningSettingIssue({ agree_on: ["riskTier", "mcc"] }), undefined);
  assert.equal(learningSettingIssue({ agree_on: ["verdict.constructor", "prototype.decision"] }), undefined, "an answer's own keys named constructor or prototype are fields like any other");
  assert.deepEqual(learningSettingForBody({ learning: { agree_on: ["prototype.decision"] } }), { agree_on: ["prototype.decision"] });
  assert.equal(learningSettingForBody({ learning: { agree_on: ["__proto__.decision"] } }), undefined, "refused on a read as on a write: no definition keeps it");
  assert.equal(learningSettingIssue({ agree_on: ["verdict.decision", "a.b.c.d.e.f.g.h"] }), undefined, "8 segments");
  assert.equal(learningSettingIssue({ agree_on: Array.from({ length: 16 }, (_, i) => `k${i}`.padEnd(128, "x")) }), undefined, "16 paths of 128 characters");
  assert.deepEqual(Object.entries(learningSettingOf({ agree_on: ["verdict.decision", "mcc"], audit_every: 5, compile_after: 4 })), [["compile_after", 4], ["agree_on", ["verdict.decision", "mcc"]], ["audit_every", 5]]);
});

test("the check compares on the definition's agree_on, else the whole answer: no field is picked from an output schema", () => {
  const schema = { type: "object", properties: { risk_appetite: { enum: ["low", "medium", "high"] }, riskTier: { enum: ["low", "medium", "high"] }, siteLive: { type: "boolean" }, kind: { const: "merchant" } } };
  assert.deepEqual(loopOf({ compile_after: 3, agree_on: ["verdict.decision"] }), { compile_after: 3, agree_min: 0.8, alone_min: 0.7, agree_on: ["verdict.decision"] });
  assert.deepEqual(loopOf({ compile_after: 3 }, schema), { compile_after: 3, agree_min: 0.8, alone_min: 0.7 }, "a schema's enum, const and boolean fields stand in for nothing");
  assert.deepEqual(loopOf(true, schema), { compile_after: 20, agree_min: 0.8, alone_min: 0.7 });
});

test("agree_on round-trips through the definition PUT; a bad one is a 422 naming the field", async (t) => {
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("mcc", { learning: true }))).status, 201);
  const put = await api("PUT", "/agents/mcc/definition", { definition: { name: "mcc", instructions: "Classify the merchant.", skills: [], tools: [], learning: { agree_on: ["verdict.decision", "mcc"], compile_after: 5 } } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(Object.entries(put.body.definition.learning), [["compile_after", 5], ["agree_on", ["verdict.decision", "mcc"]]]);
  assert.deepEqual((await api("GET", "/agents/mcc")).body.definition.learning, { compile_after: 5, agree_on: ["verdict.decision", "mcc"] });
  const wrong = await api("PUT", "/agents/mcc/definition", { definition: { name: "mcc", instructions: "Classify the merchant.", skills: [], tools: [], learning: { agree_on: ["verdict..decision"] } } });
  assert.equal(wrong.status, 422, JSON.stringify(wrong.body));
  assert.deepEqual(wrong.body.error.fields.map((f) => [f.field, f.reason, f.message]), [["definition.learning", "wrong_type", "definition.learning.agree_on[0] is not a dotted path into the answer's JSON object (e.g. verdict.decision): an empty segment, e.g. true"]], "the 422's words name agree_on, then the field's example");
});

test("a record written with agree_on reads back with it (the promotions read keeps what the check compared)", async () => {
  const settings = settingsOf();
  const check = { compile_after: 5, agree_min: 0.8, alone_min: 0.7, agree_on: ["verdict.decision"], attempt: 1, n: 1, agreed: 1, alone: 1, of: ["r-0"] };
  await recordPromotion(settings, "a", { workflow: "classify", digest: "d1", at: new Date().toISOString(), decided: "promote", reason: "promoted", check }, () => true);
  assert.deepEqual((await promotionsOf(settings, "a")).at(-1).check, check);
});

test("a draft that repeats the answer a grade marked wrong is never right on that input, whatever the fast model says: byte for byte, or the same JSON in another dress", async () => {
  const agentSaid = '{"decision":"approve","amount":100}';
  const expected = { amount: 120 };
  const corrected = knownAnswerText(agentSaid, expected);
  const repeat = await decide({}, partialRead(agentSaid, expected, agentSaid, { same: true }, corrected));
  assert.equal(repeat.record.decided, "hold", repeat.record.reason);
  assert.deepEqual([repeat.stored.check.fields.answer.workflow_right, repeat.stored.check.agreed], [0, 0]);
  assert.deepEqual(repeat.stored.check.disagreements[0].expected, [{ field: "answer", known: "grade", value: JSON.stringify(expected) }]);
  const dressed = '```json\n{"amount": 100, "decision": "approve"}\n```';
  const again = await decide({}, partialRead(agentSaid, expected, dressed, { same: true }, corrected));
  assert.equal(again.record.decided, "hold", again.record.reason);
  assert.equal(again.stored.check.fields.answer.workflow_right, 0);
});

test("an edit that leaves learning out carries the saved agree_on forward, a `__proto__` segment included; a write naming one is still refused", async (t) => {
  const { api, store } = await serve(t);
  const learning = { agree_on: ["__proto__.decision", "mcc"] };
  await store.agents.create({ id: "kept", name: "kept" }, { id: "rev-kept", kind: "agentic", body: { instructions: "Classify the merchant.", skills: {}, tools: [], learning }, skills: {} });
  assert.deepEqual((await api("GET", "/agents/kept")).body.definition.learning, learning);
  const put = await api("PUT", "/agents/kept/definition", { definition: { name: "kept", instructions: "Classify the merchant again.", skills: [], tools: [] } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual((await api("GET", "/agents/kept")).body.definition.learning, learning, "carried, not dropped");
  const wrote = await api("PUT", "/agents/kept/definition", { definition: { name: "kept", instructions: "Classify the merchant.", skills: [], tools: [], learning } });
  assert.equal(wrote.status, 422, JSON.stringify(wrote.body));
});

test("a grade that contradicts itself (marked wrong, yet its expected answer written over the agent's is the agent's own) is neither known right nor known wrong: the input is unjudged, whatever the draft says", async () => {
  for (const [expected, draft] of [[{ mcc: AGENT.mcc }, agentSays(AGENT)], [{ mcc: AGENT.mcc }, draftSays({ ...AGENT, mcc: "5999" })], [{ mcc: "7832", riskTier: "low" }, draftSays(AGENT)]]) {
    const decided = await decide({}, gradedRead(readOf(() => draft), expected));
    assert.equal(decided.record.decided, "hold", decided.record.reason);
    const { answer } = decided.stored.check.fields;
    assert.deepEqual([answer.n, answer.workflow_right, answer.unjudged], [0, 0, 5], decided.record.reason);
    assert.deepEqual(decided.stored.check.disagreements[0].expected, [{ field: "answer", known: "contradicts" }], "its own word, never a grade with no right answer");
  }
});
