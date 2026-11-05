// The owner watches a run's browser live (browser-live.ts): the run's process serves pi-browser's own viewer, read-only, on
// a loopback port of its own and hands it over in one 0600 file in the run's directory; the server gives the viewer's
// link to the owner's signed-in page alone, and proxies its page and its WebSocket, from this server's own origin alone,
// under a CSP framed by 'self' on that route only. A frame goes from the browser to the viewer through the proxy; input
// never reaches the browser; a second viewer is refused; the token is in no record, row, view, file list or log; and it
// dies with its session. On fakes: no network, no key.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { FRAME } from "./fixtures/faux-browser.mjs";
import { connect } from "./fixtures/ws-client.mjs";
import { builtConsole, call, cookieOf, follow, scratch, serve, withEnv } from "./support.mjs";

const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
const BROWSE_ASK = new URL("./fixtures/faux-browse-ask.mjs", import.meta.url).pathname;
const KEYS = ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "KERNEL_API_KEY", "FAUX_BROWSER_LOG"];
const json = { "content-type": "application/json" };
/** A test password, no real one. */
const PASSWORD = ["not-a-secret", "owner"].join("-");
const until = async (check, ms = 15_000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (await check()) return true; return false; };
/** Every file under `dir`, path and bytes. */
const filesUnder = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [[path, readFileSync(path)]] : [];
});

