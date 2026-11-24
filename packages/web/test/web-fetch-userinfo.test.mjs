// A URL's user name and password, wherever a provider's answer or error quotes one: kept out of the page web_fetch
// returns, the text the model reads, the receipt's turns and the log. Each error here quotes a URL holding them where
// a cut of its words ends inside them, so a cut made before the scrub would leave part of them behind. The network is a
// table (fixtures/fake-network.mjs) and each provider's send a stub: no socket leaves the machine, no real key.
import assert from "node:assert/strict";
import { test } from "node:test";
import { firecrawlFetch, firecrawlScrape, parallelExtract, webFetchText } from "../dist/index.js";
import { answers, firecrawlServer } from "./fixtures/fake-firecrawl.mjs";
import { network } from "./fixtures/fake-network.mjs";
import { fetchPage, readDirect, webFetch } from "./support.mjs";

const PUBLIC = "http://public.example/";

/** PUBLIC with `path`, holding a user name and a password: synthetic, built in code. */
const credentialed = (path = "") => {
  const url = new URL(`${PUBLIC}${path}`);
  url.username = "web-user";
  url.password = "not-a-secret";
  return url.href;
};
/** Words quoting credentialed() after `pad` characters. */
const quoting = (pad) => `${"x".repeat(pad)}${credentialed()}`;
/** `words` cut at `cut` keeps the user name and loses the "@" after the password. */
const straddles = (words, cut) => {
  const user = words.indexOf("web-user");
  return user >= 0 && user + "web-user".length <= cut && words.indexOf("@", user) >= cut;
};
/** A send failing with `words`, as a transport's error would. */
const failing = (words) => async () => { throw new TypeError(words); };
/** The names in `where` (a name for each value) whose value holds any part of the user name or the password. */
const leaking = (where) => Object.entries(where).filter(([, what]) => /web-user|not-a-secr/.test(typeof what === "string" ? what : JSON.stringify(what))).map(([at]) => at);
const turns = (tries) => tries.map((one) => [one.provider, one.outcome]);

/** web_fetch of PUBLIC with `given` (a client, the order): the page, the receipt's turns and the log. */
async function fetched(given) {
  const tries = [];
  const logs = [];
  const page = await webFetch(PUBLIC, { ...network(), ...given, tried: (one) => tries.push(one), log: (event, fields) => logs.push({ event, fields }) });
  return { page, tries, logs };
}
/** Where a fetch by `provider` could quote them: the receipt's turns, the page, the text the model reads, the log. */
const places = (provider, { page, tries, logs }) => ({ [`${provider}: the receipt turns`]: tries, [`${provider}: the page`]: page, [`${provider}: the text the model reads`]: webFetchText(page), [`${provider}: the log`]: logs });

test("an error a provider gives that quotes a URL with a user name and password past where it is cut: no part of them reaches the receipt's turns, the page the model reads, or the log", async () => {
  // Firecrawl's client keeps these words whole after its "failed: "; web_fetch cuts what Firecrawl said at 300.
  const firecrawlWords = quoting(250);
  assert.ok(straddles(`Firecrawl's fetch failed: ${firecrawlWords}`, 300), "the cut of what Firecrawl said ends inside them");
  // Parallel's client cuts these words at 200 after its "failed: ".
  const parallelWords = quoting(180);
  assert.ok(straddles(parallelWords, 200), "the cut of Parallel words ends inside them");
  const rows = [
    ["firecrawl-keyless", { firecrawl: firecrawlFetch({ send: failing(firecrawlWords) }) }],
    ["parallel", { parallel: parallelExtract("not-a-secret", failing(parallelWords)) }],
  ];
  const leaks = [];
  for (const [provider, client] of rows) {
    const read = await fetched({ ...client, order: [provider, "direct"] });
    assert.deepEqual(turns(read.tries), [[provider, "error"], ["direct", "ok"]], `${provider}: the turns`);
    assert.match(read.tries[0].error, /failed: x{100}/, `${provider}: the turn says it failed`);
    leaks.push(...leaking(places(provider, read)));
  }
  assert.deepEqual(leaks, [], `no part of them in: ${leaks.join("; ")}`);
});

