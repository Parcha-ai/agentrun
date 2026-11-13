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

test("a check with one request answered and paid and another down throws, whatever the paid one answered: its caller books the cost unknown (below)", async () => {
  let n = 0;
  const provider = { ...fakeJev({}).provider, async decide(request) {
    n += 1;
    if (request.label.endsWith(ONE_MERCHANT.file)) throw new Error("timed out");
    return { answers: { general: { type: "noul", noul: 0.9 } }, evidence: [], model: "jev-test", usage: { input_tokens: 100, output_tokens: 0 }, cost_usd: 0.00001, cost_basis: "estimate", provider_request_id: null };
  } };
  await assert.rejects(general.generalScores(provider, [METHOD, ONE_MERCHANT], {}, new AbortController().signal, "run-1"), /timed out/);
  assert.equal(n, 2, "both requests were sent");
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
  // #2650 review: a check that sent requests and failed spent what nobody knows, so the grade's cost is unknown (null),
  // never the grader's alone; and the skip is kept in the learning run's journal and said in its learning end.
  const graded = (await entriesOf(store, claim)).find((entry) => entry.kind === KINDS.learningGraded).data;
  assert.equal(graded.usd, null, "the check's cost is unknown, so the grade's is");
  assert.equal(graded.unchecked, "Jev is down", "the journal keeps why the check did not run");
  const { runLearningEnd } = await import("../dist/store-reads/learning.js");
  const end = await runLearningEnd(store, "run-1");
  assert.equal(end.state, "merged");
  assert.equal(end.cost_usd.grade, null);
  assert.ok(end.detail.endsWith(general.GENERAL_UNCHECKED), end.detail);
  assert.ok(!end.detail.includes("Jev is down"), "the provider's error stays in the journal and the log");
});

test("Jev down, then the grade fails: the drop keeps the check's skip, and its cost is unknown", async (t) => {
  const { store, clock, claim } = await setUp(t, { seed: "s1", notes: [METHOD], asked: ["x"] });
  // The grader fails too.
  const factory = createLearningLoop({
    sourceOf: async () => ({ runId: "run-1", agentId: "agent-1" }),
    proposal: (runId) => store.learning.proposal(runId),
    folder: (agentId) => ({ workspace: { agentId }, end: async () => {} }),
    readMain: async () => MAIN,
    ask: async () => { throw new Error("grader down"); },
    commit: async () => MERGED,
    mainTexts: async () => ({}),
    merged: async () => undefined,
    now: () => clock.now,
    general: async () => { throw new Error("Jev is down"); },
  });
  const failing = factory({ journal: (c) => store.journal(c), flush: async () => store.flush(), signal: new AbortController().signal });
  assert.deepEqual(await failing.start(claim), { state: "ended" });
  const dropped = (await entriesOf(store, claim)).find((entry) => entry.kind === KINDS.learningDropped).data;
  assert.equal(dropped.reason, "grade_failed");
  assert.equal(dropped.usd, null);
  assert.equal(dropped.unchecked, "Jev is down");
  const { runLearningEnd } = await import("../dist/store-reads/learning.js");
  assert.ok((await runLearningEnd(store, "run-1")).detail.endsWith(general.GENERAL_UNCHECKED));
});

test("the shipped runners give the learning loop a log: a Jev fallback is never silent", async () => {
  const { readFile } = await import("node:fs/promises");
  const main = await readFile(new URL("../src/runner/main.ts", import.meta.url), "utf8");
  const beside = await readFile(new URL("../src/runner/beside.ts", import.meta.url), "utf8");
  const runnerLoopBody = main.slice(main.indexOf("export function runnerLoop("), main.indexOf("export type RunnerParts"));
  assert.match(runnerLoopBody, /\blog: /, "runnerLoop's dispatch deps name a log");
  assert.match(beside.slice(beside.indexOf("const createLoop = dispatchRunner("), beside.indexOf("const { runnerMemory }")), /\blog: /, "runnerBeside's dispatch deps name a log");
});

test("no Jev on this host (the check answers undefined): graded as before", async (t) => {
  const { store, clock, claim } = await setUp(t, { seed: "s1", notes: [METHOD], asked: ["x"] });
  const { loop, calls } = loopOn(store, clock, { answer: KEEP_METHOD, general: async () => undefined });
  assert.deepEqual(await loop.start(claim), { state: "ended" });
  assert.equal(calls.ask.length, 1);
  assert.equal(calls.commit.length, 1);
});

// --- A restart in the middle of the check (#2650 review: "Restarts repeat paid checks") ---
// Jev's requests are paid, and the decision id does not dedupe them (the adapter sends only the state, the model and the
// questions), so the check is made durable as the grader's ask is (learning-ask.ts bookedAsk): its requests are marked
// sent in the learning run's journal before they leave, and its answer and cost are kept there before the grader starts.

/** A loop on `store` whose check and grader are `general` and `ask`, as one attempt of the runner's sees them. */
function attemptOn(store, clock, { general: check, ask }) {
  const calls = { ask: 0, log: [] };
  const factory = createLearningLoop({
    sourceOf: async () => ({ runId: "run-1", agentId: "agent-1", instructions: "Classify each merchant with its four-digit code." }),
    proposal: (runId) => store.learning.proposal(runId),
    folder: (agentId) => ({ workspace: { agentId }, end: async () => {} }),
    readMain: async () => MAIN,
    ask: async (request, signal) => (calls.ask++, ask(request, signal)),
    commit: async () => MERGED,
    mainTexts: async () => ({}),
    merged: async () => undefined,
    now: () => clock.now,
    general: check,
    log: (line) => calls.log.push(line),
  });
  return { loop: factory({ journal: (claim) => store.journal(claim), flush: async () => store.flush(), signal: new AbortController().signal }), calls };
}

