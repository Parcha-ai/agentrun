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

test("passes whose first row's Archil never answers go on past it: the next pass starts after the row its bound cut, so a later row's remove is asked and its row removed, and the hanging one is asked again", { timeout: 10_000 }, async () => {
  const settings = memorySettings();
  for (const run of ["run-1", "run-2", "run-3"]) await settings.put(mountRevokeKeyOf(run), row(3));
  const asked = [];
  // run-1's disk never answers: its call waits until its signal is aborted. The others' answer at once.
  const revoke = async (runId, _left, signal) => {
    asked.push(runId);
    if (runId === "run-1") await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  // One start kept across the passes, as the janitor keeps one.
  const start = {};
  const passes = [];
  for (let pass = 0; pass < 3; pass += 1) passes.push((await sweepMountRevokes({ settings, revoke, deleteMs: 50, start })).failed);
  assert.deepEqual(asked, ["run-1", "run-2", "run-3", "run-1", "run-1"], "pass 1 is cut at run-1; pass 2 starts at run-2 and comes back round to run-1; pass 3 asks run-1 again");
  assert.deepEqual([...settings.rows.keys()], [mountRevokeKeyOf("run-1")], "run-2's and run-3's rows removed by the second pass; run-1's stays for the next");
  assert.match(passes[0].join("\n"), /2 more left Archil mount credential removes were not asked/);
  for (const failed of passes) assert.match(failed[0], /run run-1: .*did not answer within 0\.05 s/);
});

/** `settings` whose first putIfAbsent of `key` finds `value` written there by another between the leave's read and its
 *  write, as a claim of the run ending at the same time does. */
function racing(settings, key, value) {
  let raced = false;
  return {
    ...settings,
    putIfAbsent: async (at, ...rest) => {
      if (at === key && !raced) {
        raced = true;
        await settings.put(key, value);
      }
      return settings.putIfAbsent(at, ...rest);
    },
  };
}

test("a leave writes its row where none is: the epoch, the disk and the time alone", async () => {
  const settings = memorySettings();
  await leaveMountRevoke(settings, "run-1", { ...row(3), token: "not-a-secret" });
  assert.deepEqual(await settings.get(mountRevokeKeyOf("run-1")), row(3));
});

test("a leave keeps a row a later claim left, whose remove reaches this one's credentials too", async () => {
  const settings = memorySettings();
  await settings.put(mountRevokeKeyOf("run-1"), row(5, 2_000));
  await leaveMountRevoke(settings, "run-1", row(3));
  assert.deepEqual(await settings.get(mountRevokeKeyOf("run-1")), row(5, 2_000));
});

test("a leave keeps a row its own epoch left, as written", async () => {
  const settings = memorySettings();
  await settings.put(mountRevokeKeyOf("run-1"), row(3, 2_000));
  await leaveMountRevoke(settings, "run-1", row(3));
  assert.deepEqual(await settings.get(mountRevokeKeyOf("run-1")), row(3, 2_000));
});

test("a leave replaces a row an earlier claim left: its remove reaches the earlier one's credentials too", async () => {
  const settings = memorySettings();
  await settings.put(mountRevokeKeyOf("run-1"), row(2, 2_000));
  await leaveMountRevoke(settings, "run-1", row(3));
  assert.deepEqual(await settings.get(mountRevokeKeyOf("run-1")), row(3));
});

test("a leave whose write loses to an earlier claim's row, written between its read and its write, replaces it", async () => {
  const key = mountRevokeKeyOf("run-1");
  const settings = memorySettings();
  await leaveMountRevoke(racing(settings, key, row(2, 2_000)), "run-1", row(3));
  assert.deepEqual(await settings.get(key), row(3));
});

test("a leave whose write loses to a later claim's row, written between its read and its write, keeps it", async () => {
  const key = mountRevokeKeyOf("run-1");
  const settings = memorySettings();
  await leaveMountRevoke(racing(settings, key, row(5, 2_000)), "run-1", row(3));
  assert.deepEqual(await settings.get(key), row(5, 2_000));
});

test("a leave whose row keeps changing under it throws after its tries, in words", async () => {
  const settings = memorySettings();
  await settings.put(mountRevokeKeyOf("run-1"), row(2));
  let tried = 0;
  const changing = { ...settings, replaceIf: async () => (tried += 1, false) };
  await assert.rejects(leaveMountRevoke(changing, "run-1", row(3)), /run run-1's Archil mount credential remove could not be left for the janitor: its row kept changing/);
  assert.equal(tried, 3);
});

test("a pass removes each row once its remove answers; a refused one stays, said, and the pass goes on to the next", async () => {
  const settings = memorySettings();
  await settings.put(mountRevokeKeyOf("run-1"), row(3));
  await settings.put(mountRevokeKeyOf("run-2"), row(4));
  const asked = [];
  const revoke = async (runId, left) => {
    asked.push([runId, left.epoch, left.disk]);
    if (runId === "run-1") throw new Error("Archil is down");
  };
  const { failed } = await sweepMountRevokes({ settings, revoke, deleteMs: 1_000 });
  assert.deepEqual(asked, [["run-1", 3, "disk-1"], ["run-2", 4, "disk-1"]]);
  assert.deepEqual(failed, ["the Archil mount credential of run run-1: Archil is down"]);
  assert.deepEqual([...settings.rows.keys()], [mountRevokeKeyOf("run-1")], "the refused one stays for the next pass");
});

test("a row a later claim rewrote while its remove ran stays: only the row read is removed", async () => {
  const settings = memorySettings();
  const key = mountRevokeKeyOf("run-1");
  await settings.put(key, row(3));
  const revoke = async () => settings.put(key, row(4, 2_000));
  const { failed } = await sweepMountRevokes({ settings, revoke, deleteMs: 1_000 });
  assert.deepEqual(failed, []);
  assert.deepEqual(await settings.get(key), row(4, 2_000), "the later claim's row stays for the next pass");
});

test("a row that is no left remove is removed, and nothing is asked of Archil for it", async () => {
  const settings = memorySettings();
  await settings.put(`${MOUNT_REVOKE_PREFIX}run-1`, { epoch: "3" });
  const asked = [];
  const { failed } = await sweepMountRevokes({ settings, revoke: async (runId) => void asked.push(runId), deleteMs: 1_000 });
  assert.deepEqual([failed, asked, settings.rows.size], [[], [], 0]);
});