test("a provider's page whose url, after a redirect, holds a user name and password: the page web_fetch returns and the text the model reads name it without them", async (t) => {
  const landed = credentialed("landed");
  const scraped = { markdown: "# Landed\n\nRead after a redirect.", metadata: { title: "Landed", url: landed, sourceURL: landed, statusCode: 200 } };
  const fc = await firecrawlServer(t, (name) => (name === "firecrawl_scrape" ? { content: [{ type: "text", text: JSON.stringify(scraped) }] } : answers(name)));
  const extract = async () => new Response(JSON.stringify({ results: [{ url: landed, title: "Landed", full_content: "Read after a redirect." }] }), { status: 200, headers: { "content-type": "application/json" } });
  const rows = [
    ["firecrawl-keyless", { firecrawl: firecrawlFetch({ endpoint: fc.url }) }],
    ["parallel", { parallel: parallelExtract("not-a-secret", extract) }],
  ];
  const urls = [];
  const leaks = [];
  for (const [provider, client] of rows) {
    const read = await fetched({ ...client, order: [provider, "direct"] });
    assert.deepEqual([read.page.ok, read.page.via, turns(read.tries)], [true, provider, [[provider, "ok"]]], `${provider}: the provider read the page`);
    urls.push([provider, read.page.url]);
    leaks.push(...leaking(places(provider, read)));
  }
  assert.deepEqual(leaks, [], `no part of them in: ${leaks.join("; ")}`);
  assert.deepEqual(urls, rows.map(([provider]) => [provider, `${PUBLIC}landed`]), "the url of each page, without them");
});

// undici's fetch builds a Request for each hop, and Request refuses a URL holding a user name or password with an error
// that quotes the URL whole. The transport here builds one too (Node's Request is undici's), so the words are undici's.
test("the root's own reads quote no user name or password from an error: fetchPage and readDirect redirected to one, Firecrawl's scrape and Parallel's extract failing with one past their cut", async () => {
  const moved = `${PUBLIC}moved`;
  const net = network();
  const fetchImpl = async (url, init) => {
    new Request(url);
    if (String(url) === moved) return new Response(null, { status: 302, headers: { location: credentialed() } });
    return net.fetchImpl(url, init);
  };
  const said = {};
  for (const [name, read] of [["fetchPage", fetchPage], ["readDirect", readDirect]]) {
    const page = await read(moved, { lookup: net.lookup, fetchImpl });
    assert.equal(page.ok, false, `${name}: no page`);
    said[name] = page;
  }
  // Firecrawl's scrape cuts the transport's words at 300, Parallel's extract at 200.
  const scrapeWords = quoting(280);
  assert.ok(straddles(scrapeWords, 300), "the cut of Firecrawl words ends inside them");
  said.firecrawlScrape = await firecrawlScrape(PUBLIC, { send: failing(scrapeWords) });
  assert.match(said.firecrawlScrape.error ?? "", /^Firecrawl's fetch failed: x{280}/, "the scrape failed");
  said.parallelExtract = await parallelExtract("not-a-secret", failing(quoting(180))).read(PUBLIC);
  assert.match(said.parallelExtract, /^failed: x{180}/, "the extract failed");
  const leaks = leaking(said);
  assert.deepEqual(leaks, [], `no part of them in: ${leaks.join("; ")}`);
  for (const name of ["fetchPage", "readDirect"]) assert.match(said[name].error ?? "", /includes credentials: http:\/\/public\.example\/$/, `${name}: the refusal of undici, its URL without them`);
});

// A client web_fetch is given is the caller's: what it says is scrubbed whole in web_fetch, then cut.
test("an error any client gives that quotes a URL with a user name and password is scrubbed whole and then cut: neither the receipt, the page nor the log holds any part of them", async () => {
  const words = quoting(280);
  assert.ok(straddles(words, 300), "the cut of what Firecrawl said ends inside them");
  const firecrawl = { live: () => true, read: async () => words };
  const parallel = { live: () => true, read: async () => `failed: ${credentialed()}`, post: async () => { throw new Error("not posted"); } };
  const leaks = [];
  const said = [];
  for (const [provider, client] of [["firecrawl-keyless", { firecrawl }], ["parallel", { parallel }]]) {
    const read = await fetched({ ...client, order: [provider, "direct"] });
    assert.deepEqual(turns(read.tries), [[provider, "error"], ["direct", "ok"]], `${provider}: the turns`);
    leaks.push(...leaking(places(provider, read)));
    said.push(read.tries[0].error.slice(-30));
  }
  assert.deepEqual(leaks, [], `no part of them in: ${leaks.join("; ")}`);
  assert.deepEqual(said, [`${"x".repeat(10)}http://public.exampl`, "failed: http://public.example/"], "what each said, the URL without them, cut after the scrub");
});

// The run's other calls can turn Parallel off (a 401 or 403 to its key) while the guard checks this URL for it.
test("Parallel turned off while the guard checks the URL is not asked: the page says it was refused earlier in this run", async () => {
  const net = network();
  let live = true;
  const asked = [];
  const parallel = { live: () => live, read: async (url) => (asked.push(url), "asked after it was turned off"), post: async () => { throw new Error("not posted"); } };
  const lookup = async (host) => ((live = false), net.lookup(host));
  const { page, tries } = await fetched({ parallel, order: ["parallel", "direct"], lookup });
  assert.deepEqual(asked, [], "Parallel was not asked");
  assert.deepEqual([page.via, page.parallel], ["direct", "not tried: refused earlier in this run"], "the page says why");
  assert.deepEqual(turns(tries), [["parallel", "error"], ["direct", "ok"]], "the turns");
});
