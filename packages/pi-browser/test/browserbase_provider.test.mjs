import assert from "node:assert/strict";
import http from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile as writeFileText } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import * as undici from "undici";
import { closeDirectFetch, directFetch } from "../dist/providers/browserbase-net.js";
import { applyBrowserbaseNoProxy, browserbaseGeolocation, browserbaseNoProxyHosts, browserbaseProvider, fileProfileStore, setDownloadBehavior, proxiesField, rewriteConnectUrl, SEARCH_QUERY_MAX, SEARCH_RESULTS_MAX } from "../dist/providers/browserbase.js";
import { bindConnectDial, installWebSocketWrapper, connectDialUrl, unbindConnectDial } from "../dist/providers/browserbase-net.js";
import { fakeBrowserbase } from "./fixtures/fake-browserbase.mjs";
import { scratch } from "./fixtures/scratch.mjs";
const SHARED_KEY = "shared-account-key"; // a fake value, named so the source export's credential scan reads it as one
const DIRECT_KEY = "bb_live_direct"; // a fake value, named so the source export's credential scan reads it as one

let keySeq = 0;
// The extension is uploaded once per process and account, so each test names its own account.
const proxied = () => ({ BROWSERBASE_API_KEY: `not-a-secret-${(keySeq += 1)}`, BROWSERBASE_BASE_URL: "https://proxy.example", BROWSERBASE_CONNECT_BASE_URL: "wss://proxy.example/ws" });
const spec = (over = {}) => ({ tag: "ar-run1-1-1", maxLifetimeS: 1800, idleTimeoutS: 120, proxies: true, verified: false, captcha: true, viewport: { width: 1288, height: 711 }, metadata: { agentrun: "1", job: "job-42", node: "Gather Evidence" }, ...over });
const rig = (knobs = {}, env = proxied(), extra = {}) => {
  const fake = fakeBrowserbase(knobs);
  const provider = browserbaseProvider({ env, client: fake.sdk, sleep: async () => {}, ...extra });
  return { fake, provider, env };
};

test("create sends today's body with the tag stamped, never retries, and the ref carries no secret", async () => {
  const { fake, provider } = rig();
  const ref = await provider.create(spec(), new AbortController().signal);
  assert.deepEqual(ref, { id: "sess_1", tag: "ar-run1-1-1" });
  const [create] = fake.only("sessions.create");
  assert.equal(create.body.proxies, true);
  assert.equal(create.body.timeout, 1800);
  assert.equal(create.body.keepAlive, true, "a disconnect must not end a paid session; only a release does");
  assert.equal(create.body.browserSettings.solveCaptchas, true);
  assert.equal(create.body.browserSettings.advancedStealth, undefined, "verified replaces the deprecated advancedStealth");
  assert.deepEqual(create.body.browserSettings.viewport, { width: 1288, height: 711 });
  assert.equal(create.body.projectId, undefined, "no project id behind the credential proxy");
  assert.equal(create.body.extensionId, "ext_1");
  assert.deepEqual(create.body.userMetadata, { agentrun: "1", job: "job-42", node: "Gather_Evidence", agentrun_tag: "ar-run1-1-1" });
  assert.equal(create.options.maxRetries, 0, "a create the SDK could retry would open a second paid browser");
  assert.equal(JSON.stringify(ref).includes("SECRET"), false, "the connect URL stays in provider memory");
});

test("the extension is uploaded once per process and account, without retries; a failed upload is tried again", async () => {
  const env = proxied();
  const a = rig({}, env); const b = rig({}, env);
  await a.provider.create(spec(), new AbortController().signal);
  await b.provider.create(spec({ tag: "ar-run1-2-1" }), new AbortController().signal);
  assert.equal(a.fake.only("extensions.create").length + b.fake.only("extensions.create").length, 1, "one upload for two providers on one account");
  assert.equal(a.fake.only("extensions.create")[0].options.maxRetries, 0);
  const failing = rig({ extensionError: new Error("upload 502") }, proxied());
  await assert.rejects(failing.provider.create(spec(), new AbortController().signal), /upload 502/);
  assert.equal(failing.fake.only("sessions.create").length, 0, "no session without the extension");
  failing.fake.sdk.extensions.create = async () => ({ id: "ext_late" });
  await failing.provider.create(spec(), new AbortController().signal);
  assert.equal(failing.fake.only("sessions.create")[0].body.extensionId, "ext_late");
});

test("a failed create is one call and leaves nothing for findByTag", async () => {
  const { fake, provider } = rig({ createError: Object.assign(new Error("502"), { status: 502 }) });
  await assert.rejects(provider.create(spec(), new AbortController().signal), /502/);
  assert.equal(fake.only("sessions.create").length, 1);
  assert.deepEqual(await provider.findByTag("ar-run1-1-1"), []);
});

test("a direct key names its project; behind the credential proxy it never does", async () => {
  const direct = rig({}, { BROWSERBASE_API_KEY: DIRECT_KEY, BROWSERBASE_PROJECT_ID: "proj_123" });
  await direct.provider.create(spec(), new AbortController().signal);
  assert.equal(direct.fake.only("sessions.create")[0].body.projectId, "proj_123");
  const behind = rig({}, { ...proxied(), BROWSERBASE_PROJECT_ID: "proj_123" });
  await behind.provider.create(spec(), new AbortController().signal);
  assert.equal(behind.fake.only("sessions.create")[0].body.projectId, undefined, "proxied lanes never name a project even when the env carries one");
});

