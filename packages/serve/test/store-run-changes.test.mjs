// The run-change feed's contract (store-run-changes.mjs) on the SQLite store: one store file, a second connection to it
// (the runner's role beside the server's), and a clock that never moves, so every write is in one millisecond.
import { test } from "node:test";
import { runRunChangeCases } from "./store-run-changes.mjs";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");

runRunChangeCases(test, {
  name: "SQLite",
  async open(t) {
    const { store, file, clock } = await storeOn(t);
    await agentWithRevision(store);
    const other = async () => {
      const second = await openSqliteStore({ file, role: "runner", now: () => clock.now });
      t.after(() => second.close());
      return second;
    };
    return { store, clock, other };
  },
});
