// What a run's process leaves for the runs app, written by the tests' stand-ins for it: the door start-run.mjs records in
// the run's web.json, and the record the run keeps in its store (pda_run_status, one row). Node built-ins only, so a fake
// start command can import it by path.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The run's door in web.json, beside what is there: the address it serves at, the pid that serves it and its epoch. */
export function writeDoor(dir, serve, pid = process.pid, epoch = 1) {
  const file = join(dir, "web.json");
  let meta = {};
  try {
    meta = JSON.parse(readFileSync(file, "utf8"));
  } catch {}
  writeFileSync(`${file}.tmp`, JSON.stringify({ ...meta, door: { serve, pid, epoch } }));
  renameSync(`${file}.tmp`, file);
}

/** The run's record in its store, as its process writes it: `status`, and the rest of a record. */
export function writeRecord(dir, { run = "x", status, generation = 1, wakeAt = null, holder = null, updatedAt = new Date().toISOString(), detail = null }) {
  mkdirSync(join(dir, "store"), { recursive: true });
  const db = new DatabaseSync(join(dir, "store", "run.sqlite"));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS pda_run_status (id INTEGER PRIMARY KEY CHECK (id = 1), record TEXT NOT NULL)");
    db.prepare("INSERT INTO pda_run_status (id, record) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record").run(JSON.stringify({ run, status, generation, wakeAt, holder, updatedAt, detail }));
  } finally {
    db.close();
  }
}
