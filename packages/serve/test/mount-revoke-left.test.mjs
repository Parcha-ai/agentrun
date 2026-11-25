// The removes a claim that kept nothing left for the janitor (mount-revoke-left.ts): how a claim leaves one, and the
// janitor's pass over them, against settings in memory that compare and set on the JSON text, as the store's do.
import assert from "node:assert/strict";
import { test } from "node:test";
import { leaveMountRevoke, MOUNT_REVOKE_PREFIX, mountRevokeKeyOf, sweepMountRevokes } from "../dist/workspace/mount-revoke-left.js";

function memorySettings() {
  const rows = new Map();
  const same = (key, was) => rows.has(key) && JSON.stringify(rows.get(key)) === JSON.stringify(was);
  return {
    rows,
    get: async (key) => (rows.has(key) ? structuredClone(rows.get(key)) : undefined),
    put: async (key, value) => void rows.set(key, structuredClone(value)),
    putIfAbsent: async (key, value) => structuredClone(rows.has(key) ? rows.get(key) : (rows.set(key, structuredClone(value)), value)),
    replaceIf: async (key, was, value) => same(key, was) && (rows.set(key, structuredClone(value)), true),
    removeIf: async (key, was) => same(key, was) && rows.delete(key),
    remove: async (key) => void rows.delete(key),
    all: async (filter) => [...rows].filter(([key]) => !filter?.prefix || key.startsWith(filter.prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })),
  };
}

const row = (epoch, until = 1_000) => ({ epoch, disk: "disk-1", until });

test("a pass over left removes whose Archil never answers ends at one bound, not one per row: the rest are left for the next pass, said, and the call asked is cut", { timeout: 10_000 }, async () => {
  const settings = memorySettings();
  const runs = ["run-1", "run-2", "run-3", "run-4", "run-5"];
  for (const run of runs) await settings.put(mountRevokeKeyOf(run), row(3));
  const asked = [];
  let cut = 0;
  // Archil not answering: a call waits until its signal is aborted.
  const revoke = (runId, _left, signal) => {
    asked.push(runId);
    return new Promise((_, reject) => signal.addEventListener("abort", () => { cut += 1; reject(signal.reason); }, { once: true }));
  };
  const started = performance.now();
  const { failed } = await sweepMountRevokes({ settings, revoke, deleteMs: 100 });
  const took = performance.now() - started;
  assert.deepEqual(asked, ["run-1"], "Archil not answering the first, no other is asked this pass");
  assert.equal(cut, 1, "the call asked is cut");
  assert.ok(took < 300, `the pass took ${Math.round(took)} ms: about its one bound of 100 ms, not five`);
  assert.equal(failed.length, 2, failed.join("\n"));
  assert.match(failed[0], /run run-1: .*did not answer within 0\.1 s/);
  assert.match(failed[1], /4 more left Archil mount credential removes .*next pass/);
  assert.equal(settings.rows.size, 5, "every row left for the next pass");
});
