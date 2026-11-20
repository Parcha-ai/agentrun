// The migration lint: the server migrates first, under runners of the earlier release that keep running, so a Postgres
// migration is additive unless it says otherwise. Each shipped migration past LAST_UNMARKED that drops, renames, changes
// a column's type, makes a column NOT NULL or adds one NOT NULL with no default carries the `-- runners: breaking` header
// (migrate.ts RUNNERS_BREAKING), which raises the runner floor when it is applied; one that does not fails here. The
// SQLite store has no migration files: its schema is built in code (schema.ts) and a SQLite runner opens only its own
// version (its floor is its version), so there is nothing of it to lint.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LAST_UNMARKED, marksBreaking, migrationsIn, RUNNERS_BREAKING } from "../dist/store/index.js";
import { breakingStatements } from "../dist/store/postgres/migration-lint.js";
import { buildSchema } from "../dist/store/store-schema.js";
import { SCHEMA_VERSION } from "../dist/store/schema.js";

const name = (m) => `${String(m.version).padStart(4, "0")}_${m.name}.sql`;

test("every shipped migration past LAST_UNMARKED that an earlier runner cannot run beside says so in its header", () => {
  const unmarked = migrationsIn()
    .filter((m) => m.version > LAST_UNMARKED && !m.breaking)
    .map((m) => ({ file: name(m), breaking: breakingStatements(m.sql) }))
    .filter((m) => m.breaking.length > 0);
  assert.deepEqual(
    unmarked,
    [],
    unmarked
      .map((m) => `${m.file}: ${m.breaking.map((b) => `${b.why} (${b.statement})`).join("; ")}. Make it additive (the cleanup lands one release later), or put "${RUNNERS_BREAKING}" in its leading comment, which raises the runner floor to its version: every runner of an earlier build stops, hands its runs back and exits when it is applied.`)
      .join("\n"),
  );
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
    "ALTER TABLE runs ALTER COLUMN labels DROP NOT NULL;",
    "ALTER TABLE runs ADD CONSTRAINT runs_note_check CHECK (note <> '');",
    "-- this file does not drop or rename anything\nUPDATE store_meta SET schema_version = 24 WHERE singleton = 1;",
    "/* DROP TABLE runs; */ SELECT 1;",
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
