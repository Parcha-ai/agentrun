// The run lifecycle without Archil (with a fake clock): a claim over a local directory, a real store,
// a real pi Harness on a scripted model, real commands.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Context } from "@earendil-works/chord";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { archilEnv } from "../src/env.ts";
import { exitCodeFor, FencedError, HeldError } from "../src/errors.ts";
import {
  LeaseLapsedError,
  openDurableRun,
  OWNER_LOCK,
  RunError,
  STORE_FILE,
  StoreBehindSealError,
  storeHead,
  takeOwnerLock,
  type DurableRun,
  type OpenDurableRunOptions,
  type RunEnv,
} from "../src/run.ts";
import {
  CLAIM_UNMOUNTED,
  isLeaseFresh,
  parseRunRecord,
  persistRecord,
  readRunRecord,
  RUN_JSON,
  RUN_JSON_TEMP,
  RunRecordError,
  writeRunRecord,
  type ClaimDir,
  type PersistRecord,
  type RunRecord,
} from "../src/status.ts";
import { openArchilStore, StoreFencedError } from "../src/store.ts";
import { entryCommitter, FaultyDatabase, SQLITE_IOERR_FSYNC, sqliteError } from "./_support.ts";
import { alive, ctx, fakeClaim, killQuietly, localClaimDir, localRef, scratchRoot, scriptedHarness, startCommand, startCommandIn, waitGone, type FakeClaim } from "./_run-support.ts";

const SQLITE_ERROR = 1;
const SQLITE_IOERR_CLOSE = 4106;

/** pi's store as a later pi might lay it out: the column this package reads for the head is gone. */
class SchemaMoved extends FaultyDatabase {
  override get<T extends object>(sql: string, ...params: Parameters<SqliteDatabase["get"]>[1][]): Promise<T | undefined> {
    if (sql === "SELECT next_seq FROM durable_metadata WHERE singleton = 1") return Promise.reject(sqliteError(SQLITE_ERROR, "no such column: next_seq"));
    return super.get<T>(sql, ...params);
  }
}

/** A database whose close fails with `errcode` (an I/O-class one is how a checkpoint on a fenced mount fails). */
class CloseFails extends FaultyDatabase {
  readonly errcode: number;
  constructor(inner: SqliteDatabase, errcode: number) {
    super(inner);
    this.errcode = errcode;
  }
  override close(): Promise<void> {
    return Promise.reject(sqliteError(this.errcode, "close failed"));
  }
}

type Setup = {
  claim: FakeClaim;
  fenced: FencedError[];
  steps: string[];
  agent: ReturnType<typeof scriptedHarness>["agent"];
  open(): Promise<DurableRun>;
};

/** A run on `root` over a fake claim; the env logs `cleanup` and onFenced logs `onFenced` into the claim's log. */
function setup(
  root: string,
  extra: { id?: string; options?: Partial<OpenDurableRunOptions>; claim?: Parameters<typeof fakeClaim>[2] } = {},
): Setup {
  const ref = localRef(extra.id ?? "r1");
  const claim = fakeClaim(root, ref, extra.claim);
  const fenced: FencedError[] = [];
  const steps: string[] = [];
  const scripted = scriptedHarness();
  const env = (c: { root: string; work: string; disk: string }): RunEnv => {
    const factory = archilEnv(c);
    return Object.assign((target: { cwd?: string }) => factory(target), {
      id: factory.id,
      cleanup: async (context: Context) => {
        claim.log.push("cleanup");
        await factory.cleanup(context);
      },
    });
  };
  return {
    claim,
    fenced,
    steps,
    agent: scripted.agent,
    open: () =>
      openDurableRun(ref, {
        mountToken: "unused",
        acquire: async () => {
          claim.log.push("acquire");
          return claim;
        },
        claimDir: localClaimDir,
        harness: { models: scripted.models, registry: scripted.registry },
        env,
        onFenced: (error) => {
          claim.log.push("onFenced");
          fenced.push(error);
        },
        onStep: (step) => void steps.push(step),
        ...extra.options,
      }),
  };
}

const runJson = (root: string): RunRecord => parseRunRecord(readFileSync(join(root, RUN_JSON), "utf8"));

/** This process's descriptors open on exactly `path`. */
function fdsOn(path: string): string[] {
  return readdirSync("/proc/self/fd").filter((fd) => {
    try {
      return readlinkSync(`/proc/self/fd/${fd}`) === path;
    } catch {
      return false;
    }
  });
}

/** `root` moves to `<root>.held` and an empty directory takes its path, as when the claim's mount goes away under it. */
function vanish(root: string): string {
  const held = `${root}.held`;
  renameSync(root, held);
  mkdirSync(root);
  return held;
}

/** The claim directory of a local root, with `assertMounted` replaced. */
async function claimDirWith(root: string, assertMounted: (real: ClaimDir) => Promise<void>): Promise<ClaimDir> {
  const real = await localClaimDir(root);
  return {
    root,
    get at() {
      return real.at;
    },
    assertMounted: () => assertMounted(real),
    assertSame: (name) => real.assertSame(name),
    close: () => real.close(),
  };
}

