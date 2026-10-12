// The browser store's database layer on Node: pi's SqliteStorage over the worker protocol (SQLite-WASM, in memory), under pi's storage
// conformance suite, and the transaction rules the SqliteDatabase facade promises. The same suite runs in real Chrome on OPFS
// (scripts/store-check.ts).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerConformance } from "./_conformance.ts";
import { loopbackWorker } from "./_sqlite-wasm.ts";
import { openWorkerStore, SqliteLine, storeHead, WorkerDatabase } from "../tab/sqlite-client.ts";

const database = async () => {
  const line = new SqliteLine(loopbackWorker());
  await line.call({ op: "open", name: "t" });
  return new WorkerDatabase(line);
};

registerConformance("sqlite-wasm store (in memory)", async (use) => {
  const { storage } = await openWorkerStore(loopbackWorker(), "case");
  try {
    await use(storage);
  } finally {
    await storage.close(undefined as never).catch(() => undefined);
  }
});

describe("the SqliteDatabase facade over the worker", () => {
  it("reads the store's head as the pipe does: next_seq less one", async () => {
    const { storage, database } = await openWorkerStore(loopbackWorker(), "head");
    assert.equal(await storeHead(database), 0, "a new store has no commit");
    await database.run("UPDATE durable_metadata SET next_seq = 8 WHERE singleton = 1");
    assert.equal(await storeHead(database), 7);
    await storage.close(undefined as never);
  });

  it("round-trips integers beyond 2^53, bytes, text and null", async () => {
    const db = await database();
    await db.exec("create table t(a integer, b blob, c text, d)");
    await db.run("insert into t values(?,?,?,?)", 9007199254740993n, new Uint8Array([1, 2, 3]), "x", null);
    const row = await db.get<{ a: bigint; b: Uint8Array; c: string; d: null }>("select * from t");
    assert.deepEqual({ ...row }, { a: 9007199254740993n, b: new Uint8Array([1, 2, 3]), c: "x", d: null });
    assert.equal(await db.get("select * from t where a = ?", 1), undefined);
    assert.equal((await db.all("select * from t")).length, 1);
    await db.close();
  });

  it("a transaction commits all of its statements, or none of them", async () => {
    const db = await database();
    await db.exec("create table t(a integer primary key)");
    await db.transaction(async (tx) => {
      await tx.run("insert into t values(1)");
      await tx.run("insert into t values(2)");
    });
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.run("insert into t values(3)");
        await tx.run("insert into t values(1)"); // primary key clash
      }),
      /constraint/i,
    );
    assert.deepEqual((await db.all<{ a: number }>("select a from t order by a")).map((r) => r.a), [1, 2]);
    await db.close();
  });

  it("an operation outside a transaction waits for the transaction in progress", async () => {
    const db = await database();
    await db.exec("create table t(a integer)");
    let outside: Promise<unknown> | undefined;
    const seen: unknown[] = [];
    await db.transaction(async (tx) => {
      await tx.run("insert into t values(1)");
      outside = db.all("select a from t").then((rows) => seen.push(rows.length));
      await new Promise((r) => setTimeout(r, 20));
      await tx.run("insert into t values(2)");
      assert.deepEqual(seen, [], "the read ran before the transaction ended");
    });
    await outside;
    assert.deepEqual(seen, [2], "the read saw the committed transaction");
    await db.close();
  });

  it("a transaction handle is refused after its callback settled", async () => {
    const db = await database();
    await db.exec("create table t(a integer)");
    let leaked: Parameters<Parameters<typeof db.transaction>[0]>[0] | undefined;
    await db.transaction(async (tx) => void (leaked = tx));
    await assert.rejects(leaked!.run("insert into t values(1)"), /no longer active/);
    await db.close();
  });

  it("close ends the worker, and every later call rejects", async () => {
    const worker = loopbackWorker();
    const line = new SqliteLine(worker);
    await line.call({ op: "open", name: "t" });
    const db = new WorkerDatabase(line);
    await db.close();
    assert.equal(worker.terminated, true);
    await assert.rejects(db.exec("select 1"));
  });

  it("an SQLite error keeps its message and result code", async () => {
    const db = await database();
    await assert.rejects(db.exec("select * from nowhere"), (e: Error & { resultCode?: number }) => /no such table/.test(e.message) && typeof e.resultCode === "number");
    await db.close();
  });
});
