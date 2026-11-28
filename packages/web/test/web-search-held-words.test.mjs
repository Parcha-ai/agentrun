// What the model reads from web_search while a provider is held to a reset it named (a keyless daily allowance spent
// host-wide, a 429 naming hours to midnight). Never an empty result list, which reads as "nothing exists": every
// provider held answers an error naming each provider and the time it may be asked again; one provider held while the
// one after it found nothing answers an error saying both. A quota naming no reset keeps SEARCH_UNAVAILABLE. Backends
// here are fakes; createWeb's holds are the ones serve hands a run's Web at its start.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWeb, searchBreaker, searchInTurn } from "../dist/index.js";
import { SEARCH_UNAVAILABLE, withKeyBreaker } from "../dist/search.js";

const NOW = Date.parse("2026-11-28T03:40:00Z");
const MIDNIGHT = "2026-11-29T00:00:00Z";
const SECONDS_TO_MIDNIGHT = (Date.parse(MIDNIGHT) - NOW) / 1000;

const breakersAt = (now) => {
  const made = new Map();
  return (name) => made.get(name) ?? made.set(name, searchBreaker(() => now)).get(name);
};
const limited = (name, limit) => ({ name, ask: async () => ({ answer: { error: `${name} said no` }, limit }) });
const nothing = (name) => ({ name, ask: async () => ({ answer: { provider: name, objective: "q", queries: ["q"], results: [] } }) });
const found = (name) => ({ name, ask: async () => ({ answer: { provider: name, objective: "q", queries: ["q"], results: [{ url: "https://a.example/", title: "A", snippet: "a" }] } }) });

test("every provider held to a named reset: an error naming each provider and its reset, never an empty list", async () => {
  const breakerOf = breakersAt(NOW);
  const backends = [limited("firecrawl-keyless", { kind: "quota", retryAfter: SECONDS_TO_MIDNIGHT }), limited("exa-keyless", { kind: "rate", retryAfter: SECONDS_TO_MIDNIGHT })];
  for (const call of ["the call that met both limits", "the next call, both held"]) {
    const answer = await searchInTurn(backends, breakerOf);
    assert.ok("error" in answer, `${call}: an error, not a result list: ${JSON.stringify(answer)}`);
    assert.match(answer.error, /firecrawl-keyless is out of quota until 2026-11-29T00:00:00Z/, call);
    assert.match(answer.error, /exa-keyless is rate-limited until 2026-11-29T00:00:00Z/, call);
    assert.doesNotMatch(answer.error, /rest of this run/, `${call}: the hold ends at its reset`);
  }
});

test("one provider held while the one after it found nothing: an error saying both, never a bare empty list", async () => {
  const breakerOf = breakersAt(NOW);
  await searchInTurn([limited("firecrawl-keyless", { kind: "quota", retryAfter: SECONDS_TO_MIDNIGHT })], breakerOf);
  const answer = await searchInTurn([limited("firecrawl-keyless", { kind: "quota" }), nothing("exa-keyless")], breakerOf);
  assert.ok("error" in answer, `an error, not a result list: ${JSON.stringify(answer)}`);
  assert.match(answer.error, /exa-keyless found no results/);
  assert.match(answer.error, /firecrawl-keyless is out of quota until 2026-11-29T00:00:00Z/);
});

test("one provider held, the next one with results: its results, as before", async () => {
  const breakerOf = breakersAt(NOW);
  await searchInTurn([limited("firecrawl-keyless", { kind: "quota", retryAfter: SECONDS_TO_MIDNIGHT })], breakerOf);
  const answer = await searchInTurn([limited("firecrawl-keyless", { kind: "quota" }), found("exa-keyless")], breakerOf);
  assert.equal(answer.provider, "exa-keyless");
  assert.equal(answer.results.length, 1);
});

test("no provider held, the only one finding nothing: the empty answer, as before", async () => {
  const answer = await searchInTurn([nothing("exa-keyless")], breakersAt(NOW));
  assert.deepEqual(answer.results, []);
});

test("a quota naming no reset keeps SEARCH_UNAVAILABLE", async () => {
  const breakerOf = breakersAt(NOW);
  const backends = [limited("firecrawl-keyless", { kind: "quota" }), limited("exa-keyless", { kind: "quota" })];
  assert.deepEqual(await searchInTurn(backends, breakerOf), { error: SEARCH_UNAVAILABLE });
  assert.deepEqual(await searchInTurn(backends, breakerOf), { error: SEARCH_UNAVAILABLE });
});

