import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_SESSION_COOKIE_AGE_MS, clampSessionCookieAgeMs, cookieKept, createRedactor, vaultOrigins, vaultTarget } from "../dist/index.js";
import { captureCdpState, connectCdp, restoreCdpState } from "../dist/providers/cdp-session.js";
import { cdpProvider } from "../dist/providers/cdp.js";
import { planRestore, vaultRuntime } from "../dist/vault-session.js";
import { CHROME, NO_CHROME } from "./fixtures/local-chrome.mjs";
import { countedPath, isPortProbe } from "./fixtures/loopback-probe.mjs";

// What a vault keeps of a signed-in local Chrome: the cookies the host's origins would be sent, and each origin's local storage, captured and restored over the
// browser's DevTools socket from the harness side. Cookies are scoped by DOMAIN, so the filter is tested by domain; a restore never touches the network; the
// session-cookie age cap is clamped in code; a provider's context id is a secret the redactor scrubs.
const cookie = (domain, extra = {}) => ({ name: "c", value: "v", domain, path: "/", secure: false, httpOnly: false, session: true, expires: -1, ...extra });

test("a cookie is kept only when an allowed origin would be sent it: by domain, by secure flag, never a partitioned one", () => {
  const app = ["https://app.example.com"];
  assert.equal(cookieKept(cookie("app.example.com"), app), true, "a host cookie of the origin's own host");
  assert.equal(cookieKept(cookie(".example.com"), app), true, "a parent-domain cookie the host is under");
  assert.equal(cookieKept(cookie(".app.example.com"), app), true, "a domain cookie of the host itself");
  assert.equal(cookieKept(cookie("other.example.com"), app), false, "a sibling site's host cookie");
  assert.equal(cookieKept(cookie(".other.example.com"), app), false, "a sibling's domain cookie");
  assert.equal(cookieKept(cookie("example.com"), app), false, "a host-only cookie of the parent is sent only to the parent");
  assert.equal(cookieKept(cookie(".com"), app), false, "a public-suffix domain cookie");
  assert.equal(cookieKept(cookie(".notexample.com"), app), false, "a lookalike suffix");
  assert.equal(cookieKept(cookie("APP.Example.com"), app), true, "case does not matter");
  assert.equal(cookieKept(cookie(".example.com", { secure: true }), ["http://app.example.com"]), false, "a secure cookie is never sent to a plain http origin");
  assert.equal(cookieKept(cookie(".example.com", { secure: true }), app), true, "and is to an https one");
  assert.equal(cookieKept(cookie("localhost", { secure: true }), ["http://localhost:3000"]), true, "a loopback host counts as secure");
  assert.equal(cookieKept(cookie("127.0.0.1"), ["http://127.0.0.1:8080"]), true, "the port does not scope a cookie");
  assert.equal(cookieKept(cookie(".example.com", { partitionKey: { topLevelSite: "https://x.test" } }), app), false, "a partitioned cookie");
  assert.equal(cookieKept(cookie("other.test"), ["https://a.example.com", "https://other.test"]), true, "any of several origins");
});

test("a host-only cookie matches its own host exactly: app.example.com's is not kept for sub.app.example.com, a domain cookie is, and a restored host-only cookie stays host-only", () => {
  const hostOnly = { domain: "app.example.com", secure: false };
  assert.equal(cookieKept(hostOnly, ["https://app.example.com"]), true);
  assert.equal(cookieKept(hostOnly, ["https://sub.app.example.com"]), false, "a host-only cookie is never a domain cookie");
  assert.equal(cookieKept(hostOnly, ["https://sub.app.example.com", "https://other.example.com"]), false);
  assert.equal(cookieKept({ domain: ".app.example.com", secure: false }, ["https://sub.app.example.com"]), true, "a domain cookie is kept for a host under it");
});

test("the allowed origins and the key are validated: scheme://host[:port] of http or https, a key of 1 to 128 characters", () => {
  assert.deepEqual(vaultOrigins(["https://a.example.com/", "https://a.example.com", "http://127.0.0.1:8080"]), ["https://a.example.com", "http://127.0.0.1:8080"]);
  for (const bad of ["file:///etc", "https://a.example.com/path", "ftp://x", "example.com", "", "javascript:alert(1)"]) assert.throws(() => vaultOrigins([bad]), RangeError, bad);
  assert.throws(() => vaultOrigins([]), RangeError);
  assert.deepEqual(vaultTarget({ sessionKey: "local-chrome", origins: ["https://x.test"] }), { sessionKey: "local-chrome", origins: ["https://x.test"] });
  for (const key of ["", " ", "a b", "../x", "x".repeat(129)]) assert.throws(() => vaultTarget({ sessionKey: key, origins: ["https://x.test"] }), RangeError, key);
});

