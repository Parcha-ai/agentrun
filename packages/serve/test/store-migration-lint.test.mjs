// The migration lint: the server migrates first, under runners of the earlier release that keep running, so a Postgres
// migration is additive unless it says otherwise. Each shipped migration past LAST_UNMARKED that drops, renames, changes
// a column's type, makes a column NOT NULL or adds one NOT NULL with no default carries the `-- runners: breaking` header
// (migrate.ts RUNNERS_BREAKING), which raises the runner floor when it is applied; one that does not fails here, unless
// each such statement alters or drops a table its header names `-- runners: unaffected (...)`, which no runner names. The
// SQLite store has no migration files: its schema is built in code (schema.ts) and a SQLite runner opens only its own
// version (its floor is its version), so there is nothing of it to lint.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LAST_UNMARKED, marksBreaking, migrationsIn, RUNNERS_BREAKING } from "../dist/store/index.js";
import { breakingForRunners, breakingStatements, unaffectedTables } from "../dist/store/postgres/migration-lint.js";
import { buildSchema } from "../dist/store/store-schema.js";
import { SCHEMA_VERSION } from "../dist/store/schema.js";

const name = (m) => `${String(m.version).padStart(4, "0")}_${m.name}.sql`;

test("every shipped migration past LAST_UNMARKED that an earlier runner cannot run beside says so in its header", () => {
  const unmarked = migrationsIn()
    .filter((m) => m.version > LAST_UNMARKED && !m.breaking)
    .map((m) => ({ file: name(m), breaking: breakingForRunners(m.sql) }))
    .filter((m) => m.breaking.length > 0);
  assert.deepEqual(
    unmarked,
    [],
    unmarked
      .map((m) => `${m.file}: ${m.breaking.map((b) => `${b.why} (${b.statement})`).join("; ")}. Make it additive (the cleanup lands one release later), or put "${RUNNERS_BREAKING}" in its leading comment, which raises the runner floor to its version: every runner of an earlier build stops, hands its runs back and exits when it is applied.`)
      .join("\n"),
  );
});

/** Every source file of the runner (src/runner), by its path. */
function runnerSources(dir = fileURLToPath(new URL("../src/runner", import.meta.url))) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return runnerSources(path);
    return entry.name.endsWith(".ts") ? [[path, readFileSync(path, "utf8")]] : [];
  });
}

// A migration may alter or drop a table it names `-- runners: unaffected (...)` unmarked: that holds only while no runner
// code names the table, in SQL or as its store accessor (imported_templates, store.importedTemplates).
test("every table a migration names unaffected is one no runner code names", () => {
  const tables = [...new Set(migrationsIn().flatMap((m) => unaffectedTables(m.sql)))];
  assert.ok(tables.includes("imported_templates"), "0036 names imported_templates");
  const sources = runnerSources();
  assert.ok(sources.some(([path]) => path.endsWith("main.ts")), "the runner's sources are read");
  const named = tables.flatMap((table) => {
    const accessor = table.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    return sources.filter(([, text]) => text.includes(table) || text.includes(accessor)).map(([path]) => `${table}: ${path}`);
  });
  assert.deepEqual(named, [], "a runner names a table a migration altered unmarked: mark that migration breaking instead");
});

test("the unaffected header spares an ALTER or DROP of each table it names alone", () => {
  const sql = (header) => `${header}\n-- A step.\nALTER TABLE quiet DROP CONSTRAINT IF EXISTS quiet_pkey;\nALTER TABLE quiet ALTER COLUMN id SET NOT NULL;\nDROP INDEX IF EXISTS quiet_by_id;\nALTER TABLE runs DROP COLUMN labels;\nDROP TABLE quiet, runs;\n`;
  assert.deepEqual(unaffectedTables(sql("-- runners: unaffected (quiet, other_one)")), ["quiet", "other_one"]);
  assert.deepEqual(unaffectedTables(`-- A step.\nSELECT 1;\n-- runners: unaffected (quiet)\n`), [], "after a statement it names nothing");
  assert.deepEqual(unaffectedTables("-- runners: unaffected quiet\nSELECT 1;"), [], "the tables in parentheses, nothing else");
  assert.equal(breakingStatements(sql("-- runners: unaffected (quiet)")).length, 5);
  assert.deepEqual(
    breakingForRunners(sql("-- runners: unaffected (quiet)")).map((b) => b.statement),
    ["DROP INDEX IF EXISTS quiet_by_id", "ALTER TABLE runs DROP COLUMN labels", "DROP TABLE quiet, runs"],
    "an index drop (an earlier runner's ON CONFLICT may name it), another table, and a drop of more than one stay breaking",
  );
  assert.equal(breakingForRunners(sql("-- A step with no header.")).length, 5);
});

