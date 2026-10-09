// openRunLease for an app that owns its store and Harness (a host that owns its Harness): its own store connection in
// the shared profile at its own path, the seal checked through `storeHead({ database, file })`, a Harness over
// `observe(storage)`, and the lease's release after the app closed what it opened.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Harness } from "@earendil-works/pi-durable";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { exitCodeFor, FencedError } from "../src/errors.ts";
import { openRunLease, RunError, StoreBehindSealError, storeHead, type OpenRunLeaseOptions, type RunLease } from "../src/run.ts";
import { parseRunRecord, type RunRecord } from "../src/status.ts";
import { openArchilStore, StoreFencedError, type ArchilStore } from "../src/store.ts";
import { entryCommitter, FaultyDatabase, SQLITE_IOERR_FSYNC, sqliteError } from "./_support.ts";
import { ctx, fakeClaim, localClaimDir, localRef, scratchRoot, scriptedHarness, type FakeClaim } from "./_run-support.ts";

const runJson = (root: string): RunRecord => parseRunRecord(readFileSync(join(root, "run.json"), "utf8"));

/** A lease over a fake claim; `cleanup` and `onFenced` log into the claim's log. */
function leaseAt(root: string, options: Partial<OpenRunLeaseOptions> = {}) {
  const ref = localRef("h6");
  const claim: FakeClaim = fakeClaim(root, ref);
  const steps: string[] = [];
  const fenced: FencedError[] = [];
  const open = () =>
    openRunLease(ref, {
      mountToken: "unused",
      acquire: async () => claim,
      claimDir: localClaimDir,
      cleanup: async () => void claim.log.push("cleanup"),
      onFenced: (error) => {
        claim.log.push("onFenced");
        fenced.push(error);
      },
      onStep: (step) => void steps.push(step),
      ...options,
    });
  return { claim, steps, fenced, open };
}

/** The app's own store: the shared profile, at a path of its choosing under the claim. */
function appStore(lease: RunLease, decorate?: (database: SqliteDatabase) => SqliteDatabase): Promise<ArchilStore> {
  return openArchilStore(join(lease.claim.root, "app", "durable.sqlite"), "shared", {
    onFenced: (error) => void lease.fence(error),
    ...(decorate === undefined ? {} : { decorate }),
  });
}

