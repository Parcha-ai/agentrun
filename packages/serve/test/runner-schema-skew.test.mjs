// A runner beside a server of a later release, on Postgres (migrate.ts runnerFloorOf; runner/main.ts watchFloor), and the
// learning rows' release on SQLite too (its SCHEMA_VERSION: a runner that knows an earlier one is refused, loudly). The
// server migrates first, under runners of the earlier release that keep running:
//   - an additive migration leaves the runner floor where it was: a runner of the earlier build opens the schema ahead of
//     it, and one already running finishes its run and goes on claiming;
//   - a breaking migration (its `-- runners: breaking` header) raises the floor to its version: a running runner of an
//     earlier build reads it at its next renewal, claims nothing more, hands its run back for another runner, and its
//     process ends with exit 3; one starting is refused (RunnerBelowFloor);
//   - a runner of a later build than the schema's waits for its server (StoreAwaitsServer: refused, nothing written), and
//     runs once that server migrated.
// "This build" is the earlier release here: the later one is this build's migrations and one more, applied as its server
// would (migrate()).
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { startRunnerProcess } from "../dist/runner/main.js";
import { LAST_UNMARKED, migrate, Unanswered, migrationsIn, openPostgresStore, openSqliteStore, RunnerBelowFloor, runnerFloorOf, runnerOn, StoreAwaitsServer } from "../dist/store/index.js";
import { refuseBelowFloor } from "../dist/store/postgres/migrate.js";
import { SCHEMA_VERSION } from "../dist/store/schema.js";
import { readStoreSchema, STORE_SCHEMA_LOCK_MS } from "../dist/store/store-schema.js";
import { SCHEMA_STATE_MS } from "../dist/store/postgres/store.js";
import { fauxLoops, until } from "./runner-support.mjs";
import { client, dropSchema, freshSchema, PG_URL, postgresOnly } from "./store-target.mjs";

const ONLY = postgresOnly("a runner beside a later server's migrations");
const SEAL = randomBytes(32).toString("base64");
const KNOWN = migrationsIn().at(-1).version;

/** The floor a store that applied this build's migrations up to `version` holds: the newest of them marked breaking, or
 *  LAST_UNMARKED and before. */
const floorAt = (version) => Math.max(...migrationsIn().filter((m) => m.version <= version && (m.breaking || m.version <= LAST_UNMARKED)).map((m) => m.version));

/** The later release's migration, one past this build's last: additive unless `breaking`. */
function later(breaking, version = KNOWN + 1) {
  const sql = breaking
    ? `-- A later release's cleanup.\n-- runners: breaking\nCREATE TABLE skew_later_${version} (id TEXT PRIMARY KEY);\nUPDATE store_meta SET schema_version = ${version} WHERE singleton = 1;\n`
    : `-- A later release's additive step.\nALTER TABLE runs ADD COLUMN IF NOT EXISTS skew_note_${version} TEXT;\nUPDATE store_meta SET schema_version = ${version} WHERE singleton = 1;\n`;
  return { version, name: breaking ? "later_breaking" : "later_additive", sql, sha256: createHash("sha256").update(sql).digest("hex"), breaking };
}

/** The version of the learning rows' migration (0032_learning_rows.sql), and the version before it: what a runner of the
 *  release before learning rows knows. */
const ROWS = migrationsIn().find((m) => m.name === "learning_rows").version;
/** The SQLite schema version of the release before learning rows: its runner opens only that version. */
const SQLITE_BEFORE_ROWS = 16;

/** A scratch schema dropped at the test's end, with a test client on it. */
async function schemaFor(t) {
  const schema = await freshSchema();
  const sql = await client();
  t.after(async () => {
    await sql.end();
    await dropSchema(schema);
  });
  return { schema, sql };
}

/** The later release's server migrates `schema` to this build's migrations and `more`. */
const migrateTo = (sql, schema, more) => migrate(sql, schema, Date.now(), [...migrationsIn(), ...more]);

