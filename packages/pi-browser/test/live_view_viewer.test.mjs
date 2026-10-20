// The viewer page (src/live-view/viewer.ts) in a real Chrome, against a minimal WebSocket server of the test's own that speaks protocol.ts: the token is read from the URL fragment (never the query) and is the first message and nothing
// else goes first, frames are drawn, mouse, wheel, key and paste go back in the page's coordinates, the address bar and its buttons send `nav`, the server's notices and dialogs are shown, a refusal ends the viewer, and the page is served
// under the policy the live view uses (default-src 'self') with nothing from anywhere else.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cdpProvider } from "../dist/providers/cdp.js";
import { encodeFrame } from "../dist/live-view/protocol.js";
import { viewerAssets } from "../dist/live-view/viewer.js";
import { CHROME, NO_CHROME } from "./fixtures/local-chrome.mjs";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** Written at once to stderr, so a run killed by its bound still says which step it was in. */
const step = (name) => process.stderr.write(`# step ${name}\n`);
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (ms, work) => Promise.race([Promise.resolve(work).catch(() => undefined), settle(ms)]);
/** Waits until `check` is true; a check that throws (a page that has not loaded yet has no element to ask) is not true yet. */
const until = async (check, ms = 10_000) => { const ok = async () => { try { return await check(); } catch { return false; } }; for (let i = 0; i < ms / 20 && !(await ok()); i += 1) await settle(20); return ok(); };

const frameOf = (opcode, payload) => {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]);
  return Buffer.concat([head, payload]);
};
/** A server for one viewer: the page and its two files under the live view's policy, and a WebSocket at {page}/ws that records what the viewer sends. */
async function viewerServer(token) {
  const id = randomBytes(8).toString("hex");
  const requests = [];
  const received = [];
  const sockets = new Set();
  const policy = { "content-security-policy": "default-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'", "referrer-policy": "no-referrer" };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.headers["sec-fetch-mode"]) requests.push(url.pathname + url.search); // only a browser's requests: a stranger's probe (the box's moshi-hook connects to new loopback listeners) is not the viewer's
    if (url.pathname === `/v/${id}`) { res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...policy }); return res.end(viewerAssets.html); }
    if (url.pathname === "/viewer.js") { res.writeHead(200, { "content-type": "text/javascript", ...policy }); return res.end(viewerAssets.js); }
    if (url.pathname === "/viewer.css") { res.writeHead(200, { "content-type": "text/css", ...policy }); return res.end(viewerAssets.css); }
    res.writeHead(404); res.end();
  });
  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname !== `/v/${id}/ws`) { socket.destroy(); return; }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash("sha1").update(`${req.headers["sec-websocket-key"]}${GUID}`).digest("base64")}\r\n\r\n`);
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
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
        if (opcode === 1) received.push(JSON.parse(body.toString("utf8")));
      }
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    id, base, requests, received, token, sockets: () => sockets.size,
    send: (message) => { for (const s of sockets) s.write(frameOf(1, Buffer.from(JSON.stringify(message)))); },
    sendFrame: (jpeg, w, h) => { for (const s of sockets) s.write(frameOf(2, encodeFrame(jpeg, w, h))); },
    closeSockets: () => { for (const s of sockets) s.end(Buffer.from([0x88, 0x00])); },
    close: () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

/** A tab of the browser the test drives, over one socket of its own. */
async function openTab(browserUrl, url = "about:blank") {
  const ws = new WebSocket(browserUrl);
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("the browser's socket did not open")), 30_000); ws.onopen = () => { clearTimeout(timer); resolve(); }; ws.onerror = () => { clearTimeout(timer); reject(new Error("socket error")); }; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (event) => { const m = JSON.parse(String(event.data)); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} did not answer`)); }, 15_000);
    pending.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send("Target.createTarget", { url });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  const evaluate = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId); if (r.exceptionDetails) throw new Error(`the page threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`); return r.result.value; };
  return { send: (method, params) => send(method, params, sessionId), evaluate, navigate: (u) => send("Page.navigate", { url: u }, sessionId), close: () => { try { ws.close(); } catch {} } };
}

test("the viewer's script is valid JavaScript (it is a template literal in viewer.ts: an unescaped backslash there ends the page's script, and Chrome shows nothing)", () => {
  assert.doesNotThrow(() => new Function(viewerAssets.js));
  assert.ok(!/\r/.test(viewerAssets.js), "a carriage return inside the script is a literal that was meant to be the two characters backslash and r");
});