async function until(condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Snapshot of the store's files (`run.sqlite` and any `-wal`, `-shm`). */
function storeFiles(root: string): Map<string, Buffer> {
  const dir = join(root, "store");
  return new Map(readdirSync(dir).filter((f) => f.startsWith(STORE_FILE)).map((f) => [f, readFileSync(join(dir, f))]));
}

function restoreStore(root: string, files: Map<string, Buffer>): void {
  const dir = join(root, "store");
  for (const f of readdirSync(dir).filter((name) => name.startsWith(STORE_FILE))) rmSync(join(dir, f));
  for (const [f, bytes] of files) writeFileSync(join(dir, f), bytes);
}

async function headOf(root: string): Promise<number> {
  const store = await openArchilStore(join(root, "store", STORE_FILE));
  try {
    return await storeHead(store);
  } finally {
    await store.storage.close(ctx);
  }
}

describe("openDurableRun", () => {
  it("opens in order (claim, lock, run.json, store, seal, Harness) and writes run.json", async () => {
    const dir = scratchRoot("order");
    try {
      const t = setup(dir.root);
      const run = await t.open();
      assert.deepEqual(t.steps, ["acquire", "owner-lock", "run.json", "heartbeat", "layout", "store", "seal", "harness", "live", "resume"]);
      for (const path of [OWNER_LOCK, "store", "work", "tmp", join("store", STORE_FILE), RUN_JSON]) assert.ok(existsSync(join(dir.root, path)), path);
      assert.equal(existsSync(join(dir.root, RUN_JSON_TEMP)), false, "the temp file was renamed over run.json");
      const record = runJson(dir.root);
      assert.deepEqual(
        { ...record, holder: null, heartbeatAt: null, updatedAt: "" },
        { run: "r1", status: "running", generation: 1, sealedSeq: null, wakeAt: null, holder: null, heartbeatAt: null, updatedAt: "", detail: null },
      );
      assert.equal(record.holder?.pid, process.pid);
      assert.equal(record.holder?.driver, "local");
      assert.ok(Date.parse(record.heartbeatAt!) >= Date.parse(record.updatedAt), "the write after Harness.open is a heartbeat too");
      assert.deepEqual(run.record, record);
      assert.equal(run.generation, 1);
      assert.equal(run.claim.root, dir.root);
      await run.release();
      assert.deepEqual(t.claim.log, ["acquire", "cleanup", "barrier", "release"]);
    } finally {
      dir.remove();
    }
  });

  it("bumps the generation on every claim and seals the store's last committed sequence at release", async () => {
    const dir = scratchRoot("seal");
    try {
      const first = setup(dir.root);
      const run1 = await first.open();
      const root = await run1.harness.root(ctx, { agent: first.agent });
      await root.configure({ instructions: "one" }, ctx);
      await run1.release();
      const sealed1 = runJson(dir.root);
      assert.equal(sealed1.status, "paused", "a running run seals as paused");
      assert.equal(sealed1.generation, 1);
      assert.ok(typeof sealed1.sealedSeq === "number" && sealed1.sealedSeq > 0);
      assert.equal(await headOf(dir.root), sealed1.sealedSeq, "the seal is the store's head");

      const second = setup(dir.root);
      const run2 = await second.open();
      assert.equal(run2.generation, 2);
      assert.equal(runJson(dir.root).sealedSeq, null, "a live run has no seal");
      await run2.release();
      const sealed2 = runJson(dir.root);
      assert.equal(sealed2.generation, 2);
      assert.equal(sealed2.sealedSeq, await headOf(dir.root));
    } finally {
      dir.remove();
    }
  });

  it("writes run.json and starts the heartbeat before the store opens, keeping the seal until Harness.open", async () => {
    const dir = scratchRoot("early");
    try {
      await (await setup(dir.root).open()).release();
      const sealed = runJson(dir.root).sealedSeq;
      assert.ok(sealed !== null);
      let atStoreOpen: RunRecord | undefined;
      const decorateStore = (database: SqliteDatabase) => {
        atStoreOpen = runJson(dir.root);
        return database;
      };
      const t = setup(dir.root, { options: { decorateStore } });
      const run = await t.open();
      assert.deepEqual([atStoreOpen?.status, atStoreOpen?.generation, atStoreOpen?.holder?.pid], ["running", 2, process.pid]);
      assert.equal(atStoreOpen?.sealedSeq, sealed, "the first write keeps the seal the check reads");
      assert.equal(runJson(dir.root).sealedSeq, null, "a live store has no seal");
      await run.release();
    } finally {
      dir.remove();
    }
  });

  it("writes the host driver's handle as the holder, with this process's pid and since", async () => {
    const dir = scratchRoot("holder");
    try {
      const handle = { driver: "local", host: "host-b", unit: "pda-r1.service", mountpoint: "/mnt/archil/runs/r1", pid: 1, since: "x" };
      const run = await setup(dir.root, { options: { holder: handle } }).open();
      const holder = runJson(dir.root).holder!;
      assert.deepEqual({ ...holder, bootId: null, since: "" }, { ...handle, bootId: null, pid: process.pid, since: "" });
      assert.ok(Date.parse(holder.since) > 0);
      assert.equal(holder.bootId, readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), "bootId defaults to this machine's");
      await run.release();
      const t = setup(dir.root, { options: { holder: { host: 42 } } });
      await assert.rejects(t.open(), (error: unknown) => error instanceof RunError && error.code === "INVALID_ARGUMENT");
      assert.deepEqual(t.claim.log, [], "a bad handle is refused before the claim is taken");
    } finally {
      dir.remove();
    }
  });

  it("refuses a store behind its seal before Harness.open, marks the run failed, and leaves the store as it found it", async () => {
    const dir = scratchRoot("behind");
    try {
      const a = setup(dir.root);
      const run1 = await a.open();
      await run1.harness.root(ctx, { agent: a.agent });
      await run1.release();
      const sealed1 = runJson(dir.root).sealedSeq!;
      const older = storeFiles(dir.root);

      const b = setup(dir.root);
      const run2 = await b.open();
      await (await run2.harness.root(ctx, {})).configure({ instructions: "the commit that will be lost" }, ctx);
      await run2.release();
      const sealed2 = runJson(dir.root).sealedSeq!;
      assert.equal(sealed2, sealed1 + 1, "the second incarnation made exactly one commit");

      restoreStore(dir.root, older);
      for (let attempt = 0; attempt < 2; attempt++) {
        const c = setup(dir.root);
        const refused = await c.open().then(() => null, (error: unknown) => error);
        assert.ok(refused instanceof StoreBehindSealError, String(refused));
        assert.equal(refused.code, "STORE_BEHIND_SEAL");
        assert.equal(exitCodeFor(refused), 65);
        assert.deepEqual([refused.sealedSeq, refused.head], [sealed2, sealed1]);
        assert.deepEqual(c.steps, ["acquire", "owner-lock", "run.json", "heartbeat", "layout", "store"], "refused at the seal step, before Harness.open");
        assert.deepEqual(c.claim.log, ["acquire", "release"], "the claim is released, not fenced");
        assert.equal(c.fenced.length, 0);
        const failed = runJson(dir.root);
        assert.equal(failed.status, "failed");
        assert.equal(failed.sealedSeq, sealed2, "the seal is kept as evidence");
        assert.deepEqual(failed.detail, { code: "STORE_BEHIND_SEAL", sealedSeq: sealed2, head: sealed1 });
        assert.equal(await headOf(dir.root), sealed1, "the refusal wrote nothing to the store");
      }
      takeOwnerLock(dir.root).release();
    } finally {
      dir.remove();
    }
  });

  it("an env factory that throws abandons the lease: the claim is released, the owner lock is free and the heartbeat stops", async () => {
    const dir = scratchRoot("env-throws");
    try {
      const lease = { heartbeatMs: 20, expiryMs: 60_000, marginMs: 1_000, checkMs: 10 };
      const t = setup(dir.root, { options: { lease, env: () => { throw new Error("setpriv is missing"); } } });
      const refused = await t.open().then(() => null, (error: unknown) => error);
      assert.ok(refused instanceof Error && refused.message === "setpriv is missing", String(refused));
      assert.deepEqual(t.claim.log, ["acquire", "release"], "the claim is released, not fenced");
      assert.equal(t.fenced.length, 0);
      takeOwnerLock(dir.root).release();
      const last = runJson(dir.root).heartbeatAt;
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(runJson(dir.root).heartbeatAt, last, "no heartbeat after the failed open");
    } finally {
      dir.remove();
    }
  });

  it("refuses a store whose head it cannot read (pi's schema moved): marked failed with the seal kept, released, exit 70", async () => {
    const dir = scratchRoot("head-unreadable");
    try {
      await (await setup(dir.root).open()).release();
      const sealed = runJson(dir.root).sealedSeq;
      // The store opens (pi's own reads work) but the one pi-internal read this package makes finds no column.
      const decorateStore = (database: SqliteDatabase) => new SchemaMoved(database);
      for (let attempt = 0; attempt < 2; attempt++) {
        const t = setup(dir.root, { options: { decorateStore } });
        const refused = await t.open().then(() => null, (error: unknown) => error);
        assert.ok(refused instanceof RunError && refused.code === "STORE_HEAD_UNREADABLE", String(refused));
        assert.equal(exitCodeFor(refused), 70);
        assert.deepEqual(t.steps, ["acquire", "owner-lock", "run.json", "heartbeat", "layout", "store"], "refused before Harness.open");
        assert.deepEqual(t.claim.log, ["acquire", "release"], "the claim is released, not fenced");
        const failed = runJson(dir.root);
        assert.equal(failed.status, "failed");
        assert.equal(failed.sealedSeq, sealed, "the seal is kept");
        assert.deepEqual(failed.detail, { code: "STORE_HEAD_UNREADABLE", sealedSeq: sealed, reason: refused.message });
      }
      assert.equal(await headOf(dir.root), sealed, "the store was not touched");
    } finally {
      dir.remove();
    }
  });

  it("refuses a run.json that names another run (65) and releases the claim", async () => {
    const dir = scratchRoot("other");
    try {
      const other = setup(dir.root, { id: "other" });
      await (await other.open()).release();
      const t = setup(dir.root, { id: "r1" });
      const refused = await t.open().then(() => null, (error: unknown) => error);
      assert.ok(refused instanceof RunRecordError, String(refused));
      assert.equal(exitCodeFor(refused), 65);
      assert.deepEqual(t.claim.log, ["acquire", "release"]);
    } finally {
      dir.remove();
    }
  });

  it("refuses a lease whose self-fence does not exceed the heartbeat period, before taking the claim", async () => {
    const dir = scratchRoot("lease-args");
    try {
      const t = setup(dir.root, { options: { lease: { heartbeatMs: 80_000 } } });
      await assert.rejects(t.open(), (error: unknown) => error instanceof RunError && error.code === "INVALID_ARGUMENT");
      assert.deepEqual(t.claim.log, []);
    } finally {
      dir.remove();
    }
  });
});

