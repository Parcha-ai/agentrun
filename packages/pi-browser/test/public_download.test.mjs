// The public-host guard's bytes variant: one file from a public host, whatever its type, its bytes as they came, under the
// caller's byte cap. Every hop is checked as publicFetch checks it (public_fetch.test.mjs): the network is a table here,
// no socket.
import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { BrowserFailureError, publicDownload, publicFetch } from "../dist/index.js";

const PUBLIC = "93.184.216.34";
// Private addresses the guard must refuse, each named once here for review. A name the guard refuses by its suffix
// (.local, .internal) is covered by public_fetch.test.mjs: both functions run the one hop loop.
const PRIVATE_A = "10.0.0.5"; // key-gate: denylist an address the guard must refuse
const PRIVATE_B = "192.168.1.1"; // key-gate: denylist an address the guard must refuse
const PRIVATE_C = "172.16.0.9"; // key-gate: denylist an address the guard must refuse
const PRIVATE_D = "10.1.2.3"; // key-gate: denylist an address the guard must refuse
const LINK_LOCAL = "169.254.169.254"; // key-gate: denylist the metadata address the guard must refuse
const UNIQUE_LOCAL = "fd00::1"; // key-gate: denylist an address the guard must refuse
const LOOPBACK = "127.0.0.1"; // key-gate: loopback-rule an address the guard must refuse
/** Every byte value once, 0 to 255: a body no text decoding leaves intact. */
const BINARY = Uint8Array.from({ length: 256 }, (_, i) => i);

/** A table network: names resolve from `names` (a public address by default), each URL answers from `answers`, else 404.
 *  `dialled` lists every URL a request was made for, `looked` every name looked up, `asked` each request's init. */
function network({ names = {}, answers = {} } = {}) {
  const dialled = [];
  const looked = [];
  const asked = [];
  return {
    dialled,
    looked,
    asked,
    lookup: async (host) => { looked.push(host); return names[host] ?? [PUBLIC]; },
    fetchImpl: async (url, init) => {
      dialled.push(url.href);
      asked.push(init);
      const answer = answers[url.href];
      return answer ? answer() : new Response("Not here.", { status: 404, headers: { "content-type": "text/plain" } });
    },
  };
}

const refused = (pattern) => (error) => error instanceof BrowserFailureError && error.failure.code === "refused" && pattern.test(error.message);
const MAX = 1024 * 1024;

test("a binary file comes back byte for byte, with its type, status and URL; the request asks for any type", async () => {
  const net = network({ answers: { "https://cdn.example/a.png": () => new Response(BINARY, { status: 200, headers: { "content-type": "image/png" } }) } });
  const answer = await publicDownload("https://cdn.example/a.png", { ...net, maxBytes: MAX });
  assert.deepEqual({ ...answer, bytes: [...answer.bytes] }, { url: "https://cdn.example/a.png", status: 200, contentType: "image/png", bytes: [...BINARY] });
  assert.ok(answer.bytes instanceof Uint8Array);
  assert.equal(new Headers(net.asked[0].headers).get("accept"), "*/*");
});

test("any content type is a file: video, audio, octet-stream, a PDF, none at all", async () => {
  for (const type of ["video/mp4", "audio/mpeg", "application/octet-stream", "application/pdf", null]) {
    const net = network({ answers: { "https://cdn.example/f": () => new Response(BINARY.slice(0, 7), { status: 200, headers: type ? { "content-type": type } : {} }) } });
    const answer = await publicDownload("https://cdn.example/f", { ...net, maxBytes: MAX });
    assert.deepEqual([answer.contentType, [...answer.bytes]], [type ?? "", [0, 1, 2, 3, 4, 5, 6]], String(type));
  }
});

test("redirects are followed to the file, its final URL answered; a sixth is refused before it is dialled", async () => {
  const net = network({ answers: {
    "https://fal.example/files/x": () => new Response(null, { status: 302, headers: { location: "https://v3.cdn.example/x.mp4" } }),
    "https://v3.cdn.example/x.mp4": () => new Response(BINARY, { status: 200, headers: { "content-type": "video/mp4" } }),
  } });
  const answer = await publicDownload("https://fal.example/files/x", { ...net, maxBytes: MAX });
  assert.deepEqual([answer.url, answer.status, answer.bytes.length], ["https://v3.cdn.example/x.mp4", 200, 256]);
  assert.deepEqual(net.dialled, ["https://fal.example/files/x", "https://v3.cdn.example/x.mp4"]);
  const chain = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`http://public.example/${i}`, () => new Response(null, { status: 302, headers: { location: `/${i + 1}` } })]));
  const six = network({ answers: chain });
  await assert.rejects(publicDownload("http://public.example/0", { ...six, maxBytes: MAX }), refused(/^refused: too many redirects$/));
  assert.equal(six.dialled.length, 6);
});

