// The store's one connection lives on a worker thread (design 2.2): a write, and a flush (a commit at FULL, which waits for
// the disk), never block the event loop the runner's loops share. The main thread runs none of their SQLite statements: a
// count of the statements node:sqlite prepares or runs on this thread stays at zero while 2,000 writes and 40 flushes land.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as nodeTest } from "node:test";
import { sqliteAdapterTests } from "./store-target.mjs";

const test = sqliteAdapterTests(nodeTest, "the SQLite connection's worker thread");
import { DatabaseSync } from "node:sqlite";
import { openSqliteStore } from "../dist/store/sqlite/store.js";

/** Counts each statement node:sqlite prepares or runs on this thread (a worker's connection is another thread's
 *  node:sqlite, never counted), until `restore`. */
function countMainThreadStatements(t) {
  const counted = { statements: 0 };
  const { prepare, exec } = DatabaseSync.prototype;
  DatabaseSync.prototype.prepare = function (...args) {
    counted.statements += 1;
    return prepare.apply(this, args);
  };
  DatabaseSync.prototype.exec = function (...args) {
    counted.statements += 1;
    return exec.apply(this, args);
  };
  t.after(() => Object.assign(DatabaseSync.prototype, { prepare, exec }));
  return counted;
}

test("writes and flushes run on the connection's worker thread: the main thread runs none of their statements", { timeout: 120_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "store-worker-"));
  const file = join(dir, "store.sqlite");
  const store = await openSqliteStore({ file });
  t.after(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await store.agents.create({ id: "agent-1", name: "Agent one" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });

  const counted = countMainThreadStatements(t);
  // The count sees this thread's statements: a reader of the store's file opened here, one statement.
  const reader = new DatabaseSync(file, { readOnly: true });
  reader.prepare("SELECT 1").get();
  reader.close();
  assert.equal(counted.statements, 1, "a statement on this thread is counted");
  counted.statements = 0;
  // 40 rounds of 50 runs each, a command per run, and a flush after each round, with every round's writes in flight at once.
  for (let round = 0; round < 40; round++) {
    await Promise.all(Array.from({ length: 50 }, async (_, i) => {
      const id = `run-${round}-${i}`;
      await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" });
      await store.command(id, { kind: "steer", body: { text: "go on ".repeat(200) } });
    }));
    await store.flush();
  }
  // MUTATION: a store whose connection runs on this thread counts every write and flush here.
  assert.equal(counted.statements, 0, "no statement of a write or a flush ran on the main thread");
  assert.equal((await store.runs.list({})).length, 2_000, "every write landed");
});

test("a write after close is refused in words, and close waits for the writes before it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "store-worker-close-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "store.sqlite");
  const store = await openSqliteStore({ file });
  await store.agents.put({ id: "agent-1", name: "Agent one" });
  const pending = store.agents.addRevision({ id: "rev-1", agentId: "agent-1", kind: "agentic", body: {} });
  await store.close();
  await pending;
  await assert.rejects(store.agents.put({ id: "agent-2", name: "late" }), /the store is closed/);
  const again = await openSqliteStore({ file });
  t.after(() => again.close());
  assert.equal((await again.agents.revision("rev-1"))?.agentId, "agent-1", "the write queued before close landed");
});
