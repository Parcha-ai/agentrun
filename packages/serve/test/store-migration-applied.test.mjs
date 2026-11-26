// An applied Postgres migration is never edited: the server's open refuses a schema whose schema_migrations row holds
// other text than this build's file of that version (migrate.ts migrate). The refusal names both files, the applied
// row's and this build's, each with its sha256's start, so a migration renumbered or renamed on one side is plain to
// see. Checked on a stand-in client that answers migrate's reads: no database.
import assert from "node:assert/strict";
import { test } from "node:test";
import { migrate } from "../dist/store/postgres/migrate.js";

/** A client whose schema holds `applied` (schema_migrations rows): every read migrate makes before it applies anything. */
const clientOf = (applied) => ({
  query: async (sql) => {
    if (/FROM pg_namespace|information_schema\.columns/.test(sql)) return { rowCount: 1, rows: [{}] };
    if (/SELECT version, name, sha256 FROM schema_migrations/.test(sql)) return { rowCount: applied.length, rows: applied };
    return { rowCount: 0, rows: [] };
  },
});

test("an applied migration with other text than this build's is refused naming the applied file and this build's, each with its sha256", async () => {
  const mine = [{ version: 1, name: "initial", sql: "", sha256: "a".repeat(64) }, { version: 2, name: "ledger_calls", sql: "", sha256: "b".repeat(64) }];
  // A renamed migration: the schema applied 0002_ledger_epoch.sql, this build's 0002 is another file.
  await assert.rejects(migrate(clientOf([{ version: "1", name: "initial", sha256: "a".repeat(64) }, { version: "2", name: "ledger_epoch", sha256: "c".repeat(64) }]), "agentrun", 0, mine), (error) => {
    assert.equal(error.message, `the Postgres schema agentrun applied 0002_ledger_epoch.sql (sha256 ${"c".repeat(12)}) where this build has 0002_ledger_calls.sql (sha256 ${"b".repeat(12)}): an applied migration is never edited, renumbered or renamed, a change is a new file`);
    return true;
  });
  // The same file edited since it was applied: both names the same, the two texts' sha256s apart.
  await assert.rejects(migrate(clientOf([{ version: "1", name: "initial", sha256: "edited" }]), "agentrun", 0, mine), /applied 0001_initial\.sql \(sha256 edited\) where this build has 0001_initial\.sql \(sha256 a{12}\)/);
});
