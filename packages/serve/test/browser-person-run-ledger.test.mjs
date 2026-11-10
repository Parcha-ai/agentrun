// A person's time in a run's browser (an owner's take-over, the agent's held ask: browser-person.ts, through browserSpend's
// personTime) and the time it leaves carried until the session's next charge (carry) book on the runner's one ledger when
// browserSpend is given it (ledger.paid), as main books them through its cap: the person's time held up front at the
// provider's price, refused in the cap's words when the cap has no room, and carried time held until a charge books it, so
// a later claim still counts what was held.
import assert from "node:assert/strict";
import { test } from "node:test";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { TOOL_COST } from "@parcha/pi-durable-agent/timeline";
import { browserSpend } from "../dist/browser-cost.js";
import { paidHolds, useSpend } from "../dist/cap.js";

const cap = await import("../../run-adapters/dist/kernel/cap/index.js");
const T0 = Date.parse("2026-11-09T05:00:00Z");
/** Browserbase at $0.12 an hour (its 60 s minimum, a 180 s idle window). */
const PRICE = { usdPerHour: 0.12, minimumS: 60 };
const usdOf = (seconds) => (PRICE.usdPerHour * seconds) / 3600;
/** To the millionth of a dollar up, as browser-cost.ts holds a person's time. */
const microUsd = (usd) => Math.ceil(Math.round(usd * 1e12) / 1e6) / 1e6;
const claimOn = async (store, capUsd = 1) => cap.runCap({ sessions: store, capUsd: () => capUsd, now: () => T0, modelOf: () => undefined }).tools(await store.open(cap.TOOL_SESSION));
const near = (actual, expected, what) => assert.ok(typeof actual === "number" && Math.abs(actual - expected) < 1e-9, `${what}: ${actual}, not ${expected}`);

test("a take-over's fifteen minutes are held on the run's one ledger, and a later claim counts the hold", async () => {
  const store = memorySessionStore();
  const spend = browserSpend("browserbase", PRICE, 180, async () => {}, () => {}, { paid: await claimOn(store) });
  const hold = await spend.personTime("your time in the browser", 900, { pauses: false, tag: "s1", from: T0 });
  assert.equal("refused" in hold, false, `held: ${JSON.stringify(hold)}`);
  near((await claimOn(store)).spentUsd(), microUsd(usdOf(900)), "the next claim counts the person's held time");
});

test("a take-over past the cap is refused in the cap's words, and holds nothing", async () => {
  const store = memorySessionStore();
  const spend = browserSpend("browserbase", PRICE, 180, async () => {}, () => {}, { paid: await claimOn(store, 0.01) });
  const hold = await spend.personTime("your time in the browser", 900, { pauses: false, tag: "s1", from: T0 });
  assert.ok("refused" in hold, `refused: ${JSON.stringify(hold)}`);
  assert.match(hold.refused, /the next step, your time in the browser, could cost up to \$0\.03/, "main's paid-call words, naming it");
  near((await claimOn(store)).spentUsd(), 0, "nothing held");
});

test("on the run's one ledger a session's reserve and charges are the ledger's alone: nothing is held in, or added to, this process's spend", async (t) => {
  // This process's own spend, as a run of main's process would have it (cap.ts): it must see none of the runner's.
  let processSpent = 0;
  useSpend({ cap: 1, spent: () => processSpent, add: (usd) => void (processSpent += usd ?? 0) });
  t.after(() => useSpend(undefined));
  const store = memorySessionStore();
  const spend = browserSpend("browserbase", PRICE, 180, async () => {}, () => {}, { paid: await claimOn(store) });
  // The session's first charge, as its commit publishes it (watch): its reserve is held from here.
  let listener;
  spend.watch({ observeCommits: (given) => void (listener = given), closed: new Promise(() => {}) });
  listener.advance({ changes: [{ type: "entry", value: { kind: TOOL_COST, data: { tool: "browser", charged_by: "browserbase", call: "c1", usd: 0.0003, seconds: 9, tag: "s1", conversation: 1, at: new Date(T0).toISOString(), final: false } } }] });
  await spend.ledgerIdle?.();
  assert.equal(paidHolds(), 0, "no hold in this process's paid holds");
  assert.equal(processSpent, 0, "nothing added to this process's spend");
  // Its charge is booked on the ledger once its commit is in (as watch sees it), beside the reserve held from it.
  near((await claimOn(store)).spentUsd(), spend.stretch + 0.0003, "the session's reserve is held, and its charge booked, on the run's ledger");
});

test("a person's time carried after it ended is held until a charge books it, and a later claim counts it", async () => {
  const store = memorySessionStore();
  const spend = browserSpend("browserbase", PRICE, 180, async () => {}, () => {}, { paid: await claimOn(store) });
  spend.carry("s1", 120);
  await spend.ledgerIdle?.();
  const carried = (await claimOn(store)).spentUsd();
  assert.ok(typeof carried === "number" && carried > 0 && carried <= microUsd(usdOf(120)) + 1e-9, `the next claim counts the carried time, at most its two minutes: ${carried}`);
});

// Money its provider is already owed, run outside any call, is held on the ledger however the run's spend stands (owed:
// never asked of the cap's rule, as main's keepHold): a session still open at a reopen, and a person's time that ran.
test("past the run's cap, a session held from a reopen and a person's carried time are still held on the ledger (owed), and a later claim counts them", async () => {
  const store = memorySessionStore();
  // A $0.001 cap: one stretch ($0.009) of either does not fit, so a refusable hold would be refused.
  const spend = browserSpend("browserbase", PRICE, 180, async () => {}, () => {}, { paid: await claimOn(store, 0.001) });
  const docs = { Inventory: "inventory", Sessions: "sessions" };
  const harness = { snapshot: async (doc) => (doc === docs.Inventory ? { rows: { s1: { tag: "s1", conversationId: 1, state: "kept", resourceId: "bb-1" } } } : { sessions: [{ tag: "s1", spent: { chargedThrough: new Date().toISOString() } }] }) };
  await spend.reopened(harness, docs, {});
  await spend.ledgerIdle?.();
  const reopened = (await claimOn(store)).spentUsd();
  assert.ok(typeof reopened === "number" && reopened >= spend.stretch - 1e-9, `the reopen's reserve is held past the cap: ${reopened}`);
  spend.carry("s1", 120);
  await spend.ledgerIdle?.();
  const carried = (await claimOn(store)).spentUsd();
  assert.ok(typeof carried === "number" && carried > reopened, `the carried time is held too: ${carried}, after ${reopened}`);
});
