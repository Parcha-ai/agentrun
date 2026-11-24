// The marketplace's templates (GET /v2/templates/marketplace, GRE-4834): the list marketplace.agentrun.ai publishes
// (/search.json) read when asked, kept 5 minutes, one read at a time, the last good list kept through a failed read,
// each entry checked field by field, and each matched to the package here that it is. Off under --faux unless
// AGENTRUN_MARKETPLACE names an address. A fake marketplace on loopback stands in for the site: no test reaches it.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { entryOf, hereOf, listOf, Marketplace, MARKETPLACE_LIMITS, MARKETPLACE_RETRY_MS, MARKETPLACE_TTL_MS, MARKETPLACE_URL, marketplaceUrlOf } from "../dist/marketplace.js";
import { serve } from "./support.mjs";

const SITE = "https://market.example";
const SHA = "c".repeat(40);
const LIST = [
  { name: "kyb", title: "KYB due diligence", description: "Checks a business.", category: "compliance", tags: ["kyb"], url: "/templates/kyb/", needs: ["Requires web search"], source: `github:Parcha-ai/agentrun/packages/serve/templates/kyb@${SHA}` },
  { name: "company-brief", title: "Company research brief", summary: "A one-page brief on a company.", category: "research", tags: ["research", "Bad Tag"], url: "/templates/company-brief/", needs: [], source: `github:Parcha-ai/agentrun-templates/templates/company-brief@${SHA}` },
];

/** A fake marketplace on loopback: answers /search.json with `answer()` ({status, body, headers}), counting reads. */
async function fakeMarketplace(t, answer) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers["user-agent"]}`);
    const { status = 200, body = LIST, headers = {} } = answer();
    res.writeHead(status, { "content-type": "application/json", ...headers }).end(typeof body === "string" ? body : JSON.stringify(body));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

test("AGENTRUN_MARKETPLACE: unset, the public marketplace (none under --faux); off turns it off; an https address, or http on loopback, reads that site; anything else stops the start", () => {
  assert.equal(marketplaceUrlOf({}, false), MARKETPLACE_URL);
  assert.equal(marketplaceUrlOf({}, true), null, "a --faux server reaches no network unasked");
  assert.equal(marketplaceUrlOf({ AGENTRUN_MARKETPLACE: "  " }, false), MARKETPLACE_URL);
  for (const off of ["off", "OFF", "0", "false", "no"]) assert.equal(marketplaceUrlOf({ AGENTRUN_MARKETPLACE: off }, false), null, off);
  assert.equal(marketplaceUrlOf({ AGENTRUN_MARKETPLACE: "https://market.example/" }, true), "https://market.example", "an address is read under --faux too");
  assert.equal(marketplaceUrlOf({ AGENTRUN_MARKETPLACE: "https://example.com/market/" }, false), "https://example.com/market");
  assert.equal(marketplaceUrlOf({ AGENTRUN_MARKETPLACE: "http://127.0.0.1:7420" }, false), "http://127.0.0.1:7420");
  // An address with a user and password in it, built from its parts (a literal one reads as a credential to the source export).
  const withUser = `https://${["u", "p"].join(":")}@market.example`;
  for (const bad of ["marketplace.agentrun.ai", "htps://market.example", "http://market.example", withUser, "https://market.example/?x=1", "https://market.example/#top"]) {
    assert.throws(() => marketplaceUrlOf({ AGENTRUN_MARKETPLACE: bad }, false), /AGENTRUN_MARKETPLACE=.*off/, bad);
  }
});

test("an entry is kept by its name: each other field of its shape is kept, one not of its shape dropped, and the list keeps the marketplace's order with each name once", () => {
  assert.deepEqual(entryOf(LIST[0], SITE), { name: "kyb", title: "KYB due diligence", description: "Checks a business.", category: "compliance", tags: ["kyb"], needs: ["Requires web search"], page_url: `${SITE}/templates/kyb/`, source: LIST[0].source });
  assert.deepEqual(entryOf({ name: "x-y", title: "", category: "astrology", tags: ["ok", "Not OK", 3, "ok"], url: "https://evil.example/templates/x-y/", needs: ["a", "", 4], source: "https://evil.example/pkg", summary: "line\none\u0007" }, SITE),
    { name: "x-y", title: "x-y", summary: "line one", tags: ["ok"], needs: ["a"], page_url: `${SITE}/templates/x-y/` }, "an empty title is its name; an unknown category, a bad tag, an off-site page and a source that is no package's are dropped");
  assert.deepEqual(entryOf({ name: "x", harness: ["claude-agent", "pi", "Not A Harness", 3, "pi"] }, SITE).harness, ["claude-agent", "pi"], "harnesses keep their order, each once, ids of a harness's shape only");
  assert.deepEqual(entryOf({ name: "x", harness: [] }, SITE).harness, [], "an empty list is any harness, and kept");
  assert.equal("harness" in entryOf({ name: "x" }, SITE), false, "a list that does not say leaves it out");
  assert.equal("harness" in entryOf({ name: "x", harness: "pi" }, SITE), false, "one that is not a list too");
  assert.equal(entryOf({ name: "x", url: "//evil.example/x" }, SITE).page_url, `${SITE}/templates/x/`, "a protocol-relative page is off the site");
  assert.equal(entryOf({ name: "x", description: "d".repeat(5000) }, SITE).description.length, 2000, "a long description is cut");
  for (const bad of [null, "kyb", [], { name: "Not A Name" }, { name: "a".repeat(65) }, { title: "no name" }]) assert.equal(entryOf(bad, SITE), undefined, JSON.stringify(bad));
  assert.deepEqual(listOf([{ name: "b" }, { name: "bad name" }, { name: "a" }, { name: "b", title: "second" }], SITE).map((e) => [e.name, e.title]), [["b", "b"], ["a", "a"]]);
  assert.throws(() => listOf({ templates: [] }, SITE), /not a list/);
  assert.equal(listOf(Array.from({ length: MARKETPLACE_LIMITS.entries + 5 }, (_, i) => ({ name: `t${i}` })), SITE).length, MARKETPLACE_LIMITS.entries);
});

