// The guarded direct fetch: one public web page as a Page, through the public-host guard serve injects (support.mjs:
// pi-browser's). The network here is a table (no socket): every hostile target must be refused before it is dialled,
// and the public page must answer. serve's web-fetch-direct.test.mjs holds the same of an agentic run and a call node.
import assert from "node:assert/strict";
import { test } from "node:test";
import { network } from "./fixtures/fake-network.mjs";
import { fetchPage } from "./support.mjs";

/** Every target that must be refused, and whether a first hop is dialled before the refusal (a redirect's). */
const HOSTILE = [
  ["http://127.0.0.1:9421/v1/models", false],
  ["http://127.0.0.1/", false],
  ["http://localhost:8080/", false],
  ["http://localhost/", false],
  ["http://public.example:8080/", false],
  ["http://app.localhost/", false],
  ["http://localhost./", false],
  ["http://metadata.internal./", false],
  ["http://169.254.169.254/latest/meta-data/", false], // key-gate: denylist a private target the guard must refuse
  ["http://10.0.0.1/", false], // key-gate: denylist a private target the guard must refuse
  ["http://172.16.0.1/", false], // key-gate: denylist a private target the guard must refuse
  ["http://192.168.1.1/", false], // key-gate: denylist a private target the guard must refuse
  ["http://100.64.0.1/", false], // key-gate: denylist a private target the guard must refuse
  ["http://[::1]/", false],
  ["http://[fc00::1]/", false], // key-gate: denylist a private target the guard must refuse
  ["http://[::ffff:127.0.0.1]/", false],
  ["http://2130706433/", false],
  ["http://0x7f.0.0.1/", false],
  ["http://0177.0.0.1/", false],
  ["http://[::ffff:7f00:1]/", false],
  ["http://evil.example/", false],
  ["http://mixed.example/", false],
  ["http://redirect.example/", true],
  ["http://renamed.example/", true],
  ["file:///etc/passwd", false],
  ["data:text/html,<h1>hi</h1>", false],
  ["ftp://public.example/", false],
];

const PUBLIC = {
  ok: true, url: "http://public.example/", status: 200, title: "Public page",
  links: ["http://public.example/about", "https://other.example/x"],
};
/** A page less its text and `chars`, which is checked to be the text's length. */
const textless = ({ text, chars, ...rest }) => (assert.equal(chars, text.length, "chars, the length of the text"), rest);

test("the tool refuses every private, local and non-http(s) target before it is dialled, a redirect's next hop too; a public page answers", async () => {
  for (const [url, firstHop] of HOSTILE) {
    const net = network();
    const page = await fetchPage(url, net);
    assert.equal(page.ok, false, url);
    assert.match(page.refused ?? "", /^refused: /, `${url}: ${JSON.stringify(page)}`);
    assert.equal(page.error, undefined, url);
    assert.deepEqual(net.dialled, firstHop ? [url] : [], `${url} dials nothing private`);
  }
  const net = network();
  const page = await fetchPage("http://public.example/", net);
  assert.deepEqual(textless(page), PUBLIC, "the title, and each http(s) link once, absolute, without its fragment; no mailto");
  assert.match(page.text, /The answer is forty-two\./);
  assert.deepEqual(net.dialled, ["http://public.example/"]);
  assert.deepEqual(await fetchPage("http://public.example/notes.txt", network()), { ok: true, url: "http://public.example/notes.txt", status: 200, title: "", text: "Plain notes.", chars: 12, links: [] });
  assert.match((await fetchPage("http://public.example/image.png", network())).refused, /image\/png is not text/);
  assert.equal((await fetchPage("http://public.example:8080/", network())).refused, "refused: port 8080 is not 80 or 443", "a public host on another port");
  for (const url of ["http://public.example:80/", "http://public.example:443/", "https://public.example:443/"]) assert.notEqual((await fetchPage(url, network())).refused?.startsWith("refused: port"), true, url);
  assert.deepEqual(await fetchPage("http://public.example/missing", network()), { ok: false, url: "http://public.example/missing", status: 404, title: "", text: "", links: [], error: "the page answered 404" });
  assert.deepEqual(await fetchPage("not a url", network()), { ok: false, url: "not a url", status: 0, title: "", text: "", links: [], error: "url is not an absolute URL" });
  const zoned = network();
  const zone = "http://[fe80::1%25eth0]/"; // key-gate: denylist a link-local address with a zone id, which no URL may name
  assert.equal((await fetchPage(zone, zoned)).error, "url is not an absolute URL", "a v6 zone id is no URL");
  assert.deepEqual(zoned.dialled, []);
  assert.match((await fetchPage("http://nowhere.example/", network())).error, /ENOTFOUND/);
});

