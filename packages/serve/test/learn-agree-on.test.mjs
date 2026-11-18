// learning.agree_on: the check (runner/promotion.ts decideCheck) and the audit (runner/audit.ts) compare two answers on
// the fields that say the decision, never on free text two real runs never repeat. A definition's `learning.agree_on`
// names the answer's top-level JSON keys; absent, the agent's output_schema's top-level enum, const and boolean fields
// stand in; neither, the whole answer, as before, and a check that agreed on none says to name the fields.
// Synthetic data only: an invented merchant on example.com.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { agent, serve } from "./support.mjs";

const { decideCheck } = await import("../dist/runner/promotion.js");
const { promotionsOf, recordPromotion, sameAnswer } = await import("../dist/learn/promote.js");
const { agreeOnOf, learningSettingIssue, learningSettingOf, loopOf } = await import("../dist/learning-setting.js");
const { secretsShown } = await import("../dist/learning.js");

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

/** A check's read of `rows` answered alone, each the agent's AGENT-shaped answer and the draft's `draft(i)`. */
const readOf = (draft, n = 5) => {
  const rows = Array.from({ length: n }, (_, i) => ({ of: `r-${i}`, input: `{"merchant":"Example Cinema ${i}","site":"https://example.com/${i}"}`, agent: agentSays(AGENT), outcome: "answered", answer: draft(i) }));
  return { rows, cost: 0, outcomes: { answered: n, handed_back: 0, skipped_write: 0, failed: 0 }, unstarted: 0 };
};

async function decide(bar, read) {
  const settings = settingsOf();
  const logs = [];
  const deps = { store: { settings }, agentId: "a", runId: "now", revisionId: "rev", launch: {}, context: ctx, log: (line) => logs.push(line), shown: async () => secretsShown([]) };
  const decided = await decideCheck(deps, "classify", "d1", { compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1, ...bar }, read, () => true, {});
  return { record: decided.record, stored: (await promotionsOf(settings, "a")).at(-1), logs };
}

test("check on live-shaped answers: same mcc and riskTier, other rationale, evidence and confidence: agreed on agree_on, promoted; on the whole answer, held", async () => {
  const on = await decide({ agree_on: ["mcc", "riskTier"], agree_from: "definition" }, readOf(() => draftSays(DRAFT)));
  assert.equal(on.record.decided, "promote", on.record.reason);
  assert.deepEqual([on.stored.check.agreed, on.stored.check.alone, on.stored.check.agree_on, on.stored.check.agree_from], [5, 5, ["mcc", "riskTier"], "definition"], "the record says what it compared");
  assert.match(on.record.reason, /5 of those said what the agent said on mcc and riskTier \(100\.0%, the bar 80\.0%\): promoted$/);

  const whole = await decide({}, readOf(() => draftSays(DRAFT)));
  assert.equal(whole.record.decided, "hold", "today's whole-answer rule stands with no agree_on");
  assert.equal(whole.stored.check.agreed, 0);
  assert.equal(whole.stored.check.agree_on, undefined);
  assert.match(whole.record.reason, /0 of those said what the agent said \(0\.0%, the bar 80\.0%\): held; its answers never matched the agent's word for word; name the fields that carry the decision \(learning\.agree_on\); the agent's next run recompiles/);
});

test("on agree_on, a draft that differs on a declared field disagrees; agreement is counted per input against the bar", async () => {
  const read = readOf((i) => draftSays(i < 2 ? { ...DRAFT, riskTier: "high" } : DRAFT));
  const held = await decide({ agree_on: ["mcc", "riskTier"], agree_from: "definition" }, read);
  assert.equal(held.record.decided, "hold");
  assert.equal(held.stored.check.agreed, 3);
  assert.deepEqual(held.stored.check.disagreements.map((one) => one.run), ["r-0", "r-1"]);
  assert.doesNotMatch(held.record.reason, /word for word/, "it agreed on some: no hint");
});

test("a key missing on either side, or an answer that is no JSON object, disagrees under agree_on", () => {
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
});

test("agree_on's shape: 1 to 16 distinct strings of 1 to 64 characters; kept in the owner's order", () => {
  for (const agree_on of [[], "mcc", ["mcc", "mcc"], [""], ["x".repeat(65)], [7], Array.from({ length: 17 }, (_, i) => `k${i}`), null, { mcc: true }]) {
    assert.equal(learningSettingIssue({ agree_on }), "learning.agree_on is a list of 1 to 16 distinct top-level answer keys, each 1 to 64 characters", JSON.stringify(agree_on));
  }
  assert.equal(learningSettingIssue({ agree_on: ["riskTier", "mcc"] }), undefined);
  assert.equal(learningSettingIssue({ agree_on: Array.from({ length: 16 }, (_, i) => `k${i}`.padEnd(64, "x")) }), undefined, "16 keys of 64 characters");
  assert.deepEqual(Object.entries(learningSettingOf({ agree_on: ["riskTier", "mcc"], audit_every: 5, compile_after: 4 })), [["compile_after", 4], ["agree_on", ["riskTier", "mcc"]], ["audit_every", 5]]);
});