test("findByTag returns every running session with the tag and never another's, even when the lane ignores the query", async () => {
  const { fake, provider } = rig();
  const signal = new AbortController().signal;
  await provider.create(spec({ tag: "ar-run1-1-1" }), signal);
  await provider.create(spec({ tag: "ar-run1-2-1" }), signal);
  assert.deepEqual(await provider.findByTag("ar-run1-2-1"), [{ id: "sess_2", tag: "ar-run1-2-1" }]);
  assert.equal(fake.only("sessions.list")[0].query.q, "user_metadata['agentrun_tag']:'ar-run1-2-1'");
  assert.deepEqual(fake.only("sessions.list").map((c) => c.query.status).sort(), ["PENDING", "RUNNING"], "both statuses are asked, never none (q alone 504s)");
  fake.sessions.get("sess_2").status = "PENDING";
  assert.deepEqual(await provider.findByTag("ar-run1-2-1"), [{ id: "sess_2", tag: "ar-run1-2-1" }], "a session whose create reply was lost while PENDING is found, once");
  fake.sessions.get("sess_2").status = "RUNNING";
  const lax = rig({ ignoreQuery: true });
  await lax.provider.create(spec({ tag: "ar-run1-1-1" }), signal);
  await lax.provider.create(spec({ tag: "ar-run1-2-1" }), signal);
  assert.deepEqual(await lax.provider.findByTag("ar-run1-2-1"), [{ id: "sess_2", tag: "ar-run1-2-1" }], "a proxy that drops `q` returns every session; the match is ours");
  await assert.rejects(provider.findByTag("x' OR 1"), /session tag/);
});

test("attach gives the driver the raw connect URL and the process its dial target; a new process finds the URL again", async () => {
  const dialed = [];
  const { fake, provider } = rig({}, proxied(), { downloadBehavior: async (url) => { dialed.push(url); return { open: true, close() { this.open = false; } }; } });
  const ref = await provider.create(spec(), new AbortController().signal);
  const target = await provider.attach(ref);
  assert.ok(dialed.length === 1 && dialed[0] === target.dial.url, "attach tells the browser to keep downloads, dialing the proxy like the driver does");
  assert.ok(target.sdkCdpUrl === "wss://connect.usw2.browserbase.com/sess_1?signingKey=SECRET", "the extension in the cloud browser dials the raw URL");
  assert.ok(target.dial.url === "wss://proxy.example/ws/sess_1?signingKey=SECRET", "this process dials the credential proxy");
  assert.equal(target.extensionId, undefined, "the driver finds the preloaded extension itself");
  await provider.attach(ref);
  assert.equal(dialed.length, 1, "the setting's socket is held for the session: a second attach in this process sends nothing");
  const restarted = browserbaseProvider({ env: proxied(), client: fake.sdk, downloadBehavior: async () => undefined });
  assert.ok((await restarted.attach(ref)).sdkCdpUrl === target.sdkCdpUrl, "after a crash the URL comes from the session record");
});

test("the download setting's socket is held until release, and re-sent when it was lost", async () => {
  const sockets = [];
  const { provider } = rig({}, proxied(), { downloadBehavior: async () => { const s = { open: true, close() { this.open = false; } }; sockets.push(s); return s; } });
  const ref = await provider.create(spec(), new AbortController().signal);
  await provider.attach(ref);
  assert.deepEqual(sockets.map((s) => s.open), [true]);
  sockets[0].open = false;
  await provider.attach(ref);
  assert.deepEqual(sockets.map((s) => s.open), [false, true], "a socket that dropped is replaced by the next attach (a crash's reattach)");
  await provider.release(ref);
  assert.deepEqual(sockets.map((s) => s.open), [false, false], "release closes the held socket");
});

test("two providers with different proxies in one process never dial each other's: the target is bound to the socket's own URL", async () => {
  const fake = fakeBrowserbase();
  const make = (base) => ({ provider: browserbaseProvider({ env: { ...proxied(), BROWSERBASE_CONNECT_BASE_URL: base }, client: fake.sdk, sleep: async () => {}, downloadBehavior: async () => undefined }) });
  const a = make("wss://proxy-a.example/ws");
  const b = make("wss://proxy-b.example/ws");
  const refA = await a.provider.create(spec({ tag: "ar-iso-a-1" }), new AbortController().signal);
  const refB = await b.provider.create(spec({ tag: "ar-iso-b-1" }), new AbortController().signal);
  const urlA = (await a.provider.attach(refA)).sdkCdpUrl;
  const urlB = (await b.provider.attach(refB)).sdkCdpUrl;
  assert.ok(urlA !== urlB);
  assert.ok(connectDialUrl(urlA).startsWith("wss://proxy-a.example/ws/"), "A's socket goes to A's proxy even though B attached after");
  assert.ok(connectDialUrl(urlB).startsWith("wss://proxy-b.example/ws/"), "B's goes to B's");
  assert.ok(connectDialUrl("wss://connect.usw2.browserbase.com/unknown") === "wss://connect.usw2.browserbase.com/unknown", "a URL no provider bound is dialed as it is");
  await a.provider.release(refA);
  assert.ok(connectDialUrl(urlA) === urlA, "a released session's binding is gone");
  await b.provider.release(refB);
});

