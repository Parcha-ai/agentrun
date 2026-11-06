// The locked extension worker against code that runs beside it: model code shares the worker's realm with WORKER_LOCK, so
// it can replace any intrinsic the lock might look up at call time (Object.keys, Array.prototype.includes, JSON, ...) and
// hand the lock objects that lie (a Proxy, a getter that answers twice, a field the prototype carries). None of it may get
// a navigation, a request rule or a window change past the lock: each wrapper reads what it is given once, checks it, and
// hands Chrome a new object of its own.
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { cdpProvider } from "../dist/providers/cdp.js";
import { CHROME, NO_CHROME, skipIncapable } from "./fixtures/local-chrome.mjs";
import { scratch } from "./fixtures/scratch.mjs";

const spec = (tag) => ({ tag, maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} });

/** What run code tries, in the worker, for each place it would send a tab: every intrinsic the lock could look up replaced,
 *  and every way an object can lie to a reader. Each attempt restores what it replaced before the next. */
const attacks = (fixture, places) => `(async () => {
  // Chrome's second name for the extension APIs, with objects of its own: locked as chrome is.
  const namespaces = {};
  for (const name of ["chrome", "browser"]) { const api = globalThis[name]; namespaces[name] = api ? [typeof api.tabs.create, typeof api.tabs.get, typeof api.debugger.attach, typeof api.windows.create, typeof api.offscreen.closeDocument, typeof api.declarativeNetRequest.updateDynamicRules, typeof api.scripting, typeof api.management].join(",") : "absent"; }
  const out = { namespaces, attempts: {} };
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((one) => String(one.url).startsWith(${JSON.stringify(fixture)}));
  if (!tab) return { error: "no fixture tab: " + JSON.stringify(tabs.map((one) => one.url)) };
  out.tabId = tab.id;
  const urls = async () => (await chrome.tabs.query({})).map((one) => String(one.url));
  const attempt = async (name, setup, call, restore) => {
    let undo;
    let result;
    try { undo = setup(); result = { value: JSON.stringify(await call()) ?? null }; }
    catch (error) { result = { error: String((error && error.message) || error) }; }
    finally { try { (undo ?? restore)?.(); } catch (error) { result.restoreError = String(error); } }
    await new Promise((done) => setTimeout(done, 700));
    result.urls = await urls();
    out.attempts[name] = result;
  };
  const swap = (owner, key, value) => () => { const was = Object.getOwnPropertyDescriptor(owner, key); Object.defineProperty(owner, key, { value, writable: true, configurable: true }); return () => (was ? Object.defineProperty(owner, key, was) : delete owner[key]); };
  for (const place of ${JSON.stringify(places)}) {
    const update = (props) => () => chrome.tabs.update(tab.id, props);
    await attempt(place + " plain", () => undefined, update({ url: place }));
    if (globalThis.browser) await attempt(place + " browser namespace", () => undefined, () => browser.tabs.update(tab.id, { url: place }));
    await attempt(place + " Object.keys", swap(Object, "keys", () => []), update({ url: place }));
    await attempt(place + " Object.entries", swap(Object, "entries", () => []), update({ url: place }));
    await attempt(place + " Array.prototype.every", swap(Array.prototype, "every", () => true), update({ url: place }));
    await attempt(place + " Array.prototype.includes", swap(Array.prototype, "includes", () => true), update({ active: true, url: place }));
    await attempt(place + " Object.prototype.hasOwnProperty", swap(Object.prototype, "hasOwnProperty", () => true), update({ url: place }));
    await attempt(place + " Array.isArray", swap(Array, "isArray", () => true), update({ url: place }));
    await attempt(place + " JSON.stringify", swap(JSON, "stringify", () => "{}"), update({ url: place }));
    await attempt(place + " Reflect.ownKeys", swap(Reflect, "ownKeys", () => ["active"]), update({ active: true, url: place }));
    await attempt(place + " hidden field", () => undefined, () => { const props = { active: true }; Object.defineProperty(props, "url", { value: place, enumerable: false }); return chrome.tabs.update(tab.id, props); });
    await attempt(place + " prototype field", () => undefined, () => { const props = Object.create({ url: place }); props.active = true; return chrome.tabs.update(tab.id, props); });
    await attempt(place + " Object.prototype field", () => { Object.defineProperty(Object.prototype, "url", { get: () => place, configurable: true }); return () => delete Object.prototype.url; }, update({ active: true }));
    await attempt(place + " lying Proxy", () => undefined, () => chrome.tabs.update(tab.id, new Proxy({ active: true }, {
      ownKeys: () => ["active"],
      getOwnPropertyDescriptor: (target, key) => ({ value: key === "url" ? place : true, enumerable: true, configurable: true, writable: true }),
      has: () => true,
      get: (target, key) => (key === "url" ? place : key === "active" ? true : undefined),
    })));
    await attempt(place + " getter that answers twice", () => undefined, () => { let reads = 0; return chrome.tabs.update(tab.id, { get active() { reads += 1; return true; }, get url() { return reads > 0 ? place : undefined; } }); });
  }
  // A window changed in more than its focus.
  await attempt("window Object.keys", swap(Object, "keys", () => []), () => chrome.windows.update(tab.windowId, { focused: true, state: "minimized" }));
  // A request rule that redirects: the checks fooled by replaced intrinsics, or by an action whose type answers twice.
  const dnr = chrome.declarativeNetRequest;
  const redirect = (id, action) => () => dnr.updateSessionRules({ addRules: [{ id, priority: 1, action, condition: { urlFilter: "/goal", resourceTypes: ["main_frame"] } }] });
  const target = { url: ${JSON.stringify(`${fixture}redirected`)} };
  await attempt("rule Array.prototype.includes", () => { const a = swap(Object, "keys", () => [])(); const b = swap(Array.prototype, "includes", () => true)(); return () => (b(), a()); }, redirect(9101, { type: "redirect", redirect: target }));
  await attempt("rule type that answers twice", swap(Object, "keys", () => []), () => { let reads = 0; return redirect(9102, { get type() { reads += 1; return reads > 1 ? "redirect" : "block"; }, redirect: target })(); });
  await attempt("rule Proxy", () => undefined, redirect(9103, new Proxy({ type: "block" }, { ownKeys: () => ["type"], get: (t, key) => (key === "type" ? "redirect" : key === "redirect" ? target : undefined) })));
  out.rules = (await dnr.getSessionRules()).map((rule) => ({ id: rule.id, type: rule.action.type }));
  await dnr.updateSessionRules({ removeRuleIds: [9101, 9102, 9103] }).catch(() => undefined);
  // The lock still lets Stagehand do what it does: activate a tab, focus its window, read the targets.
  await attempt("activate", () => undefined, () => chrome.tabs.update(tab.id, { active: true }).then((one) => one.id === tab.id));
  await attempt("activate, call and apply replaced", () => {
    const undo = [swap(Function.prototype, "call", () => { throw new Error("call used"); })(), swap(Function.prototype, "apply", () => { throw new Error("apply used"); })(), swap(Function.prototype, "bind", () => { throw new Error("bind used"); })(), swap(Reflect, "apply", () => { throw new Error("Reflect.apply used"); })(), swap(Object, "keys", () => { throw new Error("Object.keys used"); })(), swap(Reflect, "ownKeys", () => { throw new Error("Reflect.ownKeys used"); })(), swap(Number, "isInteger", () => false)()];
    return () => { for (const one of undo.reverse()) one(); };
  }, () => chrome.tabs.update(tab.id, { active: true }).then((one) => one.id === tab.id));
  await attempt("focus", () => undefined, () => chrome.windows.update(tab.windowId, { focused: true }).then((one) => one.id === tab.windowId));
  await attempt("targets", () => undefined, () => chrome.debugger.getTargets().then((all) => all.length > 0));
  await attempt("allow rule", () => undefined, () => dnr.updateSessionRules({ addRules: [{ id: 9104, priority: 1, action: { type: "allow" }, condition: { regexFilter: "^https?://", isUrlFilterCaseSensitive: false, resourceTypes: ["main_frame"], excludedResourceTypes: [], initiatorDomains: ["x.example"], tabIds: [-1] } }], removeRuleIds: [] }).then(() => dnr.getSessionRules()).then((rules) => rules.filter((rule) => rule.id === 9104).map((rule) => rule.action.type + ":" + rule.condition.regexFilter)));
  await dnr.updateSessionRules({ removeRuleIds: [9104] }).catch(() => undefined);
  return out;
})()`;

