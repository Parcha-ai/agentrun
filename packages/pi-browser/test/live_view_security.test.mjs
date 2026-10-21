// The live view's security contract, with a fake stream and a fake gate: the token travels in the fragment and then as the first message; a
// missing, wrong or query-borne token, a bad Origin and a second viewer are each refused; the token is dead at release; no frame touches disk.
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLiveView } from "../dist/live-view/index.js";
import { CLOSE_CODES, decodeFrame } from "../dist/live-view/protocol.js";
import { connect } from "./fixtures/ws-client.mjs";

const HOST = "https://app.example";
const VIEWER = { html: "<!doctype html><title>v</title><script src=\"../viewer.js\"></script>", js: "/* viewer */", css: "/* css */" };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function fakeStream() {
  const made = [];
  const factory = (cdpUrl, handlers) => {
    const s = { cdpUrl, handlers, inputs: [], navs: [], dialogs: [], closed: false };
    s.api = { input: async (m) => { s.inputs.push(m); }, nav: async (m) => { s.navs.push(m); }, dialog: async (m) => { s.dialogs.push(m); }, close: () => { s.closed = true; } };
    made.push(s);
    return s.api;
  };
  return { factory, made };
}
function fakeGates() {
  const gates = new Map();
  const make = (tag) => {
    const g = { tag, ended: false, listeners: new Set(), mode: "driving", drive: "idle" };
    g.api = {
      state: () => g.drive,
      input: () => g.mode,
      model: () => ({ release() {} }),
      onChange: (l) => { g.listeners.add(l); return () => g.listeners.delete(l); },
      viewing: () => g.viewing === true,
      setViewing: (on) => { g.viewing = on; },
      end: () => { g.ended = true; g.viewing = false; g.listeners.clear(); },
    };
    return g;
  };
  return { gates: (tag) => { if (!gates.has(tag)) gates.set(tag, make(tag)); return gates.get(tag).api; }, get: (tag) => gates.get(tag) };
}
const parts = (liveUrl) => { const u = new URL(liveUrl); return { u, id: u.pathname.split("/").at(-1), token: new URLSearchParams(u.hash.slice(1)).get("t") }; };
const wsUrl = (liveUrl, extra = "") => { const u = new URL(liveUrl); u.hash = ""; return `ws://${u.host}${u.pathname}/ws${extra}`; };

async function rig(t, options = {}) {
  const stream = fakeStream();
  const g = fakeGates();
  const host = createLiveView({ hostOrigin: HOST, stream: stream.factory, gates: g.gates, viewer: VIEWER, helloTimeoutMs: 300, ...options });
  t.after(() => host.close());
  const view = await host.open("ar-run-1-1", "ws://127.0.0.1:9/devtools/browser/x");
  const { u, id, token } = parts(view.fullscreen);
  return { host, stream, g, view, url: view.fullscreen, origin: u.origin, id, token, wsUrl: wsUrl(view.fullscreen) };
}
const hello = (token) => ({ type: "hello", token });
const gateFor = () => { let open; const promise = new Promise((resolve) => { open = resolve; }); return { promise, open }; };
const authed = async (r, origin = r.origin) => { const c = await connect(r.wsUrl, { origin }); assert.equal(c.status, 101); c.ws.sendJson(hello(r.token)); const ready = await c.ws.next(); assert.equal(JSON.parse(ready.data).type, "ready", JSON.stringify(ready)); return c.ws; };
const closeOf = async (ws) => { const { item } = await ws.until((m) => m.type === "close"); return item; };

test("the URL carries its token in the fragment only; the path id is separate and opaque; open is idempotent per tag and a new tag gets new secrets", async (t) => {
  const r = await rig(t);
  assert.match(r.token, /^[A-Za-z0-9_-]{43}$/, "256 bits, base64url");
  assert.match(r.id, /^[A-Za-z0-9_-]{22}$/, "128 bits, base64url");
  assert.notEqual(r.id, r.token);
  const u = new URL(r.url);
  assert.deepEqual([u.search, u.pathname.includes(r.token), u.hostname], ["", false, "127.0.0.1"]);
  assert.equal(r.view.framed, r.url);
  const again = await r.host.open("ar-run-1-1", "ws://127.0.0.1:9/devtools/browser/x");
  assert.equal(again.fullscreen, r.url, "the same URL until release");
  const other = parts((await r.host.open("ar-run-1-2", "ws://127.0.0.1:9/devtools/browser/y")).fullscreen);
  assert.deepEqual([other.id === r.id, other.token === r.token], [false, false]);
  assert.equal(r.stream.made.length, 0, "nothing is streamed until a viewer authenticates");
});

