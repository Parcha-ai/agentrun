// A run's web_search breaker read against a fake clock (searchBreaker), and keyless Exa's limit as it reads it
// (exaLimitOf). Out of quota: every later call answers that search is unavailable for the rest of the run. Rate-limited:
// every call answers that search is busy for the seconds left of the wait the provider named (Retry-After, in seconds
// or as an HTTP date), or 60 s when it named none. The cases that bind a run's web_search through serve's tools stay in
// serve's web-search-breaker test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { exaLimitOf } from "../dist/providers/exa-keyless.js";
import { RATE_LIMITED } from "../dist/providers/mcp.js";
import * as webSearch from "../dist/search.js";

/** What every web_search call of a run answers once its provider said the run is out of quota. */
const UNAVAILABLE = "search is unavailable for the rest of this run; answer from what you have";
/** What a call answers while a rate limit's wait holds, `n` seconds of it left. */
const BUSY = /^search is busy; try again in (\d+) s, or answer from what you have$/;

test("the breaker read against a fake clock: a rate limit's wait passes at its end, and a quota answer naming no reset holds past any wait", () => {
  assert.equal(typeof webSearch.searchBreaker, "function", "the run's breaker, made with a clock");
  let now = Date.parse("2026-11-15T12:00:00Z");
  const fail = { error: "the provider's search failed" };
  const found = { provider: "parallel", query: "q", results: [] };
  const words = (held) => held?.error;
  const breaker = webSearch.searchBreaker(() => now);
  assert.equal(breaker.held(), undefined, "it starts closed");
  assert.deepEqual(breaker.read({ answer: fail, limit: { kind: "rate" } }), fail, "the call's own answer passes");
  assert.equal(words(breaker.held()), "search is busy; try again in 60 s, or answer from what you have");
  now += 59_500;
  assert.equal(words(breaker.held()), "search is busy; try again in 1 s, or answer from what you have", "rounded up, at least 1");
  now += 1_500;
  assert.equal(breaker.held(), undefined, "61 s on, the next call asks the provider");
  breaker.read({ answer: found });
  assert.equal(breaker.held(), undefined, "a success leaves it closed");
  // Quota beats a rate limit: off for the rest of the run, whatever wait passes.
  breaker.read({ answer: fail, limit: { kind: "quota" } });
  assert.equal(words(breaker.held()), UNAVAILABLE);
  now += 61_000;
  assert.equal(words(breaker.held()), UNAVAILABLE, "61 s on, still off");
  breaker.read({ answer: fail, limit: { kind: "rate", retryAfter: "1" } });
  now += 3_600_000;
  assert.equal(words(breaker.held()), UNAVAILABLE, "an hour on, still off");
  // Retry-After as the provider hands it back: seconds, an HTTP date, a number of seconds (Exa's), or words that read as none.
  for (const [retryAfter, n] of [["2", 2], [new Date(now + 90_000).toUTCString(), 90], [7, 7], ["900", 900], ["soon", 60]]) {
    const one = webSearch.searchBreaker(() => now);
    one.read({ answer: fail, limit: { kind: "rate", retryAfter } });
    assert.equal(words(one.held()), `search is busy; try again in ${n} s, or answer from what you have`, String(retryAfter));
  }
  // A date already passed: no wait at all.
  const passed = webSearch.searchBreaker(() => now);
  passed.read({ answer: fail, limit: { kind: "rate", retryAfter: new Date(now - 10_000).toUTCString() } });
  assert.equal(passed.held(), undefined);
});

