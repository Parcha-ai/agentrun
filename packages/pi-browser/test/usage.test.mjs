// Pricing is money and has no integration path until a host composes the extension: the arithmetic is pinned here.
import assert from "node:assert/strict";
import test from "node:test";
import { fetchUsage, LIST_PRICES, resolvePrices, searchUsage, sessionCharge, sessionPrice, startSpent } from "../dist/index.js";

const at = (s) => new Date(Date.UTC(2026, 9, 6, 12, 0, s)).toISOString();
/** The meter bills to the picodollar: a sum of its charges is compared at that resolution, as it bills. */
const pico = (usd) => Math.round(usd * 1e12) / 1e12;

test("the host's session price: unset is unpriced, a non-negative decimal is priced per minute, anything else is invalid", () => {
  assert.deepEqual(sessionPrice(undefined), { prices: { sessionUsdPerHour: null }, state: "unpriced" });
  assert.deepEqual(sessionPrice("  "), { prices: { sessionUsdPerHour: null }, state: "unpriced" });
  assert.deepEqual(sessionPrice("0.002"), { prices: { sessionUsdPerHour: 0.002 * 60 }, state: "priced" });
  assert.equal(sessionPrice("0").state, "priced", "zero is a price");
  for (const bad of ["-1", "abc", "0x10", "1,5", "NaN", "Infinity", "3e307", "1e400"]) assert.equal(sessionPrice(bad).state, "invalid", bad);
  assert.equal(sessionPrice("3e300").state, "priced", "large but finite once converted to an hourly price");
  assert.equal(resolvePrices(sessionPrice("abc").prices).sessionUsdPerHour, null, "an invalid price is a gap, never the list price");
  assert.equal(resolvePrices().sessionUsdPerHour, LIST_PRICES.sessionUsdPerHour);
});

test("per-call deltas add up to the whole; the release tops the session up to the minimum once", () => {
  const prices = resolvePrices({ sessionUsdPerHour: 0.12 });
  let spent = startSpent(at(0));
  const a = sessionCharge(spent, at(10), prices); spent = a.spent;
  const b = sessionCharge(spent, at(25), prices); spent = b.spent;
  assert.equal(pico(a.usage.usage.cost.total + b.usage.usage.cost.total), spent.usd);
  assert.equal(spent.seconds, 25);
  const end = sessionCharge(spent, at(30), prices, "priced", true);
  assert.equal(end.spent.seconds, 60, "a 30 s session is billed its 1-minute minimum");
  assert.equal(end.spent.usd, 0.002, "60 s at $0.12 per hour, exactly");
  assert.equal(end.spent.final, true, "the release's charge marks the record");
  for (const final of [true, false]) {
    const again = sessionCharge(end.spent, at(500), prices, "priced", final);
    assert.equal(again.usage.usage.cost.total, 0, "a release retried after the host lost the first answer charges nothing");
    assert.deepEqual(again.spent, end.spent);
  }
  const same = sessionCharge(end.spent, at(30), prices, "priced", true);
  assert.deepEqual(same.spent, end.spent, "the same release charged twice adds nothing");
  const long = sessionCharge(startSpent(at(0)), at(300), prices, "priced", true);
  assert.equal(long.spent.seconds, 300, "past the minimum there is no top-up");
});

test("unpriced and invalid sessions record their seconds, charge nothing and say why; the clock never runs backwards", () => {
  for (const state of ["unpriced", "invalid"]) {
    const prices = resolvePrices({ sessionUsdPerHour: null });
    const { spent, usage } = sessionCharge(startSpent(at(0)), at(90), prices, state, true);
    assert.deepEqual([spent.seconds, spent.usd, usage.usage.cost.total, usage.state], [90, 0, 0, state]);
  }
  const first = sessionCharge(startSpent(at(100)), at(50), resolvePrices());
  assert.deepEqual([first.spent.seconds, first.spent.chargedThrough], [0, at(100)]);
});

test("fetch and search are charged per call at list price, and fetch with proxies at its own", () => {
  const prices = resolvePrices();
  assert.equal(fetchUsage(prices, false).usage.cost.total, 0.001);
  assert.equal(fetchUsage(prices, true).usage.cost.total, 0.004);
  assert.equal(searchUsage(prices).usage.cost.total, 0.007);
  assert.equal(searchUsage(resolvePrices({ searchUsd: 0.01 })).usage.cost.total, 0.01, "the host's plan wins");
});