test("a URL on a port other than 80 or 443 is refused before its host is looked up or dialled", async () => {
  const net = network();
  const looked = [];
  const lookup = (host, ...rest) => (looked.push(host), net.lookup(host, ...rest));
  const page = await fetchPage("http://public.example:8080/", { ...net, lookup });
  assert.equal(page.refused, "refused: port 8080 is not 80 or 443");
  assert.deepEqual(looked, [], "no lookup for a port it refuses");
});

/** The fake network, with `body` served as `type` at `url`. */
function serving(url, type, body) {
  const net = network();
  return { ...net, fetchImpl: async (asked, init) => (asked.href === url ? new Response(body, { status: 200, headers: { "content-type": type } }) : net.fetchImpl(asked, init)) };
}

test("a page that is not HTML lists the absolute URLs its text holds: a JSON body's string values, a text body's URLs", async () => {
  const incidents = JSON.stringify({ page: { url: "https://www.githubstatus.com" }, incidents: [{ name: "Degraded Actions", shortlink: "https://stspg.io/abc", note: "see https://www.githubstatus.com/incidents/x1#update and mailto:help@github.example", relative: "/incidents/x1" }] });
  const json = await fetchPage("http://public.example/api/v2/incidents.json", serving("http://public.example/api/v2/incidents.json", "application/json", incidents));
  assert.equal(json.ok, true, JSON.stringify(json));
  assert.deepEqual(json.links, ["https://www.githubstatus.com/", "https://stspg.io/abc", "https://www.githubstatus.com/incidents/x1"], "each once, in the body's order, without its fragment; no mailto or relative path");
  assert.equal(json.text, incidents, "the text is the body as it came");
  // A body that is one JSON string is read as JSON too: its escapes undone, and a URL whole kept whole.
  const { linksOf } = await import("../dist/index.js");
  assert.deepEqual([...linksOf(String.raw`"https:\/\/stspg.io\/abc"`)], ["https://stspg.io/abc"]);
  assert.deepEqual([...linksOf('"https://en.example/wiki/Yahoo!"')], ["https://en.example/wiki/Yahoo!"]);
  const notes = "Status: https://status.example/a, then (https://en.wikipedia.org/wiki/Foo_(bar)) and 'https://b.example/O'Reilly'.";
  const text = await fetchPage("http://public.example/status.txt", serving("http://public.example/status.txt", "text/plain", notes));
  assert.deepEqual(text.links, ["https://status.example/a", "https://en.wikipedia.org/wiki/Foo_(bar)", "https://b.example/O'Reilly"], "a sentence's punctuation, an unopened bracket and a closing quote stay outside a URL");
});

test("the URLs a hostile text writes out are read in one pass: runs of schemes, closing brackets and nesting take no longer than their length", async () => {
  const { linksOf } = await import("../dist/index.js");
  const hostile = (n) => ["https://".repeat(n / 8), `https://a.example/${")".repeat(n)}`, `https://a.example/${"(".repeat(n)}${".".repeat(n)}`, `${"[".repeat(n / 80)}"https://deep.example/"${"]".repeat(n / 80)}`, `${"](".repeat(n / 2)} https://after.example/`, `<f${" a='".repeat(n / 4)}`, `<f${" a=".repeat(n / 3)}`, `<f a="${"&amp;".repeat(n / 5)}`];
  const n = 400_000;
  const large = hostile(n);
  assert.deepEqual(large.slice(1, 5).map((text) => [...linksOf(text)]), [["https://a.example/"], [`https://a.example/${"(".repeat(n)}`], ["https://deep.example/"], ["https://after.example/"]]);
  // The time is checked as a ratio, never against a clock: a loaded runner slows both sizes alike, while a pass that
  // rereads the text takes a hundred times as long for ten times the length. Each size keeps its fastest of three reads,
  // taken in turn so a burst of load lands on both.
  const small = hostile(n / 10);
  const read = (texts) => {
    const started = performance.now();
    for (const text of texts) [...linksOf(text)];
    return performance.now() - started;
  };
  let fast = Infinity;
  let slow = Infinity;
  for (let i = 0; i < 3; i++) {
    fast = Math.min(fast, read(small));
    slow = Math.min(slow, read(large));
  }
  assert.ok(slow < 30 * fast, `ten times the text took ${(slow / fast).toFixed(1)} times as long (${Math.round(fast)} ms, then ${Math.round(slow)} ms), not under 30`);
});

