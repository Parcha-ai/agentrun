// learning.agree_on: the check (runner/promotion.ts decideCheck) and the audit (runner/audit.ts) compare two answers on
// the fields that say the decision, never on free text two real runs never repeat. A definition's `learning.agree_on`
// names them as dotted paths into the answer's JSON object (`verdict.decision`); absent, the whole answer, as before (no
// field is picked from the output schema: its enum can be an echo of the owner's setting, not the decision), and a check
// that agreed on none says to name the fields. Synthetic data only: an invented merchant on example.com.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { agent, serve } from "./support.mjs";

const { decideCheck } = await import("../dist/runner/promotion.js");
const { promotionsOf, recordPromotion, sameAnswer } = await import("../dist/learn/promote.js");
const { learningSettingIssue, learningSettingOf, loopOf } = await import("../dist/learning-setting.js");
const { secretsShown } = await import("../dist/learning.js");

/** The agent's answer as a real model writes it: prose, then one fenced json block. */
const agentSays = (fields) => `Example Cinema (example.com) sells film tickets and concessions.\n\n\`\`\`json\n${JSON.stringify(fields, null, 2)}\n\`\`\``;
/** The draft's answer: one bare fenced json block. */
const draftSays = (fields) => `\`\`\`json\n${JSON.stringify(fields)}\n\`\`\``;

const AGENT = { mcc: "7832", riskTier: "low", riskRationale: "A cinema with a public box office and a long trading history.", evidence: ["example.com/tickets lists showtimes"], confidence: 0.86 };
const DRAFT = { riskTier: "low", mcc: "7832", riskRationale: "Motion picture theatre; low chargeback exposure.", evidence: ["Showtimes page on example.com"], confidence: 0.74 };

/** The agent's learning records in memory, as Store.learning keeps them (records, changeRecords in one write each), and
 *  its workflow "classify" held at digest d1, the one each check here decides. */
function learningRowsOf() {
  const kinds = new Map();
  let seq = 0;
  const stamp = (one) => ({ ...one, seq: one.seq ?? ++seq, at: one.at ?? Date.now() });
  return {
    records: async (_agentId, kind) => structuredClone(kinds.get(kind) ?? []),
    changeRecords: async (_agentId, kind, update) => {
      const out = update(structuredClone(kinds.get(kind) ?? []));
      if ("records" in out) kinds.set(kind, out.records.map(stamp));
      return out.result;
    },
    versions: async (_agentId, _kind, name) => (name === "classify" ? [{ digest: "d1" }] : []),
  };
}

/** A check's read of `rows` answered alone, each the agent's `agent`-shaped answer and the draft's `draft(i)`. */
const readOf = (draft, n = 5, said = AGENT) => {
  const rows = Array.from({ length: n }, (_, i) => ({ of: `r-${i}`, input: `{"merchant":"Example Cinema ${i}","site":"https://example.com/${i}"}`, agent: agentSays(said), outcome: "answered", answer: draft(i) }));
  return { rows, cost: 0, outcomes: { answered: n, handed_back: 0, skipped_write: 0, failed: 0 }, unstarted: 0 };
};

async function decide(bar, read) {
  const learning = learningRowsOf();
  const logs = [];
  const deps = { store: { learning }, agentId: "a", runId: "now", revisionId: "rev", launch: {}, context: ctx, log: (line) => logs.push(line), shown: async () => secretsShown([]) };
  const decided = await decideCheck(deps, "classify", "d1", { compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1, ...bar }, read, () => true, {});
  return { record: decided.record, stored: (await promotionsOf(learning, "a")).at(-1), logs };
}

test("check on live-shaped answers: same mcc and riskTier, other rationale, evidence and confidence: agreed on agree_on, promoted; on the whole answer, held", async () => {
  const on = await decide({ agree_on: ["mcc", "riskTier"] }, readOf(() => draftSays(DRAFT)));
  assert.equal(on.record.decided, "promote", on.record.reason);
  assert.deepEqual([on.stored.check.agreed, on.stored.check.alone, on.stored.check.agree_on], [5, 5, ["mcc", "riskTier"]], "the record says what it compared");
  assert.equal("agree_from" in on.stored.check, false, "one source: the definition's list");
  assert.match(on.record.reason, /5 of those said what the agent said on mcc and riskTier \(100\.0%, the bar 80\.0%\): promoted$/);

  const whole = await decide({}, readOf(() => draftSays(DRAFT)));
  assert.equal(whole.record.decided, "hold", "today's whole-answer rule stands with no agree_on");
  assert.equal(whole.stored.check.agreed, 0);
  assert.equal(whole.stored.check.agree_on, undefined);
  assert.match(whole.record.reason, /0 of those said what the agent said \(0\.0%, the bar 80\.0%\): held; its answers never matched the agent's word for word, and no fast model compared their decisions \(a learning agent with no agree_on wants one: AGENT_MODEL_FAST, or its model_tiers\.fast\); name the fields that carry the decision \(learning\.agree_on\); the agent's next run recompiles/);
});

test("check on dotted paths: verdict.decision agrees though the rationale differs; a draft that differs on it disagrees, counted per input", async () => {
  const said = { checked_on: "2026-11-18", risk_appetite: "medium", verdict: { decision: "approve", rationale: "Registered, no sanctions hit." }, report_markdown: "# Example Cinema\n..." };
  const draft = (decision) => ({ checked_on: "2026-11-18", risk_appetite: "medium", verdict: { decision, rationale: "Clean registry record." }, report_markdown: "# Report\n..." });
  const read = readOf((i) => draftSays(draft(i < 2 ? "decline" : "approve")), 5, said);
  const held = await decide({ agree_on: ["verdict.decision"] }, read);
  assert.equal(held.record.decided, "hold");
  assert.equal(held.stored.check.agreed, 3);
  assert.deepEqual(held.stored.check.disagreements.map((one) => one.run), ["r-0", "r-1"]);
  assert.match(held.record.reason, /3 of those said what the agent said on verdict\.decision \(60\.0%/);
  assert.doesNotMatch(held.record.reason, /word for word/, "it agreed on some: no hint");
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
  ]) {
    assert.equal(learningSettingIssue({ agree_on: ["mcc", path] }), `learning.agree_on[1] is not a dotted path into the answer's JSON object (e.g. verdict.decision): ${why}`, JSON.stringify(path));
  }
  assert.equal(learningSettingIssue({ agree_on: ["riskTier", "mcc"] }), undefined);
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
  const learning = learningRowsOf();
  const check = { compile_after: 5, agree_min: 0.8, alone_min: 0.7, agree_on: ["verdict.decision"], attempt: 1, n: 1, agreed: 1, alone: 1, of: ["r-0"] };
  await recordPromotion(learning, "a", { workflow: "classify", digest: "d1", at: new Date().toISOString(), decided: "promote", reason: "promoted", check }, () => true);
  assert.deepEqual((await promotionsOf(learning, "a")).at(-1).check, check);
});
