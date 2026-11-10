// A data directory an earlier version wrote is refused at start, never taken for this version's (store/sqlite/store.ts
// earlierVersionIn). Its store.sqlite may be busy as the start reads it (that version's server mid-commit, in its rollback
// journal): busy says nothing of whose store it is, so the read waits for it, and never answers "this version's".
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const { isThisVersionsStore } = await import("../dist/store/sqlite/store.js");

test("an earlier version's store, busy as it is read, is never taken for this version's", { timeout: 60_000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "store-earlier-busy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "store.sqlite");
  // An earlier version's store: its own tables, no store_meta, in the rollback journal it kept.
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE runs_v0 (id TEXT PRIMARY KEY)");
  // That version's server mid-commit: the file held exclusively for as long as this case reads it.
  old.exec("BEGIN EXCLUSIVE");
  old.exec("INSERT INTO runs_v0 (id) VALUES ('run-1')");
  t.after(() => old.isOpen && old.close());
  let answer;
  try {
    answer = isThisVersionsStore(file);
  } catch (error) {
    answer = `refused: ${error.message}`;
  }
  assert.notEqual(answer, true, "a busy store is never read as this version's");
  old.exec("ROLLBACK");
  assert.equal(isThisVersionsStore(file), false, "once free, it reads as the earlier version's it is");
});
