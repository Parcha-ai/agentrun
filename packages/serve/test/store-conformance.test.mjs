// pi's own storage conformance suite (@earendil-works/pi-durable/testing) over RunStorage: one run's journal in the one
// store, scoped by run_id, each case on a fresh run in a fresh store file. RunStorage is a pi Storage in every case pi
// itself checks: atomic commits and their seqs, global ids, conversations, entries and their ancestry, tasks,
// submissions, documents and their history, cursors, close.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import { runRow, scratchConnection } from "./store-support.mjs";

const { RunStorage, journalTables } = await import("../dist/store/journal/storage.js");

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

describe("RunStorage passes pi's storage conformance (one run's journal in the one store)", () => {
  let current;
  const cases = createStorageConformance({
    assertions,
    withStorage: async (use) => {
      const connection = current.connection;
      await connection.exec(journalTables());
      const claim = await runRow(connection, `run-${randomUUID()}`, 1);
      const storage = await RunStorage.open(connection, claim);
      await use(storage);
    },
  });
  for (const testCase of cases) {
    it(testCase.name, async (t) => {
      current = { connection: scratchConnection(t) };
      await testCase.run();
    });
  }
});
