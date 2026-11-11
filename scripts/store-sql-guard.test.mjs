// Only the store knows SQL, pragmas or a file (design 2.1): SQL and PRAGMA live in packages/serve/src/store/ and nowhere
// else in the packages' and apps' source. Today's files that still hold SQL are listed by name; the cutover deletes or moves
// each one, and the list only shrinks: a listed file with no SQL left fails until it is taken off the list. The same for
// a .sqlite file name: only the store picks its file in the data directory it is given.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { driversIn, sqlIn } from "./store-guard.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STORE = "packages/serve/src/store/";
/** The files outside the store that held SQL when the store landed. Each goes at the cutover. */
const TODAY = [
  "packages/serve/src/agents.ts",
  "packages/serve/src/cap.ts",
  "packages/serve/src/import-summary.ts",
  "packages/serve/src/run-db.ts",
  "packages/serve/src/server-lock.ts",
  // The copy of pi/src/durable/readers.ts serve runs (its workflow code moved into serve; pi's copy goes with pi).
  "packages/serve/src/workflow/readers.ts",
];
/** A SQLite file named in source: only the store picks its file (a data directory is all anyone else passes). */
const SQLITE_FILE = /\.sqlite\b/;
/** The files outside the store that named a .sqlite file when the store took its data directory. Each goes at the
 *  cutover; the list only shrinks. */
const TODAY_FILE = [
  "packages/serve/src/agents.ts",
  "packages/serve/src/import.ts",
  "packages/serve/src/run-db.ts",
  "packages/serve/src/server.ts",
  "packages/serve/src/stats.ts",
  "packages/serve/src/tool-plane.ts",
  "packages/serve/src/webhooks.ts",
];

