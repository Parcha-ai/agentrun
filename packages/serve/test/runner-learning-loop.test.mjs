// The built-in learning run (runner/learning-loop.ts): a queued run of harness "learning" that a runner claims like any
// run. It grades what its source run kept (learning_proposals) through the grader call it is given, writes the verdict
// before the merge, merges what the grader keeps through the folder's one write (learningCommit, faked here), and ends:
// merged and ended; stale (main moved), dropped and ended; refused by the checker, failed; the folder unreachable, parked
// with a wake, the grade never asked again. The grader's prompt is the server's (learn/grade.ts gradePrompt), asked once
// more on an answer it cannot read, as grade.ts did.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const { createLearningLoop, GRADE_MAX_TOKENS, GRADE_TIMEOUT_MS, UNAVAILABLE_BACKOFF_MS } = await import("../dist/runner/learning-loop.js");
const { KINDS } = await import("../dist/runner/journal-kinds.js");
const { journalEntries } = await import("../dist/runner/journal-reader.js");
const { gradePrompt } = await import("../dist/learn/grade.js");

const NOTE = { file: "retries.md", text: "---\nname: Retries\ndescription: retry twice\n---\nRetry a flaky fetch twice." };
const PROPOSAL = { seed: "s1", notes: [NOTE], asked: ["please be careful with retries"] };
const MAIN = { active: [], superseded: [], graded: { "old.md": "oid-1" } };
const KEEP = JSON.stringify({ merge: true, reason: "Worth keeping.", items: [{ file: "retries.md", keep: true, why: "useful" }] });
const DROP = JSON.stringify({ merge: false, reason: "Too vague to help.", items: [{ file: "retries.md", keep: false, why: "vague" }] });
const MERGED = { ok: true, main: "c0ffee", commit: "c0ffee", files: ["retries.md"] };

/** A source run that ended keeping PROPOSAL, and its queued learning run, claimed by a runner. */
async function setUp(t) {
  const { store, clock } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const source = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  await store.runs.update(source, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: { answer: "…" }, proposal: PROPOSAL } }, { table: "learning_run", row: { id: "learn-1" } }] });
  const claim = await store.claim("learn-1", "runner-a", { leaseMs: 60_000 });
  return { store, clock, claim };
}

/** The learning loop over the store, with fakes for the grader, the folder and its write; `calls` counts each. */
function loopOn(store, clock, { answers = [KEEP], commit = async () => MERGED, readMain = async () => MAIN } = {}) {
  const calls = { ask: [], commit: [], flush: 0 };
  const queue = [...answers];
  const factory = createLearningLoop({
    sourceOf: async () => ({ runId: "run-1", agentId: "agent-1", instructions: "Be brief." }),
    proposal: (runId) => store.learning.proposal(runId),
    workspace: (agentId) => ({ agentId }),
    readMain,
    ask: async (request, signal) => {
      calls.ask.push({ request, aborted: signal.aborted });
      const answer = queue.shift();
      if (answer instanceof Error) throw answer;
      return { text: answer, usd: 0.01 };
    },
    commit: async (ws, change) => (calls.commit.push({ ws, change }), commit(ws, change)),
    now: () => clock.now,
  });
  const loop = factory({ journal: (claim) => store.journal(claim), flush: async () => (calls.flush++, store.flush()), signal: new AbortController().signal });
  return { loop, calls };
}

const kindsOf = async (store, claim) => (await journalEntries(store.journal(claim), BACKGROUND_CONTEXT)).map((entry) => entry.kind);

test("a kept proposal is graded, then merged through the folder's one write, and the run ends", async (t) => {
  const { store, clock, claim } = await setUp(t);
  const { loop, calls } = loopOn(store, clock);
  assert.deepEqual(await loop.start(claim), { state: "ended" });
  assert.equal(calls.ask.length, 1, "the grader asked once");
  assert.equal(calls.commit.length, 1, "one merge");
  assert.deepEqual(calls.commit[0].change, { kind: "merge", runId: "run-1", reason: "Worth keeping.", files: [{ path: "retries.md", text: NOTE.text }], graded: MAIN.graded });
  assert.deepEqual(await kindsOf(store, claim), [KINDS.learningGraded, KINDS.learningMerged]);
  assert.equal((await store.runs.get("learn-1")).state, "ended");
});

test("the grader's prompt and bounds are the server's: gradePrompt over the same input, GRADE_MAX_TOKENS, its timeout", async (t) => {
  const { store, clock, claim } = await setUp(t);
  const { loop, calls } = loopOn(store, clock);
  await loop.start(claim);
  const expected = gradePrompt({ run: "run-1", instructions: "Be brief.", active: [], superseded: [], proposed: [NOTE], asked: PROPOSAL.asked });
  assert.equal(calls.ask[0].request.prompt, expected);
  assert.equal(calls.ask[0].request.maxTokens, GRADE_MAX_TOKENS);
  // The same figures the server's grade.ts used, while it is still in the tree.
  const server = readFileSync(new URL("../src/grade.ts", import.meta.url), "utf8");
  assert.match(server, new RegExp(`GRADE_TIMEOUT_MS = ${GRADE_TIMEOUT_MS.toLocaleString("en-US").replace(/,/g, "_")};`));
  assert.match(server, new RegExp(`GRADE_MAX_TOKENS = ${GRADE_MAX_TOKENS.toLocaleString("en-US").replace(/,/g, "_")};`));
});