test("the process dials a bound connect URL at its credential proxy while the record keeps the raw URL", async () => {
  const raw = "wss://connect.usw2.browserbase.com/x?signingKey=k";
  assert.ok(connectDialUrl(raw) === raw, "nothing bound: dialed as it is");
  bindConnectDial(raw, "wss://proxy.example/ws");
  assert.ok(connectDialUrl(raw) === "wss://proxy.example/ws/x?signingKey=k");
  assert.ok(connectDialUrl("wss://proxy.example/ws/x") === "wss://proxy.example/ws/x", "already proxied: untouched");
  assert.ok(connectDialUrl("ws://127.0.0.1:9222/devtools/browser/abc") === "ws://127.0.0.1:9222/devtools/browser/abc", "non-Browserbase: untouched");
  assert.ok(rewriteConnectUrl("wss://connect.browserbase.com/x", null) === "wss://connect.browserbase.com/x");
  unbindConnectDial(raw);
  const seen = [];
  const proxy = http.createServer();
  proxy.on("upgrade", (req, socket) => { seen.push(req.url); socket.destroy(); });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  try {
    installWebSocketWrapper();
    const url = "wss://connect.usw2.browserbase.com/abc?signingKey=SECRET";
    bindConnectDial(url, `ws://127.0.0.1:${proxy.address().port}/ws`);
    const ws = new WebSocket(url);
    await new Promise((r) => { ws.addEventListener("error", () => setTimeout(r, 30)); ws.addEventListener("close", () => setTimeout(r, 30)); });
    assert.ok(seen.length === 1 && seen[0] === "/ws/abc?signingKey=SECRET", "the socket dialed the proxy, path prefixed, signing query kept");
    unbindConnectDial(url);
  } finally { proxy.close(); }
});

test("release: the request is retried, confirmed by the provider's own report, and never marked done before", async () => {
  const lagging = rig({ releaseLag: 2 });
  const ref = await lagging.provider.create(spec(), new AbortController().signal);
  await lagging.provider.release(ref);
  assert.equal(lagging.fake.only("sessions.update").length, 1);
  assert.equal(lagging.fake.only("sessions.update")[0].options.maxRetries, 0, "a release request is not retried by the SDK");
  assert.equal(lagging.fake.sessions.get(ref.id).status, "COMPLETED");
  await lagging.provider.release(ref);
  const second = rig({ releaseErrors: [new Error("502 bad gateway"), new Error("502 bad gateway")] });
  const stuck = await second.provider.create(spec(), new AbortController().signal);
  await assert.rejects(second.provider.release(stuck), /502/);
  assert.equal(second.fake.only("sessions.update").length, 2, "two attempts per release");
  assert.equal(second.fake.sessions.get(stuck.id).status, "RUNNING", "still running: the release is not reported done");
  await second.provider.release(stuck);
  assert.equal(second.fake.sessions.get(stuck.id).status, "COMPLETED", "a later release succeeds");
  const gone = rig();
  await gone.provider.release({ id: "sess_nope", tag: "t" });
});

test("status is the provider's report: running, stopped, gone on a 404; any other failure is not a fact", async () => {
  const { fake, provider } = rig();
  const ref = await provider.create(spec(), new AbortController().signal);
  assert.equal(await provider.status(ref), "running");
  await provider.release(ref);
  assert.equal(await provider.status(ref), "stopped");
  assert.equal(await provider.status({ id: "sess_nope", tag: "t" }), "gone");
  const broken = rig({ retrieveError: Object.assign(new Error("lookup 500"), { status: 500 }) });
  await assert.rejects(broken.provider.status({ id: "sess_1", tag: "t" }), /lookup 500/);
  const [lookup] = fake.only("sessions.retrieve");
  assert.equal(lookup.options.maxRetries, undefined, "reads keep the SDK's retries");
});

test("the live view carries the fullscreen and framed URLs and each tab; a failed lookup is no view", async () => {
  const { fake, provider } = rig();
  const ref = await provider.create(spec(), new AbortController().signal);
  const view = await provider.liveView(ref);
  assert.ok(/devtools-fullscreen.*s=sess_1/.test(view.fullscreen));
  assert.equal(view.pages[0].id, "p1");
  fake.sdk.sessions.debug = async () => { throw new Error("debug down"); };
  assert.equal(await provider.liveView(ref), null);
});

test("geolocation: only a two-letter country is a place; proxies take it, and never turn on by it", () => {
  assert.deepEqual(browserbaseGeolocation({ country: "gb", city: "sao paulo" }), { country: "GB", city: "SAO_PAULO" });
  assert.deepEqual(browserbaseGeolocation({ country: "US", state: "ca" }), { country: "US", state: "CA" });
  assert.equal(browserbaseGeolocation({ city: "LONDON" }), null, "no country, no geolocation");
  assert.deepEqual(proxiesField({ geolocation: { country: "GB", city: "LONDON" } }), [{ type: "browserbase", geolocation: { country: "GB", city: "LONDON" } }]);
  assert.equal(proxiesField(true), true);
  assert.equal(proxiesField(false), false);
  assert.equal(proxiesField({ geolocation: { country: "United Kingdom" } }), true, "an unusable place falls back to the plain switch");
});

