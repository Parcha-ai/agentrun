// The public-host guard from the package's root: every hop's port, name and addresses are checked before it is dialled,
// and the caller's signal bounds every hop, its name lookup included. The network is a table here: no socket.
import assert from "node:assert/strict";
import test from "node:test";
import { BrowserFailureError, isPrivateAddress, publicFetch, readPage } from "../dist/index.js";

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
