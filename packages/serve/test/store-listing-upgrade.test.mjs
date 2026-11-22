// The upgrade to each run's listing on its row (store/schema.ts RUN_LISTING_COLUMNS): SQLite version 11 to 12 at the
// server's open (listingUpgrade, then on to this version: store-relay-upgrade.test.mjs), Postgres 0016 to 0017 (migrations/0017_run_listing.sql). A store an earlier release made,
// its runs in every row state, comes through with its rows as they were, each settled run's status set from its row (a
// status filter finds it before any listing is built), and every run behind: a list builds what it shows, and what it
// builds is the run's view's item. A runner refuses the earlier SQLite store until its server has upgraded it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { client, dropSchema, freshSchema, PG_URL, postgresOnly, sqliteOnly } from "./store-target.mjs";

const { migrate, migrationsIn, openPostgresStore, openSqliteStore, SCHEMA_VERSION } = await import("../dist/store/index.js");
const { listedItem, listingOverStore, summaryOverStore } = await import("../dist/store-view.js");

const T = Date.parse("2026-11-10T09:00:00.000Z");
const FAR = T + 365 * 24 * 3_600_000;
const COLUMNS = ["list_mark", "listing", "list_status", "listing_mark", "listing_live", "listing_until", "listing_flags"];
const TRIGGERS = ["runs_list_moved", "runs_list_parent", "commands_list_moved", "commands_list_settled", "learning_list_moved", "learning_list_changed"];
const INDEXES = ["runs_listing_behind", "runs_listing_live", "runs_listing_until", "runs_by_list_status", "runs_listing_flagged", "learning_proposals_by_learning_run"];

/** The earlier release's rows, as its own writes left them: one run in each row state the status table reads. */
const ROWS = [
  "INSERT INTO agents (id, name, current_revision, created_at) VALUES ('old', 'old', 'rev-old', 1)",
  "INSERT INTO revisions (id, agent_id, kind, body, created_at) VALUES ('rev-old', 'old', 'agentic', '{\"instructions\":\"Answer.\"}', 1)",
  `INSERT INTO runs (id, agent_id, revision_id, state, epoch, cost_usd, started_at, ended_at) VALUES ('run-ended', 'old', 'rev-old', 'ended', 1, 0.25, ${T + 1}, ${T + 2})`,
  `INSERT INTO runs (id, agent_id, revision_id, state, epoch, cost_usd, started_at, ended_at) VALUES ('run-failed', 'old', 'rev-old', 'failed', 1, 0.5, ${T + 3}, ${T + 4})`,
  `INSERT INTO runs (id, agent_id, revision_id, state, epoch, outcome, started_at, ended_at) VALUES ('run-cancelled', 'old', 'rev-old', 'stopped', 1, 'cancelled', ${T + 5}, ${T + 6})`,
  `INSERT INTO runs (id, agent_id, revision_id, state, epoch, outcome, started_at, ended_at) VALUES ('run-stopped', 'old', 'rev-old', 'stopped', 1, 'stopped', ${T + 7}, ${T + 8})`,
  `INSERT INTO runs (id, agent_id, revision_id, state, epoch, runner, claimed_until, started_at) VALUES ('run-working', 'old', 'rev-old', 'running', 1, 'runner-a', ${FAR}, ${T + 9})`,
  `INSERT INTO runs (id, agent_id, revision_id, state, epoch, started_at) VALUES ('run-queued', 'old', 'rev-old', 'queued', 0, ${T + 10})`,
];
/** Each run's status from its row as the upgrade sets it: the settled ones, none for a run still going. */
const SETTLED = { "run-ended": "completed", "run-failed": "failed", "run-cancelled": "cancelled", "run-stopped": null, "run-working": null, "run-queued": null };
const DEPS = { origin: "http://127.0.0.1:7340", serverSecrets: () => [] };

/** What the upgraded store holds of each run's listing, by run. */
const listingRows = (rows) => Object.fromEntries(rows.map((row) => [row.id, { status: row.list_status, behind: Number(row.listing_mark) < Number(row.list_mark), listing: row.listing }]));

/** On the upgraded `store`: a status filter finds each settled run before any listing is built, the runs still going are
 *  the ones a filtered list builds first, and each listing built is the item the run's view gives, after which none is
 *  behind. */
async function listsAsViews(store) {
  for (const [id, status] of Object.entries(SETTLED)) {
    if (status) assert.deepEqual((await store.runs.listed({ archived: false, status, limit: 50 })).rows.map((run) => run.row.id), [id], `status=${status} reads the row's status`);
  }
  assert.deepEqual((await store.runs.listed({ archived: false, going: true, limit: 50 })).rows.map((run) => run.row.id).sort(), ["run-queued", "run-stopped", "run-working"], "the runs still going are the ones a filtered list builds first");
  const page = await store.runs.listed({ archived: false, limit: 50 });
  assert.equal(page.rows.length, 6);
  assert.ok(page.rows.every((run) => run.behind && run.listing === null), "every run is behind, none built");
  for (const { row, listMark } of page.rows) assert.equal(await store.runs.putListing(row.id, listMark, await listingOverStore(store, row.id, DEPS)), true, `${row.id}'s listing is written`);
  const built = await store.runs.listed({ archived: false, limit: 50 });
  for (const { row, listing, behind } of built.rows) {
    assert.equal(behind, false, `${row.id} is current once built`);
    assert.deepEqual(listedItem(listing, DEPS.origin, null, []), await summaryOverStore(store, row.id, DEPS), `${row.id} lists as its view`);
  }
  assert.deepEqual(await store.runs.behind({ limit: 50 }), [], "nothing is left for the lister");
}

