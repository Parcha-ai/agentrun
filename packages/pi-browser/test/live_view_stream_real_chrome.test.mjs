// The live view's stream (src/live-view/stream.ts) against a real Chrome: frames are real JPEGs, a click and typed text sent as protocol messages reach the page, a wheel scrolls it, a JS dialog is shown and answered, an address,
// back and reload work, and the stream moves to a page opened later. Only the stream: the server and the viewer page are tested apart.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openStream } from "../dist/live-view/stream.js";
import { cdpProvider } from "../dist/providers/cdp.js";
import { CHROME, NO_CHROME } from "./fixtures/local-chrome.mjs";

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (ms, work) => Promise.race([Promise.resolve(work).catch(() => undefined), settle(ms)]);
const until = async (check, ms = 15_000) => { for (let i = 0; i < ms / 25 && !check(); i += 1) await settle(25); return check(); };

const PAGE = `<!doctype html><html><head><title>LV test</title><style>body{margin:0;height:3000px;font:16px sans-serif}
#in{position:absolute;left:20px;top:60px;width:240px;height:30px}#go{position:absolute;left:20px;top:110px;width:120px;height:30px}#al{position:absolute;left:160px;top:110px;width:120px;height:30px}</style></head>
<body><input id="in" autocomplete="off"><button id="go">send</button><button id="al">alert</button>
<script>
const post = (path, body) => fetch(path, { method: "POST", body: JSON.stringify(body) });
document.getElementById("go").onclick = () => post("/seen", { value: document.getElementById("in").value });
document.getElementById("al").onclick = () => { alert("hello from the page"); post("/alerted", {}); };
let last = 0;
addEventListener("scroll", () => { if (Date.now() - last > 200) { last = Date.now(); post("/scrolled", { y: scrollY }); } });
</script></body></html>`;
const TWO = `<!doctype html><html><head><title>Two</title></head><body><p>second page</p></body></html>`;

async function site() {
  const log = { loads: 0, seen: [], alerted: 0, scrolled: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.url === "/lv") { log.loads += 1; res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }); return res.end(PAGE); }
      // The pathname, not the whole address: the new tab in the last step asks for /two?tab=2, and an answer of 204 (no content) never commits a document, so that tab would stay empty and send no frame.
      if (new URL(req.url, "http://placeholder").pathname === "/two") { res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }); return res.end(TWO); }
      if (req.url === "/seen") log.seen.push(JSON.parse(body));
      else if (req.url === "/alerted") log.alerted += 1;
      else if (req.url === "/scrolled") log.scrolled.push(JSON.parse(body).y);
      res.writeHead(204); res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { log, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

/** One command to the browser over a short socket of the test's own (a page opened as a person opens a tab). */
function browserCall(url, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error(`${method} did not answer`)); }, 10_000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (event) => { const m = JSON.parse(String(event.data)); if (m.id === 1) { clearTimeout(timer); ws.close(); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("socket error")); };
  });
}

