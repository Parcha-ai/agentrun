// GET /runs/{id}/learning read from the one store (store-reads/learning.ts runLearningOverStore) is today's response
// for the same run: the run-files read the server answered before the store (todayOf below), with the golden fixtures'
// own learning (the server's grade, captured at 77c24d30db) as the run's, and the seed its pin held. The store's run is
// the same run ended with the same proposal, its learning run graded by the runner with the same verdict, its start's
// seed and given notes on its launch. What differs by nature is put aside: when it happened, and the merge commit's id.
// Then the parts the store gives on its own: the seed is the launch's, never the kept proposal's; a host's secret in a
// note's name reads [redacted]; and what it held for its owner's OK reads as the store's run view reads it, never from
// the folder.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";

const reads = await import("../dist/store-reads/learning.js");
const { runLearningBody, statusesOf } = await import("../dist/learning-routes.js");
const { currentLearning, holdsForOk, LEARNING_PIN, readPin, secretsShown } = await import("../dist/learning.js");
const { learningLoopFactory } = await import("../dist/runner/learning-factory.js");
const fn = (module, name) => (typeof module[name] === "function" ? module[name] : () => assert.fail(`${name} is not there`));
const runLearningOverStore = (...args) => fn(reads, "runLearningOverStore")(...args);

const GOLDEN = JSON.parse(readFileSync(new URL("./fixtures/learning-end-golden.json", import.meta.url), "utf8"));
const answerOf = (verdict) => JSON.stringify({
  merge: verdict.merge, reason: verdict.reason,
  items: verdict.items.map((item) => ({ file: item.file, decision: item.pending ? "pending" : item.keep ? "keep" : "drop", ...(item.origin ? { origin: item.origin } : {}), ...(item.question ? { question: item.question } : {}), ...(item.why ? { why: item.why } : {}) })),
});
/** A response as compared: its time and its merge commit's id put aside (a sha, or not). */
const comparable = (body) => body && { ...body, at: "<time>", merged: typeof body.merged === "string" && /^[0-9a-f]{40}$/.test(body.merged) ? "<sha>" : body.merged };

/** Golden case `golden`'s run in a store: started with `launchLearning` on its launch, ended with the case's proposal,
 *  its learning run graded with the case's verdict (none: the grader fails). */
async function storedAs(t, golden, launchLearning) {
  const { store, dir } = await storeOn(t);
  await store.agents.create({ id: golden.agentId, name: golden.agentId }, { id: "rev-1", kind: "agentic", body: { instructions: golden.instructions } });
  await store.runs.create({ id: golden.runId, agentId: golden.agentId, revisionId: "rev-1" }, { body: { input: { content: "Go." }, title: "t", place: { mode: "runner" }, learning: launchLearning } });
  const source = await store.claim(golden.runId, "runner-a", { leaseMs: 60_000 });
  const kept = { ...(golden.proposed.problems ? { left: golden.proposed.problems } : {}), state: "proposed", proposal: golden.proposal, detail: golden.proposed.detail };
  await store.runs.update(source, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: kept } }, { table: "learning_run", row: { id: `${golden.runId}-learning` } }] });
  const verdict = golden.saved.verdict;
  const ask = async () => {
    if (!verdict) throw new Error("the faux grader failed on purpose");
    return { text: answerOf(verdict), usd: golden.saved.cost_usd?.grade ?? null, tokens: golden.saved.tokens?.grade ?? null };
  };
  const claim = await store.claim(`${golden.runId}-learning`, "runner-b", { leaseMs: 60_000 });
  await learningLoopFactory({ refuse: async () => [], store, data: dir, ask })({ journal: (c) => store.journal(c), flush: () => store.flush(), signal: new AbortController().signal }).start(claim);
  return { store, dir };
}

/** The run-files read the server answered GET /runs/{id}/learning with before the store, kept here as this test's oracle:
 *  what the run held for its owner's OK as its folder reads now, the seed its pin holds, through the one body shape. */
async function runLearning(run, shown, secrets, data) {
  const learning = holdsForOk(run.meta.learning) ? currentLearning(run.meta.learning, await statusesOf(data, run.agentId)) : run.meta.learning;
  if (!learning) return null;
  const pin = await readPin(run.dir).catch(() => undefined);
  return runLearningBody({ id: run.id, learning, seed: pin?.seed ?? null, settled: run.settled }, shown, secrets);
}

/** Today's response for golden case `golden`: the oracle over a run whose learning is the case's own and whose pin
 *  holds `seed`, its agent's folder the store's (the same data directory). */
async function todayOf(golden, seed, dir, shown, secrets) {
  const runDir = mkdtempSync(join(tmpdir(), "run-learning-"));
  writeFileSync(join(runDir, LEARNING_PIN), JSON.stringify({ seed }));
  const run = { id: golden.runId, agentId: golden.agentId, dir: runDir, settled: true, meta: { learning: golden.saved } };
  return runLearning(run, shown, secrets, dir);
}

for (const golden of GOLDEN) {
  test(`${golden.id}: GET /runs/{id}/learning from the store is today's response for the same run`, async (t) => {
    const seed = golden.proposal.seed;
    const { store, dir } = await storedAs(t, golden, { seed });
    const shown = secretsShown([]);
    assert.deepEqual(comparable(await runLearningOverStore(store, golden.runId, shown, [])), comparable(await todayOf(golden, seed, dir, shown, [])));
  });
}

test("the seed is the one the run's launch records, never the kept proposal's", async (t) => {
  const golden = GOLDEN.find((one) => one.id === "you");
  const { store } = await storedAs(t, golden, { seed: "a".repeat(40) });
  const body = await runLearningOverStore(store, golden.runId, secretsShown([]), []);
  assert.equal(body.seed, "a".repeat(40), "the launch's seed");
  assert.notEqual(body.seed, golden.proposal.seed);
  const { store: none } = await storedAs(t, golden, {});
  assert.equal((await runLearningOverStore(none, golden.runId, secretsShown([]), [])).seed, null, "a launch with none: none");
});

test("a host's secret in a note's name reads [redacted] in what the run learned and in the verdict, as today", async (t) => {
  const golden = GOLDEN.find((one) => one.id === "you");
  const { store, dir } = await storedAs(t, golden, { seed: golden.proposal.seed });
  const secret = "check-units";
  const shown = secretsShown([secret]);
  const body = await runLearningOverStore(store, golden.runId, shown, [secret]);
  assert.ok(!JSON.stringify(body).includes(secret), "no part of the secret shows");
  assert.ok(JSON.stringify(body.verdict).includes("[redacted]"), `the verdict's item names it [redacted]: ${JSON.stringify(body.verdict)}`);
  assert.deepEqual(comparable(body), comparable(await todayOf(golden, golden.proposal.seed, dir, shown, [secret])));
});

test("what a run held for its owner's OK reads as the store's run view reads it: the folder is never read", async (t) => {
  const golden = GOLDEN.find((one) => one.id === "pending");
  const { store } = await storedAs(t, golden, { seed: golden.proposal.seed });
  // The store's read takes no data directory: it cannot read the folder. Its held notes are the learning end's.
  assert.equal(reads.runLearningOverStore?.length, 4, "store, run, shown, secrets: no folder");
  const body = await runLearningOverStore(store, golden.runId, secretsShown([]), []);
  assert.deepEqual(body.pending.map((note) => note.file), golden.saved.pending.map((note) => note.file), "held as its learning end says");
});
