// A purge leaves no copy of what it purged in the SQLite store's file bytes (DELETE /v2/runs/{run_id}, DELETE
// /v2/agents/{agent_id}). A row the purge deletes or blanks stays readable in the file's free space, and in the WAL's
// earlier page images, unless every connection that writes runs with secure_delete (worker.ts open) and the purge
// checkpoints the WAL once it commits (sqlite/store.ts #purging). One sentinel, a word no other test holds, is in the raw
// bytes of store.sqlite and its -wal before the purge; after it, it is in none of store.sqlite, -wal, -journal or -shm:
// at once, after another checkpoint, and after the server closes. The scrub's marker is written before the purge changes
// a row: one that cannot be written refuses the purge with nothing purged. A checkpoint another connection's reader holds
// back never fails the purge: it keeps the marker, and the next start's scrub truncates the log; it waits only its
// own short busy wait, so the store's other requests never queue behind the store's own. SQLite only: on Postgres a
// purged row's bytes stay in its dead tuples until a write reuses the space VACUUM freed (a gap named in the purge docs,
// not closed).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { purgeRun } from "../dist/agent-delete.js";
import { openSqliteStore } from "../dist/store/index.js";
import { forgetServed, viewOverStore } from "../dist/store-view.js";
import { sqliteOnly } from "./store-target.mjs";
import { agent, follow, serve, startRun } from "./support.mjs";

const FILES = ["store.sqlite", "store.sqlite-wal", "store.sqlite-journal", "store.sqlite-shm"];

/** Of the store's files in `data`, those whose raw bytes hold `word` (a file not there holds nothing). */
function holding(data, word) {
  return FILES.filter((name) => {
    try {
      return readFileSync(join(data, name)).includes(word);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  });
}

/** A WAL checkpoint (TRUNCATE) from a connection of the test's own, as any later one of the server's would run: what it
 *  copies into the file must hold no purged byte either. */
function checkpoint(data) {
  const db = new DatabaseSync(join(data, "store.sqlite"), { timeout: 5_000 });
  try {
    return db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  } finally {
    db.close();
  }
}

/** The sentinel is in no file of the store now, after a checkpoint, and after the server `stop`s. */
async function goneFromBytes(data, word, stop) {
  assert.deepEqual(holding(data, word), [], "after the purge, no store file holds the sentinel");
  const done = checkpoint(data);
  assert.deepEqual(holding(data, word), [], `after a checkpoint (${JSON.stringify(done)}), no store file holds the sentinel`);
  await stop();
  assert.deepEqual(holding(data, word), [], "after the server closes, no store file holds the sentinel");
}

test("a purged run's sentinel, in its input, prompt and answer, is in the store's raw bytes before its DELETE and in none of store.sqlite, -wal, -journal or -shm after: at once, after a checkpoint, after the server closes", { ...sqliteOnly("the SQLite store's file bytes"), timeout: 120_000 }, async (t) => {
  const word = `PURGE-SENTINEL-${randomBytes(6).toString("hex")}`;
  const { api, data, stop } = await serve(t);
  // The faux model answers "Keep <word> everywhere." with the word: its input, its prompt and its answer hold it.
  const run = (await startRun(api, "calc", `Keep ${word} everywhere.`)).run_id;
  await follow(api, run, ["completed"]);
  assert.ok(JSON.stringify((await api("GET", `/runs/${run}/timeline`)).body).includes(word), "its answer holds the sentinel");
  assert.notDeepEqual(holding(data, word), [], "before the purge, the store's bytes hold the sentinel");
  const purged = await api("DELETE", `/runs/${run}`);
  assert.equal(purged.status, 204, JSON.stringify(purged.body));
  await goneFromBytes(data, word, stop);
});

test("a purged agent's sentinel, in its instructions and its run's input, is in none of the store's files after its DELETE: at once, after a checkpoint, after the server closes", { ...sqliteOnly("the SQLite store's file bytes"), timeout: 120_000 }, async (t) => {
  const word = `PURGE-SENTINEL-${randomBytes(6).toString("hex")}`;
  const { api, data, stop } = await serve(t);
  // Its instructions are its revision's body, which the agent's purge itself blanks (after each run's purge).
  const run = (await startRun(api, "kept", `Keep ${word} everywhere.`, { instructions: `Answer, and say ${word}.` })).run_id;
  await follow(api, run, ["completed"]);
  assert.notDeepEqual(holding(data, word), [], "before the purge, the store's bytes hold the sentinel");
  assert.equal((await api("POST", "/agents/kept/archive")).status, 200);
  const purged = await api("DELETE", "/agents/kept");
  assert.equal(purged.status, 204, JSON.stringify(purged.body));
  await goneFromBytes(data, word, stop);
});

/** `promise`, or a failure in words once `ms` have passed: a test's own bound, short of the suite's. */
const within = (promise, ms, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms).unref())]);

