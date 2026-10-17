// The live view's whole path in two real Chromes: the viewer page runs in Chrome A and is driven with CDP mouse and keys as a person drives it (click the username field, type, click the password field, type, click submit);
// the host's server and stream carry it into Chrome B, which shows a fixture login page. The login must land. The viewer's outgoing messages are logged beside the ones the same actions make straight over the
// protocol, so a difference between the two is visible in the test output (nothing printed names a token or a URL of the viewer).
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createLiveView } from "../dist/live-view/index.js";
import { cdpProvider } from "../dist/providers/cdp.js";
import { connect } from "./fixtures/ws-client.mjs";
import { CHROME, NO_CHROME } from "./fixtures/local-chrome.mjs";

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (ms, work) => Promise.race([Promise.resolve(work).catch(() => undefined), settle(ms)]);
/** Waits until `check` is true; a check that throws (a page that has not loaded yet has no element to ask) is not true yet. */
const until = async (check, ms = 15_000) => { const ok = async () => { try { return await check(); } catch { return false; } }; for (let i = 0; i < ms / 25 && !(await ok()); i += 1) await settle(25); return ok(); };

const LOGIN = `<!doctype html><html><head><title>Sign in</title><style>body{margin:0;font:16px sans-serif}
input,button{position:absolute;left:120px;width:300px;height:36px;font:16px sans-serif}#user{top:140px}#pass{top:200px}#go{top:260px;width:120px}</style></head>
<body><h1 style="margin:30px 120px">Sign in</h1>
<input id="user" autocomplete="off" aria-label="user"><input id="pass" type="password" autocomplete="off" aria-label="pass"><button id="go" type="button">Sign in</button>
<script>window.__moves = []; addEventListener("mousemove", (e) => window.__moves.push(e.buttons)); window.__downs = []; addEventListener("mousedown", (e) => window.__downs.push(e.buttons)); window.__ups = []; addEventListener("mouseup", (e) => window.__ups.push(e.buttons)); window.__upButtons = []; addEventListener("mouseup", (e) => window.__upButtons.push(e.button));
document.getElementById("go").onclick = () => fetch("/login", { method: "POST", body: JSON.stringify({ user: document.getElementById("user").value, pass: document.getElementById("pass").value }) });</script></body></html>`;

