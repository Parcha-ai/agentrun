// readLocalRunStatus: the public reader of a local run's status. A run on a local directory has no disk and no control API, so
// `readRunStatus` cannot read it; this reads the same `run.json` through the same strict parser, from the directory.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localRun, openDurableRun, readLocalRunStatus, readRunStatus, RunRecordError } from "../src/index.ts";
import { scratchRoot, scriptedHarness } from "./_run-support.ts";

const REF = { disk: "local", region: "local", id: "status-1" };

/** A control API over one directory: `runs/<id>/run.json` is `<root>/run.json`, as the supervisor reads it from a disk. */
const controlOver = (root: string) => ({
  getObject: async (key: string) => {
    if (key !== `runs/${REF.id}/run.json`) throw Object.assign(new Error("no such key"), { status: 404 });
    try {
      return new Uint8Array(readFileSync(join(root, "run.json")));
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") throw Object.assign(new Error("no such key"), { status: 404 });
      throw error;
    }
  },
});

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

  it("refuses a malformed run.json as readRunStatus does: RunRecordError, RUN_JSON_INVALID", async () => {
    const dir = scratchRoot("local-status-bad");
    try {
      mkdirSync(dir.root, { recursive: true });
      for (const text of ["not json", JSON.stringify({ run: "x", status: "napping" })]) {
        writeFileSync(join(dir.root, "run.json"), text);
        await assert.rejects(readLocalRunStatus(dir.root), (error: unknown) => error instanceof RunRecordError && error.code === "RUN_JSON_INVALID");
        await assert.rejects(readRunStatus(controlOver(dir.root), REF.id), (error: unknown) => error instanceof RunRecordError && error.code === "RUN_JSON_INVALID");
      }
    } finally {
      dir.remove();
    }
  });

  it("returns what readRunStatus returns for the same run.json, through a control API over the same directory", async () => {
    const dir = scratchRoot("local-status-same");
    try {
      assert.equal(await readLocalRunStatus(dir.root), await readRunStatus(controlOver(dir.root), REF.id), "both null before the run exists");
      const scripted = scriptedHarness();
      const run = await openDurableRun(REF, { ...localRun(dir.root), harness: { models: scripted.models, registry: scripted.registry } });
      await run.setStatus("sleeping", null, { wakeAt: new Date(Date.now() + 60_000).toISOString() });
      await run.release();
      const local = await readLocalRunStatus(dir.root);
      assert.equal(local?.status, "sleeping");
      assert.deepEqual(local, await readRunStatus(controlOver(dir.root), REF.id));
    } finally {
      dir.remove();
    }
  });
});
