// The MCP refresh keep's one deadline, at the store's connection. A refresh's new set is kept (store.mcp.keepRefreshed)
// under ONE deadline counted from its call: its wait behind the connection's queue, for the database's lock, its
// statement and its commit (STORE_WRITE_DEADLINE_MS), so a keep queued behind a slow transaction can never outlast the
// refresh lease while a waiter takes over. The keep's compare-and-set and the lease's bound are proven in store-mcp.test.mjs
// and, through the claim step, in runner-mcp-keep.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";
import { sqliteOnly } from "./store-target.mjs";

const { Connection, StoreDeadline } = await import("../dist/store/index.js");

// The SQLite connection's own queue (Connection.open on the store's file). Postgres's pool has no such queue; its twin, a
// keep behind a held pool client or row lock ending within the deadline counted from its call, comes with the Postgres
// connection's from-call deadline.
test("a transaction whose deadline counts from its call, queued behind a held one, ends within it never begun", sqliteOnly("the SQLite connection's queue behind a held transaction"), async (t) => {
  const { file } = await storeOn(t);
  const connection = await Connection.open(file);
  t.after(() => connection.close().catch(() => {}));
  let release;
  const held = connection.transaction(async (tx) => {
    await tx.get("SELECT 1 AS one");
    await new Promise((resolve) => (release = resolve));
  });
  let ran = false;
  const bounded = connection.transaction(async () => void (ran = true), { deadlineMs: 50, fromCall: true });
  const outcome = await Promise.race([
    bounded.then(() => "ran", (error) => (error instanceof StoreDeadline ? "deadline" : `other: ${error.message}`)),
    new Promise((resolve) => setTimeout(() => resolve("still queued"), 3_000).unref()),
  ]);
  release();
  await held;
  assert.equal(outcome, "deadline", "its deadline counted from its call: it ended with StoreDeadline while the other held the queue");
  assert.equal(ran, false, "never begun");
});
