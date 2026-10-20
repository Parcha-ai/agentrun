import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  AgentHomeError, carryBack, choosePrompt, createAgentHome, homeRevision, LOOKUP_TEXT_MAX, prepareRun, projectForExport, readAgentHome, setPrompts, startRun,
  undoPrepare,
} from "../dist/index.js";
import { DEFINITION, scratch } from "./support.mjs";

const refused = (code, pattern) => (error) => error instanceof AgentHomeError && error.code === code && (!pattern || pattern.test(error.message));
const QUESTION = "What kind of organization is this company?";
const overlay = (id, option, threshold = 0.8) => ({ id, role: "overlay", label: `${option} overlay`, text: `Research it as a ${option} would be researched.`, when: { question: "kind", option, threshold } });
const SET = [
  { id: "base", role: "base", label: "Company research", text: "Research the company in the input. Cite every claim." },
  { id: "kind", role: "question", label: "Kind of organization", text: QUESTION, criteria: { public_company: "Its shares trade on a public exchange.", other: "None of the kinds above, or it cannot be told." } },
  overlay("public", "public_company", 0.9),
  overlay("nonprofit", "nonprofit"),
  overlay("private", "private_company"),
  overlay("government", "government_body", 0.75),
  { id: "generic", role: "generic", label: "Not sure", text: "Say what kind of organization it seems to be, and why." },
];
/** The set as stored and read back: keyed by id, without it. */
const stored = (variants) => Object.fromEntries(variants.map(({ id, ...variant }) => [id, variant]));

async function home(name = "home") {
  return createAgentHome(path.join(await scratch(), name), { definition: DEFINITION });
}

test("setPrompts stores a base, a generic and overlays with their Jev rules; readAgentHome returns them by id; a new set replaces the old one, and the same set writes nothing", async () => {
  const h = await home();
  assert.deepEqual((await readAgentHome(h)).prompts, {});
  assert.deepEqual(await setPrompts(h, SET), { changed: true });
  assert.deepEqual((await readAgentHome(h)).prompts, stored(SET));

  const revision = await homeRevision(h);
  assert.deepEqual(await setPrompts(h, [...SET].reverse()), { changed: false }, "order is not content");
  assert.equal(await homeRevision(h), revision, "an equal set is no commit");

  const next = [SET[0], SET[1], { ...SET[2], text: "Read its latest annual report first." }, SET[6]];
  assert.deepEqual(await setPrompts(h, next), { changed: true });
  assert.deepEqual((await readAgentHome(h)).prompts, stored(next), "the ids the new set leaves out are gone");
  assert.ok(await homeRevision(h) > revision);
});

test("a set that is not one base, one generic and overlays with valid ids, sizes and rules is refused, and the home is unchanged", async () => {
  const h = await home();
  await setPrompts(h, SET);
  const revision = await homeRevision(h);
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
    ["a rule on the generic", [base, { ...generic, when: publicOverlay.when }], /only an overlay has a when/],
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
  for (const [name, variants, pattern] of cases) await assert.rejects(setPrompts(h, variants), refused("invalid", pattern), name);
  assert.deepEqual((await readAgentHome(h)).prompts, stored(SET));
  assert.equal(await homeRevision(h), revision, "no refused set wrote anything");
  assert.deepEqual(await setPrompts(h, [base, { ...question, criteria: { other: "Neither." } }, overlay("edge-0", "a", 0), overlay("edge-1", "b", 1), generic]), { changed: true }, "0 and 1 are thresholds");
});

test("with ifRevision, a set written against an older revision is refused and nothing is written; against the current one it lands", async () => {
  const h = await home();
  const before = await homeRevision(h);
  await setPrompts(h, SET);
  const next = [SET[0], SET[6]];
  await assert.rejects(setPrompts(h, next, { ifRevision: before }), refused("stale", new RegExp(`not ${before} as the prompts' writer expected`)));
  assert.deepEqual((await readAgentHome(h)).prompts, stored(SET));
  for (const ifRevision of [-1, 1.5, "3"]) await assert.rejects(setPrompts(h, next, { ifRevision }), refused("invalid", /is not a home revision/), String(ifRevision));
  assert.deepEqual(await setPrompts(h, next, { ifRevision: await homeRevision(h) }), { changed: true });
  assert.deepEqual((await readAgentHome(h)).prompts, stored(next));
});

