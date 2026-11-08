// Who opens the store (the lead's ruling on processes): the server and each runner are separate processes with their own
// connection, and SQLite serializes their writes. The server sets the schema up once at its start and holds the store's
// owner lock: a second server on the same store is refused. A runner never sets anything up and refuses a schema version
// it does not know, with a typed error.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SchemaVersionUnknown, StoreOwned } from "../dist/store/store.js";
import { openSqliteStore } from "../dist/store/sqlite/store.js";

function fresh(t) {
  const dir = mkdtempSync(join(tmpdir(), "store-roles-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "store.sqlite");
}

test("a second server on the same store is refused (StoreOwned); once the first closes, a server opens it", async (t) => {
  const file = fresh(t);
  const first = await openSqliteStore({ file, role: "server" });
  await assert.rejects(openSqliteStore({ file, role: "server" }), (error) => error instanceof StoreOwned && /another server holds the store/.test(error.message));
  const runner = await openSqliteStore({ file, role: "runner" });
  await runner.close();
  await first.close();
  const second = await openSqliteStore({ file, role: "server" });
  await second.close();
});

test("a runner refuses a store with no schema yet, and one of a schema version it does not know (SchemaVersionUnknown)", async (t) => {
  const file = fresh(t);
  await assert.rejects(openSqliteStore({ file, role: "runner" }), (error) => error instanceof SchemaVersionUnknown && error.found === null);
  const server = await openSqliteStore({ file, role: "server" });
  await server.close();
  // A later build's store.
  const raw = new DatabaseSync(file);
  raw.exec("UPDATE store_meta SET schema_version = 99");
  raw.close();
  await assert.rejects(openSqliteStore({ file, role: "runner" }), (error) => error instanceof SchemaVersionUnknown && error.found === 99 && error.known === 1);
  await assert.rejects(openSqliteStore({ file, role: "server" }), SchemaVersionUnknown, "nor does the server open a later build's store");
});

test("a runner sets nothing up: its open leaves an empty file empty", async (t) => {
  const file = fresh(t);
  await assert.rejects(openSqliteStore({ file, role: "runner" }), SchemaVersionUnknown);
  const raw = new DatabaseSync(file);
  try {
    assert.deepEqual(raw.prepare("SELECT name FROM sqlite_schema").all(), [], "no table was made");
  } finally {
    raw.close();
  }
});