test("a real Chrome: frames are JPEGs, a click and typed text reach the page, a wheel scrolls it, a dialog is shown and answered, an address, back and reload work, and a page opened later is followed", { skip: NO_CHROME, timeout: 150_000 }, async (t) => {
  const web = await site();
  const root = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "lv-stream-"));
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root } });
  let ref = null;
  let stream = null;
  t.after(async () => { stream?.close(); if (ref) await within(20_000, provider.release(ref)); await within(5_000, web.close()); await within(5_000, rm(root, { recursive: true, force: true })); }, { timeout: 40_000 });
  ref = await within(60_000, provider.create({ tag: "lv-stream", maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} }, new AbortController().signal));
  assert.ok(ref, "the browser started");
  const target = await provider.attach(ref);

  const seen = { frames: [], pages: [], dialogs: [] };
  stream = openStream(target.sdkCdpUrl, {
    frame: (bytes, size, ack) => { seen.frames.push({ magic: [bytes[0], bytes[1]], size }); ack(); },
    page: (p) => seen.pages.push(p),
    dialog: (d) => seen.dialogs.push(d),
    closed: () => {},
  });
  assert.ok(await until(() => seen.frames.length >= 1), "a frame arrived");
  assert.deepEqual(seen.frames[0].magic, [0xff, 0xd8], "a real JPEG");
  assert.ok(seen.frames[0].size.w > 0 && seen.frames[0].size.h > 0, `the page's size: ${JSON.stringify(seen.frames[0].size)}`);

  // An address typed in the bar.
  await stream.nav({ type: "nav", action: "url", url: `${web.base}/lv` });
  assert.ok(await until(() => seen.pages.some((p) => p.url === `${web.base}/lv` && p.title === "LV test")), `the page shown is announced with its title: ${JSON.stringify(seen.pages)}`);
  const framesAfterLoad = seen.frames.length;

  // A click into the field, typed keys and pasted text, then a click on the button: the page receives them.
  await stream.input({ type: "mouse", action: "down", x: 100, y: 75, button: "left", clickCount: 1 });
  await stream.input({ type: "mouse", action: "up", x: 100, y: 75, button: "left", clickCount: 1 });
  for (const ch of ["h", "i"]) {
    await stream.input({ type: "key", action: "down", key: ch, code: `Key${ch.toUpperCase()}`, text: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
    await stream.input({ type: "key", action: "up", key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
  }
  await stream.input({ type: "text", text: "-pasted" });
  await stream.input({ type: "mouse", action: "down", x: 80, y: 125, button: "left", clickCount: 1 });
  await stream.input({ type: "mouse", action: "up", x: 80, y: 125, button: "left", clickCount: 1 });
  assert.ok(await until(() => seen.frames.length > framesAfterLoad), "a change on the page (the field's focus and text) sends a new frame: Chrome sends none for a still page");
  assert.ok(await until(() => web.log.seen.length === 1), "the click on the button reached the page");
  assert.deepEqual(web.log.seen[0], { value: "hi-pasted" }, "the typed keys and the pasted text reached the field the click focused");

  // A wheel scrolls the page.
  await stream.input({ type: "wheel", x: 100, y: 300, deltaX: 0, deltaY: 400 });
  assert.ok(await until(() => web.log.scrolled.some((y) => y > 100)), `the page scrolled: ${JSON.stringify(web.log.scrolled)}`);

  // A dialog is shown to the viewer and answered by it.
  await stream.input({ type: "wheel", x: 100, y: 300, deltaX: 0, deltaY: -1000 });
  await settle(300);
  await stream.input({ type: "mouse", action: "down", x: 200, y: 125, button: "left", clickCount: 1 });
  await stream.input({ type: "mouse", action: "up", x: 200, y: 125, button: "left", clickCount: 1 });
  assert.ok(await until(() => seen.dialogs.some((d) => d?.message === "hello from the page")), `the dialog was shown: ${JSON.stringify(seen.dialogs)}`);
  assert.equal(seen.dialogs.find((d) => d)?.kind, "alert");
  await stream.dialog({ type: "dialog", accept: true });
  assert.ok(await until(() => seen.dialogs.at(-1) === null), "the dialog's end is reported");
  assert.ok(await until(() => web.log.alerted === 1), "the page went on after the dialog was answered");

  // Another address, back, and reload.
  await stream.nav({ type: "nav", action: "url", url: `${web.base}/two` });
  assert.ok(await until(() => seen.pages.at(-1)?.title === "Two"), "the second page is shown");
  await stream.nav({ type: "nav", action: "back" });
  assert.ok(await until(() => seen.pages.at(-1)?.url === `${web.base}/lv`), `back returns to the first page: ${JSON.stringify(seen.pages.at(-1))}`);
  const loads = web.log.loads;
  await stream.nav({ type: "nav", action: "reload" });
  assert.ok(await until(() => web.log.loads > loads), "a reload loads the page again");

  // A page opened later (a person's tab, a link that opens one) is the one followed.
  // Frames are counted from the moment the new page is ANNOUNCED (the stream announces it as it starts following it, before any frame of it can arrive), not from when this test noticed: a first frame that landed in between is not missed.
  const announcedAt = [];
  const announced = (p) => { announcedAt.push([p.url, seen.frames.length]); };
  const stopWatching = ((orig) => { seen.pages.push = (p) => { announced(p); return orig.call(seen.pages, p); }; return () => { seen.pages.push = orig; }; })(seen.pages.push);
  await browserCall(target.sdkCdpUrl, "Target.createTarget", { url: `${web.base}/two?tab=2` });
  assert.ok(await until(() => seen.pages.at(-1)?.url === `${web.base}/two?tab=2`, 30_000), `the new tab is followed: ${JSON.stringify(seen.pages.at(-1))}`);
  stopWatching();
  // The tab must really load its document: a page that never committed (a server answer of 204 does that) has no frame to send, however the stream behaves.
  assert.ok(await until(() => seen.pages.at(-1)?.title === "Two", 30_000), `the new tab loaded the second page: ${JSON.stringify(seen.pages.at(-1))}`);
  const before = announcedAt.find(([url]) => url === `${web.base}/two?tab=2`)?.[1] ?? seen.frames.length;
  const arrived = await until(() => seen.frames.length > before, 30_000);
  if (!arrived) {
    // Why, if it ever fails: what Chrome says to a screenshot of the page now, from a socket of this test's own.
    const probe = await within(15_000, browserCall(target.sdkCdpUrl, "Target.getTargets", {}));
    assert.fail(`frames of the new page arrive: none in 30 s (frames ${seen.frames.length}, counted from ${before}; pages ${JSON.stringify(seen.pages.map((p) => p.url))}; targets ${JSON.stringify((probe?.targetInfos ?? []).filter((x) => x.type === "page").map((x) => [x.url, x.attached]))})`);
  }
});