test("an entry is the package here whose source it names, or a bundled one where this server's own packages live; with no source, the package of its name, a bundled one first", () => {
  const packages = [
    { id: "kyb", name: "kyb", origin: null },
    { id: "github:Parcha-ai/agentrun-templates/templates/company-brief", name: "company-brief", origin: { source: "x" } },
    { id: "github:someone/else/release-notes", name: "release-notes", origin: { source: "y" } },
  ];
  assert.equal(hereOf({ name: "kyb", source: `github:Parcha-ai/agentrun/packages/serve/templates/kyb@${SHA}` }, packages), "kyb");
  assert.equal(hereOf({ name: "company-brief", source: `github:Parcha-ai/agentrun-templates/templates/company-brief@${SHA}` }, packages), packages[1].id);
  assert.equal(hereOf({ name: "kyb", source: "github:someone/else/kyb@main" }, packages), undefined, "another publisher's kyb is not the bundled one");
  assert.equal(hereOf({ name: "release-notes", source: `github:Parcha-ai/agentrun-templates/templates/release-notes@${SHA}` }, packages), undefined, "nor is another source's package of the same name");
  assert.equal(hereOf({ name: "kyb" }, packages), "kyb");
  assert.equal(hereOf({ name: "release-notes" }, packages), packages[2].id, "with no source, its name");
  assert.equal(hereOf({ name: "market-monitor" }, packages), undefined);
});

