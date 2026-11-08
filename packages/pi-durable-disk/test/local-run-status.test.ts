// readLocalRunStatus: the public reader of a local run's record, from its store, once no process holds the run.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HeldError } from "../src/errors.ts";
import { localRun, openDurableRun, readLocalRunStatus, RunRecordError } from "../src/index.ts";
import { RUN_STATUS_TABLE } from "../src/internals.ts";
import { scratchRoot, scriptedHarness } from "./_run-support.ts";

const REF = { disk: "local", region: "local", id: "status-1" };

describe("readLocalRunStatus", () => {
  it("reads a released run's record from its store; while a process holds the run it refuses, HeldError store", async () => {
    const dir = scratchRoot("local-status");
    try {
      const scripted = scriptedHarness();
      const run = await openDurableRun(REF, { ...localRun(dir.root), harness: { models: scripted.models, registry: scripted.registry } });
      await assert.rejects(readLocalRunStatus(dir.root), (error: unknown) => error instanceof HeldError && error.holder === "store");
      await run.setStatus("done", { reason: "finished" });
      await run.release();
      const done = await readLocalRunStatus(dir.root);
      assert.equal(done?.run, REF.id);
      assert.equal(done?.status, "done");
      assert.equal(done?.generation, 1);
      assert.equal(done?.holder?.pid, process.pid);
      assert.deepEqual(done?.detail, { reason: "finished" });
    } finally {
      dir.remove();
    }
  });

  it("answers null for a run that has no store or no record yet, and for a directory that is not there", async () => {
    const dir = scratchRoot("local-status-none");
    try {
      assert.equal(await readLocalRunStatus(dir.root), null);
      assert.equal(await readLocalRunStatus(join(dir.root, "nothing-here")), null);
      mkdirSync(join(dir.root, "store"));
      new DatabaseSync(join(dir.root, "store", "run.sqlite")).close();
      assert.equal(await readLocalRunStatus(dir.root), null, "a store with no record table");
    } finally {
      dir.remove();
    }
  });

  it("refuses a malformed record: RunRecordError, RUN_JSON_INVALID", async () => {
    const dir = scratchRoot("local-status-bad");
    try {
      mkdirSync(join(dir.root, "store"), { recursive: true });
      const db = new DatabaseSync(join(dir.root, "store", "run.sqlite"));
      db.exec(`CREATE TABLE ${RUN_STATUS_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), record TEXT NOT NULL)`);
      db.close();
      const valid = { run: "x", status: "paused", generation: 1, wakeAt: null, holder: null, updatedAt: "2026-10-30T00:00:00.000Z", detail: null };
      for (const text of ["not json", JSON.stringify({ run: "x", status: "napping" }), JSON.stringify({ ...valid, box: { mode: "docker" } }), JSON.stringify({ ...valid, box: "bwrap" }), JSON.stringify({ ...valid, box: null })]) {
        const write = new DatabaseSync(join(dir.root, "store", "run.sqlite"));
        write.prepare(`INSERT INTO ${RUN_STATUS_TABLE} (id, record) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record`).run(text);
        write.close();
        await assert.rejects(readLocalRunStatus(dir.root), (error: unknown) => error instanceof RunRecordError && error.code === "RUN_JSON_INVALID", text);
      }
    } finally {
      dir.remove();
    }
  });

  it("returns what a parked run left: sleeping with its wake", async () => {
    const dir = scratchRoot("local-status-parked");
    try {
      const scripted = scriptedHarness();
      const run = await openDurableRun(REF, { ...localRun(dir.root), harness: { models: scripted.models, registry: scripted.registry } });
      const wakeAt = new Date(Date.now() + 60_000).toISOString();
      await run.setStatus("sleeping", null, { wakeAt });
      await run.release();
      const local = await readLocalRunStatus(dir.root);
      assert.deepEqual([local?.status, local?.wakeAt], ["sleeping", wakeAt]);
    } finally {
      dir.remove();
    }
  });
});
