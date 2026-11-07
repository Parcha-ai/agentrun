// The run lifecycle: a claim over a local directory, a real store, a real pi Harness on a scripted model, real commands.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Context } from "@earendil-works/chord";
import type { Cursor, DocumentRecord, Page, Seq, Storage } from "@earendil-works/pi-durable";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import * as piDurable from "@earendil-works/pi-durable";
import { archilEnv } from "../src/env.ts";
import { exitCodeFor, FencedError, HeldError } from "../src/errors.ts";
import {
  openDurableRun,
  RunError,
  STORE_FILE,
  storeHead,
  type BeforeResume,
  type DurableRun,
  type OpenDurableRunOptions,
  type RunEnv,
  type StoreReads,
} from "../src/run.ts";
import { CLAIM_UNMOUNTED, parseRunRecord, readLocalRunStatus, RunRecordError, type ClaimDir, type RunRecord } from "../src/status.ts";
import { openArchilStore, StoreFencedError } from "../src/store.ts";
import { entryCommitter, FaultyDatabase, sessionFailed, SQLITE_IOERR_FSYNC, sqliteError } from "./_support.ts";
import { alive, ctx, fakeClaim, killQuietly, localClaimDir, localRef, removeWhileWritten, scratchRoot, scriptedHarness, scriptedReply, startCommand, startCommandIn, waitGone, type FakeClaim } from "./_run-support.ts";

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
  faux: ReturnType<typeof scriptedHarness>["faux"];
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
    faux: scripted.faux,
    open: () =>
      openDurableRun(ref, {
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

/** The record a released run left in its store. */
const recordOf = async (root: string): Promise<RunRecord> => (await readLocalRunStatus(root))!;

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

/** Every page of a scan, in order. */
async function scanAll<T>(scan: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>): Promise<T[]> {
  const items: T[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await scan(cursor);
    items.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return items;
}

/**
 * What a recorder takes at `at`: the conversations, the tasks, and every document of every scope as stored at `at`. A
 * document that keeps no history (`latest`, and every session or task document) reads only at "current", which is its
 * state at `at` while nothing has committed since.
 */
async function snapshotAt(storage: StoreReads, at: Seq) {
  const conversations = await scanAll((cursor) => storage.scanConversations({}, 100, cursor, ctx));
  const tasks = await scanAll((cursor) => storage.scanTasks({}, 100, cursor, ctx));
  const scopes: DocumentRecord["scope"][] = [
    { kind: "session" },
    ...conversations.map((c) => ({ kind: "conversation" as const, conversationId: c.id })),
    ...tasks.map((t) => ({ kind: "task" as const, taskId: t.id })),
  ];
  const documents = [];
  for (const scope of scopes) {
    for (const record of await scanAll((cursor) => storage.scanDocuments({ scope, at }, 100, cursor, ctx))) {
      documents.push(await storage.document(record.id, record.history === "rewindable" ? at : "current", ctx));
    }
  }
  return { conversations, tasks, documents };
}

describe("openDurableRun", () => {
  it("opens in order (claim, the store's lock tried, layout, store, Harness, record) and keeps the record in the store, no lease file", async () => {
    const dir = scratchRoot("order");
    try {
      const t = setup(dir.root);
      const run = await t.open();
      assert.deepEqual(t.steps, ["acquire", "claim-dir", "layout", "store", "harness", "record", "resume"]);
      for (const path of ["store", "work", "tmp", join("store", STORE_FILE)]) assert.ok(existsSync(join(dir.root, path)), path);
      assert.deepEqual(readdirSync(dir.root).filter((name) => /^(run\.json|owner\.lock)/.test(name)), [], "no lease file");
      const record = run.record;
      assert.deepEqual({ ...record, holder: null, updatedAt: "" }, { run: "r1", status: "running", generation: 1, wakeAt: null, holder: null, updatedAt: "", detail: null });
      assert.equal(record.holder?.pid, process.pid);
      assert.equal(record.holder?.driver, "local");
      assert.equal(run.generation, 1);
      assert.equal(run.claim.root, dir.root);
      await run.release();
      assert.deepEqual(t.claim.log, ["acquire", "cleanup", "barrier", "release"]);
      assert.deepEqual({ ...(await recordOf(dir.root)), updatedAt: "" }, { ...record, status: "paused", updatedAt: "" }, "the release left it paused in the store");
    } finally {
      dir.remove();
    }
  });

  it("afterClaim runs once the claim is held (layout) and before the store and the Harness, which open with what it returns", async () => {
    const dir = scratchRoot("after-claim");
    try {
      const own = scriptedHarness();
      let seen: { root: string; work: boolean; store: boolean } | undefined;
      const t = setup(dir.root, {
        options: {
          harness: undefined,
          afterClaim: async (claim) => {
            seen = { root: claim.root, work: existsSync(claim.work), store: existsSync(join(claim.store, STORE_FILE)) };
            return { harness: { models: own.models, registry: own.registry } };
          },
        },
      });
      const run = await t.open();
      assert.deepEqual(t.steps, ["acquire", "claim-dir", "layout", "after-claim", "store", "harness", "record", "resume"]);
      assert.deepEqual(seen, { root: dir.root, work: true, store: false }, "on the claimed directory, laid out, before the store opens");
      const root = await run.harness.root(ctx, { agent: own.agent });
      assert.equal((await (await root.submit({ type: "input", content: "hello" }, ctx)).wait(ctx)).status, "done", "the Harness has the options afterClaim returned");
      await run.release();
    } finally {
      dir.remove();
    }
  });

  it("an afterClaim that fails leaves the store as it was: none on a new run, the previous record on a resume, the claim let go, and the next open runs it again", async () => {
    const dir = scratchRoot("after-claim-refused");
    try {
      let calls = 0;
      const refusing = { afterClaim: async () => { calls++; throw new Error("the app module did not load"); } };
      for (let attempt = 0; attempt < 2; attempt++) {
        const t = setup(dir.root, { options: refusing });
        await assert.rejects(t.open(), /did not load/);
        assert.deepEqual(t.steps, ["acquire", "claim-dir", "layout"], "no store opened");
        assert.equal(existsSync(join(dir.root, "store", STORE_FILE)), false, "a new run still has no store");
        assert.deepEqual(t.claim.log, ["acquire", "release"], "the claim is let go, not fenced");
      }
      assert.equal(calls, 2, "the next open ran afterClaim again");
      await (await setup(dir.root).open()).release();
      const left = await recordOf(dir.root);
      const resumed = setup(dir.root, { options: refusing });
      await assert.rejects(resumed.open(), /did not load/);
      assert.deepEqual(await recordOf(dir.root), left, "a resume leaves the previous incarnation's record as it was");
      assert.deepEqual(resumed.claim.log, ["acquire", "release"]);
      const none = setup(dir.root, { options: { harness: undefined, afterClaim: async () => ({}) } });
      await assert.rejects(none.open(), (e: unknown) => e instanceof RunError && e.code === "INVALID_ARGUMENT" && /afterClaim returned none/.test((e as Error).message));
      assert.deepEqual(await recordOf(dir.root), left, "no Harness options from afterClaim: refused the same way");
      assert.deepEqual(none.claim.log, ["acquire", "release"]);
      const neither = setup(dir.root, { options: { harness: undefined } });
      await assert.rejects(neither.open(), (e: unknown) => e instanceof RunError && e.code === "INVALID_ARGUMENT");
      assert.deepEqual(neither.claim.log, [], "no Harness options and no afterClaim: refused before any claim");
    } finally {
      dir.remove();
    }
  });

  it("an invalid read through the run's store is refused and the run's Session goes on (pi 1.2 fails a Session on any other Storage error)", async () => {
    const dir = scratchRoot("invalid-read");
    try {
      const t = setup(dir.root);
      const run = await t.open();
      const root = await run.harness.root(ctx, { agent: t.agent });
      assert.equal((await (await root.submit({ type: "input", content: "hello" }, ctx)).wait(ctx)).status, "done");
      // The run's store is pi's SqliteStorage behind the lease's commit observer: an invalid request must reach the Session
      // as the loaded pi's own StorageRequestError (1.2 tests its class), not rewrapped.
      const RequestError = (piDurable as Record<string, unknown>).StorageRequestError as (new (message: string) => Error) | undefined;
      const refused = (error: unknown) => {
        assert.ok(error instanceof Error);
        if (RequestError) assert.ok(error instanceof RequestError, `a StorageRequestError, not ${error.name}: ${error.message}`);
        return true;
      };
      await assert.rejects(root.entries({}, 10, { after: "not a sequence" } as never, ctx), refused);
      await assert.rejects(root.commit((tx) => tx.scanEntries({ conversationId: 987_654 as never }, 10), ctx), refused);
      assert.equal((await (await root.submit({ type: "input", content: "again" }, ctx)).wait(ctx)).status, "done");
      assert.deepEqual(t.fenced, [], "an invalid read fences nothing");
      await run.release();
    } finally {
      dir.remove();
    }
  });

  it("an awaited beforeResume runs to completion before a resumed task takes its first step, and what it admits commits first", async () => {
    const dir = scratchRoot("before-resume");
    try {
      // a bash call in flight when the first incarnation is released: the next one resumes that turn, and its first step
      // is a model call (the call's result, interrupted, goes back to the model)
      const first = setup(dir.root);
      const run1 = await first.open();
      const { conversationId } = await startCommandIn(run1, first.agent);
      await run1.release();
      const sealed = await headOf(dir.root);
      const seen: string[] = [];
      let hookDone: number | undefined;
      let firstCall: number | undefined;
      let database: SqliteDatabase | undefined;
      const second = setup(dir.root, {
        options: {
          decorateStore: (db) => (database = db),
          beforeResume: async ({ harness, context, generation }) => {
            seen.push(`scheduling ${(await harness.inspect(context)).scheduling}`);
            await new Promise((resolve) => setTimeout(resolve, 300)); // an awaited step: the resumed work waits for it
            // what the hook admits into the resumed task's own conversation (a note on where it now runs)
            const conversation = (await harness.conversation(conversationId, context))!;
            await conversation.submit({ type: "write", requestId: `moved-${generation}`, entry: { kind: "app.notice", data: { generation } } }, context);
            seen.push(`done in generation ${generation}`);
            hookDone = performance.now();
          },
        },
      });
      second.faux.setResponses(Array.from({ length: 50 }, () => (...args: Parameters<typeof scriptedReply>) => {
        firstCall ??= performance.now();
        return scriptedReply(...args);
      }));
      const run2 = await second.open();
      for (let i = 0; i < 200 && firstCall === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 25));
      await new Promise((resolve) => setTimeout(resolve, 300)); // the turn's commits after the call
      assert.deepEqual(seen, ["scheduling paused", "done in generation 2"], "the hook ran to the end, before the scheduler started");
      assert.deepEqual(second.steps.slice(-3), ["record", "before-resume", "resume"]);
      assert.ok(firstCall !== undefined, "the resumed turn took its first step");
      assert.ok(hookDone! <= firstCall!, `the hook finished (${hookDone}) before the resumed turn's first model call (${firstCall})`);
      // commit order, from the store: everything the resumed turn committed in this incarnation comes after the hook's entry
      const rows = (await database!.all<{ commit_seq: number; record: string }>("SELECT commit_seq, record FROM entries"))
        .map((row) => ({ seq: Number(row.commit_seq), entry: JSON.parse(row.record) as { kind: string; conversationId: unknown } }))
        .filter((row) => String(row.entry.conversationId) === String(conversationId));
      const notice = rows.find((row) => row.entry.kind === "app.notice");
      assert.ok(notice, "the hook's entry is in the store");
      // Between the first incarnation's seal and the hook's entry, only the result pi writes to close the call left in flight
      // (`interrupted`, so the conversation stays a call followed by its result) when the hook's write is admitted; every
      // step of the resumed turn commits after the hook's entry
      const order = JSON.stringify(rows.map((row) => [row.seq, row.entry.kind]));
      assert.ok(rows.filter((row) => row.seq > sealed && row.seq < notice!.seq).every((row) => row.entry.kind === "pi.tool-result"), order);
      assert.ok(rows.some((row) => row.seq > notice!.seq && row.entry.kind === "pi.assistant"), `the resumed turn's model reply commits after the hook's entry: ${order}`);
      await run2.release();
    } finally {
      dir.remove();
    }
  });

  it("beforeResume's previous is null on a run's first open; record is this incarnation's", async () => {
    const dir = scratchRoot("before-resume-first");
    try {
      let got: Pick<BeforeResume, "previous" | "record" | "generation"> | undefined;
      const t = setup(dir.root, { options: { beforeResume: ({ previous, record, generation }) => void (got = { previous, record, generation }) } });
      const run = await t.open();
      assert.equal(got!.previous, null);
      assert.deepEqual([got!.generation, got!.record.generation, got!.record.status], [1, 1, "running"]);
      await run.release();
    } finally {
      dir.remove();
    }
  });

  it("after a park, beforeResume's previous is the parked record: sleeping, its wakeAt and detail", async () => {
    const dir = scratchRoot("before-resume-parked");
    try {
      const first = setup(dir.root);
      const parked = await first.open();
      const wakeAt = new Date(Date.now() + 90_000).toISOString();
      await parked.setStatus("sleeping", { why: "retry backoff" }, { wakeAt });
      await parked.release();
      const left = await recordOf(dir.root);
      let got: Pick<BeforeResume, "previous" | "record"> | undefined;
      const second = setup(dir.root, { options: { beforeResume: ({ previous, record }) => void (got = { previous, record }) } });
      const run = await second.open();
      assert.deepEqual(got!.previous, left, "exactly the record the parked incarnation left");
      assert.deepEqual([got!.previous!.status, got!.previous!.wakeAt, got!.previous!.detail, got!.previous!.generation], ["sleeping", wakeAt, { why: "retry backoff" }, 1]);
      // The open had already written this incarnation's record over it: running, generation 2, the detail gone.
      assert.deepEqual([got!.record.status, got!.record.generation, got!.record.detail, got!.record.wakeAt], ["running", 2, null, null]);
      await run.release();
    } finally {
      dir.remove();
    }
  });

  it("after a crash, beforeResume's previous is the dead incarnation's record: running, the killed process as holder", async () => {
    const dir = scratchRoot("before-resume-crashed");
    const child = spawn(process.execPath, [new URL("./fixtures/open-and-hold.ts", import.meta.url).pathname, dir.root, "r1"], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, NODE_NO_WARNINGS: "1" } });
    try {
      const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
      const opened = String((await lines.next()).value);
      const deadPid = Number(/^opened 1 (\d+)$/.exec(opened)?.[1]);
      assert.equal(deadPid, child.pid, opened);
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
      let previous: RunRecord | null | undefined;
      const t = setup(dir.root, { options: { beforeResume: (run) => void (previous = run.previous) } });
      const run = await t.open();
      assert.deepEqual([previous!.status, previous!.generation, previous!.holder?.pid, previous!.detail], ["running", 1, deadPid, null]);
      assert.equal(run.generation, 2);
      await run.release();
    } finally {
      child.kill("SIGKILL");
      dir.remove();
    }
  });

  it("a beforeResume that rejects fails the open, before resume, and releases the claim", async () => {
    const dir = scratchRoot("before-resume-fails");
    try {
      const t = setup(dir.root, { options: { beforeResume: async () => Promise.reject(new Error("the app refused")) } });
      await assert.rejects(t.open(), /the app refused/);
      assert.ok(!t.steps.includes("resume"), `steps: ${t.steps.join(", ")}`);
      assert.ok(t.claim.log.includes("release"), "the claim was released");
    } finally {
      dir.remove();
    }
  });

  /** A first incarnation that configured its root and finished one turn: conversations, tasks and documents, none in flight. */
  async function finishedTurn(root: string): Promise<void> {
    const first = setup(root);
    const run = await first.open();
    const conversation = await run.harness.root(ctx, { agent: first.agent });
    await conversation.configure({ instructions: "one" }, ctx);
    await (await conversation.submit({ type: "input", content: "hello", requestId: "hello-1" }, ctx)).wait(ctx);
    await run.harness.waitForIdle(ctx);
    await run.release();
  }

  it("beforeResume gets the store the Harness was opened over: a snapshot of every document at its head is what the store holds", async () => {
    const dir = scratchRoot("before-resume-snapshot");
    try {
      await finishedTurn(dir.root);
      let got: { head: number; snapshot: Awaited<ReturnType<typeof snapshotAt>> } | undefined;
      const second = setup(dir.root, { options: { beforeResume: async ({ storage, head }) => void (got = { head, snapshot: await snapshotAt(storage, head) }) } });
      const run = await second.open();
      await run.release();
      // Nothing resumed and nothing committed after the hook: the store as it is now is the store the hook read.
      assert.equal(await headOf(dir.root), got!.head, "the hook's head is the store's head");
      const { conversations, tasks, documents } = got!.snapshot;
      assert.ok(conversations.length > 0 && tasks.length > 0 && documents.length > 0, `a snapshot with something in it: ${JSON.stringify([conversations.length, tasks.length, documents.length])}`);
      const store = await openArchilStore(join(dir.root, "store", STORE_FILE));
      try {
        assert.deepEqual(await snapshotAt(store.storage, got!.head as Seq), got!.snapshot);
      } finally {
        await store.storage.close(ctx);
      }
    } finally {
      dir.remove();
    }
  });

  it("beforeResume's storage has the four reads and no write: commit and mintId are not there, even through a cast", async () => {
    const dir = scratchRoot("before-resume-reads");
    try {
      await finishedTurn(dir.root);
      const tried: string[] = [];
      let database: SqliteDatabase | undefined;
      let headBefore = 0;
      const second = setup(dir.root, {
        options: {
          decorateStore: (db) => (database = db),
          beforeResume: async ({ storage, head }) => {
            headBefore = head;
            assert.deepEqual(Object.keys(storage).sort(), ["document", "scanConversations", "scanDocuments", "scanTasks"]);
            assert.ok(Object.isFrozen(storage), "nothing can be added to it");
            const writable = storage as unknown as Storage;
            for (const write of [() => writable.commit([], ctx), () => writable.mintId()]) {
              try {
                await write();
                tried.push("ran");
              } catch (error) {
                tried.push((error as Error).name);
              }
            }
          },
        },
      });
      const run = await second.open();
      assert.deepEqual(tried, ["TypeError", "TypeError"], "commit and mintId are not functions on it");
      const head = await database!.get<{ next_seq: number }>("SELECT next_seq FROM durable_metadata WHERE singleton = 1");
      assert.equal(Number(head!.next_seq) - 1, headBefore, "nothing committed through it");
      await run.release();
    } finally {
      dir.remove();
    }
  });

  it("beforeResume's head is the store's head at the hook, and a later commit leaves the value it got where it was", async () => {
    const dir = scratchRoot("before-resume-head");
    try {
      await finishedTurn(dir.root);
      let seen: BeforeResume | undefined;
      let atHook: number | undefined;
      let database: SqliteDatabase | undefined;
      const second = setup(dir.root, {
        options: {
          decorateStore: (db) => (database = db),
          beforeResume: async (run) => {
            seen = run;
            const row = await database!.get<{ next_seq: number }>("SELECT next_seq FROM durable_metadata WHERE singleton = 1");
            atHook = Number(row!.next_seq) - 1;
          },
        },
      });
      const run = await second.open();
      assert.equal(seen!.head, atHook, "the head the hook got is the store's head while it ran");
      const root = await run.harness.root(ctx, { agent: second.agent });
      await root.configure({ instructions: "two" }, ctx);
      const after = await storeHead(run.store);
      assert.ok(after > atHook!, `a commit after the hook moved the store's head (${atHook} to ${after})`);
      assert.equal(seen!.head, atHook, "the value the hook got did not move");
      await run.release();
    } finally {
      dir.remove();
    }
  });

  it("bumps the generation on every open, and a release leaves a running run paused in its store", async () => {
    const dir = scratchRoot("generation");
    try {
      const first = setup(dir.root);
      const run1 = await first.open();
      const root = await run1.harness.root(ctx, { agent: first.agent });
      await root.configure({ instructions: "one" }, ctx);
      await run1.release();
      const left1 = await recordOf(dir.root);
      assert.equal(left1.status, "paused", "a running run is left paused");
      assert.equal(left1.generation, 1);
      const second = setup(dir.root);
      const run2 = await second.open();
      assert.equal(run2.generation, 2);
      await run2.release();
      assert.equal((await recordOf(dir.root)).generation, 2);
    } finally {
      dir.remove();
    }
  });

  it("writes the host's handle as the holder, with this process's pid and since", async () => {
    const dir = scratchRoot("holder");
    try {
      const handle = { driver: "local", host: "host-b", unit: "pda-r1.service", mountpoint: "/mnt/archil/runs/r1", pid: 1, since: "x" };
      const run = await setup(dir.root, { options: { holder: handle } }).open();
      const holder = run.record.holder!;
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

  it("an env factory that throws abandons the open: the claim is released and the store is free", async () => {
    const dir = scratchRoot("env-throws");
    try {
      await (await setup(dir.root).open()).release();
      const t = setup(dir.root, { options: { env: () => { throw new Error("setpriv is missing"); } } });
      const refused = await t.open().then(() => null, (error: unknown) => error);
      assert.ok(refused instanceof Error && refused.message === "setpriv is missing", String(refused));
      assert.deepEqual(t.claim.log, ["acquire", "release"], "the claim is released, not fenced");
      assert.equal(t.fenced.length, 0);
      assert.equal((await recordOf(dir.root)).generation, 1, "the store is free, and its record is the last open's");
    } finally {
      dir.remove();
    }
  });

});

describe("storeHead reads pi's store head", () => {
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

describe("fences during the run", () => {
  it("a commit that fails with SQLITE_IOERR_FSYNC fences the run once: commands die, then onFenced; nothing more is recorded", async () => {
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
      assert.equal(run.record.status, "running", "nothing more was recorded");
      assert.ok(!t.claim.log.includes("release"));
      await faulty.database!.inner.close();
    } finally {
      killQuietly(pid);
      dir.remove();
    }
  });

  for (const synchronous of ["FULL", "NORMAL"] as const) {
    it(`at ${synchronous}, a fenced run's status write fails with the fence's own error, never the barrier's (barriers.ts runStatus)`, async () => {
      const dir = scratchRoot(`status-fence-${synchronous}`);
      try {
        const faulty: { database?: FaultyDatabase } = {};
        const decorateStore = (database: SqliteDatabase) => (faulty.database = new FaultyDatabase(database));
        const t = setup(dir.root, { options: { decorateStore, synchronous } });
        const run = await t.open();
        const root = await run.harness.root(ctx, { agent: t.agent });
        faulty.database!.failNextCommit(sqliteError(SQLITE_IOERR_FSYNC, "disk I/O error"));
        await assert.rejects(root.configure({ instructions: "never durable" }, ctx), StoreFencedError);
        await until(() => t.fenced.length === 1);
        await assert.rejects(run.setStatus("failed", { reason: "fenced" }), (error) => error === t.fenced[0]);
        assert.equal(run.record.status, "running");
        await faulty.database!.inner.close();
      } finally {
        dir.remove();
      }
    });
  }

  it("a fenced run whose Harness then closes answers with the fence's error, never RELEASE_ORDER: a fence's close is not the app's misuse", async () => {
    const dir = scratchRoot("fence-then-close");
    try {
      const faulty: { database?: FaultyDatabase } = {};
      const decorateStore = (database: SqliteDatabase) => (faulty.database = new FaultyDatabase(database));
      const t = setup(dir.root, { options: { decorateStore } });
      const run = await t.open();
      const root = await run.harness.root(ctx, { agent: t.agent });
      faulty.database!.failNextCommit(sqliteError(SQLITE_IOERR_FSYNC, "disk I/O error"));
      await assert.rejects(root.configure({ instructions: "never durable" }, ctx), StoreFencedError);
      await until(() => t.fenced.length === 1);
      await run.harness.close(ctx).catch(() => undefined);
      await assert.rejects(run.setStatus("failed", { reason: "fenced" }), (error) => error === t.fenced[0]);
      await assert.rejects(run.release(), (error) => error === t.fenced[0]);
      assert.equal(run.record.status, "running");
      await faulty.database!.inner.close();
    } finally {
      dir.remove();
    }
  });
});

describe("release", () => {
  it("records the release in the store, closes, kills the commands, barriers, then lets go of the claim directory", async () => {
    const dir = scratchRoot("release");
    let pid = 0;
    try {
      const atUnmount: { commandAlive?: boolean; record?: RunRecord; rootOpen?: number } = {};
      const t = setup(dir.root, {
        claim: {
          release: async () => {
            atUnmount.rootOpen = fdsOn(dir.root).length;
            atUnmount.commandAlive = !(await waitGone(pid, 2_000));
            atUnmount.record = (await readLocalRunStatus(dir.root))!;
          },
        },
      });
      const run = await t.open();
      await (await run.harness.root(ctx, { agent: t.agent })).configure({ instructions: "x" }, ctx);
      pid = await startCommand(run, t.agent);
      t.steps.length = 0;
      await run.release();
      assert.deepEqual(t.steps, ["record", "close", "cleanup", "barrier", "unmount"]);
      assert.deepEqual(t.claim.log, ["acquire", "cleanup", "barrier", "release"]);
      assert.equal(atUnmount.commandAlive, false, "the command was dead before the unmount");
      assert.equal(atUnmount.record?.status, "paused", "the store was free before the unmount, and its record says paused");
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
    it(`a rejecting close is a fence (${what}): the claim is not released`, async () => {
      const dir = scratchRoot("close-fence");
      try {
        let raw: CloseFails | undefined;
        const decorateStore = (database: SqliteDatabase): SqliteDatabase => (raw = new CloseFails(database, errcode));
        const t = setup(dir.root, { options: { decorateStore } });
        const run = await t.open();
        await run.harness.root(ctx, { agent: t.agent });
        await assert.rejects(run.release(), FencedError);
        assert.equal(t.fenced.length, 1);
        assert.ok(!t.claim.log.includes("barrier") && !t.claim.log.includes("release"), t.claim.log.join(","));
        await raw!.inner.close();
      } finally {
        dir.remove();
      }
    });
  }

  it("a failed barrier is a fence: the claim is not released", async () => {
    const dir = scratchRoot("barrier-fence");
    try {
      const t = setup(dir.root, { claim: { barrier: () => Promise.reject(new FencedError("archil sync: the mount is failed or read-only")) } });
      const run = await t.open();
      await assert.rejects(run.release(), FencedError);
      assert.equal(t.fenced.length, 1);
      assert.ok(!t.claim.log.includes("release"));
    } finally {
      dir.remove();
    }
  });

  it("setStatus writes transitions in the store, and done and failed run the barrier first", async () => {
    const dir = scratchRoot("status");
    try {
      const log: string[] = [];
      const t = setup(dir.root, { claim: { log } });
      const run = await t.open();
      const wakeAt = new Date(Date.now() + 60_000).toISOString();
      await run.setStatus("sleeping", { why: "poll" }, { wakeAt });
      assert.deepEqual([run.record.status, run.record.wakeAt, run.record.detail], ["sleeping", wakeAt, { why: "poll" }]);
      log.length = 0;
      await run.setStatus("done", { ok: true });
      assert.deepEqual(log, ["barrier"], "the barrier ran before the terminal status");
      assert.equal(run.record.wakeAt, null);
      await run.release();
      const left = await recordOf(dir.root);
      assert.equal(left.status, "done", "release keeps a terminal status");
      assert.deepEqual(left.detail, { ok: true });
    } finally {
      dir.remove();
    }
  });
});