test("the viewer page in a real Chrome: token from the fragment as the first message, frames drawn, input mapped to the protocol, the notices and dialogs shown, a refusal ends it, and nothing but its own three files is asked for", { skip: NO_CHROME, timeout: 100_000 }, async (t) => {
  const TOKEN = randomBytes(32).toString("base64url");
  step("server");
  const web = await viewerServer(TOKEN);
  await new Promise((resolve) => http.get(`${web.base}/stranger-probe`, (res) => { res.resume(); res.on("end", resolve); }).on("error", resolve));
  assert.ok(!web.requests.includes("/stranger-probe"), "a plain client's request is not the viewer's");
  step("browser");
  const root = await mkdtemp(path.join(tmpdir(), "lv-viewer-"));
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root } });
  let ref = null;
  const tabs = [];
  t.after(async () => { for (const tab of tabs) tab.close(); if (ref) await within(20_000, provider.release(ref)); await within(5_000, web.close()); await within(5_000, rm(root, { recursive: true, force: true })); }, { timeout: 40_000 });
  ref = await within(60_000, provider.create({ tag: "lv-viewer", maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} }, new AbortController().signal));
  assert.ok(ref, "the browser started");
  const attached = await within(30_000, provider.attach(ref));
  assert.ok(attached, "the browser answered attach");
  const browserUrl = attached.sdkCdpUrl;
  step("attached");
  const open = async (url) => { const tab = await openTab(browserUrl, url); tabs.push(tab); return tab; };

  // A frame the viewer can decode: Chrome makes one.
  step("maker");
  const maker = await open("about:blank");
  const jpegBase64 = await maker.evaluate(`(async () => { const c = new OffscreenCanvas(200, 100); const g = c.getContext("2d"); g.fillStyle = "#ff0000"; g.fillRect(0, 0, 200, 100); const b = await c.convertToBlob({ type: "image/jpeg", quality: 0.9 }); const a = new Uint8Array(await b.arrayBuffer()); let s = ""; for (const x of a) s += String.fromCharCode(x); return btoa(s); })()`);
  const jpeg = Buffer.from(jpegBase64, "base64");
  assert.deepEqual([jpeg[0], jpeg[1]], [0xff, 0xd8]);

  // No token, or a token in the query: the viewer asks the server for nothing but its files and opens no socket.
  const bare = await open(`${web.base}/v/${web.id}`);
  assert.ok(await until(async () => (await bare.evaluate(`document.getElementById("notice").textContent`)).includes("no token")), "no token: the viewer says so");
  const query = await open(`${web.base}/v/${web.id}?t=${TOKEN}`);
  assert.ok(await until(async () => (await query.evaluate(`document.getElementById("notice").textContent`)).includes("no token")), "a token in the query is not read");
  await settle(500);
  assert.equal(web.sockets(), 0, "neither opened a WebSocket");
  assert.deepEqual(web.received, []);
  bare.close(); query.close();

  // A token in the fragment: the first message, and the fragment is gone from the address bar.
  const viewer = await open(`${web.base}/v/${web.id}#t=${TOKEN}`);
  assert.ok(await until(() => web.received.length >= 1), "the viewer connected and spoke");
  assert.deepEqual(web.received[0], { type: "hello", token: TOKEN }, "the first message is the hello with the token");
  assert.equal(web.received.length, 1, "nothing else is sent before the server has answered");
  assert.equal(await viewer.evaluate(`location.hash`), "", "the fragment was dropped from the address bar");
  assert.equal(await viewer.evaluate(`location.href.includes(${JSON.stringify(TOKEN)})`), false, "the token is nowhere in the page's address");

  // Frames: drawn on the canvas, in the page's own size for the mapping.
  web.send({ type: "ready", drive: "idle" });
  web.send({ type: "page", url: "https://acme.example/login", title: "Sign in" });
  web.sendFrame(jpeg, 1000, 500);
  assert.ok(await until(async () => (await viewer.evaluate(`document.getElementById("screen").width`)) === 200), "the frame was drawn");
  assert.equal(await viewer.evaluate(`document.getElementById("url").value`), "https://acme.example/login");
  assert.equal(await viewer.evaluate(`document.title`), "Sign in - Live view");
  const pixel = await viewer.evaluate(`(() => { const c = document.getElementById("screen"); const d = c.getContext("2d").getImageData(100, 50, 1, 1).data; return [d[0], d[1], d[2]]; })()`);
  assert.ok(pixel[0] > 200 && pixel[1] < 60 && pixel[2] < 60, `the red frame is on the canvas: ${pixel}`);
  const box = await viewer.evaluate(`(() => { const r = document.getElementById("screen").getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);

  // Mouse: the viewer's click at a point of the canvas is the page's point, by the frame's own width and height.
  const at = (fx, fy) => ({ x: box.left + box.width * fx, y: box.top + box.height * fy });
  const centre = at(0.5, 0.5);
  const from = web.received.length;
  await viewer.send("Input.dispatchMouseEvent", { type: "mousePressed", x: centre.x, y: centre.y, button: "left", clickCount: 1 });
  await viewer.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: centre.x, y: centre.y, button: "left", clickCount: 1 });
  assert.ok(await until(() => web.received.length >= from + 2));
  const [down, up] = web.received.slice(from, from + 2);
  assert.equal(down.type, "mouse"); assert.equal(down.action, "down"); assert.equal(down.button, "left"); assert.equal(down.clickCount, 1);
  assert.ok(Math.abs(down.x - 500) <= 1 && Math.abs(down.y - 250) <= 1, `canvas centre is the page's centre: ${down.x},${down.y}`);
  assert.equal(up.action, "up");
  const corner = at(0.1, 0.8);
  const f2 = web.received.length;
  await viewer.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: corner.x, y: corner.y });
  assert.ok(await until(() => web.received.length > f2));
  const moved = web.received.at(-1);
  assert.deepEqual([moved.type, moved.action], ["mouse", "move"]);
  assert.ok(Math.abs(moved.x - 100) <= 1 && Math.abs(moved.y - 400) <= 1, `a point of the canvas: ${moved.x},${moved.y}`);
  const f3 = web.received.length;
  await viewer.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: centre.x, y: centre.y, deltaX: 0, deltaY: 120 });
  assert.ok(await until(() => web.received.slice(f3).some((m) => m.type === "wheel")));
  const wheel = web.received.slice(f3).find((m) => m.type === "wheel");
  assert.equal(wheel.deltaY, 120);
  assert.ok(Math.abs(wheel.x - 500) <= 1);

  // Keys and paste: a key that makes text carries it, Enter carries a return, the paste shortcut is not sent as keys and the pasted text is a `text` message.
  const f4 = web.received.length;
  await viewer.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", text: "a", windowsVirtualKeyCode: 65 });
  await viewer.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
  await viewer.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await viewer.send("Input.dispatchKeyEvent", { type: "keyDown", key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 2 });
  await viewer.send("Input.dispatchKeyEvent", { type: "keyUp", key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 2 });
  await viewer.evaluate(`(() => { const dt = new DataTransfer(); dt.setData("text/plain", "pasted \\u00e9 text"); const e = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }); document.getElementById("screen").dispatchEvent(e); return e.defaultPrevented; })()`);
  assert.ok(await until(() => web.received.slice(f4).some((m) => m.type === "text")));
  const keys = web.received.slice(f4);
  assert.deepEqual(keys.filter((m) => m.type === "key").map((m) => [m.action, m.key, m.text]), [["down", "a", "a"], ["up", "a", undefined], ["down", "Enter", "\r"]], "no key message for the paste shortcut");
  assert.deepEqual(keys.find((m) => m.type === "text"), { type: "text", text: "pasted é text" });
  assert.equal(keys.find((m) => m.type === "key").windowsVirtualKeyCode, 65);

  // The address bar and its buttons.
  const f5 = web.received.length;
  await viewer.evaluate(`document.getElementById("back").click(); document.getElementById("reload").click(); const u = document.getElementById("url"); u.value = "example.com/x"; document.getElementById("go").requestSubmit(); 1`);
  assert.ok(await until(() => web.received.length >= f5 + 3));
  assert.deepEqual(web.received.slice(f5, f5 + 3), [{ type: "nav", action: "back" }, { type: "nav", action: "reload" }, { type: "nav", action: "url", url: "https://example.com/x" }]);

  // The server's notices and dialogs are shown; a dialog is answered with its prompt text.
  web.send({ type: "status", drive: "agent" });
  assert.ok(await until(async () => /agent/.test(await viewer.evaluate(`document.getElementById("notice").textContent`))), "the agent-acting notice");
  assert.equal(await viewer.evaluate(`document.getElementById("drive").className`), "agent");
  web.send({ type: "status", drive: "person" });
  assert.ok(await until(async () => (await viewer.evaluate(`document.getElementById("notice").hidden`)) === true), "the notice goes when the agent is done");
  web.send({ type: "held", reason: "agent_acting" });
  assert.ok(await until(async () => /Try again/.test(await viewer.evaluate(`document.getElementById("notice").textContent`))), "a held input says why");
  web.send({ type: "dialog", kind: "prompt", message: "Your name?", defaultPrompt: "d" });
  assert.ok(await until(async () => (await viewer.evaluate(`document.getElementById("dialog").hidden`)) === false), "the dialog is shown");
  assert.equal(await viewer.evaluate(`document.getElementById("dialog-message").textContent`), "Your name?");
  assert.equal(await viewer.evaluate(`document.getElementById("dialog-prompt").value`), "d");
  const f6 = web.received.length;
  await viewer.evaluate(`document.getElementById("dialog-prompt").value = "Ada"; document.getElementById("dialog-accept").click(); 1`);
  assert.ok(await until(() => web.received.length > f6));
  assert.deepEqual(web.received.at(-1), { type: "dialog", accept: true, promptText: "Ada" });
  web.send({ type: "dialog_closed" });
  assert.ok(await until(async () => (await viewer.evaluate(`document.getElementById("dialog").hidden`)) === true), "the dialog goes when the page's is closed");

  // A refusal ends the viewer: it says why and sends nothing more.
  web.send({ type: "refused", reason: "viewer_in_use" });
  assert.ok(await until(async () => /Another viewer/.test(await viewer.evaluate(`document.getElementById("notice").textContent`))));
  const f7 = web.received.length;
  await viewer.send("Input.dispatchMouseEvent", { type: "mousePressed", x: centre.x, y: centre.y, button: "left", clickCount: 1 });
  await settle(300);
  assert.equal(web.received.length, f7, "a viewer that was refused sends nothing");

  // What the viewer asked for: its page and its two files, the page under the live view's policy, and nothing external in any of the three.
  assert.deepEqual([...new Set(web.requests.map((r) => r.split("?")[0]))].filter((r) => r !== "/favicon.ico").sort(), [`/v/${web.id}`, "/viewer.css", "/viewer.js"].sort(), "its own page and two files, nothing else");
  assert.ok(web.requests.includes(`/v/${web.id}`));
  for (const [name, text] of Object.entries(viewerAssets)) {
    const urls = [...text.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]*/gi)].map((m) => m[0]);
    assert.deepEqual(urls.filter((u) => !/^(wss?|https?):\/\/$/.test(u) && !/^(wss?|https?):\/\/\s*$/.test(u) && u !== "https://" && u !== "wss://" && u !== "ws://"), [], `${name} names no external address`);
  }
  assert.doesNotMatch(viewerAssets.js, /\b(eval|new Function|localStorage|sessionStorage|indexedDB|document\.cookie)\b/, "no eval and no storage");
  assert.match(viewerAssets.html, /<script src="\.\.\/viewer\.js"><\/script>/);
  assert.match(viewerAssets.html, /<link rel="stylesheet" href="\.\.\/viewer\.css">/);
  assert.doesNotMatch(viewerAssets.html.replace(/<script src="[^"]*"><\/script>/g, ""), /<script|\son[a-z]+=|style=/, "no inline script, handler or style");
});

