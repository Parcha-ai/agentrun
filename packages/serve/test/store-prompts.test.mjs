// The prompt set validator folded into the store (store/prompts.ts, the P4 fold of home.ts's checkPrompts): the same rules
// and words as before, tested on checkPrompts directly. Ported from pi-durable-agent/test/prompts.test.mjs's refusal cases.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPrompts, PromptsInvalid } from "../dist/store/prompts.js";

const refused = (pattern) => (error) => error instanceof PromptsInvalid && (!pattern || pattern.test(error.message));
const overlay = (id, option, threshold = 0.8) => ({ id, role: "overlay", label: `${option} overlay`, text: `Research it as a ${option} would be researched.`, when: { question: "kind", option, threshold } });
const SET = [
  { id: "base", role: "base", label: "Company research", text: "Research the company in the input. Cite every claim." },
  { id: "kind", role: "question", label: "Kind of organization", text: "What kind of organization is this company?", criteria: { public_company: "Its shares trade on a public exchange.", other: "None of the kinds above, or it cannot be told." } },
  overlay("public", "public_company", 0.9),
  overlay("nonprofit", "nonprofit"),
  overlay("private", "private_company"),
  overlay("government", "government_body", 0.75),
  { id: "generic", role: "generic", label: "Not sure", text: "Say what kind of organization it seems to be, and why." },
];
const stored = (variants) => Object.fromEntries(variants.map(({ id, ...variant }) => [id, variant]));

test("a valid set is accepted, returned as [id, variant] in order, its rules and criteria kept", () => {
  const out = checkPrompts(SET);
  assert.deepEqual(out.map(([id]) => id), ["base", "kind", "public", "nonprofit", "private", "government", "generic"]);
  const byId = Object.fromEntries(out);
  assert.deepEqual(byId.public.when, { question: "kind", option: "public_company", threshold: 0.9 });
  assert.equal(byId.kind.criteria.public_company, "Its shares trade on a public exchange.");
  // 0 and 1 are valid thresholds.
  assert.doesNotThrow(() => checkPrompts([SET[0], { ...SET[1], criteria: { other: "Neither." } }, overlay("edge-0", "a", 0), overlay("edge-1", "b", 1), SET[6]]));
});

test("every refusal names the first thing wrong, in the same words as before", () => {
  const [base, question, publicOverlay, , , , generic] = SET;
  const cases = [
    ["not a list", stored(SET), /not a list/],
    ["no base", [question, publicOverlay, generic], /0 base variants/],
    ["two bases", [base, { ...base, id: "base-2" }, generic], /2 base variants/],
    ["no generic", [base, question, publicOverlay], /0 generic variants/],
    ["two generics", [base, generic, { ...generic, id: "generic-2" }], /2 generic variants/],
    ["an id twice", [base, question, publicOverlay, { ...publicOverlay, label: "again" }, generic], /public is given twice/],
    ["two questions", [base, question, { ...question, id: "kind-2" }, generic], /2 questions \(kind, kind-2\); a set has at most one/],
    ["a rule and no question row", [base, publicOverlay, generic], /question kind is not the set's question row/],
    ["a rule naming another question", [base, question, { ...publicOverlay, when: { ...publicOverlay.when, question: "size" } }, generic], /question size is not the set's question row/],
    ["an option two overlays need", [base, question, publicOverlay, { ...publicOverlay, id: "public-2" }, generic], /option public_company is needed by both public and public-2/],
    ["an overlay for other", [base, question, { ...publicOverlay, when: { ...publicOverlay.when, option: "other" } }, generic], /option is "other", which every question has/],
    ["criteria on the base", [{ ...base, criteria: { other: "x" } }, question, generic], /base is the base; only a question has criteria/],
    ["criteria for an option no overlay needs", [base, { ...question, criteria: { private_company: "x" } }, publicOverlay, generic], /describes private_company, which no overlay needs/],
    ["an empty criterion", [base, { ...question, criteria: { other: " " } }, publicOverlay, generic], /criterion for other is not a non-empty string/],
    ["an id that is not one URL segment", [base, question, { ...publicOverlay, id: "has space" }, generic], /id "has space" does not match/],
    ["no id", [base, { ...generic, id: undefined }], /id undefined does not match/],
    ["an unknown role", [base, question, { ...publicOverlay, role: "system" }, generic], /role "system" is not base, overlay, generic or question/],
    ["an empty label", [base, question, { ...publicOverlay, label: " " }, generic], /label is not a non-empty string/],
    ["a label over 200 characters", [base, question, { ...publicOverlay, label: "x".repeat(201) }, generic], /label is not a non-empty string of at most 200/],
    ["an empty text", [base, question, { ...publicOverlay, text: "\n" }, generic], /text is not a non-empty string/],
    ["a text over 64 KiB in bytes", [base, question, { ...publicOverlay, text: "é".repeat(32_769) }, generic], /at most 65536 bytes/],
    ["a rule on the base", [{ ...base, when: publicOverlay.when }, generic], /base is the base; only an overlay has a when/],
    ["a threshold below 0", [base, question, { ...publicOverlay, when: { ...publicOverlay.when, threshold: -0.01 } }, generic], /threshold -0.01 is not a number from 0 to 1/],
    ["a threshold above 1", [base, question, { ...publicOverlay, when: { ...publicOverlay.when, threshold: 1.01 } }, generic], /threshold 1.01 is not/],
    ["a threshold that is NaN", [base, question, { ...publicOverlay, when: { ...publicOverlay.when, threshold: Number.NaN } }, generic], /threshold NaN is not/],
    ["a threshold given as text", [base, question, { ...publicOverlay, when: { ...publicOverlay.when, threshold: "0.9" } }, generic], /threshold 0.9 is not/],
    ["a rule with no question", [base, question, { ...publicOverlay, when: { option: "public_company", threshold: 0.9 } }, generic], /question undefined is not a prompt id/],
    ["a rule with no option", [base, question, { ...publicOverlay, when: { question: "kind", threshold: 0.9 } }, generic], /option is not a non-empty string/],
    ["a rule that is not an object", [base, question, { ...publicOverlay, when: "public_company" }, generic], /when is not an object/],
    ["a rule with a field it does not keep", [base, question, { ...publicOverlay, when: { ...publicOverlay.when, model: "x" } }, generic], /a rule does not keep: model/],
    ["a variant with a field it does not keep", [base, question, { ...publicOverlay, model: "x" }, generic], /a variant does not keep: model/],
    ["more than 64 variants", [base, question, generic, ...Array.from({ length: 62 }, (_, i) => overlay(`o${i}`, `kind_${i}`))], /65 variants; a set has at most 64/],
  ];
  for (const [name, variants, pattern] of cases) assert.throws(() => checkPrompts(variants), refused(pattern), name);
});