test("the session-cookie age cap is clamped to 24 h in code: above is clamped, lower is kept, zero, negative and not-a-number are refused", () => {
  assert.equal(MAX_SESSION_COOKIE_AGE_MS, 86_400_000);
  assert.equal(clampSessionCookieAgeMs(), 86_400_000);
  assert.equal(clampSessionCookieAgeMs(48 * 3600_000), 86_400_000, "48 h becomes 24 h");
  assert.equal(clampSessionCookieAgeMs(Number.MAX_SAFE_INTEGER), 86_400_000);
  assert.equal(clampSessionCookieAgeMs(3600_000), 3600_000, "a lower cap holds");
  for (const bad of [0, -1, NaN, Infinity, "86400000"]) assert.throws(() => clampSessionCookieAgeMs(bad), RangeError, String(bad));
});

/** A stand-in for the browser's DevTools socket: answers the few calls capture and restore make, records them. */
function fakeLink({ jar = [], storage = {} } = {}) {
  const calls = []; const listeners = new Set();
  return {
    calls,
    link: {
      send: async (method, params = {}) => {
        calls.push([method, params]);
        if (method === "Storage.getCookies") return { cookies: jar };
        if (method === "Target.createTarget") return { targetId: "t1" };
        if (method === "Target.attachToTarget") return { sessionId: "s1" };
        if (method === "Page.navigate") { setTimeout(() => listeners.forEach((l) => l({ sessionId: "s1", method: "Page.loadEventFired" })), 1); return {}; }
        if (method === "DOMStorage.getDOMStorageItems") return { entries: Object.entries(storage[params.storageId.securityOrigin] ?? {}) };
        return {};
      },
      on: (l) => { listeners.add(l); return () => listeners.delete(l); },
      close() {},
    },
  };
}

test("capture keeps only the allowed origins' cookies and storage, marks a session cookie by no expiry, and stamps capturedAt", async () => {
  const jar = [
    cookie("app.example.com", { name: "keep-session", value: "1" }),
    cookie(".example.com", { name: "keep-persistent", value: "2", session: false, expires: 2_000_000_000, httpOnly: true, secure: true, sameSite: "Lax" }),
    cookie("sibling.example.com", { name: "drop-sibling", value: "3" }),
    cookie(".tracker.test", { name: "drop-other", value: "4" }),
  ];
  const { link, calls } = fakeLink({ jar, storage: { "https://app.example.com": { token: "t", theme: "dark" }, "https://sibling.example.com": { x: "y" } } });
  const state = await captureCdpState(link, ["https://app.example.com"], new Date("2026-10-21T01:00:00Z"));
  assert.equal(state.kind, "cdp");
  assert.equal(state.capturedAt, "2026-10-21T01:00:00.000Z");
  assert.deepEqual(state.cookies.map((c) => c.name).sort(), ["keep-persistent", "keep-session"]);
  assert.equal(state.cookies.find((c) => c.name === "keep-session").expires, undefined, "a session cookie has no expiry");
  assert.deepEqual(state.cookies.find((c) => c.name === "keep-persistent"), { name: "keep-persistent", value: "2", domain: ".example.com", path: "/", expires: 2_000_000_000, httpOnly: true, secure: true, sameSite: "Lax" });
  assert.deepEqual(state.localStorage, { "https://app.example.com": { token: "t", theme: "dark" } }, "only the allowed origin's storage");
  assert.ok(!calls.some(([m, p]) => m === "DOMStorage.getDOMStorageItems" && p.storageId.securityOrigin !== "https://app.example.com"), "no other origin was even asked");
  assert.ok(calls.some(([m, p]) => m === "Fetch.enable" && p.patterns[0].urlPattern === "https://app.example.com/*"), "its requests are answered locally, not sent");
});

