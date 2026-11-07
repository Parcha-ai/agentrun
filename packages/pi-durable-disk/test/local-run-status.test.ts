// readLocalRunStatus: the public reader of a local run's status, `run.json` through its strict parser, from the directory.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localRun, openDurableRun, readLocalRunStatus, RunRecordError } from "../src/index.ts";
import { scratchRoot, scriptedHarness } from "./_run-support.ts";

const REF = { disk: "local", region: "local", id: "status-1" };

describe("readLocalRunStatus", () => {
  it("reads a run's record from its directory: running while it is held, then what the run set and the seal its release wrote", async () => {
    const dir = scratchRoot("local-status");
    try {
      const scripted = scriptedHarness();
      const run = await openDurableRun(REF, { ...localRun(dir.root), harness: { models: scripted.models, registry: scripted.registry } });
      const held = await readLocalRunStatus(dir.root);
      assert.equal(held?.run, REF.id);
      assert.equal(held?.status, "running");
      assert.equal(held?.generation, 1);
      assert.equal(held?.holder?.pid, process.pid);
      await run.setStatus("done", { reason: "finished" });
      await run.release();
      const done = await readLocalRunStatus(dir.root);
      assert.equal(done?.status, "done");
      assert.equal(done?.generation, 1);
      assert.ok(done?.sealedSeq !== null && done!.sealedSeq! >= 0, `the release sealed the store: ${done?.sealedSeq}`);
      assert.deepEqual(done?.detail, { reason: "finished" });
    } finally {
      dir.remove();
    }
  });

  it("answers null for a run that has no run.json yet, and for a directory that is not there", async () => {
    const dir = scratchRoot("local-status-none");
    try {
      assert.equal(await readLocalRunStatus(dir.root), null);
      assert.equal(await readLocalRunStatus(join(dir.root, "nothing-here")), null);
    } finally {
      dir.remove();
    }
  });

  it("refuses a malformed run.json: RunRecordError, RUN_JSON_INVALID", async () => {
    const dir = scratchRoot("local-status-bad");
    try {
      mkdirSync(dir.root, { recursive: true });
      const valid = { run: "x", status: "paused", generation: 1, sealedSeq: null, wakeAt: null, holder: null, heartbeatAt: null, updatedAt: "2026-10-30T00:00:00.000Z", detail: null };
      for (const text of ["not json", JSON.stringify({ run: "x", status: "napping" }), JSON.stringify({ ...valid, box: { mode: "docker" } }), JSON.stringify({ ...valid, box: "bwrap" }), JSON.stringify({ ...valid, box: null })]) {
        writeFileSync(join(dir.root, "run.json"), text);
        await assert.rejects(readLocalRunStatus(dir.root), (error: unknown) => error instanceof RunRecordError && error.code === "RUN_JSON_INVALID");
      }
    } finally {
      dir.remove();
    }
  });

  it("returns the run.json a released run left", async () => {
    const dir = scratchRoot("local-status-same");
    try {
      assert.equal(await readLocalRunStatus(dir.root), null, "null before the run exists");
      const scripted = scriptedHarness();
      const run = await openDurableRun(REF, { ...localRun(dir.root), harness: { models: scripted.models, registry: scripted.registry } });
      await run.setStatus("sleeping", null, { wakeAt: new Date(Date.now() + 60_000).toISOString() });
      await run.release();
      const local = await readLocalRunStatus(dir.root);
      assert.equal(local?.status, "sleeping");
    } finally {
      dir.remove();
    }
  });
});
