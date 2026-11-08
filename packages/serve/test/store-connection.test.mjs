// The store's connection is a Chord SqliteDatabase (the shape pi's SqliteStorage takes, so the journal runs on it as
// written): exec, run, runCounted, get, all and transaction(callback(tx)). A transaction is BEGIN IMMEDIATE on the worker;
// every other call waits for it; a rejecting callback rolls back and rejects with that same error; the handle takes nothing
// after the callback settles.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Connection } from "../dist/store/sqlite/connection.js";

async function connected(t) {
  const dir = mkdtempSync(join(tmpdir(), "store-connection-"));
  const db = await Connection.open(join(dir, "c.sqlite"));
  t.after(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)");
  return db;
}

test("run, runCounted, get and all, with positional bindings", async (t) => {
  const db = await connected(t);
  await db.run("INSERT INTO notes (text) VALUES (?)", "one");
  await db.run("INSERT INTO notes (text) VALUES (?)", "two");
  assert.equal(await db.runCounted("UPDATE notes SET text = text || ?", "!"), 2);
  assert.deepEqual({ ...(await db.get("SELECT text FROM notes WHERE id = ?", 1)) }, { text: "one!" });
  assert.equal(await db.get("SELECT text FROM notes WHERE id = ?", 9), undefined);
  assert.deepEqual((await db.all("SELECT text FROM notes ORDER BY id")).map((r) => r.text), ["one!", "two!"]);
});

test("a transaction commits what its handle wrote; a rejecting callback rolls back and rejects with the same error", async (t) => {
  const db = await connected(t);
  const value = await db.transaction(async (tx) => {
    await tx.run("INSERT INTO notes (text) VALUES (?)", "kept");
    return (await tx.get("SELECT count(*) AS n FROM notes")).n;
  });
  assert.equal(value, 1, "the handle reads its own writes");
  const thrown = new Error("the callback's own");
  await assert.rejects(db.transaction(async (tx) => {
    await tx.run("INSERT INTO notes (text) VALUES (?)", "rolled back");
    throw thrown;
  }), (error) => error === thrown);
  assert.deepEqual((await db.all("SELECT text FROM notes")).map((r) => r.text), ["kept"]);
});

test("every other call waits for an open transaction, and its handle takes nothing once the callback settled", async (t) => {
  const db = await connected(t);
  const order = [];
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let handle;
  const tx = db.transaction(async (h) => {
    handle = h;
    await h.run("INSERT INTO notes (text) VALUES (?)", "first");
    order.push("tx wrote");
    await held;
    order.push("tx ends");
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const outside = db.run("INSERT INTO notes (text) VALUES (?)", "second").then(() => order.push("outside wrote"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(order, ["tx wrote"], "the outside write waits");
  release();
  await Promise.all([tx, outside]);
  assert.deepEqual(order, ["tx wrote", "tx ends", "outside wrote"]);
  await assert.rejects(handle.run("INSERT INTO notes (text) VALUES (?)", "late"), /transaction is over/);
});

test("a worker that exits leaves every later call rejected in words within 2 s, and close() resolves within 2 s, never hanging", async (t) => {
  // Its own connection, closed by the test itself under the same bound: no cleanup that could wait on a dead worker.
  const dir = mkdtempSync(join(tmpdir(), "store-connection-lost-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = await Connection.open(join(dir, "c.sqlite"));
  await db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)");
  await Connection.workerOf(db).terminate();
  /** `promise`'s outcome, or "still waiting after 2 s". */
  const within2s = (promise) => Promise.race([promise.then(() => "resolved", (error) => error), new Promise((resolve) => setTimeout(() => resolve("still waiting after 2 s"), 2_000))]);
  for (const [name, call] of [["a read", () => db.get("SELECT 1 AS one")], ["a write", () => db.run("INSERT INTO notes (text) VALUES (?)", "late")], ["a transaction", () => db.transaction(async (tx) => tx.run("INSERT INTO notes (text) VALUES (?)", "late"))]]) {
    const outcome = await within2s(call());
    assert.ok(outcome instanceof Error && outcome.name === "StoreWorkerLost" && /the store's worker (exited|failed)/.test(outcome.message), `${name} rejected within 2 s with StoreWorkerLost: ${String(outcome)}`);
  }
  assert.equal(await within2s(db.close()), "resolved", "close() resolved within 2 s");
});

test("a commit that fails (a deferred foreign key) is rolled back, and the next write goes", async (t) => {
  const db = await connected(t);
  await db.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent (id))");
  await assert.rejects(db.transaction(async (tx) => {
    await tx.exec("PRAGMA defer_foreign_keys = ON");
    await tx.run("INSERT INTO child (parent_id) VALUES (?)", 99);
  }), /FOREIGN KEY/);
  await db.run("INSERT INTO notes (text) VALUES (?)", "after");
  await db.transaction(async (tx) => tx.run("INSERT INTO notes (text) VALUES (?)", "a transaction after"));
  assert.deepEqual((await db.all("SELECT text FROM notes ORDER BY id")).map((r) => r.text), ["after", "a transaction after"]);
  assert.deepEqual(await db.all("SELECT id FROM child"), [], "nothing of the failed commit is kept");
});