test("restore drops what expired, session cookies older than the cap and what the requested origins do not allow, and returns counts, never a value", async () => {
  const state = {
    kind: "cdp", capturedAt: "2026-10-20T12:00:00.000Z",
    cookies: [
      { name: "alive", value: "a", domain: ".example.com", path: "/", expires: 2_000_000_000, httpOnly: true, secure: true },
      { name: "expired", value: "b", domain: ".example.com", path: "/", expires: 1_000_000_000, httpOnly: false, secure: false },
      { name: "young-session", value: "c", domain: "app.example.com", path: "/", httpOnly: false, secure: true },
      { name: "outside", value: "d", domain: "elsewhere.test", path: "/", httpOnly: false, secure: false },
    ],
    localStorage: { "https://app.example.com": { k: "v" }, "https://elsewhere.test": { z: "z" } },
  };
  // 6 h after capture: the session cookie is young
  const young = fakeLink();
  const counts = await restoreCdpState(young.link, state, ["https://app.example.com"], new Date("2026-10-20T18:00:00Z"));
  assert.deepEqual(counts, { cookies: 2, origins: 1, droppedExpired: 1, droppedAged: 0, droppedOutside: 2 });
  const set = young.calls.find(([m]) => m === "Storage.setCookies")[1].cookies;
  assert.deepEqual(set.map((c) => c.name).sort(), ["alive", "young-session"]);
  assert.ok(!set.some((c) => "expires" in c && c.name === "young-session"), "a session cookie is restored as a session cookie");
  assert.ok(young.calls.findIndex(([m]) => m === "Storage.setCookies") < young.calls.findIndex(([m]) => m === "DOMStorage.setDOMStorageItem"), "cookies first, before any page");
  assert.equal(JSON.stringify(counts).includes("\"a\""), false);
  // 25 h after capture: with no host value the 24 h cap drops it; a host value of 48 h is clamped to 24 h and drops it too
  for (const requested of [undefined, 48 * 3600_000]) {
    const old = fakeLink();
    const c = await restoreCdpState(old.link, state, ["https://app.example.com"], new Date("2026-10-21T13:00:00Z"), requested);
    assert.equal(c.droppedAged, 1, `a session cookie 25 h old is dropped (requested ${requested})`);
    assert.ok(!old.calls.find(([m]) => m === "Storage.setCookies")[1].cookies.some((x) => x.name === "young-session"));
  }
  // a host that lowers the cap to 1 h drops it at 6 h
  const low = await restoreCdpState(fakeLink().link, state, ["https://app.example.com"], new Date("2026-10-20T18:00:00Z"), 3600_000);
  assert.equal(low.droppedAged, 1);
  await assert.rejects(restoreCdpState(fakeLink().link, state, ["https://app.example.com"], new Date(), 0), RangeError, "a zero cap is refused");
  // a state with no usable capturedAt keeps no session cookie
  const blind = await restoreCdpState(fakeLink().link, { ...state, capturedAt: "not a date" }, ["https://app.example.com"], new Date("2026-10-20T18:00:00Z"));
  assert.equal(blind.droppedAged, 1);
});

test("a provider's context id is a capability: once tracked as a secret, the redactor removes it from any text, in the raw and URL-encoded spellings", () => {
  const contextId = "ctx_7f3a91c2d4e85b06a1";
  const tracked = [];
  const redact = createRedactor(() => tracked);
  assert.equal(redact(`created session with context ${contextId}`).includes(contextId), true, "untracked, it passes through: the reason it must be registered");
  tracked.push(contextId);
  assert.equal(redact(`created session with context ${contextId}`), "created session with context [redacted]");
  assert.equal(redact(`https://api.example/browsers?context=${encodeURIComponent(contextId)}`).includes(contextId), false);
});