test("run code beside the locked worker gets no navigation, request rule or window change past it: replaced intrinsics, hidden and prototype fields, lying Proxies and getters that answer twice are all refused, and the tab never moves; what Stagehand does still works", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const { localBrowser, Stagehand } = await import("@browserbasehq/stagehand");
  const server = http.createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(`<title>Lock Fixture</title><p>${req.url}</p>`); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close(), { timeout: 30_000 });
  const fixture = `http://127.0.0.1:${server.address().port}/`;
  const root = await scratch(t, "worker-lock-");
  const told = [];
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, guard: true, args: (launch) => (told.push(launch), []) } });
  const ref = await provider.create(spec("worker-lock-1"), new AbortController().signal);
  let stagehand;
  try {
    const target = await provider.attach(ref);
    let browser;
    try {
      browser = await localBrowser.connect({ cdpUrl: target.sdkCdpUrl, extensionCdpUrl: target.extensionCdpUrl });
      stagehand = await Stagehand.create({ browser, logging: { level: "off" } });
    } catch (error) { if (skipIncapable(t, error)) return; throw error; }
    const [page] = await browser.context.pages();
    await page.goto(fixture);
    // The worker's own realm, the one run code shares, reached on the browser's own socket (the provider's, not the guard).
    const raw = new WebSocket(`ws://127.0.0.1:${told[0].debuggingPort}${new URL(target.sdkCdpUrl).pathname}`);
    await new Promise((ok, fail) => (raw.addEventListener("open", ok), raw.addEventListener("error", fail)));
    t.after(() => raw.close());
    let id = 0;
    const waiting = new Map();
    raw.addEventListener("message", (event) => { const m = JSON.parse(event.data); waiting.get(m.id)?.(m); });
    const send = (method, params = {}, sessionId) => new Promise((ok) => { waiting.set(++id, ok); raw.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
    const worker = (await send("Target.getTargets")).result.targetInfos.find((info) => info.type === "service_worker" && info.url.endsWith("/service-worker.js"));
    assert.ok(worker, "Stagehand's worker runs");
    const { sessionId } = (await send("Target.attachToTarget", { targetId: worker.targetId, flatten: true })).result;
    const places = ["file:///etc/hostname", "chrome://version/", "chrome://settings/"];
    const answer = await send("Runtime.evaluate", { expression: attacks(fixture, places), awaitPromise: true, returnByValue: true }, sessionId);
    const out = answer.result?.result?.value;
    assert.ok(out && !out.error, JSON.stringify(answer).slice(0, 2000));
    t.diagnostic(JSON.stringify(out).slice(0, 8000));
    // Neither namespace holds an unlocked API.
    for (const [name, apis] of Object.entries(out.namespaces)) assert.match(apis, /^(absent|undefined(,undefined){7})$/, `${name}: ${apis}`);
    for (const [name, result] of Object.entries(out.attempts)) {
      for (const url of result.urls) assert.match(url, /^(http:|about:blank)/, `${name}: a tab went to ${url}`);
      // The fixture's tab is still open where it was: a tab that went to a file or browser page would have been closed by the guard.
      assert.ok(result.urls.includes(fixture), `${name}: the fixture's tab is gone: ${JSON.stringify(result.urls)}`);
      if (["activate", "activate, call and apply replaced", "focus", "targets", "allow rule"].includes(name)) {
        assert.equal(result.error, undefined, `${name} works: ${JSON.stringify(result)}`);
        continue;
      }
      // A field the caller's object does not own (its prototype's, Object.prototype's, one a Proxy hides) is never read:
      // what Chrome is handed is the lock's own object, so the tab is activated and goes nowhere.
      if (/ (prototype field|Object\.prototype field|lying Proxy)$/.test(name) && result.error === undefined) continue;
      assert.match(result.error ?? "", /^pi-browser: this browser's extension does not /, `${name} is refused by the lock: ${JSON.stringify(result)}`);
    }
    assert.equal(out.attempts["activate"].value, "true");
    assert.equal(out.attempts["activate, call and apply replaced"].value, "true");
    assert.equal(out.attempts["focus"].value, "true");
    assert.equal(out.attempts["allow rule"].value, JSON.stringify(["allow:^https?://"]));
    assert.deepEqual(out.rules.filter((rule) => rule.id >= 9101 && rule.id <= 9103), [], "no redirect rule went in");
    // The page itself is where it was.
    assert.equal(await page.url(), fixture);
  } finally {
    await stagehand?.close().catch(() => undefined);
    await provider.release(ref);
  }
});
