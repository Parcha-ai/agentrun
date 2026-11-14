// A filesystem notification is a wake-up hint, not a guarantee that a SQLite commit is already readable.
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { scratch } from "./support.mjs";
import { outboxOf, receiver, settled, webhookOn } from "./webhook-support.mjs";

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