async function site() {
  const log = { logins: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.url === "/page") { res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }); return res.end(LOGIN); }
      if (req.url === "/login") log.logins.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(204); res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { log, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

/** A tab of a browser the test drives, over one socket of its own. */
async function openTab(browserUrl, url = "about:blank", before) {
  const ws = new WebSocket(browserUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("socket error")); });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (event) => { const m = JSON.parse(String(event.data)); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} did not answer`)); }, 15_000);
    pending.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  if (before) await send("Page.addScriptToEvaluateOnNewDocument", { source: before }, sessionId);
  const evaluate = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId); if (r.exceptionDetails) throw new Error(`the page threw: ${r.exceptionDetails.text}`); return r.result.value; };
  const tab = { send: (method, params) => send(method, params, sessionId), evaluate, close: () => { try { ws.close(); } catch {} } };
  if (url !== "about:blank") await tab.send("Page.navigate", { url });
  return tab;
}

// What a person's keyboard makes: a keyDown with the character as text, then a keyUp; Shift for a capital.
const KEYS = { "-": ["Minus", 189], "!": ["Digit1", 49] };
const keyOf = (ch) => {
  const upper = ch.toUpperCase();
  if (/[a-z]/i.test(ch)) return { code: `Key${upper}`, vk: upper.charCodeAt(0), shift: ch !== ch.toLowerCase() };
  if (/[0-9]/.test(ch)) return { code: `Digit${ch}`, vk: ch.charCodeAt(0), shift: false };
  const [code, vk] = KEYS[ch];
  return { code, vk, shift: ch === "!" };
};
async function typeLikeAPerson(tab, text) {
  for (const ch of text) {
    const k = keyOf(ch);
    const modifiers = k.shift ? 8 : 0;
    await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, code: k.code, text: ch, unmodifiedText: k.shift ? ch.toLowerCase() : ch, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers });
    await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers });
  }
}
const clickLikeAPerson = async (tab, p) => {
  await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "none", buttons: 0 });
  await tab.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 1 });
  await tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", buttons: 0, clickCount: 1 });
};

const USER = "alice";
const PASS = "Pa55-w0rd!";
const SPY = `window.__sent = []; (() => { const send = WebSocket.prototype.send; WebSocket.prototype.send = function (data) { try { if (typeof data === "string") { const m = JSON.parse(data); if (m.type !== "hello") window.__sent.push(m); } } catch {} return send.call(this, data); }; })();`;
/** The messages as one line each: what a reader compares. */
const short = (m) => m.type === "mouse" ? `mouse ${m.action} ${m.x},${m.y} ${m.button} n=${m.clickCount} mod=${m.modifiers ?? 0}` : m.type === "key" ? `key ${m.action} ${JSON.stringify(m.key)} ${m.code} vk=${m.windowsVirtualKeyCode} text=${JSON.stringify(m.text ?? null)} mod=${m.modifiers ?? 0}` : JSON.stringify(m);

async function rig(t) {
  const web = await site();
  const root = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "lv-full-"));
  const target = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: path.join(root, "target") } });
  const viewer = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: path.join(root, "viewer") } });
  const refs = [];
  let host = null;
  const tabs = [];
  t.after(async () => { for (const tab of tabs) tab.close(); await within(5_000, host?.close()); for (const [p, r] of refs) await within(20_000, p.release(r)); await within(5_000, web.close()); await within(5_000, rm(root, { recursive: true, force: true })); }, { timeout: 60_000 });
  const spec = (tag, viewport) => ({ tag, maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport, metadata: {} });
  const tref = await within(60_000, target.create(spec("lv-target", { width: 1000, height: 700 }), new AbortController().signal));
  assert.ok(tref, "the target browser started"); refs.push([target, tref]);
  const vref = await within(60_000, viewer.create(spec("lv-viewer", { width: 800, height: 600 }), new AbortController().signal));
  assert.ok(vref, "the viewer's browser started"); refs.push([viewer, vref]);
  const targetCdp = (await target.attach(tref)).sdkCdpUrl;
  const viewerCdp = (await viewer.attach(vref)).sdkCdpUrl;
  const pageTab = await openTab(targetCdp, `${web.base}/page`);
  tabs.push(pageTab);
  assert.ok(await until(async () => (await pageTab.evaluate(`document.title`)) === "Sign in"), "the login page loaded in the target");
  host = createLiveView({ hostOrigin: null }); // the host's own driving gates: the real path
  const view = await host.open("ar-run-fp-1", targetCdp);
  return { web, view, host, pageTab, viewerCdp, tabs };
}

const FIELDS = `(() => { const f = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }; return { vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio, user: f("user"), pass: f("pass"), go: f("go") }; })()`;

test("full path: the viewer page driven with CDP mouse and keys like a person logs in on the page it shows", { skip: NO_CHROME, timeout: 150_000 }, async (t) => {
  const r = await rig(t);
  const viewerTab = await openTab(r.viewerCdp, r.view.fullscreen, SPY);
  r.tabs.push(viewerTab);
  assert.ok(await until(() => viewerTab.evaluate(`document.getElementById("screen").width > 100`)), "the viewer drew a frame of the target");
  await settle(500);
  const geo = await viewerTab.evaluate(`(() => { const c = document.getElementById("screen"); const b = c.getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height, cw: c.width, ch: c.height, dpr: devicePixelRatio, iw: innerWidth, ih: innerHeight }; })()`);
  const f = await r.pageTab.evaluate(FIELDS);
  // Where a person sees each control on the viewer: the canvas shows the target's whole viewport, scaled to fit.
  const onScreen = (p) => ({ x: geo.l + (p.x / f.vw) * geo.w, y: geo.t + (p.y / f.vh) * geo.h });
  console.log(`geometry: target viewport ${f.vw}x${f.vh} dpr ${f.dpr}; viewer window ${geo.iw}x${geo.ih} dpr ${geo.dpr}; canvas bitmap ${geo.cw}x${geo.ch} shown ${Math.round(geo.w)}x${Math.round(geo.h)} at ${Math.round(geo.l)},${Math.round(geo.t)}`);

  await clickLikeAPerson(viewerTab, onScreen(f.user));
  await typeLikeAPerson(viewerTab, USER);
  await clickLikeAPerson(viewerTab, onScreen(f.pass));
  await typeLikeAPerson(viewerTab, PASS);
  const typed = await until(async () => (await r.pageTab.evaluate(`document.getElementById("user").value + "|" + document.getElementById("pass").value`)) === `${USER}|${PASS}`, 8_000);
  const fields = await r.pageTab.evaluate(`document.getElementById("user").value.length + "," + document.getElementById("pass").value.length`);
  await clickLikeAPerson(viewerTab, onScreen(f.go));
  await until(() => r.web.log.logins.length > 0, 5_000);

  const sent = await viewerTab.evaluate(`window.__sent`);
  console.log("the viewer sent:\n" + sent.map(short).join("\n"));
  const ideal = [["user", f.user], ["pass", f.pass], ["go", f.go]].map(([name, p]) => `${name} at ${p.x},${p.y}`);
  const downs = sent.filter((m) => m.type === "mouse" && m.action === "down");
  console.log(`the clicks should land on the page's own coordinates: ${ideal.join("; ")}; the viewer sent downs at ${downs.map((m) => `${m.x},${m.y}`).join("; ")}`);
  for (const [i, p] of [f.user, f.pass, f.go].entries()) assert.ok(downs[i] && Math.abs(downs[i].x - p.x) <= 2 && Math.abs(downs[i].y - p.y) <= 2, `click ${i + 1} maps to the page's own coordinates (${p.x},${p.y}); the viewer sent ${downs[i] ? `${downs[i].x},${downs[i].y}` : "nothing"}`);
  const keyDowns = sent.filter((m) => m.type === "key" && m.action === "down");
  assert.deepEqual(keyDowns.map((m) => m.text), [...USER, ...PASS], "every printable key goes with its text");
  assert.ok(typed, `the typed text reached the fields (lengths user,pass = ${fields}; expected ${USER.length},${PASS.length})`);
  assert.deepEqual(r.web.log.logins, [{ user: USER, pass: PASS }], "the login landed");
});

