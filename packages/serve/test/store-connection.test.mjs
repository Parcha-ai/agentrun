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