test("a page that gives no picture: the viewer says so after a moment, keeps input working, clears the status at the next frame, and a new title on the same page does not bring it back", { skip: NO_CHROME, timeout: 100_000 }, async (t) => {
  const TOKEN = randomBytes(32).toString("base64url");
  step("server");
  const web = await viewerServer(TOKEN);
  await new Promise((resolve) => http.get(`${web.base}/stranger-probe`, (res) => { res.resume(); res.on("end", resolve); }).on("error", resolve));
  assert.ok(!web.requests.includes("/stranger-probe"), "a plain client's request is not the viewer's");
  step("browser");
  const root = await mkdtemp(path.join(tmpdir(), "lv-viewer-"));
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root } });
  let ref = null;
  const tabs = [];
  t.after(async () => { for (const tab of tabs) tab.close(); if (ref) await within(20_000, provider.release(ref)); await within(5_000, web.close()); await within(5_000, rm(root, { recursive: true, force: true })); }, { timeout: 40_000 });
  ref = await within(60_000, provider.create({ tag: "lv-viewer", maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} }, new AbortController().signal));
  assert.ok(ref, "the browser started");
  const attached = await within(30_000, provider.attach(ref));
  assert.ok(attached, "the browser answered attach");
  const browserUrl = attached.sdkCdpUrl;
  step("attached");
  const open = async (url) => { const tab = await openTab(browserUrl, url); tabs.push(tab); return tab; };

  // A frame the viewer can decode: Chrome makes one.
  step("maker");
  const maker = await open("about:blank");
  const jpegBase64 = await maker.evaluate(`(async () => { const c = new OffscreenCanvas(200, 100); const g = c.getContext("2d"); g.fillStyle = "#ff0000"; g.fillRect(0, 0, 200, 100); const b = await c.convertToBlob({ type: "image/jpeg", quality: 0.9 }); const a = new Uint8Array(await b.arrayBuffer()); let s = ""; for (const x of a) s += String.fromCharCode(x); return btoa(s); })()`);
  const jpeg = Buffer.from(jpegBase64, "base64");
  assert.deepEqual([jpeg[0], jpeg[1]], [0xff, 0xd8]);

  const viewer = await open(`${web.base}/v/${web.id}#t=${TOKEN}`);
  assert.ok(await until(() => web.received.length >= 1), "the viewer connected and spoke");
  const still = () => viewer.evaluate(`document.getElementById("still").hidden`);
  web.send({ type: "ready", drive: "idle" });
  web.send({ type: "page", url: "https://one.example/", title: "One" });
  web.sendFrame(jpeg, 1000, 500);
  assert.ok(await until(async () => (await viewer.evaluate(`document.getElementById("screen").width`)) === 200), "the first page's frame was drawn");
  assert.equal(await still(), true, "a page that drew is not announced as pictureless");
  // The followed page changes to one that draws nothing: its address arrives, no frame follows.
  web.send({ type: "page", url: "https://background.example/", title: "Background" });
  await settle(600);
  assert.equal(await still(), true, "not at once: a page may be about to draw");
  assert.ok(await until(async () => (await still()) === false, 6_000), "after a moment the viewer says there is no picture");
  assert.match(await viewer.evaluate(`document.getElementById("still").textContent`), /background tab/);
  // Input still works: a click on the canvas is sent.
  const box = await viewer.evaluate(`(() => { const r = document.getElementById("screen").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const before = web.received.length;
  await viewer.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1 });
  await viewer.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", buttons: 0, clickCount: 1 });
  assert.ok(await until(() => web.received.slice(before).some((m) => m.type === "mouse" && m.action === "down")), "input is still sent while there is no picture");
  // The page draws: the status goes. A new title on the same page does not bring it back.
  web.sendFrame(jpeg, 1000, 500);
  assert.ok(await until(async () => (await still()) === true), "the next frame takes the status down");
  web.send({ type: "page", url: "https://background.example/", title: "Background, retitled" });
  await settle(3_200);
  assert.equal(await still(), true, "a new title on the same page is not a new page waiting for a picture");
});

test("a pending mouse move is sent before the button event that follows it: a move then a quick press and release arrive in the order they were made", { skip: NO_CHROME, timeout: 100_000 }, async (t) => {
  const TOKEN = randomBytes(32).toString("base64url");
  step("server");
  const web = await viewerServer(TOKEN);
  await new Promise((resolve) => http.get(`${web.base}/stranger-probe`, (res) => { res.resume(); res.on("end", resolve); }).on("error", resolve));
  assert.ok(!web.requests.includes("/stranger-probe"), "a plain client's request is not the viewer's");
  step("browser");
  const root = await mkdtemp(path.join(tmpdir(), "lv-viewer-"));
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root } });
  let ref = null;
  const tabs = [];
  t.after(async () => { for (const tab of tabs) tab.close(); if (ref) await within(20_000, provider.release(ref)); await within(5_000, web.close()); await within(5_000, rm(root, { recursive: true, force: true })); }, { timeout: 40_000 });
  ref = await within(60_000, provider.create({ tag: "lv-viewer", maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} }, new AbortController().signal));
  assert.ok(ref, "the browser started");
  const attached = await within(30_000, provider.attach(ref));
  assert.ok(attached, "the browser answered attach");
  const browserUrl = attached.sdkCdpUrl;
  step("attached");
  const open = async (url) => { const tab = await openTab(browserUrl, url); tabs.push(tab); return tab; };

  // A frame the viewer can decode: Chrome makes one.
  step("maker");
  const maker = await open("about:blank");
  const jpegBase64 = await maker.evaluate(`(async () => { const c = new OffscreenCanvas(200, 100); const g = c.getContext("2d"); g.fillStyle = "#ff0000"; g.fillRect(0, 0, 200, 100); const b = await c.convertToBlob({ type: "image/jpeg", quality: 0.9 }); const a = new Uint8Array(await b.arrayBuffer()); let s = ""; for (const x of a) s += String.fromCharCode(x); return btoa(s); })()`);
  const jpeg = Buffer.from(jpegBase64, "base64");
  assert.deepEqual([jpeg[0], jpeg[1]], [0xff, 0xd8]);

  const viewer = await open(`${web.base}/v/${web.id}#t=${TOKEN}`);
  assert.ok(await until(() => web.received.length >= 1), "the viewer connected and spoke");
  web.send({ type: "ready", drive: "idle" });
  web.send({ type: "page", url: "https://one.example/", title: "One" });
  web.sendFrame(jpeg, 1000, 500);
  assert.ok(await until(async () => (await viewer.evaluate(`document.getElementById("screen").width`)) === 200), "the frame was drawn");
  const before = web.received.length;
  // All four events in one task, so no animation frame runs between them: the viewer coalesces moves to one per frame, and a button event must not overtake the move before it.
  await viewer.evaluate(`(() => { const c = document.getElementById("screen"); const r = c.getBoundingClientRect(); const ev = (type, x, y, buttons) => c.dispatchEvent(new MouseEvent(type, { clientX: r.left + x, clientY: r.top + y, buttons, button: 0, bubbles: true, cancelable: true })); ev("mousemove", 10, 10, 0); ev("mousedown", 50, 40, 1); ev("mousemove", 60, 45, 1); ev("mouseup", 60, 45, 0); return true; })()`);
  assert.ok(await until(() => web.received.slice(before).filter((m) => m.type === "mouse").length >= 4), "all four mouse messages arrived");
  await settle(150);
  const got = web.received.slice(before).filter((m) => m.type === "mouse");
  assert.deepEqual(got.map((m) => m.action), ["move", "down", "move", "up"], `in the order they were made: ${JSON.stringify(got.map((m) => `${m.action}@${m.x},${m.y}`))}`);
  assert.ok(got[0].x < got[1].x && got[1].x < got[2].x, "each carries its own place: the first move is where the pointer was before the press, not where it pressed");
  assert.deepEqual(got.map((m) => m.buttons), [0, 1, 1, 0], "and the buttons held at that moment");

  // A drag that leaves the canvas: the moves and the release outside it are sent, kept inside the page's own area, once; and a window that loses focus releases the button.
  const out = web.received.length;
  await viewer.evaluate(`(() => { const c = document.getElementById("screen"); const r = c.getBoundingClientRect(); const on = (el, type, x, y, buttons) => el.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, buttons, button: 0, bubbles: true, cancelable: true })); on(c, "mousedown", r.left + 50, r.top + 40, 1); on(document.body, "mousemove", r.left - 30, r.top - 30, 1); on(document.body, "mouseup", r.left - 30, r.top - 30, 0); on(document.body, "mouseup", r.left - 30, r.top - 30, 0); return true; })()`);
  assert.ok(await until(() => web.received.slice(out).filter((m) => m.type === "mouse").length >= 3), "the press, the move outside and the release outside arrived");
  await settle(300);
  const dragged = web.received.slice(out).filter((m) => m.type === "mouse");
  assert.deepEqual(dragged.map((m) => m.action), ["down", "move", "up"], "one release, though two mouseups arrived outside");
  assert.deepEqual([dragged[1].x, dragged[1].y, dragged[2].x, dragged[2].y], [0, 0, 0, 0], "kept inside the page's own area");
  assert.deepEqual([dragged[1].buttons, dragged[2].buttons], [1, 0]);
  // Once released, nothing is held: a window that loses focus afterwards sends no second release.
  const idle = web.received.length;
  await viewer.evaluate(`(() => { window.dispatchEvent(new Event("blur")); return true; })()`);
  await settle(300);
  assert.deepEqual(web.received.slice(idle).filter((m) => m.type === "mouse"), [], "a blur after the release releases nothing");
  const blurAt = web.received.length;
  await viewer.evaluate(`(() => { const c = document.getElementById("screen"); const r = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent("mousedown", { clientX: r.left + 20, clientY: r.top + 20, buttons: 1, button: 0, bubbles: true, cancelable: true })); window.dispatchEvent(new Event("blur")); return true; })()`);
  assert.ok(await until(() => web.received.slice(blurAt).filter((m) => m.type === "mouse").length >= 2), "the press and the release on blur arrived");
  const blurred = web.received.slice(blurAt).filter((m) => m.type === "mouse");
  assert.deepEqual([blurred[0].action, blurred[1].action, blurred[1].buttons], ["down", "up", 0], "a window that loses focus releases the held button");
});

