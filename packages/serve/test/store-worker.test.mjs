// The store's one connection lives on a worker thread (design 2.2): a write, and a flush (a commit at FULL, which waits for
// the disk), never block the event loop the runner's loops share. Under a stream of writes and flushes, a timer on the main
// thread keeps its pace within a bound.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openSqliteStore } from "../dist/store/sqlite/store.js";

/** The most a 10 ms timer may be late while the store works: far under a flush's disk wait on a busy box, far over a
 *  timer's own jitter. */
const LAG_BOUND_MS = 150;

test("writes and flushes under load never stall the main event loop past a bound", { timeout: 120_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "store-worker-"));
  const store = await openSqliteStore({ file: join(dir, "store.sqlite") });
  t.after(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await store.agents.create({ id: "agent-1", name: "Agent one" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });

  let worst = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 10);
    last = now;
  }, 10);
  try {
    // 40 rounds of 50 runs each, a command per run, and a flush after each round, with every round's writes in flight at
    // once.
    for (let round = 0; round < 40; round++) {
      await Promise.all(Array.from({ length: 50 }, async (_, i) => {
        const id = `run-${round}-${i}`;
        await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" });
        await store.command(id, { kind: "steer", body: { text: "go on ".repeat(200) } });
      }));
      await store.flush();
    }
  } finally {
    clearInterval(timer);
  }
  assert.equal((await store.runs.list({})).length, 2_000, "every write landed");
  assert.ok(worst < LAG_BOUND_MS, `the main loop was held up to ${Math.round(worst)} ms (bound ${LAG_BOUND_MS} ms)`);
});

test("a write after close is refused in words, and close waits for the writes before it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "store-worker-close-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "store.sqlite");
  const store = await openSqliteStore({ file });
  await store.agents.put({ id: "agent-1", name: "Agent one" });
  const pending = store.agents.addRevision({ id: "rev-1", agentId: "agent-1", kind: "agentic", body: {} });
  await store.close();
  await pending;
  await assert.rejects(store.agents.put({ id: "agent-2", name: "late" }), /the store is closed/);
  const again = await openSqliteStore({ file });
  t.after(() => again.close());
  assert.equal((await again.agents.revision("rev-1"))?.agentId, "agent-1", "the write queued before close landed");
});
