// An imported run's summary row over the one store (store-reads/import-summary.ts foundOverStore): its source and agent,
// the metrics the import wrote, and its requests' hours from its journal — read from A, not a run's own database. A run not
// held as imported is undefined.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { agentWithRevision, storeOn, T0 } from "./store-helpers.mjs";

const { launchBody } = await import("../dist/run-launch.js");
const { foundOverStore } = await import("../dist/store-reads/import-summary.js");

const context = BACKGROUND_CONTEXT;
const ROOT = 1;
const launch = () => ({ body: launchBody({ input: { content: "x" }, title: "x", place: { mode: "runner" } }) });
const at = Date.parse("2026-11-08T09:00:00Z"); // a request time; hoursOf buckets by local hour

test("foundOverStore reads an imported run's source, agent, metrics and hours from A", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  const metrics = { input: 100, cacheRead: 20, cacheWrite: 0, output: 30, requests: 2, unmetered: 0, models: {}, tools: { read: { calls: 3, errors: 0 } }, activeMs: 5000 };
  await store.importRun({
    id: "imp-1", agentId: "agent-1", revisionId: "rev-1", importedFrom: { source: "codex", session: "s-1" }, launch: launch(), metrics, startedAt: T0,
    transcript: [[{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: { id: 2, conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", content: "hi", timestamp: at }] } }]],
  });

  const found = await foundOverStore(store, "imp-1", context);
  assert.equal(found.source, "codex");
  assert.equal(found.agent, "agent-1");
  assert.deepEqual(found.metrics, { input: 100, cacheRead: 20, cacheWrite: 0, output: 30, tools: { read: { calls: 3, errors: 0 } }, activeMs: 5000 }, "the summary's slice of the metrics");
  assert.equal(found.hours.reduce((a, b) => a + b, 0), 1, "one request's hour counted");
  assert.equal(found.hours[new Date(at).getHours()], 1, "at its local hour");
});

test("a run not held as imported is undefined", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "live", agentId: "agent-1", revisionId: "rev-1" });
  assert.equal(await foundOverStore(store, "live", context), undefined);
  assert.equal(await foundOverStore(store, "nope", context), undefined);
});
