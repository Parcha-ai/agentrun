// store-schema on SQLite (store/store-schema.ts): a file at this build's version that an earlier build of the same
// version left without a column this build's runner needs (sqlite/store.ts SQLITE_RUNNER_NEEDS) reads "waits", as the
// runner's own open refuses it until the server adds the column; and every wait the runner's open says is on that list.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { openSqliteStore, StoreAwaitsServer } = await import("../dist/store/index.js");
const { OLDEST_UPGRADED, SQLITE_RUNNER_NEEDS, SQLITE_UPGRADES, STORE_FILE } = await import("../dist/store/sqlite/store.js");
const { readStoreSchema, storeSchemaReport } = await import("../dist/store/store-schema.js");
const { SCHEMA_VERSION } = await import("../dist/store/schema.js");

const sqliteEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "AGENTRUN_STORE_URL"));

async function serverMade(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-store-schema-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await (await openSqliteStore({ dataDir: dir, role: "server" })).close();
  return dir;
}

test("on a file this build's server set up, store-schema says its server and runner open it", async (t) => {
  const dir = await serverMade(t);
  const report = await readStoreSchema(dir, sqliteEnv);
  assert.deepEqual([report.store, report.schema, report.runnerFloor, report.build, report.server, report.runner], ["sqlite", SCHEMA_VERSION, SCHEMA_VERSION, SCHEMA_VERSION, "opens", "opens"]);
});

for (const need of SQLITE_RUNNER_NEEDS) {
  test(`a file of this version without ${need.table}.${need.columns.join(", ")}: store-schema says the runner waits, as its open refuses it`, async (t) => {
    const dir = await serverMade(t);
    // An earlier build of this version left the file without the column; without the runners table (its relay was in
    // runner_relays then), hand_backs, run_attempts, the learning ledger or learning_saves, which the server makes at its start.
    const db = new DatabaseSync(join(dir, STORE_FILE));
    if (need.columns.includes("host") || ["hand_backs", "run_attempts", "learning_ledger", "learning_spend", "learning_saves"].includes(need.table)) db.exec(`DROP TABLE ${need.table}`);
    else for (const column of need.columns) {
      for (const { name } of db.prepare(`SELECT name FROM pragma_index_list('${need.table}')`).all()) {
        if (db.prepare(`SELECT 1 FROM pragma_index_info('${name}') WHERE name = ?`).get(column) && !name.startsWith("sqlite_autoindex")) db.exec(`DROP INDEX "${name}"`);
      }
      // A trigger that names the column came with it (schema.ts RUN_LAUNCH_CENSUS_ERASED): an earlier build had none.
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'run_launch_census_erased' AND tbl_name = ? AND sql LIKE ?").all(need.table, `%${column}%`)) db.exec(`DROP TRIGGER "${name}"`);
      db.exec(`ALTER TABLE ${need.table} DROP COLUMN ${column}`);
    }
    db.close();
    const report = await readStoreSchema(dir, sqliteEnv);
    assert.deepEqual([report.schema, report.server, report.runner], [SCHEMA_VERSION, "opens", "waits"], JSON.stringify(report));
    await assert.rejects(openSqliteStore({ dataDir: dir, role: "runner" }), (error) => {
      assert.ok(error instanceof StoreAwaitsServer, String(error));
      assert.match(error.message, new RegExp(`to ${need.why.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} before opening a runner`));
      return true;
    });
    // Its server adds it at its start; then both open.
    await (await openSqliteStore({ dataDir: dir, role: "server" })).close();
    assert.equal((await readStoreSchema(dir, sqliteEnv)).runner, "opens");
  });
}