test("0023, the first migration past LAST_UNMARKED, is additive: a nullable column, and a NOT NULL one with a default and a CHECK", () => {
  const m = migrationsIn().find((each) => each.version === 23);
  assert.ok(m && m.version === LAST_UNMARKED + 1, "0023 is the first the lint reads");
  assert.deepEqual(breakingStatements(m.sql), [], name(m));
  assert.equal(m.breaking, false, "and it carries no header");
});

test("no migration up to LAST_UNMARKED carries the header: the rule starts after them, and each of them counts as breaking", () => {
  const shipped = migrationsIn();
  assert.ok(shipped.length >= LAST_UNMARKED, "the unmarked ones ship");
  assert.deepEqual(shipped.filter((m) => m.version <= LAST_UNMARKED && m.breaking).map(name), []);
  // The lint would have caught the earlier history's destructive steps: 0020 renames the table runners kept their relay
  // in, and 0011 drops the table of each run's MCP pins.
  assert.ok(breakingStatements(shipped[19].sql).some((b) => /RENAME TO runners/i.test(b.statement)), name(shipped[19]));
  assert.ok(breakingStatements(shipped[10].sql).some((b) => /DROP TABLE IF EXISTS mcp_pins/i.test(b.statement)), name(shipped[10]));
  // And passes their additive ones: a nullable column with a CHECK that reads IS NOT NULL (0015), a trigger rebuilt.
  assert.deepEqual(breakingStatements(shipped[14].sql), [], name(shipped[14]));
});

test("the lint finds a drop, a rename, a type change, a column made NOT NULL and a NOT NULL column with no default", () => {
  const found = (sql) => breakingStatements(sql).map((b) => b.why);
  for (const sql of [
    "DROP TABLE runner_relays;",
    "DROP INDEX IF EXISTS runs_listing;",
    "ALTER TABLE runs DROP COLUMN labels;",
    "ALTER TABLE runs DROP CONSTRAINT runs_state_check;",
    "ALTER TABLE runs ALTER COLUMN labels DROP DEFAULT;",
    "ALTER TABLE runs RENAME COLUMN labels TO tags;",
    "ALTER TABLE runs RENAME TO jobs;",
    "ALTER TABLE runs ALTER COLUMN cost TYPE NUMERIC;",
    "ALTER TABLE runs ALTER cost SET DATA TYPE NUMERIC USING cost::numeric;",
    "ALTER TABLE runs ALTER COLUMN labels SET NOT NULL;",
    "ALTER TABLE runs ADD COLUMN attempt BIGINT NOT NULL;",
    "ALTER TABLE runs ADD attempt BIGINT NOT NULL;",
    "ALTER TABLE runs ADD COLUMN note TEXT, ADD COLUMN attempt BIGINT NOT NULL CHECK (attempt >= 0);",
    // A primary key makes its columns NOT NULL; ON DELETE SET DEFAULT is no default of the column's own.
    "ALTER TABLE runs ADD PRIMARY KEY (note);",
    "ALTER TABLE runs ADD CONSTRAINT runs_note_key PRIMARY KEY (note);",
    "ALTER TABLE events ADD COLUMN sequence BIGINT PRIMARY KEY;",
    "ALTER TABLE runs ADD COLUMN owner_id BIGINT NOT NULL REFERENCES owners (id) ON DELETE SET DEFAULT;",
    // A dollar-quoted body whose tag holds a digit is still a body, and a statement after it still read.
    "DO $fn1$ BEGIN PERFORM 1; END $fn1$; ALTER TABLE runs DROP COLUMN labels;",
  ]) {
    assert.ok(found(sql).length > 0, `found in: ${sql}`);
  }
});

test("the lint passes additive steps, and reads no comment or string as a statement", () => {
  for (const sql of [
    "CREATE TABLE extra (id TEXT PRIMARY KEY, n BIGINT NOT NULL);",
    "CREATE INDEX IF NOT EXISTS extra_n ON extra (n);",
    "ALTER TABLE computer_intervals ADD COLUMN IF NOT EXISTS booked_ms BIGINT NOT NULL DEFAULT 0 CHECK (booked_ms >= 0);",
    "ALTER TABLE runs ADD COLUMN note TEXT;",
    "ALTER TABLE runs ADD COLUMN made BIGINT NOT NULL GENERATED ALWAYS AS (0) STORED;",
    "ALTER TABLE events ADD COLUMN sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY;",
    "ALTER TABLE runs ALTER COLUMN labels DROP NOT NULL;",
    "ALTER TABLE runs ADD CONSTRAINT runs_note_check CHECK (note <> '');",
    "-- this file does not drop or rename anything\nUPDATE store_meta SET schema_version = 24 WHERE singleton = 1;",
    "/* DROP TABLE runs; */ SELECT 1;",
    "DO $fn1$ BEGIN PERFORM 1; END $fn1$;",
    "UPDATE commands SET refused = 'drop it: renamed type' WHERE id = 1;",
    "DO $$ BEGIN PERFORM 1; END $$;",
    "ALTER TABLE runs ADD COLUMN IF NOT EXISTS labels TEXT CHECK (labels IS NULL OR labels IS NOT NULL);",
    "DROP TRIGGER IF EXISTS runs_changed ON runs;",
    "ALTER TABLE runs ADD COLUMN note TEXT CHECK (note IS NULL OR (note IS NOT NULL AND length(note) > 0));",
  ]) {
    assert.deepEqual(breakingStatements(sql), [], sql);
  }
});