test("SQLite: a version 11 store comes to this version at its server's open, never at a runner's, every run behind and each settled run's status set", sqliteOnly("the SQLite upgrade"), async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-listing-upgrade-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "store.sqlite");
  // Version 11's shape: this version's store with the listing taken out, and the earlier release's rows written into it.
  await (await openSqliteStore({ file })).close();
  const old = new DatabaseSync(file);
  try {
    for (const name of TRIGGERS) old.exec(`DROP TRIGGER ${name}`);
    for (const name of INDEXES) old.exec(`DROP INDEX ${name}`);
    for (const column of COLUMNS) old.exec(`ALTER TABLE runs DROP COLUMN ${column}`);
    // Nor does it keep version 13's relay: no runner on a token's row, no runners (where their listeners answer).
    old.exec("DROP TABLE runners");
    for (const column of ["runner", "incarnation", "run", "refused"]) old.exec(`ALTER TABLE minted_tokens DROP COLUMN ${column}`);
    old.exec("UPDATE store_meta SET schema_version = 11 WHERE singleton = 1");
    for (const sql of ROWS) old.exec(sql);
  } finally {
    old.close();
  }
  const snapshot = () => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return { schema: db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all().map((row) => ({ ...row })), runs: db.prepare("SELECT * FROM runs ORDER BY id").all().map((row) => ({ ...row })), version: db.prepare("SELECT schema_version FROM store_meta").get().schema_version };
    } finally {
      db.close();
    }
  };
  const before = snapshot();
  await assert.rejects(openSqliteStore({ file, role: "runner" }), new RegExp(`Start the AgentRun server to bring this store from version 11 to ${SCHEMA_VERSION} before opening a runner`));
  assert.deepEqual(snapshot(), before, "a runner's refusal changes nothing");

  const store = await openSqliteStore({ file });
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT schema_version FROM store_meta").get().schema_version, SCHEMA_VERSION);
      assert.deepEqual(db.prepare("SELECT name FROM pragma_table_info('runs')").all().map((row) => row.name).filter((name) => COLUMNS.includes(name)), COLUMNS);
      assert.deepEqual(db.prepare(`SELECT name FROM sqlite_schema WHERE name IN (${[...TRIGGERS, ...INDEXES].map(() => "?").join(", ")}) ORDER BY name`).all(...TRIGGERS, ...INDEXES).map((row) => row.name), [...TRIGGERS, ...INDEXES].sort());
      const rows = db.prepare("SELECT * FROM runs ORDER BY id").all();
      assert.deepEqual(rows.map((row) => Object.fromEntries(Object.keys(before.runs[0]).map((key) => [key, row[key]]))), before.runs, "every run's row as it was");
      assert.deepEqual(listingRows(rows), Object.fromEntries(Object.entries(SETTLED).map(([id, status]) => [id, { status, behind: true, listing: null }])));
    } finally {
      db.close();
    }
    await listsAsViews(store);
  } finally {
    await store.close();
  }
  const upgraded = snapshot();
  await (await openSqliteStore({ file })).close();
  assert.deepEqual(snapshot(), upgraded, "a second open finds this version and changes nothing");
  await (await openSqliteStore({ file, role: "runner" })).close();
});

test("Postgres: a store at 0016 takes 0017, every run behind and each settled run's status set, its rows as they were", postgresOnly("the Postgres migration"), async (t) => {
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
  const earlier = migrationsIn().filter((m) => m.version <= 16);
  assert.equal(earlier.at(-1).version, 16, "the earlier release's last migration");
  await migrate(sql, schema, T, earlier);
  for (const statement of ROWS) await sql.query(statement);
  const columns = async () => (await sql.query("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'runs' ORDER BY ordinal_position", [schema])).rows.map((row) => row.column_name);
  const old = await columns();
  assert.deepEqual(old.filter((name) => COLUMNS.includes(name)), [], "0016 keeps no listing");
  const before = (await sql.query(`SELECT ${old.join(", ")} FROM runs ORDER BY id`)).rows;

  store = await openPostgresStore({ url: PG_URL, schema });
  assert.equal(Number((await sql.query("SELECT schema_version FROM store_meta")).rows[0].schema_version), migrationsIn().at(-1).version);
  assert.deepEqual((await columns()).filter((name) => COLUMNS.includes(name)), COLUMNS);
  assert.deepEqual((await sql.query(`SELECT ${old.join(", ")} FROM runs ORDER BY id`)).rows, before, "every run's row as it was");
  assert.deepEqual(listingRows((await sql.query("SELECT * FROM runs ORDER BY id")).rows), Object.fromEntries(Object.entries(SETTLED).map(([id, status]) => [id, { status, behind: true, listing: null }])));
  assert.deepEqual((await sql.query("SELECT tgname FROM pg_trigger JOIN pg_class ON pg_class.oid = tgrelid JOIN pg_namespace ON pg_namespace.oid = relnamespace WHERE nspname = $1 AND NOT tgisinternal AND tgname LIKE '%list%' ORDER BY tgname", [schema])).rows.map((row) => row.tgname), ["commands_list_moved", "commands_list_settled", "learning_list_moved", "runs_list_moved", "runs_list_parent"]);
  await listsAsViews(store);
});