test("a window that loses focus releases every button still held, each by its own name: a right press then blur, and a left plus right chord then blur", { skip: NO_CHROME, timeout: 100_000 }, async (t) => {
  const TOKEN = randomBytes(32).toString("base64url");
  step("server");
  const web = await viewerServer(TOKEN);
  await new Promise((resolve) => http.get(`${web.base}/stranger-probe`, (res) => { res.resume(); res.on("end", resolve); }).on("error", resolve));
  assert.ok(!web.requests.includes("/stranger-probe"), "a plain client's request is not the viewer's");
  step("browser");
  const root = await mkdtemp(path.join(tmpdir(), "lv-viewer-"));
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root } });
  let ref = null;
  const tabs = [];
  t.after(async () => { for (const tab of tabs) tab.close(); if (ref) await within(20_000, provider.release(ref)); await within(5_000, web.close()); await within(5_000, rm(root, { recursive: true, force: true })); }, { timeout: 40_000 });
  ref = await within(60_000, provider.create({ tag: "lv-viewer", maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} }, new AbortController().signal));
  assert.ok(ref, "the browser started");
  const attached = await within(30_000, provider.attach(ref));
  assert.ok(attached, "the browser answered attach");
  const browserUrl = attached.sdkCdpUrl;
  step("attached");
  const open = async (url) => { const tab = await openTab(browserUrl, url); tabs.push(tab); return tab; };

  // A frame the viewer can decode: Chrome makes one.
  step("maker");
  const maker = await open("about:blank");
  const jpegBase64 = await maker.evaluate(`(async () => { const c = new OffscreenCanvas(200, 100); const g = c.getContext("2d"); g.fillStyle = "#ff0000"; g.fillRect(0, 0, 200, 100); const b = await c.convertToBlob({ type: "image/jpeg", quality: 0.9 }); const a = new Uint8Array(await b.arrayBuffer()); let s = ""; for (const x of a) s += String.fromCharCode(x); return btoa(s); })()`);
  const jpeg = Buffer.from(jpegBase64, "base64");
  assert.deepEqual([jpeg[0], jpeg[1]], [0xff, 0xd8]);

  const viewer = await open(`${web.base}/v/${web.id}#t=${TOKEN}`);
  assert.ok(await until(() => web.received.length >= 1), "the viewer connected and spoke");
  web.send({ type: "ready", drive: "idle" });
  web.send({ type: "page", url: "https://one.example/", title: "One" });
  web.sendFrame(jpeg, 1000, 500);
  assert.ok(await until(async () => (await viewer.evaluate(`document.getElementById("screen").width`)) === 200), "the frame was drawn");
  const drive = async (steps) => {
    const at = web.received.length;
    await viewer.evaluate(`(() => { const c = document.getElementById("screen"); const r = c.getBoundingClientRect(); const on = (type, buttons, button) => c.dispatchEvent(new MouseEvent(type, { clientX: r.left + 30, clientY: r.top + 30, buttons, button, bubbles: true, cancelable: true })); ${steps}; return true; })()`);
    await settle(400);
    return web.received.slice(at).filter((m) => m.type === "mouse").map((m) => [m.action, m.button, m.buttons]);
  };
  assert.deepEqual(await drive(`on("mousedown", 2, 2); window.dispatchEvent(new Event("blur"))`), [["down", "right", 2], ["up", "right", 0]], "a right press then blur releases the RIGHT button, with nothing held after");
  assert.deepEqual(await drive(`on("mousedown", 4, 1); window.dispatchEvent(new Event("blur"))`), [["down", "middle", 4], ["up", "middle", 0]], "and a middle press the middle button");
  assert.deepEqual(await drive(`on("mousedown", 1, 0); on("mousedown", 3, 2); window.dispatchEvent(new Event("blur"))`), [["down", "left", 1], ["down", "right", 3], ["up", "right", 1], ["up", "left", 0]], "a chord is released button by button, with the buttons still held after each");
  assert.deepEqual(await drive(`on("mousedown", 1, 0); on("mousemove", 3, 0); window.dispatchEvent(new Event("blur"))`), [["down", "left", 1], ["move", undefined, 3], ["up", "right", 1], ["up", "left", 0]], "a button that joined the drag in a move is released too");
  assert.deepEqual(await drive(`window.dispatchEvent(new Event("blur"))`), [], "a blur with nothing held releases nothing");
  assert.deepEqual(await drive(`on("mousedown", 1, 0); on("mouseup", 0, 0); window.dispatchEvent(new Event("blur"))`), [["down", "left", 1], ["up", "left", 0]], "a button already released is not released again by a blur");
});

