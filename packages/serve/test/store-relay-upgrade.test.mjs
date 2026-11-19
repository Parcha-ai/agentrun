// The store's relay of a dial to the runner that made its machine (dial-relay.ts): each minted token's row names the
// runner in a process of its own that minted it and that runner's incarnation (null for the server's own process), and
// that runner's row in runners (its word that it is there, runner/presence.ts) says where its attach listener answers.
// SQLite version 12 comes to 13 at its server's open (schema.ts relayUpgrade), never at a runner's; a version 13 store
// that kept runner_relays has it dropped and runners made at its server's open, no row copied (heartbeats). Postgres 0018
// takes 0019 (migrations/0019_runner_relays.sql), and 0019 takes 0020 (migrations/0020_runners.sql), which makes
// runner_relays runners in place, its rows kept. The rows an earlier release minted come through as the server's own.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { client, dropSchema, freshSchema, onPostgres, PG_URL, postgresOnly, sqliteOnly } from "./store-target.mjs";

const { migrate, migrationsIn, openPostgresStore, openSqliteStore, SCHEMA_VERSION } = await import("../dist/store/index.js");
const { liveRelays } = await import("../dist/computer-attach.js");
const { runnersRefused } = await import("../dist/runner/presence.js");

const T = Date.parse("2026-11-18T09:00:00.000Z");
const FAR = T + 365 * 24 * 3_600_000;
const SHA = "a".repeat(64);
const WORDS = "AGENTRUN_RUN_USER=bogus is not a setting this runner knows: set AGENTRUN_RUN_USER=same.";
/** Which of runners' columns are NOT NULL, on either store. */
const NOT_NULL = { runner: true, incarnation: true, host: false, port: false, seen_at: true, refused: false };

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

test("a minted token's row names the runner and incarnation that minted it, or none for the server's own process, and the run its machine is for, or none", async (t) => {
  const store = await storeOf(t, () => T);
  await store.mintedTokens.mint({ machine: "m-runner", tokenSha256: "b".repeat(64), kind: "desktop", os: "linux", arch: "amd64", expiresAt: FAR, runner: "runner-a", incarnation: "inc-1", run: "run-1" });
  await store.mintedTokens.mint({ machine: "m-server", tokenSha256: "c".repeat(64), kind: "desktop", os: "linux", arch: "amd64", expiresAt: FAR });
  const runner = await store.mintedTokens.byToken("b".repeat(64));
  assert.deepEqual([runner?.machine, runner?.runner, runner?.incarnation, runner?.run], ["m-runner", "runner-a", "inc-1", "run-1"]);
  const server = await store.mintedTokens.get("m-server");
  assert.deepEqual([server?.runner, server?.incarnation, server?.run], [null, null, null]);
  assert.deepEqual([runner?.refused, server?.refused], [null, null], "no dial of either was refused");
  // The server's refusal to relay a dial is kept on its token's row, by the token; another token's refusal moves nothing.
  await store.mintedTokens.refuse("b".repeat(64), "a dial for run run-1 (machine m-runner): runner runner-a, which made it, is not running now");
  await store.mintedTokens.refuse("e".repeat(64), "no row has this token");
  assert.equal((await store.mintedTokens.get("m-runner"))?.refused, "a dial for run run-1 (machine m-runner): runner runner-a, which made it, is not running now");
  assert.equal((await store.mintedTokens.get("m-server"))?.refused, null);
  // A mint again for the machine replaces its run with the new mint's, and clears the refusal of its earlier token.
  await store.mintedTokens.mint({ machine: "m-runner", tokenSha256: "d".repeat(64), kind: "desktop", os: "linux", arch: "amd64", expiresAt: FAR, runner: "runner-a", incarnation: "inc-1" });
  assert.deepEqual([(await store.mintedTokens.get("m-runner"))?.run, (await store.mintedTokens.get("m-runner"))?.refused], [null, null]);
  // A refusal under the replaced token's SHA-256 does not reach the new token's row.
  await store.mintedTokens.refuse("b".repeat(64), "late words about the earlier token");
  assert.equal((await store.mintedTokens.get("m-runner"))?.refused, null);
});

/** The tables of `file` named runners or runner_relays. */
function relayTablesOf(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('runners', 'runner_relays') ORDER BY name").all().map((row) => row.name);
  } finally {
    db.close();
  }
}

/** Version 13's runner_relays, as the release before runners made it. */
const RUNNER_RELAYS_13 = "CREATE TABLE runner_relays (runner TEXT PRIMARY KEY, incarnation TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, seen_at INTEGER NOT NULL) STRICT";