test("full path, the control: the same actions sent straight over the protocol log in", { skip: NO_CHROME, timeout: 150_000 }, async (t) => {
  const r = await rig(t);
  const u = new URL(r.view.fullscreen);
  const token = new URLSearchParams(u.hash.slice(1)).get("t");
  u.hash = "";
  const c = await connect(`ws://${u.host}${u.pathname}/ws`, { origin: u.origin });
  assert.equal(c.status, 101);
  c.ws.sendJson({ type: "hello", token });
  assert.equal(JSON.parse((await c.ws.next()).data).type, "ready");
  t.after(() => c.ws.destroy(), { timeout: 10_000 });
  await c.ws.until((m) => m.type === "binary", 10_000); // the stream has attached to the page: input before that is held with no_page
  const f = await r.pageTab.evaluate(FIELDS);
  const sent = [];
  const out = (m) => { sent.push(m); c.ws.sendJson(m); };
  const click = (p) => { out({ type: "mouse", action: "down", x: p.x, y: p.y, button: "left", clickCount: 1, modifiers: 0 }); out({ type: "mouse", action: "up", x: p.x, y: p.y, button: "left", clickCount: 1, modifiers: 0 }); };
  const type = async (text) => { for (const ch of text) { const k = keyOf(ch); const modifiers = k.shift ? 8 : 0; out({ type: "key", action: "down", key: ch, code: k.code, windowsVirtualKeyCode: k.vk, modifiers, text: ch }); out({ type: "key", action: "up", key: ch, code: k.code, windowsVirtualKeyCode: k.vk, modifiers }); await settle(5); } };
  click(f.user); await settle(50); await type(USER);
  click(f.pass); await settle(50); await type(PASS);
  click(f.go);
  await until(() => r.web.log.logins.length > 0, 8_000);
  console.log("straight over the protocol:\n" + sent.map(short).join("\n"));
  assert.deepEqual(r.web.log.logins, [{ user: USER, pass: PASS }], "the login landed");
});

