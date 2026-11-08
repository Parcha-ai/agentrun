// The agent reader's pi-durable schema range: a store pi 1.5 writes is schema 2, one an earlier release wrote and no 1.5
// harness has reopened since is schema 1. Version 2 only rebuilt `tasks`; `entries`, the table the reader reads, is the
// same in both, so both read, and a newer schema is refused.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openReadOnly } from "../dist/serve/read.js";

/** A run store with one entry, closed, its schema version then set to `version` as an earlier release left it. */
async function storeAt(t, version) {
  const dir = mkdtempSync(join(tmpdir(), "read-schema-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "run.sqlite");
  const harness = await Harness.open(await openNodeSqliteStorage(file), { registry: createRegistry(), models: createModels() }, ctx);
  await harness.commit(async (tx) => {
    const root = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await tx.appendEntry(root.id, { kind: "pi.user", model: [] });
  }, ctx);
  await harness.close(ctx);
  const db = new DatabaseSync(file);
  db.exec(`UPDATE durable_schema SET version = ${version}`);
  db.close();
  return file;
}

for (const version of [1, 2]) {
  test(`a store at pi-durable schema ${version} is read: its entries, as both schemas keep them`, async (t) => {
    const db = openReadOnly(await storeAt(t, version));
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM entries").get().n, 1);
    } finally {
      db.close();
    }
  });
}

test("a store at a newer pi-durable schema (3) is refused, in words that name both", async (t) => {
  const file = await storeAt(t, 3);
  assert.throws(() => openReadOnly(file), /pi-durable schema 3; this version reads 1 and 2/);
});