test("the Browserbase lane bypasses the env proxy: NO_PROXY carries the base and connect hosts", () => {
  assert.deepEqual(browserbaseNoProxyHosts({ BROWSERBASE_BASE_URL: "https://egress.proxy.example/browserbase", BROWSERBASE_CONNECT_BASE_URL: "wss://egress.proxy.example/browserbase/ws" }), ["egress.proxy.example"]);
  assert.deepEqual(browserbaseNoProxyHosts({ BROWSERBASE_BASE_URL: "https://proxy.example" }), ["proxy.example", ".browserbase.com"], "no connect proxy: Browserbase's own CDP hosts bypass too");
  assert.deepEqual(browserbaseNoProxyHosts({}), [".browserbase.com"]);
  const e = { NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost", BROWSERBASE_BASE_URL: "https://proxy.example", BROWSERBASE_CONNECT_BASE_URL: "wss://proxy.example/ws" };
  applyBrowserbaseNoProxy(e);
  assert.equal(e.NO_PROXY, "localhost,127.0.0.1,proxy.example");
  assert.equal(e.no_proxy, "localhost,proxy.example");
  applyBrowserbaseNoProxy(e);
  assert.equal(e.NO_PROXY, "localhost,127.0.0.1,proxy.example", "idempotent");
});

test("fetch and search: the service's facts come back typed; limits are clamped and the key rides the call, not the result", async () => {
  const { fake, provider, env } = rig();
  const ok = await provider.fetch({ url: "https://example.com", format: "markdown", proxies: true });
  assert.deepEqual({ ...ok, usage: undefined }, { usage: undefined, finalUrl: null, statusCode: 200, contentType: "text/markdown", content: "# Example\n\nHello from fetch." });
  const call = fake.only("fetch")[0].input;
  assert.deepEqual([call.url, call.proxies, call.allowRedirects, call.format], ["https://example.com", true, true, "markdown"]);
  assert.equal((await provider.fetch({ url: "https://blocked.test", format: "raw", proxies: false })).statusCode, 403);
  assert.equal(fake.only("fetch")[1].input.proxies, false, "the Fetch API takes proxies as a switch");
  const found = await provider.search({ query: "q".repeat(SEARCH_QUERY_MAX + 50), n: 99 });
  assert.equal(found.results[0].url, "https://example.com/a");
  const sent = fake.only("search")[0].input;
  assert.equal(sent.query.length, SEARCH_QUERY_MAX);
  assert.equal(sent.numResults, SEARCH_RESULTS_MAX);
  assert.equal(JSON.stringify([ok, found]).includes(env.BROWSERBASE_API_KEY), false);
  assert.equal(fake.only("sessions.create").length, 0, "fetch and search never open a session");
});

test("fetch and search results carry usage: list price, proxied fetch at its own, the host's plan when it has one", async () => {
  const { provider } = rig();
  assert.deepEqual([(await provider.fetch({ url: "https://example.com", format: "markdown", proxies: false })).usage.usage.cost.total, (await provider.fetch({ url: "https://example.com", format: "markdown", proxies: true })).usage.usage.cost.total, (await provider.search({ query: "q", n: 3 })).usage.usage.cost.total], [0.001, 0.004, 0.007]);
  const planned = rig({}, proxied(), { prices: { searchUsd: 0.01 } });
  const found = await planned.provider.search({ query: "q", n: 3 });
  assert.deepEqual([found.usage.usage.cost.total, found.usage.state], [0.01, "priced"]);
});

test("the real SDK on the provider's direct fetch uploads a streamed multipart file (userland undici needs duplex)", async () => {
  // Only requests that carry this test's own secret count: a stray prober on an ephemeral port never sends it.
  const secret = `upload-${Math.random().toString(36).slice(2)}`;
  const mine = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.headers["x-upload-test"] === secret) mine.push({ type: req.headers["content-type"], body: Buffer.concat(chunks).toString("latin1") });
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: "ext_live_shape" }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    // A foreign request reaches the server first, as a stray prober's does; the assertions below must not see it.
    await (await fetch(`${base}/probe`, { headers: { "user-agent": "Go-http-client/1.1" } })).text();
    const { default: Browserbase } = await import("@browserbasehq/sdk");
    const sdk = new Browserbase({ apiKey: "not-a-secret", baseURL: base, fetch: await directFetch(), maxRetries: 0, defaultHeaders: { "x-upload-test": secret } });
    const made = await sdk.extensions.create({ file: createReadStream(new URL("./fixtures/fake-browserbase.mjs", import.meta.url)) });
    assert.ok(made.id === "ext_live_shape");
    assert.equal(mine.length, 1, "exactly the SDK's own upload");
    assert.ok(/^multipart\/form-data/.test(mine[0].type), "the upload is multipart");
    assert.ok(mine[0].body.includes("export function fakeBrowserbase"), "the streamed file's bytes arrived");
  } finally { server.close(); await closeDirectFetch(); }
});