test("the header is a line of the migration's leading comment, nowhere else", () => {
  assert.equal(marksBreaking(`-- The store's schema, version 30.\n${RUNNERS_BREAKING}\n\nDROP TABLE x;`), true);
  assert.equal(marksBreaking(`\n${RUNNERS_BREAKING}\nDROP TABLE x;`), true);
  assert.equal(marksBreaking(`-- The store's schema, version 30.\nDROP TABLE x;\n${RUNNERS_BREAKING}\n`), false, "after a statement it marks nothing");
  assert.equal(marksBreaking("-- runners: breaking soon\nDROP TABLE x;"), false, "the line itself, nothing more");
  assert.equal(marksBreaking("-- The store's schema.\nCREATE TABLE x (id TEXT);"), false);
});

test("store-schema --build says the versions this build knows, from its own files, with no store", () => {
  assert.deepEqual(buildSchema(), { postgres: migrationsIn().at(-1).version, sqlite: SCHEMA_VERSION });
});

// Postgres reads a function body between a pair of `$tag$` delimiters (`$$` with no tag). A lone `$` is a syntax error
// that only a Postgres migrate run shows, and every Postgres-backed server then fails to start on it (0027 once shipped
// to CI as `AS $` ... `$;`). Outside comments, every `$` but a `$1` parameter is part of a delimiter, in pairs.
test("every shipped Postgres migration quotes its function bodies in matched $tag$ pairs, with no lone $", () => {
  const bad = [];
  for (const m of migrationsIn()) {
    const code = m.sql.replace(/--[^\n]*/g, "").replace(/\$\d+/g, "");
    const tags = new Map();
    const rest = code.replace(/\$([A-Za-z_]\w*)?\$/g, (tag) => {
      tags.set(tag, (tags.get(tag) ?? 0) + 1);
      return "";
    });
    if (rest.includes("$")) bad.push(`${name(m)}: a lone $`);
    for (const [tag, count] of tags) if (count % 2 !== 0) bad.push(`${name(m)}: ${tag} opens ${count} times, unmatched`);
  }
  assert.deepEqual(bad, []);
});

// A store whose record of a migration is gone has it applied again on a schema it already changed (store-postgres.test.mjs
// from 0003, store-trigger-template.test.mjs, run-census.test.mjs), so each migration from RUNS_AGAIN_FROM runs twice
// unharmed (0020 renames a table, so those tests drop its result by hand; each one after is written to run again). Read
// from each file's statements outside its dollar-quoted bodies, by pattern: a statement Postgres can't guard (ADD
// CONSTRAINT, CREATE TYPE) belongs in a DO body, and a body's own guard is not proven, only that one is named where it
// reads a column the file drops. A data UPDATE is not judged: each one here is written to land the same rows again.
const RUNS_AGAIN_FROM = 21;
/** What in `sql` would fail, or change data again, on a schema it already brought to its version. */
function notRunnableTwice(sql) {
  const code = sql.replace(/--[^\n]*/g, "");
  const bodies = [];
  const outside = code.replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, (body) => (bodies.push(body), " "));
  const statements = outside.split(";").map((one) => one.replace(/\s+/g, " ").trim()).filter(Boolean);
  const bad = [];
  for (const statement of statements) {
    if (/\bCREATE (UNIQUE )?INDEX\b(?! IF NOT EXISTS)/i.test(statement) || /\bCREATE TABLE\b(?! IF NOT EXISTS)/i.test(statement)) bad.push(`made with no IF NOT EXISTS: ${statement}`);
    if (/\bADD COLUMN\b(?! IF NOT EXISTS)/i.test(statement)) bad.push(`a column added with no IF NOT EXISTS: ${statement}`);
    if (/\bDROP (TABLE|INDEX|COLUMN|TRIGGER|FUNCTION|CONSTRAINT)\b(?! IF EXISTS)/i.test(statement)) bad.push(`dropped with no IF EXISTS: ${statement}`);
    if (/\bCREATE SEQUENCE\b(?! IF NOT EXISTS)/i.test(statement)) bad.push(`made with no IF NOT EXISTS: ${statement}`);
    if (/\bCREATE FUNCTION\b/i.test(statement)) bad.push(`a function made with no OR REPLACE: ${statement}`);
    if (/\bCREATE VIEW\b/i.test(statement)) bad.push(`a view made with no OR REPLACE: ${statement}`);
    if (/\bADD CONSTRAINT\b/i.test(statement) || /\bCREATE TYPE\b/i.test(statement)) bad.push(`made with no guard Postgres takes (a DO body that finds it first): ${statement}`);
    if (/\bINSERT INTO\b/i.test(statement) && !/\bON CONFLICT\b/i.test(statement)) bad.push(`an insert with no ON CONFLICT: ${statement}`);
    if (/\bRENAME\b/i.test(statement)) bad.push(`a rename: ${statement}`);
    const trigger = /\bCREATE TRIGGER (\w+)/i.exec(statement)?.[1];
    if (trigger && !statements.some((one) => new RegExp(`^DROP TRIGGER IF EXISTS ${trigger}\\b`, "i").test(one))) bad.push(`a trigger made with no DROP TRIGGER IF EXISTS before it: ${statement}`);
  }
  // A column it drops is read before by a statement only in a body that finds the column first (a DO block over
  // information_schema.columns): run again, the column is gone.
  for (const [, column] of outside.matchAll(/\bDROP COLUMN (?:IF EXISTS )?(\w+)/gi)) {
    const names = new RegExp(`\\b${column}\\b`, "i");
    for (const statement of statements) if (names.test(statement) && !/\bDROP COLUMN\b/i.test(statement)) bad.push(`reads ${column}, which it drops, unguarded: ${statement}`);
    for (const body of bodies) if (names.test(body) && !new RegExp(`column_name = '${column}'`).test(body)) bad.push(`a body reads ${column}, which it drops, without finding it first`);
  }
  return bad;
}