test("a request to the test site is set aside only when it is exactly a port probe: GET /, the User-Agent Go-http-client/1.1 and no Cookie; any other request counts, a Chrome User-Agent included", () => {
  const req = (over = {}) => ({ method: "GET", url: "/", headers: { "user-agent": "Go-http-client/1.1" }, ...over });
  assert.equal(isPortProbe(req()), true);
  assert.equal(countedPath(req()), null);
  for (const [what, over] of Object.entries({
    "a Chrome User-Agent": { headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36" } },
    "another User-Agent": { headers: { "user-agent": "curl/8.5.0" } },
    "no User-Agent": { headers: {} },
    "a near-miss User-Agent": { headers: { "user-agent": "Go-http-client/2.0" } },
    "a cookie": { headers: { "user-agent": "Go-http-client/1.1", cookie: "a=b" } },
    "another path": { url: "/favicon.ico" },
    "a path with a query": { url: "/?x=1" },
    "another method": { method: "POST" },
  })) {
    assert.equal(isPortProbe(req(over)), false, what);
    assert.notEqual(countedPath(req(over)), null, `${what} is counted`);
  }
});

test("in Chrome: a signed-in session is captured, the browser is released, and a fresh Chrome gets it back before any page opens, with no request to the site", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const hits = [];
  const server = http.createServer((req, res) => { const counted = countedPath(req); if (counted !== null) hits.push(counted); res.writeHead(200, { "content-type": "text/html" }); res.end(`<!doctype html><title>site</title><p id="who"></p><script>document.getElementById("who").textContent = localStorage.getItem("login") || "signed out";</script>`); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close(), { timeout: 30_000 });
  const A = `http://127.0.0.1:${server.address().port}`;
  const B = `http://localhost:${server.address().port}`;
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "vault-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }), { timeout: 30_000 });
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, args: [] } });
  const spec = (tag) => ({ tag, maxLifetimeS: 600, idleTimeoutS: 120, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: { run: "vault", label: tag } });
  const signal = () => AbortSignal.timeout(60_000);
  const attachedLink = async (ref) => connectCdp((await provider.attach(ref, signal())).sdkCdpUrl);
  const openPage = async (link, url) => {
    const { targetId } = await link.send("Target.createTarget", { url }); const { sessionId } = await link.send("Target.attachToTarget", { targetId, flatten: true });
    await new Promise((resolve) => setTimeout(resolve, 900)); return { targetId, eval: async (expression) => (await link.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)).result.value };
  };

  // session A: sign in the way a site does, with a persistent cookie, an httpOnly session cookie, and local storage on two origins
  const refA = await provider.create(spec("vault-a"), signal());
  const linkA = await attachedLink(refA);
  const pageA = await openPage(linkA, `${A}/`);
  await pageA.eval(`localStorage.setItem("login", "sam"); document.cookie = "persist=1; max-age=2592000; path=/"; 1`);
  await linkA.send("Storage.setCookies", { cookies: [{ name: "sess", value: "s", url: `${A}/`, httpOnly: true }, { name: "stranger", value: "x", url: "http://stranger.test/" }] });
  const pageA2 = await openPage(linkA, `${B}/`);
  await pageA2.eval(`localStorage.setItem("login", "sam-on-localhost"); 1`);
  const state = await captureCdpState(linkA, [A, B]);
  linkA.close(); await provider.release(refA, signal());
  assert.deepEqual(state.cookies.map((c) => c.name).sort(), ["persist", "sess"], "the stranger site's cookie was not captured");
  assert.ok(state.cookies.find((c) => c.name === "persist").expires > Date.now() / 1000, "a persistent cookie keeps its expiry");
  assert.equal(state.cookies.find((c) => c.name === "sess").expires, undefined, "a session cookie has none");
  assert.deepEqual(Object.keys(state.localStorage).sort(), [A, B].sort());

  // session B: a fresh Chrome and a fresh profile. Restore before any page: the site must not be asked for anything
  const refB = await provider.create(spec("vault-b"), signal());
  const linkB = await attachedLink(refB);
  // B's Chrome is released even when an assertion below fails: a left-over Chrome holds the test process open.
  t.after(async () => { linkB.close(); await provider.release(refB, signal()).catch(() => undefined); }, { timeout: 30_000 });
  const before = hits.length;
  const counts = await restoreCdpState(linkB, state, [A, B]);
  assert.equal(hits.length, before, "the restore made no request to the site: every request was answered locally");
  assert.deepEqual([counts.cookies, counts.origins], [2, 2]);
  const pageB = await openPage(linkB, `${A}/`);
  assert.equal(await pageB.eval(`document.getElementById("who").textContent`), "sam", "the page's own script finds the restored local storage");
  assert.match(await pageB.eval(`document.cookie`), /persist=1/);
  assert.equal(/sess=/.test(await pageB.eval(`document.cookie`)), false, "the httpOnly cookie is not readable by a script");
  assert.ok((await linkB.send("Storage.getCookies", {})).cookies.some((c) => c.name === "sess" && c.httpOnly), "but it is in the jar");
  const pageB2 = await openPage(linkB, `${B}/`);
  assert.equal(await pageB2.eval(`document.getElementById("who").textContent`), "sam-on-localhost");
  linkB.close(); await provider.release(refB, signal());
});