test("direct calls share one agent: two fetchers reuse one connection, and the agent can be closed and made again", async () => {
  // Only connections that carried this test's own request count: a stray prober opens connections that never send the
  // marker.
  const secret = `direct-fetch-${Math.random().toString(36).slice(2)}`;
  const mine = new Set();
  const server = http.createServer((req, res) => { if (req.headers["x-direct-fetch-test"] === secret) mine.add(req.socket); res.end("ok"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const get = async () => (await (await directFetch())(`http://127.0.0.1:${server.address().port}/`, { headers: { "x-direct-fetch-test": secret } })).text();
  try {
    await get();
    await new Promise((r) => setTimeout(r, 100)); // the pool takes the connection back just after the body is read
    await get();
    assert.equal(mine.size, 1, "one agent, one kept-alive connection");
    await closeDirectFetch();
    await get();
    assert.equal(mine.size, 2, "after a close the next call builds a new agent");
  } finally { await closeDirectFetch(); server.close(); }
});

test("release by a fresh provider (custody builds one) still closes the attach socket and drops the dial binding", async () => {
  const sockets = [];
  const fake = fakeBrowserbase();
  const env = proxied();
  const make = () => browserbaseProvider({ env, client: fake.sdk, sleep: async () => {}, downloadBehavior: async () => { const s = { open: true, close() { this.open = false; } }; sockets.push(s); return s; } });
  const attacher = make();
  const ref = await attacher.create(spec({ tag: "ar-fresh-1-1" }), new AbortController().signal);
  const url = (await attacher.attach(ref)).sdkCdpUrl;
  assert.ok(connectDialUrl(url) !== url, "the dial target is bound while attached");
  await make().release(ref);
  assert.deepEqual(sockets.map((s) => s.open), [false], "the socket the attacher opened is closed by another provider's release");
  assert.ok(connectDialUrl(url) === url, "and the binding is gone");
});

test("findByTag throws when either status query fails: a partial set would leave a session unreleased", async () => {
  const { fake, provider } = rig();
  await provider.create(spec({ tag: "ar-partial-1-1" }), new AbortController().signal);
  const list = fake.sdk.sessions.list;
  for (const failing of ["RUNNING", "PENDING"]) {
    fake.sdk.sessions.list = async (query, options) => { if (query.status === failing) throw Object.assign(new Error(`${failing} list 504`), { status: 504 }); return list(query, options); };
    await assert.rejects(provider.findByTag("ar-partial-1-1"), new RegExp(`${failing} list 504`));
  }
  fake.sdk.sessions.list = list;
  assert.equal((await provider.findByTag("ar-partial-1-1")).length, 1);
});

test("a cancelled fetch or search rejects at once; the late result is dropped", async () => {
  let finish;
  const { fake, provider } = rig();
  fake.sdk.fetchAPI.create = () => new Promise((resolve) => { finish = () => resolve({ id: "f", statusCode: 200, contentType: "text/html", encoding: "utf-8", headers: {}, content: "late" }); });
  fake.sdk.search.web = () => new Promise(() => {});
  for (const call of [(signal) => provider.fetch({ url: "https://slow.test", format: "markdown", proxies: false }, signal), (signal) => provider.search({ query: "slow", n: 3 }, signal)]) {
    const controller = new AbortController();
    const pending = call(controller.signal);
    setTimeout(() => controller.abort(new Error("job cancelled")), 20);
    await assert.rejects(pending, /job cancelled/);
  }
  finish();
  const already = new AbortController(); already.abort(new Error("before"));
  await assert.rejects(provider.fetch({ url: "https://x.test", format: "raw", proxies: false }, already.signal), /before/);
});

test("concurrent attaches share one download socket, and a release during the opening closes it", async () => {
  const sockets = [];
  let open;
  const gate = new Promise((r) => { open = r; });
  const { provider } = rig({}, proxied(), { downloadBehavior: async () => { await gate; const s = { open: true, close() { this.open = false; } }; sockets.push(s); return s; } });
  const ref = await provider.create(spec({ tag: "ar-conc-1-1" }), new AbortController().signal);
  const attaches = [provider.attach(ref), provider.attach(ref), provider.attach(ref)];
  await new Promise((r) => setTimeout(r, 20));
  const releasing = provider.release(ref);
  open();
  await Promise.all([...attaches, releasing]);
  assert.equal(sockets.length, 1, "three attaches opened one socket");
  assert.deepEqual(sockets.map((s) => s.open), [false], "and the release that overlapped its opening closed it");
});

test("a session already attached through one proxy is refused a second one, never switched", async () => {
  const fake = fakeBrowserbase();
  const make = (base) => browserbaseProvider({ env: { BROWSERBASE_API_KEY: SHARED_KEY, BROWSERBASE_BASE_URL: "https://proxy.example", BROWSERBASE_CONNECT_BASE_URL: base }, client: fake.sdk, sleep: async () => {}, downloadBehavior: async () => undefined });
  const a = make("wss://proxy-a.example/ws");
  const b = make("wss://proxy-b.example/ws");
  const ref = await a.create(spec({ tag: "ar-same-1-1" }), new AbortController().signal);
  const url = (await a.attach(ref)).sdkCdpUrl;
  await assert.rejects(b.attach(ref), /another credential proxy/);
  assert.ok(connectDialUrl(url).startsWith("wss://proxy-a.example/ws/"), "the first provider's sockets still dial its own proxy");
  await a.release(ref);
});

test("the real SDK client sends Fetch and Search exactly as Stagehand's facade does, on the provider's own agent", async () => {
  // The API key is the per-test secret: only requests carrying it are the SDK's, never a stray prober's.
  const key = `real-sdk-key-${Math.random().toString(36).slice(2)}`;
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.headers["x-bb-api-key"] === key) requests.push({ method: req.method, url: req.url, key: req.headers["x-bb-api-key"], type: req.headers["content-type"], body: JSON.parse(Buffer.concat(chunks).toString() || "null") });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/v1/fetch"
        ? { id: "f1", statusCode: 200, contentType: "text/markdown", encoding: "utf-8", headers: {}, content: "# real shape" }
        : { requestId: "r1", query: "q", results: [{ id: "1", url: "https://example.com/a", title: "A", author: "Ada", publishedDate: "2026-01-02" }, { id: "2", title: "no url" }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  // A trap: the global dispatcher throws if anything dispatches through it, since the provider's client must ride its
  // own agent (a foreign undici owning the global once failed every SDK call).
  const before = undici.getGlobalDispatcher();
  const foreign = { dispatch() { throw new Error("the foreign global dispatcher must not serve the Browserbase SDK"); }, close: async () => {}, destroy: async () => {} };
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    // A foreign request reaches the server first, as a stray prober's does; the assertions below must not see it.
    await (await fetch(`${base}/probe`, { headers: { "user-agent": "Go-http-client/1.1" } })).text();
    undici.setGlobalDispatcher(foreign);
    const provider = browserbaseProvider({ env: { BROWSERBASE_API_KEY: key, BROWSERBASE_BASE_URL: base } });
    const page = await provider.fetch({ url: "https://example.com/p", format: "markdown", proxies: true });
    assert.deepEqual({ ...page, usage: undefined }, { usage: undefined, finalUrl: null, statusCode: 200, contentType: "text/markdown", content: "# real shape" });
    const found = await provider.search({ query: "q".repeat(SEARCH_QUERY_MAX + 5), n: 99 });
    assert.deepEqual(found.results, [{ url: "https://example.com/a", title: "A", author: "Ada", published: "2026-01-02" }], "a hit with no URL is dropped");
    assert.equal(requests.length, 2, "exactly the SDK's own two calls, both served with a throwing global dispatcher installed");
    const [fetched, searched] = requests;
    assert.deepEqual([fetched.method, fetched.url, fetched.type], ["POST", "/v1/fetch", "application/json"]);
    assert.ok(fetched.key === key, "the API key rides the header the SDK sends");
    assert.deepEqual(fetched.body, { url: "https://example.com/p", proxies: true, allowRedirects: true, format: "markdown" }, "Stagehand's facade passes these four to fetchAPI.create");
    assert.deepEqual([searched.method, searched.url], ["POST", "/v1/search"]);
    assert.ok(searched.key === key);
    assert.deepEqual(searched.body, { query: "q".repeat(SEARCH_QUERY_MAX), numResults: SEARCH_RESULTS_MAX }, "clamped to the facade's limits");
  } finally { undici.setGlobalDispatcher(before); server.close(); await closeDirectFetch(); }
});

test("the shared CDP call names the host in a failed open and refuses an unanswered command", async () => {
  await assert.rejects(setDownloadBehavior("ws://127.0.0.1:9/x?signingKey=SECRETKEY"), (error) => /the CDP socket to 127\.0\.0\.1:9 failed/.test(error.message) && !error.message.includes("SECRETKEY"));
  const silent = http.createServer();
  const open = new Set();
  silent.on("connection", (c) => { open.add(c); c.on("close", () => open.delete(c)); });
  silent.on("upgrade", (req, socket) => { /* accepts the connection and never answers the upgrade */ });
  await new Promise((r) => silent.listen(0, "127.0.0.1", r));
  try { await assert.rejects(setDownloadBehavior(`ws://127.0.0.1:${silent.address().port}/x`, { timeoutMs: 150 }), /did not answer Browser\.setDownloadBehavior/); }
  finally { for (const c of open) c.destroy(); silent.close(); }
});

const PROFILE = { name: "work", save: true };
const memoryStore = (initial = {}) => { const rows = new Map(Object.entries(initial)); let tail = Promise.resolve(); return { rows, resolve: (key, make) => (tail = tail.then(async () => { if (!rows.has(key)) rows.set(key, await make()); return rows.get(key); }, async () => { if (!rows.has(key)) rows.set(key, await make()); return rows.get(key); })) }; };
const direct = () => ({ BROWSERBASE_API_KEY: `not-a-secret-direct-${(keySeq += 1)}`, BROWSERBASE_PROJECT_ID: "proj_1" });

test("a profile is a Browserbase context made on first use, remembered by name, and reused with persist following save", async () => {
  const profiles = memoryStore();
  const env = proxied();
  const first = rig({}, env, { profiles });
  assert.equal(first.provider.caps.profiles, true);
  await first.provider.create(spec({ profile: PROFILE }), new AbortController().signal);
  assert.equal(first.fake.only("contexts.create").length, 1);
  assert.deepEqual(first.fake.only("contexts.create")[0].body, {}, "behind the credential proxy the project is never named");
  assert.equal(first.fake.only("contexts.create")[0].options.maxRetries, 0, "a context create the SDK could retry would leave a second, unreachable context");
  assert.deepEqual(first.fake.only("sessions.create")[0].body.browserSettings.context, { id: "ctx_1", persist: true });
  assert.equal([...profiles.rows.values()].join(), "ctx_1", "the name maps to the context id");
  assert.equal(JSON.stringify([...profiles.rows.keys()]).includes(env.BROWSERBASE_API_KEY), false, "and the store's key never holds the API key");

  const second = rig({}, env, { profiles });
  await second.provider.create(spec({ tag: "ar-run1-2-1", profile: { name: "work", save: false } }), new AbortController().signal);
  assert.equal(second.fake.only("contexts.create").length, 0, "the saved name finds its context");
  assert.deepEqual(second.fake.only("sessions.create")[0].body.browserSettings.context, { id: "ctx_1", persist: false });

  const plain = rig({}, proxied(), { profiles });
  await plain.provider.create(spec(), new AbortController().signal);
  assert.equal("context" in plain.fake.only("sessions.create")[0].body.browserSettings, false);

  const keyed = rig({}, direct(), { profiles: memoryStore() });
  await keyed.provider.create(spec({ profile: PROFILE }), new AbortController().signal);
  assert.deepEqual(keyed.fake.only("contexts.create")[0].body, { projectId: "proj_1" }, "a direct key names its project");
});

test("two accounts that both call a profile work get two contexts; a context that cannot be made fails the create with no session and is tried again", async () => {
  const profiles = memoryStore();
  const a = rig({}, proxied(), { profiles });
  const b = rig({}, proxied(), { profiles });
  await a.provider.create(spec({ profile: PROFILE }), new AbortController().signal);
  await b.provider.create(spec({ tag: "ar-run1-2-1", profile: PROFILE }), new AbortController().signal);
  assert.equal(profiles.rows.size, 2);

  const broken = rig({ contextError: Object.assign(new Error("502"), { status: 502 }) }, proxied(), { profiles: memoryStore() });
  await assert.rejects(broken.provider.create(spec({ profile: PROFILE }), new AbortController().signal), /502/);
  assert.equal(broken.fake.only("sessions.create").length, 0);
  broken.fake.sdk.contexts.create = async () => ({ id: "ctx_late" });
  await broken.provider.create(spec({ profile: PROFILE }), new AbortController().signal);
  assert.equal(broken.fake.only("sessions.create")[0].body.browserSettings.context.id, "ctx_late");
});

test("one session at a time saves to a profile, and a saving session's release waits for Browserbase to write the context back", async () => {
  const slept = [];
  const profiles = memoryStore();
  const { provider } = rig({}, proxied(), { profiles, sleep: async (ms) => { slept.push(ms); }, profileSettleMs: 4_000 });
  const first = await provider.create(spec({ profile: PROFILE }), new AbortController().signal);
  await assert.rejects(provider.create(spec({ tag: "ar-run1-2-1", metadata: { run: "run-2", label: "other" }, profile: PROFILE }), new AbortController().signal), (error) => error.failure?.code === "refused" && /one session at a time/.test(error.failure.message));
  const reader = await provider.create(spec({ tag: "ar-run1-3-1", profile: { name: "work", save: false } }), new AbortController().signal);
  await provider.release(reader);
  assert.deepEqual(slept, [], "a session that does not save leaves nothing to wait for");
  await provider.release(first);
  assert.ok(slept.includes(4_000), "the saving session's release waited out the write-back");
  assert.ok((await provider.create(spec({ tag: "ar-run1-4-1", profile: PROFILE }), new AbortController().signal)).id);
});

test("the default profile store is a file: first use is one create across processes, other names survive, and a file that is not ours, unreadable or malformed is never overwritten", async (t) => {
  const dir = await scratch(t, "bb-profiles-");
  const file = `${dir}/profiles.json`;
  let made = 0;
  const make = (id) => async () => { made += 1; await new Promise((r) => setTimeout(r, 120)); return id; };
  const [x, y, z] = await Promise.all([fileProfileStore(file).resolve("acct|one", make("ctx_a")), fileProfileStore(file).resolve("acct|one", make("ctx_b")), fileProfileStore(file).resolve("acct|two", make("ctx_c"))]);
  assert.ok(x === y && (x === "ctx_a" || x === "ctx_b"), "two first uses of one name get one and the same context");
  assert.deepEqual([z, made], ["ctx_c", 2], "and made one context for it, one for the other name");
  assert.match(await readFileText(file), new RegExp(`${x}[\\s\\S]*ctx_c|ctx_c[\\s\\S]*${x}`), "and both names are kept");
  assert.equal(await fileProfileStore(file).resolve("acct|one", make("ctx_never")), x);
  const bad = { "not json": "not json", "an array of contexts": '{"schema":"pi-browser.profiles.v1","contexts":[]}', "a non-string id": '{"schema":"pi-browser.profiles.v1","contexts":{"k":7}}', "an empty id": '{"schema":"pi-browser.profiles.v1","contexts":{"k":""}}', "another schema": '{"schema":"other","contexts":{}}' };
  for (const [what, text] of Object.entries(bad)) {
    const odd = `${dir}/odd.json`;
    await writeFileText(odd, text);
    await assert.rejects(fileProfileStore(odd).resolve("k2", make("ctx_x")), /profiles file/, what);
    assert.equal(await readFileText(odd), text, `${what}: the file is left as it is`);
  }
  await mkdir(`${dir}/dir.json`);
  await assert.rejects(fileProfileStore(`${dir}/dir.json`).resolve("k", make("ctx_y")), /EISDIR|illegal operation/, "a read error is an error, never an empty map");
});

test("a cancelled first use fails only its own caller; the next caller makes the context itself", async () => {
  const profiles = memoryStore();
  const { fake, provider } = rig({ contextDelayMs: 150 }, proxied(), { profiles });
  const cancelled = new AbortController();
  const first = provider.create(spec({ profile: { name: "work", save: false } }), cancelled.signal);
  const second = provider.create(spec({ tag: "ar-run1-2-1", profile: { name: "work", save: false } }), new AbortController().signal);
  cancelled.abort();
  await assert.rejects(first);
  assert.ok((await second).id, "the other caller was not failed by the first one's cancellation");
  assert.ok(fake.only("contexts.create").length >= 1);
});

test("a relaunch on a saving profile waits for the old session's release instead of being refused; a different owner is refused at once", async () => {
  const { provider } = rig({}, proxied(), { profiles: memoryStore(), sleep: async () => {}, profileSettleMs: 0 });
  const mine = { metadata: { run: "run-1", label: "node-a" }, profile: PROFILE };
  const old = await provider.create(spec({ ...mine }), new AbortController().signal);
  await assert.rejects(provider.create(spec({ tag: "ar-run1-9-1", metadata: { run: "run-2", label: "node-a" }, profile: PROFILE }), new AbortController().signal), (error) => error.failure?.code === "refused");
  const next = provider.create(spec({ tag: "ar-run1-2-1", ...mine }), new AbortController().signal);
  setTimeout(() => { void provider.release(old); }, 250);
  assert.ok((await next).id, "the replacement started once the old session was released");
});

test("a saving session that ended on its own, or whose create answer was lost and found nothing, no longer holds the profile", async () => {
  const { fake, provider } = rig({}, proxied(), { profiles: memoryStore(), sleep: async () => {}, profileSettleMs: 0 });
  const one = await provider.create(spec({ profile: PROFILE }), new AbortController().signal);
  fake.sessions.get(one.id).status = "COMPLETED";
  const two = await provider.create(spec({ tag: "ar-run1-2-1", metadata: { run: "run-2", label: "x" }, profile: PROFILE }), new AbortController().signal);
  assert.ok(two.id, "an ended browser's claim is taken over");

  const lost = rig({ createError: Object.assign(new Error("lost"), { status: 502 }) }, proxied(), { profiles: memoryStore(), sleep: async () => {}, profileSettleMs: 0 });
  await assert.rejects(lost.provider.create(spec({ tag: "ar-run1-3-1", profile: PROFILE }), new AbortController().signal), /lost/);
  await assert.rejects(lost.provider.create(spec({ tag: "ar-run1-4-1", metadata: { run: "run-3", label: "x" }, profile: PROFILE }), new AbortController().signal), (error) => error.failure?.code === "refused", "a create whose answer may have been lost keeps its claim until custody has looked for it");
  assert.deepEqual(await lost.provider.findByTag("ar-run1-3-1"), []);
  lost.fake.sdk.sessions.create = async (body) => ({ id: "sess_late", connectUrl: "wss://connect.usw2.browserbase.com/sess_late?signingKey=S" });
  assert.ok((await lost.provider.create(spec({ tag: "ar-run1-5-1", metadata: { run: "run-3", label: "x" }, profile: PROFILE }), new AbortController().signal)).id, "and it is free once findByTag found no browser");
});

const readFileText = (file) => readFile(file, "utf8");

test("a saver that takes over from a session which ended on its own waits for the write-back first, and a cancelled one stops waiting", async () => {
  const events = [];
  const { fake, provider } = rig({}, proxied(), { profiles: memoryStore(), sleep: async (ms) => { events.push(`sleep ${ms}`); }, profileSettleMs: 4_000 });
  const real = fake.sdk.sessions.create;
  fake.sdk.sessions.create = async (...args) => { events.push("create"); return real(...args); };
  const one = await provider.create(spec({ profile: PROFILE }), new AbortController().signal);
  fake.sessions.get(one.id).status = "COMPLETED";
  events.length = 0;
  await provider.create(spec({ tag: "ar-run1-2-1", metadata: { run: "run-2", label: "x" }, profile: PROFILE }), new AbortController().signal);
  assert.deepEqual(events, ["sleep 4000", "create"], "the settle wait comes before the replacement is created");

  const gate = Promise.withResolvers();
  const held = rig({}, proxied(), { profiles: memoryStore(), sleep: () => gate.promise, profileSettleMs: 4_000 });
  const ended = await held.provider.create(spec({ tag: "ar-run1-5-1", profile: { name: "slow", save: true } }), new AbortController().signal);
  held.fake.sessions.get(ended.id).status = "COMPLETED";
  const cancel = new AbortController();
  const started = Date.now();
  const waiting = held.provider.create(spec({ tag: "ar-run1-6-1", metadata: { run: "run-6", label: "w" }, profile: { name: "slow", save: true } }), cancel.signal);
  setTimeout(() => cancel.abort(), 200);
  await assert.rejects(waiting);
  assert.ok(Date.now() - started < 2_000, "cancelling ends the wait for the write-back");
  assert.equal(held.fake.only("sessions.create").length, 1, "and no replacement was created");
  gate.resolve();
});

test("a session in the middle of its release's write-back wait still holds its profile", async () => {
  let enter;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = Promise.withResolvers();
  const { fake, provider } = rig({}, proxied(), { profiles: memoryStore(), sleep: (ms) => { if (ms === 4_000) { enter(); return gate.promise; } return Promise.resolve(); }, profileSettleMs: 4_000 });
  const ref = await provider.create(spec({ profile: PROFILE }), new AbortController().signal);
  const release = provider.release(ref);
  await entered;
  assert.equal(fake.sessions.get(ref.id).status, "COMPLETED", "Browserbase already reports the session stopped");
  const asked = Date.now();
  await assert.rejects(provider.create(spec({ tag: "ar-run1-2-1", metadata: { run: "run-2", label: "x" }, profile: PROFILE }), new AbortController().signal), (error) => error.failure?.code === "refused", "yet it is the write-back wait that keeps the profile held");
  assert.ok(Date.now() - asked < 1_500, `refused at once, as a running holder is (${Date.now() - asked} ms), not after waiting out the write-back`);
  gate.resolve();
  await release;
  assert.ok((await provider.create(spec({ tag: "ar-run1-3-1", metadata: { run: "run-2", label: "x" }, profile: PROFILE }), new AbortController().signal)).id, "and it is free once the wait is over");
});

test("the profiles file's lock is never outlived by the context call it protects: a make slower than its limit is cut, writes nothing and frees the lock", async (t) => {
  const dir = await scratch(t, "bb-profiles-limit-");
  const file = `${dir}/profiles.json`;
  const store = fileProfileStore(file, { makeLimitMs: 150 });
  const started = Date.now();
  let seenAbort = false;
  // The limit is an unref'd timer, so the test holds the loop for it.
  const hold = setInterval(() => {}, 50);
  t.after(() => clearInterval(hold));
  await assert.rejects(store.resolve("acct|profile:work", (signal) => new Promise((_, reject) => { signal.addEventListener("abort", () => { seenAbort = true; reject(new Error("stopped")); }); })), /took longer than 150 ms/);
  assert.ok(Date.now() - started < 5_000);
  assert.equal(seenAbort, true, "the call itself is told to stop");
  await assert.rejects(readFileText(file), { code: "ENOENT" }, "nothing was written");
  await assert.rejects(readFileText(`${file}.lock`), { code: "ENOENT" }, "the lock is free");
  assert.equal(await store.resolve("acct|profile:work", async () => "ctx_ok"), "ctx_ok", "the next caller makes it");
});
