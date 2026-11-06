// WORKER_LOCK in a realm of its own, over fake extension APIs that record what they are handed: code that runs after the
// lock, in the same realm, replaces every intrinsic the lock could look up and hands it objects that lie. Chrome is only
// ever handed the lock's own objects, holding the fields it allows, each read once. The real browser's half is
// worker_lock_real_chrome.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { HEARTBEAT, WORKER_LOCK } from "../dist/providers/worker-extension.js";

/** A fresh realm with `chrome` and `browser` namespaces whose calls are recorded, the lock run in it first. */
function lockedRealm() {
  const calls = [];
  const namespace = (root) => {
    const recorder = (name) => function (...args) { calls.push({ root, name, self: this, args }); return Promise.resolve({ id: typeof args[0] === "number" ? args[0] : 1 }); };
    return {
      tabs: { query: recorder("tabs.query"), update: recorder("tabs.update"), create: recorder("tabs.create"), get: recorder("tabs.get"), onCreated: { addListener() {} } },
      windows: { update: recorder("windows.update"), create: recorder("windows.create") },
      debugger: { getTargets: recorder("debugger.getTargets"), attach: recorder("debugger.attach"), sendCommand: recorder("debugger.sendCommand") },
      offscreen: { createDocument: recorder("offscreen.createDocument"), closeDocument: recorder("offscreen.closeDocument") },
      declarativeNetRequest: { getSessionRules: recorder("dnr.getSessionRules"), isRegexSupported: recorder("dnr.isRegexSupported"), updateSessionRules: recorder("dnr.updateSessionRules"), updateDynamicRules: recorder("dnr.updateDynamicRules"), MAX_NUMBER_OF_SESSION_RULES: 5000, MAX_NUMBER_OF_REGEX_RULES: 1000 },
      scripting: { executeScript: recorder("scripting.executeScript") },
      management: { setEnabled: recorder("management.setEnabled") },
      permissions: { request: recorder("permissions.request") },
      runtime: { id: "x", getURL: (p) => `chrome-extension://x/${p}` },
    };
  };
  const context = vm.createContext({ chrome: namespace("chrome"), browser: namespace("browser") });
  vm.runInContext(WORKER_LOCK, context);
  // Strict, as Stagehand's module worker is: a write to a fixed property throws rather than doing nothing.
  const run = (code) => vm.runInContext(`(async () => { "use strict"; ${code} })()`, context);
  return { calls, run, context };
}

const refusal = /^pi-browser: this browser's extension does not /;
/** Every value the API got, as a plain tree, and whether each object in it is the lock's own (no prototype). */
const seen = (value) => JSON.parse(JSON.stringify(value));
// Read with this realm's own functions: the locked realm's Array.prototype may have been replaced by then.
const every = (list, check) => Array.prototype.every.call(list, check);
const ownObjects = (value) => (value === null || typeof value !== "object" ? true : Array.isArray(value) ? every(Object.values(value), ownObjects) : Object.getPrototypeOf(value) === null && every(Object.values(value), ownObjects));

test("the lock replaces, in both namespaces, every API that could open, move or script a page, and fixes the names", async () => {
  const { run } = lockedRealm();
  const out = await run(`
    const result = {};
    for (const root of ["chrome", "browser"]) {
      const api = globalThis[root];
      result[root] = [typeof api.tabs.create, typeof api.tabs.get, typeof api.windows.create, typeof api.debugger.attach, typeof api.offscreen.closeDocument, typeof api.declarativeNetRequest.updateDynamicRules, typeof api.scripting, typeof api.management, typeof api.permissions].join(",");
      try { api.tabs = { update: () => "free" }; } catch (error) { result[root + " assign"] = error.constructor.name; }
      try { Object.defineProperty(api, "tabs", { value: {} }); } catch (error) { result[root + " define"] = error.constructor.name; }
    }
    try { globalThis.browser = { tabs: {} }; } catch (error) { result.browserName = error.constructor.name; }
    try { Object.defineProperty(globalThis, "chrome", { value: {} }); } catch (error) { result.chromeName = error.constructor.name; }
    result.clients = typeof clients;
    return result;`);
  for (const root of ["chrome", "browser"]) {
    assert.equal(out[root], "undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined", root);
    assert.equal(out[`${root} assign`], "TypeError");
    assert.equal(out[`${root} define`], "TypeError");
  }
  assert.equal(out.browserName, "TypeError");
  assert.equal(out.chromeName, "TypeError");
  assert.equal(out.clients, "undefined");
});

