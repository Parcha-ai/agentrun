// The store's relay of a dial to the runner that made its machine (dial-relay.ts): each minted token's row names the
// runner in a process of its own that minted it and that runner's incarnation (null for the server's own process), and
// runner_relays keeps where each such runner's attach listener answers. SQLite version 12 comes to 13 at its server's
// open (schema.ts relayUpgrade), never at a runner's; Postgres 0017 takes 0018 (migrations/0018_runner_relays.sql). The
// rows an earlier release minted come through as the server's own. On either store: a row's put, its renewal under its
// incarnation alone, its read, its list and its removal under its incarnation alone.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { client, dropSchema, freshSchema, onPostgres, PG_URL, postgresOnly, sqliteOnly } from "./store-target.mjs";

const { migrate, migrationsIn, openPostgresStore, openSqliteStore, SCHEMA_VERSION } = await import("../dist/store/index.js");

const T = Date.parse("2026-11-18T09:00:00.000Z");
const FAR = T + 365 * 24 * 3_600_000;
const SHA = "a".repeat(64);

/** A store on this run's database, with `now` as its clock, closed (and its schema dropped) at the test's end. */
async function storeOf(t, now) {
  if (onPostgres) {
    const schema = await freshSchema();
    const store = await openPostgresStore({ url: PG_URL, schema, now });
    t.after(async () => {
      await store.close();
      await dropSchema(schema);
    });
    return store;
  }
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-relay-store-"));
  const store = await openSqliteStore({ file: join(dir, "store.sqlite"), now });
  t.after(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

test("a minted token's row names the runner and incarnation that minted it, or none for the server's own process", async (t) => {
  const store = await storeOf(t, () => T);
  await store.mintedTokens.mint({ machine: "m-runner", tokenSha256: "b".repeat(64), kind: "desktop", os: "linux", arch: "amd64", expiresAt: FAR, runner: "runner-a", incarnation: "inc-1" });
  await store.mintedTokens.mint({ machine: "m-server", tokenSha256: "c".repeat(64), kind: "desktop", os: "linux", arch: "amd64", expiresAt: FAR });
  const runner = await store.mintedTokens.byToken("b".repeat(64));
  assert.deepEqual([runner?.machine, runner?.runner, runner?.incarnation], ["m-runner", "runner-a", "inc-1"]);
  const server = await store.mintedTokens.get("m-server");
  assert.deepEqual([server?.runner, server?.incarnation], [null, null]);
});

test("a runner's relay row: put, renewed only under its incarnation, read and listed, replaced by a restart, and removed only under its incarnation", async (t) => {
  let now = T;
  const store = await storeOf(t, () => now);
  assert.deepEqual(await store.runnerRelays.list(), []);
  await store.runnerRelays.put({ runner: "runner-b", incarnation: "inc-b", host: "127.0.0.1", port: 40_001 });
  await store.runnerRelays.put({ runner: "runner-a", incarnation: "inc-1", host: "runner-a.example", port: 40_000 });
  assert.deepEqual(await store.runnerRelays.get("runner-a"), { runner: "runner-a", incarnation: "inc-1", host: "runner-a.example", port: 40_000, seenAt: T });
  now = T + 5_000;
  assert.equal(await store.runnerRelays.seen("runner-a", "inc-1"), true, "renewed under its incarnation");
  assert.equal(await store.runnerRelays.seen("runner-a", "inc-0"), false, "an earlier incarnation renews nothing");
  assert.equal(await store.runnerRelays.seen("runner-z", "inc-1"), false, "a runner with no row renews nothing");
  assert.equal((await store.runnerRelays.get("runner-a"))?.seenAt, T + 5_000);
  assert.deepEqual((await store.runnerRelays.list()).map((row) => row.runner), ["runner-a", "runner-b"]);
  // A restart: the same name under a new incarnation replaces the row; the earlier process's close removes nothing.
  now = T + 9_000;
  await store.runnerRelays.put({ runner: "runner-a", incarnation: "inc-2", host: "runner-a.example", port: 40_002 });
  await store.runnerRelays.remove("runner-a", "inc-1");
  assert.deepEqual(await store.runnerRelays.get("runner-a"), { runner: "runner-a", incarnation: "inc-2", host: "runner-a.example", port: 40_002, seenAt: T + 9_000 });
  await store.runnerRelays.remove("runner-a", "inc-2");
  assert.equal(await store.runnerRelays.get("runner-a"), undefined);
  assert.deepEqual((await store.runnerRelays.list()).map((row) => row.runner), ["runner-b"]);
});

test("SQLite: a version 12 store comes to 13 at its server's open, never at a runner's, its minted rows the server's own", sqliteOnly("the SQLite upgrade"), async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-relay-upgrade-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "store.sqlite");
  // Version 12's shape: this version's store with the relay taken out, and a token the earlier release minted.
  await (await openSqliteStore({ file })).close();
  const old = new DatabaseSync(file);
  try {
    old.exec("DROP TABLE runner_relays");
    for (const column of ["runner", "incarnation"]) old.exec(`ALTER TABLE minted_tokens DROP COLUMN ${column}`);
    old.exec("UPDATE store_meta SET schema_version = 12 WHERE singleton = 1");
    old.prepare("INSERT INTO minted_tokens (machine, token_sha256, kind, os, arch, expires_at, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)").run("m-old", SHA, "desktop", "linux", "amd64", FAR, T);
  } finally {
    old.close();
  }
  const read = () => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return {
        version: db.prepare("SELECT schema_version FROM store_meta").get().schema_version,
        minted: db.prepare("SELECT name FROM pragma_table_info('minted_tokens') ORDER BY cid").all().map((row) => row.name),
        relays: db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'runner_relays'").get().n,
      };
    } finally {
      db.close();
    }
  };
  const before = read();
  assert.deepEqual([before.version, before.relays, before.minted.includes("runner")], [12, 0, false]);
  await assert.rejects(openSqliteStore({ file, role: "runner" }), /Start the AgentRun server to bring this store from version 12 to 13 before opening a runner/);
  assert.deepEqual(read(), before, "a runner's refusal changes nothing");
  const store = await openSqliteStore({ file });
  try {
    const after = read();
    assert.deepEqual([after.version, after.relays], [SCHEMA_VERSION, 1]);
    assert.deepEqual(after.minted.slice(-2), ["runner", "incarnation"]);
    const row = await store.mintedTokens.byToken(SHA);
    assert.deepEqual([row?.machine, row?.runner, row?.incarnation], ["m-old", null, null], "the earlier release's token is the server's own");
  } finally {
    await store.close();
  }
  await (await openSqliteStore({ file })).close();
  assert.equal(read().version, SCHEMA_VERSION, "a second open changes nothing");
  await (await openSqliteStore({ file, role: "runner" })).close();
});

