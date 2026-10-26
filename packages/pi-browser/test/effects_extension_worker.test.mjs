import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { EffectObserver, effectDecider } from "@parcha/pi-browser";
import { openDial } from "../dist/core/dial.js";
import { extensionDirectory } from "../dist/providers/chrome-args.js";
import { cdpCall } from "../dist/providers/cdp-call.js";
import { stagehandDriver } from "../dist/driver/stagehand.js";
import { cdpProvider } from "../dist/providers/cdp.js";
import { CHROME, NO_CHROME, skipIncapable } from "./fixtures/local-chrome.mjs";
import { scratch } from "./fixtures/scratch.mjs";

const SPEC = { tag: "worker-effects", maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 800, height: 600 }, metadata: {} };
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A website's own worker: on a message it sends a POST, as a background sync or a push handler would.
const SITE_WORKER = `self.addEventListener("message", () => { fetch("/from-site-worker", { method: "POST", body: "x" }).catch(() => {}); });`;
const PAGE = `<!doctype html><title>sink</title><a id="next" href="/next">next</a><input id="file" type="file">`;

/** A loopback server that counts what reaches it: every request that is not a read, and every WebSocket upgrade. */
async function sink() {
  const sent = [];
  const upgrades = [];
  const reached = [];
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      reached.push(`${request.method} ${request.url}`);
      if (!SAFE.has(request.method)) sent.push(`${request.method} ${request.url}`);
      const script = request.url === "/site-worker.js";
      response.writeHead(200, { "content-type": script ? "text/javascript" : "text/html", "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" });
      response.end(script ? SITE_WORKER : PAGE);
    });
  });
  server.on("upgrade", (request, socket) => { upgrades.push(request.url); socket.destroy(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}`, sent: () => [...sent], upgrades: () => [...upgrades], reached: () => [...reached],
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

/** Every journal row, as the observer's listener got it, in order. */
function journal(observer) {
  const calls = [];
  const stop = observer.record((row) => { calls.push({ ...row }); });
  const latest = () => { const byId = new Map(); for (const row of calls) byId.set(row.requestId, row); return [...byId.values()]; };
  const until = async (ready, what, ms = 20_000) => {
    for (const deadline = Date.now() + ms; !ready(); await sleep(50)) if (Date.now() > deadline) throw new Error(`${what}: not within ${ms} ms: ${JSON.stringify(latest())}`);
  };
  return { latest, until, stop };
}

const view = (rows) => rows.map(({ method, origin, path, held }) => ({ method, origin, path, held }));

/** A local Chrome with Stagehand's extension, the sink, and the observer, opened before or after the driver. Null when
 *  this Chrome cannot load the extension. */
async function world(t, { policy, observerFirst = false, decisions = {}, confined = false }) {
  const dir = await scratch(t, "pi-browser-worker-effects-");
  // The observer's tests run with the extension's own confinement off, so each layer is pinned by itself.
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: dir, ...(confined ? {} : { confineExtension: false }) } });
  const signal = new AbortController().signal;
  const site = await sink();
  t.after(() => site.close(), { timeout: 30_000 });
  const ref = await provider.create(SPEC, signal);
  t.after(() => provider.release(ref), { timeout: 30_000 });
  const target = await provider.attach(ref);
  const w = { site, provider, ref, signal, target, observer: null, driver: null, rows: null };
  const openObserver = async () => {
    w.observer = await EffectObserver.open(target, policy === null ? null : effectDecider(policy, decisions));
    t.after(() => w.observer.close(), { timeout: 30_000 });
    w.rows = journal(w.observer);
  };
  w.attach = async () => {
    try { w.driver = await stagehandDriver()(await provider.attach(ref), signal); } catch (error) { if (skipIncapable(t, error)) return false; throw error; }
    t.after(() => w.driver.close().catch(() => undefined), { timeout: 30_000 });
    return true;
  };
  if (observerFirst) await openObserver();
  if (!await w.attach()) return null;
  if (!observerFirst) await openObserver();
  return w;
}

const post = (url) => `try { const r = await fetch(${JSON.stringify(url)}, { method: "POST", body: "x" }); return "sent " + r.status; } catch (e) { return "failed"; }`;

for (const observerFirst of [false, true]) {
  const when = observerFirst ? "opened before the driver attached" : "opened after the driver attached";
  test(`a POST that run code sends is held, journaled and denied under deny, observer ${when}`, { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
    const w = await world(t, { policy: "deny", observerFirst });
    if (!w) return;
    assert.equal(await w.driver.run({ code: post(`${w.site.origin}/from-run-code`) }), "failed", "the run code's fetch is refused by the browser");
    await w.rows.until(() => w.rows.latest().some((row) => row.held === "denied"), "a denied row");
    await w.observer.flush();
    assert.deepEqual(view(w.rows.latest()), [{ method: "POST", origin: w.site.origin, path: "/from-run-code", held: "denied" }], "one row, held and denied");
    assert.deepEqual(w.site.sent(), [], "nothing reached the server");
  });
}

test("a POST that run code sends is held and journaled after the extension's worker restarts under a live observer", { skip: NO_CHROME, timeout: 180_000 }, async (t) => {
  const w = await world(t, { policy: "deny" });
  if (!w) return;
  assert.equal(await w.driver.run({ code: "return 1;" }), 1);
  await w.driver.close();
  // The browser stops the worker; it starts again on the next event, with none of the runtime's earlier state.
  const ws = openDial(w.target);
  t.after(() => ws.close(), { timeout: 30_000 });
  await new Promise((resolve) => { ws.onopen = resolve; });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (event) => { const m = JSON.parse(String(event.data)); if (m.id) waiting.get(m.id)?.(m); };
  const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; waiting.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
  const [worker] = (await send("Target.getTargets")).result.targetInfos.filter((x) => x.type === "service_worker" && x.url.startsWith("chrome-extension://"));
  assert.equal((await send("Target.closeTarget", { targetId: worker.targetId })).result.success, true);
  await sleep(1_000);
  assert.equal(await w.attach(), true, "a new driver attaches to the reloaded extension");
  assert.equal(await w.driver.run({ code: post(`${w.site.origin}/after-restart`) }), "failed");
  await w.rows.until(() => w.rows.latest().some((row) => row.held === "denied"), "a denied row");
  assert.deepEqual(view(w.rows.latest()), [{ method: "POST", origin: w.site.origin, path: "/after-restart", held: "denied" }]);
  assert.deepEqual(w.site.sent(), []);
});

test("under allow, a POST that run code sends leaves and is journaled as allowed", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const w = await world(t, { policy: "allow" });
  if (!w) return;
  assert.equal(await w.driver.run({ code: post(`${w.site.origin}/allowed`) }), "sent 200");
  await w.rows.until(() => w.rows.latest().some((row) => row.held === "allowed"), "an allowed row");
  assert.deepEqual(view(w.rows.latest()), [{ method: "POST", origin: w.site.origin, path: "/allowed", held: "allowed" }]);
  assert.deepEqual(w.site.sent(), ["POST /allowed"]);
});

test("with no decider the observer journals what run code sends without holding it", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const w = await world(t, { policy: null });
  if (!w) return;
  assert.equal(await w.driver.run({ code: post(`${w.site.origin}/watched`) }), "sent 200");
  await w.rows.until(() => w.rows.latest().length > 0, "a row");
  await w.observer.flush();
  assert.deepEqual(view(w.rows.latest()), [{ method: "POST", origin: w.site.origin, path: "/watched", held: null }]);
});

test("the host that is asked about a request run code sent is told it came from run code", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const asked = [];
  const w = await world(t, { policy: "ask", decisions: { approveEffect: async (request) => { asked.push(request); return false; } } });
  if (!w) return;
  await w.driver.run({ code: post(`${w.site.origin}/asked`) });
  await w.rows.until(() => w.rows.latest().some((row) => row.held === "denied"), "a denied row");
  assert.equal(asked.length, 1);
  assert.deepEqual([asked[0].method, asked[0].path, asked[0].trigger], ["POST", "/asked", "run code"]);
});

/** What the driver does by itself, with a page and the extension's own files: goto, snapshot, click, screenshot, upload, a request to an extension file. */
async function ownWork(w) {
  const { driver, site } = w;
  await driver.run({ code: `await page.goto(${JSON.stringify(`${site.origin}/page`)}); return await page.title();` });
  const tree = await driver.snapshot();
  assert.match(tree, /next/);
  await driver.run({ code: `await page.locator("#next").click(); await page.waitForLoadState("domcontentloaded"); return await page.url();` });
  const shot = await driver.screenshot({ type: "png" });
  assert.ok(shot.data.length > 100, "a screenshot came back");
  await driver.run({ code: `await page.goto(${JSON.stringify(`${site.origin}/page`)}); return true;` });
  await driver.setInputFiles("#file", { name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  // A request to the extension's own files is the extension's, not a request out.
  assert.equal(typeof await driver.run({ code: `try { const r = await fetch(chrome.runtime.getURL("blank.html"), { method: "POST" }); return r.status; } catch (e) { return "blocked"; }` }), "number");
  await w.observer.flush();
}

test("under deny, everything the driver does itself is held by nothing: the observer's rows stay empty and the work completes", { skip: NO_CHROME, timeout: 180_000 }, async (t) => {
  // The observer is open before the driver attaches, so the extension's own start-up is watched too.
  const w = await world(t, { policy: "deny", observerFirst: true });
  if (!w) return;
  await ownWork(w);
  assert.deepEqual(w.rows.latest(), [], "no row: nothing here is a request out");
  assert.deepEqual(w.site.sent(), []);
});

test("with no decider, everything the driver does itself journals nothing: the same work, the same empty rows", { skip: NO_CHROME, timeout: 180_000 }, async (t) => {
  // Journal-only takes the observer's other path (a request is recorded as it is sent, not as it is held), which has its own exemptions.
  const w = await world(t, { policy: null, observerFirst: true });
  if (!w) return;
  await ownWork(w);
  assert.deepEqual(w.rows.latest(), [], "no row: nothing here is a request out");
  assert.deepEqual(w.site.sent(), []);
});

test("the closed trace port is exempt by its exact URL only: a near miss sent from the worker is held and journaled", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const w = await world(t, { policy: "deny" });
  if (!w) return;
  const near = ["http://127.0.0.1:9/v1/traces?x=1", "http://127.0.0.1:9/v1/tracez", "http://127.0.0.1:9/v1/traces/", "http://127.0.0.1:10/v1/traces"];
  for (const url of near) assert.equal(await w.driver.run({ code: post(url) }), "failed", url);
  await w.rows.until(() => w.rows.latest().filter((row) => row.held === "denied").length === near.length, "a denied row for each near miss");
  const seen = view(w.rows.latest()).map((row) => `${row.origin}${row.path} ${row.held}`).sort();
  assert.deepEqual(seen, ["http://127.0.0.1:10/v1/traces denied", "http://127.0.0.1:9/v1/traces denied", "http://127.0.0.1:9/v1/traces/ denied", "http://127.0.0.1:9/v1/tracez denied"]);
  // The exact URL goes nowhere and leaves no row.
  assert.equal(await w.driver.run({ code: post("http://127.0.0.1:9/v1/traces") }), "failed");
  await w.observer.flush();
  assert.equal(w.rows.latest().length, near.length, "the exact URL adds no row");
});

test("a request a website's own worker sends is not labeled as run code", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const asked = [];
  const w = await world(t, { policy: "ask", decisions: { approveEffect: async (request) => { asked.push(request); return false; } } });
  if (!w) return;
  await w.driver.run({ code: `await page.goto(${JSON.stringify(`${w.site.origin}/page`)}); return true;` });
  const register = `(async () => { await navigator.serviceWorker.register("/site-worker.js"); const ready = await navigator.serviceWorker.ready; ready.active.postMessage(1); return 1; })()`;
  await w.driver.run({ code: `return await page.evaluate(${JSON.stringify(register)});` });
  await w.rows.until(() => w.rows.latest().some((row) => row.held === "denied"), "a denied row");
  assert.equal(asked.length, 1);
  assert.deepEqual([asked[0].method, asked[0].path, asked[0].trigger], ["POST", "/from-site-worker", null], "the site's worker sent it, not run code");
});

test("a socket to the browser's own endpoint with a different query is journaled: only the exact URL is the extension's own", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const w = await world(t, { policy: "deny" });
  if (!w) return;
  const other = new URL(w.target.sdkCdpUrl);
  other.searchParams.set("other", "1");
  await w.driver.run({ code: `try { new WebSocket(${JSON.stringify(other.href)}); } catch (e) {} return true;` });
  await w.rows.until(() => w.rows.latest().length > 0, "a WebSocket row for the different query");
  assert.deepEqual(view(w.rows.latest()).map((row) => [row.method, row.held]), [["WEBSOCKET", null]]);
});

test("a WebSocket the extension's worker opens is journaled, not held: Fetch cannot hold a socket", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const w = await world(t, { policy: "deny" });
  if (!w) return;
  await w.driver.run({ code: `try { new WebSocket(${JSON.stringify(`${w.site.ws}/worker-socket`)}); } catch (e) {} return true;` });
  await w.rows.until(() => w.rows.latest().length > 0, "a WebSocket row");
  assert.deepEqual(view(w.rows.latest()), [{ method: "WEBSOCKET", origin: w.site.ws, path: "/worker-socket", held: null }]);
  for (const deadline = Date.now() + 10_000; w.site.upgrades().length === 0 && Date.now() < deadline; await sleep(50));
  assert.deepEqual(w.site.upgrades(), ["/worker-socket"], "known limit: the socket reaches the server");
});

test("a WebSocket a page opens is journaled the same way", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const w = await world(t, { policy: "deny" });
  if (!w) return;
  await w.driver.run({ code: `await page.goto(${JSON.stringify(`${w.site.origin}/page`)}); await page.evaluate(${JSON.stringify(`(() => { new WebSocket(${JSON.stringify(`${w.site.ws}/page-socket`)}); return 1; })()`)}); return true;` });
  await w.rows.until(() => w.rows.latest().length > 0, "a WebSocket row");
  assert.deepEqual(view(w.rows.latest()), [{ method: "WEBSOCKET", origin: w.site.ws, path: "/page-socket", held: null }]);
});

// The browser's own layer: the extension a local launched Chrome is given may connect to nothing but its host.
test("confined, the extension worker's POST and GET are refused by the browser itself, with the observer only watching", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const w = await world(t, { policy: null, confined: true });
  if (!w) return;
  assert.equal(await w.driver.run({ code: post(`${w.site.origin}/confined-post`) }), "failed");
  assert.equal(await w.driver.run({ code: `try { const r = await fetch(${JSON.stringify(`${w.site.origin}/confined-get`)}); return "got " + r.status; } catch (e) { return "failed"; }` }), "failed");
  assert.deepEqual(w.site.reached(), [], "nothing the worker sent reached the server");
});

test("confined, a WebSocket the extension worker opens never reaches the server", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const w = await world(t, { policy: "deny", confined: true });
  if (!w) return;
  const outcome = await w.driver.run({ code: `return await new Promise((resolve) => { try { const s = new WebSocket(${JSON.stringify(`${w.site.ws}/confined-socket`)}); s.onopen = () => resolve("open"); s.onerror = () => resolve("error"); s.onclose = () => resolve("closed"); setTimeout(() => resolve("silent"), 5000); } catch (e) { resolve("threw"); } });` });
  assert.notEqual(outcome, "open");
  await sleep(500);
  assert.deepEqual(w.site.upgrades(), [], "the upgrade never arrived");
});

test("confined, the extension is the only Stagehand Runtime and everything the driver does works", { skip: NO_CHROME, timeout: 180_000 }, async (t) => {
  const w = await world(t, { policy: "deny", observerFirst: true, confined: true });
  if (!w) return;
  const { driver, site } = w;
  const ws = openDial(w.target);
  t.after(() => ws.close(), { timeout: 30_000 });
  await new Promise((resolve) => { ws.onopen = resolve; });
  const reply = await new Promise((resolve) => { ws.onmessage = (event) => { const m = JSON.parse(String(event.data)); if (m.id === 1) resolve(m); }; ws.send(JSON.stringify({ id: 1, method: "Extensions.getExtensions" })); });
  const runtimes = reply.result.extensions.filter((x) => x.name === "Stagehand Runtime" && x.enabled);
  assert.equal(runtimes.length, 1, "one enabled Stagehand Runtime");
  assert.equal(w.target.extensionId, runtimes[0].id, "and the attach target names it");
  await driver.run({ code: `await page.goto(${JSON.stringify(`${site.origin}/page`)}); return await page.title();` });
  assert.match(await driver.snapshot(), /next/);
  await driver.run({ code: `await page.locator("#next").click(); await page.waitForLoadState("domcontentloaded"); return await page.url();` });
  assert.ok((await driver.screenshot({ type: "png" })).data.length > 100);
  await driver.run({ code: `await page.goto(${JSON.stringify(`${site.origin}/page`)}); return true;` });
  await driver.setInputFiles("#file", { name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await w.observer.flush();
  assert.deepEqual(w.rows.latest(), [], "nothing here is a request out");
});

test("confined, a page's own POST is not affected: the page stays under the observer", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const w = await world(t, { policy: "allow", confined: true });
  if (!w) return;
  await w.driver.run({ code: `await page.goto(${JSON.stringify(`${w.site.origin}/page`)}); return true;` });
  const sent = await w.driver.run({ code: `return await page.evaluate(${JSON.stringify(`fetch(${JSON.stringify(`${w.site.origin}/from-page`)}, { method: "POST", body: "x" }).then((r) => "sent " + r.status).catch(() => "failed")`)});` });
  assert.equal(sent, "sent 200");
  await w.rows.until(() => w.rows.latest().some((row) => row.held === "allowed"), "an allowed row");
  assert.deepEqual(w.site.sent(), ["POST /from-page"]);
});

test("confined, a stale unconfined Stagehand extension already in the browser is not the one the attach names", { skip: NO_CHROME, timeout: 180_000 }, async (t) => {
  const dir = await scratch(t, "pi-browser-stale-extension-");
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: dir } });
  const signal = new AbortController().signal;
  const site = await sink();
  t.after(() => site.close(), { timeout: 30_000 });
  const ref = await provider.create(SPEC, signal);
  t.after(() => provider.release(ref), { timeout: 30_000 });
  // Before the lease's first attach: another copy of Stagehand's extension, from its own directory, with no connect policy.
  const port = ref.id.split(":")[2];
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const loaded = await cdpCall(version.webSocketDebuggerUrl, "Extensions.loadUnpacked", { path: extensionDirectory() }, 20_000);
  loaded.close();
  assert.equal(typeof loaded.result.id, "string", "the stale copy is loaded");
  const target = await provider.attach(ref);
  assert.notEqual(target.extensionId, loaded.result.id, "the attach names the lease's own copy, not the one already there");
  let driver;
  try { driver = await stagehandDriver()(target, signal); } catch (error) { if (skipIncapable(t, error)) return; throw error; }
  t.after(() => driver.close().catch(() => undefined), { timeout: 30_000 });
  assert.equal(await driver.run({ code: post(`${site.origin}/stale`) }), "failed", "the worker the driver runs in is the confined one");
  assert.deepEqual(site.reached(), []);
});