/** agent-1 and `runs` queued, made by this build's server, which then closes. */
async function setUp(schema, runs) {
  const server = await openPostgresStore({ url: PG_URL, schema });
  try {
    await server.agents.create({ id: "agent-1", name: "Agent one" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
    for (const id of runs) await server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" });
  } finally {
    await server.close();
  }
}

/** Queues `id` with the one statement the store's runs.create runs (sqlite/store.ts, both stores' code), straight on the
 *  schema: the later server queueing a run on a schema no store of this build may open as a server. */
const queueRaw = (sql, schema, id) => sql.query(`INSERT INTO ${schema}.runs (id, agent_id, revision_id, state, epoch, started_at) VALUES ($1, 'agent-1', 'rev-1', 'queued', 0, $2)`, [id, Date.now()]);

/** A run's row, read straight from the schema. */
const row = async (sql, schema, id) => (await sql.query(`SELECT state, runner FROM ${schema}.runs WHERE id = $1`, [id])).rows[0];

function runner(t, schema, options) {
  const dataDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-skew-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return startRunnerProcess({ dataDir, storeUrl: PG_URL, env: { ...process.env, AGENTRUN_STORE_SCHEMA: schema, AGENTRUN_SEAL_KEY: SEAL }, loops: 2, ...options });
}

test("the server records which migrations break runners: the floor is the newest of them, or LAST_UNMARKED", ONLY, async (t) => {
  const { schema, sql } = await schemaFor(t);
  assert.deepEqual(await runnerFloorOf(sql, schema), { version: null, runnerFloor: null }, "nothing set up");
  await migrateTo(sql, schema, []);
  assert.deepEqual(await runnerFloorOf(sql, schema), { version: KNOWN, runnerFloor: floorAt(KNOWN) });
  await migrateTo(sql, schema, [later(false)]);
  assert.deepEqual(await runnerFloorOf(sql, schema), { version: KNOWN + 1, runnerFloor: floorAt(KNOWN) }, "an additive migration leaves the floor");
  await migrateTo(sql, schema, [later(false), later(true, KNOWN + 2), later(false, KNOWN + 3)]);
  assert.deepEqual(await runnerFloorOf(sql, schema), { version: KNOWN + 3, runnerFloor: KNOWN + 2 }, "a breaking one raises it to its version, and the next additive one leaves it there");
  const marks = (await sql.query(`SELECT version, runners_breaking FROM ${schema}.schema_migrations WHERE version > $1 ORDER BY version`, [KNOWN])).rows;
  assert.deepEqual(marks.map((m) => [Number(m.version), m.runners_breaking]), [[KNOWN + 1, false], [KNOWN + 2, true], [KNOWN + 3, false]]);
});

test("a ledger an earlier server kept, with no breaking marks, has its version as its floor", ONLY, async (t) => {
  const { schema, sql } = await schemaFor(t);
  // An earlier server's ledger: no breaking marks, and so no migration past LAST_UNMARKED (the marks came with 0023).
  await migrate(sql, schema, Date.now(), migrationsIn().slice(0, LAST_UNMARKED));
  await sql.query(`ALTER TABLE ${schema}.schema_migrations DROP COLUMN runners_breaking`);
  assert.deepEqual(await runnerFloorOf(sql, schema), { version: LAST_UNMARKED, runnerFloor: LAST_UNMARKED });
  // This build's server marks it at its next start, and marks each migration it applies past it.
  await migrateTo(sql, schema, []);
  assert.deepEqual(await runnerFloorOf(sql, schema), { version: KNOWN, runnerFloor: floorAt(KNOWN) });
});

test("after an additive migration, a runner of the earlier build opens the schema ahead of it and runs a run to its end", ONLY, async (t) => {
  const { schema, sql } = await schemaFor(t);
  await setUp(schema, ["run-1"]);
  await migrateTo(sql, schema, [later(false)]);
  const said = [];
  const started = await runner(t, schema, { name: "runner-old", createLoop: fauxLoops({ turns: 2, turnMs: 10 }).createLoop, warn: (line) => said.push(line) });
  let closed = false;
  t.after(() => (closed ? undefined : started.close()));
  assert.ok(said.some((line) => line.includes(`the store is at schema version ${KNOWN + 1}, ahead of this runner's ${KNOWN}; its runner floor is ${floorAt(KNOWN)}`)), said.join(" | "));
  await until(async () => (await row(sql, schema, "run-1")).state === "ended", "the run ends on the newer schema", 15_000);
  await until(async () => (await row(sql, schema, "run-1")).runner === null, "its release");
  await started.close();
  closed = true;
});

test("an additive migration under a running runner of the earlier build: it finishes its run, goes on claiming, and never stops", ONLY, async (t) => {
  const { schema, sql } = await schemaFor(t);
  await setUp(schema, ["run-1"]);
  const faux = fauxLoops({ turns: 40, turnMs: 25 });
  const started = await runner(t, schema, { name: "runner-old", createLoop: faux.createLoop, floorEveryMs: 50 });
  let closed = false;
  t.after(() => (closed ? undefined : started.close()));
  let outdated;
  void started.outdated.then((why) => (outdated = why));
  await until(async () => (await row(sql, schema, "run-1")).runner === "runner-old", "it holds the run");
  await migrateTo(sql, schema, [later(false)]);
  // The later server queues one more run on the schema it migrated: the runner, its floor unmoved, claims it (the control
  // for the breaking case below, which queues the same way and is never claimed).
  await queueRaw(sql, schema, "run-2");
  for (const id of ["run-1", "run-2"]) await until(async () => (await row(sql, schema, id)).state === "ended", `${id} ends`, 20_000);
  assert.equal(outdated, undefined, "the floor did not rise: it never stopped");
  assert.deepEqual(faux.loops.map((loop) => loop.claim.runner), ["runner-old", "runner-old"]);
  await started.close();
  closed = true;
});

test("a breaking migration under a running runner of the earlier build: it claims nothing more, hands its run back, and says why", ONLY, async (t) => {
  const { schema, sql } = await schemaFor(t);
  await setUp(schema, ["run-1"]);
  const faux = fauxLoops({ turns: 400, turnMs: 25 });
  const started = await runner(t, schema, { name: "runner-old", createLoop: faux.createLoop, floorEveryMs: 50 });
  let closed = false;
  t.after(() => (closed ? undefined : started.close()));
  await until(async () => (await row(sql, schema, "run-1")).runner === "runner-old", "it holds the run");
  await migrateTo(sql, schema, [later(true)]);
  const why = await Promise.race([started.outdated, new Promise((resolve) => setTimeout(() => resolve("never"), 10_000))]);
  assert.equal(why, `the store is at schema version ${KNOWN + 1}, and its runner floor rose to ${KNOWN + 1}, above the version this runner knows (${KNOWN}): a later server changed the schema in a way this runner cannot run beside`);
  // The later server queues a run now. The runner has a free loop (2, holding 1) and polls every second: it claims nothing.
  await queueRaw(sql, schema, "run-2");
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  assert.deepEqual(await row(sql, schema, "run-2"), { state: "queued", runner: null }, "the run queued after the floor rose is never claimed");
  // The process's stop (runnerMain: runUntilSignalled, then exit 3): the close, its run handed back.
  await started.close();
  closed = true;
  const after = await row(sql, schema, "run-1");
  assert.equal(after.runner, null, "handed back: no runner holds it");
  assert.ok(!["ended", "stopped", "failed"].includes(after.state), `not ended for the stop: ${after.state}`);
  assert.equal(faux.loops.length, 1, "it claimed nothing after the floor rose, with a loop free and a run queued");
  assert.deepEqual(faux.loops.map((loop) => loop.stopCalls.map((call) => call.kind)), [["shutdown"]], "its loop was stopped for a shutdown, to resume elsewhere");
  // A runner of the earlier build starting now is refused, in words that say what to run.
  await assert.rejects(runner(t, schema, { createLoop: fauxLoops().createLoop }), (error) => {
    assert.equal(error.name, "RunnerRefused");
    assert.ok(error.cause instanceof RunnerBelowFloor, String(error.cause));
    assert.equal(error.message, `The store in the Postgres schema ${schema} is at schema version ${KNOWN + 1}, and a runner on it must know version ${KNOWN + 1} or later; this runner knows ${KNOWN}: run a runner of the server's release.`);
    return true;
  });
});

test("an idle runner of the earlier build, holding no run, reads the floor too: a breaking migration stops it", ONLY, async (t) => {
  const { schema, sql } = await schemaFor(t);
  await setUp(schema, []);
  const started = await runner(t, schema, { name: "runner-idle", createLoop: fauxLoops().createLoop, floorEveryMs: 50 });
  t.after(() => started.close());
  assert.deepEqual(started.runner.held(), [], "it holds nothing");
  await migrateTo(sql, schema, [later(true)]);
  const why = await Promise.race([started.outdated, new Promise((resolve) => setTimeout(() => resolve("never"), 10_000))]);
  assert.match(why, new RegExp(`runner floor rose to ${KNOWN + 1}, above the version this runner knows \\(${KNOWN}\\)`));
});

test("a runner of a later build than the schema's waits for its server: refused, nothing written, then it runs once the server migrated", ONLY, async (t) => {
  const { schema, sql } = await schemaFor(t);
  // The earlier release's server left the schema one migration behind this build.
  await migrate(sql, schema, Date.now(), migrationsIn().slice(0, -1));
  const ledger = async () => (await sql.query(`SELECT * FROM ${schema}.schema_migrations ORDER BY version`)).rows;
  const before = await ledger();
  const faux = fauxLoops({ turns: 1, turnMs: 10 });
  await assert.rejects(runner(t, schema, { name: "runner-new", createLoop: faux.createLoop }), (error) => {
    assert.equal(error.name, "RunnerRefused");
    assert.ok(error.cause instanceof StoreAwaitsServer, String(error.cause));
    assert.match(error.message, /is behind this runner: start the server first, which upgrades the store in place, then the runner/);
    return true;
  });
  assert.deepEqual(await ledger(), before, "the runner migrated nothing");
  assert.equal(faux.loops.length, 0, "and claimed nothing");
  // The server of the runner's release migrates, and queues a run: the runner, started again, runs it.
  await setUp(schema, ["run-1"]);
  const started = await runner(t, schema, { name: "runner-new", createLoop: faux.createLoop });
  t.after(() => started.close());
  await until(async () => (await row(sql, schema, "run-1")).state === "ended", "the run ends", 15_000);
  assert.equal(faux.loops[0].claim.runner, "runner-new");
});

test("store-schema reads the live schema and floor beside this build's version, and writes nothing", ONLY, async (t) => {
  const { schema, sql } = await schemaFor(t);
  const env = { ...process.env, AGENTRUN_STORE_SCHEMA: schema };
  const read = () => readStoreSchema("/nonexistent-data-dir", env, PG_URL);
  const where = `the Postgres schema ${schema}`;
  assert.deepEqual(await read(), { store: "postgres", where, schema: null, runnerFloor: null, build: KNOWN, server: "sets up", runner: "refused" });
  assert.equal((await sql.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema])).rowCount, 0, "no schema made");
  await migrate(sql, schema, Date.now(), migrationsIn().slice(0, -1));
  assert.deepEqual(await read(), { store: "postgres", where, schema: KNOWN - 1, runnerFloor: floorAt(KNOWN - 1), build: KNOWN, server: "migrates", runner: "waits" });
  await migrateTo(sql, schema, []);
  assert.deepEqual(await read(), { store: "postgres", where, schema: KNOWN, runnerFloor: floorAt(KNOWN), build: KNOWN, server: "opens", runner: "opens" });
  await migrateTo(sql, schema, [later(false)]);
  assert.deepEqual(await read(), { store: "postgres", where, schema: KNOWN + 1, runnerFloor: floorAt(KNOWN), build: KNOWN, server: "refuses", runner: "opens" }, "a rollback across a migration: this build's server refuses, its runner still opens");
  await migrateTo(sql, schema, [later(false), later(true, KNOWN + 2)]);
  assert.deepEqual(await read(), { store: "postgres", where, schema: KNOWN + 2, runnerFloor: KNOWN + 2, build: KNOWN, server: "refuses", runner: "refused" });
  const ledger = (await sql.query(`SELECT * FROM ${schema}.schema_migrations ORDER BY version`)).rows;
  await read();
  assert.deepEqual((await sql.query(`SELECT * FROM ${schema}.schema_migrations ORDER BY version`)).rows, ledger, "a read changes nothing");
});

