// The VM beat's life: the host's verdict on the VM's events, the beat's marks across a reopen, and the cleanup when
// something fails after the VM started.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { beatMarks, cleanOnFailure, followEvents, requireDone } from "../lifecycle.ts";

const events = (...names: string[]) => names.map((event) => JSON.stringify({ event, ...(event === "vm.open" ? { out: "/runs/r/work/gg-run" } : {}) })).join("\n");
const follow = (file: string, deadlineMs = 2_000) => followEvents(async () => file, () => {}, { deadlineMs, pollMs: 10 });

test("only a beat that ended in done is a result; vm.error and the deadline fail the run", async () => {
  const done = await follow(events("vm.open", "done"));
  assert.deepEqual(done, { ended: "done", out: "/runs/r/work/gg-run" });
  assert.doesNotThrow(() => requireDone(done.ended, 60_000));

  const failed = await follow(events("vm.open", "vm.error"));
  assert.equal(failed.ended, "vm.error");
  assert.throws(() => requireDone(failed.ended, 60_000), /failed/);

  const t = Date.now();
  const silent = await follow(events("vm.open"), 200);
  assert.ok(Date.now() - t < 2_000);
  assert.equal(silent.ended, undefined);
  assert.throws(() => requireDone(silent.ended, 30 * 60_000), /did not finish within 30 minutes/);
});

test("the beat's marks: a reopen after it started and before it finished is interrupted; after it finished, finished", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "gg-marks-"));
  try {
    const marks = beatMarks(join(dir, "gg-run"));
    assert.equal(marks.state(), "new");
    marks.started();
    assert.equal(beatMarks(join(dir, "gg-run")).state(), "interrupted");
    marks.finished();
    assert.equal(beatMarks(join(dir, "gg-run")).state(), "finished");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failure after the VM started closes it before the error goes on; success leaves it to the caller", async () => {
  const closed: string[] = [];
  const close = async () => void closed.push("closed");
  await assert.rejects(
    cleanOnFailure(close, async () => {
      throw new Error("sandboxes.fromId failed");
    }),
    /sandboxes.fromId failed/,
  );
  assert.deepEqual(closed, ["closed"]);
  assert.equal(await cleanOnFailure(close, async () => 7), 7);
  assert.deepEqual(closed, ["closed"]);
});
