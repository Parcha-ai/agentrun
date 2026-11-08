// Store.importRun writes an imported run whole, in one transaction: the ended run row (imported_from, outcome, cost,
// summary, metrics), its launch row and its transcript's journal. The readers then treat it like any other run — its row,
// its launch and its entries all read back. A crash mid-import leaves nothing; a session imported twice is refused.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { agentWithRevision, storeOn, T0 } from "./store-helpers.mjs";

const { StoreConstraint, StoreLaunchMissing } = await import("../dist/store/index.js");
const { launchBody } = await import("../dist/run-launch.js");
const { runEntries } = await import("../dist/store-reads/journal.js");
const { readRun } = await import("../dist/store-reads/runs.js");

const context = BACKGROUND_CONTEXT;
const ROOT = 1;
const transcript = () => [[
  { type: "conversation", value: { id: ROOT } },
  { type: "entry", value: { id: 2, conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "do it" }] } },
  { type: "entry", value: { id: 3, conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", content: "done" }] } },
]];
const launch = () => ({ body: launchBody({ input: { content: "do it" }, title: "do it", place: { mode: "runner" } }) });

test("importRun writes the run, its launch and its transcript in one transaction; the readers read them back", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  const metrics = { input: 10, cacheRead: 0, cacheWrite: 0, output: 5, requests: 1, unmetered: 0, models: {}, tools: {} };
  await store.importRun({ id: "imp-1", agentId: "agent-1", revisionId: "rev-1", importedFrom: { source: "codex", session: "s-1" }, launch: launch(), outcome: "completed", costUsd: 0.3, summary: "did it", metrics, startedAt: T0, endedAt: T0 + 1000, transcript: transcript() });

  const row = await store.runs.get("imp-1");
  assert.equal(row.state, "ended");
  assert.equal(row.outcome, "completed");
  assert.deepEqual(row.importedFrom, { source: "codex", session: "s-1" });
  assert.equal(row.costUsd, 0.3);
  assert.equal(row.summary, "did it");
  assert.equal(row.startedAt, T0);
  assert.equal(row.endedAt, T0 + 1000);
  assert.deepEqual(row.metrics, metrics);

  assert.deepEqual((await store.runs.launch("imp-1")).body, launchBody({ input: { content: "do it" }, title: "do it", place: { mode: "runner" } }));
  assert.deepEqual((await runEntries(store, "imp-1", context)).map((e) => e.kind), ["pi.user", "pi.assistant"], "its transcript");
  assert.deepEqual((await readRun(store, "imp-1", context)).importedFrom, { source: "codex", session: "s-1" }, "the view names where it came from");
});

test("a crash mid-import leaves nothing: a failing transcript rolls back the run and its launch too", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  // A second batch reuses an id the first batch wrote: the journal refuses it, so the whole transaction rolls back.
  const bad = [transcript()[0], [{ type: "entry", value: { id: 2, conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "again" }] } }]];
  await assert.rejects(store.importRun({ id: "imp-bad", agentId: "agent-1", revisionId: "rev-1", importedFrom: { source: "codex", session: "s-bad" }, launch: launch(), startedAt: T0, transcript: bad }));
  assert.equal(await store.runs.get("imp-bad"), undefined, "no run row");
  await assert.rejects(store.runs.launch("imp-bad"), StoreLaunchMissing, "no launch row");
  assert.deepEqual(await runEntries(store, "imp-bad", context), [], "no journal");
});

test("a session imported twice is refused (one run per source and session)", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  await store.importRun({ id: "imp-a", agentId: "agent-1", revisionId: "rev-1", importedFrom: { source: "pi", session: "same" }, launch: launch(), startedAt: T0, transcript: transcript() });
  await assert.rejects(store.importRun({ id: "imp-b", agentId: "agent-1", revisionId: "rev-1", importedFrom: { source: "pi", session: "same" }, launch: launch(), startedAt: T0, transcript: transcript() }), StoreConstraint, "the session is one run's");
  assert.equal(await store.runs.get("imp-b"), undefined, "the second run is not written");
});