test("an answer the grader's reader can't read is asked once more; two such answers drop it unread", async (t) => {
  const { store, clock, claim } = await setUp(t);
  const { loop, calls } = loopOn(store, clock, { answers: ["not json", "still not json"] });
  assert.deepEqual(await loop.start(claim), { state: "ended" });
  assert.equal(calls.ask.length, 2, "asked twice");
  assert.equal(calls.commit.length, 0, "nothing merged");
  assert.deepEqual(await kindsOf(store, claim), [KINDS.learningGraded, KINDS.learningDropped]);
});

test("a verdict that keeps nothing is dropped with the grader's words, and nothing is written to the folder", async (t) => {
  const { store, clock, claim } = await setUp(t);
  const { loop, calls } = loopOn(store, clock, { answers: [DROP] });
  assert.deepEqual(await loop.start(claim), { state: "ended" });
  assert.equal(calls.commit.length, 0);
  const entries = await journalEntries(store.journal(claim), BACKGROUND_CONTEXT);
  const dropped = entries.find((entry) => entry.kind === KINDS.learningDropped).data;
  assert.equal(dropped.reason, "grader");
  assert.match(dropped.detail, /^Not kept: /);
});

test("main moved under the merge (a conflict): dropped as stale, the run ended", async (t) => {
  const { store, clock, claim } = await setUp(t);
  const { loop } = loopOn(store, clock, { commit: async () => ({ ok: false, reason: "conflict", problems: [{ rule: "supersedes", path: "old.md", detail: "moved" }] }) });
  assert.deepEqual(await loop.start(claim), { state: "ended" });
  const entries = await journalEntries(store.journal(claim), BACKGROUND_CONTEXT);
  assert.equal(entries.find((entry) => entry.kind === KINDS.learningDropped).data.reason, "stale");
  assert.equal((await store.runs.get("learn-1")).state, "ended");
});

test("the checker refused the merged folder: the run fails, its problems named", async (t) => {
  const { store, clock, claim } = await setUp(t);
  const { loop } = loopOn(store, clock, { commit: async () => ({ ok: false, reason: "refused", problems: [{ rule: "index", detail: "the index is past its lines" }] }) });
  const end = await loop.start(claim);
  assert.equal(end.state, "failed");
  assert.match(end.error.message, /the index is past its lines/);
  assert.equal((await store.runs.get("learn-1")).state, "failed");
});

test("the folder unreachable: the run parks with a wake after the backoff, and its resume merges without asking the grader again", async (t) => {
  const { store, clock, claim } = await setUp(t);
  let reachable = false;
  const { loop, calls } = loopOn(store, clock, { commit: async () => (reachable ? MERGED : { ok: false, reason: "unavailable", error: "the folder's exec timed out" }) });
  const parked = await loop.start(claim);
  assert.deepEqual(parked, { state: "parked", wakeAt: clock.now + UNAVAILABLE_BACKOFF_MS[0] });
  assert.equal((await store.runs.get("learn-1")).state, "parked");
  // The runner releases it parked; at its wake another claim resumes it.
  await store.release(claim, { state: "parked", wakeAt: parked.wakeAt });
  clock.now = parked.wakeAt + 1;
  const again = await store.claim("learn-1", "runner-b", { leaseMs: 60_000 });
  reachable = true;
  const second = loopOn(store, clock, { commit: async () => MERGED });
  assert.deepEqual(await second.loop.start(again), { state: "ended" });
  assert.equal(calls.ask.length + second.calls.ask.length, 1, "the grader asked once in all");
  assert.equal(second.calls.commit.length, 1);
});

test("a stop row ends the learning run stopped, its row taken, with nothing merged", async (t) => {
  const { store, clock, claim } = await setUp(t);
  const { loop, calls } = loopOn(store, clock);
  const stop = await store.command("learn-1", { kind: "stop" });
  await loop.stop({ kind: "command", commandId: stop.id });
  const end = await loop.start(claim);
  assert.equal(end.state, "stopped");
  assert.equal(calls.commit.length, 0, "nothing merged");
  assert.equal((await store.runs.get("learn-1")).state, "stopped");
  assert.notEqual((await store.commands("learn-1", 0)).find((row) => row.id === stop.id).takenAt, null, "its row taken");
});

test("a learning run whose source kept nothing ends with nothing graded", async (t) => {
  const { store, clock } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "learn-2", agentId: "agent-1", revisionId: "rev-1" });
  const claim = await store.claim("learn-2", "runner-a", { leaseMs: 60_000 });
  const { loop, calls } = loopOn(store, clock);
  assert.deepEqual(await loop.start(claim), { state: "ended" });
  assert.equal(calls.ask.length, 0);
  assert.deepEqual(await kindsOf(store, claim), [KINDS.learningDropped]);
});