/** A GitHub releases.atom, as github.com serves it: each entry's link in an attribute, its content escaped HTML. */
const RELEASES_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US">
  <id>tag:github.com,2008:https://github.com/vitejs/vite/releases</id>
  <link type="text/html" rel="alternate" href="https://github.com/vitejs/vite/releases?q=v8&amp;expanded=true"/>
  <title>Release notes from vite</title>
  <entry>
    <id>tag:github.com,2008:Repository/257485422/v8.2.6</id>
    <link rel="alternate" type="text/html" href="https://github.com/vitejs/vite/releases/tag/v8.2.6"/>
    <title>v8.2.6</title>
    <content type="html">&lt;p&gt;See &lt;a href=&quot;https://github.com/vitejs/vite/blob/v8.2.6/CHANGELOG.md&quot;&gt;the changelog&lt;/a&gt;.&lt;/p&gt;</content>
  </entry>
</feed>`;

test("an Atom feed lists its entries' links: an attribute's URL, and its escaped content's, with XML's entities undone", async () => {
  const url = "http://public.example/vitejs/vite/releases.atom";
  const page = await fetchPage(url, serving(url, "application/atom+xml; charset=utf-8", RELEASES_ATOM));
  assert.equal(page.ok, true, JSON.stringify(page));
  // A single-quoted attribute ends at its quote too, and an entity in it is undone.
  const { linksOf } = await import("../dist/index.js");
  assert.deepEqual([...linksOf("<feed><link href='https://example.com/release'/><link href = 'https://example.com/a?x=1&amp;y=O&apos;Reilly'/></feed>")], ["https://example.com/release", "https://example.com/a?x=1&y=O%27Reilly"], "an apostrophe in a query, as the URL standard writes it");
  // An attribute named in any script is read so too.
  assert.deepEqual([...linksOf("<feed><link é:href='https://example.com/ns'/></feed>")], ["https://example.com/ns"]);
  // A double-quoted attribute is left as it is, an "='" in its query too.
  assert.deepEqual([...linksOf(`<feed><link href="https://example.com/?q='hello'&amp;x=1"/></feed>`)], ["https://example.com/?q=%27hello%27&x=1"]);
  // Every URL the body writes out, the one in its tag URI's id too; its namespace's name is an identifier, not a link.
  assert.deepEqual(page.links, ["https://github.com/vitejs/vite/releases", "https://github.com/vitejs/vite/releases?q=v8&expanded=true", "https://github.com/vitejs/vite/releases/tag/v8.2.6", "https://github.com/vitejs/vite/blob/v8.2.6/CHANGELOG.md"]);
});

test("a releases.atom entry's links are its <link href> and its escaped content's pull URL, exactly: no entity runs into a link", async () => {
  const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xml:lang="en-US">
  <entry>
    <id>tag:github.com,2008:Repository/257485422/v8.2.6</id>
    <link rel="alternate" type="text/html" href="https://github.com/vitejs/vite/releases/tag/v8.2.6"/>
    <title>v8.2.6</title>
    <content type="html">&lt;ul&gt;&lt;li&gt;fix: &lt;a href=&quot;https://github.com/vitejs/vite/pull/123&quot;&gt;#123&lt;/a&gt; by &lt;a class=&quot;user-mention&quot;&gt;someone&lt;/a&gt;&lt;/li&gt;&lt;/ul&gt;</content>
  </entry>
</feed>`;
  const url = "http://public.example/vitejs/vite/releases.atom";
  const page = await fetchPage(url, serving(url, "application/atom+xml; charset=utf-8", atom));
  assert.deepEqual(page.links, ["https://github.com/vitejs/vite/releases/tag/v8.2.6", "https://github.com/vitejs/vite/pull/123"], "a namespace's name is not a link");
  assert.equal(page.links.some((link) => link.includes("&quot;") || link.includes("%22")), false);
});

test("an HTML page's links stay its link targets alone, as before: a URL written in its text is not one", async () => {
  const html = `<html><head><title>Public page</title></head><body><p>Mirror: https://bare.example/x</p><a href="/about">About</a> <a href="https://other.example/x#part">Other</a></body></html>`;
  const page = await fetchPage("http://public.example/", serving("http://public.example/", "text/html; charset=utf-8", html));
  assert.equal(JSON.stringify(page.links), '["http://public.example/about","https://other.example/x"]');
});
