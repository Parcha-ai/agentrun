// The learning run's loop factory (runner/learning-factory.ts), the one the runner's main factory picks for a launch of
// harness "learning": its source from the run's launch row and the store, its grader, folder and write passed in. A run
// that learned and ended queues its learning run; a runner claims that run, the factory's loop grades and merges, and the
// learning run ends.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const { learningLoopFactory, LEARNING_HARNESS } = await import("../dist/runner/learning-factory.js");

const NOTE = { file: "retries.md", text: "---\nname: Retries\ndescription: retry twice\n---\nRetry a flaky fetch twice." };
const KEEP = JSON.stringify({ merge: true, reason: "Worth keeping.", items: [{ file: "retries.md", keep: true, why: "useful" }] });

test("a learning run built by the factory goes from its claim to its end: graded, merged, ended", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const source = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const kept = { state: "proposed", notes: ["Retries"], skills: [], workflows: [], proposal: { seed: "s1", notes: [NOTE] }, detail: "Proposed 1 note." };
  await store.runs.update(source, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: kept } }, { table: "learning_run", row: { id: "learn-1" } }] });

  const launch = await store.runs.launch("learn-1");
  assert.equal(launch.body.harness, LEARNING_HARNESS, "the main factory picks this one by the launch's harness");

  const merges = [];
  const factory = learningLoopFactory({
    store,
    workspace: (agentId) => ({ agentId }),
    readMain: async () => ({ active: [], superseded: [], graded: {} }),
    ask: async () => ({ text: KEEP, usd: 0.01 }),
    commit: async (ws, change) => (merges.push({ ws, change }), { ok: true, main: "c0ffee", commit: "c0ffee", files: ["retries.md"] }),
  });
  const claim = await store.claim("learn-1", "runner-b", { leaseMs: 60_000 });
  const loop = factory({ journal: (c) => store.journal(c), flush: () => store.flush(), signal: new AbortController().signal });
  assert.deepEqual(await loop.start(claim), { state: "ended" });
  assert.deepEqual(merges.map(({ ws, change }) => [ws.agentId, change.runId, change.files.map((file) => file.path)]), [["agent-1", "run-1", ["retries.md"]]]);
  assert.equal((await store.runs.get("learn-1")).state, "ended");
});

test("a learning run whose launch names no run that learned fails, saying so", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "learn-2", agentId: "agent-1", revisionId: "rev-1" }, { body: { harness: LEARNING_HARNESS, input: {} } });
  const factory = learningLoopFactory({ store, workspace: () => ({}), readMain: async () => ({ active: [], superseded: [], graded: {} }), ask: async () => ({ text: KEEP, usd: 0 }), commit: async () => assert.fail("no merge") });
  const claim = await store.claim("learn-2", "runner-b", { leaseMs: 60_000 });
  const end = await factory({ journal: (c) => store.journal(c), flush: () => store.flush(), signal: new AbortController().signal }).start(claim);
  assert.equal(end.state, "failed");
  assert.equal(end.error.code, "learning_no_source");
});
