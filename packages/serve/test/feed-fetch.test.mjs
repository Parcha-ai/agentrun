// A feed's read (feed/fetch.ts readFeed), on a fake network: the address check the MCP servers' requests are held to
// (mcp-oauth.ts), with plain http allowed on a public address alone (a private host the owner allows stays https); each
// redirect checked again, at most 5; a conditional read on the last ETag and Last-Modified, a 304 handed back with no
// body; the body read to 5 MB at most.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FEED_MAX_BYTES, readFeed } from "../dist/feed/fetch.js";

/** A network whose names resolve as `names` says and whose answers are `answers`' by URL (a function of the request),
 *  each request recorded with the address it was dialled at. */
function network(names, answers) {
  const sent = [];
  const answer = (url, init, address) => {
    sent.push({ url, address, headers: Object.fromEntries(new Headers(init.headers ?? {})) });
    const made = answers[url];
    if (!made) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    return Promise.resolve(typeof made === "function" ? made(init) : made());
  };
  return { sent, net: { lookup: async (host) => names[host] ?? [], local: () => [], fetch: answer, dial: answer } };
}
const ok = (body, headers = {}) => () => new Response(body, { status: 200, headers });
const moved = (to, status = 302) => () => new Response(null, { status, headers: { location: to } });

test("plain http reads a feed on a public address, dialled at the address checked, conditional on the last ETag and Last-Modified; a 304 comes back with no body", async () => {
  const { sent, net } = network({ "feeds.example": ["93.184.216.34"] }, {
    "http://feeds.example/rss": (init) => (new Headers(init.headers).get("if-none-match") === '"v1"' ? new Response(null, { status: 304 }) : new Response("<rss/>", { status: 200, headers: { etag: '"v1"', "last-modified": "Mon, 01 Jun 2026 00:00:00 GMT" } })),
  });
  const first = await readFeed("http://feeds.example/rss", {}, { network: net, reach: {} });
  assert.deepEqual(first, { status: 200, body: "<rss/>", etag: '"v1"', modified: "Mon, 01 Jun 2026 00:00:00 GMT" });
  assert.equal(sent[0].address, "93.184.216.34");
  const again = await readFeed("http://feeds.example/rss", { etag: first.etag, modified: first.modified }, { network: net, reach: {} });
  assert.deepEqual(again, { status: 304 });
  assert.deepEqual([sent[1].headers["if-none-match"], sent[1].headers["if-modified-since"]], ['"v1"', "Mon, 01 Jun 2026 00:00:00 GMT"]);
});

test("a private address is refused, http or https; a private host the owner allows is read over https alone; a URL that isn't http(s) is refused", async () => {
  const { sent, net } = network({ "inside.example": ["10.0.0.5"], "intra.example": ["10.1.2.3"] }, { "https://intra.example/feed": ok("{}") });
  for (const url of ["http://inside.example/feed", "https://inside.example/feed", "https://10.0.0.5/feed"]) {
    await assert.rejects(readFeed(url, {}, { network: net, reach: {} }), /private (address|network)/, url);
  }
  assert.equal((await readFeed("https://intra.example/feed", {}, { network: net, reach: { allowed: ["intra.example"] } })).status, 200);
  await assert.rejects(readFeed("http://intra.example/feed", {}, { network: net, reach: { allowed: ["intra.example"] } }), /private address; refused/);
  await assert.rejects(readFeed("ftp://feeds.example/rss", {}, { network: net, reach: {} }), /not http|refused/);
  assert.deepEqual(sent.map((one) => one.url), ["https://intra.example/feed"], "nothing else was sent");
});

test("each redirect is checked as the first URL is, at most 5: one to a private address is refused, a sixth is refused", async () => {
  const names = { "a.example": ["93.184.216.34"], "inside.example": ["10.0.0.5"] };
  const { net: toPrivate } = network(names, { "https://a.example/feed": moved("http://inside.example/feed") });
  await assert.rejects(readFeed("https://a.example/feed", {}, { network: toPrivate, reach: {} }), /private address/);
  const hops = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`https://a.example/${i}`, i < 6 ? moved(`https://a.example/${i + 1}`, 301) : ok("<feed/>")]));
  const { net: far } = network(names, hops);
  await assert.rejects(readFeed("https://a.example/0", {}, { network: far, reach: {} }), /more than 5 redirects/);
  const near = network(names, { ...hops, "https://a.example/1": ok("<feed/>") });
  assert.deepEqual((await readFeed("https://a.example/0", {}, { network: near.net, reach: {} })).body, "<feed/>");
});

test("a body over 5 MB is refused, read no further", async () => {
  assert.equal(FEED_MAX_BYTES, 5 * 1024 * 1024);
  const { net } = network({ "big.example": ["93.184.216.34"] }, { "https://big.example/feed": ok(new Uint8Array(FEED_MAX_BYTES + 1)) });
  await assert.rejects(readFeed("https://big.example/feed", {}, { network: net, reach: {} }), /more than 5 MB/);
});

test("plain http to a private address is refused before a byte is sent: a private IP, the metadata address, a redirect from a public http feed to it, and a private host the owner allows (https only there)", async () => {
  const names = { "feeds.example": ["93.184.216.34"], "intra.example": ["10.1.2.3"] };
  const { sent, net } = network(names, {
    "http://feeds.example/rss": moved("http://169.254.169.254/latest/meta-data/"),
    "http://feeds.example/hop": moved("http://feeds.example/rss", 301),
  });
  for (const url of ["http://10.0.0.5/feed", "http://192.168.1.10/feed", "http://169.254.169.254/latest/meta-data/", "http://[::1]:8080/feed"]) {
    await assert.rejects(readFeed(url, {}, { network: net, reach: {} }), /private|link-local|refused/, url);
  }
  await assert.rejects(readFeed("http://feeds.example/rss", {}, { network: net, reach: {} }), /169\.254\.169\.254.*refused|private|link-local/);
  await assert.rejects(readFeed("http://feeds.example/hop", {}, { network: net, reach: {} }), /169\.254\.169\.254.*refused|private|link-local/, "two hops in, still checked");
  await assert.rejects(readFeed("http://intra.example/feed", {}, { network: net, reach: { allowed: ["intra.example"] } }), /private address; refused/);
  assert.deepEqual(sent.map((one) => one.url), ["http://feeds.example/rss", "http://feeds.example/hop", "http://feeds.example/rss"], "only the public feed was asked; nothing went to a private or metadata address");
});
