// What the model reads from web_search while a provider is held to a reset it named (a keyless daily allowance spent
// host-wide, a 429 naming hours to midnight). Never an empty result list, which reads as "nothing exists": every
// provider held answers an error naming each provider and the time it may be asked again; one provider held while the
// one after it found nothing answers an error saying both. A quota naming no reset keeps SEARCH_UNAVAILABLE. Backends
// here are fakes; createWeb's holds are the ones serve hands a run's Web at its start.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWeb, searchBreaker, searchInTurn } from "../dist/index.js";
import { SEARCH_UNAVAILABLE } from "../dist/search.js";

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