test("agree_on stands in order: the definition's, else the output schema's top-level enum, const and boolean fields, else none", () => {
  const schema = { type: "object", properties: { mcc: { type: "string" }, riskTier: { enum: ["low", "medium", "high"] }, confidence: { type: "number" }, flags: { type: "array", items: { type: "string" } }, siteLive: { type: "boolean" }, kind: { const: "merchant" }, rationale: { type: "string" } } };
  assert.deepEqual(agreeOnOf({ agree_on: ["mcc"] }, schema), { agree_on: ["mcc"], agree_from: "definition" });
  assert.deepEqual(agreeOnOf(true, schema), { agree_on: ["riskTier", "siteLive", "kind"], agree_from: "schema" }, "never numbers, arrays or free text");
  assert.equal(agreeOnOf(true, { type: "object", properties: { rationale: { type: "string" }, confidence: { type: "number" } } }), undefined, "no such field: the whole answer");
  assert.equal(agreeOnOf(true, undefined), undefined);
  assert.equal(agreeOnOf(true, { type: "array" }), undefined);
  assert.deepEqual(loopOf({ compile_after: 3 }, schema), { compile_after: 3, agree_min: 0.8, alone_min: 0.7, agree_on: ["riskTier", "siteLive", "kind"], agree_from: "schema" });
  assert.deepEqual(loopOf(true), { compile_after: 20, agree_min: 0.8, alone_min: 0.7 });
});

test("a schema-derived check promotes the live shape out of the box: riskTier and siteLive agree, confidence and rationale do not count", async () => {
  const schema = { type: "object", properties: { mcc: { type: "string" }, riskTier: { enum: ["low", "medium", "high"] }, siteLive: { type: "boolean" }, confidence: { type: "number" }, riskRationale: { type: "string" } } };
  const bar = loopOf(true, schema);
  const read = readOf(() => draftSays({ ...DRAFT, siteLive: true }));
  for (const row of read.rows) row.agent = agentSays({ ...AGENT, siteLive: true });
  const { record, stored } = await decide({ ...bar }, read);
  assert.equal(record.decided, "promote", record.reason);
  assert.deepEqual([stored.check.agree_on, stored.check.agree_from], [["riskTier", "siteLive"], "schema"]);
  assert.match(record.reason, /said what the agent said on riskTier and siteLive/);
});

test("agree_on round-trips through the definition PUT; a bad one is a 422 naming the field", async (t) => {
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("mcc", { learning: true }))).status, 201);
  const put = await api("PUT", "/agents/mcc/definition", { definition: { name: "mcc", instructions: "Classify the merchant.", skills: [], tools: [], learning: { agree_on: ["riskTier", "mcc"], compile_after: 5 } } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(Object.entries(put.body.definition.learning), [["compile_after", 5], ["agree_on", ["riskTier", "mcc"]]]);
  assert.deepEqual((await api("GET", "/agents/mcc")).body.definition.learning, { compile_after: 5, agree_on: ["riskTier", "mcc"] });
  const wrong = await api("PUT", "/agents/mcc/definition", { definition: { name: "mcc", instructions: "Classify the merchant.", skills: [], tools: [], learning: { agree_on: ["mcc", "mcc"] } } });
  assert.equal(wrong.status, 422, JSON.stringify(wrong.body));
  assert.deepEqual(wrong.body.error.fields.map((f) => [f.field, f.reason, f.message]), [["definition.learning", "wrong_type", "definition.learning.agree_on is a list of 1 to 16 distinct top-level answer keys, each 1 to 64 characters, e.g. true"]], "the 422's words name agree_on, then the field's example");
});

test("a record written with agree_on reads back with it (the promotions read keeps what the check compared)", async () => {
  const settings = settingsOf();
  const check = { compile_after: 5, agree_min: 0.8, alone_min: 0.7, agree_on: ["mcc"], agree_from: "definition", attempt: 1, n: 1, agreed: 1, alone: 1, of: ["r-0"] };
  await recordPromotion(settings, "a", { workflow: "classify", digest: "d1", at: new Date().toISOString(), decided: "promote", reason: "promoted", check }, () => true);
  assert.deepEqual((await promotionsOf(settings, "a")).at(-1).check, check);
});