test("the page is served with no referrer, a same-origin CSP and framing limited to the host; an unknown id is a 404", async (t) => {
  const r = await rig(t);
  const get = (p) => new Promise((resolve, reject) => http.get(new URL(p, r.origin), (res) => { let body = ""; res.setEncoding("utf8"); res.on("data", (d) => { body += d; }); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body })); }).on("error", reject));
  const page = await get(`/v/${r.id}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers["referrer-policy"], "no-referrer");
  assert.equal(page.headers["cache-control"], "no-store");
  assert.match(page.headers["content-type"], /^text\/html/);
  const csp = page.headers["content-security-policy"];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, new RegExp(`frame-ancestors ${HOST.replace(/\./g, "\\.")}(;|$)`));
  assert.match(csp, new RegExp(`connect-src [^;]*ws://127\\.0\\.0\\.1:${new URL(r.origin).port}`));
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
  assert.equal(page.body, VIEWER.html);
  assert.equal((await get(`/viewer.js`)).body, VIEWER.js);
  assert.equal((await get(`/viewer.css`)).body, VIEWER.css);
  assert.equal((await get(`/v/${"A".repeat(22)}`)).status, 404);
  assert.equal((await get(`/v/${r.token}`)).status, 404, "the token is not an id");
  const none = await rig(t, { hostOrigin: null });
  const bare = await get.call(null, `/v/${none.id}`).catch(() => null);
  assert.ok(bare === null || bare.status === 404 || bare.status === 200);
});

test("with no host origin the page may be framed by nobody", async (t) => {
  const r = await rig(t, { hostOrigin: null });
  const res = await new Promise((resolve, reject) => http.get(new URL(`/v/${r.id}`, r.origin), (x) => { x.resume(); resolve(x.headers); }).on("error", reject));
  assert.match(res["content-security-policy"], /frame-ancestors 'none'/);
});

test("nothing is accepted before the hello: an input first is refused unauthorized and never reaches the stream", async (t) => {
  const r = await rig(t);
  const c = await connect(r.wsUrl, { origin: r.origin });
  c.ws.sendJson({ type: "mouse", action: "down", x: 1, y: 1 });
  const refused = JSON.parse((await c.ws.next()).data);
  assert.deepEqual(refused, { type: "refused", reason: "unauthorized" });
  assert.equal((await closeOf(c.ws)).code, CLOSE_CODES.unauthorized);
  assert.equal(r.stream.made.length, 0);
});

test("a wrong token, a hello with no token, a token of another session and a non-JSON first message are each refused the same way", async (t) => {
  const r = await rig(t);
  const other = parts((await r.host.open("ar-run-1-2", "ws://127.0.0.1:9/x")).fullscreen);
  for (const first of [hello("x".repeat(43)), hello(r.token.slice(0, -1) + (r.token.endsWith("A") ? "B" : "A")), { type: "hello" }, hello(other.token), hello(r.id), "not json"]) {
    const c = await connect(r.wsUrl, { origin: r.origin });
    typeof first === "string" ? c.ws.sendText(first) : c.ws.sendJson(first);
    const { item, seen } = await c.ws.until((m) => m.type === "close");
    assert.equal(item?.code, CLOSE_CODES.unauthorized, JSON.stringify(seen));
    assert.deepEqual(JSON.parse(seen[0].data), { type: "refused", reason: "unauthorized" });
  }
  assert.equal(r.stream.made.length, 0, "no stream was ever started");
});

test("a token in the query instead of the fragment opens nothing: no hello, no view; the silent connection is cut off", async (t) => {
  const r = await rig(t);
  const c = await connect(wsUrl(r.url, `?t=${r.token}`), { origin: r.origin });
  assert.equal(c.status, 101, "the upgrade itself carries no authority");
  const item = await closeOf(c.ws);
  assert.equal(item?.code, CLOSE_CODES.unauthorized, "cut off at the hello timeout");
  assert.equal(r.stream.made.length, 0);
  const page = await new Promise((resolve, reject) => http.get(new URL(`/v/${r.id}?t=${r.token}`, r.origin), (x) => { x.resume(); resolve(x.statusCode); }).on("error", reject));
  assert.equal(page, 200, "serving the page is harmless: it holds no secret");
});

test("a bad, a missing or a null Origin on the upgrade is refused before any WebSocket exists; the viewer's own origin is accepted", async (t) => {
  const r = await rig(t);
  for (const origin of ["https://evil.example", HOST, `http://localhost:${new URL(r.origin).port}`, "null", `${r.origin}.evil.example`, undefined]) {
    const c = await connect(r.wsUrl, { origin });
    assert.equal(c.status, 403, `Origin ${origin}`);
  }
  const ok = await connect(r.wsUrl, { origin: r.origin });
  assert.equal(ok.status, 101);
  ok.ws.destroy();
  assert.equal(r.stream.made.length, 0);
});

test("a second viewer with the right token is refused viewer_in_use and the first keeps its view; the slot frees when the first leaves", async (t) => {
  const r = await rig(t);
  const first = await authed(r);
  assert.equal(r.stream.made.length, 1);
  const second = await connect(r.wsUrl, { origin: r.origin });
  second.ws.sendJson(hello(r.token));
  const { item, seen } = await second.ws.until((m) => m.type === "close");
  assert.deepEqual(JSON.parse(seen[0].data), { type: "refused", reason: "viewer_in_use" });
  assert.equal(item.code, CLOSE_CODES.viewer_in_use);
  assert.equal(r.stream.made.length, 1, "the refused viewer started no second stream");
  assert.equal(first.closedWith(), null, "the first viewer was not replaced");
  r.stream.made[0].handlers.frame(JPEG, { w: 800, h: 600 }, () => {});
  const frame = await first.next();
  assert.equal(frame.type, "binary");
  first.destroy();
  await first.gone();
  for (let i = 0; i < 100 && !r.stream.made[0].closed; i += 1) await new Promise((x) => setTimeout(x, 10));
  assert.equal(r.stream.made[0].closed, true, "the stream ends with its viewer");
  const third = await authed(r);
  assert.equal(r.stream.made.length, 2);
  third.destroy();
});

