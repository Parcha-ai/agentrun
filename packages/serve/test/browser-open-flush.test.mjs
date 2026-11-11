// A browser session's open on the runner (browser-cost.ts opening, pi-browser's beforeCreate): the run's record of it
// (BROWSER_SESSION_OPEN, its tag) is committed and then flushed to disk through the run's ledger (the runner's store
// flush) before the vendor is asked, so a lost box never leaves a billed session that no record in the store names. The
// runner's flush before a tool call comes before the call's session is opened, so it never covers this record.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BROWSER_SESSION_OPEN, browserSpend } from "../dist/browser-cost.js";

const PRICE = { usdPerHour: 0.12, minimumS: 60 };
const paid = { admit: async () => ({ ok: true }), settle: async () => undefined, spentUsd: () => 0, heldUsd: () => 0 };

/** pi-browser's `open` for one session: its commit notes each entry it appends, in order with the flushes. */
function opened(seen) {
  return {
    conversationId: 3,
    tag: "tag-1",
    commit: async (change) => change({ appendEntry: async (_conversation, entry) => void seen.push(`commit ${entry.kind} ${entry.data.tag}`) }),
  };
}

test("a session's open is committed and then flushed before the vendor is asked", async () => {
  const seen = [];
  const spend = browserSpend("browserbase", PRICE, 180, async () => {}, () => {}, { paid, flush: async () => void seen.push("flush") });
  await spend.opening(opened(seen));
  assert.deepEqual(seen, [`commit ${BROWSER_SESSION_OPEN} tag-1`, "flush"]);
});

test("a flush that fails fails the open, so pi-browser creates no session", async () => {
  const spend = browserSpend("browserbase", PRICE, 180, async () => {}, () => {}, { paid, flush: async () => { throw new Error("disk gone"); } });
  await assert.rejects(spend.opening(opened([])), /disk gone/);
});
