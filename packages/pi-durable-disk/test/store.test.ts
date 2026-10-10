// The store: pragma read-back per profile, fence classification, a real Harness poisoned by an
// injected SQLITE_IOERR_FSYNC, and pi's storage conformance on both profiles on local disk. No Archil, no network, no model.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { Storage } from "@earendil-works/pi-durable";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";
import type { StorageConformanceProvider } from "@earendil-works/pi-durable/testing";
import { PI_DURABLE_VERSION, registerConformance, runConformance, SCANS_HAVE_ORDER } from "./_conformance.ts";
import {
  ctx,
  entryCommitter,
  FaultyDatabase,
  SQLITE_FULL,
  SQLITE_IOERR,
  SQLITE_IOERR_FSYNC,
  SQLITE_IOERR_WRITE,
  SQLITE_NOTADB,
  sqliteError,
  withStoreIn,
} from "./_support.ts";
import {
  assertPragmas,
  Fence,
  FencedDatabase,
  openArchilStore,
  PROFILE_PRAGMAS,
  StoreBusyError,
  StoreFencedError,
  StorePragmaError,
} from "../src/store.ts";
import type { ArchilStore, Profile } from "../src/store.ts";
import { exitCodeFor } from "../src/errors.ts";

const PROFILES: readonly Profile[] = ["exclusive", "shared"];

/** Result codes in an error description produced by the rlimit fixture: the error's own and its aggregate members'. */
const codesIn = (shape: { errcode?: number; members?: unknown[] } | undefined): number[] =>
  shape === undefined ? [] : [...(shape.errcode === undefined ? [] : [shape.errcode]), ...(shape.members ?? []).flatMap((m) => codesIn(m as typeof shape))];

function scratch(label: string): { dir: string; file: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), `pda-store-${label}-`));
  return { dir, file: join(dir, "store", "run.sqlite"), remove: () => rmSync(dir, { recursive: true, force: true }) };
}

const withStore = <T>(profile: Profile, use: (store: ArchilStore, file: string) => Promise<T>): Promise<T> =>
  withStoreIn(tmpdir(), profile, use);

const pragmaValue = async (store: ArchilStore, name: string): Promise<unknown> =>
  Object.values((await store.database.get<Record<string, unknown>>(`PRAGMA ${name}`))!)[0];

// ---- T2: pi's storage conformance, local disk, both profiles ----------------------------------------------------

for (const profile of PROFILES) {
  const withStorage: StorageConformanceProvider = (use) =>
    withStore(profile, async (store, file) => {
      await use(store.storage);
      if (profile === "exclusive") assert.equal(existsSync(`${file}-shm`), false, "the exclusive profile created -shm");
    });
  registerConformance(`storage conformance, ${profile} profile, local disk`, withStorage);
}