test("the cap: a body of exactly maxBytes passes, one byte more is refused while it is read, a declared length over it before", async () => {
  const exact = network({ answers: { "https://cdn.example/f": () => new Response(BINARY, { status: 200, headers: { "content-type": "image/png" } }) } });
  assert.equal((await publicDownload("https://cdn.example/f", { ...exact, maxBytes: 256 })).bytes.length, 256);
  const over = network({ answers: { "https://cdn.example/f": () => new Response(BINARY, { status: 200, headers: { "content-type": "image/png" } }) } });
  await assert.rejects(publicDownload("https://cdn.example/f", { ...over, maxBytes: 255 }), refused(/^refused: the file is over 255 bytes$/));
  // A stream with no end: cut off as it is read, not after.
  let pulled = 0;
  const endless = new ReadableStream({ pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(MAX)); }, cancel() {} });
  const big = network({ answers: { "https://cdn.example/big": () => new Response(endless, { status: 200, headers: { "content-type": "video/mp4" } }) } });
  await assert.rejects(publicDownload("https://cdn.example/big", { ...big, maxBytes: 3 * MAX }), refused(/^refused: the file is over 3 MiB$/));
  assert.ok(pulled <= 6, `only a few MiB were read before the refusal (${pulled})`);
  // A content-length over the cap is refused before a byte of the body is read (a stream that buffers nothing ahead, so
  // each pull is a read asked for).
  let read = 0;
  const declared = new ReadableStream({ pull(controller) { read += 1; controller.enqueue(new Uint8Array(16)); }, cancel() {} }, { highWaterMark: 0 });
  const long = network({ answers: { "https://cdn.example/long": () => new Response(declared, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(2 * MAX) } }) } });
  await assert.rejects(publicDownload("https://cdn.example/long", { ...long, maxBytes: MAX }), refused(/^refused: the file is over 1 MiB$/));
  assert.equal(read, 0, "no chunk of the body was pulled");
});

test("an answer that is not 2xx comes back with no bytes; a 2xx with no body is an empty file", async () => {
  const net = network({ answers: { "https://cdn.example/empty": () => new Response(null, { status: 204 }) } });
  assert.deepEqual(await publicDownload("https://cdn.example/gone", { ...net, maxBytes: MAX }), { url: "https://cdn.example/gone", status: 404, contentType: "text/plain", bytes: null });
  const empty = await publicDownload("https://cdn.example/empty", { ...net, maxBytes: MAX });
  assert.deepEqual([empty.status, [...empty.bytes]], [204, []]);
});

test("the guard's refusals hold for a download, each before anything is dialled: scheme, local name, private address, port, a redirect inward", async () => {
  for (const url of ["file:///etc/hosts", "ftp://public.example/f", "data:image/png;base64,AAAA"]) {
    const net = network();
    await assert.rejects(publicDownload(url, { ...net, maxBytes: MAX }), refused(/^refused: [a-z]+: is not http\(s\)$/), url);
    assert.deepEqual([net.looked, net.dialled], [[], []], url);
  }
  for (const url of ["http://localhost/f", `http://${LOOPBACK}/f`, "http://[::1]/f", `http://${LINK_LOCAL}/latest`]) {
    const net = network();
    await assert.rejects(publicDownload(url, { ...net, maxBytes: MAX }), refused(/is not a public host$/), url);
    assert.deepEqual(net.dialled, [], url);
  }
  const inside = network({ names: { "inside.example": [PRIVATE_A] } });
  await assert.rejects(publicDownload("https://inside.example/f", { ...inside, maxBytes: MAX }), refused(/^refused: inside\.example is not a public host$/));
  assert.deepEqual(inside.dialled, []);
  const port = network();
  await assert.rejects(publicDownload("https://cdn.example:8443/f", { ...port, maxBytes: MAX }), refused(/^refused: port 8443 is not 80 or 443$/));
  assert.deepEqual(port.dialled, []);
  const hop = network({ names: { "inside.example": [PRIVATE_B] }, answers: { "https://cdn.example/f": () => new Response(null, { status: 302, headers: { location: "http://inside.example/secret" } }) } });
  await assert.rejects(publicDownload("https://cdn.example/f", { ...hop, maxBytes: MAX }), refused(/inside\.example is not a public host/));
  assert.deepEqual(hop.dialled, ["https://cdn.example/f"], "the private hop was never requested");
});

