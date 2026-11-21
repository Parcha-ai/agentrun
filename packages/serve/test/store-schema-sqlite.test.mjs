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
const { SQLITE_RUNNER_NEEDS, STORE_FILE } = await import("../dist/store/sqlite/store.js");
const { readStoreSchema } = await import("../dist/store/store-schema.js");
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
    // An earlier build of this version left the file without the column; runners, without the table (its relay was in
    // runner_relays then), which the server makes at its start.
    const db = new DatabaseSync(join(dir, STORE_FILE));
    if (need.table === "runners") db.exec("DROP TABLE runners");
    else for (const column of need.columns) {
      for (const { name } of db.prepare(`SELECT name FROM pragma_index_list('${need.table}')`).all()) {
        if (db.prepare(`SELECT 1 FROM pragma_index_info('${name}') WHERE name = ?`).get(column) && !name.startsWith("sqlite_autoindex")) db.exec(`DROP INDEX "${name}"`);
      }
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
  assert.ok(said.length >= SQLITE_RUNNER_NEEDS.length, `the open's waits: ${said.join(" | ")}`);
  const listed = new Set(SQLITE_RUNNER_NEEDS.map((need) => need.why));
  assert.deepEqual(said.filter((why) => !listed.has(why)), [], "each is listed");
});
