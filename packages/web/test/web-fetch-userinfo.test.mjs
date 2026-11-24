// A URL's user name and password, wherever a provider's answer or error quotes one: kept out of the page web_fetch
// returns, the text the model reads, the receipt's turns and the log. Each error here quotes a URL holding them where
// a cut of its words ends inside them, so a cut made before the scrub would leave part of them behind. The network is a
// table (fixtures/fake-network.mjs) and each provider's send a stub: no socket leaves the machine, no real key.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWeb, firecrawlFetch, firecrawlScrape, parallelExtract, readDirect as readDirectBy, URL_MAX, webFetchText } from "../dist/index.js";
import { answers, firecrawlServer } from "./fixtures/fake-firecrawl.mjs";
import { network } from "./fixtures/fake-network.mjs";
import { fetchPage, guard, readDirect, webFetch } from "./support.mjs";

const PUBLIC = "http://public.example/";

/** PUBLIC with `path`, holding a user name and a password: synthetic, built in code. */
const credentialed = (path = "") => {
  const url = new URL(`${PUBLIC}${path}`);
  url.username = "web-user";
  url.password = "not-a-secret";
  return url.href;
};
/** PUBLIC with `path`, holding one of them alone: the user name ("username") or the password ("password"). */
const halfCredentialed = (path, part) => {
  const url = new URL(`${PUBLIC}${path}`);
  url[part] = part === "username" ? "web-user" : "not-a-secret";
  return url.href;
};
/** credentialed(path) with an "@" left unencoded in its password ("not@a-secret"): made from the text, as a URL would
 *  encode it ("%40"). */
const unencoded = (path = "") => credentialed(path).replace("not-a-secret", "not@a-secret");
/** Words quoting credentialed() after `pad` characters. */
const quoting = (pad) => `${"x".repeat(pad)}${credentialed()}`;
/** `words` cut at `cut` keeps the user name and loses the "@" after the password. */
const straddles = (words, cut) => {
  const user = words.indexOf("web-user");
  return user >= 0 && user + "web-user".length <= cut && words.indexOf("@", user) >= cut;
};
/** A send failing with `words`, as a transport's error would. */
const failing = (words) => async () => { throw new TypeError(words); };
/** The names in `where` (a name for each value) whose value holds any part of the user name or the password ("a-secret":
 *  what follows an unencoded "@" in it). */
const leaking = (where) => Object.entries(where).filter(([, what]) => /web-user|not-a-secr|a-secret/.test(typeof what === "string" ? what : JSON.stringify(what))).map(([at]) => at);
const turns = (tries) => tries.map((one) => [one.provider, one.outcome]);