/** A store at `dir` (its own data directory, or its file `store.sqlite` there) with agent-1 and run-1 ended, its input and
 *  summary holding `word`. */
async function storeWithRun(dir, word, options = {}) {
  const store = await openSqliteStore({ ...options, dataDir: dir });
  await store.agents.create({ id: "agent-1", name: "agent-1" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: `Keep ${word} for run-1.` } } });
  const claim = await store.claim("run-1", "runner-test", { leaseMs: 30_000 });
  assert.ok(claim, "run-1 is claimed");
  await store.runs.update(claim, { state: "ended", costUsd: 0.01, summary: `It kept ${word}.` });
  return store;
}

/** A reader's snapshot from before a purge, in a connection of its own: the log's frames it reads stay, so no checkpoint
 *  can truncate the log while it is open. */
function heldReader(dir) {
  const reader = new DatabaseSync(join(dir, "store.sqlite"), { readOnly: true });
  reader.exec("BEGIN");
  reader.prepare("SELECT count(*) AS n FROM runs").get();
  return reader;
}

const KEPT = { meters: null, spend: { usd: null }, learning: null };

test("a purge whose checkpoint a reader in another connection holds back still commits and leaves the scrub's marker: the next start's scrub truncates the log, and the sentinel is in none of the store's files", { ...sqliteOnly("the SQLite store's WAL checkpoint"), timeout: 120_000 }, async (t) => {
  const word = `PURGE-SENTINEL-${randomBytes(6).toString("hex")}`;
  const dir = mkdtempSync(join(tmpdir(), "purge-bytes-"));
  let reader;
  t.after(() => reader?.isOpen && reader.close());
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = await storeWithRun(dir, word);
  reader = heldReader(dir);
  await store.runs.purge("run-1", KEPT);
  assert.equal((await store.runs.get("run-1")).purgedAt !== null, true, "the purge committed");
  const marker = join(dir, "store.sqlite.scrub");
  assert.ok(existsSync(marker), "its checkpoint held back, the purge leaves the scrub's marker for the next start");
  // The reader's snapshot ends, its connection open: the store's close is not the last connection's, so it leaves the log
  // as the held checkpoint left it (as a crash would).
  reader.exec("COMMIT");
  await store.close();
  assert.ok(statSync(join(dir, "store.sqlite-wal")).size > 0, "the log keeps its frames past the store's close");
  assert.notDeepEqual(holding(dir, word), [], "the store's bytes still hold the sentinel");

  // The next start, on the same data: its scrub, the store's secureRewrite the server runs before it serves (server.ts,
  // here with no row of its own to rewrite), truncates the log. The reader's connection stays open, so the log's size
  // is the scrub's doing and not the last close's.
  const next = await openSqliteStore({ dataDir: dir });
  t.after(() => next.close());
  assert.deepEqual(await next.secureRewrite(async () => 0), { rewritten: 0 }, "the scrub finishes");
  assert.equal(existsSync(marker), false, "the next start's scrub is done: its marker is gone");
  assert.equal(statSync(join(dir, "store.sqlite-wal")).size, 0, "and it truncated the log");
  assert.deepEqual(holding(dir, word), [], "no store file holds the sentinel");
});

test("a purge whose checkpoint is held back while a rewrite that finds nothing to rewrite is under way keeps its scrub's marker: the rewrite never removes a marker a purge left, and the next start's scrub truncates the log", { ...sqliteOnly("the SQLite store's WAL checkpoint"), timeout: 120_000 }, async (t) => {
  const word = `PURGE-SENTINEL-${randomBytes(6).toString("hex")}`;
  const dir = mkdtempSync(join(tmpdir(), "purge-bytes-"));
  let reader;
  t.after(() => reader?.isOpen && reader.close());
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = await storeWithRun(dir, word);
  const marker = join(dir, "store.sqlite.scrub");
  assert.equal(existsSync(marker), false, "no scrub is pending before the rewrite");
  // A rewrite as the server runs one while it serves (server.ts sealMarked: no VACUUM), whose work the test holds until
  // the purge is done, and which then finds nothing to rewrite (another write changed the row meanwhile).
  let entered;
  const inWork = new Promise((resolve) => (entered = resolve));
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const rewriting = store.secureRewrite(async () => (entered(), await held, 0), { vacuum: false });
  await inWork;
  reader = heldReader(dir);
  await store.runs.purge("run-1", KEPT);
  assert.equal((await store.runs.get("run-1")).purgedAt !== null, true, "the purge committed");
  release();
  const rewrote = await rewriting;
  assert.ok(existsSync(marker), "the marker the purge left (its checkpoint held back) outlives the rewrite");
  assert.deepEqual(rewrote, { rewritten: 0, left: "deferred" }, "the rewrite says the scrub is left to the next start");

  reader.exec("COMMIT");
  await store.close();
  assert.notDeepEqual(holding(dir, word), [], "the store's bytes still hold the sentinel");
  // The next start's scrub, as in the test above: it finds the marker, and truncates the log.
  const next = await openSqliteStore({ dataDir: dir });
  t.after(() => next.close());
  assert.deepEqual(await next.secureRewrite(async () => 0), { rewritten: 0 }, "the scrub finishes");
  assert.equal(existsSync(marker), false, "the next start's scrub is done: its marker is gone");
  assert.equal(statSync(join(dir, "store.sqlite-wal")).size, 0, "and it truncated the log");
  assert.deepEqual(holding(dir, word), [], "no store file holds the sentinel");
});