describe("the conformance runner is not vacuous", () => {
  it("fails a storage that silently drops task writes", async () => {
    const withBroken: StorageConformanceProvider = async (use) => {
      const inner = new MemoryStorage();
      const broken = new Proxy(inner, {
        get(target, prop) {
          if (prop === "commit") return (writes: Parameters<Storage["commit"]>[0], c: Parameters<Storage["commit"]>[1]) => target.commit(writes.filter((w) => w.type !== "task"), c);
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await use(broken);
    };
    const { total, failed } = await runConformance(withBroken);
    assert.ok(failed.length > 0, "a broken storage passed every case");
    assert.ok(failed.length < total, "every case failed, so the control proves nothing about the assertions");
  });

  it("fails a storage that ignores the order a scan asks for", { skip: SCANS_HAVE_ORDER ? false : `pi-durable ${PI_DURABLE_VERSION}'s Storage has no scan order` }, async () => {
    // The pinned pi-durable's own case for `order`; a release that renames it fails here, by name.
    const SCAN_ORDER_CASE = "scans tables in either ID order and continues a cursor in its order";
    const SCANS = new Set<PropertyKey>(["scanConversations", "scanEntries", "scanTasks", "scanSubmissions"]);
    const withUnordered: StorageConformanceProvider = async (use) => {
      const inner = new MemoryStorage();
      const unordered = new Proxy(inner, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (typeof value !== "function") return value;
          if (!SCANS.has(prop)) return value.bind(target);
          return (query: { order?: unknown }, ...rest: unknown[]) => {
            const { order: _dropped, ...unorderedQuery } = query;
            return value.call(target, unorderedQuery, ...rest);
          };
        },
      });
      await use(unordered);
    };
    // The unchanged storage passes every case, so a failure below comes from the one thing the proxy changes.
    const unchanged = await runConformance(async (use) => { await use(new MemoryStorage()); });
    assert.deepEqual(unchanged.failed, [], "the unchanged storage failed a case, so the control proves nothing about order");
    const { total, failed } = await runConformance(withUnordered);
    assert.ok(failed.includes(SCAN_ORDER_CASE), `the scan-order case passed on a storage that drops order; failed: ${JSON.stringify(failed)}`);
    assert.ok(failed.length < total, "every case failed, so the control proves nothing about the assertions");
  });
});

// ---- T1: profiles and pragma read-back -------------------------------------------------------------------------

describe("profiles", () => {
  for (const profile of PROFILES) {
    it(`${profile}: every pragma reads back at FULL with mmap off`, async () => {
      await withStore(profile, async (store) => {
        for (const [name, expected] of Object.entries(PROFILE_PRAGMAS[profile])) {
          assert.equal(await pragmaValue(store, name), expected, `${profile} ${name}`);
        }
        assert.equal(await pragmaValue(store, "synchronous"), 2, "synchronous is FULL");
      });
    });
  }

  it("exclusive: no -shm file ever exists; shared creates one (control)", async () => {
    await withStore("exclusive", async (store, file) => {
      const writer = entryCommitter(store.storage);
      await writer.setup();
      for (let n = 0; n < 50; n++) await writer.commit(n);
      assert.ok(existsSync(`${file}-wal`), "the exclusive store runs in WAL mode");
      assert.equal(existsSync(`${file}-shm`), false);
    });
    await withStore("shared", async (store, file) => {
      await entryCommitter(store.storage).setup();
      assert.ok(existsSync(`${file}-shm`), "the control is meaningless if the shared profile makes no -shm");
    });
  });

  it("exclusive: a second connection gets 'database is locked'; after the owner closes it opens", async () => {
    const dir = scratch("locked");
    try {
      const store = await openArchilStore(dir.file, "exclusive");
      await entryCommitter(store.storage).setup();
      const other = new DatabaseSync(dir.file, { timeout: 0 });
      assert.throws(
        () => other.prepare("SELECT count(*) AS n FROM durable_metadata").get(),
        (error: Error & { errcode?: number }) => error.errcode === 5 && /database is locked/.test(error.message),
      );
      other.close();
      await assert.rejects(openArchilStore(dir.file, "exclusive"), StoreBusyError);
      await store.storage.close(ctx);
      const reopened = new DatabaseSync(dir.file, { timeout: 0 });
      assert.deepEqual({ ...reopened.prepare("SELECT count(*) AS n FROM entries").get() }, { n: 0 });
      reopened.close();
    } finally {
      dir.remove();
    }
  });

  it("exclusive: a refused second open leaves the first store writable", async () => {
    await withStore("exclusive", async (store, file) => {
      const writer = entryCommitter(store.storage);
      await writer.setup();
      await writer.commit(0);
      await assert.rejects(openArchilStore(file, "exclusive"), StoreBusyError);
      await writer.commit(1);
      assert.equal(store.database.fenced, false);
    });
  });

  it("shared: a second store on the same file sees live commits", async () => {
    await withStore("shared", async (first, file) => {
      const writer = entryCommitter(first.storage);
      await writer.setup();
      await writer.commit(0);
      const second = await openArchilStore(file, "shared");
      try {
        const page = await second.storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 10, undefined, ctx);
        assert.equal(page.items.length, 1);
        await writer.commit(1);
        const later = await second.storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 10, undefined, ctx);
        assert.equal(later.items.length, 2);
      } finally {
        await second.storage.close(ctx);
      }
    });
  });
});