describe("the seal reads pi's store head", () => {
  it("equals the Seq the last commit returned, on the installed pi-durable", async () => {
    const dir = scratchRoot("head");
    try {
      const store = await openArchilStore(join(dir.root, "run.sqlite"));
      try {
        assert.equal(await storeHead(store), 0, "a fresh store has committed nothing");
        const committer = entryCommitter(store.storage);
        await committer.setup();
        for (let i = 0; i < 5; i++) {
          const seq = await committer.commit(i);
          assert.equal(await storeHead(store), seq);
        }
      } finally {
        await store.storage.close(ctx);
      }
    } finally {
      dir.remove();
    }
  });

  it("fails closed (STORE_HEAD_UNREADABLE, exit 70) when the metadata row or table is missing", async () => {
    const dir = scratchRoot("head-missing");
    try {
      const store = await openArchilStore(join(dir.root, "run.sqlite"));
      try {
        await store.database.exec("DELETE FROM durable_metadata");
        await assert.rejects(storeHead(store), (error: unknown) => error instanceof RunError && error.code === "STORE_HEAD_UNREADABLE" && exitCodeFor(error) === 70);
        await store.database.exec("DROP TABLE durable_metadata");
        await assert.rejects(storeHead(store), (error: unknown) => error instanceof RunError && error.code === "STORE_HEAD_UNREADABLE");
      } finally {
        await store.database.close();
      }
    } finally {
      dir.remove();
    }
  });
});