test("a read is kept 5 minutes and shared by callers at once; a failed read keeps the last good list (stale) and is tried again after a minute; with none, it is unreachable", async () => {
  let clock = Date.parse("2026-11-24T00:00:00Z");
  let reads = 0;
  let answer = () => new Response(JSON.stringify(LIST), { status: 200 });
  const market = new Marketplace(SITE, { now: () => clock, fetchImpl: async (url, init) => { reads++; assert.equal(url, `${SITE}/search.json`); assert.equal(init.redirect, "manual"); return answer(); } });

  const [a, b] = await Promise.all([market.list(), market.list()]);
  assert.equal(reads, 1, "callers at once share one read");
  assert.deepEqual([a.state, a.read_at, a.templates.map((e) => e.name)], ["read", "2026-11-24T00:00:00.000Z", ["kyb", "company-brief"]]);
  assert.deepEqual(b, a);
  clock += MARKETPLACE_TTL_MS - 1;
  assert.equal((await market.list()).state, "read");
  assert.equal(reads, 1, "kept 5 minutes");

  clock += 1;
  answer = () => new Response("down", { status: 503 });
  const stale = await market.list();
  assert.equal(reads, 2);
  assert.deepEqual([stale.state, stale.read_at, stale.templates.length], ["stale", "2026-11-24T00:00:00.000Z", 2]);
  assert.match(stale.problem, /answered 503/);
  clock += MARKETPLACE_RETRY_MS - 1;
  assert.equal((await market.list()).state, "stale");
  assert.equal(reads, 2, "a failed read is not tried again for a minute");
  clock += 1;
  answer = () => new Response(JSON.stringify([LIST[1]]), { status: 200 });
  const back = await market.list();
  assert.deepEqual([back.state, back.problem, back.templates.map((e) => e.name)], ["read", undefined, ["company-brief"]]);

  const never = new Marketplace(SITE, { fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  const none = await never.list();
  assert.deepEqual([none.state, none.read_at, none.templates], ["unreachable", null, []]);
  assert.match(none.problem, /could not be reached: fetch failed/);

  const off = await new Marketplace(null).list();
  assert.deepEqual([off.state, off.url, off.templates], ["off", null, []]);
});

test("a read refuses a redirect, an answer over its bytes, and one that is not JSON, each in words", async () => {
  const once = async (res) => (await new Marketplace(SITE, { fetchImpl: async () => res }).list()).problem;
  assert.match(await once(new Response(null, { status: 302, headers: { location: "https://elsewhere.example/search.json" } })), /sent its list elsewhere \(302 to https:\/\/elsewhere\.example\/search\.json\): set AGENTRUN_MARKETPLACE/);
  assert.match(await once(new Response("[]", { status: 200, headers: { "content-length": String(MARKETPLACE_LIMITS.bytes + 1) } })), /over the \d+ this server reads/);
  const big = new ReadableStream({ start(c) { for (let i = 0; i < 5; i++) c.enqueue(new Uint8Array(1 << 20)); c.close(); } });
  assert.match(await once(new Response(big, { status: 200 })), /over the \d+ bytes this server reads/, "counted as it comes, with no length said");
  assert.match(await once(new Response("<html>", { status: 200 })), /not JSON/);
});

test("a read that never answers, or answers and then stalls, ends at the deadline (unreachable, or stale over the last good list) and is tried again after a minute", { timeout: 10_000 }, async () => {
  // The timeout: a read with no deadline would wait on these servers for ever, so the test fails rather than hangs.
  let clock = Date.parse("2026-11-24T00:00:00Z");
  // A server that never sends its headers: the fetch ends only when the read's signal does, as a real one would.
  const silent = (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  // A server that sends its headers and one chunk, then nothing: the body errors when the signal aborts, as a real one's does.
  const stalled = (_url, init) => Promise.resolve(new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("[")); init.signal.addEventListener("abort", () => c.error(init.signal.reason), { once: true }); } }), { status: 200 }));
  let fetchImpl = silent;
  const market = new Marketplace(SITE, { now: () => clock, deadlineMs: 50, fetchImpl: (url, init) => fetchImpl(url, init) });

  const silentRead = await market.list();
  assert.deepEqual([silentRead.state, silentRead.templates], ["unreachable", []]);
  assert.match(silentRead.problem, /did not answer in 0\.05 s/);

  clock += MARKETPLACE_RETRY_MS;
  fetchImpl = async () => new Response(JSON.stringify(LIST), { status: 200 });
  assert.equal((await market.list()).state, "read", "tried again after a minute, and read");

  clock += MARKETPLACE_TTL_MS;
  fetchImpl = stalled;
  const stalledRead = await market.list();
  assert.deepEqual([stalledRead.state, stalledRead.templates.length], ["stale", LIST.length], "the last good list is kept");
  assert.match(stalledRead.problem, /did not finish its list in 0\.05 s/);

  clock += MARKETPLACE_RETRY_MS;
  fetchImpl = async () => new Response(JSON.stringify([LIST[0]]), { status: 200 });
  assert.equal((await market.list()).templates.length, 1, "and tried again after a minute");
});

test("GET /v2/templates/marketplace answers the marketplace's list with the package here that each is, read once for callers within 5 minutes; off and unreachable answer 200 with an empty list", { timeout: 60_000 }, async (t) => {
  let answer = () => ({});
  const market = await fakeMarketplace(t, () => answer());
  const { api } = await serve(t, { marketplace: market.url, runner: false });
  const read = await api("GET", "/templates/marketplace");
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual([read.body.url, read.body.state, typeof read.body.read_at], [market.url, "read", "string"]);
  assert.deepEqual(read.body.templates.map((e) => [e.name, e.here ?? null, e.page_url]), [["kyb", "kyb", `${market.url}/templates/kyb/`], ["company-brief", null, `${market.url}/templates/company-brief/`]]);
  assert.deepEqual(read.body.templates[1].tags, ["research"]);
  assert.equal((await api("GET", "/templates/marketplace")).status, 200);
  assert.deepEqual(market.seen, ["GET /search.json agentrun-serve"], "read once, as agentrun-serve, and kept");
  assert.equal((await api("GET", "/templates/kyb")).body.template.id, "kyb", "a template's own route still answers");

  const { api: offApi } = await serve(t, { marketplace: null, runner: false });
  const off = await offApi("GET", "/templates/marketplace");
  assert.deepEqual([off.status, off.body.state, off.body.templates], [200, "off", []]);

  const { api: fauxApi } = await serve(t, { runner: false });
  assert.equal((await fauxApi("GET", "/templates/marketplace")).body.state, "off", "--faux reads no marketplace unasked");

  answer = () => ({ status: 500, body: "boom" });
  const down = await fakeMarketplace(t, () => answer());
  const { api: downApi } = await serve(t, { marketplace: down.url, runner: false });
  const unreachable = await downApi("GET", "/templates/marketplace");
  assert.deepEqual([unreachable.status, unreachable.body.state, unreachable.body.templates], [200, "unreachable", []]);
  assert.match(unreachable.body.problem, /answered 500/);
});