/** The runner died: its claim's lease runs out, and another runner claims the learning run. */
async function restart(store, clock) {
  clock.now += 60_001;
  return store.claim("learn-1", "runner-b", { leaseMs: 60_000 });
}

/** A promise that never settles: the process died there. */
const died = () => new Promise(() => {});

test("a restart after Jev answered, before the grade was kept: Jev is not asked again, and its cost is counted once", async (t) => {
  const { store, clock, claim } = await setUp(t, { seed: "s1", notes: [METHOD, ONE_MERCHANT], asked: ["SQ *BLUEBIRD BAKERY"] });
  let jev = 0;
  const check = async (notes, source, signal, run, sending) => {
    await sending?.();
    jev++;
    return { scores: { [METHOD.file]: 0.91, [ONE_MERCHANT.file]: 0.03 }, usd: 0.00002 };
  };
  let grading;
  const asked = new Promise((resolve) => (grading = resolve));
  const first = attemptOn(store, clock, { general: check, ask: () => (grading(), died()) });
  void first.loop.start(claim);
  await asked;
  const again = await restart(store, clock);
  const second = attemptOn(store, clock, { general: check, ask: async (request) => ({ text: KEEP_METHOD, usd: 0.01, prompt: request.prompt }) });
  assert.deepEqual(await second.loop.start(again), { state: "ended" });
  assert.equal(jev, 1, "Jev was asked once in all");
  assert.equal(second.calls.ask, 1);
  const graded = (await entriesOf(store, again)).find((entry) => entry.kind === KINDS.learningGraded).data;
  assert.equal(graded.verdict.items.find((item) => item.file === ONE_MERCHANT.file).question, "General", "the first answer's drop stands");
  assert.ok(Math.abs(graded.usd - 0.01002) < 1e-9, `the check's cost once, with the grade's: ${graded.usd}`);
  assert.ok(Math.abs((await store.runs.get("learn-1")).costUsd - 0.01002) < 1e-9, "the run's cost counts the check once");
});

test("a restart while Jev's requests were out: what they spent is unknown (null, never 0), the check is asked again, and it is said", async (t) => {
  const { store, clock, claim } = await setUp(t, { seed: "s1", notes: [METHOD, ONE_MERCHANT], asked: ["SQ *BLUEBIRD BAKERY"] });
  let jev = 0;
  let sent;
  const out = new Promise((resolve) => (sent = resolve));
  const first = attemptOn(store, clock, {
    general: async (notes, source, signal, run, sending) => { await sending?.(); jev++; sent(); return died(); },
    ask: died,
  });
  void first.loop.start(claim);
  await out;
  const again = await restart(store, clock);
  const second = attemptOn(store, clock, {
    general: async (notes, source, signal, run, sending) => { await sending?.(); jev++; return { scores: { [METHOD.file]: 0.91, [ONE_MERCHANT.file]: 0.03 }, usd: 0.00002 }; },
    ask: async () => ({ text: KEEP_METHOD, usd: 0.01 }),
  });
  assert.deepEqual(await second.loop.start(again), { state: "ended" });
  assert.equal(jev, 2, "the cut check is asked again, as a cut grade's request is");
  const graded = (await entriesOf(store, again)).find((entry) => entry.kind === KINDS.learningGraded).data;
  assert.equal(graded.usd, null, "the cut requests' cost is unknown, so the grade's is");
  assert.equal(graded.verdict.items.find((item) => item.file === ONE_MERCHANT.file).question, "General", "the second answer screens");
  assert.equal((await store.runs.get("learn-1")).costUsd, null, "the run's cost is unknown, never the second check's alone");
  assert.ok(second.calls.log.some((line) => /generality check .*cut .*unknown/.test(line)), second.calls.log.join("\n"));
});

test("a restart after the check failed: it is not asked again, its skip and unknown cost stand", async (t) => {
  const { store, clock, claim } = await setUp(t, { seed: "s1", notes: [METHOD], asked: ["x"] });
  let jev = 0;
  const check = async (notes, source, signal, run, sending) => { await sending?.(); jev++; throw new Error("Jev is down"); };
  let grading;
  const asked = new Promise((resolve) => (grading = resolve));
  const first = attemptOn(store, clock, { general: check, ask: () => (grading(), died()) });
  void first.loop.start(claim);
  await asked;
  const again = await restart(store, clock);
  const second = attemptOn(store, clock, { general: check, ask: async () => ({ text: KEEP_METHOD, usd: 0.01 }) });
  assert.deepEqual(await second.loop.start(again), { state: "ended" });
  assert.equal(jev, 1, "a failed check is kept as failed, never asked again");
  const graded = (await entriesOf(store, again)).find((entry) => entry.kind === KINDS.learningGraded).data;
  assert.equal(graded.usd, null);
  assert.equal(graded.unchecked, "Jev is down");
});

test("generalScores marks its requests sent, once, before any leaves", async () => {
  const order = [];
  const jev = { decide: async () => (order.push("decide"), { answers: { general: { type: "noul", noul: 0.9 } }, cost_usd: 0.00001 }) };
  const notes = [METHOD, ONE_MERCHANT];
  await general.generalScores(jev, notes, { job: "j", input: "i" }, new AbortController().signal, "run-1", async () => { order.push("sent"); });
  assert.deepEqual(order, ["sent", "decide", "decide"]);
});