/** A link to the test database that forwards until `stall()`, then passes nothing on either way: a database that stopped
 *  answering, its connections still open. */
async function stallingLink() {
  const target = new URL(PG_URL);
  const sockets = new Set();
  let stalled = false;
  const server = createServer((socket) => {
    const upstream = connect(Number(target.port || 5432), target.hostname);
    for (const [from, to] of [[socket, upstream], [upstream, socket]]) {
      sockets.add(from);
      from.on("error", () => undefined);
      from.on("data", (chunk) => void (!stalled && to.writable && to.write(chunk)));
      from.on("close", () => to.destroy());
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = new URL(PG_URL);
  url.host = `127.0.0.1:${server.address().port}`;
  return {
    url: url.toString(),
    stall: () => void (stalled = true),
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(resolve);
    }),
  };
}

test("store-schema behind a server's migration (its lock on the ledger) fails at its lock timeout, never waits it out", ONLY, async (t) => {
  const { schema, sql } = await schemaFor(t);
  await setUp(schema, []);
  // A server migrating holds the ledger: its ALTER TABLE takes it ACCESS EXCLUSIVE until its transaction ends.
  const migrating = await client();
  t.after(() => migrating.end());
  await migrating.query("BEGIN");
  await migrating.query(`LOCK TABLE ${schema}.schema_migrations IN ACCESS EXCLUSIVE MODE`);
  const began = Date.now();
  await assert.rejects(readStoreSchema("/nonexistent-data-dir", { ...process.env, AGENTRUN_STORE_SCHEMA: schema }, PG_URL), (error) => error.code === "55P03" || /lock timeout/i.test(error.message));
  const took = Date.now() - began;
  assert.ok(took >= STORE_SCHEMA_LOCK_MS - 200 && took < STORE_SCHEMA_LOCK_MS + 3_000, `gave up at its lock timeout: ${took} ms`);
  await migrating.query("ROLLBACK");
  assert.equal((await readStoreSchema("/nonexistent-data-dir", { ...process.env, AGENTRUN_STORE_SCHEMA: schema }, PG_URL)).schema, KNOWN, "and reads once the migration is done");
});

test("a floor read on a database that stopped answering gives up at its deadline, dropping its connection: the next read and the close are never held", ONLY, async (t) => {
  const { schema } = await schemaFor(t);
  await setUp(schema, []);
  const link = await stallingLink();
  t.after(() => link.close());
  const store = await openPostgresStore({ url: link.url, schema, role: "runner" });
  assert.equal((await store.schemaState()).version, KNOWN, "read through the link while it answers");
  link.stall();
  const began = Date.now();
  await assert.rejects(store.schemaState(), Unanswered);
  const took = Date.now() - began;
  assert.ok(took >= SCHEMA_STATE_MS - 100 && took < SCHEMA_STATE_MS + 2_000, `gave up at its deadline: ${took} ms`);
  // The close waits for every call in flight: none is left to hold it.
  const closing = Date.now();
  await store.close();
  assert.ok(Date.now() - closing < 5_000, `closed promptly: ${Date.now() - closing} ms`);
});

// Learning rows are runners-breaking: a runner of the release before them commits a run's learning to its git folder and
// settings keys, which this server neither reads nor purges, so it must never run beside this server's store. It is
// refused at its open, in words that name the floor, on either store.
test("the learning rows' migration (0032) is breaking for runners: a schema migrated through it refuses a runner that knows only the version before it", () => {
  const rows = migrationsIn().find((m) => m.version === ROWS);
  assert.equal(rows.breaking, true, `${String(ROWS).padStart(4, "0")}_${rows.name}.sql says "-- runners: breaking" in its leading comment`);
  const state = { version: ROWS, runnerFloor: floorAt(ROWS) };
  assert.equal(state.runnerFloor, ROWS);
  assert.equal(runnerOn(state, ROWS - 1), "refused");
  assert.throws(() => refuseBelowFloor("agentrun", state, ROWS - 1), (error) => error instanceof RunnerBelowFloor && error.floor === ROWS && error.message.includes(`must know version ${ROWS} or later`), "RunnerBelowFloor, naming the floor");
  assert.equal(runnerOn(state, ROWS), "opens", "this build's runner opens it");
});

// The ledger's re-record mark (0034) is breaking for runners; the workspace columns (0033) before it, the hooked firing
// column (0035) and the imported packages' workspace keys (0036, which no runner reads or writes) after it are additive:
// the floor this build's Postgres store holds is 0034, a runner that knows only 0033 is refused, and one that knows 0034
// or 0035 still opens a store at 0036.
test("the reopened-run ledger mark (0034) is breaking, the workspace columns (0033), the hooked firing column (0035) and the upload keys (0036) additive: this build's floor is 34", () => {
  const all = migrationsIn();
  const byName = (name) => all.find((m) => m.name === name);
  assert.deepEqual([byName("workspace")?.version, byName("workspace")?.breaking], [33, false], "0033_workspace.sql, additive");
  assert.deepEqual([byName("learning_ledger_rerecorded")?.version, byName("learning_ledger_rerecorded")?.breaking], [34, true], "0034_learning_ledger_rerecorded.sql, -- runners: breaking");
  assert.deepEqual([byName("trigger_firing_hooked")?.version, byName("trigger_firing_hooked")?.breaking], [35, false], "0035_trigger_firing_hooked.sql, additive");
  assert.deepEqual([byName("imported_templates_by_workspace")?.version, byName("imported_templates_by_workspace")?.breaking], [36, false], "0036_imported_templates_by_workspace.sql, additive");
  assert.deepEqual(all.slice(-2).map((m) => m.version), [35, 36], "0035 then 0036, in order");
  const latest = Math.max(...all.map((m) => m.version));
  assert.equal(latest, 36);
  const state = { version: latest, runnerFloor: floorAt(latest) };
  assert.equal(state.runnerFloor, 34);
  assert.equal(runnerOn(state, 33), "refused", "a runner that knows the workspace columns only");
  assert.equal(runnerOn(state, 34), "opens", "a runner that knows the ledger mark but not the hooked column opens it");
  assert.equal(runnerOn(state, 35), "opens", "a runner of the build before the upload keys opens it");
  assert.equal(runnerOn(state, 36), "opens", "this build's runner opens it");
});

test("on SQLite, this build's store is past the release before learning rows: its runner is refused, a later store's runner gets RunnerBelowFloor naming the floor, and an earlier store waits for its server", async (t) => {
  assert.ok(SCHEMA_VERSION > SQLITE_BEFORE_ROWS, `SCHEMA_VERSION (${SCHEMA_VERSION}) is past ${SQLITE_BEFORE_ROWS}, the version a runner before learning rows opens`);
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-skew-sqlite-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "store.sqlite");
  const server = await openSqliteStore({ file });
  const state = await server.schemaState();
  await server.close();
  assert.deepEqual([state.version, state.runnerFloor], [SCHEMA_VERSION, SCHEMA_VERSION]);
  assert.equal(runnerOn(state, SQLITE_BEFORE_ROWS), "refused", "a runner that knows the version before learning rows");
  // A later release's file: this build's runner is refused at its open, its words naming the floor.
  const raw = new DatabaseSync(file);
  raw.exec(`UPDATE store_meta SET schema_version = ${SCHEMA_VERSION + 1}`);
  raw.close();
  await assert.rejects(openSqliteStore({ file, role: "runner" }), (error) => error instanceof RunnerBelowFloor && error.floor === SCHEMA_VERSION + 1 && error.known === SCHEMA_VERSION && error.message.includes(`must know version ${SCHEMA_VERSION + 1} or later`) && error.message.includes(`this runner knows ${SCHEMA_VERSION}`));
  // The release before learning rows' file: a runner of this build waits for its server, which brings it to this version.
  const back = new DatabaseSync(file);
  back.exec(`UPDATE store_meta SET schema_version = ${SQLITE_BEFORE_ROWS}`);
  back.close();
  await assert.rejects(openSqliteStore({ file, role: "runner" }), (error) => error instanceof StoreAwaitsServer);
  const upgraded = await openSqliteStore({ file });
  assert.equal((await upgraded.schemaState()).version, SCHEMA_VERSION);
  await upgraded.close();
  const runner = await openSqliteStore({ file, role: "runner" });
  await runner.close();
});

test("a Postgres schema this build's server migrated through the learning rows refuses a runner of the release before them: RunnerBelowFloor at its open, naming the floor", ONLY, async (t) => {
  const { schema, sql } = await schemaFor(t);
  await migrate(sql, schema, Date.now(), migrationsIn().filter((m) => m.version < ROWS));
  const before = await runnerFloorOf(sql, schema);
  assert.equal(runnerOn(before, ROWS - 1), "opens", "the release before learning rows runs on its own schema");
  // Through the learning rows only: a later breaking migration raises the floor past them.
  await migrate(sql, schema, Date.now(), migrationsIn().filter((m) => m.version <= ROWS));
  const state = await runnerFloorOf(sql, schema);
  assert.equal(state.runnerFloor, ROWS, "the floor rose to the learning rows' migration");
  assert.throws(() => refuseBelowFloor(schema, state, ROWS - 1), (error) => error instanceof RunnerBelowFloor && error.floor === ROWS && error.message.includes(`must know version ${ROWS} or later`));
});
