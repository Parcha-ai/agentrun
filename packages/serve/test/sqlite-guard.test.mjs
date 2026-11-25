// The guard (fixtures/sqlite-guard.mjs): a DatabaseSync that could write the store a live serve() owns throws, so a test's
// write there goes through raw() (store-target.mjs) off the thread the server commits from.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { GUARD_MESSAGE } from "./fixtures/sqlite-guard.mjs";
import { serve } from "./support.mjs";
import { raw } from "./store-target.mjs";

const refused = (error) => error.message.startsWith(GUARD_MESSAGE) && /raw\(\) \(store-target\.mjs\)/.test(error.message);

test("the guard is installed in this process: node:sqlite in a test is the guarded one (run the suite with npm test, or node --import=./test/fixtures/sqlite-guard-register.mjs --test)", () => {
  assert.equal(DatabaseSync.guarded, true);
});

test("the package's test script and the Postgres runner load the guard in every test process", () => {
  const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
  assert.match(JSON.parse(read("../package.json")).scripts.test, /^node --test (?:\S+ )*--import=\.\/test\/fixtures\/sqlite-guard-register\.mjs /);
  assert.match(read("../scripts/test-pg.mjs"), /spawnSync\(process\.execPath, \["--import=\.\/test\/fixtures\/sqlite-guard-register\.mjs", "--test"/);
});

test("a DatabaseSync that is not readOnly on a live server's store throws, saying to use raw()", async (t) => {
  const { data } = await serve(t, { runner: false });
  const file = join(data, "store.sqlite");
  assert.throws(() => new DatabaseSync(file), refused);
  assert.throws(() => new DatabaseSync(file, { timeout: 10_000 }), refused);
  assert.throws(() => new DatabaseSync(file, { readOnly: false }), refused);
  assert.throws(() => new DatabaseSync(new URL(`file://${file}`)), refused);
});

test("a readOnly DatabaseSync on a live server's store opens", async (t) => {
  const { data } = await serve(t, { runner: false });
  const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true });
  try {
    assert.ok(db.prepare("SELECT 1 AS one").get().one === 1);
  } finally {
    db.close();
  }
});

test("a server's store once it has closed opens for writing again, and a store no server owns always does", async (t) => {
  const server = await serve(t, { runner: false });
  const file = join(server.data, "store.sqlite");
  assert.throws(() => new DatabaseSync(file), refused);
  await server.stop();
  new DatabaseSync(file).close();
  new DatabaseSync(":memory:").close();
});

test("raw() writes a live server's store", async (t) => {
  const { data } = await serve(t, { runner: false });
  const db = await raw(join(data, "store.sqlite"), { timeout: 10_000 });
  try {
    await db.exec("CREATE TABLE guard_probe (n INTEGER)");
    assert.deepEqual(await db.run("INSERT INTO guard_probe VALUES (1)"), { changes: 1 });
    assert.deepEqual(await db.all("SELECT n FROM guard_probe"), [{ n: 1 }]);
  } finally {
    await db.close();
  }
});