describe("openRunLease", () => {
  it("runs the claim's lifecycle around an app's own store and Harness, and seals what its commits returned", async () => {
    const dir = scratchRoot("lease");
    try {
      const t = leaseAt(dir.root);
      const lease = await t.open();
      assert.deepEqual(t.steps, ["acquire", "owner-lock", "run.json", "heartbeat", "layout"], "no store, no Harness");
      assert.deepEqual([lease.generation, lease.sealedSeq, lease.record.status], [1, null, "running"]);
      const store = await appStore(lease);
      await lease.checkSeal({ database: store.database, file: store.file });
      const scripted = scriptedHarness();
      const harness = await Harness.open(lease.observe(store.storage), { models: scripted.models, registry: scripted.registry }, ctx);
      await lease.live();
      assert.equal(runJson(dir.root).sealedSeq, null);
      const root = await harness.root(ctx, { agent: scripted.agent });
      await root.configure({ instructions: "one" }, ctx);
      await harness.close(ctx);
      t.steps.length = 0;
      await lease.release();
      assert.deepEqual(t.steps, ["cleanup", "barrier", "seal", "unlock", "unmount"]);
      assert.deepEqual(t.claim.log, ["cleanup", "barrier", "release"]);
      const sealed = runJson(dir.root);
      assert.equal(sealed.status, "paused");
      const reopened = await openArchilStore(store.file, "shared");
      try {
        assert.equal(sealed.sealedSeq, await storeHead(reopened), "the seal is the head the observed commits reached");
      } finally {
        await reopened.storage.close(ctx);
      }

      const again = leaseAt(dir.root);
      const second = await again.open();
      assert.deepEqual([second.generation, second.sealedSeq], [2, sealed.sealedSeq]);
      await second.release();
      assert.equal(runJson(dir.root).sealedSeq, sealed.sealedSeq, "a lease that never touched the store keeps the seal");
    } finally {
      dir.remove();
    }
  });

  it("checkSeal refuses a store behind its seal, marks the run failed, and abandon closes the app's parts without sealing", async () => {
    const dir = scratchRoot("lease-seal");
    try {
      // A first incarnation commits twice and seals; its store is then replaced by one that holds one commit.
      const first = leaseAt(dir.root);
      const lease1 = await first.open();
      const store1 = await appStore(lease1);
      await lease1.checkSeal(store1);
      const committer = entryCommitter(lease1.observe(store1.storage));
      await committer.setup();
      await committer.commit(1);
      await store1.storage.close(ctx);
      await lease1.release();
      const sealed = runJson(dir.root).sealedSeq!;
      const older = join(dir.root, "older.sqlite");
      const store0 = await openArchilStore(older, "shared");
      await entryCommitter(store0.storage).setup();
      await store0.storage.close(ctx);
      for (const suffix of ["", "-wal", "-shm"]) rmSync(join(dir.root, "app", `durable.sqlite${suffix}`), { force: true });
      renameSync(older, join(dir.root, "app", "durable.sqlite"));

      const t = leaseAt(dir.root);
      const lease = await t.open();
      assert.equal(lease.sealedSeq, sealed);
      const store = await appStore(lease);
      const refused = await lease.checkSeal(store).then(() => null, (error: unknown) => error);
      assert.ok(refused instanceof StoreBehindSealError, String(refused));
      assert.equal(exitCodeFor(refused), 65);
      assert.deepEqual(runJson(dir.root).detail, { code: "STORE_BEHIND_SEAL", sealedSeq: sealed, head: sealed - 1 });
      assert.match(refused.message, /app\/durable\.sqlite/, "the error names the app's store");
      let closed = false;
      await lease.abandon(refused, async () => {
        await store.storage.close(ctx);
        closed = true;
      });
      assert.equal(closed, true);
      assert.deepEqual(t.claim.log, ["release"], "unmounted, no barrier of the lease's own, nothing sealed");
      assert.deepEqual([runJson(dir.root).status, runJson(dir.root).sealedSeq], ["failed", sealed], "the seal is kept");
    } finally {
      dir.remove();
    }
  });

  it("checkSeal marks a store whose head cannot be read as failed (70)", async () => {
    const dir = scratchRoot("lease-head");
    try {
      const t = leaseAt(dir.root);
      const lease = await t.open();
      const store = await appStore(lease);
      await store.database.exec("DELETE FROM durable_metadata");
      await assert.rejects(lease.checkSeal(store), (error: unknown) => error instanceof RunError && error.code === "STORE_HEAD_UNREADABLE" && exitCodeFor(error) === 70);
      assert.equal(runJson(dir.root).status, "failed");
      assert.equal((runJson(dir.root).detail as { code: string }).code, "STORE_HEAD_UNREADABLE");
      await lease.abandon(new RunError("STORE_HEAD_UNREADABLE", "no durable_metadata"), () => store.database.close());
      assert.deepEqual(t.claim.log, ["release"]);
    } finally {
      dir.remove();
    }
  });

  it("a FencedError from a commit through observe fences the lease, even when the app wired no onFenced", async () => {
    const dir = scratchRoot("lease-fence");
    try {
      const t = leaseAt(dir.root);
      const lease = await t.open();
      let faulty: FaultyDatabase | undefined;
      const store = await openArchilStore(join(dir.root, "app", "durable.sqlite"), "shared", { decorate: (db) => (faulty = new FaultyDatabase(db)) });
      await lease.checkSeal(store);
      const scripted = scriptedHarness();
      const harness = await Harness.open(lease.observe(store.storage), { models: scripted.models, registry: scripted.registry }, ctx);
      await lease.live();
      const root = await harness.root(ctx, { agent: scripted.agent });
      faulty!.failNextCommit(sqliteError(SQLITE_IOERR_FSYNC, "disk I/O error"));
      await assert.rejects(root.configure({ instructions: "never durable" }, ctx), StoreFencedError);
      assert.equal(lease.fenced, true);
      await lease.fenceSettled();
      assert.deepEqual(t.claim.log.slice(-3), ["markFenced", "cleanup", "onFenced"]);
      assert.ok(t.fenced[0] instanceof StoreFencedError);
      await assert.rejects(lease.release(), StoreFencedError);
      await assert.rejects(lease.live(), StoreFencedError);
      await assert.rejects(lease.setStatus("done"), StoreFencedError);
      assert.equal(runJson(dir.root).sealedSeq, null, "nothing sealed");
      await faulty!.inner.close();
    } finally {
      dir.remove();
    }
  });
});
