// The store's one schema: every table the rewrite's modules write (A's runs and commands, E's triggers and the channel
// outbox, the review ledger, the MCP registry and pins, idempotency, the computer ledger), every time an INTEGER epoch ms,
// and foreign keys enforced. A run update can carry rows in the same commit (a journal commit's staged patch: the outbox),
// and a fenced one writes none of them.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Fenced, StoreConstraint } from "../dist/store/store.js";
import { openSqliteStore } from "../dist/store/sqlite/store.js";
import { queued, storeOn, T0 } from "./store-helpers.mjs";

const TABLES = [
  "agents", "channel_posts", "channel_told", "commands", "computer_ledger", "computer_viewers", "idempotency", "learning", "learning_proposals", "mcp_oauth_pending", "mcp_pins",
  "mcp_servers", "review_ledger", "revisions", "run_launch", "run_live", "run_origins", "runs", "sealed_keys", "settings", "sign_in_tombstones", "sign_ins", "store_meta",
  "trigger_conversations", "trigger_firings", "trigger_scopes", "trigger_settings", "triggers",
];

test("the schema has every table, and every time column is an INTEGER", async (t) => {
  const { store, file } = await storeOn(t);
  await store.flush();
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'pi\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").all().map((row) => row.name);
    assert.deepEqual(tables, TABLES);
    const times = [];
    for (const table of tables) {
      for (const column of raw.prepare(`PRAGMA table_info(${table})`).all()) {
        if (/(_at|_until)$/.test(column.name) || ["at"].includes(column.name)) times.push([table, column.name, column.type]);
      }
    }
    assert.deepEqual(times.filter(([, , type]) => type !== "INTEGER"), [], "every time is INTEGER epoch ms");
    assert.ok(times.some(([table, name]) => table === "runs" && name === "wake_at"), "runs.wake_at");
    assert.ok(raw.prepare("PRAGMA table_info(revisions)").all().some((column) => column.name === "package"), "revisions.package");
    assert.ok(raw.prepare("PRAGMA table_info(commands)").all().some((column) => column.name === "refused"), "commands.refused");
  } finally {
    raw.close();
  }
});

test("foreign keys are enforced: a run of an unknown agent is refused", async (t) => {
  const { store } = await storeOn(t);
  await assert.rejects(store.runs.create({ id: "run-x", agentId: "agent-none", revisionId: "rev-none" }), StoreConstraint);
});

test("a server open drops a stale browser_viewers table a prior build left, and keeps computer_viewers", async (t) => {
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
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    assert.deepEqual(raw.prepare("SELECT id, run_id, channel, moment, state, next_at, created_at FROM channel_posts").all().map((r) => ({ ...r })), [{ id: "post-1", run_id: "run-1", channel: "slack:C1", moment: "ended", state: "queued", next_at: clock.now, created_at: clock.now }]);
    assert.deepEqual(raw.prepare("SELECT channel, run_id, marker, at FROM channel_told").all().map((r) => ({ ...r })), [{ channel: "slack:C1", run_id: "run-1", marker: "ended", at: clock.now }]);
  } finally {
    raw.close();
  }
});

test("the computer ledger: a provider's session labels and detail put, read, listed by provider, replaced in place, removed", async (t) => {
  const { store, clock } = await storeOn(t);
  const labels = { "agentrun.run": "run-1", "agentrun.epoch": "3" };
  const detail = { image: "android-14", deadline: "2026-11-08T21:30:00.000Z" };
  await store.computerLedger.put("phone-harness", "sess-a", labels, detail);
  await store.computerLedger.put("phone-harness", "sess-b", { "agentrun.run": "run-2" }, {});
  await store.computerLedger.put("other", "sess-a", { "agentrun.run": "run-9" }, {});
  assert.deepEqual(await store.computerLedger.get("phone-harness", "sess-a"), { provider: "phone-harness", sessionId: "sess-a", labels, detail, updatedAt: clock.now });
  assert.equal(await store.computerLedger.get("phone-harness", "sess-none"), undefined);
  assert.deepEqual((await store.computerLedger.list("phone-harness")).map((row) => row.sessionId), ["sess-a", "sess-b"], "one provider's sessions, by id");
  clock.now += 1_000;
  await store.computerLedger.put("phone-harness", "sess-a", { "agentrun.run": "run-1", "agentrun.epoch": "4" }, { ...detail, deadline: "2026-11-08T22:00:00.000Z" });
  assert.deepEqual(await store.computerLedger.get("phone-harness", "sess-a"), { provider: "phone-harness", sessionId: "sess-a", labels: { "agentrun.run": "run-1", "agentrun.epoch": "4" }, detail: { ...detail, deadline: "2026-11-08T22:00:00.000Z" }, updatedAt: clock.now }, "replaced in place");
  await store.computerLedger.remove("phone-harness", "sess-b");
  assert.deepEqual((await store.computerLedger.list("phone-harness")).map((row) => row.sessionId), ["sess-a"]);
  assert.deepEqual((await store.computerLedger.list("other")).map((row) => row.sessionId), ["sess-a"], "another provider's row is its own");
});

test("the computer ledger is STRICT, its labels and detail JSON and its time INTEGER, and it outlives the store that wrote it", async (t) => {
  const { store, file } = await storeOn(t);
  await store.computerLedger.put("phone-harness", "sess-a", { "agentrun.run": "run-1" }, {});
  await store.flush();
  await store.close();
  const raw = new DatabaseSync(file);
  try {
    assert.match(raw.prepare("SELECT sql FROM sqlite_schema WHERE name = 'computer_ledger'").get().sql, /\)\s*STRICT$/);
    assert.throws(() => raw.prepare("INSERT INTO computer_ledger (provider, session_id, labels, detail, updated_at) VALUES ('p', 's', 'not json', '{}', 1)").run(), /CHECK constraint/);
    assert.throws(() => raw.prepare("INSERT INTO computer_ledger (provider, session_id, labels, detail, updated_at) VALUES ('p', 's', '{}', 'not json', 1)").run(), /CHECK constraint/);
  } finally {
    raw.close();
  }
  // A restart: a new store over the same file still lists the session.
  const again = await storeOn(t, { file });
  assert.deepEqual((await again.store.computerLedger.list("phone-harness")).map((row) => [row.sessionId, row.labels]), [["sess-a", { "agentrun.run": "run-1" }]]);
});
