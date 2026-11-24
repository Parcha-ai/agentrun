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
const { answersPair, forgetRunCopies, promotionsOf, recordPromotion, sameAnswer } = await import("../dist/learn/promote.js");
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
  assert.deepEqual(Object.entries(on.stored.check.fields).map(([name, one]) => [name, one.workflow_right, one.n, one.pass]), [["mcc", 5, 5, true], ["riskTier", 5, 5, true]], "one verdict per field");

  const whole = await decide({}, readOf(() => draftSays(DRAFT)));
  assert.equal(whole.record.decided, "hold", "today's whole-answer rule stands with no agree_on");
  assert.equal(whole.stored.check.agreed, 0);
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

test("graded inputs on the whole answer: each key of a grade's expected answer is a field judged against it, and the whole answer still says what the agent said (outside a corrected key, equal there; else the fast model's verdict)", async () => {
  const agent = JSON.stringify({ answer: 42, note: "six sevens" });
  const graded = (draft, compared) => Array.from({ length: 5 }, (_, i) => ({ of: `r-${i}`, input: `Question ${i}`, agent, outcome: "answered", answer: draft, expected: { answer: 41 }, compared: { grader: "fast-model", pair: answersPair(draft, agent), ...compared } }));
  const read = (rows) => ({ rows, cost: 0, outcomes: { answered: rows.length, handed_back: 0, skipped_write: 0, failed: 0 }, unstarted: 0 });
  const right = JSON.stringify({ answer: 41, note: "six sevens" });
  const decided = await decide({}, read(graded(right, { same: false, differs_on: "the number" })));
  assert.equal(decided.record.decided, "promote", decided.record.reason);
  assert.deepEqual(Object.fromEntries(Object.entries(decided.stored.check.fields).map(([name, one]) => [name, one.by])), {
    answer: { agent: { n: 5, workflow_right: 5, agent_right: 5, pass: true } },
    "answer.answer": { grade: { n: 5, workflow_right: 5, agent_right: 0, pass: true } },
  }, "the corrected key against the grade; the rest of the answer the agent's, equal outside it");
  assert.equal(decided.stored.check.grader, "fast-model", "the grader's verdict is read on graded inputs too");
  const elsewhere = JSON.stringify({ answer: 41, note: "a guess" });
  const held = await decide({}, read(graded(elsewhere, { same: false, differs_on: "the number and the note" })));
  assert.equal(held.record.decided, "hold", "right on the corrected key, another note: the rest is not the agent's");
  assert.deepEqual([held.stored.check.fields.answer.workflow_right, held.stored.check.fields["answer.answer"].workflow_right], [0, 5]);
  const wrong = JSON.stringify({ answer: 7, note: "six sevens" });
  const missed = await decide({}, read(graded(wrong, { same: false, differs_on: "the number" })));
  assert.equal(missed.record.decided, "hold");
  assert.deepEqual(missed.stored.check.disagreements[0].fields, ["answer.answer"]);
  assert.deepEqual(missed.stored.check.disagreements[0].expected, [{ field: "answer.answer", known: "grade", value: "41" }], "the known answer the draft missed, and where it came from, for the recompile");
  await forgetRunCopies(missed.settings, "a", "r-0");
  assert.deepEqual((await promotionsOf(missed.settings, "a")).at(-1).check.disagreements[0], { run: "r-0", input: "", agent: null, draft: "", fields: ["answer.answer"], expected: [{ field: "answer.answer", known: "grade", value: "" }] }, "a purge blanks the known answer's value, keeping its field and source");
});

test("a partial grade on the whole answer: a draft right on the graded key and wrong on every other decision is held; the fast model's verdict decides the rest", async () => {
  const graded = (said, compared) => {
    const read = readOf(() => draftSays(said));
    return { ...read, rows: read.rows.map((row) => ({ ...row, expected: { mcc: "7832" }, compared: { grader: "fast-model", pair: answersPair(row.answer, row.agent), ...compared } })) };
  };
  const held = await decide({}, graded({ ...DRAFT, riskTier: "high" }, { same: false, differs_on: "riskTier" }));
  assert.equal(held.record.decided, "hold", held.record.reason);
  assert.equal(held.stored.check.agreed, 0);
  assert.deepEqual(Object.entries(held.stored.check.fields).map(([name, one]) => [name, one.known, one.workflow_right, one.n, one.pass]), [["answer", "agent", 0, 5, false], ["answer.mcc", "grade", 5, 5, true]]);
  const promoted = await decide({}, graded(DRAFT, { same: true }));
  assert.equal(promoted.record.decided, "promote", `the same decisions by the fast model's verdict: ${promoted.record.reason}`);
});