test("SQLite: a version 13 store keeping runner_relays rows opens at its server with runners in their place, empty (a relay's rows are heartbeats, none copied), and a runner waits for that server", sqliteOnly("the SQLite upgrade"), async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-runners-upgrade-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "store.sqlite");
  // Version 13 as the release before runners left it: runner_relays with a live and a stale runner's rows, and no runners.
  await (await openSqliteStore({ file })).close();
  const old = new DatabaseSync(file);
  try {
    old.exec("DROP TABLE runners");
    old.exec(RUNNER_RELAYS_13);
    const put = old.prepare("INSERT INTO runner_relays (runner, incarnation, host, port, seen_at) VALUES (?, ?, ?, ?, ?)");
    put.run("runner-live", "inc-live", "127.0.0.1", 40_000, Date.now());
    put.run("runner-stale", "inc-stale", "runner-stale.example", 40_001, Date.now() - 3_600_000);
  } finally {
    old.close();
  }
  assert.deepEqual(relayTablesOf(file), ["runner_relays"]);
  await assert.rejects(openSqliteStore({ file, role: "runner" }), /Start the AgentRun server to keep each runner's word that it is there and its relay in one table \(runners\) before opening a runner/);
  assert.deepEqual(relayTablesOf(file), ["runner_relays"], "a runner's refusal changes nothing");
  const store = await openSqliteStore({ file });
  try {
    assert.deepEqual(relayTablesOf(file), ["runners"]);
    assert.deepEqual(await store.runners.list(), [], "no relay's row is copied: each runner says it is there again within its renewal");
    assert.deepEqual(await liveRelays(store.runners), []);
    // A runner of this build writes into it, its relay with it.
    await store.runners.put({ runner: "runner-new", incarnation: "inc-new", refused: null, host: "127.0.0.1", port: 40_002 });
    assert.deepEqual((await liveRelays(store.runners)).map((row) => [row.runner, row.host, row.port, row.refused]), [["runner-new", "127.0.0.1", 40_002, null]]);
  } finally {
    await store.close();
  }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT schema_version FROM store_meta").get().schema_version, SCHEMA_VERSION, "no version moves: runners is the open's, as computer_viewers is");
  } finally {
    db.close();
  }
  await (await openSqliteStore({ file, role: "runner" })).close();
});

test("SQLite: a fresh store keeps runners and no runner_relays", sqliteOnly("the SQLite schema"), async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-runners-fresh-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "store.sqlite");
  await (await openSqliteStore({ file })).close();
  assert.deepEqual(relayTablesOf(file), ["runners"]);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.deepEqual(Object.fromEntries(db.prepare("SELECT name, \"notnull\" FROM pragma_table_info('runners')").all().map((row) => [row.name, row.notnull === 1])), NOT_NULL);
  } finally {
    db.close();
  }
});

test("SQLite: a version 12 store comes to 13 at its server's open, never at a runner's, its minted rows the server's own", sqliteOnly("the SQLite upgrade"), async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-relay-upgrade-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "store.sqlite");
  // Version 12's shape: this version's store with the runners and the minting runner taken out, and a token the earlier
  // release minted.
  await (await openSqliteStore({ file })).close();
  const old = new DatabaseSync(file);
  try {
    old.exec("DROP TABLE runners");
    for (const column of ["runner", "incarnation", "run", "refused"]) old.exec(`ALTER TABLE minted_tokens DROP COLUMN ${column}`);
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
        relays: db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'runners'").get().n,
        oldRelays: db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'runner_relays'").get().n,
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
    assert.deepEqual([after.version, after.relays, after.oldRelays], [SCHEMA_VERSION, 1, 0], "the step leaves runners, never runner_relays");
    assert.deepEqual(after.minted.slice(-4), ["runner", "incarnation", "run", "refused"]);
    const row = await store.mintedTokens.byToken(SHA);
    assert.deepEqual([row?.machine, row?.runner, row?.incarnation, row?.run, row?.refused], ["m-old", null, null, null, null], "the earlier release's token is the server's own, of no run, none refused");
  } finally {
    await store.close();
  }
  await (await openSqliteStore({ file })).close();
  assert.equal(read().version, SCHEMA_VERSION, "a second open changes nothing");
  await (await openSqliteStore({ file, role: "runner" })).close();
});

test("Postgres: a store at 0018 takes 0019, its minted rows the server's own", postgresOnly("the Postgres migration"), async (t) => {
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
  const earlier = migrationsIn().filter((m) => m.version <= 18);
  assert.equal(earlier.at(-1).version, 18, "the earlier release's last migration");
  await migrate(sql, schema, T, earlier);
  await sql.query("INSERT INTO minted_tokens (machine, token_sha256, kind, os, arch, expires_at, revoked_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7)", ["m-old", SHA, "desktop", "linux", "amd64", FAR, T]);
  assert.deepEqual(await pgRelayTables(sql, schema), [], "0018 keeps no relays");
  store = await openPostgresStore({ url: PG_URL, schema });
  assert.equal(Number((await sql.query("SELECT schema_version FROM store_meta")).rows[0].schema_version), migrationsIn().at(-1).version);
  assert.ok(migrationsIn().some((m) => m.version === 19), "0019 ships");
  assert.deepEqual(await pgRelayTables(sql, schema), ["runners"]);
  const row = await store.mintedTokens.byToken(SHA);
  assert.deepEqual([row?.machine, row?.runner, row?.incarnation, row?.run, row?.refused], ["m-old", null, null, null, null], "the earlier release's token is the server's own, of no run, none refused");
});