// What different drivers send for a typed character. The viewer must carry every one of them to the page: a person's browser and a script's CDP both end in the viewer's keydown.
const SHAPES = {
  "a keyboard's full event (key, code, text, virtual key)": (ch, k, modifiers) => [{ type: "keyDown", key: ch, code: k.code, text: ch, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers }, { type: "keyUp", key: ch, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers }],
  "key and text only: no code, no virtual key": (ch, _k, modifiers) => [{ type: "keyDown", key: ch, text: ch, modifiers }, { type: "keyUp", key: ch, modifiers }],
  "key, text and virtual key, no code": (ch, k, modifiers) => [{ type: "keyDown", key: ch, text: ch, windowsVirtualKeyCode: k.vk, modifiers }, { type: "keyUp", key: ch, windowsVirtualKeyCode: k.vk, modifiers }],
  "rawKeyDown then char then keyUp, with a code": (ch, k, modifiers) => [{ type: "rawKeyDown", key: ch, code: k.code, windowsVirtualKeyCode: k.vk, modifiers }, { type: "char", key: ch, text: ch, modifiers }, { type: "keyUp", key: ch, code: k.code, windowsVirtualKeyCode: k.vk, modifiers }],
  "rawKeyDown then char then keyUp, no code": (ch, k, modifiers) => [{ type: "rawKeyDown", key: ch, windowsVirtualKeyCode: k.vk, modifiers }, { type: "char", key: ch, text: ch, modifiers }, { type: "keyUp", key: ch, windowsVirtualKeyCode: k.vk, modifiers }],
};

test("full path: every shape of typed key a driver sends reaches the field, and the viewer sends the server a message it accepts for each", { skip: NO_CHROME, timeout: 150_000 }, async (t) => {
  const r = await rig(t);
  const viewerTab = await openTab(r.viewerCdp, r.view.fullscreen, SPY);
  r.tabs.push(viewerTab);
  assert.ok(await until(() => viewerTab.evaluate(`document.getElementById("screen").width > 100`)), "the viewer drew a frame of the target");
  await settle(500);
  const failures = [];
  for (const [name, make] of Object.entries(SHAPES)) {
    await r.pageTab.evaluate(`document.getElementById("user").value = ""; document.getElementById("user").blur(); true`);
    const geo = await viewerTab.evaluate(`(() => { const b = document.getElementById("screen").getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height }; })()`);
    const f = await r.pageTab.evaluate(FIELDS);
    await clickLikeAPerson(viewerTab, { x: geo.l + (f.user.x / f.vw) * geo.w, y: geo.t + (f.user.y / f.vh) * geo.h });
    await viewerTab.evaluate(`window.__sent.length = 0; true`);
    for (const ch of "Ab1") { const k = keyOf(ch); for (const params of make(ch, k, k.shift ? 8 : 0)) await viewerTab.send("Input.dispatchKeyEvent", params); }
    const landed = await until(async () => (await r.pageTab.evaluate(`document.getElementById("user").value`)) === "Ab1", 3_000);
    const value = await r.pageTab.evaluate(`document.getElementById("user").value`);
    const sent = (await viewerTab.evaluate(`window.__sent`)).filter((m) => m.type === "key");
    console.log(`${landed ? "LANDED" : "LOST  "} [${name}] field=${JSON.stringify(value)}; the viewer sent:\n  ${sent.map(short).join("\n  ") || "(no key message)"}`);
    if (!landed) failures.push(`${name}: the field holds ${JSON.stringify(value)}`);
  }
  assert.deepEqual(failures, [], "every shape of typed key reaches the field");
});