describe("pragma read-back refuses a wrong pragma", () => {
  it("rejects an unknown profile before touching the file", async () => {
    await assert.rejects(openArchilStore(join(tmpdir(), "pda-never-created", "run.sqlite"), "exclusiv" as Profile), TypeError);
    assert.equal(existsSync(join(tmpdir(), "pda-never-created")), false);
  });

  it("rejects a database that cannot run WAL (journal_mode reads back 'memory')", async () => {
    for (const profile of PROFILES) {
      await assert.rejects(openArchilStore(":memory:", profile), (error: unknown) => {
        assert.ok(error instanceof StorePragmaError);
        assert.equal(error.profile, profile);
        const journal = error.mismatches.find((m) => m.pragma === "journal_mode");
        assert.deepEqual(journal && [journal.expected, journal.actual], ["wal", "memory"]);
        return true;
      });
    }
  });

  it("names every pragma that differs, per profile", async () => {
    const reads = (values: Record<string, unknown>): SqliteExecutor => ({
      async exec() {},
      async run() {},
      async all() {
        return [];
      },
      async get<T extends object>(sql: string): Promise<T | undefined> {
        const name = sql.replace("PRAGMA ", "");
        return { [name]: values[name] } as T;
      },
    });
    await assertPragmas(reads(PROFILE_PRAGMAS.exclusive), "exclusive");
    await assertPragmas(reads(PROFILE_PRAGMAS.shared), "shared");
    await assert.rejects(
      assertPragmas(reads({ ...PROFILE_PRAGMAS.exclusive, locking_mode: "normal", synchronous: 1, mmap_size: 268435456 }), "exclusive"),
      (error: unknown) => {
        assert.ok(error instanceof StorePragmaError);
        assert.deepEqual(error.mismatches.map((m) => m.pragma), ["locking_mode", "synchronous", "mmap_size"]);
        return true;
      },
    );
    await assert.rejects(assertPragmas(reads(PROFILE_PRAGMAS.exclusive), "shared"), StorePragmaError);
  });
});

// ---- T1: the fence-aware facade --------------------------------------------------------------------------------

/** A database whose every call is counted and answers from `behavior`. */
function scripted(behavior: Partial<Record<"exec" | "run" | "get" | "all" | "transaction" | "close", (...args: unknown[]) => unknown>> = {}) {
  const calls: string[] = [];
  const call = (name: keyof typeof behavior) => async (...args: unknown[]) => {
    calls.push(name);
    return behavior[name]?.(...args);
  };
  const database = {
    exec: call("exec"),
    run: call("run"),
    get: call("get"),
    all: call("all"),
    transaction: call("transaction"),
    close: call("close"),
  } as unknown as SqliteDatabase;
  return { database, calls };
}

const throwing = (error: unknown) => () => {
  throw error;
};