test("a run records the variant the host chose, only when given; an unknown variant or a malformed choice is refused before anything is written; the choice survives the carry back and the export", async () => {
  const h = await home();
  await setPrompts(h, SET);
  const chose = { id: "public", reason: "public_company at 0.93, above 0.9" };
  await startRun(h, { runId: "r1", host: "laptop", prompt: chose });
  await startRun(h, { runId: "r2", host: "laptop" });
  let state = await readAgentHome(h);
  assert.deepEqual(state.runs.r1.prompt, chose);
  assert.equal(Object.hasOwn(state.runs.r2, "prompt"), false, "no choice, no field");

  const revision = await homeRevision(h);
  const bad = [
    [{ id: "nope", reason: "x" }, /prompt nope is not one of the agent's variants/],
    [{ id: "public" }, /reason is not a non-empty string/],
    [{ id: "public", reason: " " }, /reason is not a non-empty string/],
    [{ id: "public", reason: "x".repeat(2_001) }, /at most 2000 characters/],
    [{ id: "has space", reason: "x" }, /prompt id "has space" is not a variant id/],
    [{ id: "public", reason: "x", text: "an overlay of my own" }, /the prompt is not \{ id, reason \}/],
    ["public", /the prompt is not \{ id, reason \}/],
  ];
  for (const [index, [prompt, pattern]] of bad.entries()) {
    await assert.rejects(startRun(h, { runId: `bad-${index}`, host: "laptop", prompt }), refused("invalid", pattern), JSON.stringify(prompt));
    assert.equal(existsSync(path.join(h.dir, "runs", `bad-${index}`)), false);
  }
  await assert.rejects(prepareRun(h, { runId: "bad-prepare", host: "laptop", prompt: { id: "nope", reason: "x" } }), refused("invalid", /not one of the agent's variants/));
  assert.equal(await homeRevision(h), revision, "no refused start wrote anything");

  await carryBack(h, { runId: "r1" }, { outcome: "completed", finalAnswer: "Listed on NASDAQ." });
  state = await readAgentHome(h);
  assert.deepEqual(state.runs.r1.prompt, chose, "the carry back keeps the choice");
  assert.deepEqual(projectForExport("agent.runs", state.runs.r1).prompt, chose, "and an export carries it");
  assert.deepEqual(projectForExport("agent.prompts", state.prompts.public), stored(SET).public, "prompts are exported as they are");

  const seed = await prepareRun(h, { runId: "r3", host: "laptop", prompt: { id: "generic", reason: "no option reached its threshold" } });
  assert.deepEqual((await readAgentHome(h)).runs.r3.prompt, { id: "generic", reason: "no option reached its threshold" });
  // The seed as a host may hand it back after carrying it as data: the choice's keys in another order.
  const carried = { ...seed, prior: { ...seed.prior, record: { ...seed.prior.record, prompt: { reason: "no option reached its threshold", id: "generic" } } } };
  assert.deepEqual(await undoPrepare(h, carried), { undone: true }, "an undo knows its own start, choice included, whatever its key order");
  assert.equal(Object.hasOwn((await readAgentHome(h)).runs, "r3"), false);
});

/** The set as `readAgentHome` returns it. */
const PROMPTS = stored(SET);
const OPTIONS = ["public_company", "nonprofit", "private_company", "government_body", "other"];
/** A pass's answer: `choice` at `p`, the rest of the probability spread evenly. */
const answer = (choice, p, confidence = p) => ({
  type: "choice", choice, confidence,
  probabilities: Object.fromEntries(OPTIONS.map((option) => [option, option === choice ? p : (1 - p) / (OPTIONS.length - 1)])),
});
/** A fake judge: each call takes the next answer (an Error is thrown), and every call's params are kept. */
function judgeOf(...answers) {
  const asked = [];
  const judge = async (params) => {
    asked.push(structuredClone(params));
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return { answers: { kind: next }, model: "jev-test", cost_usd: 0.0004, usage: null, request_sha256: "x" };
  };
  return { judge, asked };
}
/** A fake lookup: returns `found` (an Error is thrown) and keeps each query. */
function lookupOf(found) {
  const queries = [];
  const lookup = async (query, context) => {
    queries.push({ query, input: context.input });
    if (found instanceof Error) throw found;
    return found;
  };
  return { lookup, queries };
}
const instructionsFor = (id) => `${PROMPTS.base.text}\n\n${PROMPTS[id].text}`;

test("choosePrompt: a confident first pass picks the overlay, asks one choice question of every overlay's option and other, and runs no lookup", async () => {
  const { judge, asked } = judgeOf(answer("public_company", 0.95, 0.9));
  const { lookup, queries } = lookupOf("never read");
  const choice = await choosePrompt(PROMPTS, "Caterpillar Inc.", { judge, lookup });
  assert.equal(choice.variant, "public");
  assert.equal(choice.instructions, instructionsFor("public"));
  assert.deepEqual(choice.lookup, { used: false, chars: 0, sources: [] });
  assert.deepEqual(queries, []);
  assert.equal(choice.passes.length, 1);
  assert.deepEqual([choice.passes[0].choice, choice.passes[0].confidence, choice.passes[0].model, choice.passes[0].cost_usd], ["public_company", 0.9, "jev-test", 0.0004]);
  assert.ok(Number.isInteger(choice.passes[0].latency_ms) && choice.passes[0].latency_ms >= 0);
  assert.equal(asked.length, 1);
  assert.deepEqual({ ...asked[0], questions: undefined }, { label: "kind", kind: "judge", state: { input: "Caterpillar Inc." }, questions: undefined });
  assert.deepEqual(asked[0].questions, { kind: { type: "choice", instructions: QUESTION, criteria: {
    public_company: "Its shares trade on a public exchange.", nonprofit: null, private_company: null, government_body: null, other: "None of the kinds above, or it cannot be told.",
  } } });
  assert.match(choice.reason, /^Jev: public_company at 95%, at or over 90%$/);
});

test("choosePrompt: unsure, then a lookup on the input's words, then sure: the overlay, with both passes and what the lookup read but never its text", async () => {
  const { judge, asked } = judgeOf(answer("nonprofit", 0.6, 0.4), answer("nonprofit", 0.92));
  const sources = [{ via: "wikipedia", url: "https://en.wikipedia.org/wiki/Habitat_for_Humanity", title: "Habitat for Humanity" }, { via: "browserbase_search", url: "https://www.habitat.org/" }];
  const text = "Habitat for Humanity is a nonprofit housing organization.";
  const { lookup, queries } = lookupOf({ text, sources });
  const input = { company: "Habitat for Humanity", country: "US", employees: 7000 };
  const choice = await choosePrompt(PROMPTS, input, { judge, lookup });
  assert.equal(choice.variant, "nonprofit");
  assert.equal(choice.instructions, instructionsFor("nonprofit"));
  assert.deepEqual(queries, [{ query: "Habitat for Humanity US", input }], "the lookup gets the input's words, and the input");
  assert.deepEqual(asked.map((params) => params.state), [{ input }, { input, lookup: text }]);
  assert.deepEqual(choice.lookup, { used: true, chars: text.length, sources });
  assert.deepEqual(choice.passes.map((pass) => [pass.choice, pass.probabilities.nonprofit, pass.confidence]), [["nonprofit", 0.6, 0.4], ["nonprofit", 0.92, 0.92]]);
  assert.ok(!JSON.stringify(choice).includes(text), "the lookup's text is not in the choice");
  assert.match(choice.reason, /^Jev: nonprofit at 60%, under 80%; after the lookup, Jev: nonprofit at 92%, at or over 80%$/);
});

test("choosePrompt: still unsure after the lookup, or nothing found, or no lookup at all: the generic, and the reason says each step", async () => {
  const still = await choosePrompt(PROMPTS, "Acme", { judge: judgeOf(answer("other", 0.5), answer("other", 0.7)).judge, lookup: lookupOf("Acme is a cartoon company.").lookup });
  assert.deepEqual([still.variant, still.instructions, still.passes.length, still.lookup], ["generic", instructionsFor("generic"), 2, { used: true, chars: 26, sources: [] }]);
  assert.match(still.reason, /^Jev: other at 50% \(no prompt for it\); after the lookup, Jev: other at 70% \(no prompt for it\); so the generic prompt$/);

  const nothing = await choosePrompt(PROMPTS, "Acme", { judge: judgeOf(answer("private_company", 0.5)).judge, lookup: lookupOf(null).lookup });
  assert.deepEqual([nothing.variant, nothing.passes.length, nothing.lookup], ["generic", 1, { used: true, chars: 0, sources: [] }]);
  assert.match(nothing.reason, /^Jev: private_company at 50%, under 80%; the lookup found nothing; so the generic prompt$/);

  const without = await choosePrompt(PROMPTS, "Acme", { judge: judgeOf(answer("private_company", 0.5)).judge });
  assert.deepEqual([without.variant, without.passes.length, without.lookup.used], ["generic", 1, false]);
  assert.match(without.reason, /under 80%; so the generic prompt$/);
});

test("choosePrompt: a judge or lookup failure gives the generic with the reason, and never throws", async () => {
  const thrown = await choosePrompt(PROMPTS, "Acme", { judge: judgeOf(new Error("TypeSafe answered 503")).judge, lookup: lookupOf("x").lookup });
  assert.deepEqual([thrown.variant, thrown.instructions, thrown.passes, thrown.lookup.used], ["generic", instructionsFor("generic"), [], false]);
  assert.equal(thrown.reason, "Jev failed (TypeSafe answered 503), so the generic prompt");

  const second = await choosePrompt(PROMPTS, "Acme", { judge: judgeOf(answer("nonprofit", 0.5), new Error("timeout")).judge, lookup: lookupOf("Acme Foundation.").lookup });
  assert.deepEqual([second.variant, second.passes.length], ["generic", 1]);
  assert.match(second.reason, /; Jev failed after the lookup \(timeout\), so the generic prompt$/);

  const malformed = await choosePrompt(PROMPTS, "Acme", { judge: async () => ({ answers: { kind: { type: "noul", noul: 0.5 } } }) });
  assert.equal(malformed.variant, "generic");
  assert.equal(malformed.reason, "Jev failed (the judge gave no choice for kind), so the generic prompt");

  const lookupFailed = await choosePrompt(PROMPTS, "Acme", { judge: judgeOf(answer("nonprofit", 0.5)).judge, lookup: lookupOf(new Error("Wikipedia answered 429")).lookup });
  assert.deepEqual([lookupFailed.variant, lookupFailed.lookup], ["generic", { used: true, chars: 0, sources: [] }]);
  assert.match(lookupFailed.reason, /; the lookup failed \(Wikipedia answered 429\); so the generic prompt$/);
});

test("choosePrompt: each overlay has its own threshold, met at equality; the highest probability that meets one wins, even under another option's", async () => {
  const at = (probabilities) => async () => ({ answers: { kind: { type: "choice", choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0], probabilities, confidence: 0.5 } } });
  const exact = await choosePrompt(PROMPTS, "x", { judge: at({ public_company: 0.9, other: 0.1 }) });
  assert.equal(exact.variant, "public", "0.9 meets public's 0.9");
  const under = await choosePrompt(PROMPTS, "x", { judge: at({ nonprofit: 0.79, other: 0.21 }) });
  assert.equal(under.variant, "generic", "0.79 is under nonprofit's 0.8");
  const both = await choosePrompt(PROMPTS, "x", { judge: at({ government_body: 0.46, private_company: 0.5, other: 0.04 }) });
  assert.equal(both.variant, "generic", "neither meets its threshold");
  const lowSet = { ...PROMPTS, government: { ...PROMPTS.government, when: { ...PROMPTS.government.when, threshold: 0.3 } }, private: { ...PROMPTS.private, when: { ...PROMPTS.private.when, threshold: 0.3 } } };
  const highest = await choosePrompt(lowSet, "x", { judge: at({ government_body: 0.35, private_company: 0.4, other: 0.25 }) });
  assert.equal(highest.variant, "private", "both meet 0.3; 0.4 is higher");
  const notTop = await choosePrompt(lowSet, "x", { judge: at({ other: 0.6, government_body: 0.32, private_company: 0.08 }) });
  assert.equal(notTop.variant, "government", "other is the top choice, and government still meets its threshold");
});

test("choosePrompt: the lookup's text is cut to LOOKUP_TEXT_MAX for the second pass; a set setPrompts refuses is refused; a set with no rule is the generic, with no judge call", async () => {
  const { judge, asked } = judgeOf(answer("other", 0.5), answer("other", 0.5));
  const long = "y".repeat(LOOKUP_TEXT_MAX + 500);
  const cut = await choosePrompt(PROMPTS, "x", { judge, lookup: lookupOf({ text: long }).lookup });
  assert.equal(asked[1].state.lookup, long.slice(0, LOOKUP_TEXT_MAX));
  assert.equal(cut.lookup.chars, LOOKUP_TEXT_MAX);

  const { base, generic } = PROMPTS;
  const calls = judgeOf();
  await assert.rejects(choosePrompt({ generic }, "x", { judge: calls.judge }), refused("invalid", /0 base variants/));
  await assert.rejects(choosePrompt({ base, generic, public: PROMPTS.public }, "x", { judge: calls.judge }), refused("invalid", /question kind is not the set's question row/));
  const plain = await choosePrompt({ base, generic }, "x", { judge: calls.judge });
  assert.deepEqual([plain.variant, plain.instructions, plain.passes, plain.reason], ["generic", instructionsFor("generic"), [], "no overlay has a rule, so the generic prompt"]);
  assert.deepEqual(calls.asked, []);
});
