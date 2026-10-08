// The browserbase provider against a scripted Browserbase SDK: the create body, at-most-once create, tag recovery,
// the dial rewrite, release with confirmation, status facts, fetch and search.
import assert from "node:assert/strict";
import http from "node:http";
import { createReadStream } from "node:fs";
import test from "node:test";
import * as undici from "undici";
import { closeDirectFetch, directFetch } from "../dist/providers/browserbase-net.js";
import { applyBrowserbaseNoProxy, browserbaseGeolocation, browserbaseNoProxyHosts, browserbaseProvider, setDownloadBehavior, proxiesField, rewriteConnectUrl, SEARCH_QUERY_MAX, SEARCH_RESULTS_MAX } from "../dist/providers/browserbase.js";
import { bindConnectDial, installWebSocketWrapper, connectDialUrl, unbindConnectDial } from "../dist/providers/browserbase-net.js";
import { fakeBrowserbase } from "./fixtures/fake-browserbase.mjs";

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
  const direct = rig({}, { BROWSERBASE_API_KEY: "bb_live_direct", BROWSERBASE_PROJECT_ID: "proj_123" });
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
  // The real wrapper on a real socket: a bound Browserbase URL reaches the "proxy" (a local server) at the prefixed path.
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
  // Only requests that carry this test's own secret count: anything else that reaches an ephemeral port (another program on a
  // busy host scans them) sends no such header and must never be taken for the upload.
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
  // Only connections that carried this test's own request count: anything else probing the port (another program on a busy host
  // scans ephemeral ports) opens connections of its own that never send the marker.
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
  const make = (base) => browserbaseProvider({ env: { BROWSERBASE_API_KEY: "shared-account-key", BROWSERBASE_BASE_URL: "https://proxy.example", BROWSERBASE_CONNECT_BASE_URL: base }, client: fake.sdk, sleep: async () => {}, downloadBehavior: async () => undefined });
  const a = make("wss://proxy-a.example/ws");
  const b = make("wss://proxy-b.example/ws");
  const ref = await a.create(spec({ tag: "ar-same-1-1" }), new AbortController().signal);
  const url = (await a.attach(ref)).sdkCdpUrl;
  await assert.rejects(b.attach(ref), /another credential proxy/);
  assert.ok(connectDialUrl(url).startsWith("wss://proxy-a.example/ws/"), "the first provider's sockets still dial its own proxy");
  await a.release(ref);
});

test("the real SDK client sends Fetch and Search exactly as Stagehand's facade does, on the provider's own agent", async () => {
  // The provider builds its own client, so the API key it sends is the per-test secret: only requests carrying it are the SDK's
  // own, and anything else that reaches an ephemeral port (another program on a busy host scans them) is never taken for one.
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
  // A foreign copy of undici (pi's) owning the process-global dispatcher is what once made every SDK call on the default fetch
  // fail as "Connection error" (UND_ERR_INVALID_ARG). The provider's client rides its own agent, so it must never consult the
  // global: this one throws if anything dispatches through it.
  const before = undici.getGlobalDispatcher();
  const foreign = { dispatch() { throw new Error("the foreign global dispatcher must not serve the Browserbase SDK"); }, close: async () => {}, destroy: async () => {} };
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    // A foreign request reaches the server first, as a stray prober's does; the assertions below must not see it.
    await (await fetch(`${base}/probe`, { headers: { "user-agent": "Go-http-client/1.1" } })).text();
    undici.setGlobalDispatcher(foreign);
    // No `client` option: the provider builds the real SDK on its direct fetch, pointed at the local server.
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
  silent.on("upgrade", (req, socket) => { /* accepts the connection and never answers the upgrade */ });
  await new Promise((r) => silent.listen(0, "127.0.0.1", r));
  try { await assert.rejects(setDownloadBehavior(`ws://127.0.0.1:${silent.address().port}/x`, { timeoutMs: 150 }), /did not answer Browser\.setDownloadBehavior/); }
  finally { silent.closeAllConnections?.(); silent.close(); }
});