/** The tables of `schema` named runners or runner_relays. */
async function pgRelayTables(sql, schema) {
  return (await sql.query("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name IN ('runners', 'runner_relays') ORDER BY table_name", [schema])).rows.map((row) => row.table_name);
}

/** runners' shape in `schema`: which columns are NOT NULL, and its constraints' names. */
async function pgRunnersShape(sql, schema) {
  const columns = (await sql.query("SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'runners'", [schema])).rows;
  const constraints = (await sql.query("SELECT conname FROM pg_constraint JOIN pg_class ON pg_class.oid = conrelid JOIN pg_namespace ON pg_namespace.oid = relnamespace WHERE nspname = $1 AND relname = 'runners' ORDER BY conname", [schema])).rows;
  return { notNull: Object.fromEntries(columns.map((row) => [row.column_name, row.is_nullable === "NO"])), constraints: constraints.map((row) => row.conname) };
}

test("Postgres: a store at 0019 holding runner_relays rows takes 0020 in place: the table is runners, every row kept with no refusal, the live one read as a relay, and a fresh runner writes into it", postgresOnly("the Postgres migration"), async (t) => {
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
  const earlier = migrationsIn().filter((m) => m.version <= 19);
  assert.equal(earlier.at(-1).version, 19, "the earlier release's last migration");
  await migrate(sql, schema, T, earlier);
  // A live runner's relay (seen 5 s before the store's clock) and a stale one's (seen 60 s before), each with where it answers.
  await sql.query("INSERT INTO runner_relays (runner, incarnation, host, port, seen_at) VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)", [
    "runner-live", "inc-live", "127.0.0.1", 40_000, T - 5_000,
    "runner-stale", "inc-stale", "runner-stale.example", 40_001, T - 60_000,
  ]);
  assert.deepEqual(await pgRelayTables(sql, schema), ["runner_relays"]);
  store = await openPostgresStore({ url: PG_URL, schema, testClock: () => T });
  assert.equal(Number((await sql.query("SELECT schema_version FROM store_meta")).rows[0].schema_version), migrationsIn().at(-1).version);
  assert.deepEqual(await pgRelayTables(sql, schema), ["runners"], "runner_relays is runners now, and no other table is left");
  assert.deepEqual(await pgRunnersShape(sql, schema), { notNull: NOT_NULL, constraints: ["runners_pkey"] });
  assert.deepEqual(await store.runners.list(), [
    { runner: "runner-live", incarnation: "inc-live", refused: null, host: "127.0.0.1", port: 40_000, seenAt: T - 5_000 },
    { runner: "runner-stale", incarnation: "inc-stale", refused: null, host: "runner-stale.example", port: 40_001, seenAt: T - 60_000 },
  ], "every relay's row kept, with no refusal");
  assert.deepEqual((await liveRelays(store.runners)).map((row) => [row.runner, row.host, row.port]), [["runner-live", "127.0.0.1", 40_000]], "the relay reads the live row, and not the stale one");
  assert.equal(await runnersRefused(store.runners), undefined, "a relay's row refuses nothing");
  // A fresh runner (one that refused, with no relay) writes into it; the live relay still reads alone.
  await store.runners.put({ runner: "runner-new", incarnation: "inc-new", refused: WORDS, host: null, port: null });
  assert.deepEqual((await store.runners.live(30_000)).map((row) => [row.runner, row.refused, row.host, row.port]), [["runner-live", null, "127.0.0.1", 40_000], ["runner-new", WORDS, null, null]]);
  assert.deepEqual((await liveRelays(store.runners)).map((row) => row.runner), ["runner-live"]);
});

test("Postgres: a fresh store runs every migration and ends with runners and no runner_relays, in the upgrade's shape", postgresOnly("the Postgres migration"), async (t) => {
  const schema = await freshSchema();
  const store = await openPostgresStore({ url: PG_URL, schema });
  const sql = await client(schema);
  t.after(async () => {
    try {
      await store.close();
    } finally {
      await sql.end();
      await dropSchema(schema);
    }
  });
  assert.deepEqual(await pgRelayTables(sql, schema), ["runners"]);
  assert.deepEqual(await pgRunnersShape(sql, schema), { notNull: NOT_NULL, constraints: ["runners_pkey"] });
  assert.deepEqual(await store.runners.list(), []);
});
