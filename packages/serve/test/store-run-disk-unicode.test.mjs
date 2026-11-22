// A launch body may hold an escaped NUL or a lone surrogate anywhere (a run's input): the JSON text keeps them, and Postgres's
// json functions refuse the whole document over one. The run-disk backfill (0026_run_disk.sql) and the reset's seeded-before
// read take one id or one number out of such a body, so neither may fail on a string elsewhere in it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { scratchConnection, runRow, T0 } from "./store-support.mjs";
import { readSeededBefore } from "../dist/store/sqlite/run-launch.js";
import { migrationsIn } from "../dist/store/postgres/migrate.js";
import { postgresOnly } from "./store-target.mjs";

const ESCAPES = ["\u0000", "\ud800", "\udc00", "\ud800\ud800", "\\u0000"];

test("the seeded-before read keeps its runs whose bodies hold an escaped NUL or a lone surrogate in their input", async (t) => {
  const db = await scratchConnection(t);
  const at = T0 - 1_000;
  for (const [index, escaped] of ESCAPES.entries()) {
    const id = `run-${index}`;
    await runRow(db, id);
    await db.run("INSERT INTO run_launch (run_id, body, created_at) VALUES (?, ?, ?)", id, JSON.stringify({ input: { content: `Task ${escaped} here.` }, learning: { seed: "s", section: "", seededAt: at - 1 } }), T0);
  }
  await runRow(db, "seeded-after");
  await db.run("INSERT INTO run_launch (run_id, body, created_at) VALUES (?, ?, ?)", "seeded-after", JSON.stringify({ input: { content: "Task \u0000." }, learning: { seed: "s", section: "", seededAt: at + 1 } }), T0);
  assert.deepEqual((await readSeededBefore(db.connection, "agent-1", at)).sort(), ESCAPES.map((_, index) => `run-${index}`).sort());
});

test("the run-disk backfill reads a launch's disk past an escaped NUL or a lone surrogate elsewhere in its body", postgresOnly("Postgres's json functions refuse those escapes"), async (t) => {
  const db = await scratchConnection(t);
  const backfill = migrationsIn().find((one) => one.name === "run_disk").sql.split(/;\s*\n/).find((statement) => /^\s*UPDATE runs SET disk/m.test(statement.replace(/^--.*$/gm, "")));
  assert.ok(backfill, "the migration's backfill statement");
  for (const [index, escaped] of ESCAPES.entries()) {
    const id = `run-${index}`;
    await runRow(db, id);
    await db.run("INSERT INTO run_launch (run_id, body, created_at) VALUES (?, ?, ?)", id, JSON.stringify({ input: { content: `Task ${escaped} here.` }, archil_disk: { kind: "launch", disk_id: `dsk-${index}` } }), T0);
  }
  await runRow(db, "plain");
  await db.run("INSERT INTO run_launch (run_id, body, created_at) VALUES (?, ?, ?)", "plain", JSON.stringify({ input: { content: "Task \u0000." } }), T0);
  await db.run("UPDATE runs SET disk = NULL");
  await db.run(backfill);
  const rows = await db.all("SELECT id, disk FROM runs ORDER BY id");
  assert.deepEqual(rows.map((row) => [row.id, row.disk]), [["plain", null], ...ESCAPES.map((_, index) => [`run-${index}`, `dsk-${index}`])]);
});