test("a purge's checkpoint that a reader in another connection holds back waits its own short busy wait, never the store's: on a store whose busy wait is ten minutes, the purge and a write sent behind it both answer", { ...sqliteOnly("the SQLite store's WAL checkpoint"), timeout: 120_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "purge-bytes-"));
  let reader;
  // The reader goes first: a checkpoint still waiting on it (a regression) then ends, and the store closes.
  t.after(() => reader?.isOpen && reader.close());
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A checkpoint on the store's own busy wait would wait the reader out, ten minutes: far past this test's own bound.
  const store = await storeWithRun(dir, "Purge me.", { busyTimeoutMs: 600_000 });
  t.after(() => store.close());
  reader = heldReader(dir);
  const purging = store.runs.purge("run-1", KEPT);
  const writing = store.agents.create({ id: "other", name: "other" }, { id: "rev-other", kind: "agentic", body: { instructions: "Answer." } });
  await within(Promise.all([purging, writing]), 30_000, "the purge, and a write queued behind its checkpoint");
  assert.equal((await store.runs.get("run-1")).purgedAt !== null, true, "the purge committed");
  assert.ok(await store.agents.get("other"), "the write is in");
});

const host = (store) => ({ store, madeFrom: async () => [], forgetCopies: async () => {}, forgetRun: async () => {}, kept: async () => KEPT, turnOver: async () => false, waitMs: 0, pollMs: 20 });

test("a purge whose scrub marker cannot be written (a full disk) is refused in words with nothing purged: the run, its bytes and what the process served of it are as before; the retry purges whole, and the sentinel is in none of the store's files", { ...sqliteOnly("the SQLite store's scrub marker"), timeout: 120_000 }, async (t) => {
  const word = `PURGE-SENTINEL-${randomBytes(6).toString("hex")}`;
  const dir = mkdtempSync(join(tmpdir(), "purge-bytes-"));
  let store;
  t.after(() => store?.close());
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A run with a launch the view reads back (its input, title and place), ended with an answer.
  store = await openSqliteStore({ dataDir: dir });
  await store.agents.create({ id: "agent-1", name: "agent-1" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: `Keep ${word} for run-1.` }, title: "Kept", place: { mode: "runner" } } });
  const claim = await store.claim("run-1", "runner-test", { leaseMs: 30_000 });
  assert.ok(claim, "run-1 is claimed");
  await store.runs.update(claim, { state: "ended", outcome: "completed", costUsd: 0.01, summary: `It kept ${word}.`, endedAt: Date.now() });
  // A read fills the view's answer and input slots; forgetServed says what it held, and the next read fills them again.
  const deps = { origin: "", serverSecrets: () => [] };
  const read = async () => assert.equal((await viewOverStore(store, "run-1", deps)).result.final_answer, `It kept ${word}.`);
  await read();
  assert.deepEqual(forgetServed(store, "run-1").slice(0, 2), ["answer run-1", "input run-1"], "a read keeps its answer and input");
  await read();

  // The marker's path a directory: its write fails (EISDIR), as a full disk's would, before the purge changes a row.
  const marker = join(dir, "store.sqlite.scrub");
  mkdirSync(marker);
  await assert.rejects(purgeRun(host(store), "run-1"), (error) => /^The purge's scrub marker could not be written \(EISDIR.*\): nothing was purged\.$/.test(error.message), "the purge is refused in words: a fault the server answers 500 and logs");
  assert.equal((await store.runs.get("run-1")).purgedAt, null, "nothing was purged");
  assert.notDeepEqual(holding(dir, word), [], "the store's bytes hold the run as before");
  assert.deepEqual(forgetServed(store, "run-1").slice(0, 2), ["answer run-1", "input run-1"], "and what the process served of it is kept");
  await read();
  rmSync(marker, { recursive: true });
  // The client's retry: the run purged whole, what the process served of it dropped, and no byte of it left.
  assert.equal(await purgeRun(host(store), "run-1"), undefined, "the retry purges");
  assert.notEqual((await store.runs.get("run-1")).purgedAt, null, "the retry's purge committed");
  assert.deepEqual(forgetServed(store, "run-1"), [], "nothing the process served of the run is kept: its answer and input went with the purge");
  assert.equal(existsSync(marker), false, "its checkpoint truncated the log, and the marker it wrote is gone");
  assert.deepEqual(holding(dir, word), [], "no store file holds the sentinel");
});

