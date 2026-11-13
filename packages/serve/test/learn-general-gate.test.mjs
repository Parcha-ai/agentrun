// B1 (learn-loop SPEC): notes must generalize. Two gates, both before anything is merged:
//   1. Jev's generality pre-check (learn/general.ts): one Noul per proposed note, "does it hold for inputs of this job
//      other than the one it came from?"; a note under the bar (default 0.5) is dropped before the grader reads it, its
//      why with the grader's items. Offline on Run B's 388 kept MCC notes, Jev's answer agreed with an Opus label 97.4%
//      (kappa 0.95). Jev down or not set up: every note is graded, as before.
//   2. The grader's General question is a hard gate (learn/grade.ts): every item says general true or false, and one
//      kept, held or re-filed that does not say general true is dropped, whatever its decision. Run B's grader merged
//      200 of 205 proposals, most of them one merchant's code, and called many of them "general".
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const { parseVerdict, gradePrompt, GRADE_RUBRIC, NOT_GENERAL, NOT_SAID_GENERAL } = await import("../dist/learn/grade.js");
const general = await import("../dist/learn/general.js");
const { createLearningLoop } = await import("../dist/runner/learning-loop.js");
const { KINDS } = await import("../dist/runner/journal-kinds.js");
const { journalEntries } = await import("../dist/runner/journal-reader.js");

const noteText = (name, body) => `---\nname: ${name}\ndescription: ${name}\ntype: reference\n---\n${body}\n`;
const METHOD = { file: "read-the-website.md", text: noteText("Read the website", "Open the merchant's website and read what it sells before picking a code.") };
const ONE_MERCHANT = { file: "bluebird-bakery-mcc.md", text: noteText("Bluebird Bakery code", "Bluebird Bakery Ltd is 5462.") };

// --- 2. The grader's General question, a hard gate ---

test("the rubric names one input's names, ids, amounts or pages as one case, and the prompt asks general for every item, as a gate", () => {
  assert.match(GRADE_RUBRIC, /rests on the names, ids, amounts or pages of the one input it came from/);
  assert.match(GRADE_RUBRIC, /even when it reads as a stable fact/);
  const prompt = gradePrompt({ run: "run-1", active: [], superseded: [], proposed: [METHOD] });
  assert.match(prompt, /"general": true or false/);
  assert.match(prompt, /an item that says\ngeneral false is dropped whatever its decision/);
});

test("an item kept or held while it says general false is dropped as General; one that says nothing of general is dropped too (fail closed)", () => {
  const items = [METHOD, ONE_MERCHANT];
  const answer = (one, two) => JSON.stringify({ merge: true, reason: "Judged.", items: [{ file: METHOD.file, decision: "keep", why: "A method.", ...one }, { file: ONE_MERCHANT.file, decision: "keep", why: "A stable fact.", ...two }] });
  const saidFalse = parseVerdict(answer({ general: true }, { general: false }), items);
  assert.equal(saidFalse.merge, true, "the general one still merges");
  assert.deepEqual(saidFalse.items.map(({ file, keep, question, why }) => ({ file, keep, question, why })), [
    { file: METHOD.file, keep: true, question: undefined, why: "A method." },
    { file: ONE_MERCHANT.file, keep: false, question: "General", why: NOT_GENERAL },
  ]);
  const unsaid = parseVerdict(answer({ general: true }, {}), items);
  assert.deepEqual(unsaid.items[1], { file: ONE_MERCHANT.file, keep: false, question: "General", why: NOT_SAID_GENERAL });
  const pending = parseVerdict(JSON.stringify({ merge: true, reason: "Held.", items: [{ file: METHOD.file, decision: "pending", question: "Risky", general: false, why: "Widens trust." }] }), [METHOD]);
  assert.equal(pending.merge, false, "a held item that is not general is no hold: nothing kept");
  assert.equal(pending.items[0].keep, false);
  // A drop needs no general; a general that is no boolean is no verdict.
  assert.equal(parseVerdict(JSON.stringify({ merge: false, reason: "No.", items: [{ file: METHOD.file, decision: "drop", question: "Duplicate", why: "Held already." }] }), [METHOD]).items[0].question, "Duplicate");
  assert.equal(parseVerdict(answer({ general: "yes" }, { general: true }), items).items.length, 0, "unreadable");
});

test("a re-filed skill is gated the same: decision note with general false keeps nothing", () => {
  const skill = { file: "skills/answer-format/SKILL.md", text: "---\nname: answer-format\ndescription: Answer with a table.\n---\nAnswer every report with a table.\n" };
  const verdict = parseVerdict(JSON.stringify({ merge: true, reason: "Re-filed.", items: [{ file: skill.file, decision: "note", general: false, why: "A rule for every reply." }] }), [skill]);
  assert.equal(verdict.items[0].keep, false);
  assert.equal(verdict.items[0].note, undefined);
});

// --- 1. Jev's pre-check ---

