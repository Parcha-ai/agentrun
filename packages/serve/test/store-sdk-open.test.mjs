// Runs.openSdk: the runs that hold an SDK slot (sdk/runs.ts capFull), counted in one read that stops at its limit, on
// SQLite and on Postgres (npm run test:pg).
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentWithRevision, queued, storeOn } from "./store-helpers.mjs";

const inbox = (runId, extra = {}) => ({ run_id: runId, created_at: 1, expires_at: 2, batches: [], ...extra });

test("openSdk counts the live runs whose inbox is missing or holds no completion and no close, and stops at its limit", async (t) => {
  const { store } = await storeOn(t);
  const nul = String.fromCharCode(0);
  for (const id of ["none", "open", "done", "closed", "nul-open", "nul-done", "ended"]) await queued(store, id);
  await store.settings.put("sdk-run:open", inbox("open"));
  await store.settings.put("sdk-run:done", inbox("done", { completion: { status: "completed", answer: "done" } }));
  await store.settings.put("sdk-run:closed", inbox("closed", { closed: "expired" }));
  // A replay that holds an escaped NUL, which Postgres's json functions refuse in a document read whole.
  await store.settings.put("sdk-run:nul-open", inbox("nul-open", { batches: [{ text: `a${nul}b` }] }));
  await store.settings.put("sdk-run:nul-done", inbox("nul-done", { batches: [{ text: `a${nul}b` }], completion: { status: "completed", answer: `x${nul}` } }));
  await store.settings.put("sdk-run:ended", inbox("ended"));
  await store.runs.update(await store.claim("ended", "runner-test", { leaseMs: 60_000 }), { state: "ended" });
  // Another agent's open run is its own.
  await agentWithRevision(store, "agent-2", "rev-2");
  await store.runs.create({ id: "other", agentId: "agent-2", revisionId: "rev-2" });
  await store.settings.put("sdk-run:other", inbox("other"));

  assert.equal(await store.runs.openSdk("agent-1", 100), 3, "none, open and nul-open");
  assert.equal(await store.runs.openSdk("agent-1", 2), 2, "stopped at its limit");
  assert.equal(await store.runs.openSdk("agent-2", 100), 1);
  assert.equal(await store.runs.openSdk("agent-3", 100), 0);
  for (const limit of [0, -1, 1.5, Number.NaN]) await assert.rejects(store.runs.openSdk("agent-1", limit), TypeError);
});