describe("FencedDatabase classification", () => {
  const fencing: ReadonlyArray<[string, number]> = [
    ["SQLITE_IOERR", SQLITE_IOERR],
    ["SQLITE_IOERR_READ", 266],
    ["SQLITE_IOERR_SHORT_READ", 522],
    ["SQLITE_IOERR_WRITE", SQLITE_IOERR_WRITE],
    ["SQLITE_IOERR_FSYNC", SQLITE_IOERR_FSYNC],
    ["SQLITE_IOERR_DIR_FSYNC", 1290],
    ["SQLITE_IOERR_LOCK", 3850],
    ["SQLITE_FULL", SQLITE_FULL],
    ["SQLITE_NOTADB", SQLITE_NOTADB],
  ];
  for (const [name, errcode] of fencing) {
    it(`${name} (${errcode}) fences the handle`, async () => {
      const original = sqliteError(errcode, name);
      const fence = new Fence();
      const { database } = scripted({ run: throwing(original) });
      const facade = new FencedDatabase(database, fence);
      await assert.rejects(facade.run("INSERT"), (error: unknown) => {
        assert.ok(error instanceof StoreFencedError);
        assert.equal(error.errcode, errcode);
        assert.equal(error.cause, original);
        assert.equal(error.code, "STORE_FENCED");
        return true;
      });
      assert.equal(facade.fenced, true);
      assert.equal(fence.fenced, true);
    });
  }

  const passing: ReadonlyArray<[string, unknown]> = [
    ["SQLITE_ERROR", sqliteError(1, "SQL logic error")],
    ["SQLITE_BUSY", sqliteError(5, "database is locked")],
    ["SQLITE_CONSTRAINT", sqliteError(19, "constraint failed")],
    ["SQLITE_CONSTRAINT_UNIQUE", sqliteError(2067, "UNIQUE constraint failed")],
    ["an error with no result code", new Error("boom")],
    ["a non-error throw", "boom"],
  ];
  for (const [name, original] of passing) {
    it(`${name} propagates unchanged and does not fence`, async () => {
      const { database } = scripted({ get: throwing(original) });
      const facade = new FencedDatabase(database);
      await assert.rejects(facade.get("SELECT 1"), (error: unknown) => error === original);
      assert.equal(facade.fenced, false);
      await assert.rejects(facade.get("SELECT 1"), (error: unknown) => error === original);
    });
  }

  it("finds the fencing code inside an AggregateError (a failed COMMIT whose ROLLBACK also failed)", async () => {
    const commit = sqliteError(SQLITE_IOERR_FSYNC, "disk I/O error");
    const rollback = sqliteError(21, "cannot rollback - no transaction is active");
    const { database } = scripted({ transaction: throwing(new AggregateError([commit, rollback], "SQLite transaction failed and rollback failed")) });
    const facade = new FencedDatabase(database);
    await assert.rejects(facade.transaction(async () => undefined), (error: unknown) => {
      assert.ok(error instanceof StoreFencedError);
      assert.equal(error.errcode, SQLITE_IOERR_FSYNC);
      return true;
    });
  });

  it("finds the fencing code behind a cause (a layer above wrapped it)", async () => {
    const wrapped = new Error("Document copy 7 was rejected", { cause: sqliteError(SQLITE_IOERR_WRITE, "disk I/O error") });
    const { database } = scripted({ all: throwing(wrapped) });
    const facade = new FencedDatabase(database);
    await assert.rejects(facade.all("SELECT 1"), StoreFencedError);
  });

  it("fences on a statement inside a transaction handle, even when the caller wraps the error", async () => {
    const original = sqliteError(SQLITE_IOERR_WRITE, "disk I/O error");
    const handle: SqliteExecutor = { exec: async () => {}, run: async () => { throw original; }, get: async () => undefined, all: async () => [] };
    const { database } = scripted({ transaction: (callback) => (callback as (h: SqliteExecutor) => Promise<unknown>)(handle) });
    const fence = new Fence();
    const facade = new FencedDatabase(database, fence);
    await assert.rejects(
      facade.transaction(async (tx) => {
        try {
          await tx.run("INSERT");
        } catch (error) {
          // pi wraps errors raised while it copies documents into StorageRejected, which does not poison its Session.
          throw new Error("Document copy was rejected", { cause: error });
        }
      }),
      (error: unknown) => {
        assert.ok(error instanceof StoreFencedError, "the wrapped failure must still surface as the fenced error");
        return true;
      },
    );
    assert.equal(fence.fenced, true);
  });

  it("a callback that swallows a statement failure cannot issue another statement, and the transaction still fails", async () => {
    const statements: string[] = [];
    const handle: SqliteExecutor = {
      exec: async () => {},
      run: async (sql: string) => {
        statements.push(sql);
        throw sqliteError(SQLITE_IOERR_WRITE, "disk I/O error");
      },
      get: async () => undefined,
      all: async () => [],
    };
    const { database } = scripted({ transaction: (callback) => (callback as (h: SqliteExecutor) => Promise<unknown>)(handle) });
    const facade = new FencedDatabase(database);
    await assert.rejects(
      facade.transaction(async (tx) => {
        await tx.run("FIRST").catch(() => undefined);
        await tx.run("SECOND");
      }),
      StoreFencedError,
    );
    assert.deepEqual(statements, ["FIRST"], "the second statement never reached the database");
    const swallowed = new FencedDatabase(scripted({ transaction: (callback) => (callback as (h: SqliteExecutor) => Promise<unknown>)({ ...handle, run: async () => { throw sqliteError(SQLITE_FULL, "full"); } }) }).database);
    await assert.rejects(
      swallowed.transaction(async (tx) => {
        await tx.run("ONLY").catch(() => undefined);
      }),
      StoreFencedError,
      "a transaction whose callback hid a fencing failure must not resolve",
    );
  });
});