test("before the host says ready the viewer says it is connecting and refuses input out loud: nothing is sent, each kind of input says so, and once ready the notice goes and the same input is sent", { skip: NO_CHROME, timeout: 100_000 }, async (t) => {
  const TOKEN = randomBytes(32).toString("base64url");
  step("server");
  const web = await viewerServer(TOKEN);
  step("browser");
  const root = await mkdtemp(path.join(tmpdir(), "lv-viewer-"));
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root } });
  let ref = null;
  const tabs = [];
  t.after(async () => { for (const tab of tabs) tab.close(); if (ref) await within(20_000, provider.release(ref)); await within(5_000, web.close()); await within(5_000, rm(root, { recursive: true, force: true })); }, { timeout: 40_000 });
  ref = await within(60_000, provider.create({ tag: "lv-viewer", maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} }, new AbortController().signal));
  assert.ok(ref, "the browser started");
  const attached = await within(30_000, provider.attach(ref));
  assert.ok(attached, "the browser answered attach");
  const open = async (url) => { const tab = await openTab(attached.sdkCdpUrl, url); tabs.push(tab); return tab; };

  const viewer = await open(`${web.base}/v/${web.id}#t=${TOKEN}`);
  assert.ok(await until(() => web.received.length >= 1), "the viewer connected and spoke");
  assert.deepEqual(web.received, [{ type: "hello", token: TOKEN }], "only the hello so far: the host has not said ready");
  const notice = () => viewer.evaluate(`({ hidden: document.getElementById("notice").hidden, text: document.getElementById("notice").textContent })`);

  // Waiting for the host is a visible state, not a blank page.
  const waiting = await notice();
  assert.equal(waiting.hidden, false, "the viewer shows a state while it waits for the host");
  assert.match(waiting.text, /connecting/i);

  // Each kind of input is refused out loud (the notice is cleared between them, so each has to say it itself) and none is sent.
  const refused = async (label, act) => {
    await viewer.evaluate(`(() => { const n = document.getElementById("notice"); n.textContent = ""; n.hidden = true; })()`);
    await act();
    assert.ok(await until(async () => { const n = await notice(); return !n.hidden && /not sent/i.test(n.text); }), `${label} before ready is refused out loud`);
  };
  await refused("a key", async () => {
    await viewer.evaluate(`document.getElementById("sink").focus()`);
    await viewer.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", text: "a", windowsVirtualKeyCode: 65 });
    await viewer.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
  });
  await refused("a mouse press", async () => {
    const box = await viewer.evaluate(`(() => { const r = document.getElementById("screen").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await viewer.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await viewer.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  });
  await refused("a wheel turn", async () => {
    const box = await viewer.evaluate(`(() => { const r = document.getElementById("screen").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await viewer.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: 120 });
  });
  await refused("the back button", () => viewer.evaluate(`document.getElementById("back").click()`));
  await settle(300);
  assert.deepEqual(web.received, [{ type: "hello", token: TOKEN }], "nothing but the hello was sent while the host had not said ready: refused, not queued for later");

  // Ready: the notice goes, and the same input is sent.
  web.send({ type: "ready", drive: "idle" });
  assert.ok(await until(async () => (await notice()).hidden === true), "the notice goes at ready");
  await viewer.evaluate(`document.getElementById("sink").focus()`);
  await viewer.send("Input.dispatchKeyEvent", { type: "keyDown", key: "b", code: "KeyB", text: "b", windowsVirtualKeyCode: 66 });
  assert.ok(await until(() => web.received.some((m) => m.type === "key" && m.action === "down" && m.key === "b")), "after ready the same input is sent");
  assert.equal(web.received.some((m) => m.type === "key" && m.key === "a"), false, "and the key refused before ready never arrives late");
});

