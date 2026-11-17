// No migration (the lead's ruling): the server's open refuses a data directory an earlier version wrote, naming what it
// found, with two choices: keep the directory with the earlier version, or start in a new, empty directory. Nothing is read, moved or changed there. An empty directory (or one
// not made yet, or one holding this version's store) opens.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test as nodeTest } from "node:test";
import { sqliteAdapterTests } from "./store-target.mjs";

const test = sqliteAdapterTests(nodeTest, "an earlier version's data directory files");

const { openSqliteStore, SCHEMA_VERSION } = await import("../dist/store/index.js");

function dataDir(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-earlier-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const file = (path, text = "{}") => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const sqlite = (path) => {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE agents (id TEXT PRIMARY KEY)");
  db.close();
};

/** A link at `path` to a directory elsewhere that `make` fills: an earlier version's home or run kept outside the data
 *  directory and linked in, as the server's own check of old homes follows (server.ts oldHomes). */
const linked = (path, make) => {
  const target = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-earlier-target-"));
  linkedTargets.push(target);
  make(target);
  mkdirSync(join(path, ".."), { recursive: true });
  symlinkSync(target, path, "dir");
};
const linkedTargets = [];
after(() => {
  for (const target of linkedTargets) rmSync(target, { recursive: true, force: true });
});

const SHAPES = [
  ["an earlier version's store.sqlite (no schema_version row)", (dir) => sqlite(join(dir, "store.sqlite")), "store.sqlite"],
  ["an agent home's agent.sqlite", (dir) => sqlite(join(dir, "agent-1", "agent.sqlite")), join("agent-1", "agent.sqlite")],
  ["an agents/ home's agent.sqlite", (dir) => sqlite(join(dir, "agents", "agent-1", "agent.sqlite")), join("agents", "agent-1", "agent.sqlite")],
  ["a run's run.sqlite under runs/", (dir) => sqlite(join(dir, "runs", "run-1", "run.sqlite")), join("runs", "run-1", "run.sqlite")],
  ["a run's run.sqlite on the disk", (dir) => sqlite(join(dir, "disk", "agents", "agent-1", "runs", "run-1", "run.sqlite")), join("disk", "agents", "agent-1", "runs", "run-1", "run.sqlite")],
  ["mcp-servers.json", (dir) => file(join(dir, "mcp-servers.json")), "mcp-servers.json"],
  ["triggers.json", (dir) => file(join(dir, "triggers.json")), "triggers.json"],
  ["tool-keys.json", (dir) => file(join(dir, "tool-keys.json")), "tool-keys.json"],
  ["trigger-secrets.json", (dir) => file(join(dir, "trigger-secrets.json")), "trigger-secrets.json"],
  ["a home's sign-ins.json", (dir) => file(join(dir, "homes", "home-1", "sign-ins", "sign-ins.json")), join("homes", "home-1", "sign-ins", "sign-ins.json")],
  // The per-run door's token: only an earlier version's runs had a door.
  [".door-token", (dir) => file(join(dir, ".door-token"), "token"), ".door-token"],
  // A home or run linked in from elsewhere is the earlier version's all the same.
  ["a linked agent home's agent.sqlite", (dir) => linked(join(dir, "agent-1"), (to) => sqlite(join(to, "agent.sqlite"))), join("agent-1", "agent.sqlite")],
  ["a linked agents/ home's agent.sqlite", (dir) => linked(join(dir, "agents", "agent-1"), (to) => sqlite(join(to, "agent.sqlite"))), join("agents", "agent-1", "agent.sqlite")],
  ["a linked run's run.sqlite under runs/", (dir) => linked(join(dir, "runs", "run-1"), (to) => sqlite(join(to, "run.sqlite"))), join("runs", "run-1", "run.sqlite")],
  ["a linked home's sign-ins.json", (dir) => linked(join(dir, "homes", "home-1"), (to) => file(join(to, "sign-ins", "sign-ins.json"))), join("homes", "home-1", "sign-ins", "sign-ins.json")],
];

test("this version's own files beside its store open: .token, .server.json, a leftover box-image.json, the kept idempotency answers and the learning usage ledger this version still keeps beside the store, and an earlier build's webhook config and outbox, which nothing reads", async (t) => {
  const dir = dataDir(t);
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  await store.close();
  // This version writes these beside its store, in the same format an earlier version did, so a directory holding them is
  // this version's own, not an earlier version's: it opens. The webhook's two files are an earlier build's, left unread
  // (the webhook is in the store now): they refuse nothing.
  for (const name of [".token", ".server.json", "box-image.json", "webhook.json", "webhook-outbox.json", ".idempotency.json", "learning-usage.jsonl"]) file(join(dir, name), "{}");
  const again = await openSqliteStore({ dataDir: dir, role: "server" });
  await again.close();
});

for (const [what, make, named] of SHAPES) {
  test(`the server refuses a data directory holding ${what}, by name, and changes nothing there`, async (t) => {
    const dir = dataDir(t);
    make(dir);
    const before = readdirSync(dir, { recursive: true }).sort();
    await assert.rejects(openSqliteStore({ dataDir: dir, role: "server" }), (error) => {
      assert.equal(error.name, "StoreFromEarlierVersion");
      assert.ok(error.found.includes(named), `it names ${named}: ${JSON.stringify(error.found)}`);
      assert.match(error.message, /earlier version's data/);
      // Two choices, both in plain words: keep the directory with the earlier version, or start this version on a new
      // directory and add the agents (and what they used) there again.
      assert.match(error.message, /Keep this directory with the earlier version/);
      assert.match(error.message, /or start this version on a new, empty directory and add your agents, MCP servers, keys and sign-ins there again\.$/);
      return true;
    });
    assert.deepEqual(readdirSync(dir, { recursive: true }).sort(), before, "nothing made, moved or removed");
  });
}

test("a disk mounted as the data directory opens though its lost+found is root's and closed, and an earlier version's file beside it is still found", async (t) => {
  const dir = dataDir(t);
  const lost = join(dir, "lost+found");
  mkdirSync(lost);
  chmodSync(lost, 0o000);
  try {
    const store = await openSqliteStore({ dataDir: dir, role: "server" });
    await store.close();
    file(join(dir, "triggers.json"));
    await assert.rejects(openSqliteStore({ dataDir: dir, role: "server" }), (error) => error.name === "StoreFromEarlierVersion" && error.found.includes("triggers.json"));
  } finally {
    chmodSync(lost, 0o700);
  }
});

test("an empty data directory, one not made yet, and one holding this version's store all open", async (t) => {
  const empty = dataDir(t);
  const store = await openSqliteStore({ dataDir: empty, role: "server" });
  await store.close();
  const again = await openSqliteStore({ dataDir: empty, role: "server" });
  await again.close();
  const fresh = join(dataDir(t), "not-yet");
  const made = await openSqliteStore({ dataDir: fresh, role: "server" });
  await made.close();
});

test("a store an earlier build of this version made (no revisions.mcp_pin, a per-run mcp_pins table) opens: the server adds the column and drops the table, an earlier revision has no pin, and a revision saved after pins", async (t) => {
  const dir = dataDir(t);
  const first = await openSqliteStore({ dataDir: dir, role: "server" });
  await first.agents.create({ id: "agent-old", name: "agent-old" }, { id: "rev-old", kind: "agentic", body: { instructions: "Answer." } });
  await first.runs.create({ id: "run-old", agentId: "agent-old", revisionId: "rev-old" });
  await first.close();
  // The earlier build's shape: version 11, revisions without mcp_pin, and each run's pin in mcp_pins (as main had it).
  const raw = new DatabaseSync(join(dir, "store.sqlite"));
  try {
    raw.exec("ALTER TABLE revisions DROP COLUMN mcp_pin");
    raw.exec("CREATE TABLE mcp_pins (run_id TEXT PRIMARY KEY REFERENCES runs (id), body TEXT NOT NULL CHECK (body IS NULL OR json_valid(body)), pinned_at INTEGER NOT NULL) STRICT");
    raw.prepare("INSERT INTO mcp_pins (run_id, body, pinned_at) VALUES (?, ?, ?)").run("run-old", JSON.stringify({ fake: { url: "http://127.0.0.1:1/mcp", tools: [{ name: "add" }] } }), 1);
    raw.exec("UPDATE store_meta SET schema_version = 11 WHERE singleton = 1");
  } finally {
    raw.close();
  }
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  try {
    const check = new DatabaseSync(join(dir, "store.sqlite"), { readOnly: true });
    try {
      assert.equal(check.prepare("SELECT schema_version FROM store_meta WHERE singleton = 1").get().schema_version, SCHEMA_VERSION, "the server's open brings version 11 to this version");
      const column = check.prepare("SELECT name, type, \"notnull\" FROM pragma_table_info('revisions') WHERE name = 'mcp_pin'").get();
      assert.deepEqual({ ...column }, { name: "mcp_pin", type: "TEXT", notnull: 0 }, "the open adds revisions.mcp_pin, nullable TEXT");
      assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'mcp_pins'").get().n, 0, "the open drops mcp_pins");
    } finally {
      check.close();
    }
    assert.equal((await store.mcp.pin("run-old")) ?? null, null, "a revision saved before has no pin: its first run pins it (Agents.pinOnce)");
    const pin = { fake: { url: "http://127.0.0.1:1/mcp", tools: [{ name: "add", inputSchema: { type: "object" } }] } };
    await store.agents.create({ id: "agent-new", name: "agent-new" }, { id: "rev-new", kind: "agentic", body: { instructions: "Answer." }, mcpPin: pin });
    await store.runs.create({ id: "run-new", agentId: "agent-new", revisionId: "rev-new" });
    assert.deepEqual((await store.mcp.pin("run-new"))?.body, pin, "a revision saved after the open pins");
  } finally {
    await store.close();
  }
  // The column is json-checked as the DDL's is.
  const bad = new DatabaseSync(join(dir, "store.sqlite"));
  try {
    assert.throws(() => bad.prepare("UPDATE revisions SET mcp_pin = 'not json' WHERE id = 'rev-old'").run(), /CHECK constraint failed/, "a non-JSON pin is refused");
  } finally {
    bad.close();
  }
  // A second open finds the column and adds nothing.
  const again = await openSqliteStore({ dataDir: dir, role: "server" });
  await again.close();
});

test("a store an earlier build of this version made (no runs.cost_upper_bound) opens: a runner refuses it until the server adds the column, and a run ended before reads its cost as no bound", async (t) => {
  const dir = dataDir(t);
  const first = await openSqliteStore({ dataDir: dir, role: "server" });
  await first.agents.create({ id: "agent-old", name: "agent-old" }, { id: "rev-old", kind: "agentic", body: { instructions: "Answer." } });
  await first.runs.create({ id: "run-old", agentId: "agent-old", revisionId: "rev-old" });
  const claim = await first.claim("run-old", "runner-a", { leaseMs: 60_000 });
  await first.runs.update(claim, { state: "ended", costUsd: 0.5 });
  await first.close();
  const raw = new DatabaseSync(join(dir, "store.sqlite"));
  try {
    raw.exec("ALTER TABLE runs DROP COLUMN cost_upper_bound");
  } finally {
    raw.close();
  }
  await assert.rejects(openSqliteStore({ dataDir: dir, role: "runner" }), /Start the AgentRun server to add the bound beside each run's cost/, "a runner, which writes the bound at each end, waits for the server");
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  try {
    const check = new DatabaseSync(join(dir, "store.sqlite"), { readOnly: true });
    try {
      assert.equal(check.prepare("SELECT schema_version FROM store_meta WHERE singleton = 1").get().schema_version, SCHEMA_VERSION, "the store stays at its version");
      const column = check.prepare("SELECT name, type, \"notnull\", dflt_value FROM pragma_table_info('runs') WHERE name = 'cost_upper_bound'").get();
      assert.deepEqual({ ...column }, { name: "cost_upper_bound", type: "INTEGER", notnull: 1, dflt_value: "0" }, "the open adds runs.cost_upper_bound, 0 by default");
    } finally {
      check.close();
    }
    const row = await store.runs.get("run-old");
    assert.deepEqual([row.costUsd, row.costAtMostUsd], [0.5, null], "a run ended before reads its stored cost as exact, as it was read then");
  } finally {
    await store.close();
  }
  const runner = await openSqliteStore({ dataDir: dir, role: "runner" });
  await runner.close();
});


for (const missing of [["mcp_pin"], ["monid_pin"], ["mcp_pin", "monid_pin"], []]) {
  test(`a version 11 runner ${missing.length ? `refuses missing ${missing.join(" and ")} until its server upgrades it` : "opens prepared revision metadata"}, without changing stored schema or rows`, async (t) => {
    const dir = dataDir(t);
    const first = await openSqliteStore({ dataDir: dir, role: "server" });
    const legacy = { "monid:legacy/check": { description: "An old body-only pin.", input: { type: "object" }, usd: 0.01 } };
    const body = { instructions: "Keep this saved body.", monidPin: legacy };
    const mcp = { fake: { url: "http://127.0.0.1:1/mcp", tools: [{ name: "check", inputSchema: { type: "object" } }] } };
    const monid = { "monid:tagger/tag": { description: "A saved usage-priced endpoint.", input: { type: "object" }, usd: null } };
    await first.agents.create({ id: "agent-readiness", name: "Readiness" }, { id: "rev-readiness", kind: "agentic", body, mcpPin: mcp, monidPin: monid });
    await first.close();
    const file = join(dir, "store.sqlite");
    const old = new DatabaseSync(file);
    try {
      for (const column of missing) old.exec(`ALTER TABLE revisions DROP COLUMN ${column}`);
      old.exec("CREATE TABLE mcp_pins (run_id TEXT PRIMARY KEY, body TEXT, pinned_at INTEGER) STRICT");
      old.prepare("INSERT INTO mcp_pins VALUES (?, ?, ?)").run("legacy-run", JSON.stringify(mcp), 1);
    } finally { old.close(); }
    // Logical schema and row bytes, not journal/checkpoint files a read-only connection may observe.
    const snapshot = () => {
      const raw = new DatabaseSync(file, { readOnly: true });
      try {
        const columns = raw.prepare("SELECT name FROM pragma_table_info('revisions')").all().map((row) => row.name);
        const pins = ["mcp_pin", "monid_pin"].filter((column) => columns.includes(column));
        const legacyTable = raw.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'mcp_pins'").get().n;
        return {
          schema: raw.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all().map((row) => ({ ...row })),
          version: raw.prepare("SELECT schema_version FROM store_meta WHERE singleton = 1").get().schema_version,
          revision: { ...raw.prepare(`SELECT id, agent_id, parent_id, kind, body, created_at${pins.length ? `, ${pins.join(", ")}` : ""} FROM revisions WHERE id = 'rev-readiness'`).get() },
          legacy: legacyTable ? raw.prepare("SELECT * FROM mcp_pins ORDER BY run_id").all().map((row) => ({ ...row })) : null,
        };
      } finally { raw.close(); }
    };
    const before = snapshot();
    if (missing.length) {
      // Reject at open, before a normal revision read can fail on a missing SELECT column.
      await assert.rejects(async () => {
        const runner = await openSqliteStore({ dataDir: dir, role: "runner" });
        await runner.close();
      }, /server.*MCP and Monid revision metadata.*runner/i);
    } else {
      const runner = await openSqliteStore({ dataDir: dir, role: "runner" });
      try { assert.deepEqual((await runner.agents.revision("rev-readiness")).monidPin, monid); }
      finally { await runner.close(); }
    }
    assert.deepEqual(snapshot(), before, "opening/refusing a runner adds, drops and changes no schema or saved row");
    const server = await openSqliteStore({ dataDir: dir, role: "server" });
    try {
      const runner = await openSqliteStore({ dataDir: dir, role: "runner" });
      try {
        const revision = await runner.agents.revision("rev-readiness");
        assert.deepEqual(revision.body, body, "the historical body-only pin remains opaque body data");
        assert.equal(revision.createdAt, before.revision.created_at);
        assert.deepEqual(revision.mcpPin, missing.includes("mcp_pin") ? null : mcp, "an existing MCP pin is retained; a missing one is not invented");
        assert.deepEqual(revision.monidPin, missing.includes("monid_pin") ? null : monid, "a missing Monid column never imports the old body pin; saved unknown price stays null");
      } finally { await runner.close(); }
    } finally { await server.close(); }
    const upgraded = snapshot();
    assert.equal(upgraded.version, SCHEMA_VERSION, "this additive metadata does not change the SQLite version policy");
    assert.equal(upgraded.revision.body, before.revision.body, "the exact stored body JSON bytes are unchanged");
    assert.equal(upgraded.legacy, null, "only the server removes the obsolete per-run table");
    const raw = new DatabaseSync(file);
    try {
      for (const column of ["mcp_pin", "monid_pin"]) {
        assert.deepEqual({ ...raw.prepare("SELECT type, \"notnull\" FROM pragma_table_info('revisions') WHERE name = ?").get(column) }, { type: "TEXT", notnull: 0 });
        assert.throws(() => raw.prepare(`UPDATE revisions SET ${column} = 'not json' WHERE id = 'rev-readiness'`).run(), /CHECK constraint failed/);
      }
    } finally { raw.close(); }
    const again = await openSqliteStore({ dataDir: dir, role: "server" });
    await again.close();
    assert.deepEqual(snapshot(), upgraded, "server reopen is idempotent without rewriting revision bytes or pins");
  });
}