test("every shipped Postgres migration from 0021 on runs again unharmed on a schema it already changed: each thing it makes or drops only where missing or there, and a column it drops read only while it is there", () => {
  const bad = migrationsIn().filter((m) => m.version >= RUNS_AGAIN_FROM).flatMap((m) => notRunnableTwice(m.sql).map((why) => `${name(m)}: ${why}`));
  assert.deepEqual(bad, []);
});

test("the run-again check finds a read of a dropped column outside its guard, each make or drop with no guard, a constraint or type made outside a DO body, and an insert with no ON CONFLICT", () => {
  const reads = "DELETE FROM learning_ledger l WHERE l.epoch <> 0;\nALTER TABLE learning_ledger DROP COLUMN IF EXISTS epoch;";
  assert.equal(notRunnableTwice(reads).length, 1, reads);
  const unchecked = "DO $$ BEGIN EXECUTE $q$DELETE FROM learning_ledger WHERE epoch <> 0$q$; END $$;\nALTER TABLE learning_ledger DROP COLUMN IF EXISTS epoch;";
  assert.equal(notRunnableTwice(unchecked).length, 1, unchecked);
  const guarded = "DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE column_name = 'epoch') THEN EXECUTE $q$DELETE FROM learning_ledger WHERE epoch <> 0$q$; END IF; END $$;\nALTER TABLE learning_ledger DROP COLUMN IF EXISTS epoch;";
  assert.deepEqual(notRunnableTwice(guarded), [], guarded);
  for (const sql of ["ALTER TABLE t DROP COLUMN c;", "CREATE INDEX i ON t (c);", "CREATE UNIQUE INDEX i ON t (c);", "CREATE TABLE t (c TEXT);", "ALTER TABLE t ADD COLUMN c TEXT;", "DROP TRIGGER x ON t;", "CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;", "CREATE TRIGGER x BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION f();", "ALTER TABLE t RENAME TO u;",
    "ALTER TABLE t ADD CONSTRAINT t_c CHECK (c <> '');", "CREATE TYPE k AS ENUM ('a');", "CREATE SEQUENCE s;", "CREATE VIEW v AS SELECT 1;", "INSERT INTO t (c) VALUES ('a');"]) {
    assert.ok(notRunnableTwice(sql).length > 0, sql);
  }
  for (const sql of ["INSERT INTO t (c) VALUES ('a') ON CONFLICT DO NOTHING;", "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 't_c') THEN ALTER TABLE t ADD CONSTRAINT t_c CHECK (c <> ''); END IF; END $$;",
    "CREATE SEQUENCE IF NOT EXISTS s;", "CREATE OR REPLACE VIEW v AS SELECT 1;", "DROP TRIGGER IF EXISTS x ON t;\nCREATE TRIGGER x BEFORE INSERT OR UPDATE ON t FOR EACH ROW EXECUTE FUNCTION f();"]) {
    assert.deepEqual(notRunnableTwice(sql), [], sql);
  }
});
