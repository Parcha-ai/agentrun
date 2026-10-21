// The stream's first frame (src/live-view/stream.ts) over a DevTools endpoint of the test's own, so a screencast that stays silent is deterministic: Chrome sends a frame only when the page changes, and a still page
// followed later can send none. The stream then asks for one screenshot of the page it follows, and nothing else: no tab is activated and no other page is touched (the model may be driving one).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import test from "node:test";
import { openStream } from "../dist/live-view/stream.js";
import { jpeg } from "./fixtures/fake-cdp.mjs";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 4000) => { for (let i = 0; i < ms / 10 && !check(); i += 1) await wait(10); return check(); };
const textFrame = (payload) => { const body = Buffer.from(JSON.stringify(payload)); const n = body.length; return Buffer.concat([n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : Buffer.from([0x81, 127, 0, 0, 0, 0, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]), body]); };

/** A browser endpoint with two pages (P1, then P2) and a screencast that never sends a frame on its own; `frame()` sends one. */
async function silentBrowser({ screenshot, failFirst = 0, zeroFirst = 0 }) {
  const calls = [];
  const sockets = new Set();
  const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  server.on("upgrade", (req, socket) => {
    if (req.url !== "/devtools/browser/still") { socket.destroy(); return; } // a stranger on the loopback (the box's moshi-hook connects to new listeners) is not a DevTools client
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash("sha1").update(`${req.headers["sec-websocket-key"]}${GUID}`).digest("base64")}\r\n\r\n`);
    sockets.add(socket);
    const send = (m) => socket.write(textFrame(m));
    const info = (id, url) => ({ targetId: id, type: "page", title: "", url, attached: false });
    let buffer = Buffer.alloc(0);
    let sessions = 0;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0] & 15;
        let length = buffer[1] & 127;
        let at = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); at = 4; } else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); at = 10; }
        if (buffer.length < at + 4 + length) return;
        const mask = buffer.subarray(at, at + 4);
        const body = Buffer.from(buffer.subarray(at + 4, at + 4 + length).map((b, i) => b ^ mask[i % 4]));
        buffer = buffer.subarray(at + 4 + length);
        if (opcode !== 1) continue;
        const { id, method, params = {}, sessionId } = JSON.parse(body.toString("utf8"));
        calls.push({ method, params, sessionId: sessionId ?? null });
        const reply = (result = {}) => send({ id, ...(sessionId ? { sessionId } : {}), result });
        if (method === "Target.setDiscoverTargets") { reply(); send({ method: "Target.targetCreated", params: { targetInfo: info("P1", "https://one.example.test/") } }); }
        else if (method === "Target.attachToTarget") { sessions += 1; const sid = `S${sessions}`; reply({ sessionId: sid }); send({ method: "Target.attachedToTarget", params: { sessionId: sid, targetInfo: info(params.targetId, "https://one.example.test/"), waitingForDebugger: false } }); }
        else if (method === "Page.getLayoutMetrics") { if (zeroFirst > 0) { zeroFirst -= 1; reply({ cssVisualViewport: { clientWidth: 0, clientHeight: 0 } }); } else reply({ cssVisualViewport: { clientWidth: 1000, clientHeight: 700 } }); }
        else if (method === "Page.captureScreenshot") { if (failFirst > 0) { failFirst -= 1; send({ id, ...(sessionId ? { sessionId } : {}), error: { code: -32000, message: "Unable to capture screenshot" } }); } else reply(screenshot ? { data: Buffer.from(screenshot).toString("base64") } : {}); }
        else reply();
      }
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    calls,
    url: `ws://127.0.0.1:${server.address().port}/devtools/browser/still`,
    /** A main-frame navigation of the followed page (the new document is as still as the old). */
    navigate(sessionId) { for (const s of sockets) s.write(textFrame({ method: "Page.frameNavigated", sessionId, params: { frame: { id: "P1", url: "https://one.example/next", loaderId: "L2" } } })); },
    frame(sessionId, bytes) { for (const s of sockets) s.write(textFrame({ method: "Page.screencastFrame", sessionId, params: { data: Buffer.from(bytes).toString("base64"), metadata: { deviceWidth: 1000, deviceHeight: 700 }, sessionId: 7 } })); },
    close: () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  };
}

const handlersOf = (seen) => ({ frame: (bytes, size, ack) => { seen.frames.push({ bytes, size }); ack(); }, page: () => {}, dialog: () => {}, closed: () => {} });

