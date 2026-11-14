// A filesystem notification is a wake-up hint, not a guarantee that a SQLite commit is already readable.
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { scratch } from "./support.mjs";
import { onDisk, outboxOf, receiver, settled, webhookOn } from "./webhook-support.mjs";

test("settled observes the committed webhook delivery when its only filesystem event preceded the commit", async t => {
  const response = Promise.withResolvers();
  t.after(() => response.resolve());
  const hook = await receiver(t, async () => { await response.promise; return 200; });
  const dir = await scratch(t), on = await webhookOn(t, dir);
  await on.runs("delivery");
  const webhooks = await on.open();
  await webhooks.save({ url: hook.url });
  await webhooks.emit("run.ended", { run_id: "delivery", agent_id: "a", status: "completed", title: "delivery" }, new Date().toISOString());
  await hook.when(1);
  assert.equal(outboxOf(dir).messages[0].status, "pending", "the receiver holds its answer until the watch is installed");

  const originalWatch = fs.watch;
  let changed, closed = 0;
  t.after(() => { fs.watch = originalWatch; syncBuiltinESMExports(); });
  fs.watch = (_dir, listener) => { changed = listener; return { close: () => { closed++; } }; };
  syncBuiltinESMExports();
  const ready = settled(dir);
  // The one event occurs while the actual delivery is still pending. No later event follows its commit.
  changed("change", "store.sqlite-wal");
  response.resolve();
  let timeout;
  const completed = await Promise.race([ready.then(() => true), new Promise(resolve => { timeout = setTimeout(() => resolve(false), 5_000); })]);
  clearTimeout(timeout);
  assert.equal(completed, true, `the store's committed delivery must settle without a second notification: ${JSON.stringify(outboxOf(dir).messages.map(m => m.status))}`);
  assert.deepEqual(outboxOf(dir).messages.map(m => m.status), ["delivered"]);
  assert.ok(closed > 0, "the completed waiter closes its watcher");
});

test("a locked webhook snapshot does not block the writer's event loop, and is read after the lock is released", async t => {
  const dir = await scratch(t);
  const writer = new DatabaseSync(join(dir, "store.sqlite"));
  t.after(() => writer.close());
  writer.exec(`
    CREATE TABLE channel_posts (channel, id, moment, body, attempts, next_at, state, reason, created_at);
    CREATE TABLE channel_attempts (seq, channel, post_id, moment, status_code, error, redelivery);
    CREATE TABLE channel_told (channel, run_id, marker, at);
    BEGIN EXCLUSIVE;
  `);
  const began = performance.now();
  const waiting = onDisk(dir, () => outboxOf(dir));
  try {
    // Distinguish an immediate refused read from SQLite's old five-second busy wait.
    assert.ok(performance.now() - began < 1_000, "observing a lock must not block the JS turn that releases it");
    writer.exec("COMMIT");
    assert.deepEqual(await waiting, { messages: [], attempts: [], notices: {} });
  } finally {
    if (writer.isTransaction) writer.exec("ROLLBACK");
    await waiting;
  }
});