test("full path: a viewer window at devicePixelRatio 2 maps clicks to the page's own coordinates", { skip: NO_CHROME, timeout: 150_000 }, async (t) => {
  const r = await rig(t);
  const viewerTab = await openTab(r.viewerCdp, "about:blank", SPY);
  r.tabs.push(viewerTab);
  await viewerTab.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 2, mobile: false });
  await viewerTab.send("Page.navigate", { url: r.view.fullscreen });
  assert.ok(await until(() => viewerTab.evaluate(`document.getElementById("screen").width > 100`)), "the viewer drew a frame of the target");
  await settle(500);
  const geo = await viewerTab.evaluate(`(() => { const b = document.getElementById("screen").getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height, dpr: devicePixelRatio }; })()`);
  assert.equal(geo.dpr, 2);
  const f = await r.pageTab.evaluate(FIELDS);
  await clickLikeAPerson(viewerTab, { x: geo.l + (f.pass.x / f.vw) * geo.w, y: geo.t + (f.pass.y / f.vh) * geo.h });
  const down = (await viewerTab.evaluate(`window.__sent`)).find((m) => m.type === "mouse" && m.action === "down");
  console.log(`dpr 2: the page's own coordinates ${f.pass.x},${f.pass.y}; the viewer sent ${down ? `${down.x},${down.y}` : "nothing"}`);
  assert.ok(down && Math.abs(down.x - f.pass.x) <= 2 && Math.abs(down.y - f.pass.y) <= 2, "the click maps to the page's own coordinates");
});

/** The viewer and the target ready, the username field clicked (so the viewer's text sink has focus), the viewer's outgoing messages cleared. */
async function focused(t) {
  const r = await rig(t);
  const viewerTab = await openTab(r.viewerCdp, r.view.fullscreen, SPY);
  r.tabs.push(viewerTab);
  assert.ok(await until(() => viewerTab.evaluate(`document.getElementById("screen").width > 100`)), "the viewer drew a frame of the target");
  await settle(500);
  const geo = await viewerTab.evaluate(`(() => { const b = document.getElementById("screen").getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height }; })()`);
  const f = await r.pageTab.evaluate(FIELDS);
  await clickLikeAPerson(viewerTab, { x: geo.l + (f.user.x / f.vw) * geo.w, y: geo.t + (f.user.y / f.vh) * geo.h });
  await viewerTab.evaluate(`window.__sent.length = 0; true`);
  const field = () => r.pageTab.evaluate(`document.getElementById("user").value`);
  const sentOf = (type) => viewerTab.evaluate(`window.__sent.filter((m) => m.type === ${JSON.stringify(type)})`);
  return { r, viewerTab, field, sentOf };
}

test("full path: a virtual keyboard (keyCode 229, text through insertText) types into the page's field", { skip: NO_CHROME, timeout: 150_000 }, async (t) => {
  const { viewerTab, field, sentOf } = await focused(t);
  for (const word of ["hello", " wörld"]) {
    await viewerTab.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Unidentified", code: "", windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
    await viewerTab.send("Input.insertText", { text: word });
    await viewerTab.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Unidentified", code: "", windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
  }
  const landed = await until(async () => (await field()) === "hello wörld", 5_000);
  console.log(`virtual keyboard: field=${JSON.stringify(await field())}; the viewer sent:\n  ${(await viewerTab.evaluate(`window.__sent`)).map(short).join("\n  ")}`);
  assert.ok(landed, `the text reached the field: ${JSON.stringify(await field())}`);
  assert.deepEqual((await sentOf("text")).map((m) => m.text), ["hello", " wörld"], "text is sent as text, once each, and the 229 key events send nothing");
  assert.deepEqual(await sentOf("key"), [], "a keydown that says nothing about the text is not sent as a key");
});

test("full path: an IME composition sends nothing while it is open and its text once when it ends", { skip: NO_CHROME, timeout: 150_000 }, async (t) => {
  const { viewerTab, field, sentOf } = await focused(t);
  await viewerTab.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
  await viewerTab.send("Input.imeSetComposition", { text: "日", selectionStart: 1, selectionEnd: 1 });
  await settle(200);
  assert.deepEqual(await sentOf("text"), [], "nothing is sent while the composition is open");
  await viewerTab.send("Input.insertText", { text: "日本" });
  const landed = await until(async () => (await field()) === "日本", 5_000);
  console.log(`composition: field=${JSON.stringify(await field())}; the viewer sent:\n  ${(await viewerTab.evaluate(`window.__sent`)).map(short).join("\n  ")}`);
  assert.ok(landed, `the composed text reached the field: ${JSON.stringify(await field())}`);
  assert.deepEqual((await sentOf("text")).map((m) => m.text), ["日本"], "the composed text is sent once");
});