test("httpsOnly: an http URL, or a redirect to one, is refused before it is dialled; without it, http is followed", async () => {
  for (const url of ["http://cdn.example/f", "ftp://cdn.example/f"]) {
    const net = network();
    await assert.rejects(publicDownload(url, { ...net, maxBytes: MAX, httpsOnly: true }), refused(/^refused: [a-z]+: is not https$/), url);
    assert.deepEqual([net.looked, net.dialled], [[], []], url);
  }
  const answers = {
    "https://cdn.example/f": () => new Response(null, { status: 302, headers: { location: "http://cdn.example/x.mp3" } }),
    "http://cdn.example/x.mp3": () => new Response(BINARY, { status: 200, headers: { "content-type": "audio/mpeg" } }),
  };
  const hop = network({ answers });
  await assert.rejects(publicDownload("https://cdn.example/f", { ...hop, maxBytes: MAX, httpsOnly: true }), refused(/^refused: a redirect left https$/));
  assert.deepEqual(hop.dialled, ["https://cdn.example/f"], "the http hop was never requested");
  const open = network({ answers });
  assert.equal((await publicDownload("https://cdn.example/f", { ...open, maxBytes: MAX })).bytes.length, 256, "without httpsOnly the http hop is followed");
  const fetched = network({ answers: { "http://cdn.example/p": () => new Response("hi", { status: 200, headers: { "content-type": "text/plain" } }) } });
  await assert.rejects(publicFetch("http://cdn.example/p", { ...fetched, httpsOnly: true }), refused(/^refused: http: is not https$/), "publicFetch takes it too");
});

test("maxRedirects: at most that many redirects are followed; 0 refuses any redirect before its target is dialled", async () => {
  const answers = {
    "https://cdn.example/f": () => new Response(null, { status: 302, headers: { location: "https://other.example/x.mp3" } }),
    "https://other.example/x.mp3": () => new Response(BINARY, { status: 200, headers: { "content-type": "audio/mpeg" } }),
    "https://cdn.example/direct.mp3": () => new Response(BINARY, { status: 200, headers: { "content-type": "audio/mpeg" } }),
  };
  const none = network({ answers });
  await assert.rejects(publicDownload("https://cdn.example/f", { ...none, maxBytes: MAX, maxRedirects: 0 }), refused(/^refused: a redirect, and this download follows none$/));
  assert.deepEqual(none.dialled, ["https://cdn.example/f"], "the redirect's target was never requested");
  const direct = network({ answers });
  assert.equal((await publicDownload("https://cdn.example/direct.mp3", { ...direct, maxBytes: MAX, maxRedirects: 0 })).bytes.length, 256, "a file with no redirect is read");
  const one = network({ answers });
  assert.equal((await publicDownload("https://cdn.example/f", { ...one, maxBytes: MAX, maxRedirects: 1 })).bytes.length, 256, "one redirect, followed");
  const chain = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`https://public.example/${i}`, () => new Response(null, { status: 302, headers: { location: `/${i + 1}` } })]));
  const two = network({ answers: chain });
  await assert.rejects(publicDownload("https://public.example/0", { ...two, maxBytes: MAX, maxRedirects: 2 }), refused(/^refused: too many redirects$/));
  assert.equal(two.dialled.length, 3);
  // A whole number from 0 to 5: never more than the guard's own limit, checked before any lookup.
  for (const maxRedirects of [-1, 1.5, 6, Number.NaN]) {
    const net = network();
    await assert.rejects(publicDownload("https://cdn.example/f", { ...net, maxBytes: MAX, maxRedirects }), RangeError, String(maxRedirects));
    assert.deepEqual([net.looked, net.dialled], [[], []], String(maxRedirects));
  }
});

test("the signal: aborted before the call, nothing is looked up or dialled; a deadline ends a body that never finishes", async () => {
  const before = network();
  await assert.rejects(publicDownload("https://cdn.example/f", { ...before, maxBytes: MAX, signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.deepEqual([before.looked, before.dialled], [[], []]);
  // A body that sends one chunk and then nothing, from a fetch that does not tie its body to the signal: the download's
  // own read ends at the deadline, with the signal's reason.
  const stalled = network({ answers: { "https://cdn.example/slow": () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8)); } }), { status: 200, headers: { "content-type": "video/mp4" } }) } });
  await assert.rejects(publicDownload("https://cdn.example/slow", { ...stalled, maxBytes: MAX, signal: AbortSignal.timeout(150) }), { name: "TimeoutError" });
});

test("maxBytes is a whole number of bytes above 0, checked before any lookup", async () => {
  for (const maxBytes of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5]) {
    const net = network();
    await assert.rejects(publicDownload("https://cdn.example/f", { ...net, maxBytes }), RangeError, String(maxBytes));
    assert.deepEqual([net.looked, net.dialled], [[], []], String(maxBytes));
  }
});