describe("the owner lock", () => {
  it("refuses a second instance on the same host with 76 and never touches the first one's mount", async () => {
    const dir = scratchRoot("lock");
    try {
      const first = await setup(dir.root).open();
      const second = setup(dir.root, { claim: { reused: true } });
      const refused = await second.open().then(() => null, (error: unknown) => error);
      assert.ok(refused instanceof HeldError, String(refused));
      assert.equal(refused.holder, "owner-lock");
      assert.equal(exitCodeFor(refused), 76);
      assert.deepEqual(second.claim.log, ["acquire"], "no barrier, no release: the mount is the first instance's");
      assert.deepEqual(second.steps, ["acquire"]);
      assert.equal(fdsOn(dir.root).length, 1, "the refused instance closed its claim directory; the first holds its own");
      await first.setStatus("running");
      await first.release();
      assert.equal(fdsOn(dir.root).length, 0);
    } finally {
      dir.remove();
    }
  });

  it("is refused while another process holds it, even after its handle was collected, and taken once that process is killed", async () => {
    const dir = scratchRoot("lock-proc");
    const child = spawn(process.execPath, ["--expose-gc", "test/fixtures/hold-owner-lock.ts", dir.root], { stdio: ["ignore", "pipe", "inherit"] });
    try {
      const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
      assert.equal((await lines.next()).value, "held");
      assert.throws(() => takeOwnerLock(dir.root), (error: unknown) => error instanceof HeldError && error.holder === "owner-lock");
      const t = setup(dir.root);
      await assert.rejects(t.open(), (error: unknown) => error instanceof HeldError && exitCodeFor(error) === 76);
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
      takeOwnerLock(dir.root).release();
    } finally {
      child.kill("SIGKILL");
      dir.remove();
    }
  });
});

describe("run.json", () => {
  const record: RunRecord = {
    run: "r1",
    status: "sleeping",
    generation: 3,
    sealedSeq: 41,
    wakeAt: "2026-10-06T01:05:00.000Z",
    holder: { driver: "local", host: "h", bootId: "b", pid: 4242, since: "2026-10-06T01:02:03.000Z" },
    heartbeatAt: "2026-10-06T01:04:43.000Z",
    updatedAt: "2026-10-06T01:02:03.000Z",
    detail: { why: "poll" },
  };

  it("round-trips through the atomic writer and the reader; no temp file stays", async () => {
    const dir = scratchRoot("json");
    try {
      assert.equal(await readRunRecord(dir.root), undefined, "a run without run.json reads as undefined");
      await writeRunRecord(dir.root, record);
      assert.deepEqual(await readRunRecord(dir.root), record);
      assert.deepEqual(readdirSync(dir.root), [RUN_JSON]);
      await writeRunRecord(dir.root, { ...record, status: "done" });
      assert.equal((await readRunRecord(dir.root))?.status, "done");
    } finally {
      dir.remove();
    }
  });

  it("rejects malformed records (RUN_JSON_INVALID, exit 65) and ignores unknown fields", () => {
    const text = (change: Record<string, unknown>) => JSON.stringify({ ...record, ...change });
    assert.deepEqual(parseRunRecord(text({ futureField: 1 })), record);
    const handle = { ...record.holder!, unit: "pda-r1.service", mountpoint: "/mnt/archil/runs/r1" };
    assert.deepEqual(parseRunRecord(text({ holder: handle })).holder, handle, "the driver's handle fields survive a read");
    for (const bad of [
      "not json",
      "[]",
      text({ run: "" }),
      text({ status: "zombie" }),
      text({ generation: -1 }),
      text({ generation: 1.5 }),
      text({ sealedSeq: "41" }),
      text({ wakeAt: "tomorrow" }),
      text({ heartbeatAt: 5 }),
      text({ updatedAt: null }),
      text({ holder: undefined }),
      text({ holder: { ...record.holder, pid: 0 } }),
      text({ holder: { ...record.holder, since: "never" } }),
    ]) {
      assert.throws(() => parseRunRecord(bad), (error: unknown) => error instanceof RunRecordError && error.code === "RUN_JSON_INVALID" && exitCodeFor(error) === 65, bad);
    }
  });

  it("any error from the writer is a fence, whatever its errno", async () => {
    const errno = (code: string) => Object.assign(new Error(code), { code });
    for (const cause of [errno("EIO"), errno("EROFS"), errno("ENOENT"), errno("EACCES"), errno("ENOSPC"), errno("ENOTCONN"), "a string"]) {
      const failing: PersistRecord = () => Promise.reject(cause);
      await assert.rejects(writeRunRecord("/nowhere", record, failing), (error: unknown) => error instanceof FencedError && exitCodeFor(error) === 75 && error.cause === cause);
    }
  });

  it("isLeaseFresh compares the heartbeat with the reader's clock", () => {
    const beat = Date.parse(record.heartbeatAt!);
    assert.equal(isLeaseFresh(record, beat + 89_999), true);
    assert.equal(isLeaseFresh(record, beat + 90_000), false);
    assert.equal(isLeaseFresh(record, beat + 1_000, 500), false);
    assert.equal(isLeaseFresh({ ...record, heartbeatAt: null }, beat), false);
  });
});