/** Each way run code could fool a lock that looks up intrinsics or forwards the caller's object. */
const TRICKS = {
  "Object.keys": "Object.keys = () => [];",
  "Object.entries": "Object.entries = () => [];",
  "Reflect.ownKeys": "Reflect.ownKeys = () => ['active', 'focused', 'type'];",
  "Array.prototype.every": "Array.prototype.every = () => true;",
  "Array.prototype.includes": "Array.prototype.includes = () => true;",
  "Array.isArray": "Array.isArray = () => true;",
  "Object.prototype.hasOwnProperty": "Object.prototype.hasOwnProperty = () => true;",
  "JSON": "JSON.stringify = () => '{}'; JSON.parse = () => ({});",
  "Function.prototype": "Function.prototype.call = Function.prototype.apply = Function.prototype.bind = () => { throw new Error('used'); };",
  "Reflect.apply": "Reflect.apply = () => { throw new Error('used'); };",
  "Number and String": "Number.isInteger = () => true; globalThis.Number = () => 0; globalThis.String = () => 'x';",
  "Promise": "Promise.reject = () => 'not refused'; globalThis.Promise = function () {};",
  "Object.prototype setters": "Object.defineProperty(Object.prototype, 'url', { get: () => 'file:///etc/hostname', configurable: true }); Object.defineProperty(Array.prototype, '0', { get: () => 'file:///etc/hostname', set() {}, configurable: true });",
};