test("a connection that has not sent a valid hello holds no slot: a legitimate viewer still gets in while strangers wait", async (t) => {
  const r = await rig(t, { maxPending: 3, helloTimeoutMs: 600 });
  const strangers = [];
  for (let i = 0; i < 3; i += 1) strangers.push((await connect(r.wsUrl, { origin: r.origin })).ws);
  const over = await connect(r.wsUrl, { origin: r.origin });
  assert.equal(over.status, 503, "past the pending cap the upgrade is refused");
  for (const s of strangers) assert.equal((await closeOf(s)).code, CLOSE_CODES.unauthorized);
  const viewer = await authed(r);
  viewer.destroy();
});

test("release kills the token: the viewer is told and closed, the stream and gate end, the old URL opens nothing, and a new open has new secrets", async (t) => {
  const r = await rig(t);
  const viewer = await authed(r);
  await r.host.release("ar-run-1-1");
  const { item, seen } = await viewer.until((m) => m.type === "close");
  assert.deepEqual(seen.filter((m) => m.type === "text").map((m) => JSON.parse(m.data)), [{ type: "ended", reason: "released" }]);
  assert.equal(item.code, CLOSE_CODES.released);
  assert.equal(r.stream.made[0].closed, true);
  assert.equal(r.g.get("ar-run-1-1").ended, true);
  const reuse = await connect(r.wsUrl, { origin: r.origin });
  assert.equal(reuse.status, 404, "the upgrade for a released id is refused");
  const page = await new Promise((resolve, reject) => http.get(new URL(`/v/${r.id}`, r.origin), (x) => { x.resume(); resolve(x.statusCode); }).on("error", reject));
  assert.equal(page, 404);
  await r.host.release("ar-run-1-1");
  const fresh = parts((await r.host.open("ar-run-1-1", "ws://127.0.0.1:9/x")).fullscreen);
  assert.deepEqual([fresh.id === r.id, fresh.token === r.token], [false, false]);
});

test("a token that was valid before a release is refused after it even on a new id's socket", async (t) => {
  const r = await rig(t);
  await r.host.release("ar-run-1-1");
  const fresh = parts((await r.host.open("ar-run-1-1", "ws://127.0.0.1:9/x")).fullscreen);
  const c = await connect(wsUrl(`http://127.0.0.1:${new URL(r.origin).port}/v/${fresh.id}`), { origin: r.origin });
  c.ws.sendJson(hello(r.token));
  assert.equal((await closeOf(c.ws)).code, CLOSE_CODES.unauthorized);
});

test("input reaches the stream; while the model is acting it is discarded with held agent_acting; a message that is not the protocol is held bad_message; nav leaves http(s) never", async (t) => {
  const r = await rig(t);
  const viewer = await authed(r);
  const s = r.stream.made[0];
  viewer.sendJson({ type: "mouse", action: "down", x: 10, y: 20, button: "left", clickCount: 1 });
  viewer.sendJson({ type: "text", text: "tomsmith" });
  viewer.sendJson({ type: "nav", action: "url", url: "https://the-internet.herokuapp.com/login" });
  for (let i = 0; i < 100 && s.navs.length < 1; i += 1) await new Promise((x) => setTimeout(x, 10));
  assert.deepEqual(s.inputs, [{ type: "mouse", action: "down", x: 10, y: 20, button: "left", clickCount: 1 }, { type: "text", text: "tomsmith" }]);
  assert.deepEqual(s.navs, [{ type: "nav", action: "url", url: "https://the-internet.herokuapp.com/login" }]);

  r.g.get("ar-run-1-1").mode = "agent_acting";
  viewer.sendJson({ type: "text", text: "secret" });
  assert.deepEqual(JSON.parse((await viewer.next()).data), { type: "held", reason: "agent_acting" });
  r.g.get("ar-run-1-1").mode = "driving";
  for (const bad of [{ type: "nav", action: "url", url: "file:///etc/passwd" }, { type: "nav", action: "url", url: "javascript:alert(1)" }, { type: "nav", action: "url", url: "chrome://settings" }, { type: "mouse", action: "down", x: "1", y: 2 }, { type: "wheel", x: 1, y: 1, deltaX: 1e9, deltaY: 0 }, { type: "unknown" }, { type: "text", text: "" }, { type: "text", text: "x".repeat(13_000) }, { type: "hello", token: r.token }]) {
    viewer.sendJson(bad);
    assert.deepEqual(JSON.parse((await viewer.next()).data), { type: "held", reason: "bad_message" }, JSON.stringify(bad).slice(0, 80));
  }
  assert.equal(s.inputs.length, 2, "none of it reached the browser");
  assert.equal(s.navs.length, 1);
  viewer.destroy();
});

