// The run-change feed's contract (store-run-changes.mjs) on the store the tests run on (store-target.mjs): one store, a
// second connection to it (the runner's role beside the server's), and a clock that never moves, so every write is in one
// millisecond. Postgres numbers its changes under one lock (migration 0002), so they commit in seq order, as SQLite's
// one writer does: neither can commit a change below one already read.
import { test } from "node:test";
import { runRunChangeCases } from "./store-run-changes.mjs";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";
import { onPostgres } from "./store-target.mjs";

runRunChangeCases(test, {
  name: onPostgres ? "Postgres (changes are numbered under one lock)" : "SQLite",
  async open(t) {
    const { store, file, clock } = await storeOn(t);
    await agentWithRevision(store);
    const other = async () => (await storeOn(t, { file, clock, role: "runner" })).store;
    return { store, clock, other };
  },
});