test("one Jev request a note: the job, the run's input and the note in its state, one Noul asking the lead's question", () => {
  const request = general.generalRequest({ ...ONE_MERCHANT, text: `${ONE_MERCHANT.text}` }, { job: "Classify merchants.", input: "SQ *BLUEBIRD BAKERY" });
  assert.equal(request.kind, "judge");
  assert.deepEqual(Object.keys(request.state), ["job", "input", "note"]);
  assert.equal(request.state.input, "SQ *BLUEBIRD BAKERY");
  assert.ok(request.state.note.includes("5462"));
  assert.deepEqual(Object.keys(request.questions), ["general"]);
  assert.equal(request.questions.general.type, "noul");
  assert.match(request.questions.general.instructions, /method, source, fact or preference that holds for inputs of this job other than `input`/);
  assert.match(request.questions.general.criteria.false, /names, ids, amounts or pages of that one input/);
  // Each part cut to its cap.
  const long = general.generalRequest(METHOD, { input: "x".repeat(general.GENERAL_STATE_CAPS.input + 50) });
  assert.ok(long.state.input.length <= general.GENERAL_STATE_CAPS.input + 10 && long.state.input.endsWith("[cut]"));
});

/** A fake Jev provider: a probability per note file, read from the request's state; `fail` throws. */
const fakeJev = (byFile, { fail = false, cost = 0.00001 } = {}) => {
  const asked = [];
  return {
    asked,
    provider: {
      id: "jev", needs: ["TYPESAFE_API_KEY"], capabilities: { types: ["noul"], inputs: ["json"], evidence: "none", probability: "model", grounding: false, replay: "never", maxQuestions: null, maxStateBytes: null },
      async decide(request, ctx) {
        asked.push({ request, ctx });
        if (fail) throw new Error("Jev is down");
        const file = Object.keys(byFile).find((name) => request.label.endsWith(name));
        return { answers: { general: { type: "noul", noul: byFile[file] } }, evidence: [], model: "jev-test", usage: { input_tokens: 100, output_tokens: 0 }, cost_usd: cost, cost_basis: "estimate", provider_request_id: null };
      },
    },
  };
};

test("generalScores asks one request a note, all at once, and adds their cost; an answer that is no probability throws", async () => {
  const jev = fakeJev({ [METHOD.file]: 0.93, [ONE_MERCHANT.file]: 0.04 });
  const got = await general.generalScores(jev.provider, [METHOD, ONE_MERCHANT], { input: "x" }, new AbortController().signal, "run-1");
  assert.deepEqual(got.scores, { [METHOD.file]: 0.93, [ONE_MERCHANT.file]: 0.04 });
  assert.ok(Math.abs(got.usd - 0.00002) < 1e-12);
  assert.equal(jev.asked.length, 2);
  assert.notEqual(jev.asked[0].ctx.decisionId, jev.asked[1].ctx.decisionId);
  await assert.rejects(general.generalScores(fakeJev({ [METHOD.file]: 1.7 }).provider, [METHOD], {}, new AbortController().signal, "run-1"), /no probability/);
});

test("the bar: 0.5 by default, another from the environment, and anything but a number from 0 to 1 refused", () => {
  assert.equal(general.generalThresholdOf({}), 0.5);
  assert.equal(general.generalThresholdOf({ [general.GENERAL_THRESHOLD_ENV]: "0.7" }), 0.7);
  for (const bad of ["1.5", "-0.1", "half", "0.5x"]) assert.throws(() => general.generalThresholdOf({ [general.GENERAL_THRESHOLD_ENV]: bad }), /a number from 0 to 1/);
});

// --- 1. In the learning run ---

const MAIN = { active: [], superseded: [], graded: {} };
const MERGED = { ok: true, main: "c0ffee", commit: "c0ffee", files: [METHOD.file] };

async function setUp(t, proposal) {
  const { store, clock } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const source = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const kept = { state: "proposed", notes: proposal.notes.map(({ file }) => file), skills: [], workflows: [], proposal, detail: "Proposed." };
  await store.runs.update(source, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: { answer: "…" }, proposal: kept } }, { table: "learning_run", row: { id: "learn-1" } }] });
  const claim = await store.claim("learn-1", "runner-a", { leaseMs: 60_000 });
  return { store, clock, claim };
}

function loopOn(store, clock, { answer, general: check, threshold }) {
  const calls = { ask: [], commit: [], log: [] };
  const factory = createLearningLoop({
    sourceOf: async () => ({ runId: "run-1", agentId: "agent-1", instructions: "Classify each merchant with its four-digit code." }),
    proposal: (runId) => store.learning.proposal(runId),
    folder: (agentId) => ({ workspace: { agentId }, end: async () => {} }),
    readMain: async () => MAIN,
    ask: async (request) => (calls.ask.push(request), { text: answer, usd: 0.01 }),
    commit: async (ws, change) => (calls.commit.push(change), MERGED),
    mainTexts: async () => ({}),
    merged: async () => undefined,
    now: () => clock.now,
    ...(check ? { general: check } : {}),
    ...(threshold !== undefined ? { generalThreshold: threshold } : {}),
    log: (line) => calls.log.push(line),
  });
  const loop = factory({ journal: (claim) => store.journal(claim), flush: async () => store.flush(), signal: new AbortController().signal });
  return { loop, calls };
}

