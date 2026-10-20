import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  AgentHomeError, carryBack, createAgentHome, homeRevision, prepareRun, projectForExport, readAgentHome, setPrompts, startRun, undoPrepare,
} from "../dist/index.js";
import { DEFINITION, scratch } from "./support.mjs";

const refused = (code, pattern) => (error) => error instanceof AgentHomeError && error.code === code && (!pattern || pattern.test(error.message));
const QUESTION = "What kind of organization is this company?";
const overlay = (id, option, threshold = 0.8) => ({ id, role: "overlay", label: `${option} overlay`, text: `Research it as a ${option} would be researched.`, when: { question: QUESTION, option, threshold } });
const SET = [
  { id: "base", role: "base", label: "Company research", text: "Research the company in the input. Cite every claim." },
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

  const next = [SET[0], { ...SET[1], text: "Read its latest annual report first." }, SET[5]];
  assert.deepEqual(await setPrompts(h, next), { changed: true });
  assert.deepEqual((await readAgentHome(h)).prompts, stored(next), "the ids the new set leaves out are gone");
  assert.ok(await homeRevision(h) > revision);
});

test("a set that is not one base, one generic and overlays with valid ids, sizes and rules is refused, and the home is unchanged", async () => {
  const h = await home();
  await setPrompts(h, SET);
  const revision = await homeRevision(h);
  const [base, publicOverlay, , , , generic] = SET;
  const cases = [
    ["not a list", stored(SET), /not a list/],
    ["no base", [publicOverlay, generic], /0 base variants/],
    ["two bases", [base, { ...base, id: "base-2" }, generic], /2 base variants/],
    ["no generic", [base, publicOverlay], /0 generic variants/],
    ["two generics", [base, generic, { ...generic, id: "generic-2" }], /2 generic variants/],
    ["an id twice", [base, publicOverlay, { ...publicOverlay, label: "again" }, generic], /public is given twice/],
    ["an id that is not one URL segment", [base, { ...publicOverlay, id: "has space" }, generic], /id "has space" does not match/],
    ["no id", [base, { ...generic, id: undefined }], /id undefined does not match/],
    ["an unknown role", [base, { ...publicOverlay, role: "system" }, generic], /role "system" is not base, overlay or generic/],
    ["an empty label", [base, { ...publicOverlay, label: " " }, generic], /label is not a non-empty string/],
    ["a label over 200 characters", [base, { ...publicOverlay, label: "x".repeat(201) }, generic], /label is not a non-empty string of at most 200/],
    ["an empty text", [base, { ...publicOverlay, text: "\n" }, generic], /text is not a non-empty string/],
    ["a text over 64 KiB in bytes", [base, { ...publicOverlay, text: "é".repeat(32_769) }, generic], /at most 65536 bytes/],
    ["a rule on the base", [{ ...base, when: publicOverlay.when }, generic], /base is the base; only an overlay has a when/],
    ["a rule on the generic", [base, { ...generic, when: publicOverlay.when }], /only an overlay has a when/],
    ["a threshold below 0", [base, { ...publicOverlay, when: { ...publicOverlay.when, threshold: -0.01 } }, generic], /threshold -0.01 is not a number from 0 to 1/],
    ["a threshold above 1", [base, { ...publicOverlay, when: { ...publicOverlay.when, threshold: 1.01 } }, generic], /threshold 1.01 is not/],
    ["a threshold that is NaN", [base, { ...publicOverlay, when: { ...publicOverlay.when, threshold: Number.NaN } }, generic], /threshold NaN is not/],
    ["a threshold given as text", [base, { ...publicOverlay, when: { ...publicOverlay.when, threshold: "0.9" } }, generic], /threshold 0.9 is not/],
    ["a rule with no question", [base, { ...publicOverlay, when: { option: "public_company", threshold: 0.9 } }, generic], /question is not a non-empty string/],
    ["a rule with no option", [base, { ...publicOverlay, when: { question: QUESTION, threshold: 0.9 } }, generic], /option is not a non-empty string/],
    ["a rule that is not an object", [base, { ...publicOverlay, when: "public_company" }, generic], /when is not an object/],
    ["a rule with a field it does not keep", [base, { ...publicOverlay, when: { ...publicOverlay.when, model: "x" } }, generic], /a rule does not keep: model/],
    ["a variant with a field it does not keep", [base, { ...publicOverlay, model: "x" }, generic], /a variant does not keep: model/],
    ["more than 64 variants", [base, generic, ...Array.from({ length: 63 }, (_, i) => overlay(`o${i}`, `kind_${i}`))], /65 variants; a set has at most 64/],
  ];
  for (const [name, variants, pattern] of cases) await assert.rejects(setPrompts(h, variants), refused("invalid", pattern), name);
  assert.deepEqual((await readAgentHome(h)).prompts, stored(SET));
  assert.equal(await homeRevision(h), revision, "no refused set wrote anything");
  assert.deepEqual(await setPrompts(h, [base, overlay("edge-0", "a", 0), overlay("edge-1", "b", 1), generic]), { changed: true }, "0 and 1 are thresholds");
});

test("with ifRevision, a set written against an older revision is refused and nothing is written; against the current one it lands", async () => {
  const h = await home();
  const before = await homeRevision(h);
  await setPrompts(h, SET);
  const next = [SET[0], SET[5]];
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