/** web_fetch of `url` (PUBLIC by default) with `given` (a client, the order): the page, the receipt's turns and the log. */
async function fetched(given, url = PUBLIC) {
  const tries = [];
  const logs = [];
  const page = await webFetch(url, { ...network(), ...given, tried: (one) => tries.push(one), log: (event, fields) => logs.push({ event, fields }) });
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

test("a provider's page whose url, after a redirect, holds a user name, a password or both: the page web_fetch returns and the text the model reads name it without them", async (t) => {
  const landed = credentialed("landed");
  const scraped = { markdown: "# Landed\n\nRead after a redirect.", metadata: { title: "Landed", url: landed, sourceURL: landed, statusCode: 200 } };
  const fc = await firecrawlServer(t, (name) => (name === "firecrawl_scrape" ? { content: [{ type: "text", text: JSON.stringify(scraped) }] } : answers(name)));
  const extract = (url) => async () => new Response(JSON.stringify({ results: [{ url, title: "Landed", full_content: "Read after a redirect." }] }), { status: 200, headers: { "content-type": "application/json" } });
  // A URL drops a tab in a user name, where a scrub of text stops at it: only a url cleared as a URL loses them.
  const tabbed = landed.replace("//", "//\t");
  const rows = [
    ["firecrawl-keyless", "firecrawl-keyless", { firecrawl: firecrawlFetch({ endpoint: fc.url }) }],
    ["parallel", "parallel", { parallel: parallelExtract("not-a-secret", extract(landed)) }],
    ["parallel, a tab before the user name", "parallel", { parallel: parallelExtract("not-a-secret", extract(tabbed)) }],
    // Either one alone is cleared too: a url holding a user name with no password, or a password with no user name.
    ["parallel, a user name only", "parallel", { parallel: parallelExtract("not-a-secret", extract(halfCredentialed("landed", "username"))) }],
    ["parallel, a password only", "parallel", { parallel: parallelExtract("not-a-secret", extract(halfCredentialed("landed", "password"))) }],
  ];
  const urls = [];
  const leaks = [];
  for (const [name, provider, client] of rows) {
    const read = await fetched({ ...client, order: [provider, "direct"] });
    assert.deepEqual([read.page.ok, read.page.via, turns(read.tries)], [true, provider, [[provider, "ok"]]], `${name}: the provider read the page`);
    urls.push([name, read.page.url]);
    leaks.push(...leaking(places(name, read)));
  }
  assert.deepEqual(leaks, [], `no part of them in: ${leaks.join("; ")}`);
  assert.deepEqual(urls, rows.map(([name]) => [name, `${PUBLIC}landed`]), "the url of each page, without them");
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

// A password may hold an "@" its URL left unencoded. Each client scrubs its own error once, as text: the scrub must read
// on to the last "@" before the host. A page url that does not parse as a URL (port 99999) is no url to name.
test("a URL whose password holds an unencoded at sign: Firecrawl's scrape and Parallel's extract quote none of it in an error, and a page whose url does not parse names no url at all", async () => {
  const said = {};
  said.firecrawlScrape = await firecrawlScrape(PUBLIC, { send: failing(unencoded()) });
  said.parallelExtract = await parallelExtract("not-a-secret", failing(unencoded())).read(PUBLIC);
  const landed = unencoded("landed").replace("public.example/", "public.example:99999/");
  assert.equal(URL.canParse(landed), false, "the page url does not parse");
  const extract = async () => new Response(JSON.stringify({ results: [{ url: landed, title: "Landed", full_content: "Read after a redirect." }] }), { status: 200, headers: { "content-type": "application/json" } });
  const read = await fetched({ parallel: parallelExtract("not-a-secret", extract), order: ["parallel", "direct"] });
  assert.deepEqual([read.page.ok, read.page.via], [true, "parallel"], "Parallel read the page");
  const leaks = [...leaking(said), ...leaking(places("parallel", read))];
  assert.deepEqual(leaks, [], `no part of them in: ${leaks.join("; ")}`);
  assert.deepEqual([said.firecrawlScrape.error, said.parallelExtract, read.page.url], ["Firecrawl's fetch failed: http://public.example/", "failed: http://public.example/", ""], "each error names the URL without them, and the page whose url does not parse names none");
});

// A space in a password stops a scrub of text short of the "@", and a url holding one does not parse: a provider's page
// url that does not parse is no url to name. Firecrawl's client names the URL it was sent in place of one.
test("a provider's page url holding a user name and password behind a space, that does not parse: the page web_fetch returns names none of it", async (t) => {
  const landed = credentialed("landed").replace("not-a-secret", "not a-secret").replace("public.example/", "public.example:99999/");
  assert.equal(URL.canParse(landed), false, "the page url does not parse");
  const scraped = { markdown: "# Landed\n\nRead after a redirect.", metadata: { title: "Landed", url: landed, sourceURL: landed, statusCode: 200 } };
  const fc = await firecrawlServer(t, (name) => (name === "firecrawl_scrape" ? { content: [{ type: "text", text: JSON.stringify(scraped) }] } : answers(name)));
  const extract = async () => new Response(JSON.stringify({ results: [{ url: landed, title: "Landed", full_content: "Read after a redirect." }] }), { status: 200, headers: { "content-type": "application/json" } });
  const rows = [
    ["firecrawl-keyless", { firecrawl: firecrawlFetch({ endpoint: fc.url }) }, PUBLIC],
    ["parallel", { parallel: parallelExtract("not-a-secret", extract) }, ""],
  ];
  const urls = [];
  const leaks = [];
  for (const [provider, client] of rows) {
    const read = await fetched({ ...client, order: [provider, "direct"] });
    assert.deepEqual([read.page.ok, read.page.via], [true, provider], `${provider}: the provider read the page`);
    urls.push([provider, read.page.url]);
    leaks.push(...leaking(places(provider, read)));
  }
  assert.deepEqual(leaks, [], `no part of them in: ${leaks.join("; ")}`);
  assert.deepEqual(urls, rows.map(([provider, , url]) => [provider, url]), "Firecrawl names the URL it was sent, Parallel no url");
});

// The URL a call asks for is the model's own. While it holds a user name or password it is never fetched or sent (the
// guard's check and readDirect refuse it), and every page that answers it names it without them, whichever path gave
// the page: the direct fetch's refusal, no provider in the order, a stopped call, a part the call may not ask for.
test("the URL asked, holding a user name and password: every page web_fetch gives for it, fetched directly, read by no provider, stopped or refused for its part, names it without them", async () => {
  const asked = credentialed();
  const parallel = { live: () => true, read: async () => "asked", post: async () => { throw new Error("not posted"); } };
  const pages = {};
  pages.direct = (await fetched({ order: ["direct"] }, asked)).page;
  pages.none = (await fetched({ parallel, order: ["parallel"] }, asked)).page;
  pages.stopped = (await fetched({ order: ["direct"], signal: AbortSignal.abort() }, asked)).page;
  pages["part refused"] = (await createWeb({ order: { search: [], fetch: ["direct"] }, guard }).fetch(asked, { maxChars: 1 })).answer;
  // The root's own direct reads, called as a library is: the page each refuses with names the URL without them too.
  pages.fetchPage = await fetchPage(asked, network());
  pages.readDirect = await readDirect(asked, network());
  assert.deepEqual(Object.entries(pages).map(([row, page]) => [row, page.ok, page.via]), [["direct", false, "direct"], ["none", false, "none"], ["stopped", false, "stopped"], ["part refused", false, undefined], ["fetchPage", false, undefined], ["readDirect", false, undefined]], "no page was read");
  const leaks = Object.entries(pages).flatMap(([row, page]) => leaking({ [`${row}: the page`]: page, [`${row}: the text the model reads`]: webFetchText(page) }));
  assert.deepEqual(leaks, [], `no part of them in: ${leaks.join("; ")}`);
  assert.deepEqual(Object.entries(pages).map(([row, page]) => [row, page.url]), Object.keys(pages).map((row) => [row, PUBLIC]), "the url of each page, without them");
});

// An asked URL that does not parse is no URL to name: a scrub of its text stops at a space, so a page names none.
test("the URL asked, holding a user name and password behind a space, that does not parse: every page web_fetch gives for it names no url at all", async () => {
  const asked = credentialed().replace("not-a-secret", "not a-secret").replace("public.example/", "public.example:99999/");
  assert.equal(URL.canParse(asked), false, "the URL asked does not parse");
  const parallel = { live: () => true, read: async () => "asked", post: async () => { throw new Error("not posted"); } };
  const pages = {};
  pages.direct = (await fetched({ order: ["direct"] }, asked)).page;
  pages.none = (await fetched({ parallel, order: ["parallel"] }, asked)).page;
  pages.stopped = (await fetched({ order: ["direct"], signal: AbortSignal.abort() }, asked)).page;
  pages["part refused"] = (await createWeb({ order: { search: [], fetch: ["direct"] }, guard }).fetch(asked, { maxChars: 1 })).answer;
  pages.fetchPage = await fetchPage(asked, network());
  pages.readDirect = await readDirect(asked, network());
  assert.deepEqual(Object.entries(pages).map(([row, page]) => [row, page.ok, page.via]), [["direct", false, "direct"], ["none", false, "none"], ["stopped", false, "stopped"], ["part refused", false, undefined], ["fetchPage", false, undefined], ["readDirect", false, undefined]], "no page was read");
  const leaks = Object.entries(pages).flatMap(([row, page]) => leaking({ [`${row}: the page`]: page, [`${row}: the text the model reads`]: webFetchText(page) }));
  assert.deepEqual(leaks, [], `no part of them in: ${leaks.join("; ")}`);
  assert.deepEqual(Object.entries(pages).map(([row, page]) => [row, page.url]), Object.keys(pages).map((row) => [row, ""]), "no page names a url");
});

// A provider names the URL it ended at, and its client cuts that url at URL_MAX. A password running past the cut leaves
// no "@" for a later scrub to find, and the cut url no longer parses: each client clears them before its cut.
test("a provider's page url whose password runs past where a url is cut: Firecrawl's scrape, Parallel's extract and the page web_fetch returns name it without any part of them", async (t) => {
  const landed = credentialed("landed").replace("not-a-secret", `not-a-secret${"x".repeat(URL_MAX)}`);
  assert.ok(landed.indexOf("not-a-secret") < URL_MAX && landed.indexOf("@") > URL_MAX, "the cut of the url ends inside them");
  const scraped = { markdown: "# Landed\n\nRead after a redirect.", metadata: { title: "Landed", url: landed, sourceURL: landed, statusCode: 200 } };
  const fc = await firecrawlServer(t, (name) => (name === "firecrawl_scrape" ? { content: [{ type: "text", text: JSON.stringify(scraped) }] } : answers(name)));
  const extract = async () => new Response(JSON.stringify({ results: [{ url: landed, title: "Landed", full_content: "Read after a redirect." }] }), { status: 200, headers: { "content-type": "application/json" } });
  const rows = [
    ["firecrawl-keyless", "firecrawlScrape", { firecrawl: firecrawlFetch({ endpoint: fc.url }) }, () => firecrawlScrape(PUBLIC, { endpoint: fc.url })],
    ["parallel", "parallelExtract", { parallel: parallelExtract("not-a-secret", extract) }, () => parallelExtract("not-a-secret", extract).read(PUBLIC)],
  ];
  const urls = [];
  const leaks = [];
  for (const [provider, client, given, own] of rows) {
    const read = await fetched({ ...given, order: [provider, "direct"] });
    assert.deepEqual([read.page.ok, read.page.via], [true, provider], `${provider}: the provider read the page`);
    const page = await own();
    assert.equal(page.ok, true, `${client}: a page`);
    leaks.push(...leaking({ ...places(provider, read), [`${client}: the url`]: page.url }));
    urls.push([provider, read.page.url], [client, page.url]);
  }
  assert.deepEqual(leaks, [], `no part of them in: ${leaks.join("; ")}`);
  assert.deepEqual(urls, rows.flatMap(([provider, client]) => [[provider, `${PUBLIC}landed`], [client, `${PUBLIC}landed`]]), "the url of each page, without them");
});

// A client web_fetch is given is the caller's, and may hand back a page url it never cleared. Left uncut, web_fetch's
// own scrub clears it.
test("a client's page whose url holds a user name and password, uncut: the page web_fetch returns and the text the model reads name it without them", async () => {
  const page = async () => ({ ok: true, url: credentialed(), status: 200, title: "", text: "x", beyond: false, length: 1, links: [] });
  const rows = [
    ["firecrawl-keyless", { firecrawl: { live: () => true, read: page } }],
    ["parallel", { parallel: { live: () => true, read: page, post: async () => { throw new Error("not posted"); } } }],
  ];
  const urls = [];
  const leaks = [];
  for (const [provider, client] of rows) {
    const read = await fetched({ ...client, order: [provider, "direct"] });
    assert.deepEqual([read.page.ok, read.page.via, turns(read.tries)], [true, provider, [[provider, "ok"]]], `${provider} client: it read the page`);
    urls.push([provider, read.page.url]);
    leaks.push(...leaking({ [`${provider} client: the page`]: read.page, [`${provider} client: the text the model reads`]: webFetchText(read.page) }));
  }
  assert.deepEqual(leaks, [], `no part of them in: ${leaks.join("; ")}`);
  assert.deepEqual(urls, rows.map(([provider]) => [provider, PUBLIC]), "the url of each page, without them");
});

// The guard readDirect is given is the caller's: the url its fetch says it ended at is cleared before it is cut, read
// or failed. pi-browser's guard never ends at one (undici refuses the hop), so a stub stands in for it.
test("the direct read's page url, where the guard's fetch ended at one holding a user name and password: readDirect names it without them, read or failed", async () => {
  const ended = (status, body) => ({ fetch: async () => ({ url: credentialed(), status, body, contentType: "text/plain" }), check: async () => undefined });
  const pages = {};
  pages.read = await readDirectBy(PUBLIC, ended(200, "x"));
  pages.failed = await readDirectBy(PUBLIC, ended(404, null));
  assert.deepEqual(Object.entries(pages).map(([row, page]) => [row, page.ok, page.status]), [["read", true, 200], ["failed", false, 404]], "the guard's answers");
  const leaks = Object.entries(pages).flatMap(([row, page]) => leaking({ [`readDirect, ${row}: the page`]: page }));
  assert.deepEqual(leaks, [], `no part of them in: ${leaks.join("; ")}`);
  assert.deepEqual(Object.entries(pages).map(([row, page]) => [row, page.url]), [["read", PUBLIC], ["failed", PUBLIC]], "the url of each page, without them");
});
