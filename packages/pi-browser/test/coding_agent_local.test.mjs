// What the coding agent has on one person's machine: the web_fetch a person's agent can run without a fetch service, and
// the evidence directory. The guard on where an agent may fetch is tested end to end (a loopback server that must never
// be reached) and, for the hops of a redirect, which no test can reach without a public network, directly with injected
// lookups; the evidence sink's file names are a pure function of a label and a counter.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { fetch as undiciFetch } from "undici";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FakeBackend, fakeDriver } from "@parcha/pi-browser/testing";
import { fileEvidenceSink, findChrome, httpBackup, isPrivateAddress, pinnedLookup } from "../dist/coding-agent-local.js";
import { startAgent, turn } from "./coding-agent/rig.mjs";

const listen = (handler) => new Promise((resolve) => { const server = http.createServer(handler); server.listen(0, "127.0.0.1", () => resolve(server)); });
/** A loopback server that counts only this test's own requests: the URLs a test asks for carry a per-run marker path,
 *  which a stray client never asks for (this host's prober sends `GET /` to every new loopback port). */
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

test("web_fetch on a machine with no fetch service refuses the owner's own network and never contacts it", async (t) => {
  const { port, marker, counted, control } = await markedServer(t, "<h1>secret</h1>", "text/html");
  const backend = new FakeBackend({});
  const agent = await startAgent(t, { extension: { provider: () => ({ ...backend.provider, fetch: undefined, search: undefined }), driver: fakeDriver(backend) } });
  const urls = [`http://127.0.0.1:${port}${marker}`, `http://localhost:${port}${marker}`, `http://[::1]:${port}${marker}`, "http://10.0.0.5/", "http://169.254.169.254/latest/meta-data/", "http://printer.local/"];
  const results = await agent.run(...urls.map((url) => turn(["web_fetch", { url }])));
  for (const [i, result] of results.entries()) {
    assert.equal(result.isError, true, urls[i]);
    assert.match(result.text, /not a public host|refused/, urls[i]);
  }
  assert.equal(counted.hits, 0, "the loopback server was never contacted");
  await control();
});

test("a public host's redirect to a private address is refused at that hop, and a plain page comes back as markdown", async () => {
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
  const backup = httpBackup({ lookup, fetchImpl });
  await assert.rejects(backup.fetch("http://evil.example/"), /internal\.example is not a public host/);
  assert.deepEqual(asked, ["http://evil.example/"], "the private hop was never requested");
  assert.match(await backup.fetch("http://public.example/"), /# Hello[\s\S]*World/);
  assert.ok(dispatchers.at(-1), "each request goes through a dispatcher that dials the address that was checked");
  await assert.rejects(backup.fetch("http://public.example/blob"), /not text/);
  await assert.rejects(backup.fetch("http://public.example/missing"), (error) => error.status === 404);
});

test("a hostname that resolves to the owner's loopback is never dialled, and a pinned lookup answers the checked address whatever it is asked", async (t) => {
  const { port, marker, counted, control } = await markedServer(t, "secret", "text/plain");
  const resolved = [];
  const backup = httpBackup({ lookup: async (host) => { resolved.push(host); return ["127.0.0.1"]; } });
  await assert.rejects(backup.fetch(`http://rebind.example:${port}${marker}`), /rebind\.example is not a public host/);
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
  const backup = httpBackup({ lookup: async () => ["93.184.216.34"], fetchImpl: async () => new Response(body, { status: 200, headers: { "content-type": "text/plain" } }) });
  await assert.rejects(backup.fetch("http://big.example/"), /over 5 MiB/);
  assert.ok(pulled <= 8, `only a few MiB were read before the refusal (${pulled})`);
});

test("a reply the fetch refuses without reading (not text, an error status, a redirect) never leaves the call waiting on its connection", async (t) => {
  // The guard refuses loopback, so the request is sent to the fixture server through the very dispatcher the backup built.
  const replies = { "/doc.pdf": [200, { "content-type": "application/pdf" }], "/gone": [404, { "content-type": "text/plain" }], "/moved": [302, { location: "/doc.pdf" }] };
  // Only this test's own requests, under its per-run marker, are answered and recorded: a stray client reaching the port
  // (this host's prober sends `GET /` to every new loopback port) gets a 404.
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
  const backup = httpBackup({ lookup: async () => ["93.184.216.34"], fetchImpl: (url, init) => undiciFetch(`http://127.0.0.1:${server.address().port}${marker}${new URL(url).pathname}`, init) });
  // What each call came to: its refusal (an error that is the fixture's own reply, not a connection failure), or that it was still waiting.
  const outcome = (promise) => Promise.race([promise.then(() => "returned", (error) => error.message), new Promise((resolve) => setTimeout(() => resolve("still waiting"), 3000).unref())]);
  assert.deepEqual(
    { pdf: await outcome(backup.fetch("http://docs.example/doc.pdf")), gone: await outcome(backup.fetch("http://docs.example/gone")), moved: await outcome(backup.fetch("http://docs.example/moved")) },
    { pdf: "refused: application/pdf is not text", gone: "the page answered 404", moved: "refused: application/pdf is not text" },
  );
  assert.deepEqual(served, ["/doc.pdf", "/gone", "/moved", "/doc.pdf"], "the redirect was followed to the PDF");
});

test("private, loopback, link-local and v4-mapped addresses are private; ordinary ones are not", () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.5.5", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "not an address"]) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isPrivateAddress(ip), false, ip);
});