test("every wait the SQLite runner's open says for a column is on SQLITE_RUNNER_NEEDS, so store-schema reads them all", () => {
  const source = readFileSync(new URL("../src/store/sqlite/store.ts", import.meta.url), "utf8");
  const said = [...source.matchAll(/new StoreAwaitsServer\((?:"([^"]*)"|'([^']*)')\)/g)].map((match) => match[1] ?? match[2]);
  const listed = new Set(SQLITE_RUNNER_NEEDS.map((need) => need.why));
  assert.ok(said.length >= listed.size, `the open's waits: ${said.join(" | ")}`);
  assert.deepEqual(said.filter((why) => !listed.has(why)), [], "each is listed");
});

test("on SQLite, a runner waits only for a version its server upgrades in place (SQLITE_UPGRADES: 11 to the one before this build's); any other earlier one, and a later one, is refused", () => {
  const target = { kind: "sqlite", dataDir: "/data" };
  const verdict = (version) => {
    const report = storeSchemaReport(target, { version, runnerFloor: version }, SCHEMA_VERSION);
    return [report.server, report.runner];
  };
  assert.deepEqual([...SQLITE_UPGRADES], Array.from({ length: SCHEMA_VERSION - OLDEST_UPGRADED }, (_, i) => OLDEST_UPGRADED + i), "every version from OLDEST_UPGRADED to the one before this build's");
  assert.deepEqual([OLDEST_UPGRADED, SCHEMA_VERSION], [11, 17], "11 is still upgraded, and 16 (the ledger's epoch dropped) is in the window");
  assert.deepEqual(verdict(10), ["refuses", "refused"], "10: no in-place upgrade, so neither waits on it");
  for (const version of SQLITE_UPGRADES) assert.deepEqual(verdict(version), ["migrates", "waits"], String(version));
  assert.deepEqual(verdict(SCHEMA_VERSION), ["opens", "opens"]);
  assert.deepEqual(verdict(SCHEMA_VERSION + 1), ["refuses", "refused"], "a later server's file");
  assert.deepEqual(verdict(null), ["sets up", "refused"]);
});

// The two steps the last two versions take, in order: a 15 store's ledger keeps each row's epoch, which ledgerUpgrade
// drops (writing 16); then learningRowsUpgrade makes the learning rows and writes 17. A 16 store takes the rows step alone.
// A runner of this build waits on either until its server has brought it to this version.
for (const from of [15, 16]) test(`a store at version ${from} comes to ${SCHEMA_VERSION} at its server's open, never at a runner's: ${from === 15 ? "the ledger's epoch dropped, then the learning rows made" : "the learning rows made"}`, async (t) => {
  assert.equal(SCHEMA_VERSION, 17);
  const dir = await serverMade(t);
  const file = join(dir, STORE_FILE);
  const db = new DatabaseSync(file);
  for (const table of ["learning_records", "learning_items", "learning_saves"]) db.exec(`DROP TABLE ${table}`);
  if (from === 15) db.exec("ALTER TABLE learning_ledger ADD COLUMN epoch INTEGER");
  db.exec(`UPDATE store_meta SET schema_version = ${from} WHERE singleton = 1`);
  db.close();
  assert.deepEqual((await readStoreSchema(dir, sqliteEnv)).runner, "waits");
  await assert.rejects(openSqliteStore({ dataDir: dir, role: "runner" }), (error) => error instanceof StoreAwaitsServer && error.message.includes(`from version ${from} to ${SCHEMA_VERSION}`));
  await (await openSqliteStore({ dataDir: dir, role: "server" })).close();
  const after = new DatabaseSync(file, { readOnly: true });
  t.after(() => after.close());
  assert.equal(after.prepare("SELECT schema_version AS v FROM store_meta").get().v, SCHEMA_VERSION, "the rows step ran last: it writes 17 after the ledger's 16");
  const tables = new Set(after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  assert.deepEqual(["learning_saves", "learning_items", "learning_records"].filter((table) => !tables.has(table)), [], "the learning rows are made");
  assert.equal(after.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('learning_ledger') WHERE name = 'epoch'").get().n, 0, "no ledger row keeps an epoch");
  assert.equal((await readStoreSchema(dir, sqliteEnv)).runner, "opens");
});