test("a wait past 15 minutes is a spent count with its reset (keyless Exa's 429 naming 65,796 s): off and unasked until the wait ends, then asked again; the call says unavailable, never to try again", () => {
  let now = Date.parse("2026-11-24T05:43:24Z");
  const limited = { error: RATE_LIMITED };
  const daily = webSearch.exaLimitOf({ error: RATE_LIMITED, limit: "rate_limited", retryAfterS: 65_796 });
  const breaker = webSearch.searchBreaker(() => now);
  assert.deepEqual(breaker.read({ answer: limited, limit: daily }), { error: UNAVAILABLE });
  assert.deepEqual([breaker.off(), breaker.held()?.error], [true, UNAVAILABLE]);
  now += 65_795_999;
  assert.deepEqual([breaker.off(), breaker.held()?.error], [true, UNAVAILABLE], "a millisecond before its end");
  now += 1;
  assert.deepEqual([breaker.off(), breaker.held()], [false, undefined], "at its end the next call asks");
  // Past 15 minutes by a second, or an HTTP date days off: off for that long. 15 minutes itself is still a wait.
  for (const [retryAfter, ms] of [[901, 901_000], [new Date(now + 3 * 86_400_000).toUTCString(), 3 * 86_400_000]]) {
    const one = webSearch.searchBreaker(() => now);
    assert.deepEqual(one.read({ answer: limited, limit: { kind: "rate", retryAfter } }), { error: UNAVAILABLE }, String(retryAfter));
    const start = now;
    now = start + ms - 1;
    assert.equal(one.held()?.error, UNAVAILABLE, String(retryAfter));
    now = start + ms;
    assert.equal(one.held(), undefined, String(retryAfter));
    now = start;
  }
  // A quota that names its reset keeps the call's own answer, and is off until the reset.
  const quota = webSearch.searchBreaker(() => now);
  const refused = { error: "the provider's free daily limit is spent" };
  assert.deepEqual(quota.read({ answer: refused, limit: { kind: "quota", retryAfter: 3_600 } }), refused);
  now += 3_599_999;
  assert.equal(quota.held()?.error, UNAVAILABLE);
  now += 1;
  assert.equal(quota.held(), undefined);
});

test("two calls in flight rate-limited at nearly the same time: a shorter wait never shrinks a longer one, so a call between their ends is still held, unsent", () => {
  let now = Date.parse("2026-11-15T12:00:00Z");
  const fail = { error: "the provider's search failed" };
  const breaker = webSearch.searchBreaker(() => now);
  // The first answers Retry-After 60, the second, back a moment later, Retry-After 2.
  breaker.read({ answer: fail, limit: { kind: "rate", retryAfter: "60" } });
  now += 50;
  breaker.read({ answer: fail, limit: { kind: "rate", retryAfter: "2" } });
  // 3 s on, past the short wait and inside the long one: held (the call answers this and asks no provider).
  now += 2_950;
  const held = breaker.held();
  assert.ok(held, "3 s on, the call is still held: a held call is answered unsent");
  const n = Number(BUSY.exec(held.error)?.[1]);
  assert.ok(n >= 56 && n <= 57, `about 57 s left: ${held.error}`);
  // A longer wait still lengthens it, and a quota answer still turns search off whatever the wait.
  breaker.read({ answer: fail, limit: { kind: "rate", retryAfter: "120" } });
  assert.equal(breaker.held()?.error, "search is busy; try again in 120 s, or answer from what you have");
  now += 121_000;
  assert.equal(breaker.held(), undefined, "past the longest wait, the next call asks the provider");
  breaker.read({ answer: fail, limit: { kind: "quota" } });
  assert.equal(breaker.held()?.error, UNAVAILABLE);
});

// Keyless Exa answers its daily count running out as the same RATE_LIMITED, naming no wait. A second one after a wait
// has passed, in the same run, is that count: search is off for the rest of the run. Its limit says so (repeatIsQuota,
// the server's mark, set on keyless Exa's alone, and only on a limit naming no wait: a 429 with Retry-After is a timed
// limit, exaLimitOf).
const EXA_RATE = () => ({ kind: "rate", repeatIsQuota: true });

test("keyless Exa's daily cap: busy for 60 s after its first RATE_LIMITED, the call past the wait asks Exa again, and a second RATE_LIMITED then turns search off for the run", () => {
  let now = Date.parse("2026-11-15T19:00:00Z");
  const fail = { error: "the provider's search failed" };
  const breaker = webSearch.searchBreaker(() => now);
  breaker.read({ answer: fail, limit: EXA_RATE() });
  assert.equal(breaker.held()?.error, "search is busy; try again in 60 s, or answer from what you have");
  now += 61_000;
  assert.equal(breaker.held(), undefined, "61 s on, the next call reaches Exa");
  // The call that turns search off answers so itself, never Exa's "try again in a minute".
  assert.deepEqual(breaker.read({ answer: { error: RATE_LIMITED }, limit: EXA_RATE() }), { error: UNAVAILABLE }, "the second RATE_LIMITED after the wait answers search is unavailable");
  assert.equal(breaker.held()?.error, UNAVAILABLE, "a second RATE_LIMITED after the wait: off for the run, unsent");
  now += 200_000;
  assert.equal(breaker.held()?.error, UNAVAILABLE, "200 s on, still off");
});