const KEEP_METHOD = JSON.stringify({ merge: true, reason: "A method.", items: [{ file: METHOD.file, decision: "keep", general: true, why: "Holds for any merchant." }] });
const entriesOf = async (store, claim) => journalEntries(store.journal(claim), BACKGROUND_CONTEXT);

test("a note Jev scores under the bar is dropped before the grader, which reads only the rest; its why is with the grader's items and the check's cost is the grade's", async (t) => {
  const proposal = { seed: "s1", notes: [METHOD, ONE_MERCHANT], asked: ["Card descriptor: SQ *BLUEBIRD BAKERY"] };
  const { store, clock, claim } = await setUp(t, proposal);
  const asked = [];
  const check = async (notes, source, signal, run) => (asked.push({ files: notes.map(({ file }) => file), source, run }), { scores: { [METHOD.file]: 0.91, [ONE_MERCHANT.file]: 0.03 }, usd: 0.00002 });
  const { loop, calls } = loopOn(store, clock, { answer: KEEP_METHOD, general: check });
  assert.deepEqual(await loop.start(claim), { state: "ended" });
  assert.deepEqual(asked, [{ files: [METHOD.file, ONE_MERCHANT.file], source: { job: "Classify each merchant with its four-digit code.", input: "Card descriptor: SQ *BLUEBIRD BAKERY" }, run: "run-1" }]);
  assert.equal(calls.ask.length, 1);
  assert.ok(calls.ask[0].prompt.includes(METHOD.file) && !calls.ask[0].prompt.includes(ONE_MERCHANT.file), "the grader never reads the one-case note");
  assert.deepEqual(calls.commit[0].files.map(({ path }) => path), [METHOD.file]);
  const graded = (await entriesOf(store, claim)).find((entry) => entry.kind === KINDS.learningGraded).data;
  const dropped = graded.verdict.items.find((item) => item.file === ONE_MERCHANT.file);
  assert.equal(dropped.keep, false);
  assert.equal(dropped.question, "General");
  assert.match(dropped.why, /^Jev rates it 0\.03 likely to hold for inputs other than the one it came from, under the bar of 0\.5/);
  assert.ok(Math.abs(graded.usd - 0.01002) < 1e-9, `the grade's cost holds the check's: ${graded.usd}`);
});

test("every note under the bar: the grader is never asked, and the run's learning is dropped with each note's why", async (t) => {
  const { store, clock, claim } = await setUp(t, { seed: "s1", notes: [ONE_MERCHANT], asked: ["SQ *BLUEBIRD BAKERY"] });
  const { loop, calls } = loopOn(store, clock, { answer: KEEP_METHOD, general: async () => ({ scores: { [ONE_MERCHANT.file]: 0.2 }, usd: 0.00001 }), threshold: 0.6 });
  assert.deepEqual(await loop.start(claim), { state: "ended" });
  assert.equal(calls.ask.length, 0, "no grade");
  assert.equal(calls.commit.length, 0, "nothing merged");
  const entries = await entriesOf(store, claim);
  assert.deepEqual(entries.map(({ kind }) => kind), [KINDS.learningGraded, KINDS.learningDropped]);
  const dropped = entries[1].data;
  assert.equal(dropped.reason, "grader");
  assert.match(dropped.detail, /under the bar of 0\.6/);
  assert.equal(entries[0].data.verdict.items[0].question, "General");
  assert.equal((await store.runs.get("learn-1")).state, "ended");
});

test("Jev down: every note goes to the grader, said in the log, and nothing is dropped for it", async (t) => {
  const { store, clock, claim } = await setUp(t, { seed: "s1", notes: [METHOD, ONE_MERCHANT], asked: ["x"] });
  const both = JSON.stringify({ merge: true, reason: "One kept.", items: [{ file: METHOD.file, decision: "keep", general: true, why: "Holds." }, { file: ONE_MERCHANT.file, decision: "drop", question: "General", general: false, why: "One merchant." }] });
  const { loop, calls } = loopOn(store, clock, { answer: both, general: async () => { throw new Error("Jev is down"); } });
  assert.deepEqual(await loop.start(claim), { state: "ended" });
  assert.equal(calls.ask.length, 1);
  assert.ok(calls.ask[0].prompt.includes(ONE_MERCHANT.file), "the grader reads both");
  assert.ok(calls.log.some((line) => /the generality check could not run, so the grader reads every note: Jev is down/.test(line)), calls.log.join("\n"));
  assert.deepEqual(calls.commit[0].files.map(({ path }) => path), [METHOD.file], "the grader's hard General gate still drops the one-case note");
});

test("no Jev on this host (the check answers undefined): graded as before", async (t) => {
  const { store, clock, claim } = await setUp(t, { seed: "s1", notes: [METHOD], asked: ["x"] });
  const { loop, calls } = loopOn(store, clock, { answer: KEEP_METHOD, general: async () => undefined });
  assert.deepEqual(await loop.start(claim), { state: "ended" });
  assert.equal(calls.ask.length, 1);
  assert.equal(calls.commit.length, 1);
});