describe("FencedDatabase after a fence", () => {
  it("fails every call at once with the same typed error, calls the inner database no more, runs the callback once", async () => {
    const original = sqliteError(SQLITE_IOERR_FSYNC, "disk I/O error");
    const seen: StoreFencedError[] = [];
    const { database, calls } = scripted({ transaction: throwing(original) });
    const facade = new FencedDatabase(database, new Fence((error) => seen.push(error)));
    await assert.rejects(facade.transaction(async () => undefined), StoreFencedError);
    assert.deepEqual(calls, ["transaction"]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0], facade.fencedBy);
    assert.equal((seen[0] as StoreFencedError).cause, original);

    const attempts: Array<() => Promise<unknown>> = [
      () => facade.exec("PRAGMA synchronous"),
      () => facade.run("INSERT"),
      () => facade.get("SELECT 1"),
      () => facade.all("SELECT 1"),
      () => facade.transaction(async () => undefined),
      () => facade.close(),
    ];
    for (const attempt of attempts) {
      await assert.rejects(attempt(), (error: unknown) => error === facade.fencedBy);
    }
    assert.deepEqual(calls, ["transaction"], "nothing reached the inner database after the fence: no retry, no close");
    assert.equal(seen.length, 1, "the callback runs once");
  });

  it("marks the flag before the callback runs and before the failing call rejects", async () => {
    const order: string[] = [];
    const { database } = scripted({ run: throwing(sqliteError(SQLITE_FULL, "database or disk is full")) });
    const fence = new Fence(() => order.push(`callback fenced=${String(fence.fenced)}`));
    const facade = new FencedDatabase(database, fence);
    await facade.run("INSERT").catch(() => order.push("rejected"));
    assert.deepEqual(order, ["callback fenced=true", "rejected"]);
  });

  it("fails an operation that was in flight when the fence was marked, and discards its result", async () => {
    let releaseGet: (value: unknown) => void = () => {};
    const pending = new Promise<unknown>((resolve) => {
      releaseGet = resolve;
    });
    let seq = 0;
    const { database } = scripted({
      get: () => (seq++ === 0 ? pending : undefined),
      run: throwing(sqliteError(SQLITE_IOERR_WRITE, "disk I/O error")),
    });
    const facade = new FencedDatabase(database);
    const inFlight = facade.get("SELECT 1");
    await assert.rejects(facade.run("INSERT"), StoreFencedError);
    releaseGet({ looks: "durable" });
    await assert.rejects(inFlight, (error: unknown) => error === facade.fencedBy);
  });

  it("a throwing onFenced neither hides the fence nor is swallowed: it surfaces as an uncaught exception", async () => {
    const child = spawnSync(process.execPath, [join(import.meta.dirname, "fixtures", "throwing-listener.ts")], { encoding: "utf8", timeout: 30_000 });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout.trim()), { typed: true, fenced: true, uncaught: ["listener bug"] });
  });

  it("a successful close of a live handle is delegated", async () => {
    const { database, calls } = scripted();
    await new FencedDatabase(database).close();
    assert.deepEqual(calls, ["close"]);
  });

  it("a failing close (the checkpoint hits the fence) fences, so a release cannot seal over it", async () => {
    const { database } = scripted({ close: throwing(sqliteError(SQLITE_IOERR_FSYNC, "disk I/O error")) });
    const facade = new FencedDatabase(database);
    await assert.rejects(facade.close(), StoreFencedError);
    assert.equal(facade.fenced, true);
  });
});

