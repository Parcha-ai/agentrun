// A purge leaves no copy of what it purged in the SQLite store's file bytes (DELETE /v2/runs/{run_id}, DELETE
// /v2/agents/{agent_id}). A row the purge deletes or blanks stays readable in the file's free space, and in the WAL's
// earlier page images, unless every connection that writes runs with secure_delete (worker.ts open) and the purge
// checkpoints the WAL once it commits (sqlite/store.ts #purged). One sentinel, a word no other test holds, is in the raw
// bytes of store.sqlite and its -wal before the purge; after it, it is in none of store.sqlite, -wal, -journal or -shm:
// at once, after another checkpoint, and after the server closes. A checkpoint another connection's reader holds back
// never fails the purge: it warns, and the next purge's checkpoint finishes. SQLite only: on Postgres a purged row's
// bytes are the database's until its VACUUM (a gap named in the purge docs, not closed).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openSqliteStore } from "../dist/store/index.js";
import { sqliteOnly } from "./store-target.mjs";
import { follow, serve, startRun } from "./support.mjs";

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

test("a purge whose checkpoint a reader in another connection holds back still commits: it warns that the bytes may stay, and the next purge's checkpoint, once the reader is done, leaves the sentinel in none of the store's files", sqliteOnly("the SQLite store's WAL checkpoint"), async (t) => {
  const word = `PURGE-SENTINEL-${randomBytes(6).toString("hex")}`;
  const dir = mkdtempSync(join(tmpdir(), "purge-bytes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const warned = [];
  // A short busy wait: the held checkpoint gives up in a moment, as one held past the store's own 10 s would.
  const store = await openSqliteStore({ file: join(dir, "store.sqlite"), busyTimeoutMs: 50, warn: (message) => warned.push(message) });
  t.after(() => store.close());
  await store.agents.create({ id: "agent-1", name: "agent-1" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  for (const id of ["run-1", "run-2"]) {
    await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: `Keep ${word} for ${id}.` } } });
    const claim = await store.claim(id, "runner-test", { leaseMs: 30_000 });
    assert.ok(claim, `run ${id} is claimed`);
    await store.runs.update(claim, { state: "ended", costUsd: 0.01, summary: `It kept ${word}.` });
  }
  const kept = { meters: null, spend: { usd: null }, learning: null };

  // A reader's snapshot from before the purge: the log's frames it reads stay, so no checkpoint can truncate it.
  const reader = new DatabaseSync(join(dir, "store.sqlite"), { readOnly: true });
  reader.exec("BEGIN");
  reader.prepare("SELECT count(*) AS n FROM runs").get();
  await store.runs.purge("run-1", kept);
  assert.equal((await store.runs.get("run-1")).purgedAt !== null, true, "the purge committed");
  assert.equal(warned.length, 1, JSON.stringify(warned));
  assert.match(warned[0], /purge of run run-1 committed, but its WAL checkpoint did not finish \(another connection held the log\)/);
  assert.notDeepEqual(holding(dir, word), [], "while the reader holds the log, the store's bytes may hold the sentinel, as the warning says");
  reader.exec("COMMIT");
  reader.close();

  await store.runs.purge("run-2", kept);
  assert.equal(warned.length, 1, `the next purge's checkpoint finishes: ${JSON.stringify(warned)}`);
  assert.deepEqual(holding(dir, word), [], "after the next purge's checkpoint, no store file holds the sentinel of either run");
});
