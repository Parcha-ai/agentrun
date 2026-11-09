// Who opens the store (the lead's ruling on processes): the server and each runner are separate processes with their own
// connection, and SQLite serializes their writes. The server sets the schema up once at its start and holds the store's
// owner lock: a second server on the same store is refused. A runner never sets anything up and refuses a schema version
// it does not know, with a typed error. Both name only the data directory: the store picks its file in it, and nothing
// outside the store names that file (scripts/store-sql-guard.test.mjs).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SchemaVersionUnknown, StoreOwned } from "../dist/store/store.js";
import { SCHEMA_VERSION } from "../dist/store/schema.js";
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
  await assert.rejects(openSqliteStore({ file, role: "runner" }), (error) => error instanceof SchemaVersionUnknown && error.found === 99 && error.known === SCHEMA_VERSION);
  await assert.rejects(openSqliteStore({ file, role: "server" }), SchemaVersionUnknown, "nor does the server open a later build's store");
  // An earlier build's store (version 2, before a sign-in's saves were numbered): refused the same, never migrated.
  const earlier = new DatabaseSync(file);
  earlier.exec("UPDATE store_meta SET schema_version = 2");
  earlier.close();
  await assert.rejects(openSqliteStore({ file, role: "server" }), (error) => error instanceof SchemaVersionUnknown && error.found === 2 && error.known === SCHEMA_VERSION);
});

test("a server and a runner given the same data directory open the same store, whose file the store names; a second server on it is refused", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "store-roles-data-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const server = await openSqliteStore({ dataDir, role: "server" });
  t.after(() => server.close());
  await server.agents.create({ id: "agent-1", name: "One" }, { id: "rev-1", kind: "agentic", body: {} });
  const runner = await openSqliteStore({ dataDir, role: "runner" });
  t.after(() => runner.close());
  assert.equal((await runner.agents.get("agent-1"))?.currentRevision, "rev-1", "the runner reads what the server wrote");
  await assert.rejects(openSqliteStore({ dataDir, role: "server" }), StoreOwned);
});

test("a server makes its data directory when it is not there; a runner never does", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "store-roles-parent-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  await assert.rejects(openSqliteStore({ dataDir: join(parent, "runner-first"), role: "runner" }));
  assert.equal(existsSync(join(parent, "runner-first")), false, "the runner made nothing");
  const server = await openSqliteStore({ dataDir: join(parent, "data"), role: "server" });
  await server.close();
  const runner = await openSqliteStore({ dataDir: join(parent, "data"), role: "runner" });
  await runner.close();
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
