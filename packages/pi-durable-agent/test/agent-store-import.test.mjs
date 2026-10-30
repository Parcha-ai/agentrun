// Imported runs in the agent store: a session another harness ran on this machine, recorded as a run that has already
// ended. run_imports names its source and native session, once; the store mints its id; the same session twice imports
// once. An imported run is read-only in the file itself: a trigger refuses any change to its row, so a version that
// ignores run_imports cannot reopen or end it again either.
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AgentHomeError, openStore, openStoreReader } from "../dist/index.js";
import { scratch } from "./support.mjs";

const refused = (code) => (error) => error instanceof AgentHomeError && error.code === code;
const A = { kind: "agentic", instructions: "Answer.", tools: [] };
const STARTED = "2026-10-01T10:00:00.000Z";
const ENDED = "2026-10-01T10:05:00.000Z";

async function seeded() {
  const dir = await scratch();
  const store = openStore(dir);
  store.createAgent({ name: "Notes", id: "notes" });
  const revision = await store.commitRevision("notes", A, { setCurrent: true });
  return { dir, store, revision: revision.id };
}
const input = (revision, over = {}) => ({ agent: "notes", revision, state: "completed", startedAt: STARTED, endedAt: ENDED, costUsd: 0.5, summary: "Wrote the notes.", source: "claude-code", session: "4f1c2b9e-session-a", ...over });
const rows = (dir, sql) => {
  const db = new DatabaseSync(path.join(dir, "store.sqlite"), { readOnly: true });
  try { return db.prepare(sql).all().map((r) => ({ ...r })); } finally { db.close(); }
};
const mode = (file) => statSync(file).mode & 0o777;

test("importRun records an ended run at the source's times, with its import row, and reads carry importedFrom", async () => {
  const { dir, store, revision } = await seeded();
  const run = store.importRun(input(revision));
  assert.match(run.runId, /^[0-9a-f-]{36}$/, "the store mints the id");
  assert.equal(run.dir, path.join(dir, "runs", run.runId));
  assert.equal(run.storePath, store.runStorePath(run.runId));
  const row = store.readRun(run.runId);
  assert.deepEqual({ state: row.state, startedAt: row.startedAt, endedAt: row.endedAt, costUsd: row.costUsd, summary: row.summary, importedFrom: row.importedFrom },
    { state: "completed", startedAt: STARTED, endedAt: ENDED, costUsd: 0.5, summary: "Wrote the notes.", importedFrom: { source: "claude-code", session: "4f1c2b9e-session-a" } });
  assert.deepEqual(store.listRuns().map((r) => [r.id, r.importedFrom]), [[run.runId, { source: "claude-code", session: "4f1c2b9e-session-a" }]]);
  const { runId: own } = await store.startRun({ agent: "notes" });
  assert.equal(store.readRun(own).importedFrom, undefined, "a run this server ran has none");
  assert.equal(store.listRuns().find((r) => r.id === own).importedFrom, undefined);
  const reader = openStoreReader(dir);
  assert.deepEqual(reader.readRun(run.runId).importedFrom, { source: "claude-code", session: "4f1c2b9e-session-a" }, "the read-only reader reads it too");
  reader.close();
  assert.deepEqual(rows(dir, "SELECT run_id, source, session FROM run_imports"), [{ run_id: run.runId, source: "claude-code", session: "4f1c2b9e-session-a" }]);
  store.close();
});

test("the run's directory and its store directory are 0700, set explicitly whatever the umask; no work directory is seeded", async () => {
  const { store, revision } = await seeded();
  await store.startRun({ agent: "notes" }); // runs/ exists, as on any server that ran something
  // A umask that strips the owner's write bit: a mode taken from mkdir alone reads 0500 (or the store dir is never made).
  const before = process.umask(0o222);
  let run;
  try { run = store.importRun(input(revision)); } finally { process.umask(before); }
  assert.equal(mode(run.dir), 0o700);
  assert.equal(mode(path.dirname(run.storePath)), 0o700);
  assert.equal(existsSync(path.join(run.dir, "work")), false);
  assert.equal(existsSync(run.storePath), false, "the transcript is the caller's to write");
  store.close();
});

test("a first import into a fresh store, with no run before it, makes runs/ the owner's under a umask that strips the owner's write bit", async () => {
  const { store, revision } = await seeded();
  const before = process.umask(0o222);
  let run;
  try { run = store.importRun(input(revision)); } finally { process.umask(before); }
  assert.equal(mode(path.dirname(run.dir)), 0o700, "runs/, made by this import");
  assert.equal(mode(run.dir), 0o700);
  assert.equal(mode(path.dirname(run.storePath)), 0o700);
  store.close();
});

test("an impossible calendar time is refused, never rolled to another date; a time with any fraction of a second is kept", async () => {
  const { store, revision } = await seeded();
  for (const at of ["2026-02-30T10:00:00Z", "2026-04-31T10:00:00.000Z", "2026-10-01T24:00:00Z"]) {
    assert.throws(() => store.importRun(input(revision, { startedAt: at, endedAt: "2026-12-01T10:00:00.000Z", session: `s-${at}` })), refused("invalid"), at);
  }
  assert.equal(store.listRuns().length, 0);
  const run = store.importRun(input(revision, { startedAt: "2026-10-01T10:00:00.5Z", endedAt: "2026-10-01T10:05:00Z" }));
  assert.equal(store.readRun(run.runId).startedAt, "2026-10-01T10:00:00.500Z");
  store.close();
});

