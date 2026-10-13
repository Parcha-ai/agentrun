// The launcher waits for the server by time, not by a count of tries: three wrappers (each reading 1Password) take 17-20 s before the server itself starts, and a count of tries gave up at about 30 s.
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error a plain .mjs script
import { waitUp } from "../scripts/wait-up.mjs";

/** A clock the test moves: sleep advances it, so a wait of minutes takes no time. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), at: () => t };
}

test("a server that answers after 45 s (slower than the old 30 s) is waited for", async () => {
  const c = clock();
  const up = await waitUp({ probe: async () => c.at() >= 45_000, exited: () => false, timeoutMs: 120_000, now: c.now, sleep: c.sleep });
  assert.equal(up, true);
  assert.ok(c.at() >= 45_000 && c.at() < 46_000);
});

test("a server that never answers is given up on at the timeout, and not before", async () => {
  const c = clock();
  const up = await waitUp({ probe: async () => false, exited: () => false, timeoutMs: 120_000, now: c.now, sleep: c.sleep });
  assert.equal(up, false);
  assert.ok(c.at() >= 120_000 && c.at() < 121_000, `gave up at ${c.at()} ms`);
});

test("a server that has exited ends the wait at once", async () => {
  const c = clock();
  let probes = 0;
  const up = await waitUp({ probe: async () => (probes++, false), exited: () => c.at() >= 1_000, timeoutMs: 120_000, now: c.now, sleep: c.sleep });
  assert.equal(up, false);
  assert.ok(c.at() <= 1_200, `waited until ${c.at()} ms`);
});

test("the bound holds for the probe and the sleep: the last probe is told only the time left, none starts after the deadline, and a slow probe cannot push the wait past it", async () => {
  const c = clock();
  const budgets: number[] = [];
  // Every probe takes as long as it is allowed (a request to a server that does not answer), and fails.
  const up = await waitUp({ probe: async (budgetMs: number) => (budgets.push(budgetMs), await c.sleep(budgetMs), false), exited: () => false, timeoutMs: 5_500, pollMs: 700, probeMs: 2_000, now: c.now, sleep: c.sleep });
  assert.equal(up, false);
  assert.ok(c.at() <= 5_500, `the wait ended at ${c.at()} ms, past the 5500 ms bound`);
  assert.ok(budgets.every((b) => b > 0 && b <= 2_000), `budgets ${budgets}`);
  assert.ok(budgets.at(-1)! < 2_000, "the last probe was cut to the time left");
  let started = 0;
  const d = clock();
  await waitUp({ probe: async () => (started++, false), exited: () => false, timeoutMs: 1_000, pollMs: 5_000, now: d.now, sleep: d.sleep });
  assert.equal(started, 1, "a long sleep is cut to the time left, and no probe starts after it");
  assert.ok(d.at() <= 1_000);
});
