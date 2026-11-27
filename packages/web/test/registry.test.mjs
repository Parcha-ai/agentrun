// The provider registry (providers/registry.ts): every provider once, each made from the run's parts into what its ops
// need, and an order createWeb refuses where it names an id no provider has or a provider for a tool it does not serve.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as web from "../dist/index.js";

const parts = { pay: web.unmetered, now: () => 0 };
const IDS = ["parallel", "exa", "firecrawl", "firecrawl-keyless", "exa-keyless", "native", "direct"];

test("each provider is registered once, and made into what its ops need: a search for web_search, a read for web_fetch", () => {
  assert.deepEqual(web.PROVIDERS.map(({ id }) => id), IDS, "each once, in the registry's order");
  for (const provider of web.PROVIDERS) {
    assert.ok(provider.ops.length, `${provider.id} serves a tool`);
    assert.equal(typeof provider.label, "string");
    assert.equal(web.providerOf(provider.id), provider, `${provider.id} is the provider its id names`);
    const run = provider.make(parts);
    assert.equal(typeof run.search === "function", provider.ops.includes("search"), `${provider.id}: a search where it serves web_search, none where not`);
    assert.equal(typeof run.read === "function", provider.ops.includes("fetch"), `${provider.id}: a read where it serves web_fetch, none where not`);
    assert.equal(Boolean(provider.fetch), provider.ops.includes("fetch"), `${provider.id}: a fetch shape where it serves web_fetch`);
    if (provider.key) assert.match(provider.key.env, /^[A-Z][A-Z0-9_]*_API_KEY$/, `${provider.id}: its key is read from a variable`);
  }
  assert.deepEqual(web.PROVIDERS.filter(({ fetch }) => fetch?.ends).map(({ id }) => id), ["direct"], "one provider ends a fetch order: the guarded direct fetch");
  assert.deepEqual(web.SAID, ["parallel"], "Parallel alone says a turn the guard refused, and records every turn");
  assert.deepEqual(web.AHEAD, ["parallel", "exa", "firecrawl", "firecrawl-keyless"], "every provider asked ahead of the direct fetch says why it gave none");
  assert.deepEqual(IDS.map(web.providerName), ["Parallel", "Exa", "Firecrawl", "keyless Firecrawl", "keyless Exa", web.providerOf("native").label, "the guarded direct fetch"], "a keyless provider is named so");
});

test("an id no provider has is refused by name, never read as another provider", () => {
  assert.throws(() => web.providerOf("bing"), new RegExp(`web: no provider "bing" \\(the providers are ${IDS.join(", ")}\\)`));
  assert.equal(web.isProviderId("bing"), false);
  assert.equal(web.isProviderId("exa-keyless"), true);
  assert.equal(web.serves("bing", "search"), false);
  assert.equal(web.serves(undefined, "fetch"), false);
  assert.equal(web.serves("exa-keyless", "search"), true);
  assert.equal(web.serves("exa-keyless", "fetch"), false, "keyless Exa searches and reads nothing");
  assert.equal(web.serves("exa", "fetch"), true);
  assert.equal(web.serves("direct", "search"), false);
  assert.throws(() => web.createWeb({ order: { search: ["bing"], fetch: ["direct"] } }), /web: no provider "bing"/, "an unknown search provider is not asked as keyless Exa");
  assert.throws(() => web.createWeb({ order: { search: [], fetch: ["bing", "direct"] } }), /web: no provider "bing"/);
});

test("an order naming a provider for a tool it does not serve is refused when the Web is made", () => {
  assert.throws(() => web.createWeb({ order: { search: ["direct"], fetch: ["direct"] } }), /web: direct gives no search/);
  assert.throws(() => web.createWeb({ order: { search: [], fetch: ["exa-keyless", "direct"] } }), /web: exa-keyless gives no fetch/);
  assert.throws(() => web.createWeb({ order: { search: [], fetch: ["native"] } }), /web: native gives no fetch/);
  assert.doesNotThrow(() => web.createWeb({ order: { search: ["parallel", "exa", "firecrawl", "firecrawl-keyless", "exa-keyless", "native"], fetch: ["parallel", "exa", "firecrawl", "firecrawl-keyless", "direct"] } }));
});

test("a keyed provider made with no key sends nothing: its search and its read each say the run holds no key", async () => {
  const keyed = web.PROVIDERS.filter(({ key }) => key);
  assert.deepEqual(keyed.map(({ id, key }) => [id, key.env]), [["parallel", "PARALLEL_API_KEY"], ["exa", "EXA_API_KEY"], ["firecrawl", "FIRECRAWL_API_KEY"]]);
  for (const provider of keyed) {
    let sent = 0;
    const run = provider.make({ ...parts, send: async () => (sent++, new Response("{}")) });
    const found = await run.search({ query: "q", n: 1 }, new AbortController().signal);
    assert.match(found.answer.error ?? "", /no \w+ key/, `${provider.id}: its search`);
    const read = await run.read("https://example.com/", {});
    assert.match(read.error ?? "", /no \w+ key/, `${provider.id}: its read`);
    assert.equal(sent, 0, `${provider.id}: nothing is sent without its key`);
  }
});