test("a grade with no expected answer: graded wrong, a draft that repeats the agent's answer is wrong on it; graded right, the agent's answer is known as with no grade", async () => {
  const read = readOf(() => agentSays(AGENT));
  const rows = read.rows.map((row) => ({ ...row, correct: false }));
  const held = await decide({}, { ...read, rows });
  assert.equal(held.record.decided, "hold", held.record.reason);
  assert.deepEqual(held.stored.check.fields.answer.by, { grade: { n: 5, workflow_right: 0, agent_right: 0, pass: false } });
  const confirmed = await decide({}, { ...read, rows: read.rows.map((row) => ({ ...row, correct: true })) });
  assert.deepEqual([confirmed.record.decided, confirmed.stored.check.fields.answer.by], ["promote", { agent: { n: 5, workflow_right: 5, agent_right: 5, pass: true } }]);
});

test("19 inputs graded wrong with no correction, where the draft answers anything else, and 1 it matches: held (main held it at 1 of 20)", async () => {
  const read = readOf((i) => (i < 19 ? "" : agentSays(AGENT)), 20);
  const rows = read.rows.map((row, i) => (i < 19 ? { ...row, correct: false } : row));
  const held = await decide({ compile_after: 20 }, { ...read, rows });
  assert.equal(held.record.decided, "hold", held.record.reason);
  const { answer } = held.stored.check.fields;
  assert.deepEqual([held.stored.check.agreed, held.stored.check.alone, answer.n, answer.unjudged, answer.pass], [1, 20, 1, 19, false]);
  assert.match(held.record.reason, /judged on 1 of 20 \(5\.0%, the bar 70\.0%\)/);
});

test("a decided check's record (its fields, its disagreements' fields and known answers) and a connected agent's turns meet the promotions read's schema", async () => {
  const agent = JSON.stringify({ answer: 42, note: "six sevens" });
  const draft = JSON.stringify({ answer: 7, note: "six sevens" });
  const rows = Array.from({ length: 5 }, (_, i) => ({ of: `r-${i}`, input: `Question ${i}`, agent, outcome: "answered", answer: draft, expected: { answer: 41 } }));
  const { stored } = await decide({}, { rows, cost: 0, outcomes: { answered: 5, handed_back: 0, skipped_write: 0, failed: 0 }, unstarted: 0 });
  const schema = doc.paths["/agents/{agent_id}/learning/promotions"].get.responses["200"].content["application/json"].schema.properties.promotions.items;
  assert.ok(stored.check.fields && stored.check.disagreements[0].expected, JSON.stringify(stored.check));
  assert.deepEqual(schemaProblems(doc, schema, stored), []);
  const turns = { n: 5, agreed: 0, alone: 5, agent_agreed: 0, fields: { answer: { agent: { n: 4, workflow_right: 4, agent_right: 4 }, unjudged: 1 }, "answer.answer": { grade: { n: 5, workflow_right: 0, agent_right: 0 } } }, of: ["r-0"], outcomes: { answered: 5, handed_back: 0, skipped_write: 0, failed: 0 }, disagreements: stored.check.disagreements };
  assert.deepEqual(schemaProblems(doc, schema, { ...stored, decided: "replaying", check: { ...stored.check, turns } }), []);
  assert.equal(stored.check.agent_agreed, 0, "the agent right on every field at once: on none (the grade corrected it everywhere)");
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
  for (const agree_on of [["prototype.decision"], ["__proto__.decision"]]) {
    assert.deepEqual(learningSettingForBody({ learning: { agree_on } }), { agree_on }, `a saved definition keeps its setting on read: ${agree_on}`);
  }
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
