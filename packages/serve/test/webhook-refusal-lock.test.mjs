// Fault injection must let the real writer finish its transaction; blocking this event loop prevents its commit.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { refusing } from "./webhook-support.mjs";

test("releasing a webhook write fault lets an existing writer commit on the same event loop", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "webhook-refusal-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const writer = new DatabaseSync(join(dir, "store.sqlite"));
  writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE channel_posts (channel TEXT)");
  const release = await refusing(t, dir, "outbox");
  writer.exec("BEGIN IMMEDIATE");
  let committed = false;
  const timer = setTimeout(() => { writer.exec("COMMIT"); committed = true; }, 20);
  try {
    await release();
    assert.equal(committed, true, "the writer was allowed to finish before the schema change");
    writer.exec("INSERT INTO channel_posts (channel) VALUES ('webhook-out')");
    assert.equal(writer.prepare("SELECT count(*) AS count FROM channel_posts").get().count, 1);
  } finally {
    clearTimeout(timer);
    if (!committed) writer.exec("ROLLBACK");
    writer.close();
  }
});