test("frames reach the viewer as binary [w][h][jpeg] and each is acknowledged after it was sent; the gate's state changes reach the viewer", async (t) => {
  const r = await rig(t);
  const viewer = await authed(r);
  const s = r.stream.made[0];
  let acked = 0;
  s.handlers.frame(JPEG, { w: 1280, h: 720 }, () => { acked += 1; });
  const frame = await viewer.next();
  assert.equal(frame.type, "binary");
  const decoded = decodeFrame(frame.data);
  assert.deepEqual([decoded.w, decoded.h, [...decoded.jpeg]], [1280, 720, [...JPEG]]);
  for (let i = 0; i < 100 && acked < 1; i += 1) await new Promise((x) => setTimeout(x, 10));
  assert.equal(acked, 1);
  for (const l of r.g.get("ar-run-1-1").listeners) l("agent");
  assert.deepEqual(JSON.parse((await viewer.next()).data), { type: "status", drive: "agent" });
  s.handlers.page({ url: "https://example.com/", title: "Example" });
  assert.deepEqual(JSON.parse((await viewer.next()).data), { type: "page", url: "https://example.com/", title: "Example" });
  viewer.destroy();
});

test("no frame is written anywhere: a private TMPDIR stays empty through a streamed session, and the live view's code imports no filesystem module", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "lv-nodisk-"));
  const before = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  t.after(async () => { if (before === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = before; await rm(tmp, { recursive: true, force: true }); });
  const r = await rig(t);
  const viewer = await authed(r);
  for (let i = 0; i < 20; i += 1) r.stream.made[0].handlers.frame(JPEG, { w: 100, h: 100 }, () => {});
  await new Promise((x) => setTimeout(x, 100));
  viewer.destroy();
  await r.host.release("ar-run-1-1");
  assert.deepEqual(await readdir(tmp), []);
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../dist/live-view");
  for (const file of await readdir(dir)) {
    if (!file.endsWith(".js")) continue;
    const src = await (await import("node:fs/promises")).readFile(path.join(dir, file), "utf8");
    assert.doesNotMatch(src, /from ["']node:fs(\/promises)?["']|require\(["']fs/, `${file} must not touch the filesystem`);
  }
});