test("the same source and session imports once: the second call returns undefined and writes nothing; another source with that session is its own run", async () => {
  const { dir, store, revision } = await seeded();
  const first = store.importRun(input(revision));
  assert.equal(store.importRun(input(revision, { summary: "again" })), undefined);
  assert.equal(store.listRuns().length, 1);
  assert.equal(store.readRun(first.runId).summary, "Wrote the notes.");
  const codex = store.importRun(input(revision, { source: "codex" }));
  assert.notEqual(codex.runId, first.runId);
  assert.equal(rows(dir, "SELECT COUNT(*) AS n FROM run_imports")[0].n, 2);
  store.close();
});

test("an imported run is read-only: reopenRun and carryBack are refused, and the file's trigger refuses a raw UPDATE of its row", async () => {
  const { dir, store, revision } = await seeded();
  const { runId } = store.importRun(input(revision));
  assert.throws(() => store.reopenRun(runId), (e) => refused("invalid")(e) && /imported/.test(e.message));
  assert.throws(() => store.carryBack(runId, { state: "failed" }), (e) => refused("invalid")(e) && /imported/.test(e.message));
  store.close();
  // What a version that ignores run_imports would do: the trigger travels with the file.
  const db = new DatabaseSync(path.join(dir, "store.sqlite"));
  assert.throws(() => db.prepare("UPDATE runs SET state = 'running', ended_at = NULL WHERE id = ?").run(runId), /an imported run is read-only/);
  assert.throws(() => db.prepare("UPDATE run_imports SET session = 'other' WHERE run_id = ?").run(runId), /written once/);
  assert.throws(() => db.prepare("DELETE FROM run_imports WHERE run_id = ?").run(runId), /written once/);
  db.close();
  const again = openStore(dir);
  const row = again.readRun(runId);
  assert.deepEqual([row.state, row.endedAt], ["completed", ENDED]);
  assert.equal(typeof again.setArchived("run", runId, true), "string", "archiving it is still allowed: that is not its row");
  again.close();
});

test("importRun checks everything before a write: each refusal leaves no row and no directory", async () => {
  const { dir, store, revision } = await seeded();
  store.createAgent({ name: "Other", id: "other" });
  const other = await store.commitRevision("other", { ...A, instructions: "Other." }, { setCurrent: true });
  const bad = [
    { state: "running" }, { state: "escalated" }, { source: "cursor" }, { session: "" }, { session: 7 },
    { startedAt: "yesterday" }, { endedAt: "2026-10-01T09:59:59.000Z" }, { costUsd: -1 }, { costUsd: Number.NaN }, { costUsd: Infinity },
    { summary: "" }, { revision: other.id }, { agent: "nobody" }, { runId: "chosen" },
  ];
  for (const over of bad) assert.throws(() => store.importRun(input(revision, over)), (e) => e instanceof AgentHomeError, JSON.stringify(over));
  assert.equal(store.listRuns().length, 0);
  assert.equal(existsSync(path.join(dir, "runs")) ? rows(dir, "SELECT COUNT(*) AS n FROM runs")[0].n : 0, 0);
  assert.equal(rows(dir, "SELECT COUNT(*) AS n FROM run_imports")[0].n, 0);
  store.close();
});

test("a long summary is cut as carryBack cuts it; no cost and no summary read as absent", async () => {
  const { store, revision } = await seeded();
  const long = store.importRun(input(revision, { summary: "x".repeat(5_000) }));
  assert.equal(store.readRun(long.runId).summary.length, 2_000);
  const bare = store.importRun(input(revision, { session: "bare", costUsd: undefined, summary: undefined }));
  const row = store.readRun(bare.runId);
  assert.equal(row.costUsd, undefined);
  assert.equal(row.summary, undefined);
  store.close();
});

test("the run row and its import row land in one transaction: a failed import insert leaves no run row and no directory", async () => {
  const { dir, store, revision } = await seeded();
  store.close();
  // A trigger that fails the second insert, as a full disk or a constraint would.
  const db = new DatabaseSync(path.join(dir, "store.sqlite"));
  db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON run_imports BEGIN SELECT RAISE(ABORT, 'forced'); END;");
  db.close();
  const again = openStore(dir);
  assert.throws(() => again.importRun(input(revision)), /forced/);
  assert.equal(again.listRuns().length, 0);
  const runs = path.join(dir, "runs");
  assert.deepEqual(existsSync(runs) ? (await import("node:fs")).readdirSync(runs) : [], []);
  again.close();
});

test("a store written before imports (no run_imports table) opens: the reader lists runs with no importedFrom, and the writer adds the table and imports", async () => {
  const { dir, store, revision } = await seeded();
  const { runId } = await store.startRun({ agent: "notes" });
  store.close();
  const db = new DatabaseSync(path.join(dir, "store.sqlite"));
  for (const { type, name } of db.prepare("SELECT type, name FROM sqlite_master WHERE (tbl_name = 'run_imports' OR name = 'imported_runs_stay_ended') AND type != 'table' AND sql IS NOT NULL").all()) db.exec(`DROP ${type.toUpperCase()} ${name}`);
  db.exec("DROP TABLE run_imports");
  db.close();
  const reader = openStoreReader(dir);
  assert.deepEqual(reader.listRuns().map((r) => [r.id, r.importedFrom]), [[runId, undefined]]);
  assert.equal(reader.readRun(runId).importedFrom, undefined);
  reader.close();
  const writer = openStore(dir);
  const run = writer.importRun(input(revision));
  assert.equal(writer.readRun(run.runId).importedFrom.source, "claude-code");
  writer.close();
  assert.equal(rows(dir, "PRAGMA user_version")[0].user_version, 1, "the version stays: an earlier version still opens the file");
});