// ---- T1: real faults through the real open path ----------------------------------------------------------------

describe("real faults", () => {
  it("a file that is not a database fences the open (SQLITE_NOTADB from node:sqlite)", async () => {
    for (const profile of PROFILES) {
      const dir = scratch("notadb");
      try {
        await openArchilStore(dir.file, profile).then((s) => s.storage.close(ctx)); // creates store/
        rmSync(dir.file, { force: true });
        rmSync(`${dir.file}-wal`, { force: true });
        rmSync(`${dir.file}-shm`, { force: true });
        writeFileSync(dir.file, Buffer.alloc(8192, 0x5a));
        let callbacks = 0;
        await assert.rejects(openArchilStore(dir.file, profile, { onFenced: () => void callbacks++ }), (error: unknown) => {
          assert.ok(error instanceof StoreFencedError, `${profile}: ${String(error)}`);
          assert.equal(error.errcode, SQLITE_NOTADB);
          return true;
        });
        assert.equal(callbacks, 1);
      } finally {
        dir.remove();
      }
    }
  });

  const shell = existsSync("/bin/sh");
  for (const profile of PROFILES) {
    it(
      `${profile}: a write the kernel refuses (EFBIG under a file-size limit) is SQLITE_IOERR_WRITE and fences`,
      { skip: !shell && "needs /bin/sh", timeout: 60_000 },
      async (t) => {
        const dir = scratch("rlimit");
        try {
          // `ulimit -f` counts 512-byte blocks in dash and 1 KiB blocks in bash: either way far below the WAL's growth.
          const script = 'trap "" XFSZ; ulimit -f 1024; exec "$0" "$@"';
          const child = spawnSync("/bin/sh", ["-c", script, process.execPath, join(import.meta.dirname, "fixtures", "rlimit-writer.ts"), dir.file, profile], {
            encoding: "utf8",
            timeout: 50_000,
          });
          assert.equal(child.status, 0, `child failed: ${child.stderr}`);
          const outcome = JSON.parse(child.stdout.trim().split("\n").at(-1)!) as Record<string, any>;
          t.diagnostic(JSON.stringify(outcome));
          assert.ok(outcome.committed > 0, "some commits must succeed before the limit is hit");
          assert.equal(outcome.firstError.typed, true, JSON.stringify(outcome));
          assert.equal(outcome.firstError.errcode & 0xff, SQLITE_IOERR, "the code is in the I/O class");
          assert.ok(codesIn(outcome.firstError.cause).includes(outcome.firstError.errcode), "the cause carries the code that fenced");
          assert.equal(outcome.fenced, true);
          assert.equal(outcome.callbacks, 1);
          assert.deepEqual(outcome.laterCall, { typed: true, same: true });
        } finally {
          dir.remove();
        }
      },
    );
  }
});

// ---- T1: a real pi Harness poisoned by an injected SQLITE_IOERR_FSYNC ------------------------------------------

