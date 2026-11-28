// A Mode 2 run whose computer mounts the run's folder from its Archil disk sweeps its scratch (.agentrun/tmp, bash's
// TMPDIR, and .agentrun/output, bash's full outputs) through the computer, at its end and before its end commit. A
// computer's FUSE mount of the folder takes Archil's write delegation, and while it holds, Archil refuses every write and
// delete under the folder over its file API (409 OperationAborted: "another client holds a write delegation"). The sweep
// used to remove through the run's own Workspace, which is that file API: the Workspace retried the 409 for its 60 s
// queue, the release logged `remove ".agentrun/tmp": ... 409`, and the owner's folder kept the scratch. It cannot simply
// wait for the computer's release instead: the end commit may reopen the run for a follow-up that another claim takes
// at once, in the same folder, whose scratch a late sweep would remove.
// Both spec builders, pi's (adapterRunSpecFromLaunch) and the CLI harnesses' (cliRunSpecFromLaunch), are built over the
// Archil fake, whose `delegate` stands in for the mount's delegation (fixtures/mode2-mounted-run.mjs). The fake computer
// is a local folder that does not reach the disk; a real computer's calls sync to the disk before they answer. So the
// test lays the scratch in both, as the mount's sync would have, and reads the sweep in the computer's folder and in the
// disk's calls.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { FakeArchilDisk } = await import("./fixtures/archil-fake.mjs");
const { KEY, mode2Run } = await import("./fixtures/mode2-mounted-run.mjs");

/** What the computer's mount synced to the disk during the run: staging's runs left bash's TMPDIR alone, made at the claim
 *  and empty; a run whose bash cut an answer leaves one of its full outputs too. */
const LAYOUTS = [
  ["an empty .agentrun/tmp (as staging's runs left it)", []],
  [".agentrun/tmp and one of bash's full outputs", [".agentrun/output/call-1"]],
];

for (const [name, harness, build] of [["pi's spec", undefined, adapterRunSpecFromLaunch], ["the CLI spec (opencode)", "opencode", cliRunSpecFromLaunch]]) {
  for (const [layout, files] of LAYOUTS) {
    test(`${name} in Mode 2, ${layout}: the run's end sweeps its scratch through the computer before the end commit, and nothing goes to the disk's file API while the mount holds it`, async (t) => {
      const disk = new FakeArchilDisk();
      const run = await mode2Run(t, { harness, disk });
      const { spec } = await run.claimNext(build);
      assert.equal(run.mounts.length, 1, "the computer mounted the run's folder");
      assert.ok(existsSync(join(run.scratch, ".agentrun", "tmp")), "the claim made TMPDIR through the computer");
      // The same scratch on the disk, as the mount's sync laid it.
      for (const key of [`${KEY}/.agentrun`, `${KEY}/.agentrun/tmp`]) disk.dirs.add(key);
      for (const file of files) {
        mkdirSync(join(run.scratch, file, ".."), { recursive: true });
        writeFileSync(join(run.scratch, file), "a long output\n");
        disk.dirs.add(`${KEY}/${file.split("/").slice(0, -1).join("/")}`);
        disk.files.set(`${KEY}/${file}`, Buffer.from("a long output\n"));
      }
      const before = disk.calls.length;

      // The run's end, as the loop runs it before its end commit (adapter-loop.ts: spec.endCheckout).
      await spec.endCheckout();

      assert.equal(run.mounts[0].releasedAt, undefined, "the computer is not let go yet: its mount still holds the folder");
      assert.ok(!existsSync(join(run.scratch, ".agentrun", "tmp")), ".agentrun/tmp is gone from the computer's folder");
      assert.ok(!existsSync(join(run.scratch, ".agentrun", "output")), ".agentrun/output is gone from the computer's folder");
      const deletes = disk.calls.slice(before).filter((call) => call.op === "deleteObject" || call.op === "deleteObjects");
      assert.deepEqual(deletes, [], "nothing was deleted over the disk's file API");
      assert.deepEqual(disk.refusedByDelegation, [], "and nothing was refused by the mount's delegation");

      await spec.release();
      assert.deepEqual(disk.refusedByDelegation, [], "the release wrote nothing the delegation refused either");
    });
  }
}

// A claim the runner lost (its fence says so, LoopDeps.stillHolds): the run's folder may be a later claim's by its end,
// its scratch at the same paths, so the end sweeps nothing, through the computer or the disk.
for (const [name, harness, build] of [["pi's spec", undefined, adapterRunSpecFromLaunch], ["the CLI spec (opencode)", "opencode", cliRunSpecFromLaunch]]) {
  test(`${name} in Mode 2, its claim lost: the run's end leaves the scratch in the run's folder`, async (t) => {
    const disk = new FakeArchilDisk();
    const run = await mode2Run(t, { harness, disk });
    const { spec } = await run.claimNext(build, { stillHolds: () => false });
    mkdirSync(join(run.scratch, ".agentrun", "output"), { recursive: true });
    writeFileSync(join(run.scratch, ".agentrun", "output", "call-1"), "a later claim's output\n");
    const before = disk.calls.length;
    await spec.endCheckout();
    assert.ok(existsSync(join(run.scratch, ".agentrun", "tmp")), ".agentrun/tmp is kept");
    assert.ok(existsSync(join(run.scratch, ".agentrun", "output", "call-1")), "and bash's output");
    assert.deepEqual(disk.calls.slice(before).filter((call) => call.op === "deleteObject" || call.op === "deleteObjects"), [], "nothing deleted over the disk's file API");
    await spec.release();
    assert.ok(existsSync(join(run.scratch, ".agentrun", "tmp")), "nor by the release");
  });
}
