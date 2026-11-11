// The public-host guard from the package's root: every hop's port, name and addresses are checked before it is dialled,
// and the caller's signal bounds every hop, its name lookup included. The network is a table here: no socket.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import test from "node:test";
import { fetch as undiciFetch } from "undici";
import { BrowserFailureError, createWebTools, isPrivateAddress, pinnedLookup, publicFetch, readPage } from "../dist/index.js";

const PUBLIC = "93.184.216.34";
const PAGE = '<html><head><title>Public</title></head><body><p>Hello.</p><a href="/next">Next</a></body></html>';

/** A table network: names resolve from `names` (a public address by default), and each URL answers from `answers`.
 *  `dialled` lists every URL a request was made for. */
function network({ names = {}, answers = {}, onDial = () => undefined } = {}) {
  const dialled = [];
  const looked = [];
  return {
    dialled,
    looked,
    lookup: async (host) => { looked.push(host); return names[host] ?? [PUBLIC]; },
    fetchImpl: async (url) => {
      dialled.push(url.href);
      onDial(url.href);
      const answer = answers[url.href];
      return answer ? answer() : new Response(PAGE, { status: 200, headers: { "content-type": "text/html" } });
    },
  };
}

const refused = (pattern) => (error) => error instanceof BrowserFailureError && error.failure.code === "refused" && pattern.test(error.message);

test("ports: only 80 and 443, on the first hop and on every redirect, refused like a private host and never dialled", async () => {
  const first = network();
  await assert.rejects(publicFetch("http://public.example:8080/", first), refused(/^refused: port 8080 is not 80 or 443$/));
  assert.deepEqual(first.dialled, []);
  const redirect = network({ answers: { "http://public.example/go": () => new Response(null, { status: 302, headers: { location: "https://public.example:8443/admin" } }) } });
  await assert.rejects(publicFetch("http://public.example/go", redirect), refused(/^refused: port 8443 is not 80 or 443$/));
  assert.deepEqual(redirect.dialled, ["http://public.example/go"], "the redirect's hop is never dialled");
  for (const url of ["http://public.example/", "http://public.example:80/", "https://public.example:443/", "http://public.example:443/", "https://public.example:80/"]) {
    const net = network();
    assert.equal((await publicFetch(url, net)).status, 200, url);
    assert.equal(net.dialled.length, 1, url);
  }
});

test("the signal bounds every hop's name lookup: a resolver that stalls ends at the deadline, on the first hop and on a redirect's", { timeout: 15_000 }, async (t) => {
  // A resolver that answers a minute late. Its timer holds the process up as a real lookup does; the deadline's own
  // timer is unref'd and holds nothing.
  const timers = [];
  t.after(() => timers.forEach(clearTimeout));
  const stalled = () => new Promise((resolve) => timers.push(setTimeout(() => resolve([PUBLIC]), 60_000)));
  const first = network();
  const started = Date.now();
  await assert.rejects(publicFetch("http://slow.example/", { ...first, lookup: stalled, signal: AbortSignal.timeout(100) }), { name: "TimeoutError" });
  assert.ok(Date.now() - started < 5_000, "it ends at the deadline, not when the resolver answers");
  assert.deepEqual(first.dialled, []);
  const hop = network({ answers: { "http://public.example/go": () => new Response(null, { status: 302, headers: { location: "http://slow.example/" } }) } });
  const lookup = (host) => (host === "slow.example" ? stalled() : hop.lookup(host));
  await assert.rejects(publicFetch("http://public.example/go", { ...hop, lookup, signal: AbortSignal.timeout(300) }), { name: "TimeoutError" });
  assert.deepEqual(hop.dialled, ["http://public.example/go"]);
  // A signal aborted before the call asks no resolver and dials nothing.
  const before = network();
  await assert.rejects(publicFetch("http://public.example/", { ...before, signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.deepEqual([before.looked, before.dialled], [[], []]);
});

/** A chain of `n` redirects, /0 to /n, whose last hop answers the page. */
const chain = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`http://public.example/${i}`, () => new Response(null, { status: 302, headers: { location: `/${i + 1}` } })]));

test("redirects: five are followed, a sixth is refused at the cap before it is dialled", async () => {
  const five = network({ answers: chain(5) });
  const answer = await publicFetch("http://public.example/0", five);
  assert.deepEqual([answer.url, answer.status], ["http://public.example/5", 200]);
  assert.equal(five.dialled.length, 6);
  const six = network({ answers: chain(6) });
  await assert.rejects(publicFetch("http://public.example/0", six), refused(/^refused: too many redirects$/));
  assert.deepEqual(six.dialled, [0, 1, 2, 3, 4, 5].map((i) => `http://public.example/${i}`), "the sixth redirect's target is never dialled");
});