describe("a real Harness over the facade", () => {
  it("an injected SQLITE_IOERR_FSYNC fences the store and poisons the Harness; reopening keeps every acknowledged commit", { timeout: 60_000 }, async () => {
    const dir = scratch("harness");
    try {
      const faulty: { database?: FaultyDatabase } = {};
      let callbacks = 0;
      const store = await openArchilStore(dir.file, "exclusive", {
        onFenced: () => void callbacks++,
        decorate: (database) => (faulty.database = new FaultyDatabase(database)),
      });
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("never sent")]);
      const model = faux.getModel();
      const harness = await Harness.open(store.storage, { models, registry: createRegistry() }, ctx);
      const root = await harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } });

      const first = await (await root.submit({ type: "input", content: "hello" }, ctx)).wait(ctx);
      assert.equal(first.status, "done");
      const durableEntries = async (storage: Storage) =>
        (await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 100, undefined, ctx)).items.map((e) => e.kind);
      const before = await durableEntries(store.storage);
      assert.ok(before.length >= 2, `expected a user and an assistant entry, saw ${before.join(",")}`);
      assert.equal(store.database.fenced, false);

      faulty.database!.failNextCommit(sqliteError(SQLITE_IOERR_FSYNC, "disk I/O error"));
      await assert.rejects(
        (async () => (await root.submit({ type: "input", content: "again" }, ctx)).wait(ctx))(),
        (error: unknown) => {
          assert.ok(error instanceof StoreFencedError);
          assert.equal(error.errcode, SQLITE_IOERR_FSYNC);
          return true;
        },
      );
      assert.equal(store.database.fenced, true);
      assert.equal(callbacks, 1);

      // pi poisons its Session on any non-StorageRejected commit failure: every later operation refuses.
      await assert.rejects(root.commit(async () => undefined, ctx), (error: Error) => {
        assert.match(error.message, /poisoned/);
        assert.ok(error.cause instanceof StoreFencedError);
        return true;
      });
      await assert.rejects(harness.inspect(ctx), /poisoned/);
      await assert.rejects(harness.close(ctx), StoreFencedError, "closing a fenced store fails at once, so nothing seals over it");
      assert.equal(callbacks, 1);

      // The fenced handle is abandoned. Release the file the way process exit would, then reopen: the failed commit left
      // nothing behind and every acknowledged commit is there.
      await faulty.database!.inner.close();
      const reopened = await openArchilStore(dir.file, "exclusive");
      try {
        assert.deepEqual(await durableEntries(reopened.storage), before);
      } finally {
        await reopened.storage.close(ctx);
      }
    } finally {
      dir.remove();
    }
  });
});

it("store errors carry the shared exit codes: fenced 75, busy 76 (held by the store)", async () => {
  const { exitCodeFor, FencedError, HeldError } = await import("../src/errors.ts");
  const fenced = new StoreFencedError(new Error("disk I/O error"), 1034);
  assert.ok(fenced instanceof FencedError);
  assert.equal(fenced.name, "StoreFencedError");
  assert.equal(fenced.code, "STORE_FENCED");
  assert.equal(fenced.errcode, 1034);
  assert.equal(exitCodeFor(fenced), 75);
  const busy = new StoreBusyError("/run/store/run.sqlite", "exclusive", new Error("database is locked"));
  assert.ok(busy instanceof HeldError);
  assert.equal(busy.name, "StoreBusyError");
  assert.equal(busy.code, "STORE_BUSY");
  assert.equal(busy.holder, "store");
  assert.equal(exitCodeFor(busy), 76);
});

it("the errors the store really throws keep their names and codes and exit 75 and 76", async () => {
  const fenced = await new Fence().guard(() => Promise.reject(sqliteError(SQLITE_IOERR_FSYNC, "disk I/O error"))).then(() => null, (e: unknown) => e);
  assert.ok(fenced instanceof StoreFencedError);
  assert.deepEqual([fenced.name, fenced.code, fenced.errcode, exitCodeFor(fenced)], ["StoreFencedError", "STORE_FENCED", SQLITE_IOERR_FSYNC, 75]);
  const dir = scratch("busy-exit");
  try {
    const store = await openArchilStore(dir.file, "exclusive");
    await entryCommitter(store.storage).setup();
    const busy = await openArchilStore(dir.file, "exclusive").then(() => null, (e: unknown) => e);
    assert.ok(busy instanceof StoreBusyError, String(busy));
    assert.deepEqual([busy.name, busy.code, busy.holder, exitCodeFor(busy)], ["StoreBusyError", "STORE_BUSY", "store", 76]);
    await store.storage.close(ctx);
  } finally {
    dir.remove();
  }
});