for (const [trick, setup] of Object.entries(TRICKS)) {
  test(`with ${trick} replaced, a tab is moved, a window changed, a rule redirects and another page opens by no path; Chrome gets the lock's own objects`, async () => {
    const { calls, run } = lockedRealm();
    const out = await run(`
      ${setup}
      const attempts = {
        url: () => chrome.tabs.update(7, { url: "file:///etc/hostname" }),
        activeAndUrl: () => chrome.tabs.update(7, { active: true, url: "chrome://settings/" }),
        browserUrl: () => browser.tabs.update(7, { url: "file:///etc/hostname" }),
        window: () => chrome.windows.update(3, { focused: true, state: "minimized" }),
        redirect: () => chrome.declarativeNetRequest.updateSessionRules({ addRules: [{ id: 1, action: { type: "redirect", redirect: { url: "file:///etc/hostname" } }, condition: { urlFilter: "x" } }] }),
        headers: () => browser.declarativeNetRequest.updateSessionRules({ addRules: [{ id: 2, action: { type: "modifyHeaders", requestHeaders: [] }, condition: {} }] }),
        page: () => chrome.offscreen.createDocument({ url: "wake-service-worker.html", reasons: ["BLOBS"], justification: "x" }),
        query: () => chrome.tabs.query({ url: "file:///*" }),
      };
      // No prototype: a replaced Object.prototype field must not catch the test's own writes.
      const result = { __proto__: null };
      for (const name of Object.getOwnPropertyNames(attempts)) {
        let answer;
        try { answer = attempts[name](); } catch (error) { result[name] = "threw " + error.message; continue; }
        try { await answer; result[name] = "went"; } catch (error) { result[name] = error.message; }
      }
      return result;`);
    for (const [name, said] of Object.entries(out)) assert.match(said, refusal, `${trick}, ${name}: ${said}`);
    assert.deepEqual(calls.map((call) => call.name), [], "nothing reached the API");
  });

  test(`with ${trick} replaced, what Stagehand does still goes through, as new objects with no prototype holding its fields alone`, async () => {
    const { calls, run } = lockedRealm();
    const out = await run(`
      ${setup}
      // A string, not a list: a replaced Array.prototype would change a list's own pushes.
      let result = "";
      const go = async (name, call) => { try { await call(); result += name + " went|"; } catch (error) { result += name + " " + error.message + "|"; } };
      await go("query", () => chrome.tabs.query({ active: true, lastFocusedWindow: true }));
      await go("activate", () => chrome.tabs.update(7, { active: true }));
      await go("focus", () => chrome.windows.update(3, { focused: true }));
      await go("targets", () => chrome.debugger.getTargets());
      await go("heartbeat", () => chrome.offscreen.createDocument({ url: ${JSON.stringify(HEARTBEAT)}, reasons: ["BLOBS"], justification: "Maintain service worker liveness for long-running sessions." }));
      await go("regex", () => chrome.declarativeNetRequest.isRegexSupported({ regex: "^https?://", isCaseSensitive: false, requireCapturing: false }));
      await go("rules", () => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1000000], addRules: [{ id: 1000001, priority: 4, action: { type: "allow" }, condition: { regexFilter: "^https?://", isUrlFilterCaseSensitive: false, excludedResourceTypes: [], initiatorDomains: ["x"], tabIds: [-1] } }, { id: 1000002, priority: 1, action: { type: "block" }, condition: { regexFilter: "^https?://", resourceTypes: ["main_frame", "script"] } }] }));
      await go("read rules", () => browser.declarativeNetRequest.getSessionRules());
      return result;`);
    // A replaced Promise or Number in the caller's realm changes nothing the lock does.
    assert.equal(out, "query went|activate went|focus went|targets went|heartbeat went|regex went|rules went|read rules went|", trick);
    const got = Object.fromEntries(calls.map((call) => [`${call.root} ${call.name}`, call]));
    assert.deepEqual(Object.keys(got), ["chrome tabs.query", "chrome tabs.update", "chrome windows.update", "chrome debugger.getTargets", "chrome offscreen.createDocument", "chrome dnr.isRegexSupported", "chrome dnr.updateSessionRules", "browser dnr.getSessionRules"]);
    for (const call of calls) assert.ok(every(call.args, ownObjects), `${call.name}: every object handed on is the lock's own`);
    assert.deepEqual(seen(got["chrome tabs.query"].args), [{ active: true, lastFocusedWindow: true }]);
    assert.deepEqual(seen(got["chrome tabs.update"].args), [7, { active: true }]);
    assert.deepEqual(seen(got["chrome windows.update"].args), [3, { focused: true }]);
    assert.deepEqual(seen(got["chrome debugger.getTargets"].args), []);
    assert.deepEqual(seen(got["chrome offscreen.createDocument"].args), [{ url: HEARTBEAT, reasons: ["BLOBS"], justification: "Maintain service worker liveness for long-running sessions." }]);
    assert.deepEqual(seen(got["chrome dnr.updateSessionRules"].args), [{ removeRuleIds: [1000000], addRules: [{ id: 1000001, priority: 4, action: { type: "allow" }, condition: { regexFilter: "^https?://", isUrlFilterCaseSensitive: false, excludedResourceTypes: [], initiatorDomains: ["x"], tabIds: [-1] } }, { id: 1000002, priority: 1, action: { type: "block" }, condition: { regexFilter: "^https?://", resourceTypes: ["main_frame", "script"] } }] }]);
  });
}