test("Postgres: a store at 0017 takes 0018, its minted rows the server's own", postgresOnly("the Postgres migration"), async (t) => {
  const schema = await freshSchema();
  const sql = await client(schema);
  let store;
  t.after(async () => {
    try {
      await store?.close();
    } finally {
      await sql.end();
      await dropSchema(schema);
    }
  });
  const earlier = migrationsIn().filter((m) => m.version <= 17);
  assert.equal(earlier.at(-1).version, 17, "the earlier release's last migration");
  await migrate(sql, schema, T, earlier);
  await sql.query("INSERT INTO minted_tokens (machine, token_sha256, kind, os, arch, expires_at, revoked_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7)", ["m-old", SHA, "desktop", "linux", "amd64", FAR, T]);
  const tables = async () => (await sql.query("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'runner_relays'", [schema])).rows.length;
  assert.equal(await tables(), 0, "0017 keeps no relays");
  store = await openPostgresStore({ url: PG_URL, schema });
  assert.equal(Number((await sql.query("SELECT schema_version FROM store_meta")).rows[0].schema_version), migrationsIn().at(-1).version);
  assert.ok(migrationsIn().some((m) => m.version === 18), "0018 ships");
  assert.equal(await tables(), 1);
  const row = await store.mintedTokens.byToken(SHA);
  assert.deepEqual([row?.machine, row?.runner, row?.incarnation], ["m-old", null, null], "the earlier release's token is the server's own");
});