test("a redirect to file:, data: or ftp: is refused, never followed", async () => {
  for (const location of ["file:///etc/passwd", "data:text/html,<h1>hi</h1>", "ftp://public.example/"]) {
    const net = network({ answers: { "http://public.example/go": () => new Response(null, { status: 302, headers: { location } }) } });
    await assert.rejects(publicFetch("http://public.example/go", net), refused(/^refused: a redirect left http\(s\)$/), location);
    assert.deepEqual([net.looked, net.dialled], [["public.example"], ["http://public.example/go"]], location);
  }
});

test("a hop aborted after its checks is never dialled: the signal is checked again before connecting", async () => {
  const controller = new AbortController();
  // The first hop's answer aborts the call and redirects to an address that needs no lookup.
  const net = network({ answers: { "http://public.example/go": () => (controller.abort(), new Response(null, { status: 302, headers: { location: `http://${PUBLIC}/next` } })) } });
  await assert.rejects(publicFetch("http://public.example/go", { ...net, signal: controller.signal }), { name: "AbortError" });
  assert.deepEqual(net.dialled, ["http://public.example/go"], "the redirect's address was never dialled");
});

test("a name with a public and a private address is refused and never dialled, wherever the private one is", async () => {
  for (const private_ of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "::1"]) {
    for (const addresses of [[private_, PUBLIC], [PUBLIC, private_]]) {
      const net = network({ names: { "mixed.example": addresses } });
      await assert.rejects(publicFetch("http://mixed.example/", net), refused(/^refused: mixed\.example is not a public host$/), addresses.join(","));
      assert.deepEqual(net.dialled, [], addresses.join(","));
    }
  }
  // On a redirect's hop too.
  const hop = network({ names: { "mixed.example": [PUBLIC, "192.168.1.1"] }, answers: { "http://public.example/go": () => new Response(null, { status: 302, headers: { location: "http://mixed.example/" } }) } });
  await assert.rejects(publicFetch("http://public.example/go", hop), refused(/mixed\.example is not a public host/));
  assert.deepEqual(hop.dialled, ["http://public.example/go"]);
});

test("a first URL that is not http(s) is refused before any lookup or dial", async () => {
  for (const url of ["file:///etc/hosts", "ftp://public.example/", "data:text/html,<h1>hi</h1>", "gopher://public.example/"]) {
    const net = network();
    await assert.rejects(publicFetch(url, net), refused(/^refused: [a-z]+: is not http\(s\)$/), url);
    assert.deepEqual([net.looked, net.dialled], [[], []], url);
  }
});

test("maxBytes is a whole number of bytes above 0, checked before any lookup; a custom cap refuses a larger page", async () => {
  for (const maxBytes of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5]) {
    const net = network();
    await assert.rejects(publicFetch("http://public.example/", { ...net, maxBytes }), RangeError, String(maxBytes));
    assert.deepEqual([net.looked, net.dialled], [[], []], String(maxBytes));
  }
  await assert.rejects(publicFetch("http://public.example/", { ...network(), maxBytes: 10 }), refused(/^refused: the page is over 10 bytes$/));
  assert.equal((await publicFetch("http://public.example/", { ...network(), maxBytes: PAGE.length })).status, 200);
});

const RANGES = [
  ["64:ff9b::/96", "64:ff9b::a00:1"],
  ["64:ff9b:1::/48", "64:ff9b:1:ffff::1"],
  ["198.18.0.0/15", "198.19.255.254"],
  ["240.0.0.0/4", "240.0.0.1"],
  ["192.0.0.0/24", "192.0.0.170"],
  ["fec0::/10", "fec0::1"],
];