test("a purge that fails part way through its transaction purges nothing and leaves no marker; the retry purges whole: the run's rows gone, and the sentinel in none of the store's files", { ...sqliteOnly("the SQLite store's scrub marker"), timeout: 120_000 }, async (t) => {
  const word = `PURGE-SENTINEL-${randomBytes(6).toString("hex")}`;
  const dir = mkdtempSync(join(tmpdir(), "purge-bytes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = await storeWithRun(dir, word);
  t.after(() => store.close());
  // The purge's last write (its purge time) fails, after its run's content was deleted in the same transaction.
  const raw = (sql) => {
    const db = new DatabaseSync(join(dir, "store.sqlite"), { timeout: 5_000 });
    try {
      return db.prepare(sql).all();
    } finally {
      db.close();
    }
  };
  const launches = () => raw("SELECT count(*) AS n FROM run_launch WHERE run_id = 'run-1'")[0].n;
  raw("CREATE TRIGGER purge_fails BEFORE UPDATE OF purged_at ON runs WHEN NEW.purged_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'the purge failed part way'); END");
  await assert.rejects(store.runs.purge("run-1", KEPT), /the purge failed part way/, "the purge fails part way");
  const marker = join(dir, "store.sqlite.scrub");
  assert.equal((await store.runs.get("run-1")).purgedAt, null, "nothing was purged");
  assert.equal(launches(), 1, "its launch is there: the transaction rolled back");
  assert.equal(existsSync(marker), false, "a purge that committed nothing leaves no marker");
  raw("DROP TRIGGER purge_fails");
  await store.runs.purge("run-1", KEPT);
  assert.notEqual((await store.runs.get("run-1")).purgedAt, null, "the retry's purge committed");
  assert.equal(launches(), 0, "its launch is gone");
  assert.equal(existsSync(marker), false, "its checkpoint truncated the log, and the marker it wrote is gone");
  assert.deepEqual(holding(dir, word), [], "no store file holds the sentinel");
});

/** The server's scrub marker path a directory: a purge's marker write fails (EISDIR, as a full disk's write fails).
 *  `free()` makes the path writable again. */
function markerUnwritable(data) {
  const marker = join(data, "store.sqlite.scrub");
  mkdirSync(marker);
  return () => rmSync(marker, { recursive: true });
}

test("a run's DELETE whose scrub marker cannot be written is refused, nothing purged; the retry purges", { ...sqliteOnly("the SQLite store's scrub marker"), timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t);
  const run = (await startRun(api, "calc", "What is 2 + 2?")).run_id;
  await follow(api, run, ["completed"]);
  const free = markerUnwritable(data);
  const failed = await api("DELETE", `/runs/${run}`);
  assert.deepEqual([failed.status, failed.body.error?.code], [500, "internal"], JSON.stringify(failed.body));
  assert.equal((await api("GET", `/runs/${run}`)).status, 200, "nothing was purged: the run reads as before");
  free();
  const retried = await api("DELETE", `/runs/${run}`);
  assert.equal(retried.status, 204, JSON.stringify(retried.body));
  assert.equal((await api("GET", `/runs/${run}`)).status, 410, "the retry purged it");
});

test("an agent's DELETE whose scrub marker cannot be written is refused, nothing purged; the retry purges, and drops its purge's mark", { ...sqliteOnly("the SQLite store's scrub marker"), timeout: 120_000 }, async (t) => {
  const { api, data, store } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("scrubbed", { instructions: "Answer." }))).status, 201);
  assert.equal((await api("POST", "/agents/scrubbed/archive")).status, 200);
  const free = markerUnwritable(data);
  const failed = await api("DELETE", "/agents/scrubbed");
  assert.deepEqual([failed.status, failed.body.error?.code], [500, "internal"], JSON.stringify(failed.body));
  assert.equal((await store.agents.get("scrubbed")).purgedAt, null, "nothing was purged");
  free();
  const retried = await api("DELETE", "/agents/scrubbed");
  assert.equal(retried.status, 204, JSON.stringify(retried.body));
  assert.notEqual((await store.agents.get("scrubbed")).purgedAt, null, "the retry purged it");
  assert.equal(await store.settings.get("agent.purging.scrubbed"), undefined, "its purge's mark goes with the retry");
});