test("a reader is held while its breaker holds, typed by the limit's kind, and a failed read's limit trips it", async () => {
  let now = 0;
  const breaker = web.searchBreaker(() => now);
  let reads = 0;
  const reader = web.readerOf({ read: async () => (reads++, { error: "the provider is out of quota", limit: { kind: "quota" } }) }, breaker);
  assert.equal(reader.held(), undefined, "it starts unheld");
  assert.deepEqual(await reader.read("https://example.com/", {}), { error: "the provider is out of quota", limit: { kind: "quota" } });
  const quota = { class: "quota", code: "HELD", message: "not tried: out of quota for the rest of this run" };
  assert.deepEqual(reader.held(), quota);
  now += 3_600_000;
  assert.deepEqual(reader.held(), quota, "a quota naming no reset holds for the run");
  const rate = web.readerOf({ read: async () => ({ error: "busy", limit: { kind: "rate", retryAfter: "10" } }) }, web.searchBreaker(() => now));
  await rate.read("https://example.com/", {});
  assert.deepEqual(rate.held(), { class: "rate", code: "HELD", message: "not tried: rate-limited until 01:01 UTC" }, "within a rate limit's wait, to the minute after it ends");
  assert.deepEqual(rate.holding(), { kind: "rate", until: 3_610_000 });
  now += 10_000;
  assert.equal(rate.held(), undefined, "past it");
  const noKey = { class: "refused", code: "NO_KEY", message: "not tried: no key" };
  const unready = web.readerOf({ read: async () => ({ error: "x" }), unready: () => noKey }, web.searchBreaker(() => 0));
  assert.deepEqual(unready.held(), noKey, "unready is said ahead of the breaker");
  assert.equal(reads, 1);
  assert.throws(() => web.readerOf({}, breaker), /readerOf: the provider has no read/);
});

test("each provider's settings are checked by its own entry, and a provider that takes none is named", () => {
  assert.deepEqual(web.settingsProblemsOf({ native: { x: 1 } }), ["settings name native, which takes no settings here (parallel, exa and firecrawl do)"]);
  assert.deepEqual(web.settingsProblemsOf({ exa: { type: "auto" }, parallel: { mode: "fast" }, firecrawl: { onlyMainContent: false } }), []);
  assert.equal(web.settingsProblemsOf({ exa: { pageVerbosity: "loud" } }).length, 1);
  // A setting named as one of a plain object's own members is a setting the provider does not take, never a check.
  for (const provider of ["exa", "parallel", "firecrawl"]) {
    let problems = [];
    assert.doesNotThrow(() => (problems = web.settingsProblemsOf({ [provider]: JSON.parse('{"constructor": 1, "__proto__": 2}') })), `${provider}: a settings key named constructor or __proto__ is looked up as the checks' own, never as Object's`);
    assert.equal(problems.length, 2, `${provider}: a settings key named constructor or __proto__ is reported as unknown, not run as a check`);
    assert.match(problems[0], /takes no setting "constructor"/);
    assert.match(problems[1], /takes no setting "__proto__"/);
  }
  assert.throws(() => web.createWeb({ order: { search: ["exa"], fetch: ["direct"] }, settings: { "exa-keyless": {} } }), /web settings: settings name exa-keyless, which takes no settings here/);
});

test("a setting's refused value is named by its type, never echoed: a key pasted into the wrong setting stays out of the error", () => {
  const pasted = "pasted-value-0123456789abcdef";
  const cases = [
    [{ exa: { type: pasted } }, /^Exa's type must be one of .* \(it was a string\)$/],
    [{ exa: { snippetChars: pasted } }, /^Exa's snippetChars must be a whole number from \d+ to \d+ \(it was a string\)$/],
    [{ exa: { pageLinks: [pasted] } }, /^Exa's pageLinks must be true or false \(it was a list\)$/],
    [{ parallel: { mode: { key: pasted } } }, /^Parallel's mode must be one of .* \(it was an object\)$/],
    [{ firecrawl: { onlyMainContent: 7 } }, /^Firecrawl's onlyMainContent must be true or false \(it was a number\)$/],
    [{ firecrawl: { onlyMainContent: null } }, /^Firecrawl's onlyMainContent must be true or false \(it was null\)$/],
  ];
  for (const [settings, said] of cases) {
    const problems = web.settingsProblemsOf(settings);
    assert.equal(problems.length, 1, `one problem for ${Object.keys(settings)[0]}`);
    assert.ok(!problems[0].includes(pasted.slice(0, 8)), `the refused value is not in the problem line: ${problems[0]}`);
    assert.match(problems[0], said, "the line names the setting, what it must be, and the value's type");
  }
  assert.throws(() => web.createWeb({ order: { search: ["exa"], fetch: ["direct"] }, settings: { exa: { type: pasted } } }), (error) => !String(error.message).includes(pasted.slice(0, 8)), "createWeb's error does not carry the value either");
});

test("createWeb's own refused options, pageGuard and the classifier's policy, are named by their kind, never echoed", () => {
  const pasted = "pasted-value-0123456789abcdef".repeat(40);
  const order = { search: ["exa"], fetch: ["direct"] };
  const cases = [
    [{ order, pageGuard: pasted }, TypeError, /^pageGuard must be true or false \(it was a string\)$/],
    [{ order, pageGuard: { key: pasted } }, TypeError, /^pageGuard must be true or false \(it was an object\)$/],
    [{ order, policy: pasted }, RangeError, /^the classifier's policy must be "drop", "label" or "rerank\+label" \(it was a string\)$/],
    [{ order, policy: [pasted] }, RangeError, /^the classifier's policy must be "drop", "label" or "rerank\+label" \(it was a list\)$/],
  ];
  for (const [config, type, said] of cases) {
    assert.throws(() => web.createWeb(config), (error) => {
      assert.ok(error instanceof type, `a ${type.name}`);
      assert.ok(!error.message.includes(pasted.slice(0, 8)), `the refused value is not in the error: ${error.message.slice(0, 200)}`);
      assert.match(error.message, said, "the error names the option, what it must be, and the value's kind");
      return true;
    });
  }
});