test("one provider held while the one asked found nothing: the receipt names the provider asked and keeps its fee, as with nothing held", async () => {
  const until = Date.parse(MIDNIGHT);
  const run = async (order, holds) => {
    const sent = { parallel: 0, exa: 0 };
    const nothingFound = (id) => async () => {
      sent[id] += 1;
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const web = createWeb({ order: { search: order, fetch: [] }, keys: { parallel: "not-a-secret", exa: "not-a-secret" }, holds, send: { parallel: nothingFound("parallel"), exa: nothingFound("exa") }, now: () => NOW });
    return { ...(await web.search({ objective: "Who founded Framework?", queries: ["framework founder"] })), sent };
  };
  const alone = await run(["parallel"], []);
  const held = await run(["parallel", "exa"], [{ provider: "exa", tool: "key", kind: "quota", until }]);
  assert.deepEqual(alone.answer.results, [], "nothing held: the empty answer");
  assert.match(held.answer.error, /parallel found no results, and exa is out of quota until 2026-11-29T00:00:00Z/);
  assert.deepEqual([held.sent, alone.sent], [{ parallel: 1, exa: 0 }, { parallel: 1, exa: 0 }], "one search sent either way; the held provider never asked");
  assert.equal(held.receipt.provider, "parallel", "the receipt names the provider that was asked and found nothing");
  assert.ok(alone.receipt.cost.usd > 0, "Parallel's search carries a fee");
  assert.deepEqual(held.receipt.cost, alone.receipt.cost, "the same fee line as the search with nothing held");
  assert.deepEqual(held.receipt.tries.map(({ provider, outcome }) => [provider, outcome]), [["parallel", "empty"], ["exa", "held"]]);
});

test("one provider waiting out a short rate limit while the next found nothing: an error naming the wait, never a bare empty list", async () => {
  const breakerOf = breakersAt(NOW);
  await searchInTurn([limited("firecrawl-keyless", { kind: "rate", retryAfter: 30 })], breakerOf);
  const answer = await searchInTurn([limited("firecrawl-keyless", { kind: "rate" }), nothing("exa-keyless")], breakerOf);
  assert.ok("error" in answer, `an error, not a result list: ${JSON.stringify(answer)}`);
  assert.match(answer.error, /exa-keyless found no results, and firecrawl-keyless is rate-limited until 2026-11-28T03:40:30Z/);
});

test("a breaker held by two limits names the one that ends last", () => {
  const short = { kind: "rate", until: NOW + 30_000 };
  const midnight = { kind: "quota", until: Date.parse(MIDNIGHT) };
  const holdingOf = (limits, now = NOW) => {
    const breaker = searchBreaker(() => now);
    for (const limit of limits) breaker.read({ answer: { error: "held" }, limit });
    return breaker.holding();
  };
  // A key out of quota until midnight behind a 30-second search wait: the provider runs again at midnight, not in 30 s.
  const keyed = (own, key) => withKeyBreaker(own, key).holding();
  const own = searchBreaker(() => NOW);
  own.read({ answer: { error: "held" }, limit: { kind: "rate", retryAfter: 30 } });
  const key = searchBreaker(() => NOW);
  key.read({ answer: { error: "held" }, limit: { kind: "quota", retryAfter: SECONDS_TO_MIDNIGHT } });
  assert.deepEqual(keyed(own, key), midnight, "search wait 30 s, key off until midnight");
  assert.deepEqual(keyed(key, own), midnight, "the same, either way round");
  // One breaker off until a minute from now and waiting ten: it may be asked again in ten.
  assert.deepEqual(holdingOf([{ kind: "quota", retryAfter: 60 }, { kind: "rate", retryAfter: 600 }]), { kind: "rate", until: NOW + 600_000 });
  assert.deepEqual(holdingOf([{ kind: "rate", retryAfter: 30 }]), short, "a wait alone, as before");
});

test("a run's Web with a short search wait and its key out until midnight: web_search names the key's reset", async () => {
  const until = Date.parse(MIDNIGHT);
  const nothingFound = async () => new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
  const unsent = async () => {
    throw new Error("a held provider was asked");
  };
  const web = createWeb({
    order: { search: ["parallel", "exa"], fetch: [] },
    keys: { parallel: "not-a-secret", exa: "not-a-secret" },
    holds: [{ provider: "exa", tool: "search", kind: "rate", until: NOW + 30_000 }, { provider: "exa", tool: "key", kind: "quota", until }],
    send: { parallel: nothingFound, exa: unsent },
    now: () => NOW,
  });
  const { answer } = await web.search({ objective: "Who founded Framework?", queries: ["framework founder"] });
  assert.ok("error" in answer, JSON.stringify(answer));
  assert.match(answer.error, /parallel found no results, and exa is out of quota until 2026-11-29T00:00:00Z/);
  assert.doesNotMatch(answer.error, /03:40:30Z/, "not the 30-second wait");
});

test("a run's Web started with the server's keyless holds: web_search names each provider and its reset, unsent", async () => {
  const until = Date.parse(MIDNIGHT);
  const unsent = async () => {
    throw new Error("a held provider was asked");
  };
  const web = createWeb({
    order: { search: ["firecrawl-keyless", "exa-keyless"], fetch: [] },
    holds: [{ provider: "firecrawl-keyless", tool: "key", kind: "quota", until }, { provider: "exa-keyless", tool: "key", kind: "rate", until }],
    send: { "firecrawl-keyless": unsent, "exa-keyless": unsent },
    now: () => NOW,
  });
  const { answer } = await web.search({ objective: "Who founded Framework?", queries: ["framework founder"] });
  assert.ok("error" in answer, JSON.stringify(answer));
  assert.match(answer.error, /firecrawl-keyless is out of quota until 2026-11-29T00:00:00Z/);
  assert.match(answer.error, /exa-keyless is rate-limited until 2026-11-29T00:00:00Z/);
});