test("mounted on the host's own server at a path, the same code path answers there, ignores every other request, and checks Origin against the base's origin", async (t) => {
  const stream = fakeStream();
  const g = fakeGates();
  let host;
  const server = http.createServer((req, res) => { if (!host.handle(req, res)) { res.statusCode = 418; res.end("host"); } });
  server.on("upgrade", (req, socket, head) => { if (!host.upgrade(req, socket, head)) socket.destroy(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  host = createLiveView({ hostOrigin: HOST, baseUrl: `${origin}/mount/live`, stream: stream.factory, gates: g.gates, viewer: VIEWER, helloTimeoutMs: 300 });
  t.after(() => host.close());
  const view = await host.open("ar-run-1-1", "ws://127.0.0.1:9/x");
  const u = new URL(view.fullscreen);
  assert.equal(u.origin, origin);
  assert.match(u.pathname, /^\/mount\/live\/v\/[A-Za-z0-9_-]{22}$/);
  const status = (p) => new Promise((resolve, reject) => http.get(new URL(p, origin), (x) => { x.resume(); resolve(x.statusCode); }).on("error", reject));
  assert.equal(await status(u.pathname), 200);
  assert.equal(await status("/mount/live/viewer.js"), 200);
  assert.equal(await status("/other"), 418, "a request that is not ours is the host's");
  assert.equal(await status("/mount/liveness"), 418);
  const url = `ws://${u.host}${u.pathname}/ws`;
  assert.equal((await connect(url, { origin: "https://evil.example" })).status, 403);
  const ok = await connect(url, { origin });
  assert.equal(ok.status, 101);
  ok.ws.sendJson(hello(parts(view.fullscreen).token));
  assert.equal(JSON.parse((await ok.ws.next()).data).type, "ready");
  ok.ws.destroy();
});

test("its own server listens on 127.0.0.1 only: the same port on this machine's other addresses refuses", async (t) => {
  const r = await rig(t);
  const port = Number(new URL(r.origin).port);
  const others = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
  if (others.length === 0) return t.skip("no non-loopback address on this machine");
  for (const address of others) {
    const code = await new Promise((resolve) => { const req = http.get({ host: address, port, path: `/v/${r.id}`, timeout: 1_500 }, (x) => { x.resume(); resolve(`answered ${x.statusCode}`); }); req.on("error", (e) => resolve(e.code)); req.on("timeout", () => { req.destroy(); resolve("timeout"); }); });
    assert.ok(code === "ECONNREFUSED" || code === "timeout", `${address}: ${code}`);
  }
});

test("close releases every session and stops the server it started", async (t) => {
  const r = await rig(t);
  const viewer = await authed(r);
  await r.host.close();
  assert.equal((await closeOf(viewer)).code, CLOSE_CODES.released);
  const code = await new Promise((resolve) => { http.get(new URL(`/v/${r.id}`, r.origin), (x) => { x.resume(); resolve(`answered ${x.statusCode}`); }).on("error", (e) => resolve(e.code)); });
  assert.equal(code, "ECONNREFUSED");
});

for (const mount of ["/live/run_01HZ-abc.def", "/live/run_01HZ-abc.def/", "/"]) {
  test(`mounted at ${mount} behind a page server that passes the upgrade with its Origin: pages, scripts and the socket work there, and a sibling path or another run's prefix is not ours`, async (t) => {
    const stream = fakeStream();
    const g = fakeGates();
    let host;
    const server = http.createServer((req, res) => { if (!host.handle(req, res)) { res.statusCode = 418; res.end("page server"); } });
    server.on("upgrade", (req, socket, head) => { if (!host.upgrade(req, socket, head)) socket.destroy(); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
    const origin = `http://127.0.0.1:${server.address().port}`;
    host = createLiveView({ hostOrigin: HOST, baseUrl: `${origin}${mount}`, stream: stream.factory, gates: g.gates, viewer: VIEWER, helloTimeoutMs: 300 });
    t.after(() => host.close());
    const view = await host.open("ar-run-1-1", "ws://127.0.0.1:9/x");
    const u = new URL(view.fullscreen);
    const base = mount.replace(/\/+$/, "");
    assert.equal(u.origin, origin);
    assert.match(u.pathname, new RegExp(`^${base.replace(/[.]/g, "\\.")}/v/[A-Za-z0-9_-]{22}$`));
    const status = (p) => new Promise((resolve, reject) => http.get(new URL(p, origin), (x) => { x.resume(); resolve(x.statusCode); }).on("error", reject));
    assert.equal(await status(u.pathname), 200);
    assert.equal(await status(`${base}/viewer.js`), 200);
    assert.equal(await status(`${base}/viewer.css`), 200);
    if (base) {
      assert.equal(await status(`${base}X/v/${parts(view.fullscreen).id}`), 418, "a sibling prefix is the page server's");
      assert.equal(await status(`/live/another-run/v/${parts(view.fullscreen).id}`), 418, "another run's prefix is the page server's");
      assert.equal(await status(`/v/${parts(view.fullscreen).id}`), 418, "the page outside the mount is the page server's");
    }
    const url = `ws://${u.host}${u.pathname}/ws`;
    assert.equal((await connect(url, { origin: "https://evil.example" })).status, 403);
    assert.equal((await connect(url, { origin: HOST })).status, 403, "the host page's origin is not the viewer's own");
    const ok = await connect(url, { origin });
    assert.equal(ok.status, 101);
    ok.ws.sendJson(hello(parts(view.fullscreen).token));
    assert.equal(JSON.parse((await ok.ws.next()).data).type, "ready");
    ok.ws.destroy();
  });
}

test("a key message with an empty code (bare CDP keys, a virtual keyboard, an IME) is delivered; a code that is not a bounded string is still held", async (t) => {
  const r = await rig(t);
  const viewer = await authed(r);
  const s = r.stream.made[0];
  viewer.sendJson({ type: "key", action: "down", key: "a", code: "", text: "a", windowsVirtualKeyCode: 65 });
  viewer.sendJson({ type: "key", action: "up", key: "Unidentified", code: "" });
  for (let i = 0; i < 100 && s.inputs.length < 2; i += 1) await new Promise((x) => setTimeout(x, 10));
  assert.deepEqual(s.inputs, [{ type: "key", action: "down", key: "a", code: "", text: "a", windowsVirtualKeyCode: 65 }, { type: "key", action: "up", key: "Unidentified", code: "" }]);
  for (const bad of [{ type: "key", action: "down", key: "a", code: "x".repeat(65) }, { type: "key", action: "down", key: "a", code: 7 }, { type: "key", action: "down", key: "a", code: null }, { type: "key", action: "down", key: "", code: "KeyA" }]) {
    viewer.sendJson(bad);
    assert.deepEqual(JSON.parse((await viewer.next()).data), { type: "held", reason: "bad_message" }, JSON.stringify(bad));
  }
  assert.equal(s.inputs.length, 2);
  viewer.destroy();
});

test("one message the protocol does not know is dropped with a notice and the session goes on; a viewer that keeps sending them is closed", async (t) => {
  const r = await rig(t);
  const viewer = await authed(r);
  const s = r.stream.made[0];
  viewer.sendJson({ type: "nonsense" });
  assert.deepEqual(JSON.parse((await viewer.next()).data), { type: "held", reason: "bad_message" });
  viewer.sendJson({ type: "text", text: "still here" });
  for (let i = 0; i < 100 && s.inputs.length < 1; i += 1) await new Promise((x) => setTimeout(x, 10));
  assert.deepEqual(s.inputs, [{ type: "text", text: "still here" }], "the session went on");
  for (let i = 0; i < 40; i += 1) viewer.sendJson({ type: "nonsense", i });
  const { item, seen } = await viewer.until((m) => m.type === "close");
  assert.equal(item?.code, CLOSE_CODES.bad_message, JSON.stringify(seen.slice(-2)));
  assert.deepEqual(seen.filter((m) => m.type === "text").map((m) => JSON.parse(m.data)).at(-1), { type: "refused", reason: "bad_message" });
  assert.equal(s.inputs.length, 1, "none of the nonsense reached the browser");
  for (let i = 0; i < 100 && !s.closed; i += 1) await new Promise((x) => setTimeout(x, 10));
  assert.equal(s.closed, true, "the stream ends with the viewer");
});

test("a request target the URL parser cannot read is refused, never thrown: the host's process lives, over its own server and mounted", async (t) => {
  const net = await import("node:net");
  const r = await rig(t);
  const u = new URL(r.url);
  const raw = (lines) => new Promise((resolve) => { const s = net.connect({ host: u.hostname, port: Number(u.port) }, () => s.write(lines.join("\r\n") + "\r\n\r\n")); let got = ""; s.on("data", (d) => { got += d; }); s.on("close", () => resolve(got)); s.on("error", () => resolve(got)); setTimeout(() => s.destroy(), 1_500); });
  for (const target of ["//[", "//%", "/v/[", "http://[::1"]) {
    const plain = await raw([`GET ${target} HTTP/1.1`, "Host: 127.0.0.1", "Connection: close"]);
    assert.match(plain, /^HTTP\/1\.1 4\d\d /, `a 4xx answer for ${target}, not a dead process: ${plain.slice(0, 40)}`);
    const upgrade = await raw([`GET ${target} HTTP/1.1`, "Host: 127.0.0.1", "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", `Origin: ${r.origin}`]);
    assert.doesNotMatch(upgrade, /^HTTP\/1\.1 101/, `no upgrade for ${target}`);
  }
  assert.equal(await new Promise((resolve) => http.get(new URL(`/v/${r.id}`, r.origin), (x) => { x.resume(); resolve(x.statusCode); }).on("error", () => resolve("down"))), 200, "the server still answers");
  // The host mounts handle() and upgrade() itself: neither may throw into its listener.
  const never = { setHeader() {}, writeHead() { throw new Error("must not answer"); }, end() { throw new Error("must not answer"); } };
  assert.equal(r.host.handle({ url: "//[", method: "GET", headers: {} }, never), false, "not ours, and not an exception");
  assert.equal(r.host.upgrade({ url: "//[", method: "GET", headers: { origin: r.origin } }, { end() {}, destroy() {}, write() {} }, Buffer.alloc(0)), false);
});

test("a viewer cannot grow the host's memory with queued input: past 32 waiting messages the rest are dropped with held busy, and a viewer that keeps doing it is closed", async (t) => {
  const hold = gateFor();
  const st = { inputs: 0 };
  const g = { state: () => "idle", input: () => "driving", model: () => ({ release() {} }), onChange: () => () => {}, viewing: () => false, setViewing() {}, end() {} };
  const host = createLiveView({ hostOrigin: null, gates: () => g, viewer: VIEWER, helloTimeoutMs: 300, stream: () => ({ input: async () => { st.inputs += 1; await hold.promise; }, nav: async () => {}, dialog: async () => {}, close() {} }) });
  t.after(() => host.close());
  const u = new URL((await host.open("ar-run-q-1-1", "ws://127.0.0.1:9/x")).fullscreen);
  const c = await connect(`ws://${u.host}${u.pathname}/ws`, { origin: u.origin });
  c.ws.sendJson({ type: "hello", token: new URLSearchParams(u.hash.slice(1)).get("t") });
  assert.equal(JSON.parse((await c.ws.next()).data).type, "ready");
  for (let i = 0; i < 300; i += 1) c.ws.sendJson({ type: "text", text: `message ${i}` });
  const { item, seen } = await c.ws.until((m) => m.type === "close", 5_000);
  const busy = seen.filter((m) => m.type === "text").map((m) => JSON.parse(m.data)).filter((m) => m.type === "held" && m.reason === "busy").length;
  assert.ok(busy >= 15, `the excess was told it was dropped: ${busy}`);
  assert.equal(item?.code, CLOSE_CODES.bad_message, "and a viewer that keeps doing it is closed");
  hold.open();
  await new Promise((x) => setTimeout(x, 100));
  assert.ok(st.inputs <= 33, `at most the one running and 32 waiting reached the browser: ${st.inputs}`);
});

test("release bookkeeping does not grow with the sessions a host ever released: tags that never opened leave nothing, and an open overtaken by a release leaves nothing", async (t) => {
  const g = { state: () => "idle", input: () => "driving", model: () => ({ release() {} }), onChange: () => () => {}, viewing: () => false, setViewing() {}, end() {} };
  const host = createLiveView({ hostOrigin: null, gates: () => g, viewer: VIEWER, stream: () => ({ input: async () => {}, nav: async () => {}, dialog: async () => {}, close() {} }) });
  t.after(() => host.close());
  for (let i = 0; i < 2_000; i += 1) await host.release(`ar-run-leak-${i}-1`);
  assert.deepEqual(host.tracked(), { sessions: 0, opening: 0 }, "2,000 releases of tags that were never opened");
  const racing = host.open("ar-run-leak-x-1", "ws://127.0.0.1:9/x");
  await host.release("ar-run-leak-x-1");
  await assert.rejects(racing, /closed|released/);
  assert.deepEqual(host.tracked(), { sessions: 0, opening: 0 }, "an open that lost its race to a release is not tracked afterwards");
  const kept = await host.open("ar-run-leak-y-1", "ws://127.0.0.1:9/x");
  assert.ok(kept.fullscreen);
  assert.deepEqual(host.tracked(), { sessions: 1, opening: 0 });
});

test("the viewer's queue gives its slots back: bursts under the limit, each drained before the next, are never dropped", async (t) => {
  let release = () => {};
  let hold = new Promise((resolve) => { release = resolve; });
  const st = { inputs: 0 };
  const g = { state: () => "idle", input: () => "driving", model: () => ({ release() {} }), onChange: () => () => {}, viewing: () => false, setViewing() {}, end() {} };
  const host = createLiveView({ hostOrigin: null, gates: () => g, viewer: VIEWER, stream: () => ({ input: async () => { st.inputs += 1; await hold; }, nav: async () => {}, dialog: async () => {}, close() {} }) });
  t.after(() => host.close());
  const u = new URL((await host.open("ar-run-q-2-1", "ws://127.0.0.1:9/x")).fullscreen);
  const c = await connect(`ws://${u.host}${u.pathname}/ws`, { origin: u.origin });
  c.ws.sendJson({ type: "hello", token: new URLSearchParams(u.hash.slice(1)).get("t") });
  assert.equal(JSON.parse((await c.ws.next()).data).type, "ready");
  for (let round = 0; round < 4; round += 1) {
    for (let i = 0; i < 25; i += 1) c.ws.sendJson({ type: "text", text: `round ${round} message ${i}` });
    await new Promise((x) => setTimeout(x, 150));
    release();
    hold = new Promise((resolve) => { release = resolve; });
    for (let i = 0; i < 200 && st.inputs < (round + 1) * 25; i += 1) { release(); hold = new Promise((resolve) => { release = resolve; }); await new Promise((x) => setTimeout(x, 10)); }
  }
  assert.equal(st.inputs, 100, "all 100 messages in four bursts of 25 reached the browser");
  const stray = await c.ws.next(300);
  assert.notDeepEqual(stray.type === "text" ? JSON.parse(stray.data) : null, { type: "held", reason: "busy" }, "nothing was dropped as busy");
  assert.equal(c.ws.closedWith(), null, "and the viewer was not closed");
  c.ws.destroy();
});

test("ordinary mouse traffic behind a slow command is combined, not counted as abuse: 300 moves and 60 wheel events keep the viewer and deliver the latest move and the summed scroll, in order", async (t) => {
  let release = () => {};
  const hold = new Promise((resolve) => { release = resolve; });
  const got = [];
  const g = { state: () => "idle", input: () => "driving", model: () => ({ release() {} }), onChange: () => () => {}, viewing: () => false, setViewing() {}, end() {} };
  const host = createLiveView({ hostOrigin: null, gates: () => g, viewer: VIEWER, stream: () => ({ input: async (m) => { got.push(m); if (got.length === 1) await hold; }, nav: async () => {}, dialog: async () => {}, close() {} }) });
  t.after(() => host.close());
  const u = new URL((await host.open("ar-run-mv-1-1", "ws://127.0.0.1:9/x")).fullscreen);
  const c = await connect(`ws://${u.host}${u.pathname}/ws`, { origin: u.origin });
  c.ws.sendJson({ type: "hello", token: new URLSearchParams(u.hash.slice(1)).get("t") });
  assert.equal(JSON.parse((await c.ws.next()).data).type, "ready");
  c.ws.sendJson({ type: "text", text: "holds the browser" });
  for (let i = 0; i < 100 && got.length < 1; i += 1) await new Promise((x) => setTimeout(x, 10));
  for (let i = 0; i < 300; i += 1) c.ws.sendJson({ type: "mouse", action: "move", x: i, y: 2 * i, buttons: 1 });
  c.ws.sendJson({ type: "mouse", action: "down", x: 299, y: 598, button: "left", clickCount: 1, buttons: 1 });
  for (let i = 0; i < 60; i += 1) c.ws.sendJson({ type: "wheel", x: 10, y: 10, deltaX: 0, deltaY: 3 });
  c.ws.sendJson({ type: "mouse", action: "move", x: 500, y: 600, buttons: 1 });
  c.ws.sendJson({ type: "mouse", action: "move", x: 501, y: 601, buttons: 1 });
  await new Promise((x) => setTimeout(x, 300));
  release();
  for (let i = 0; i < 200 && got.length < 5; i += 1) await new Promise((x) => setTimeout(x, 10));
  await new Promise((x) => setTimeout(x, 100));
  assert.equal(c.ws.closedWith(), null, "the viewer was not closed for dragging");
  const traffic = [];
  for (let m = await c.ws.next(100); m.type !== "none"; m = await c.ws.next(100)) if (m.type === "text") traffic.push(JSON.parse(m.data));
  assert.deepEqual(traffic.filter((m) => m.type === "held"), [], "and nothing was reported dropped");
  assert.deepEqual(got.map((m) => [m.type, m.action ?? "", m.x ?? "", m.y ?? "", m.deltaY ?? ""]), [
    ["text", "", "", "", ""],
    ["mouse", "move", 299, 598, ""],
    ["mouse", "down", 299, 598, ""],
    ["wheel", "", 10, 10, 180],
    ["mouse", "move", 501, 601, ""],
  ], "the latest of each run of moves, the press where it was, the scroll summed, the order kept");
  c.ws.destroy();
});

test("a mouse move that finds the queue full of other messages is dropped quietly (the next one supersedes it) and never counts toward closing the viewer", async (t) => {
  let release = () => {};
  const hold = new Promise((resolve) => { release = resolve; });
  const got = [];
  const g = { state: () => "idle", input: () => "driving", model: () => ({ release() {} }), onChange: () => () => {}, viewing: () => false, setViewing() {}, end() {} };
  const host = createLiveView({ hostOrigin: null, gates: () => g, viewer: VIEWER, stream: () => ({ input: async (m) => { got.push(m); if (got.length === 1) await hold; }, nav: async () => {}, dialog: async () => {}, close() {} }) });
  t.after(() => host.close());
  const u = new URL((await host.open("ar-run-mv-2-1", "ws://127.0.0.1:9/x")).fullscreen);
  const c = await connect(`ws://${u.host}${u.pathname}/ws`, { origin: u.origin });
  c.ws.sendJson({ type: "hello", token: new URLSearchParams(u.hash.slice(1)).get("t") });
  assert.equal(JSON.parse((await c.ws.next()).data).type, "ready");
  for (let i = 0; i < 40; i += 1) c.ws.sendJson({ type: "text", text: `t${i}` });
  for (let i = 0; i < 100; i += 1) c.ws.sendJson({ type: "mouse", action: "move", x: i, y: i });
  await new Promise((x) => setTimeout(x, 300));
  release();
  await new Promise((x) => setTimeout(x, 300));
  assert.equal(c.ws.closedWith(), null, "40 texts overflow by 8, and 100 moves on top of a full queue are not abuse");
  c.ws.destroy();
});

test("queued scrolls are combined only when they are at the same point with the same modifiers: two scrolls over different controls reach the page as two", async (t) => {
  let release = () => {};
  const hold = new Promise((resolve) => { release = resolve; });
  const got = [];
  const g = { state: () => "idle", input: () => "driving", model: () => ({ release() {} }), onChange: () => () => {}, viewing: () => false, setViewing() {}, end() {} };
  const host = createLiveView({ hostOrigin: null, gates: () => g, viewer: VIEWER, stream: () => ({ input: async (m) => { got.push(m); if (got.length === 1) await hold; }, nav: async () => {}, dialog: async () => {}, close() {} }) });
  t.after(() => host.close());
  const u = new URL((await host.open("ar-run-wh-1-1", "ws://127.0.0.1:9/x")).fullscreen);
  const c = await connect(`ws://${u.host}${u.pathname}/ws`, { origin: u.origin });
  c.ws.sendJson({ type: "hello", token: new URLSearchParams(u.hash.slice(1)).get("token") ?? new URLSearchParams(u.hash.slice(1)).get("t") });
  assert.equal(JSON.parse((await c.ws.next()).data).type, "ready");
  c.ws.sendJson({ type: "text", text: "holds the browser" });
  for (let i = 0; i < 100 && got.length < 1; i += 1) await new Promise((x) => setTimeout(x, 10));
  // Each message differs from the one before it in exactly one thing, so each check is the only thing that keeps two of them apart.
  c.ws.sendJson({ type: "wheel", x: 10, y: 10, deltaX: 0, deltaY: 100 });
  c.ws.sendJson({ type: "wheel", x: 10, y: 10, deltaX: 0, deltaY: 50 });            // same point, same modifiers: summed with the one before
  c.ws.sendJson({ type: "wheel", x: 400, y: 300, deltaX: 0, deltaY: 30 });          // another control (x and y): its own
  c.ws.sendJson({ type: "wheel", x: 400, y: 350, deltaX: 0, deltaY: 7 });           // same x, another y: its own
  c.ws.sendJson({ type: "wheel", x: 420, y: 350, deltaX: 0, deltaY: 9 });           // same y, another x: its own
  c.ws.sendJson({ type: "wheel", x: 420, y: 350, deltaX: 0, deltaY: 5, modifiers: 2 });  // same point, Control held (a zoom): its own
  c.ws.sendJson({ type: "wheel", x: 420, y: 350, deltaX: 0, deltaY: 4, modifiers: 2 });  // and that one sums with its twin
  await new Promise((x) => setTimeout(x, 300));
  release();
  await new Promise((x) => setTimeout(x, 300));
  assert.deepEqual(got.slice(1).map((m) => [m.x, m.y, m.deltaY, m.modifiers ?? 0]), [[10, 10, 150, 0], [400, 300, 30, 0], [400, 350, 7, 0], [420, 350, 9, 0], [420, 350, 9, 2]], "five scrolls, each where and as it was made");
  assert.equal(c.ws.closedWith(), null);
  c.ws.destroy();
});
