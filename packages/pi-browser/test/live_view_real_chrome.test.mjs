// The live view end to end on a real Chrome: the cdp provider starts it, the viewer's WebSocket protocol (hello token first, then mouse and text messages) drives a
// fixture page, and the page itself reports what it received. The person/model mutex is held both ways on the same browser. Every wait is bounded.
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createDrivingGates } from "../dist/core/driving.js";
import { createLiveView, liveViewProvider } from "../dist/live-view/index.js";
import { decodeFrame } from "../dist/live-view/protocol.js";
import { cdpProvider } from "../dist/providers/cdp.js";
import { CHROME, NO_CHROME } from "./fixtures/local-chrome.mjs";
import { scratch } from "./fixtures/scratch.mjs";
import { connect } from "./fixtures/ws-client.mjs";

const spec = (tag) => ({ tag, maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 10_000) => { for (const end = Date.now() + ms; !check() && Date.now() < end; ) await wait(25); return check(); };
/** The first message of the viewer's socket that satisfies `want`, or a failure that lists what arrived instead (frames are counted, not printed). */
async function expectMessage(ws, what, want, ms) {
  const { item, seen } = await ws.until(want, ms);
  if (item) return item;
  const summary = seen.map((m) => (m.type === "binary" ? `frame(${m.data.length}B)` : m.type === "text" ? m.data : `${m.type}${m.code ? ` ${m.code} ${m.reason}` : ""}`));
  assert.fail(`${what}: nothing matching in ${ms} ms; received ${JSON.stringify(summary.slice(-12))}`);
}
const textOf = (type) => (m) => m.type === "text" && JSON.parse(m.data).type === type;
const within = (ms, work) => Promise.race([Promise.resolve(work).catch(() => undefined), wait(ms)]);

// Absolute layout in CSS pixels, so the viewer's coordinates are known: the input is 20..220 x 20..50, the button 20..120 x 70..100.
const PAGE = `<!doctype html><meta charset="utf-8"><title>live view fixture</title>
<style>body{margin:0}#name{position:absolute;left:20px;top:20px;width:200px;height:30px;font-size:16px;box-sizing:border-box}#go{position:absolute;left:20px;top:70px;width:100px;height:30px;box-sizing:border-box}</style>
<input id="name" autocomplete="off"><button id="go">Go</button>
<script>
const report = (kind, value) => fetch("/event?kind=" + kind + "&v=" + encodeURIComponent(value));
const name = document.getElementById("name");
name.addEventListener("input", () => report("text", name.value));
document.getElementById("go").addEventListener("click", () => report("click", name.value));
</script>`;

test("a click and typed text sent through the viewer's WebSocket reach a real Chrome's page, and the person and the model never act at once", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const events = [];
  const site = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/event") { events.push({ kind: url.searchParams.get("kind"), value: url.searchParams.get("v") }); res.writeHead(204).end(); return; }
    res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  t.after(() => site.closeAllConnections?.(), { timeout: 30_000 });
  t.after(() => new Promise((r) => site.close(() => r())), { timeout: 30_000 });
  const pageUrl = `http://127.0.0.1:${site.address().port}/`;

  const root = await scratch(t, "live-view-real-");
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"] } });
  const gates = createDrivingGates({ idleMs: 1_500 });
  const host = createLiveView({ hostOrigin: null, gates });
  const wrapped = liveViewProvider(provider, host);
  const signal = AbortSignal.timeout(60_000);
  let ref;
  t.after(async () => {
    await within(20_000, host.close());
    if (ref) await within(20_000, provider.release(ref));
  }, { timeout: 30_000 });

  ref = await wrapped.create(spec("lv-real-1"), signal);
  const view = await wrapped.liveView(ref);
  assert.ok(view, "the cdp session has a live view");
  const u = new URL(view.fullscreen);
  const token = new URLSearchParams(u.hash.slice(1)).get("t");
  assert.ok(token && token.length >= 40, "the token is in the fragment");
  assert.equal(u.search, "", "and not in the query");
  const wsUrl = `ws://${u.host}${u.pathname}/ws`;

  const c = await connect(wsUrl, { origin: u.origin });
  assert.equal(c.status, 101, "the upgrade is accepted for the viewer's own origin");
  const ws = c.ws;
  t.after(() => ws.destroy(), { timeout: 30_000 });
  const gate = gates(ref.tag);
  assert.equal(gate.viewing(), false, "nobody is viewing before the viewer authenticates");
  ws.sendJson({ type: "hello", token });
  const ready = await ws.next(10_000);
  assert.equal(ready.type, "text", "a text message answers the hello");
  assert.deepEqual(JSON.parse(ready.data), { type: "ready", drive: "idle" });
  assert.equal(gate.viewing(), true, "an authenticated viewer is connected, though nobody has driven yet");

  // The page is opened through the viewer too. Input sent before the stream has attached to the browser's page is held (`no_page`), not queued, so the
  // navigation is sent again, a bounded number of times, until it is not held.
  await expectMessage(ws, "the stream attaches to the browser's first page", textOf("page"), 20_000);
  let shown;
  for (let attempt = 1; attempt <= 20 && !shown; attempt += 1) {
    ws.sendJson({ type: "nav", action: "url", url: pageUrl });
    const { item, seen } = await ws.until((m) => (textOf("page")(m) && JSON.parse(m.data).url === pageUrl) || (textOf("held")(m) && JSON.parse(m.data).reason === "no_page"), 2_000);
    if (item && textOf("page")(item)) shown = item;
    else if (!item && seen.some((m) => m.type === "close")) assert.fail("the viewer's socket closed while the page was being opened");
    else await wait(250);
  }
  assert.ok(shown, "the viewer is told the page it shows");
  const frameMessage = await expectMessage(ws, "a frame arrives", (m) => m.type === "binary", 20_000);
  const frame = decodeFrame(frameMessage.data);
  assert.ok(frame && frame.w > 0 && frame.h > 0 && frame.jpeg[0] === 0xff && frame.jpeg[1] === 0xd8, "the page's pixels arrive as JPEG frames");

  // Focus the input with a click, type into it, then click the button: the page itself reports what it got.
  const click = (x, y) => { for (const action of ["move", "down", "up"]) ws.sendJson({ type: "mouse", action, x, y, button: "left", clickCount: action === "move" ? 0 : 1 }); };
  click(120, 35);
  ws.sendJson({ type: "text", text: "hello live" });
  assert.ok(await until(() => events.some((e) => e.kind === "text" && e.value === "hello live")), `the page received the typed text; events: ${JSON.stringify(events)}`);
  click(70, 85);
  assert.ok(await until(() => events.some((e) => e.kind === "click" && e.value === "hello live")), `the page received the click on its button; events: ${JSON.stringify(events)}`);

  // The mutex, on this browser: while the person drives the model's call is refused, and once they are idle the model acts and the viewer's input is discarded.
  assert.equal(gate.state(), "person");
  assert.equal(gate.model(), "person_driving", "a model call is refused while the person drives");
  assert.ok(await until(() => gate.state() === "idle", 10_000), "the person's turn ends after the idle limit");
  assert.equal(gate.viewing(), true, "the viewer is still connected after the idle window: viewing is not driving");
  const call = gate.model();
  assert.equal(typeof call, "object", "the model may act once the person is idle");
  const clicks = events.filter((e) => e.kind === "click").length;
  click(70, 85);
  const held = await expectMessage(ws, "the viewer is told its input was held", textOf("held"), 5_000);
  assert.equal(JSON.parse(held.data).reason, "agent_acting", "viewer input is discarded with a notice while the model acts");
  await wait(500);
  assert.equal(events.filter((e) => e.kind === "click").length, clicks, "and it never reached the page");
  call.release();
  click(70, 85);
  assert.ok(await until(() => events.filter((e) => e.kind === "click").length === clicks + 1), "after the model's call the viewer drives again");

  // Release kills the token and closes the viewer.
  await within(20_000, wrapped.release(ref));
  const closed = await expectMessage(ws, "the viewer's socket closes at release", (m) => m.type === "close", 10_000);
  assert.ok(closed.code >= 4000 || closed.code === 1000 || closed.code === 1001, `the viewer's socket closes at release (code ${closed.code})`);
  assert.equal(gate.viewing(), false, "no viewer is connected once the session is released");
  assert.equal(gates(ref.tag).viewing(), false, "and the tag's next gate starts with none");
  const again = await connect(wsUrl, { origin: u.origin }).catch(() => ({ status: 0 }));
  if (again.ws) { again.ws.sendJson({ type: "hello", token }); const answer = await again.ws.until((m) => m.type === "close", 5_000).catch(() => null); again.ws.destroy(); assert.ok(answer, "a dead token is not accepted"); }
  else assert.notEqual(again.status, 101, "the dead viewer is refused at the upgrade");
});