/** Every .ts/.mts/.js/.mjs file under `dir`, relative to the repository, skipping node_modules and dist. */
function sources(dir) {
  const out = [];
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      if (name === "node_modules" || name === "dist") continue;
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(?:ts|mts|tsx|js|mjs)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(relative(ROOT, path));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

const roots = [...readdirSync(join(ROOT, "packages")).map((name) => join(ROOT, "packages", name, "src")), ...(existsSync(join(ROOT, "apps")) ? readdirSync(join(ROOT, "apps")).map((name) => join(ROOT, "apps", name, "src")) : [])];
const withSql = roots.flatMap(sources).filter((file) => sqlIn(readFileSync(join(ROOT, file), "utf8"), file));

// Each form of SQL the guard must see in a source file's strings, whatever its case, spacing or quoting.
const SQL_FORMS = {
  "lowercase": `const q = "select id from runs";`,
  "a template-literal table name": "const q = `UPDATE ${T.runs} SET state = ?`;",
  "a quoted table name": `const q = 'UPDATE "runs" SET state = ?';`,
  "a statement over two lines": "const q = `UPDATE runs\n  SET state = ?`;",
  "two spaces": `const q = "INSERT  INTO runs (id) VALUES (?)";`,
  "REPLACE INTO": `const q = "REPLACE INTO runs (id) VALUES (?)";`,
  "ALTER TABLE": `const q = "ALTER TABLE runs ADD COLUMN x TEXT";`,
  "DROP TABLE": `const q = "DROP TABLE runs";`,
  "a quote before FROM": `const q = "SELECT json_extract(body, '$.a') FROM runs";`,
};
for (const [form, source] of Object.entries(SQL_FORMS)) {
  test(`the guard sees SQL written with ${form}`, () => {
    assert.equal(sqlIn(source), true, source);
  });
}

test("the guard reads strings, not comments: prose that says select or update in a comment is no SQL", () => {
  assert.equal(sqlIn("// select a model from the list, then update the run's settings\nconst x = 1;"), false);
});

// Each way a file can take a SQLite driver, which only the store may.
const DRIVER_FORMS = {
  "node:sqlite": [`import { DatabaseSync } from "node:sqlite";`, "node:sqlite"],
  "better-sqlite3": [`import Database from "better-sqlite3";`, "better-sqlite3"],
  "chord's sqlite": [`import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite";`, "@earendil-works/chord/sqlite"],
  "pi's SqliteStorage": [`import { SqliteStorage } from "@earendil-works/pi-durable";`, "@earendil-works/pi-durable SqliteStorage"],
  "a dynamic import": [`const { DatabaseSync } = await import("node:sqlite");`, "node:sqlite"],
  "a require": [`const Database = require("better-sqlite3");`, "better-sqlite3"],
  "chord's node opener (a subpath)": [`import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";`, "@earendil-works/chord/sqlite/node"],
  "pi-durable's node SQLite storage (a subpath)": [`import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";`, "@earendil-works/pi-durable/storage/sqlite/node"],
  "pi-durable's SQLite module, any name": [`import { NodeSqliteDatabase, applySqliteMigrations } from "@earendil-works/pi-durable/storage/sqlite";`, "@earendil-works/pi-durable/storage/sqlite"],
  "a namespace import of pi-durable": [`import * as durable from "@earendil-works/pi-durable";\nconst storage = new durable.SqliteStorage(db);`, "@earendil-works/pi-durable SqliteStorage"],
  "a dynamic import of pi-durable": [`const durable = await import("@earendil-works/pi-durable");\nconst storage = new durable.SqliteStorage(db);`, "@earendil-works/pi-durable SqliteStorage"],
  "a dynamic import of pi-durable, destructured": [`const { SqliteStorage } = await import("@earendil-works/pi-durable");`, "@earendil-works/pi-durable SqliteStorage"],
  "createRequire, called at once": [`const sqlite = createRequire(import.meta.url)("node:sqlite");`, "node:sqlite"],
  "createRequire, through a named require": [`const load = createRequire(import.meta.url);\nconst sqlite = load("node:sqlite");`, "node:sqlite"],
  "a renamed createRequire": [`import { createRequire as makeRequire } from "node:module";\nconst sqlite = makeRequire(import.meta.url)("node:sqlite");`, "node:sqlite"],
  "a renamed createRequire, through a named require": [`import { createRequire as makeRequire } from "node:module";\nconst load = makeRequire(import.meta.url);\nconst sqlite = load("node:sqlite");`, "node:sqlite"],
  "createRequire off a namespace import of node:module": [`import * as mod from "node:module";\nconst sqlite = mod.createRequire(import.meta.url)("node:sqlite");`, "node:sqlite"],
  "a bracket read of SqliteStorage off a namespace import": [`import * as durable from "@earendil-works/pi-durable";\nconst storage = new durable["SqliteStorage"](db);`, "@earendil-works/pi-durable SqliteStorage"],
  "a bracket read of SqliteStorage off an import()": [`const durable = await import("@earendil-works/pi-durable");\nconst storage = new durable[\`SqliteStorage\`](db);`, "@earendil-works/pi-durable SqliteStorage"],
};
for (const [form, [source, driver]] of Object.entries(DRIVER_FORMS)) {
  test(`the guard sees a SQLite driver taken by ${form}`, () => {
    assert.deepEqual(driversIn(source), [driver], source);
  });
}

// A type is no driver: a file that only names a driver's types opens nothing.
const TYPE_ONLY = {
  "import type": `import type { SqliteDatabase } from "@earendil-works/chord/sqlite";`,
  "an inline type import": `import { type SqliteDatabase } from "@earendil-works/chord/sqlite";`,
  "export type": `export type { SqliteStorage } from "@earendil-works/pi-durable";`,
};
for (const [form, source] of Object.entries(TYPE_ONLY)) {
  test(`the guard takes no driver from ${form}`, () => {
    assert.deepEqual(driversIn(source), [], source);
  });
}

test("the store holds the SQL: its SQLite adapter and its schema", () => {
  const inStore = withSql.filter((file) => file.startsWith(STORE));
  for (const file of [`${STORE}schema.ts`, `${STORE}sqlite/store.ts`]) assert.ok(inStore.includes(file), `${file} holds the store's SQL (found: ${JSON.stringify(inStore)})`);
});

test("no SQL or PRAGMA outside the store, but for today's files on the list", () => {
  const outside = withSql.filter((file) => !file.startsWith(STORE));
  assert.deepEqual(outside.filter((file) => !TODAY.includes(file)), [], "SQL outside packages/serve/src/store/: move it behind the Store interface");
});

test("the list only shrinks: a listed file with no SQL left is taken off it", () => {
  assert.deepEqual(TODAY.filter((file) => !withSql.includes(file)), [], "these hold no SQL now: take them off TODAY");
});

const withDriver = roots.flatMap(sources).filter((file) => driversIn(readFileSync(join(ROOT, file), "utf8"), file).length > 0);
/** The files outside the store that took a SQLite driver when the guard began reading imports. Each goes at the cutover;
 *  the list only shrinks. One file joined it after: pi/src/durable/readers.ts loads node:sqlite through createRequire,
 *  which the guard first saw when it learnt that form. */
const TODAY_DRIVER = [
  "packages/serve/src/agents.ts",
  "packages/serve/src/run-db.ts",
  "packages/serve/src/server-lock.ts",
  // The copy of pi/src/durable/readers.ts serve runs, as on TODAY.
  "packages/serve/src/workflow/readers.ts",
];

test("no SQLite driver taken outside the store, but for today's files on the list", () => {
  const outside = withDriver.filter((file) => !file.startsWith(STORE));
  assert.deepEqual(outside.filter((file) => !TODAY_DRIVER.includes(file)), [], "a SQLite driver taken outside packages/serve/src/store/: go through the Store interface");
});

test("the driver list only shrinks: a listed file that takes no driver is taken off it", () => {
  assert.deepEqual(TODAY_DRIVER.filter((file) => !withDriver.includes(file)), [], "these take no driver now: take them off TODAY_DRIVER");
});

const withFile = roots.flatMap(sources).filter((file) => SQLITE_FILE.test(readFileSync(join(ROOT, file), "utf8")));

test("the store names its own file: its SQLite adapter picks it in the data directory", () => {
  assert.ok(withFile.includes(`${STORE}sqlite/store.ts`), `${STORE}sqlite/store.ts names the store's file (found: ${JSON.stringify(withFile.filter((file) => file.startsWith(STORE)))})`);
});

test("no .sqlite file named outside the store, but for today's files on the list", () => {
  const outside = withFile.filter((file) => !file.startsWith(STORE));
  assert.deepEqual(outside.filter((file) => !TODAY_FILE.includes(file)), [], "a .sqlite file named outside packages/serve/src/store/: pass the data directory to openSqliteStore instead");
});

test("the file list only shrinks: a listed file that names no .sqlite file is taken off it", () => {
  assert.deepEqual(TODAY_FILE.filter((file) => !withFile.includes(file)), [], "these name no .sqlite file now: take them off TODAY_FILE");
});