test("the special-purpose ranges are private: each refused by isPrivateAddress and by publicFetch before it is dialled", async () => {
  for (const [range, ip] of RANGES) {
    assert.equal(isPrivateAddress(ip), true, `${range}: ${ip}`);
    const net = network({ names: { "inside.example": [ip] } });
    await assert.rejects(publicFetch("http://inside.example/", net), refused(/inside\.example is not a public host/), range);
    assert.deepEqual(net.dialled, [], range);
  }
  assert.equal(isPrivateAddress("64:ff9b::8.8.8.8"), true, "NAT64 written with its IPv4 tail");
  assert.equal(isPrivateAddress("255.255.255.255"), true);
  for (const ip of ["198.17.255.255", "198.20.0.1", "192.0.1.1", "223.255.255.254", "2001:4860:4860::8888", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
  assert.equal(isPrivateAddress("fe80::1%eth0"), true, "a scoped address is refused");
});

test("readPage gives the title, the text and each absolute http(s) link once", async () => {
  const page = await readPage(PAGE, "http://public.example/");
  assert.deepEqual([page.title, page.links], ["Public", ["http://public.example/next"]]);
  assert.match(page.text, /Hello\./);
});

// The guard against the owner's own network, on a real loopback socket and through the web tools' backup: these cases
// were the coding agent's (its HTTP backup was publicFetch and readPage), and the guard they hold is publicFetch's.
const listen = (handler) => new Promise((resolve) => { const server = http.createServer(handler); server.listen(0, "127.0.0.1", () => resolve(server)); });
/** Counts only this test's own requests: they carry a per-run marker path, which a stray client never asks for (this
 *  host's prober sends `GET /` to every new loopback port). */
async function markedServer(t, body, type) {
  const marker = `/${randomUUID()}`;
  const counted = { hits: 0 };
  const server = await listen((req, res) => { if (req.url === marker) counted.hits += 1; res.writeHead(200, { "content-type": type }).end(body); });
  t.after(() => server.close());
  const port = server.address().port;
  // A foreign request first, as a stray makes it: it is not counted.
  await (await undiciFetch(`http://127.0.0.1:${port}/`, { headers: { "user-agent": "Go-http-client/1.1" } })).text();
  assert.equal(counted.hits, 0, "a foreign request is not counted");
  return { port, marker, counted,
    /** The control: a request for the marker path is counted, so a zero means nothing of this test's reached it. */
    control: async () => { await (await undiciFetch(`http://127.0.0.1:${port}${marker}`)).text(); assert.equal(counted.hits, 1, "the counter counts this test's own request"); } };
}

test("the owner's own network is refused and never contacted: loopback by address and by name, a private range, the metadata address, a .local name", async (t) => {
  const { port, marker, counted, control } = await markedServer(t, "<h1>secret</h1>", "text/html");
  const urls = [`http://127.0.0.1:${port}${marker}`, `http://localhost:${port}${marker}`, `http://[::1]:${port}${marker}`, "http://10.0.0.5/", "http://169.254.169.254/latest/meta-data/", "http://printer.local/"];
  for (const url of urls) await assert.rejects(publicFetch(url), (error) => error instanceof BrowserFailureError && /not a public host|refused/.test(error.message), url);
  assert.equal(counted.hits, 0, "the loopback server was never contacted");
  await control();
});

test("a public host's redirect to a private address is refused at that hop, and a plain page reads as markdown", async () => {
  const lookup = async (host) => (host === "evil.example" ? ["93.184.216.34"] : host === "public.example" ? ["93.184.216.34"] : ["10.1.2.3"]);
  const answers = {
    "http://evil.example/": () => new Response(null, { status: 302, headers: { location: "http://internal.example/admin" } }),
    "http://public.example/": () => new Response("<html><body><article><h1>Hello</h1><p>World</p></article></body></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
    "http://public.example/blob": () => new Response("xx", { status: 200, headers: { "content-type": "application/octet-stream" } }),
    "http://public.example/missing": () => new Response("no", { status: 404, headers: { "content-type": "text/plain" } }),
  };
  const asked = [];
  const dispatchers = [];
  const fetchImpl = async (url, init) => { asked.push(String(url)); dispatchers.push(init.dispatcher); return answers[String(url)]?.() ?? new Response("?", { status: 500 }); };
  await assert.rejects(publicFetch("http://evil.example/", { lookup, fetchImpl }), /internal\.example is not a public host/);
  assert.deepEqual(asked, ["http://evil.example/"], "the private hop was never requested");
  const page = await publicFetch("http://public.example/", { lookup, fetchImpl });
  assert.match((await readPage(page.body, page.url)).text, /# Hello[\s\S]*World/);
  assert.ok(dispatchers.at(-1), "each request goes through a dispatcher that dials the address that was checked");
  await assert.rejects(publicFetch("http://public.example/blob", { lookup, fetchImpl }), /not text/);
  assert.deepEqual(await publicFetch("http://public.example/missing", { lookup, fetchImpl }), { url: "http://public.example/missing", status: 404, contentType: "text/plain", body: null });
});

test("a hostname that resolves to the owner's loopback is never dialled, and a pinned lookup answers the checked address whatever it is asked", async (t) => {
  const { port, marker, counted, control } = await markedServer(t, "secret", "text/plain");
  const resolved = [];
  await assert.rejects(publicFetch(`http://rebind.example:${port}${marker}`, { lookup: async (host) => { resolved.push(host); return ["127.0.0.1"]; } }), /rebind\.example is not a public host/);
  assert.equal(counted.hits, 0, "the loopback server was never dialled");
  await control();
  assert.deepEqual(resolved, ["rebind.example"], "resolved once, at the check");
  const answer = (options) => new Promise((resolve) => pinnedLookup("93.184.216.34")("anything.example", options, (...args) => resolve(args)));
  assert.deepEqual(await answer({}), [null, "93.184.216.34", 4]);
  assert.deepEqual(await answer({ all: true }), [null, [{ address: "93.184.216.34", family: 4 }]]);
});

test("a page larger than the limit is cut off while it is read, not after", async () => {
  let pulled = 0;
  const body = new ReadableStream({ pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() {} });
  await assert.rejects(publicFetch("http://big.example/", { lookup: async () => ["93.184.216.34"], fetchImpl: async () => new Response(body, { status: 200, headers: { "content-type": "text/plain" } }) }), /over 5 MiB/);
  assert.ok(pulled <= 8, `only a few MiB were read before the refusal (${pulled})`);
});

test("a reply the fetch does not read (not text, an error status, a redirect) never leaves the call waiting on its connection", async (t) => {
  // The guard refuses loopback, so the request is sent to the fixture server through the very dispatcher the fetch built.
  const replies = { "/doc.pdf": [200, { "content-type": "application/pdf" }], "/gone": [404, { "content-type": "text/plain" }], "/moved": [302, { location: "/doc.pdf" }] };
  // Only requests under this test's per-run marker are answered and recorded: a stray client reaching the port gets a 404.
  const marker = `/${randomUUID()}`;
  const served = [];
  const server = await listen((req, res) => {
    const own = req.url.startsWith(`${marker}/`) ? replies[req.url.slice(marker.length)] : undefined;
    if (!own) { res.writeHead(404).end(); return; }
    served.push(req.url.slice(marker.length));
    const [status, headers] = own;
    res.writeHead(status, headers);
    res.write("x".repeat(64 * 1024));
    // The body is never finished: a client that does not cancel it waits on this connection for as long as it is open.
    t.after(() => res.destroy());
  });
  t.after(() => server.close());
  // A foreign request first, as a stray makes it: answered 404 and not recorded.
  await (await undiciFetch(`http://127.0.0.1:${server.address().port}/`, { headers: { "user-agent": "Go-http-client/1.1" } })).text();
  assert.deepEqual(served, [], "a foreign request is not recorded");
  const options = { lookup: async () => ["93.184.216.34"], fetchImpl: (url, init) => undiciFetch(`http://127.0.0.1:${server.address().port}${marker}${new URL(url).pathname}`, init) };
  // Each call's answer or refusal (the fixture's own reply, not a connection failure), or that it was still waiting at the bound.
  const outcome = (promise) => Promise.race([promise.then((answer) => `answered ${answer.status}`, (error) => error.message), new Promise((resolve) => setTimeout(() => resolve("still waiting"), 3000).unref())]);
  assert.deepEqual(
    { pdf: await outcome(publicFetch("http://docs.example/doc.pdf", options)), gone: await outcome(publicFetch("http://docs.example/gone", options)), moved: await outcome(publicFetch("http://docs.example/moved", options)) },
    { pdf: "refused: application/pdf is not text", gone: "answered 404", moved: "refused: application/pdf is not text" },
  );
  assert.deepEqual(served, ["/doc.pdf", "/gone", "/moved", "/doc.pdf"], "the redirect was followed to the PDF");
});

test("private, loopback, link-local and v4-mapped addresses are private; ordinary ones are not", () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.5.5", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "not an address"]) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isPrivateAddress(ip), false, ip);
});

test("web_fetch tells the model a backup's publicFetch refusal as a refusal: a private host, a non-text page and an oversized page are refused, not a failure worth retrying", async () => {
  const sources = {
    "http://rebind.example/": { lookup: ["127.0.0.1"] },
    "http://public.example/blob": { lookup: ["93.184.216.34"], reply: () => new Response("%PDF", { status: 200, headers: { "content-type": "application/pdf" } }) },
    "http://public.example/huge": { lookup: ["93.184.216.34"], reply: () => new Response(new Uint8Array(6 * 1024 * 1024), { status: 200, headers: { "content-type": "text/plain" } }) },
  };
  const options = { lookup: async (host) => Object.entries(sources).find(([url]) => new URL(url).hostname === host)[1].lookup, fetchImpl: async (url) => sources[url.href].reply() };
  const backup = { name: "http", fetch: async (url, signal) => (await publicFetch(url, { ...options, ...(signal ? { signal } : {}) })).body };
  const web = createWebTools({ name: "none", evidence: { file: async () => null }, scope: () => ({ label: "t", proxies: false }), backups: [backup] });
  for (const url of Object.keys(sources)) {
    const out = await web.fetch(1, { url });
    const failure = JSON.parse(out.text);
    assert.equal(out.isError, true, url);
    assert.deepEqual([failure.code, failure.retryable], ["refused", false], `${url}: ${out.text}`);
    assert.doesNotMatch(failure.message, /Try once more/, `${url}: a refusal is not worth retrying`);
  }
});
