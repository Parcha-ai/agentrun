// The store's one schema, version 1: every table the rewrite's modules write (A's runs and commands, E's triggers and the
// channel outbox, the review ledger, the MCP registry and pins, idempotency), every time an INTEGER epoch ms, and foreign
// keys enforced. A run update can carry rows in the same commit (a journal commit's staged patch: the outbox), and a
// fenced one writes none of them.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Fenced, StoreConstraint } from "../dist/store/store.js";
import { openSqliteStore } from "../dist/store/sqlite/store.js";
import { queued, storeOn, T0 } from "./store-helpers.mjs";
import { raw, sqliteOnly } from "./store-target.mjs";

const TABLES = [
  "agents", "channel_posts", "channel_told", "commands", "computer_viewers", "idempotency", "learning", "learning_proposals", "mcp_oauth_pending", "mcp_pins",
  "mcp_servers", "review_ledger", "revisions", "run_launch", "run_live", "run_origins", "runs", "sealed_keys", "settings", "sign_in_tombstones", "sign_ins", "store_meta",
  "trigger_conversations", "trigger_firings", "trigger_scopes", "trigger_settings", "triggers",
];

test("schema v1 has every table, and every time column is an INTEGER", async (t) => {
  const { store, file } = await storeOn(t);
  await store.flush();
  const db = await raw(file, { readOnly: true });
  // The schema as the database records it: SQLite's sqlite_schema and table_info, Postgres's information_schema (its
  // INTEGER is BIGINT; schema_migrations is the Postgres migrations' own record).
  const columnsOf = async (table) => db.kind === "sqlite"
    ? (await db.all(`PRAGMA table_info(${table})`)).map((column) => ({ name: column.name, type: column.type }))
    : (await db.all("SELECT column_name AS name, upper(data_type) AS type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?", table)).map((column) => ({ name: column.name, type: column.type === "BIGINT" ? "INTEGER" : column.type }));
  try {
    const tables = db.kind === "sqlite"
      ? (await db.all("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'pi\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")).map((row) => row.name)
      : (await db.all("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name NOT LIKE 'pi\\_%' AND table_name <> 'schema_migrations' ORDER BY table_name COLLATE \"C\"")).map((row) => row.name);
    assert.deepEqual(tables, TABLES);
    const times = [];
    for (const table of tables) {
      for (const column of await columnsOf(table)) {
        if (/(_at|_until)$/.test(column.name) || ["at"].includes(column.name)) times.push([table, column.name, column.type]);
      }
    }
    assert.deepEqual(times.filter(([, , type]) => type !== "INTEGER"), [], "every time is INTEGER epoch ms");
    assert.ok(times.some(([table, name]) => table === "runs" && name === "wake_at"), "runs.wake_at");
    assert.ok((await columnsOf("revisions")).some((column) => column.name === "package"), "revisions.package");
    assert.ok((await columnsOf("commands")).some((column) => column.name === "refused"), "commands.refused");
  } finally {
    await db.close();
  }
});

test("foreign keys are enforced: a run of an unknown agent is refused", async (t) => {
  const { store } = await storeOn(t);
  await assert.rejects(store.runs.create({ id: "run-x", agentId: "agent-none", revisionId: "rev-none" }), StoreConstraint);
});

test("a server open drops a stale browser_viewers table a prior build left, and keeps computer_viewers", sqliteOnly("an earlier build's store file"), async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "store.sqlite");
  const first = await openSqliteStore({ file, role: "server", now: () => T0 });
  await first.close();
  // The per-run viewer table was renamed browser_viewers → computer_viewers; its rows are ephemeral, so none migrate. A
  // store file an earlier build wrote still holds the old table: a server open must drop it, leaving no stale table behind.
  const raw = new DatabaseSync(file);
  try {
    raw.exec("CREATE TABLE browser_viewers (run_id TEXT)");
  } finally {
    raw.close();
  }
  const second = await openSqliteStore({ file, role: "server", now: () => T0 });
  try {
    const check = new DatabaseSync(file, { readOnly: true });
    try {
      const names = check.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('browser_viewers', 'computer_viewers') ORDER BY name").all().map((row) => row.name);
      assert.deepEqual(names, ["computer_viewers"], "the stale browser_viewers is dropped at open; computer_viewers stays");
    } finally {
      check.close();
    }
  } finally {
    await second.close();
  }
});

test("a run update carries rows in the same commit (an outbox post, a told marker); a fenced one writes none", async (t) => {
  const { store, clock, file } = await storeOn(t);
  await queued(store);
  const stale = await store.claim("run-1", "runner-a", { leaseMs: 1_000 });
  clock.now += 2_000;
  const claim = await store.claim("run-1", "runner-b", { leaseMs: 30_000 });
  const post = { id: "post-1", channel: "slack:C1", moment: "ended", body: { text: "done" } };
  await assert.rejects(store.runs.update(stale, { state: "ended" }, { also: [{ table: "channel_posts", row: post }] }), Fenced);
  await store.runs.update(claim, { state: "ended", costUsd: 0.5 }, { also: [{ table: "channel_posts", row: post }, { table: "channel_told", row: { channel: "slack:C1", marker: "ended" } }] });
  await store.flush();
  const db = await raw(file, { readOnly: true });
  try {
    assert.deepEqual(await db.all("SELECT id, run_id, channel, moment, state, next_at, created_at FROM channel_posts"), [{ id: "post-1", run_id: "run-1", channel: "slack:C1", moment: "ended", state: "queued", next_at: clock.now, created_at: clock.now }]);
    assert.deepEqual(await db.all("SELECT channel, run_id, marker, at FROM channel_told"), [{ channel: "slack:C1", run_id: "run-1", marker: "ended", at: clock.now }]);
  } finally {
    await db.close();
  }
});