describe("fences during the run", () => {
  it("a failed heartbeat write fences the run: commands die before onFenced, nothing more is written, nothing is sealed", async () => {
    const dir = scratchRoot("beat-fence");
    let fail = false;
    let before: string | undefined;
    let pid = 0;
    try {
      // `before` is run.json as the failing write finds it: writes are serialized, so none is in flight at that moment.
      const persist: PersistRecord = (root, text, signal) => {
        if (!fail) return persistRecord(root, text, signal);
        before ??= readFileSync(join(root, RUN_JSON), "utf8");
        return Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" }));
      };
      const t = setup(dir.root, { options: { persist, lease: { heartbeatMs: 20, expiryMs: 60_000, marginMs: 1_000, checkMs: 10 } } });
      const run = await t.open();
      pid = await startCommand(run, t.agent);
      fail = true;
      await until(() => t.fenced.length === 1);
      assert.ok(t.fenced[0] instanceof FencedError);
      assert.equal(exitCodeFor(t.fenced[0]), 75);
      assert.match(t.fenced[0].message, /run\.json/);
      assert.deepEqual(t.claim.log.slice(-3), ["markFenced", "cleanup", "onFenced"], "commands are killed before onFenced");
      assert.ok(await waitGone(pid), "the command died");
      assert.equal(run.fenced, true);
      assert.equal(run.claim.fenced, true);
      assert.equal(readFileSync(join(dir.root, RUN_JSON), "utf8"), before, "run.json is what it was when the failing write began");
      fail = false;
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(readFileSync(join(dir.root, RUN_JSON), "utf8"), before, "no write after the fence");
      await assert.rejects(run.release(), (error: unknown) => error === t.fenced[0]);
      await assert.rejects(run.setStatus("done"), (error: unknown) => error === t.fenced[0]);
      await assert.rejects(run.claim.barrier(), (error: unknown) => error === t.fenced[0]);
      assert.equal(runJson(dir.root).sealedSeq, null);
      assert.ok(!t.claim.log.includes("release"), "a fenced claim is never released by the run");
      assert.equal(t.fenced.length, 1, "onFenced runs once");
    } finally {
      killQuietly(pid);
      dir.remove();
    }
  });

  it("a run.json write in flight when another source fences never renames after the fence", async () => {
    const dir = scratchRoot("inflight-fence");
    try {
      let holding = false;
      let held: (() => void) | undefined;
      const persist: PersistRecord = async (root, text, signal) => {
        if (holding) await new Promise<void>((resolve) => (held = resolve));
        return persistRecord(root, text, signal);
      };
      const lease = { heartbeatMs: 10, expiryMs: 60_000, marginMs: 1_000, checkMs: 10 };
      const t = setup(dir.root, { options: { persist, lease }, claim: { barrier: () => Promise.reject(new FencedError("archil sync: the mount is failed")) } });
      const run = await t.open();
      holding = true;
      await until(() => held !== undefined);
      const before = readFileSync(join(dir.root, RUN_JSON), "utf8");
      await assert.rejects(run.claim.barrier(), FencedError);
      assert.equal(run.fenced, true, "the fence took effect before the held write resumed");
      held!();
      await until(() => t.fenced.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(readFileSync(join(dir.root, RUN_JSON), "utf8"), before, "the heartbeat that began before the fence did not publish");
      assert.equal(runJson(dir.root).heartbeatAt, JSON.parse(before).heartbeatAt);
      assert.equal(existsSync(join(dir.root, RUN_JSON_TEMP)), false, "its temp file was removed");
    } finally {
      dir.remove();
    }
  });

  it("a failing first run.json write fails the open with a fence", async () => {
    const dir = scratchRoot("first-write");
    try {
      const persist: PersistRecord = () => Promise.reject(Object.assign(new Error("EROFS"), { code: "EROFS" }));
      const t = setup(dir.root, { options: { persist } });
      const refused = await t.open().then(() => null, (error: unknown) => error);
      assert.ok(refused instanceof FencedError, String(refused));
      assert.equal(t.fenced.length, 1);
      assert.equal(t.fenced[0], refused);
      assert.ok(!t.claim.log.includes("release"));
      assert.deepEqual(t.steps, ["acquire", "owner-lock"]);
    } finally {
      dir.remove();
    }
  });

  it("a commit that fails with SQLITE_IOERR_FSYNC fences the run once: commands die, then onFenced; nothing is sealed", async () => {
    const dir = scratchRoot("store-fence");
    let pid = 0;
    try {
      const faulty: { database?: FaultyDatabase } = {};
      const decorateStore = (database: SqliteDatabase) => (faulty.database = new FaultyDatabase(database));
      const t = setup(dir.root, { options: { decorateStore } });
      const run = await t.open();
      const root = await run.harness.root(ctx, { agent: t.agent });
      pid = await startCommand(run, t.agent);
      faulty.database!.failNextCommit(sqliteError(SQLITE_IOERR_FSYNC, "disk I/O error"));
      await assert.rejects(root.configure({ instructions: "never durable" }, ctx), StoreFencedError);
      await until(() => t.fenced.length === 1);
      assert.ok(t.fenced[0] instanceof StoreFencedError);
      assert.deepEqual(t.claim.log.slice(-3), ["markFenced", "cleanup", "onFenced"]);
      assert.ok(await waitGone(pid), "the command died");
      await assert.rejects(run.release(), StoreFencedError);
      assert.equal(runJson(dir.root).status, "running");
      assert.equal(runJson(dir.root).sealedSeq, null);
      assert.ok(!t.claim.log.includes("release"));
      await faulty.database!.inner.close();
    } finally {
      killQuietly(pid);
      dir.remove();
    }
  });

  it("self-fences once the last successful heartbeat started more than expiry minus margin ago, measured from its start", async () => {
    const dir = scratchRoot("lapse-clock");
    let now = 0;
    let holding = false;
    let written = 0;
    const pending: Array<() => Promise<void>> = [];
    let pid = 0;
    try {
      const persist: PersistRecord = (root, text, signal) => {
        if (!holding) return persistRecord(root, text, signal).finally(() => written++);
        return new Promise<void>((resolve, reject) => pending.push(() => persistRecord(root, text, signal).then(resolve, reject)));
      };
      // The fake clock drives the timer; the watchdog thread keeps real time, and its 8 s limit is never reached here.
      const lease = { heartbeatMs: 10, expiryMs: 10_000, marginMs: 2_000, checkMs: 5 };
      const t = setup(dir.root, { options: { persist, lease, clock: () => now } });
      const run = await t.open();
      pid = await startCommand(run, t.agent);
      // Writes are serialized: the second to finish after the clock moved started after it moved, and so does every later one.
      now = 5_000;
      const seen = written;
      await until(() => written >= seen + 2);
      holding = true;
      await until(() => pending.length === 1);
      now = 7_000;
      await pending.shift()!();
      await until(() => pending.length === 1);
      now = 12_900;
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(t.fenced.length, 0, "7900 ms since the last successful heartbeat started: not yet");
      now = 13_100;
      await until(() => t.fenced.length === 1);
      const lapsed = t.fenced[0];
      assert.ok(lapsed instanceof LeaseLapsedError, String(lapsed));
      assert.equal(lapsed.code, "LEASE_LAPSED");
      assert.equal(exitCodeFor(lapsed), 75);
      assert.equal(lapsed.sinceMs, 8_100, "measured from when the write started (5000), not when it finished (7000)");
      assert.equal(lapsed.by, "timer");
      assert.deepEqual(t.claim.log.slice(-3), ["markFenced", "cleanup", "onFenced"]);
      assert.ok(await waitGone(pid), "the command died");
      assert.equal(pending.length, 1, "the self-fence fired while a heartbeat write still hung");
      // The hung heartbeat finishes now: it must not make the lapsed lease look fresh.
      const atFence = readFileSync(join(dir.root, RUN_JSON), "utf8");
      await pending.shift()!();
      assert.equal(readFileSync(join(dir.root, RUN_JSON), "utf8"), atFence, "the late heartbeat did not rename over run.json");
      assert.equal(existsSync(join(dir.root, RUN_JSON_TEMP)), false, "its temp file was removed");
    } finally {
      killQuietly(pid);
      dir.remove();
    }
  });

  it("a lapsed lease kills the run's commands and the instance exits 75 while its store still commits", { timeout: 30_000 }, async () => {
    const dir = scratchRoot("lapse-proc");
    const child = spawn(process.execPath, ["test/fixtures/lease-lapse.ts", dir.root], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    let pid = 0;
    try {
      const exit = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
      let commits = 0;
      let blockedAt = 0;
      for await (const line of createInterface({ input: child.stdout! })) {
        const event = JSON.parse(line) as { pid?: number; commits?: number };
        if (event.pid) {
          pid = event.pid;
          blockedAt = performance.now();
          assert.ok(alive(pid));
        }
        if (event.commits) commits = event.commits;
      }
      assert.equal(await exit, 75, stderr);
      const ms = performance.now() - blockedAt;
      assert.match(stderr, /LEASE_LAPSED/);
      assert.ok(commits > 0, "the store kept committing while the heartbeat was blocked");
      assert.ok(ms < 2_000, `exited ${Math.round(ms)} ms after heartbeats were blocked (self-fence at 300 ms)`);
      assert.ok(await waitGone(pid), "the command died with the instance");
    } finally {
      child.kill("SIGKILL");
      killQuietly(pid);
      dir.remove();
    }
  });

  it("a claim root whose mount went away fences at the next heartbeat: commands die, nothing is written under the bare path", async () => {
    const dir = scratchRoot("vanish");
    let held = "";
    let pid = 0;
    try {
      const t = setup(dir.root, { options: { lease: { heartbeatMs: 20, expiryMs: 60_000, marginMs: 1_000, checkMs: 10 } } });
      const run = await t.open();
      pid = await startCommand(run, t.agent);
      // The claim directory is one descriptor; a heartbeat (every 20 ms here) opens the root a second time while it syncs it.
      await until(() => fdsOn(dir.root).length === 1).catch(() => assert.fail(`the run holds its root open once, not ${fdsOn(dir.root).length} times`));
      held = vanish(dir.root);
      await until(() => t.fenced.length === 1);
      const fence = t.fenced[0]!;
      assert.equal(fence.code, CLAIM_UNMOUNTED, fence.message);
      assert.equal(exitCodeFor(fence), 75);
      assert.deepEqual(t.claim.log.slice(-3), ["markFenced", "cleanup", "onFenced"], "commands are killed before onFenced");
      assert.ok(await waitGone(pid), "the command died");
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(readdirSync(dir.root), [], "nothing was written under the root's path");
      assert.equal(runJson(held).status, "running", "run.json stays where the claim's directory is");
      await until(() => fdsOn(held).length === 0);
    } finally {
      killQuietly(pid);
      dir.remove();
      if (held) rmSync(held, { recursive: true, force: true });
    }
  });

  it("a write through the claim directory that fails (its directory is gone) fences, even when the path check passed", async () => {
    const dir = scratchRoot("dirfd-fails");
    let held = "";
    let pid = 0;
    try {
      // The check passes, as one that ran just before the mount died does: the write itself must fail, not land elsewhere.
      const claimDir = (root: string) => claimDirWith(root, async () => undefined);
      const t = setup(dir.root, { options: { claimDir, lease: { heartbeatMs: 20, expiryMs: 60_000, marginMs: 1_000, checkMs: 10 } } });
      const run = await t.open();
      pid = await startCommand(run, t.agent);
      held = vanish(dir.root);
      rmSync(held, { recursive: true });
      await until(() => t.fenced.length === 1);
      const fence = t.fenced[0]!;
      assert.equal(fence.code, "FENCED");
      assert.match(fence.message, /run\.json/);
      assert.equal((fence.cause as { code?: string }).code, "ENOENT");
      assert.ok(await waitGone(pid), "the command died");
      assert.deepEqual(readdirSync(dir.root), [], "nothing was written under the root's path");
    } finally {
      killQuietly(pid);
      dir.remove();
    }
  });

  it("an owner lock that is not the claim directory's fences the open, is let go, and leaves only itself on the path", async () => {
    const dir = scratchRoot("lock-vanish");
    let held = "";
    try {
      // The mount goes away right after the check before the lock: SQLite then opens owner.lock by path, on the local disk.
      const claimDir = (root: string) =>
        claimDirWith(root, async (real) => {
          await real.assertMounted();
          if (!held) held = vanish(root);
        });
      const t = setup(dir.root, { options: { claimDir } });
      const refused = await t.open().then(() => null, (error: unknown) => error);
      assert.ok(refused instanceof FencedError && refused.code === CLAIM_UNMOUNTED, String(refused));
      assert.deepEqual(t.fenced, [refused]);
      assert.deepEqual(t.steps, ["acquire"]);
      assert.deepEqual(readdirSync(dir.root), [OWNER_LOCK], "the one file made by path: the lock, with its journal in memory");
      takeOwnerLock(dir.root).release();
      assert.deepEqual(readdirSync(held), [], "nothing in the claim's directory");
    } finally {
      dir.remove();
      if (held) rmSync(held, { recursive: true, force: true });
    }
  });
});

describe("the watchdog thread", () => {
  it("kills the run's commands at the deadline while a store commit blocks the main thread, then the instance exits 75", { timeout: 30_000 }, async () => {
    const dir = scratchRoot("blocked");
    const blockMs = 2_500;
    const child = spawn(process.execPath, ["test/fixtures/blocked-commit.ts", dir.root, String(blockMs)], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    let pid = 0;
    try {
      const exit = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
      const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
      const started = JSON.parse((await lines.next()).value as string) as { pid: number; heartbeatAt: string };
      pid = started.pid;
      const blocking = JSON.parse((await lines.next()).value as string) as { blocking: number };
      while (alive(pid) && Date.now() < blocking.blocking + blockMs + 5_000) await new Promise((resolve) => setTimeout(resolve, 5));
      const deadAt = Date.now();
      assert.equal(alive(pid), false, "the command died");
      assert.ok(deadAt < blocking.blocking + blockMs, `the command died ${deadAt - blocking.blocking} ms into a ${blockMs} ms block, while the main thread was still stuck`);
      const sinceBeat = deadAt - Date.parse(started.heartbeatAt);
      assert.ok(sinceBeat >= 800 && sinceBeat < blockMs, `the command died ${sinceBeat} ms after the last heartbeat started (self-fence at 800 ms, block of ${blockMs} ms)`);
      assert.equal(child.exitCode, null, "the instance was still blocked when its command died");
      assert.equal(await exit, 75, stderr);
      assert.match(stderr, /fenced \(LEASE_LAPSED\).*seen by the watchdog/);
    } finally {
      child.kill("SIGKILL");
      killQuietly(pid);
      dir.remove();
    }
  });
});

describe("release", () => {
  it("kills the commands, closes, barriers, seals, unlocks, then unmounts", async () => {
    const dir = scratchRoot("release");
    let pid = 0;
    try {
      const atUnmount: { commandAlive?: boolean; record?: RunRecord; lockFree?: boolean; rootOpen?: number } = {};
      const t = setup(dir.root, {
        claim: {
          release: async () => {
            atUnmount.rootOpen = fdsOn(dir.root).length;
            atUnmount.commandAlive = !(await waitGone(pid, 2_000));
            atUnmount.record = runJson(dir.root);
            takeOwnerLock(dir.root).release();
            atUnmount.lockFree = true;
          },
        },
      });
      const run = await t.open();
      await (await run.harness.root(ctx, { agent: t.agent })).configure({ instructions: "x" }, ctx);
      pid = await startCommand(run, t.agent);
      t.steps.length = 0;
      await run.release();
      assert.deepEqual(t.steps, ["close", "cleanup", "barrier", "seal", "unlock", "unmount"]);
      assert.deepEqual(t.claim.log, ["acquire", "cleanup", "barrier", "release"]);
      assert.equal(atUnmount.commandAlive, false, "the command was dead before the unmount");
      assert.equal(atUnmount.record?.status, "paused");
      assert.equal(atUnmount.record?.sealedSeq, await headOf(dir.root));
      assert.equal(atUnmount.lockFree, true, "the owner lock was released before the unmount");
      assert.equal(atUnmount.rootOpen, 0, "the claim directory was closed before the unmount: an open directory keeps a mount busy");
      await run.release();
      assert.equal(t.claim.log.filter((e) => e === "release").length, 1, "release is idempotent");
      await assert.rejects(run.setStatus("running"), (error: unknown) => error instanceof RunError && error.code === "RUN_RELEASED");
    } finally {
      killQuietly(pid);
      dir.remove();
    }
  });

  it("a tool cut at release comes back interrupted on the next open, never as a result of its own", async () => {
    const dir = scratchRoot("cut");
    let pid = 0;
    try {
      const first = setup(dir.root);
      const run1 = await first.open();
      const command = await startCommandIn(run1, first.agent);
      pid = command.pid;
      await run1.release();
      assert.ok(await waitGone(pid), "the command died at release");
      const second = setup(dir.root);
      const run2 = await second.open();
      await run2.harness.waitForIdle(ctx);
      const conversation = (await run2.harness.conversation(command.conversationId, ctx))!;
      const results = (await conversation.entries({}, 100, undefined, ctx)).items.filter((e) => e.kind === "pi.tool-result");
      assert.equal(results.length, 1, JSON.stringify(results));
      assert.match(JSON.stringify(results[0]), /Tool bash was interrupted and may have partially run/);
      await run2.release();
    } finally {
      killQuietly(pid);
      dir.remove();
    }
  });

  for (const [what, errcode] of [["an I/O error the store fences on", SQLITE_IOERR_CLOSE], ["any other error", SQLITE_ERROR]] as const) {
    it(`a rejecting close is a fence (${what}): nothing is sealed and the claim is not released`, async () => {
      const dir = scratchRoot("close-fence");
      try {
        let raw: CloseFails | undefined;
        const decorateStore = (database: SqliteDatabase): SqliteDatabase => (raw = new CloseFails(database, errcode));
        const t = setup(dir.root, { options: { decorateStore } });
        const run = await t.open();
        await run.harness.root(ctx, { agent: t.agent });
        await assert.rejects(run.release(), FencedError);
        assert.equal(t.fenced.length, 1);
        assert.equal(runJson(dir.root).status, "running");
        assert.equal(runJson(dir.root).sealedSeq, null);
        assert.ok(!t.claim.log.includes("barrier") && !t.claim.log.includes("release"), t.claim.log.join(","));
        await raw!.inner.close();
      } finally {
        dir.remove();
      }
    });
  }

  it("a failed barrier is a fence: nothing is sealed and the claim is not released", async () => {
    const dir = scratchRoot("barrier-fence");
    try {
      const t = setup(dir.root, { claim: { barrier: () => Promise.reject(new FencedError("archil sync: the mount is failed or read-only")) } });
      const run = await t.open();
      await assert.rejects(run.release(), FencedError);
      assert.equal(t.fenced.length, 1);
      assert.equal(runJson(dir.root).sealedSeq, null);
      assert.ok(!t.claim.log.includes("release"));
    } finally {
      dir.remove();
    }
  });

  it("setStatus writes transitions, and done and failed run the barrier first", async () => {
    const dir = scratchRoot("status");
    try {
      const log: string[] = [];
      const persist: PersistRecord = (root, text, signal) => {
        log.push(`write:${(JSON.parse(text) as RunRecord).status}`);
        return persistRecord(root, text, signal);
      };
      const t = setup(dir.root, { options: { persist }, claim: { log } });
      const run = await t.open();
      const wakeAt = new Date(Date.now() + 60_000).toISOString();
      await run.setStatus("sleeping", { why: "poll" }, { wakeAt });
      assert.deepEqual([runJson(dir.root).status, runJson(dir.root).wakeAt, runJson(dir.root).detail], ["sleeping", wakeAt, { why: "poll" }]);
      log.length = 0;
      await run.setStatus("done", { ok: true });
      assert.deepEqual(log, ["barrier", "write:done"], "the barrier ran before the terminal status was written");
      assert.equal(runJson(dir.root).wakeAt, null);
      await run.release();
      assert.equal(runJson(dir.root).status, "done", "release keeps a terminal status");
      assert.ok(runJson(dir.root).sealedSeq !== null);
    } finally {
      dir.remove();
    }
  });
});