test("each hop is resolved once and dialled at the address checked: a name that answers public, then private, is never dialled at the private one", async (t) => {
  // undici's own fetch, no fetchImpl: its connection is caught at node's net.connect, where the address it would dial is
  // the dispatcher's lookup's answer. Nothing leaves the process: every connection fails at once.
  const dialledAt = [];
  const connect = net.connect;
  t.after(() => { net.connect = connect; });
  net.connect = (options) => {
    const socket = new net.Socket();
    options.lookup(options.host, {}, (_error, address) => dialledAt.push(address));
    process.nextTick(() => socket.destroy(Object.assign(new Error("connect ECONNREFUSED (test: no dial)"), { code: "ECONNREFUSED" })));
    return socket;
  };
  const answers = [[PUBLIC], [LOOPBACK]];
  const looked = [];
  const lookup = async (host) => { looked.push(host); return answers[Math.min(looked.length - 1, 1)]; };
  await assert.rejects(publicDownload("http://rebind.example/f.png", { lookup, maxBytes: MAX }), (error) => !(error instanceof BrowserFailureError));
  assert.deepEqual(looked, ["rebind.example"], "the name was resolved once, at the check");
  assert.deepEqual(dialledAt, [PUBLIC], "the connection went to the address checked, never the private one a second lookup gives");
});

test("a redirect to a private host is refused at its hop, by name or by the address it resolves to, and never dialled", async () => {
  for (const location of [`http://${LOOPBACK}/admin`, `http://${PRIVATE_D}/x`, `http://[${UNIQUE_LOCAL}]/x`, "http://inside.example/x"]) {
    const net_ = network({ names: { "inside.example": [PRIVATE_C] }, answers: { "https://cdn.example/f": () => new Response(null, { status: 302, headers: { location } }) } });
    await assert.rejects(publicDownload("https://cdn.example/f", { ...net_, maxBytes: MAX }), refused(/is not a public host$/), location);
    assert.deepEqual(net_.dialled, ["https://cdn.example/f"], location);
  }
});

// A reply that states its length is read into one buffer of that length, allocated before the first chunk, so a file is
// held once and never copied whole again: a body that runs past its stated length is refused at the chunk that does,
// and one that ends short of it is refused at its end.
/** A body of `chunks`, each sent as its own read; `hang`: no end after them (a body that would keep coming). */
const chunked = (chunks, { hang = false } = {}) => new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
    if (!hang) controller.close();
  },
  cancel() {},
});
const stated = (body, length, extra = {}) => network({ answers: { "https://cdn.example/f": () => new Response(body, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(length), ...extra } }) } });

test("a stated length: the bytes come back exactly, in one buffer of that length allocated whole (no pooled copy of the chunks)", async () => {
  const answer = await publicDownload("https://cdn.example/f", { ...stated(chunked([[1, 2, 3], [4, 5], [6, 7, 8, 9, 10]]), 10), maxBytes: MAX });
  assert.deepEqual([...answer.bytes], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // The joined copy of the chunks (Buffer.concat) of a small file is a slice of Node's shared pool; the buffer read into
  // whole is its own, of exactly the stated length.
  assert.deepEqual([answer.bytes.buffer.byteLength, answer.bytes.byteOffset], [10, 0], "the bytes are the one buffer allocated for the stated length");
});

test("a stated length: a body longer is refused at the chunk that runs past it, while the body is still coming", { timeout: 10_000 }, async () => {
  const net = stated(chunked([[1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12]], { hang: true }), 10);
  // The body hangs after the chunk that runs past the length: a read that waited for its end never settles, and the
  // test's timeout catches it.
  const settled = await publicDownload("https://cdn.example/f", { ...net, maxBytes: MAX }).then(() => "read whole", (error) => error);
  assert.ok(refused(/^refused: the file is longer than the 10 bytes its host stated$/)(settled), `refused as the extra bytes came: ${settled?.message ?? settled}`);
});

test("a stated length: a body that ends short of it is refused", async () => {
  const net = stated(chunked([[1, 2, 3], [4, 5, 6]]), 10);
  await assert.rejects(publicDownload("https://cdn.example/f", { ...net, maxBytes: MAX }), refused(/^refused: the file ended at 6 of the 10 bytes its host stated$/));
});

test("no stated length, or a length of an encoded body: the chunks are joined as they come, as before", async () => {
  const none = network({ answers: { "https://cdn.example/f": () => new Response(chunked([[1, 2], [3]]), { status: 200, headers: { "content-type": "video/mp4" } }) } });
  assert.deepEqual([...(await publicDownload("https://cdn.example/f", { ...none, maxBytes: MAX })).bytes], [1, 2, 3]);
  // A gzip reply's content-length counts the bytes on the wire, not the decoded ones a fetch hands over: not the length.
  const encoded = stated(chunked([[1, 2], [3, 4, 5, 6]]), 3, { "content-encoding": "gzip" });
  assert.deepEqual([...(await publicDownload("https://cdn.example/f", { ...encoded, maxBytes: MAX })).bytes], [1, 2, 3, 4, 5, 6]);
});
