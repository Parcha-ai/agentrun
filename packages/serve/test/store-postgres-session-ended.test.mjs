// PRRT_kwDOUmdVMs62FaCj: which errors say the database ended a transaction's session (postgres/connection.ts
// sessionEnded), so its transaction answers StoreDeadline (home_busy, retryable) and never an internal error: the
// idle-in-transaction timeout's FATAL (25P03), and a connection that takes no more statements. Any other is the
// statement's own. CI's Postgres job runs the whole path (store-postgres.test.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";

const { sessionEnded } = await import("../dist/store/postgres/connection.js");

test("the idle-in-transaction timeout's FATAL and a gone connection are a session the database ended; a statement's own error is not", () => {
  assert.equal(sessionEnded(Object.assign(new Error("terminating connection due to idle-in-transaction timeout"), { code: "25P03" })), true);
  assert.equal(sessionEnded(new Error("Client has encountered a connection error and is not queryable")), true);
  assert.equal(sessionEnded(new Error("Connection terminated unexpectedly")), true);
  for (const own of [Object.assign(new Error("duplicate key"), { code: "23505" }), Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }), new Error("syntax error"), undefined, null]) assert.equal(sessionEnded(own), false, String(own?.message ?? own));
});
