// A Mode 2 run whose computer mounts the run's folder from its Archil disk sweeps its scratch (.agentrun/tmp, bash's
// TMPDIR, and .agentrun/output, bash's full outputs) only once the computer is let go. A computer's FUSE mount of the
// folder takes Archil's write delegation, and while it holds, Archil refuses every write to the folder over its file API
// (409 OperationAborted: "another client holds a write delegation"). The sweep goes through the run's own Workspace,
// which is that file API, so a sweep before the computer's release (its final sync and checkin) is refused: the
// Workspace retries the 409 for its 60 s queue, the release logs `remove ".agentrun/tmp": ... 409`, and the folder keeps
// the run's scratch. Both spec builders, pi's (adapterRunSpecFromLaunch) and the CLI harnesses' (cliRunSpecFromLaunch),
// are built over the Archil fake, whose `delegate` stands in for the mount's delegation (fixtures/mode2-mounted-run.mjs).
// The computer's own mkdir of .agentrun/tmp reaches the disk through the mount's sync in a real computer; the fake
// computer is a local folder, so the test lays what that sync would have laid on the disk itself.
import assert from "node:assert/strict";
import { test } from "node:test";

const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { FakeArchilDisk } = await import("./fixtures/archil-fake.mjs");
const { KEY, mode2Run } = await import("./fixtures/mode2-mounted-run.mjs");

const TMP = `${KEY}/.agentrun/tmp`;
const OUTPUT = `${KEY}/.agentrun/output`;
const OUTPUT_FILE = `${OUTPUT}/call-1`;

/** The disk's keys (files and folders) at or under `key`. */
const keysUnder = (disk, key) => [...disk.files.keys(), ...disk.dirs].filter((k) => k === key || k.startsWith(`${key}/`));

/** What the computer's mount synced to the disk during the run: staging's runs left bash's TMPDIR alone, made at the claim
 *  and empty; a run whose bash cut an answer leaves one of its full outputs too. */
const LAYOUTS = [
  ["an empty .agentrun/tmp (as staging's runs left it)", (disk) => {
    disk.dirs.add(`${KEY}/.agentrun`);
    disk.dirs.add(TMP);
  }],
  [".agentrun/tmp and one of bash's full outputs", (disk) => {
    disk.dirs.add(`${KEY}/.agentrun`);
    disk.dirs.add(TMP);
    disk.dirs.add(OUTPUT);
    disk.files.set(OUTPUT_FILE, Buffer.from("a long output\n"));
  }],
];

for (const [name, harness, build] of [["pi's spec", undefined, adapterRunSpecFromLaunch], ["the CLI spec (opencode)", "opencode", cliRunSpecFromLaunch]]) {
  for (const [layout, lay] of LAYOUTS) {
    test(`${name} in Mode 2, ${layout}: the run's release sweeps the scratch after the computer lets the mount's write delegation go`, async (t) => {
      const disk = new FakeArchilDisk();
      const run = await mode2Run(t, { harness, disk });
      const { spec } = await run.claimNext(build);
      assert.equal(run.mounts.length, 1, "the computer mounted the run's folder");
      lay(disk);

      await spec.release();

      assert.deepEqual(disk.refusedByDelegation, [], "no delete of the run's scratch was refused by the mount's delegation");
      assert.deepEqual(keysUnder(disk, TMP), [], ".agentrun/tmp is gone from the disk");
      assert.deepEqual(keysUnder(disk, OUTPUT), [], ".agentrun/output is gone from the disk");
      const released = run.mounts[0].releasedAt;
      assert.ok(released !== undefined, "the computer was released");
      const deletes = disk.calls.flatMap((call, i) => (call.op === "deleteObject" && call.key.startsWith(`${KEY}/.agentrun/`) ? [i] : []));
      assert.ok(deletes.length > 0, "the sweep deleted the scratch over the disk's file API");
      assert.ok(deletes.every((i) => i >= released), `every delete came after the release let the delegation go (deletes at calls ${deletes.join(", ")}, the release at call ${released})`);
    });
  }
}
