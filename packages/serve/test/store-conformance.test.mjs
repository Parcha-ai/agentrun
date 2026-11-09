// pi's own storage conformance suite (@earendil-works/pi-durable/testing) over the store's journal: store.journal(claim) on
// the one store (openSqliteStore, its connection on a worker; openPostgresStore with AGENTRUN_TEST_PG_URL), scoped by
// run_id, each case on a fresh claimed run in a fresh store file (or schema). The journal is a pi Storage in every case pi itself checks: atomic commits and their seqs, global
// ids, conversations, entries and their ancestry, tasks, submissions, documents and their history, cursors, close.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import { storeOn } from "./store-helpers.mjs";

/** pi's assertions on node:assert. */
const assertions = {
  ok: (value, message) => assert.ok(value, message),
  strictEqual: (actual, expected) => assert.strictEqual(actual, expected),
  deepEqual: (actual, expected) => assert.deepStrictEqual(actual, expected),
  partialDeepEqual: (actual, expected) => assert.partialDeepStrictEqual(actual, expected),
  greaterThan: (actual, expected) => assert.ok(actual > expected, `${actual} > ${expected}`),
  rejects: async (operation, messageIncludes) => {
    await assert.rejects(operation, (error) => (messageIncludes === undefined ? true : String(error?.message ?? error).includes(messageIncludes)));
  },
};

/** The one store of test `t` (a scratch file, or a Postgres schema: store-helpers.mjs), closed and removed after it. */
async function scratchStore(t) {
  const { store } = await storeOn(t, { clock: { get now() { return Date.now(); } } });
  await store.agents.put({ id: "agent-1", name: "Agent" });
  await store.agents.addRevision({ id: "rev-1", agentId: "agent-1", kind: "agentic", body: {} });
  return store;
}

describe("the store's journal passes pi's storage conformance (one run's journal in the one store)", () => {
  let current;
  const cases = createStorageConformance({
    assertions,
    withStorage: async (use) => {
      const { store } = current;
      const run = await store.runs.create({ id: `run-${randomUUID()}`, agentId: "agent-1", revisionId: "rev-1" });
      const claim = await store.claim(run.id, "runner-1");
      assert.ok(claim, "the run is claimed");
      await use(store.journal(claim));
    },
  });
  for (const testCase of cases) {
    it(testCase.name, async (t) => {
      current = { store: await scratchStore(t) };
      await testCase.run();
    });
  }
});
