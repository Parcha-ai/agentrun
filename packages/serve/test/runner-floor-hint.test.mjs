// A runner reads its store's runner floor again soon after the store says it changed (Store.watchSchema; runner/main.ts
// watchFloor), not only at its timer (each renewal, 10 s): on SQLite, a write to the store's file by another process (a
// later server's upgrade among them) is that hint, so the runner stops within a second or so of the floor's rise.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { FLOOR_HINT_GAP_MS, startRunnerProcess } from "../dist/runner/main.js";
import { openSqliteStore } from "../dist/store/index.js";
import { SCHEMA_VERSION } from "../dist/store/schema.js";
import { STORE_FILE } from "../dist/store/sqlite/store.js";
import { fauxLoops } from "./runner-support.mjs";

const SEAL = randomBytes(32).toString("base64");

/** A data directory the server set up, removed at the test's end. */
async function serverData(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-floor-hint-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  await server.close();
  return dir;
}

/** What `promise` settles with within `ms`, or "never" (its timer holds no process open). */
const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve("never"), ms).unref())]);

test("a SQLite store hints at a write to its file by another connection, and its unsubscribe ends the hints", async (t) => {
  const dir = await serverData(t);
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  t.after(() => store.close());
  assert.equal(typeof store.watchSchema, "function");
  let hints = 0;
  let hinted;
  const first = new Promise((resolve) => (hinted = resolve));
  const unwatch = store.watchSchema(() => {
    hints += 1;
    hinted("hinted");
  });
  const db = new DatabaseSync(join(dir, STORE_FILE), { timeout: 10_000 });
  try {
    db.exec("CREATE TABLE hint_probe (n INTEGER)");
    db.prepare("INSERT INTO hint_probe (n) VALUES (1)").run();
    assert.equal(await within(first, 5_000), "hinted", "the write was said");
    unwatch();
    const seen = hints;
    db.prepare("INSERT INTO hint_probe (n) VALUES (2)").run();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(hints, seen, "none once unsubscribed");
  } finally {
    db.close();
  }
});

test("a runner whose floor timer is an hour away stops within seconds of the floor's rise on SQLite: the store's hint reads it", async (t) => {
  const dir = await serverData(t);
  const started = await startRunnerProcess({ dataDir: dir, env: { AGENTRUN_SEAL_KEY: SEAL }, name: "runner-hint", loops: 1, createLoop: fauxLoops().createLoop, floorEveryMs: 3_600_000 });
  t.after(() => started.close());
  // A later release's server upgraded the file (on SQLite a runner's floor is the version).
  const db = new DatabaseSync(join(dir, STORE_FILE), { timeout: 10_000 });
  db.prepare("UPDATE store_meta SET schema_version = ?").run(SCHEMA_VERSION + 1);
  db.close();
  const why = await within(started.outdated, FLOOR_HINT_GAP_MS + 4_000);
  assert.notEqual(why, "never", "read on the store's hint, not at the hour's timer");
  assert.match(why, new RegExp(`runner floor rose to ${SCHEMA_VERSION + 1}, above the version this runner knows \\(${SCHEMA_VERSION}\\)`));
});