test("a Chrome attached by endpoint is offered to a vault only when the host says it is the run's own: without it the vault is refused with its reason, and nothing is restored", async () => {
  const warnings = [];
  const rt = vaultRuntime({ sessionVault: { restore: async () => { throw new Error("must not be asked"); }, capture: async () => { throw new Error("must not capture"); }, forget: async () => {} } }, () => {}, (message) => warnings.push(message));
  const target = { sessionKey: "k", origins: ["https://app.example.com"] };
  const spec = { tag: "t", maxLifetimeS: 60, idleTimeoutS: 30, proxies: false, verified: false, captcha: false, viewport: { width: 800, height: 600 }, metadata: { run: "r", label: "l" } };
  const shared = cdpProvider({ endpoint: "http://127.0.0.1:9" });
  assert.equal(shared.vault, undefined, "an endpoint Chrome declares no vault capability on its own");
  const plan = await planRestore(rt, target, shared, spec);
  assert.equal(plan.afterAttach, null);
  assert.equal(plan.spec, spec);
  assert.match(warnings.join("\n"), /ownBrowser: true/, "the refusal names the opt-in");
  assert.deepEqual(cdpProvider({ endpoint: "http://127.0.0.1:9", ownBrowser: true }).vault, { kind: "cdp" }, "the host's promise offers it");
});

test("in Chrome: a restored host-only cookie stays host-only (never a domain cookie), so a capture for a sub-host does not take it, and a domain cookie does reach the sub-host", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "vault-ho-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }), { timeout: 30_000 });
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, args: [] } });
  const ref = await provider.create({ tag: "vault-host-only", maxLifetimeS: 600, idleTimeoutS: 120, proxies: false, verified: false, captcha: false, viewport: { width: 800, height: 600 }, metadata: { run: "vault", label: "ho" } }, AbortSignal.timeout(60_000));
  const link = await connectCdp((await provider.attach(ref, AbortSignal.timeout(60_000))).sdkCdpUrl);
  try {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const saved = { kind: "cdp", capturedAt: new Date().toISOString(), localStorage: {}, cookies: [
      { name: "h", value: "1", domain: "app.example.test", path: "/", secure: true, httpOnly: false, expires },
      { name: "d", value: "1", domain: ".app.example.test", path: "/", secure: true, httpOnly: false, expires },
    ] };
    await restoreCdpState(link, saved, ["https://app.example.test"], new Date(), MAX_SESSION_COOKIE_AGE_MS);
    const jar = (await link.send("Storage.getCookies", {})).cookies;
    assert.equal(jar.find((c) => c.name === "h").domain, "app.example.test", "the host-only cookie came back with no leading dot");
    assert.equal(jar.find((c) => c.name === "d").domain, ".app.example.test", "and the domain cookie with its dot");
    assert.deepEqual((await captureCdpState(link, ["https://sub.app.example.test"], new Date())).cookies.map((c) => c.name), ["d"], "a sub-host takes the domain cookie only");
    assert.deepEqual((await captureCdpState(link, ["https://app.example.test"], new Date())).cookies.map((c) => c.name).sort(), ["d", "h"]);
    // and a restore for the sub-host does not put the host-only cookie back
    const second = await provider.create({ tag: "vault-host-only-2", maxLifetimeS: 600, idleTimeoutS: 120, proxies: false, verified: false, captcha: false, viewport: { width: 800, height: 600 }, metadata: { run: "vault", label: "ho2" } }, AbortSignal.timeout(60_000));
    const link2 = await connectCdp((await provider.attach(second, AbortSignal.timeout(60_000))).sdkCdpUrl);
    try {
      const counts = await restoreCdpState(link2, saved, ["https://sub.app.example.test"], new Date(), MAX_SESSION_COOKIE_AGE_MS);
      assert.deepEqual([counts.cookies, counts.droppedOutside], [1, 1]);
      assert.deepEqual((await link2.send("Storage.getCookies", {})).cookies.map((c) => c.name), ["d"]);
    } finally { link2.close(); await provider.release(second, AbortSignal.timeout(60_000)); }
  } finally { link.close(); await provider.release(ref, AbortSignal.timeout(60_000)); }
});
