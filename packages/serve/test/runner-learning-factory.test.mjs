// The learning run's loop factory (runner/learning-factory.ts), the one the runner's main factory picks for a launch of
// harness "learning": its source from the run's launch row and the store, its grader passed in, and the agent's own
// learning folder in the server's data (learningWorkspace, readMain, learningCommit). A run that learned and ended
// queues its learning run; a runner claims that run, the factory's loop grades and merges into the folder, and the
// learning run ends.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const { learningLoopFactory, LEARNING_HARNESS } = await import("../dist/runner/learning-factory.js");
const { folderTestHooks, learningWorkspace, readSnapshot } = await import("../dist/learn/folder.js");

const NOTE = { file: "retries.md", text: "---\nname: Retries\ndescription: Retry a flaky fetch twice\ntype: reference\n---\nRetry a flaky fetch twice.\n" };
const KEEP = JSON.stringify({ merge: true, reason: "Worth keeping.", items: [{ file: "retries.md", decision: "keep", why: "useful" }] });

/** A fresh store: run-1 ended keeping NOTE, its learning run claimed and run by the factory's loop on agent-1's
 *  folder, the grader answering `answer`. The loop's end. */
async function learnedOnce(t, answer) {
  const { store, dir } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const source = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const kept = { state: "proposed", notes: ["Retries"], skills: [], workflows: [], proposal: { notes: [NOTE] }, detail: "Proposed 1 note." };
  await store.runs.update(source, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: kept } }, { table: "learning_run", row: { id: "learn-1" } }] });
  const claim = await store.claim("learn-1", "runner-b", { leaseMs: 60_000 });
  const factory = learningLoopFactory({ refuse: async () => [], store, data: dir, ask: async () => ({ text: answer, usd: 0.01 }) });
  return { end: await factory({ journal: (c) => store.journal(c), flush: () => store.flush(), signal: new AbortController().signal }).start(claim) };
}

test("a learning run built by the factory goes from its claim to its end: graded, merged into the agent's folder, ended", async (t) => {
  const { store, dir } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const source = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const kept = { state: "proposed", notes: ["Retries"], skills: [], workflows: [], proposal: { notes: [NOTE] }, detail: "Proposed 1 note." };
  await store.runs.update(source, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: kept } }, { table: "learning_run", row: { id: "learn-1" } }] });

  const launch = await store.runs.launch("learn-1");
  assert.equal(launch.body.harness, LEARNING_HARNESS, "the main factory picks this one by the launch's harness");

  const factory = learningLoopFactory({ refuse: async () => [], store, data: dir, ask: async () => ({ text: KEEP, usd: 0.01 }) });
  const claim = await store.claim("learn-1", "runner-b", { leaseMs: 60_000 });
  const loop = factory({ journal: (c) => store.journal(c), flush: () => store.flush(), signal: new AbortController().signal });
  assert.deepEqual(await loop.start(claim), { state: "ended" });
  assert.equal((await store.runs.get("learn-1")).state, "ended");
  const { workspace, end } = learningWorkspace({ mode: "local", agentId: "agent-1", data: dir });
  try {
    const snapshot = await readSnapshot(workspace);
    assert.deepEqual(snapshot.notes.map((note) => [note.file, note.status]), [["retries.md", "active"]], "merged into agent-1's own folder");
    assert.deepEqual([snapshot.log[0]?.by, snapshot.log[0]?.files], [{ run: "run-1" }, ["MEMORY.md", "retries.md"]], "the commit names the run that learned");
  } finally {
    await end();
  }
});

test("the folder is ended once on every way out of a learning run: a merge, and a read of main that throws", async (t) => {
  const ends = [];
  let broken = false;
  const hook = (place) => {
    delete folderTestHooks.workspace;
    try {
      const real = learningWorkspace(place);
      const gone = async () => { throw new Error("the folder's disk is gone"); };
      const workspace = broken ? { ...real.workspace, read: gone, exec: gone, list: gone } : real.workspace;
      return { workspace, end: async () => { ends.push(place.agentId); await real.end(); } };
    } finally {
      folderTestHooks.workspace = hook;
    }
  };
  folderTestHooks.workspace = hook;
  t.after(() => { delete folderTestHooks.workspace; });

  const merged = await learnedOnce(t, KEEP);
  assert.deepEqual(merged.end, { state: "ended" });
  assert.deepEqual(ends, ["agent-1"], "ended after the merge");
  broken = true;
  await assert.rejects(learnedOnce(t, KEEP), /the folder's disk is gone/);
  assert.deepEqual(ends, ["agent-1", "agent-1"], "ended after the throw too");
});

test("a learning run whose launch names no run that learned fails, saying so, and opens no folder", async (t) => {
  const { store, dir } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "learn-2", agentId: "agent-1", revisionId: "rev-1" }, { body: { harness: LEARNING_HARNESS, input: {} } });
  const factory = learningLoopFactory({ refuse: async () => [], store, data: dir, ask: async () => assert.fail("no grade") });
  const claim = await store.claim("learn-2", "runner-b", { leaseMs: 60_000 });
  const end = await factory({ journal: (c) => store.journal(c), flush: () => store.flush(), signal: new AbortController().signal }).start(claim);
  assert.equal(end.state, "failed");
  assert.equal(end.error.code, "learning_no_source");
});