test("keyless Exa: two RATE_LIMITED answers within one open wait (in flight together) only hold it; a success between two waits resets the count, so the next is a wait again", () => {
  let now = Date.parse("2026-11-15T19:00:00Z");
  const fail = { error: "the provider's search failed" };
  const found = { provider: "exa-keyless", query: "q", results: [] };
  const flight = webSearch.searchBreaker(() => now);
  flight.read({ answer: fail, limit: EXA_RATE() });
  now += 200;
  flight.read({ answer: fail, limit: EXA_RATE() });
  assert.match(flight.held()?.error ?? "", BUSY, "two in flight: busy, never off");
  now += 61_000;
  assert.equal(flight.held(), undefined, "past the wait, the next call reaches Exa");
  // A success means the daily count is not spent: a transient limit at minute 5 and another at minute 50, with good
  // searches between, are two waits, never search off for the run.
  const transient = webSearch.searchBreaker(() => now);
  transient.read({ answer: fail, limit: EXA_RATE() });
  now += 61_000;
  assert.equal(transient.held(), undefined);
  transient.read({ answer: found });
  assert.equal(transient.held(), undefined, "a success leaves it closed");
  now += 45 * 60_000;
  transient.read({ answer: fail, limit: EXA_RATE() });
  assert.equal(transient.held()?.error, "search is busy; try again in 60 s, or answer from what you have", "a wait again, not off");
  // With no success since, the next one past that wait is the daily count.
  now += 61_000;
  assert.equal(transient.held(), undefined);
  assert.deepEqual(transient.read({ answer: { error: RATE_LIMITED }, limit: EXA_RATE() }), { error: UNAVAILABLE });
  assert.equal(transient.held()?.error, UNAVAILABLE, "the next RATE_LIMITED after a completed wait, no success since, turns it off");
  // A failure that is no limit (a 5xx) is no success: it does not reset the count.
  const failed = webSearch.searchBreaker(() => now);
  failed.read({ answer: fail, limit: EXA_RATE() });
  now += 61_000;
  failed.read({ answer: fail });
  assert.deepEqual(failed.read({ answer: { error: RATE_LIMITED }, limit: EXA_RATE() }), { error: UNAVAILABLE });
  assert.equal(failed.held()?.error, UNAVAILABLE, "a failed search between is no success");
});

test("a quota answer keeps the call's own answer: its words name no retry, and a hosted search's results found before it stay", () => {
  const breaker = webSearch.searchBreaker(() => Date.parse("2026-11-15T19:00:00Z"));
  const found = { provider: "native", query: "q", results: [{ url: "https://example.com/", title: "t", snippet: "s" }] };
  assert.deepEqual(breaker.read({ answer: found, limit: { kind: "quota" } }), found);
  assert.equal(breaker.held()?.error, UNAVAILABLE);
});

test("a rate limit not keyless Exa's (Parallel's 429, a hosted search's) that repeats after its wait still just waits again", () => {
  let now = Date.parse("2026-11-15T19:00:00Z");
  const fail = { error: "the provider's search failed" };
  const breaker = webSearch.searchBreaker(() => now);
  for (let round = 0; round < 3; round++) {
    breaker.read({ answer: fail, limit: { kind: "rate" } });
    assert.equal(breaker.held()?.error, "search is busy; try again in 60 s, or answer from what you have", `round ${round}`);
    now += 61_000;
    assert.equal(breaker.held(), undefined, `round ${round}: past the wait, the next call asks`);
  }
});

test("keyless Exa's limit as the breaker reads it: the daily count's answer, naming no wait, is marked repeatIsQuota; a 429 that names its wait is a timed limit, unmarked; a refused connection is no limit", () => {
  assert.equal(typeof exaLimitOf, "function", "the server's reading of keyless Exa's refusal");
  assert.deepEqual(exaLimitOf({ error: RATE_LIMITED, limit: "rate_limited" }), { kind: "rate", repeatIsQuota: true });
  assert.deepEqual(exaLimitOf({ error: RATE_LIMITED, limit: "rate_limited", retryAfterS: 2 }), { kind: "rate", retryAfter: 2 });
  assert.equal(exaLimitOf({ error: "refused", limit: "connection_refused" }), undefined);
});