/** A signed-in owner's server with the fake browser, and a run of `watch` (browse, then ask) waiting with its session open. */
async function watched(t, options = {}) {
  withEnv(t, { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project", FAUX_BROWSER_LOG: join(await scratch(t), "browser.jsonl") }, KEYS);
  const server = await serve(t, { accounts: true, openSetup: true, console: await builtConsole(t), fauxBrowser: FAUX_BROWSER, faux: BROWSE_ASK, ...options });
  const origin = `http://127.0.0.1:${server.port}`;
  const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: PASSWORD } });
  assert.equal(made.status, 201, made.text);
  const cookie = cookieOf(made);
  assert.equal((await server.api("POST", "/agents", { definition: { id: "watch", name: "watch", instructions: "Browse, then ask.", tools: ["browser", "ask_person"] } })).status, 201);
  const started = await server.api("POST", "/agents/watch/runs", { input: { content: "Browse the example page." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  const { after } = await follow(server.api, runId, ["input_required"]);
  const file = join(server.data, "runs", runId, "browser-live.json");
  assert.ok(await until(() => stat(file).then(() => true, () => false)), "the run's process handed its viewer over");
  return { server, origin, cookie, runId, file, after };
}

const browserOf = (w, headers) => call(w.server.port, { path: `/v2/runs/${w.runId}/browser`, headers });
/** A WebSocket to `path`: from the server's own origin (null: none) with the owner's cookie (null: none), unless told. */
const liveWs = (w, path, { origin = w.origin, cookie = w.cookie, headers = {} } = {}) => connect(`ws://127.0.0.1:${w.server.port}${path}`, { origin: origin ?? undefined, headers: { ...(cookie ? { cookie } : {}), ...headers } });

test("the owner's signed-in page alone gets the viewer's link; the page is framed by 'self' on that route alone; a frame reaches the viewer through the proxy, its input never reaches the browser, and a second viewer is refused", { timeout: 120_000 }, async (t) => {
  const w = await watched(t);
  const handed = JSON.parse(readFileSync(w.file, "utf8"));
  assert.equal(statSync(w.file).mode & 0o777, 0o600, "the hand-over is the server's user's alone");
  assert.deepEqual(Object.keys(handed).sort(), ["id", "port", "tag", "token"]);
  assert.ok(!w.file.includes("/work/"), "outside the run's work/");

  // Owner-only: no credential 401, the server's token 403, the owner's session 200.
  assert.equal((await browserOf(w, {})).status, 401);
  assert.equal((await browserOf(w, { authorization: `Bearer ${w.server.token}` })).status, 403, "a token never opens the browser");
  const answer = await browserOf(w, { cookie: w.cookie });
  assert.equal(answer.status, 200, answer.text);
  assert.deepEqual(answer.json, { state: "live", viewer: `/v2/runs/${w.runId}/browser/live/v/${handed.id}#t=${handed.token}` });
  assert.equal(answer.headers["cache-control"], "no-store");

  // The viewer's page: the owner's session, under this route's own CSP; the console keeps frame-ancestors 'none'.
  const pagePath = `/v2/runs/${w.runId}/browser/live/v/${handed.id}`;
  assert.equal((await call(w.server.port, { path: pagePath })).status, 401);
  assert.equal((await call(w.server.port, { path: pagePath, headers: { authorization: `Bearer ${w.server.token}` } })).status, 403);
  const viewerPage = await call(w.server.port, { path: pagePath, headers: { cookie: w.cookie } });
  assert.equal(viewerPage.status, 200, viewerPage.text);
  assert.match(viewerPage.text, /<canvas id="screen"/);
  assert.match(viewerPage.headers["content-security-policy"], /frame-ancestors 'self'/);
  assert.match(viewerPage.headers["content-security-policy"], /connect-src 'self';/, "the viewer connects to this server alone");
  assert.equal((await call(w.server.port, { path: `/v2/runs/${w.runId}/browser/live/viewer.js`, headers: { cookie: w.cookie } })).status, 200);
  assert.equal((await call(w.server.port, { path: `/v2/runs/${w.runId}/browser/live/v/AAAAAAAAAAAAAAAAAAAAAA`, headers: { cookie: w.cookie } })).status, 404, "another viewer's path is not proxied");
  assert.match((await call(w.server.port, { path: "/", headers: { cookie: w.cookie } })).headers["content-security-policy"], /frame-ancestors 'none'/, "the console is never framed");

  // The WebSocket: this server's own origin and the owner's session, or nothing.
  const wsPath = `${pagePath}/ws`;
  assert.equal((await liveWs(w, wsPath, { origin: "http://evil.example" })).status, 403, "another origin");
  assert.equal((await liveWs(w, wsPath, { origin: null })).status, 403, "no origin");
  assert.equal((await liveWs(w, wsPath, { cookie: null })).status, 401, "no session");
  assert.equal((await liveWs(w, wsPath, { cookie: null, headers: { authorization: `Bearer ${w.server.token}` } })).status, 401, "a token is no session");
  assert.equal((await liveWs(w, `/v2/runs/${w.runId}/browser/live/v/AAAAAAAAAAAAAAAAAAAAAA/ws`)).status, 404);
  assert.equal((await liveWs(w, "/v2/runs/whatever")).status, 404, "no other upgrade is taken");
  const first = await liveWs(w, wsPath);
  assert.equal(first.status, 101);
  first.ws.sendJson({ type: "hello", token: handed.token });
  assert.deepEqual(JSON.parse((await first.ws.next(5_000)).data), { type: "ready", drive: "idle", readOnly: true });
  const { item: frame } = await first.ws.until((m) => m.type === "binary", 10_000);
  assert.ok(frame, "a screencast frame arrived through the proxy");
  assert.deepEqual([frame.data.readUInt16BE(0), frame.data.readUInt16BE(2)], [FRAME.w, FRAME.h]);
  assert.deepEqual(frame.data.subarray(4), FRAME.bytes, "the browser's frame, byte for byte");
  first.ws.sendJson({ type: "text", text: "typed into a read-only view" });
  const { item: held } = await first.ws.until((m) => m.type === "text" && JSON.parse(m.data).type === "held", 5_000);
  assert.deepEqual(JSON.parse(held.data), { type: "held", reason: "read_only" }, "input is dropped by the run, never sent");
  const second = await liveWs(w, wsPath);
  assert.equal(second.status, 101);
  second.ws.sendJson({ type: "hello", token: handed.token });
  assert.deepEqual(JSON.parse((await second.ws.next(5_000)).data), { type: "refused", reason: "viewer_in_use" });
  first.ws.destroy();
});

test("the viewer's token and its file are in no record, row, view, file list, home or log; it dies with the session: the route says none and the old link is refused", { timeout: 120_000 }, async (t) => {
  const w = await watched(t);
  const handed = JSON.parse(readFileSync(w.file, "utf8"));
  const runDir = join(w.server.data, "runs", w.runId);
  const said = [];
  for (const path of [`/runs/${w.runId}`, `/runs/${w.runId}/timeline`, "/runs", `/agents/watch/runs`, `/runs/${w.runId}/files`, "/agents/watch/home/files", "/capabilities", "/stats"]) {
    const res = await w.server.api("GET", path);
    said.push(path);
    assert.ok(!JSON.stringify(res.body).includes(handed.token) && !JSON.stringify(res.body).includes(handed.id), `${path} holds no token and no viewer id`);
  }
  for (const path of [`/runs/${w.runId}/files/..%2Fbrowser-live.json`, `/runs/${w.runId}/files/../browser-live.json`, `/runs/${w.runId}/files/browser-live.json`]) {
    const res = await w.server.api("GET", path);
    assert.ok(res.status >= 400 && !JSON.stringify(res.body).includes(handed.token), `${path}: ${res.status}`);
  }
  // Every file the server and the run keep, the run's store and its process log among them: the token is in the hand-over alone.
  const holding = filesUnder(w.server.data).filter(([path, bytes]) => bytes.includes(handed.token)).map(([path]) => path);
  assert.deepEqual(holding, [w.file]);
  assert.equal((await w.server.api("POST", `/runs/${w.runId}/archive`)).status, 200);
  assert.ok(!JSON.stringify((await w.server.api("GET", `/runs/${w.runId}`)).body).includes(handed.token), "archived, the same");
  assert.equal((await w.server.api("POST", `/runs/${w.runId}/unarchive`)).status, 200);

  // The viewer open as the session ends: it is told, and the token dies with it.
  const wsPath = `/v2/runs/${w.runId}/browser/live/v/${handed.id}/ws`;
  const open = await liveWs(w, wsPath);
  open.ws.sendJson({ type: "hello", token: handed.token });
  assert.equal(JSON.parse((await open.ws.next(5_000)).data).type, "ready");
  assert.equal((await w.server.api("POST", `/runs/${w.runId}/messages`, { content: "Yes, that is all." })).status, 202);
  await follow(w.server.api, w.runId, ["completed"], { after: w.after });
  const { item: ended } = await open.ws.until((m) => m.type === "close" || (m.type === "text" && JSON.parse(m.data).type === "ended"), 15_000);
  assert.ok(ended, "the open viewer was ended");
  assert.ok(await until(() => stat(w.file).then(() => false, () => true)), "the hand-over went with the session");
  assert.deepEqual((await browserOf(w, { cookie: w.cookie })).json, { state: "none" });
  assert.equal((await liveWs(w, wsPath)).status, 404, "the old link opens nothing");
  assert.equal((await call(w.server.port, { path: `/v2/runs/${w.runId}/browser/live/v/${handed.id}`, headers: { cookie: w.cookie } })).status, 404);
  assert.ok(!filesUnder(runDir).some(([, bytes]) => bytes.includes(handed.token)), "and nothing of the run's holds the token");
});

test("capabilities say the owner may watch a run's browser, read-only", async (t) => {
  const { api } = await serve(t);
  assert.deepEqual((await api("GET", "/capabilities")).body.features.browser_live, { read_only: true });
});

test("the route says whether a run has a browser at all: off with why when its agent has none or its browser resolves unavailable, none when it has one with no session open", { timeout: 120_000 }, async (t) => {
  withEnv(t, { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project", FAUX_BROWSER_LOG: join(await scratch(t), "browser.jsonl") }, KEYS);
  const first = await serve(t, { accounts: true, openSetup: true, console: await builtConsole(t), fauxBrowser: FAUX_BROWSER });
  const own = (server) => ({ ...json, origin: `http://127.0.0.1:${server.port}` });
  const made = await call(first.port, { method: "POST", path: "/v2/setup", headers: own(first), body: { password: PASSWORD } });
  assert.equal(made.status, 201, made.text);
  const browserOfRun = (server, cookie, runId) => call(server.port, { path: `/v2/runs/${runId}/browser`, headers: { cookie } });
  const ran = async (id, tools, content) => {
    assert.equal((await first.api("POST", "/agents", { definition: { id, name: id, instructions: "Answer.", tools } })).status, 201);
    const started = await first.api("POST", `/agents/${id}/runs`, { input: { content } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await follow(first.api, started.body.run_id, ["completed"]);
    return started.body.run_id;
  };
  const plain = await ran("plain", ["read"], "hi");
  const browsed = await ran("browse", ["browser"], "Browse the example page.");
  assert.deepEqual((await browserOfRun(first, cookieOf(made), plain)).json, { state: "off", reason: "this run's agent has no browser tool" });
  assert.deepEqual((await browserOfRun(first, cookieOf(made), browsed)).json, { state: "none" }, "a browser, its session released with the run");
  await first.close();
  // Its browser resolving unavailable at the next start (its vendor's key gone): off, in the plane's words.
  const file = join(first.data, "runs", browsed, "serve.json");
  const meta = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...meta, tool_plane: { ...meta.tool_plane, browser: "kernel" } }));
  const again = await serve(t, { data: first.data, accounts: true, fauxBrowser: FAUX_BROWSER });
  const signed = await call(again.port, { method: "POST", path: "/v2/auth/sign-in", headers: own(again), body: { password: PASSWORD } });
  assert.equal(signed.status, 200, signed.text);
  assert.deepEqual((await browserOfRun(again, cookieOf(signed), browsed)).json, { state: "off", reason: "kernel picked, no KERNEL_API_KEY" });
});

test("a malformed run id under the live path is a 404, never a crash: the server answers the next request, for HTTP and for the upgrade", { timeout: 60_000 }, async (t) => {
  const { port } = await serve(t);
  for (const path of ["/v2/runs/%E0%A4%A/browser/live/viewer.js", "/v2/runs/%/browser/live/v/AAAAAAAAAAAAAAAAAAAAAA"]) {
    assert.equal((await call(port, { path })).status, 404, path);
    assert.equal((await call(port, { path: "/v2/health" })).status < 500, true, `the server still answers after ${path}`);
  }
  const upgrade = await connect(`ws://127.0.0.1:${port}/v2/runs/%E0%A4%A/browser/live/v/AAAAAAAAAAAAAAAAAAAAAA/ws`, { origin: `http://127.0.0.1:${port}` });
  assert.equal(upgrade.status, 404);
  assert.equal((await call(port, { path: "/v2/health" })).status < 500, true, "and after the upgrade");
});

test("a run's process that dies without letting its sessions go takes its hand-over with it, and a hand-over with no live process names no viewer: none, and nothing is proxied", { timeout: 120_000 }, async (t) => {
  const w = await watched(t);
  const handed = JSON.parse(readFileSync(w.file, "utf8"));
  const { holder } = JSON.parse(readFileSync(join(w.server.data, "runs", w.runId, "run.json"), "utf8"));
  process.kill(holder.pid, "SIGKILL");
  assert.ok(await until(() => stat(w.file).then(() => false, () => true)), "the hand-over went with the process");
  assert.deepEqual((await browserOf(w, { cookie: w.cookie })).json, { state: "none" });
  // One left behind (a server that was not watching when the process died), on a port another listener now answers: none.
  const { createServer } = await import("node:http");
  const squatter = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<script src=/x.js></script>"); });
  await new Promise((resolve) => squatter.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => squatter.close(resolve)));
  writeFileSync(w.file, JSON.stringify({ ...handed, port: squatter.address().port }), { mode: 0o600 });
  assert.deepEqual((await browserOf(w, { cookie: w.cookie })).json, { state: "none" }, "no live process: no viewer");
  assert.equal((await call(w.server.port, { path: `/v2/runs/${w.runId}/browser/live/v/${handed.id}`, headers: { cookie: w.cookie } })).status, 404, "nothing proxied");
  assert.equal((await liveWs(w, `/v2/runs/${w.runId}/browser/live/v/${handed.id}/ws`)).status, 404);
});