test("a bill topped up to the minimum is exactly the minimum, at any millisecond: 60 s and $0.002 at $0.002 a minute", () => {
  // Timestamps a CI run once met: a call 1 ms after the create, the release 7 ms after that call. Adding a
  // fractional elapsed time to its complement left 59.99999999999999 s and $0.0019999999999999996.
  const prices = resolvePrices({ sessionUsdPerHour: 0.12 });
  const ms = (n) => new Date(Date.UTC(2026, 9, 8, 0, 0, 0) + n).toISOString();
  for (const [call, release] of [[1, 8], [1, 29], [1, 36], [333, 1_234], [59_999, 59_999]]) {
    const first = sessionCharge(startSpent(ms(0)), ms(call), prices);
    const end = sessionCharge(first.spent, ms(release), prices, "priced", true);
    assert.equal(end.spent.seconds, 60, `call at ${call} ms, release at ${release} ms`);
    assert.equal(end.spent.usd, 0.002, `call at ${call} ms, release at ${release} ms`);
    assert.equal(pico(first.usage.usage.cost.total + end.usage.usage.cost.total), end.spent.usd, "the deltas add up to the bill");
  }
});

test("a session resumed at a new price keeps the old rate for the time already billed; the minimum tops the total once", () => {
  // A host restart resumes an open session under the price it now reads: only newly elapsed time takes the new rate.
  const old = resolvePrices({ sessionUsdPerHour: 0.12 });
  const now = resolvePrices({ sessionUsdPerHour: 0.06 });
  const billed = sessionCharge(startSpent(at(0)), at(120), old);
  assert.equal(billed.spent.usd, 0.004, "120 s at $0.12 an hour");
  const resumed = sessionCharge(billed.spent, at(121), now);
  // The new second is 16,666,666.67 picodollars: 16,666,666 billed, the remainder carried on the record.
  assert.equal(resumed.spent.usd, 0.004016666666, "the earlier 120 s keep $0.004; the new second is $0.06 an hour");
  assert.equal(resumed.spent.carry, 2_400_000, "the sub-picodollar remainder rides to the next charge");
  assert.ok(resumed.usage.usage.cost.total > 0, "a charge is never negative");

  // 30 s at $0.12, then resumed at $0.06 and released at 40 s: 10 s more and the 20 s top-up at the new rate.
  const short = sessionCharge(startSpent(at(0)), at(30), old);
  const end = sessionCharge(short.spent, at(40), now, "priced", true);
  assert.deepEqual([end.spent.seconds, end.spent.usd], [60, 0.0015], "30 s at $0.12 ($0.001) and 30 s at $0.06 ($0.0005)");
});

test("the bill never depends on how many calls it was charged in: rounding is carried, so a minimum bill is exactly $0.002", () => {
  // The review's case: calls at 1 ms and 2 ms, the release at 8 ms; rounding each call alone gave $0.001999999999.
  const prices = resolvePrices({ sessionUsdPerHour: 0.12 });
  const ms = (n) => new Date(Date.UTC(2026, 9, 8, 0, 0, 0) + n).toISOString();
  for (const calls of [[1, 2], [1, 2, 3, 4, 5], [1, 4, 7, 10, 13, 16, 19], Array.from({ length: 50 }, (_, i) => 1 + 3 * i)]) {
    let spent = startSpent(ms(0));
    let charged = 0;
    for (const at of calls) { const c = sessionCharge(spent, ms(at), prices); spent = c.spent; charged += c.usage.usage.cost.total; }
    const end = sessionCharge(spent, ms(calls.at(-1) + 6), prices, "priced", true);
    assert.deepEqual([end.spent.seconds, Math.round(end.spent.usd * 1e12)], [60, 2_000_000_000], `calls at ${calls.length} instants: exactly 2,000,000,000 picodollars`);
    assert.equal(end.spent.usd, 0.002);
    assert.equal(pico(charged + end.usage.usage.cost.total), 0.002, "the calls' charges add up to the bill");
  }
});