test("full path: a virtual keyboard's Enter, Backspace, Delete and autocorrection become the messages the page takes", { skip: NO_CHROME, timeout: 150_000 }, async (t) => {
  const { viewerTab, sentOf } = await focused(t);
  await viewerTab.evaluate(`(() => { const s = document.getElementById("sink"); for (const [inputType, data] of [["insertLineBreak"], ["deleteContentBackward"], ["deleteContentForward"], ["insertReplacementText", "fixed"]]) s.dispatchEvent(new InputEvent("beforeinput", { inputType, data, cancelable: true, bubbles: true })); return true; })()`);
  assert.deepEqual((await sentOf("key")).map((m) => [m.action, m.key, m.code, m.windowsVirtualKeyCode, m.text ?? null]), [
    ["down", "Enter", "Enter", 13, "\r"], ["up", "Enter", "Enter", 13, null],
    ["down", "Backspace", "Backspace", 8, null], ["up", "Backspace", "Backspace", 8, null],
    ["down", "Delete", "Delete", 46, null], ["up", "Delete", "Delete", 46, null],
  ]);
  assert.deepEqual((await sentOf("text")).map((m) => m.text), ["fixed"]);
});

test("full path: hover reaches the page as no button held, and a left drag and a right drag reach it as the left and the right button", { skip: NO_CHROME, timeout: 150_000 }, async (t) => {
  const { r, viewerTab } = await focused(t);
  const geo = await viewerTab.evaluate(`(() => { const b = document.getElementById("screen").getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height }; })()`);
  const f = await r.pageTab.evaluate(FIELDS);
  const at = (p, dx = 0) => ({ x: geo.l + ((p.x + dx) / f.vw) * geo.w, y: geo.t + (p.y / f.vh) * geo.h });
  const seen = async () => { await settle(250); return r.pageTab.evaluate(`window.__moves.splice(0)`); };
  const move = async (p, buttons, button = "none") => { await viewerTab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button, buttons }); await settle(80); };
  await seen();
  // A plain hover: no button is held.
  for (const dx of [10, 20, 30]) await move(at(f.go, dx), 0);
  const hover = await seen();
  console.log(`hover: the page's mousemove buttons ${JSON.stringify(hover)}`);
  assert.ok(hover.length > 0 && hover.every((b) => b === 0), `a hover is buttons 0 on the page: ${JSON.stringify(hover)}`);
  // A right-button drag, then a left-button drag.
  for (const [name, button, bits] of [["right", "right", 2], ["left", "left", 1]]) {
    const p = at(f.go);
    await viewerTab.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button, buttons: bits, clickCount: 1 });
    for (const dx of [10, 20, 30]) await move(at(f.go, dx), bits, button);
    const drag = await seen();
    await viewerTab.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x + 30, y: p.y, button, buttons: 0, clickCount: 1 });
    console.log(`${name} drag: the page's mousemove buttons ${JSON.stringify(drag)}`);
    assert.ok(drag.length > 0 && drag.every((b) => b === bits), `a ${name} drag is buttons ${bits} on the page: ${JSON.stringify(drag)}`);
    await seen();
  }
  for (const dx of [10, 20]) await move(at(f.go, dx), 0);
  const after = await seen();
  assert.ok(after.length > 0 && after.every((b) => b === 0), `a hover after the release is buttons 0 again: ${JSON.stringify(after)}`);
  // A chord: the right button pressed while the left is held reaches the page as both held (buttons 3), not as the right button alone.
  const p = at(f.go);
  await r.pageTab.evaluate(`window.__downs.length = 0; true`);
  await viewerTab.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 1 });
  await viewerTab.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "right", buttons: 3, clickCount: 1 });
  await viewerTab.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "right", buttons: 1, clickCount: 1 });
  await viewerTab.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", buttons: 0, clickCount: 1 });
  await settle(250);
  const downs = await r.pageTab.evaluate(`window.__downs.slice()`);
  console.log(`chord: the page's mousedown buttons ${JSON.stringify(downs)}`);
  assert.deepEqual(downs, [1, 3], "the second press of a chord carries both buttons");
});