test("a page whose screencast stays silent gets one screenshot as its first frame, in the page's own size, and the stream touches nothing else", async (t) => {
  const shot = jpeg(1000, 700, 40, 3);
  const browser = await silentBrowser({ screenshot: shot });
  t.after(() => browser.close(), { timeout: 10_000 });
  const seen = { frames: [] };
  const stream = openStream(browser.url, handlersOf(seen));
  t.after(() => stream.close(), { timeout: 10_000 });
  assert.ok(await until(() => seen.frames.length === 1, 4000), "a first frame arrived with no screencast frame");
  assert.deepEqual([seen.frames[0].bytes[0], seen.frames[0].bytes[1]], [0xff, 0xd8], "a JPEG");
  assert.deepEqual(seen.frames[0].size, { w: 1000, h: 700 }, "the page's own CSS size, from the layout metrics");
  assert.deepEqual(seen.frames[0].bytes, Buffer.from(shot), "the screenshot's bytes");
  const methods = browser.calls.map((c) => c.method);
  assert.ok(methods.includes("Page.captureScreenshot") && methods.includes("Page.getLayoutMetrics"));
  // The first frame touches only the page being followed: nothing activates a tab, nothing is sent to any other session, no navigation, no script.
  const sessions = new Set(browser.calls.filter((c) => c.sessionId).map((c) => c.sessionId));
  assert.deepEqual([...sessions], ["S1"], "every page command goes to the one session the stream follows");
  for (const forbidden of ["Page.bringToFront", "Target.activateTarget", "Target.createTarget", "Target.closeTarget", "Page.navigate", "Page.reload", "Runtime.evaluate", "Emulation.setFocusEmulationEnabled"]) assert.ok(!methods.includes(forbidden), `${forbidden} is never sent`);
  await wait(600);
  assert.equal(seen.frames.length, 1, "one stand-in frame, not a stream of screenshots");
});

test("a page whose screencast sends its own frame in time is not screenshotted", async (t) => {
  const browser = await silentBrowser({ screenshot: jpeg(1000, 700, 40, 3) });
  t.after(() => browser.close(), { timeout: 10_000 });
  const seen = { frames: [] };
  const stream = openStream(browser.url, handlersOf(seen));
  t.after(() => stream.close(), { timeout: 10_000 });
  assert.ok(await until(() => browser.calls.some((c) => c.method === "Page.startScreencast")), "the screencast started");
  browser.frame("S1", jpeg(1000, 700, 40, 9));
  assert.ok(await until(() => seen.frames.length === 1));
  await wait(900);
  assert.equal(browser.calls.filter((c) => c.method === "Page.captureScreenshot").length, 0, "no screenshot when the screencast has sent a frame");
  assert.equal(seen.frames.length, 1);
});

test("a capture that fails once is tried again: the followed page still gets its first frame", async (t) => {
  const shot = jpeg(1000, 700, 40, 4);
  const browser = await silentBrowser({ screenshot: shot, failFirst: 1 });
  t.after(() => browser.close(), { timeout: 10_000 });
  const seen = { frames: [] };
  const stream = openStream(browser.url, handlersOf(seen));
  t.after(() => stream.close(), { timeout: 10_000 });
  assert.ok(await until(() => seen.frames.length === 1, 8000), "a frame arrived after the first capture failed");
  assert.deepEqual(seen.frames[0].bytes, Buffer.from(shot));
  assert.ok(browser.calls.filter((c) => c.method === "Page.captureScreenshot").length >= 2, "the capture was asked for again");
});

test("a page that reports no size yet is not delivered as a 0x0 frame: the stand-in waits for a size and delivers the page's own", async (t) => {
  const browser = await silentBrowser({ screenshot: jpeg(1000, 700, 40, 5), zeroFirst: 1 });
  t.after(() => browser.close(), { timeout: 10_000 });
  const seen = { frames: [] };
  const stream = openStream(browser.url, handlersOf(seen));
  t.after(() => stream.close(), { timeout: 10_000 });
  assert.ok(await until(() => seen.frames.length >= 1, 8000), "a frame arrived");
  assert.deepEqual(seen.frames[0].size, { w: 1000, h: 700 }, "the first frame carries the page's size, not 0x0");
});

test("a navigation of the followed page re-arms the stand-in: the new document, as still as the old, gets a frame too", async (t) => {
  const browser = await silentBrowser({ screenshot: jpeg(1000, 700, 40, 6) });
  t.after(() => browser.close(), { timeout: 10_000 });
  const seen = { frames: [] };
  const stream = openStream(browser.url, handlersOf(seen));
  t.after(() => stream.close(), { timeout: 10_000 });
  assert.ok(await until(() => seen.frames.length === 1, 5000), "the first document got its stand-in frame");
  await wait(300);
  browser.navigate("S1");
  assert.ok(await until(() => seen.frames.length === 2, 5000), "the navigated document got a stand-in frame of its own");
  await wait(1500);
  assert.equal(seen.frames.length, 2, "one per document, not a stream of screenshots");
});