test("objects that lie are read once, field by field: a Proxy, a getter that answers twice, a hidden or inherited field; what Chrome gets cannot change after the check", async () => {
  const { calls, run } = lockedRealm();
  const out = await run(`
    const result = {};
    const go = async (name, call) => { try { await call(); result[name] = "went"; } catch (error) { result[name] = error.message; } };
    let reads = 0;
    await go("twice active", () => chrome.tabs.update(7, { get active() { reads += 1; return reads === 1 ? true : "file:///etc/hostname"; } }));
    const hidden = { active: true };
    Object.defineProperty(hidden, "url", { value: "file:///etc/hostname", enumerable: false });
    await go("hidden url", () => chrome.tabs.update(7, hidden));
    await go("inherited url", () => { const props = Object.create({ url: "file:///etc/hostname" }); props.active = true; return chrome.tabs.update(7, props); });
    await go("lying proxy", () => chrome.tabs.update(7, new Proxy({ active: true }, { ownKeys: () => ["active"], getOwnPropertyDescriptor: () => ({ value: true, enumerable: true, configurable: true, writable: true }), get: (t, key) => (key === "url" ? "file:///etc/hostname" : true) })));
    await go("throwing proxy", () => chrome.tabs.update(7, new Proxy({}, { ownKeys: () => { throw new Error("trap"); } })));
    let typeReads = 0;
    await go("twice type", () => chrome.declarativeNetRequest.updateSessionRules({ addRules: [{ id: 5, action: { get type() { typeReads += 1; return typeReads === 1 ? "block" : "redirect"; } }, condition: { urlFilter: "x" } }] }));
    let listReads = 0;
    const types = new Proxy(["main_frame"], { get: (t, key) => (key === "length" ? 1 : key === "0" ? (++listReads === 1 ? "main_frame" : { toString: () => "x" }) : t[key]) });
    await go("list item twice", () => chrome.declarativeNetRequest.updateSessionRules({ addRules: [{ id: 6, action: { type: "block" }, condition: { urlFilter: "y", resourceTypes: types } }] }));
    await go("object id", () => chrome.tabs.update({ valueOf: () => 7 }, { active: true }));
    await go("twice url", () => { let urlReads = 0; return chrome.offscreen.createDocument({ get url() { urlReads += 1; return urlReads === 1 ? ${JSON.stringify(HEARTBEAT)} : "wake-service-worker.html"; }, reasons: ["BLOBS"], justification: "x" }); });
    return { result, reads, typeReads, listReads };`);
  assert.equal(out.result["twice active"], "went");
  assert.equal(out.reads, 1, "the getter is read once");
  assert.match(out.result["hidden url"], refusal, "an own field that is not enumerable is still an own field");
  assert.equal(out.result["inherited url"], "went");
  assert.equal(out.result["lying proxy"], "went");
  assert.match(out.result["throwing proxy"], refusal);
  assert.equal(out.result["twice type"], "went");
  assert.equal(out.typeReads, 1);
  assert.equal(out.result["list item twice"], "went");
  assert.equal(out.listReads, 1);
  assert.match(out.result["object id"], refusal);
  assert.equal(out.result["twice url"], "went");
  // What went is the lock's own objects, with the values the check saw.
  assert.ok(calls.every((call) => every(call.args, ownObjects)));
  const updates = calls.filter((call) => call.name === "tabs.update").map((call) => seen(call.args));
  assert.deepEqual(updates, [[7, { active: true }], [7, { active: true }], [7, { active: true }]]);
  const rules = calls.filter((call) => call.name === "dnr.updateSessionRules").map((call) => seen(call.args));
  assert.deepEqual(rules, [[{ addRules: [{ id: 5, action: { type: "block" }, condition: { urlFilter: "x" } }] }], [{ addRules: [{ id: 6, action: { type: "block" }, condition: { urlFilter: "y", resourceTypes: ["main_frame"] } }] }]]);
  assert.deepEqual(seen(calls.find((call) => call.name === "offscreen.createDocument").args), [{ url: HEARTBEAT, reasons: ["BLOBS"], justification: "x" }]);
  // Each original was called on its own namespace object.
  assert.ok(calls.every((call) => call.self && typeof call.self === "object"));
});

test("a namespace Chrome does not give is fixed as absent: none can be put in its place", async () => {
  const context = vm.createContext({ chrome: { tabs: { query() {}, update() {}, onCreated: {} } } });
  vm.runInContext(WORKER_LOCK, context);
  const out = await vm.runInContext(`(async () => { "use strict"; try { globalThis.browser = { tabs: {} }; } catch (error) { return [typeof browser, error.constructor.name].join(","); } return typeof browser; })()`, context);
  assert.equal(out, "undefined,TypeError");
});

test("a browser whose two names hold one namespace object locks it once, and the worker starts", async () => {
  const chrome = { tabs: { query() {}, update() {}, create() {}, onCreated: {} } };
  const context = vm.createContext({ chrome, browser: chrome });
  vm.runInContext(WORKER_LOCK, context);
  assert.equal(await vm.runInContext(`(async () => [browser === chrome, typeof browser.tabs.create, typeof chrome.tabs.update].join(","))()`, context), "true,undefined,function");
});