test("a Chrome the person names comes first, then the first install that exists; none is null", () => {
  const present = new Set(["/opt/google/chrome/chrome", "/opt/me/chrome-custom", "/usr/local/bin/chromium"]);
  const exists = (file) => present.has(file);
  assert.equal(findChrome({ PI_BROWSER_CHROME: "/opt/me/chrome-custom", PATH: "/usr/local/bin" }, exists), "/opt/me/chrome-custom");
  assert.equal(findChrome({ CHROME_PATH: "/opt/me/chrome-custom" }, exists), "/opt/me/chrome-custom");
  assert.equal(findChrome({ PI_BROWSER_CHROME: "/missing", PATH: "/usr/local/bin" }, exists), "/usr/local/bin/chromium", "a named path that is absent falls through to the search");
  assert.equal(findChrome({ PATH: "/nowhere" }, exists), "/opt/google/chrome/chrome");
  assert.equal(findChrome({ PATH: "/nowhere" }, (file) => file === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  assert.equal(findChrome({ PATH: "/nowhere" }, () => false), null);
});

test("evidence is filed under the label with a counter, the receipt header carries every fact, and a hostile label stays inside the directory", async () => {
  const root = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), "evidence-sink-"));
  const sink = fileEvidenceSink(path.join(root, "evidence"), root);
  const facts = { sha256: "ab".repeat(32), final_url: "https://example.test/x", title: "T", status_code: undefined };
  const filed = await sink.file("../../escape", { tool: "browser_read", args: { what: "text" }, status: "ok", facts, body: "line one\nline two", ext: "txt" });
  assert.equal(filed.path, "evidence/.._.._escape/0001-browser_read.md", "slashes cannot make a path");
  assert.equal((await sink.file("..", { tool: "browser_read", args: {}, status: "ok", facts: { sha256: "00" }, body: "x" })).path, "evidence/_../0002-browser_read.md", "a label of dots is not a directory that climbs");
  assert.ok(!fs.existsSync(path.join(root, "..", "escape")), "nothing outside the evidence root");
  const text = fs.readFileSync(path.join(root, filed.path), "utf8");
  assert.equal(text.split("\n").slice(0, 7).join("\n"), `tool: browser_read\nargs: {"what":"text"}\nstatus: ok\nsha256: ${"ab".repeat(32)}\nfinal_url: https://example.test/x\ntitle: T\n---`);
  assert.equal(text.split("\n")[filed.bodyLine - 1], "line one", "bodyLine is where the body starts");
  const image = await sink.file("shots", { tool: "screenshot", args: {}, status: "ok", facts: { sha256: "cd".repeat(32) }, body: new Uint8Array([1, 2, 3]), ext: "png" });
  assert.equal(image.path, "evidence/shots/0003-screenshot.md");
  assert.deepEqual([...fs.readFileSync(path.join(root, "evidence/shots/0003-screenshot.png"))], [1, 2, 3]);
  const blocked = fileEvidenceSink(path.join(root, "evidence", "shots", "0003-screenshot.md", "nope"), root);
  assert.equal(await blocked.file("x", { tool: "browser_read", args: {}, status: "ok", facts: { sha256: "00" }, body: "x" }), null, "a sink that cannot write files nothing and says so");
});

test("a later session's sink never overwrites an earlier session's receipt or capture", async () => {
  const root = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), "evidence-sessions-"));
  const record = (body, ext) => ({ tool: "browser_read", args: {}, status: "ok", facts: { sha256: "00" }, body, ext });
  const first = await fileEvidenceSink(path.join(root, "evidence"), root).file("browser", record("first session"));
  const [second, third] = [await fileEvidenceSink(path.join(root, "evidence"), root).file("browser", record("second session")), await fileEvidenceSink(path.join(root, "evidence"), root).file("browser", record("third session"))];
  assert.deepEqual([first.path, second.path, third.path], ["evidence/browser/0001-browser_read.md", "evidence/browser/0002-browser_read.md", "evidence/browser/0003-browser_read.md"]);
  assert.match(fs.readFileSync(path.join(root, first.path), "utf8"), /first session$/, "the earlier citation still points at what it cited");
  const shot = (body) => ({ tool: "screenshot", args: {}, status: "ok", facts: { sha256: "11" }, body, ext: "png" });
  const [a, b] = [await fileEvidenceSink(path.join(root, "shots"), root).file("s", shot(new Uint8Array([1]))), await fileEvidenceSink(path.join(root, "shots"), root).file("s", shot(new Uint8Array([2])))];
  assert.deepEqual([a.path, b.path], ["shots/s/0001-screenshot.md", "shots/s/0002-screenshot.md"]);
  assert.deepEqual([...fs.readFileSync(path.join(root, "shots/s/0001-screenshot.png"))], [1], "a capture is reserved with its receipt");
});