test("full path: a drag released outside the canvas (over the toolbar) reaches the page as a release, so the page does not keep the button down", { skip: NO_CHROME, timeout: 150_000 }, async (t) => {
  const { r, viewerTab } = await focused(t);
  const geo = await viewerTab.evaluate(`(() => { const b = document.getElementById("screen").getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height }; })()`);
  const f = await r.pageTab.evaluate(FIELDS);
  assert.ok(geo.t > 20, `the toolbar is above the canvas (canvas top ${geo.t})`);
  const p = { x: geo.l + (f.go.x / f.vw) * geo.w, y: geo.t + (f.go.y / f.vh) * geo.h };
  // The click that gave the field focus (in `focused`) is still on its way to the page: its release must have landed before the count starts, or it is counted as this drag's.
  assert.ok(await until(async () => (await r.pageTab.evaluate(`window.__ups.length`)) >= 1, 8_000), "the focusing click's release reached the page");
  await settle(300);
  await r.pageTab.evaluate(`window.__ups.length = 0; window.__downs.length = 0; true`);
  await viewerTab.evaluate(`window.__sent.length = 0; true`);
  await viewerTab.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 1 });
  assert.ok(await until(async () => (await r.pageTab.evaluate(`window.__downs.length`)) >= 1, 8_000), "the press reached the page");
  await viewerTab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 20, y: 10, button: "left", buttons: 1 });
  await settle(100);
  await viewerTab.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 20, y: 10, button: "left", buttons: 0, clickCount: 1 });
  assert.ok(await until(async () => (await r.pageTab.evaluate(`window.__ups.length`)) >= 1, 8_000), "the page saw the button released");
  await settle(600); // a second release, if there were one, would be here by now
  const ups = await r.pageTab.evaluate(`window.__ups.slice()`);
  const sentUps = (await viewerTab.evaluate(`window.__sent`)).filter((m) => m.type === "mouse" && m.action === "up");
  console.log(`release outside the canvas: the viewer sent ${sentUps.length} release, the page's mouseup buttons ${JSON.stringify(ups)}`);
  assert.equal(sentUps.length, 1, "the viewer sent exactly one release for one release outside the canvas");
  assert.deepEqual(ups, [0], "the page saw it once, with no button held");
});

test("full path: a window that loses focus while the right button is held releases the RIGHT button on the page, not the left", { skip: NO_CHROME, timeout: 150_000 }, async (t) => {
  const { r, viewerTab } = await focused(t);
  const geo = await viewerTab.evaluate(`(() => { const b = document.getElementById("screen").getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height }; })()`);
  const f = await r.pageTab.evaluate(FIELDS);
  const p = { x: geo.l + (f.go.x / f.vw) * geo.w, y: geo.t + (f.go.y / f.vh) * geo.h };
  assert.ok(await until(async () => (await r.pageTab.evaluate(`window.__ups.length`)) >= 1, 8_000), "the focusing click's release reached the page");
  await settle(300);
  await r.pageTab.evaluate(`window.__ups.length = 0; window.__upButtons.length = 0; window.__downs.length = 0; true`);
  await viewerTab.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "right", buttons: 2, clickCount: 1 });
  assert.ok(await until(async () => (await r.pageTab.evaluate(`window.__downs.length`)) >= 1, 8_000), "the press reached the page");
  await viewerTab.evaluate(`window.dispatchEvent(new Event("blur")); true`);
  assert.ok(await until(async () => (await r.pageTab.evaluate(`window.__upButtons.length`)) >= 1, 8_000), "the page saw a release");
  await settle(500);
  const buttons = await r.pageTab.evaluate(`window.__upButtons.slice()`);
  console.log(`blur while the right button is held: the page's mouseup buttons ${JSON.stringify(buttons)}`);
  assert.deepEqual(buttons, [2], "one release, of the right button (2), not the left (0)");
});