test("once the connection has closed, input leaves the disconnect notice alone: it never turns into 'still connecting' for a link that will not come back, whether the socket closed before ready or after", { skip: NO_CHROME, timeout: 100_000 }, async (t) => {
  const TOKEN = randomBytes(32).toString("base64url");
  step("server");
  const web = await viewerServer(TOKEN);
  step("browser");
  const root = await mkdtemp(path.join(tmpdir(), "lv-viewer-"));
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root } });
  let ref = null;
  const tabs = [];
  t.after(async () => { for (const tab of tabs) tab.close(); if (ref) await within(20_000, provider.release(ref)); await within(5_000, web.close()); await within(5_000, rm(root, { recursive: true, force: true })); }, { timeout: 40_000 });
  ref = await within(60_000, provider.create({ tag: "lv-viewer", maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} }, new AbortController().signal));
  assert.ok(ref, "the browser started");
  const attached = await within(30_000, provider.attach(ref));
  assert.ok(attached, "the browser answered attach");
  const open = async (url) => { const tab = await openTab(attached.sdkCdpUrl, url); tabs.push(tab); return tab; };

  for (const afterReady of [false, true]) {
    const label = afterReady ? "closed after ready" : "closed before ready";
    const seen = web.received.length;
    const viewer = await open(`${web.base}/v/${web.id}#t=${TOKEN}`);
    assert.ok(await until(() => web.received.length > seen), `${label}: the viewer connected and spoke`);
    const notice = () => viewer.evaluate(`({ hidden: document.getElementById("notice").hidden, text: document.getElementById("notice").textContent })`);
    if (afterReady) {
      web.send({ type: "ready", drive: "idle" });
      assert.ok(await until(async () => (await notice()).hidden === true), `${label}: ready cleared the notice`);
    }
    web.closeSockets();
    assert.ok(await until(async () => /disconnected/i.test((await notice()).text)), `${label}: the viewer says it is disconnected`);
    await viewer.evaluate(`document.getElementById("sink").focus()`);
    await viewer.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", text: "a", windowsVirtualKeyCode: 65 });
    await viewer.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
    await viewer.evaluate(`document.getElementById("back").click()`);
    await settle(400);
    const after = await notice();
    assert.match(after.text, /disconnected/i, `${label}: the disconnect notice is still the one shown`);
    assert.doesNotMatch(after.text, /still connecting/i, `${label}: input on a closed connection does not say the viewer is connecting`);
    assert.equal(after.hidden, false);
  }
});
