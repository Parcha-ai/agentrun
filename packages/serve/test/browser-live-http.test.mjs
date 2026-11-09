// The owner's live view of a runner-path run, over HTTP and its WebSocket, from the one store (browser-live.ts, server.ts):
// the run's viewer is the one its runner put into the store under the run's claim (store.liveViewers, its token sealed),
// never a file in its directory. The server names it to the owner alone (GET /v2/runs/{id}/browser), serves the viewer's
// page from its own copy under LIVE_CSP, and pipes the viewer's WebSocket to the run's loopback port only from its own
// origin with the owner's session; once the runner drops it, none, and the old link opens nothing. The token is in the
// owner's browser answer alone: no other API answer, no file under the data directory (the store's journal and command
// rows among its tables), no plaintext browser_viewers column.
//
// The runner does not bind the browser tool yet (E2r3), so the run's viewer is a stand-in here: a loopback viewer (port 0)
// shaped as pi-browser's own (its page at /v/<id>, its WebSocket at /v/<id>/ws), put into the store with putLiveViewer
// under a real claim (runs.claimMany on the server's store, as a runner holds it).
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { connect } from "./fixtures/ws-client.mjs";
import { call, cookieOf, serve, withEnv } from "./support.mjs";

const { dropLiveViewer, LIVE_CSP, putLiveViewer } = await import("../dist/browser-live.js");
const { openSqliteStore, STORE_FILE } = await import("../dist/store/sqlite/store.js");
const { viewerAssets } = await import("@parcha/pi-browser/live-view");

const KEYS = ["AGENTRUN_SEAL_KEY", "BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"];
const json = { "content-type": "application/json" };
/** A test password, no real one. */
const PASSWORD = ["not-a-secret", "owner"].join("-");
/** Every file under `dir`, path and bytes. */
const filesUnder = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [[path, readFileSync(path)]] : [];
});
const accept = (key) => createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
const frame = (text) => { const p = Buffer.from(text); return Buffer.concat([Buffer.from([0x81, p.length]), p]); };
/** The first masked text frame in `bytes` (a client's), unmasked; undefined until it is whole. */
function firstText(bytes) {
  if (bytes.length < 6) return undefined;
  const length = bytes[1] & 0x7f;
  if (length >= 126 || bytes.length < 6 + length) return undefined;
  const mask = bytes.subarray(2, 6);
  return Buffer.from(bytes.subarray(6, 6 + length).map((byte, i) => byte ^ mask[i % 4])).toString("utf8");
}

/** A stand-in for the run's own viewer on loopback, shaped as pi-browser's: its page at /v/<id> (HEAD and GET), its
 *  WebSocket at /v/<id>/ws, which answers the viewer's first message with `ready`. It notes every request and upgrade. */
async function standInViewer(t, id) {
  const asked = [];
  const upgrades = [];
  const sockets = new Set();
  let heard;
  const hello = new Promise((resolve) => (heard = resolve));
  const viewer = createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`);
    res.writeHead(req.url === `/v/${id}` ? 200 : 404, { "content-type": "text/html" });
    res.end(req.method === "HEAD" ? undefined : "<script src=/planted.js></script>");
  });
  viewer.on("upgrade", (req, socket) => {
    upgrades.push({ url: req.url, headers: req.headers });
    sockets.add(socket);
    socket.on("error", () => {});
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept(req.headers["sec-websocket-key"])}\r\n\r\n`);
    let bytes = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      const text = firstText(bytes);
      if (text === undefined) return;
      bytes = Buffer.alloc(0);
      heard(text);
      socket.write(frame(JSON.stringify({ type: "ready", drive: "idle", takeOver: true, held: false })));
    });
  });
  await new Promise((resolve) => viewer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); viewer.closeAllConnections(); viewer.close(resolve); }));
  return { port: viewer.address().port, asked, upgrades, hello };
}

/** A signed-in owner's server with no runner beside it, a run of `watch` (browser) claimed on the server's store as a runner
 *  holds it, and the stand-in viewer put into the store under that claim. */
async function watched(t) {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" }, KEYS);
  const key = Buffer.from(process.env.AGENTRUN_SEAL_KEY, "base64");
  const server = await serve(t, { runner: false, accounts: true, openSetup: true });
  const origin = `http://127.0.0.1:${server.port}`;
  const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: PASSWORD } });
  assert.equal(made.status, 201, made.text);
  const cookie = cookieOf(made);
  assert.equal((await server.api("POST", "/agents", { definition: { id: "watch", name: "watch", instructions: "Browse.", tools: ["browser"] } })).status, 201);
  const started = await server.api("POST", "/agents/watch/runs", { input: { content: "Browse the example page." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  // The run's runner: the server's store, opened as a runner opens it, and the run claimed under it.
  const store = await openSqliteStore({ dataDir: server.data, role: "runner" });
  t.after(() => store.close());
  const [claim] = await store.runs.claimMany("runner-test", 1, { leaseMs: 10 * 60_000 });
  assert.equal(claim?.runId, runId, "the run is claimed as its runner holds it");
  const id = randomBytes(16).toString("base64url");
  const token = randomBytes(32).toString("base64url");
  const viewer = await standInViewer(t, id);
  const tag = `ar-${runId}-1`;
  assert.equal(await putLiveViewer(store, key, claim, { port: viewer.port, id, token, tag }), true);
  return { server, origin, cookie, runId, store, claim, key, id, token, tag, viewer };
}

const browserOf = (w, headers, runId = w.runId) => call(w.server.port, { path: `/v2/runs/${runId}/browser`, headers });
const liveWs = (w, path, { origin = w.origin, cookie = w.cookie, headers = {} } = {}) => connect(`ws://127.0.0.1:${w.server.port}${path}`, { origin: origin ?? undefined, headers: { ...(cookie ? { cookie } : {}), ...headers } });

test("a runner-path run's viewer, from the store: the owner's GET is live with its link, its page is this server's own under LIVE_CSP, its WebSocket from the server's own origin with the owner's session pipes to the run's viewer, the same refusals as ever otherwise, and once dropped none and the old link opens nothing", { timeout: 120_000 }, async (t) => {
  const w = await watched(t);
  const link = `/v2/runs/${w.runId}/browser/live/v/${w.id}#t=${w.token}`;

  // The owner alone: no credential 401, the server's token 403, the owner's session 200 with the link.
  assert.equal((await browserOf(w, {})).status, 401);
  assert.equal((await browserOf(w, { authorization: `Bearer ${w.server.token}` })).status, 403, "a token never opens the browser");
  const answer = await browserOf(w, { cookie: w.cookie });
  assert.equal(answer.status, 200, answer.text);
  assert.deepEqual(answer.json, { state: "live", viewer: link });
  assert.equal(answer.headers["cache-control"], "no-store");

  // The page: this server's own copy, under the route's CSP, never the run's port's.
  const pagePath = `/v2/runs/${w.runId}/browser/live/v/${w.id}`;
  assert.equal((await call(w.server.port, { path: pagePath })).status, 401);
  assert.equal((await call(w.server.port, { path: pagePath, headers: { authorization: `Bearer ${w.server.token}` } })).status, 403);
  const page = await call(w.server.port, { path: pagePath, headers: { cookie: w.cookie } });
  assert.equal(page.status, 200, page.text);
  assert.equal(page.headers["content-security-policy"], LIVE_CSP);
  assert.equal(page.text, viewerAssets.html, "this server's own pi-browser viewer, byte for byte");
  assert.equal((await call(w.server.port, { path: `/v2/runs/${w.runId}/browser/live/viewer.js`, headers: { cookie: w.cookie } })).status, 200);
  assert.equal((await call(w.server.port, { path: `/v2/runs/${w.runId}/browser/live/v/AAAAAAAAAAAAAAAAAAAAAA`, headers: { cookie: w.cookie } })).status, 404, "another viewer's path is not served");
  assert.ok(w.viewer.asked.every((line) => line === `HEAD /v/${w.id}`), `only the viewer's liveness check reached the run's port: ${w.viewer.asked.join(", ")}`);

  // The WebSocket: the same refusals as ever; another run's id finds no viewer.
  const other = await w.server.api("POST", "/agents/watch/runs", { input: { content: "Another." } });
  assert.equal(other.status, 202);
  const wsPath = `${pagePath}/ws`;
  assert.equal((await liveWs(w, wsPath, { origin: "http://evil.example" })).status, 403, "another origin");
  assert.equal((await liveWs(w, wsPath, { origin: null })).status, 403, "no origin");
  assert.equal((await liveWs(w, wsPath, { cookie: null })).status, 401, "no session");
  assert.equal((await liveWs(w, wsPath, { cookie: null, headers: { authorization: `Bearer ${w.server.token}` } })).status, 401, "a token is no session");
  assert.equal((await liveWs(w, `/v2/runs/${other.body.run_id}/browser/live/v/${w.id}/ws`)).status, 404, "another run's id");
  assert.equal((await liveWs(w, `/v2/runs/${w.runId}/browser/live/v/AAAAAAAAAAAAAAAAAAAAAA/ws`)).status, 404);
  assert.deepEqual(w.viewer.upgrades, [], "no refused socket reached the run's port");

  // The owner's, from this server's own origin: piped to the run's viewer, as its own origin, with nothing of the owner's.
  const open = await liveWs(w, wsPath);
  assert.equal(open.status, 101);
  open.ws.sendJson({ type: "hello", token: w.token });
  assert.deepEqual(JSON.parse(await w.viewer.hello), { type: "hello", token: w.token }, "the viewer's message reached the run's port");
  assert.deepEqual(JSON.parse((await open.ws.next(60_000)).data), { type: "ready", drive: "idle", takeOver: true, held: false }, "and its answer came back");
  assert.equal(w.viewer.upgrades.length, 1);
  const [{ url, headers }] = w.viewer.upgrades;
  assert.equal(url, `/v/${w.id}/ws`);
  assert.equal(headers.host, `127.0.0.1:${w.viewer.port}`);
  assert.equal(headers.origin, `http://127.0.0.1:${w.viewer.port}`, "the run's viewer sees its own origin");
  assert.equal(headers.cookie, undefined, "nothing of the owner's reaches the run");
  open.ws.destroy();

  // The runner drops it (the session released): none, and the old link opens nothing.
  await dropLiveViewer(w.store, w.claim, w.tag);
  assert.deepEqual((await browserOf(w, { cookie: w.cookie })).json, { state: "none" });
  assert.equal((await liveWs(w, wsPath)).status, 404, "the old link's upgrade");
  assert.equal((await call(w.server.port, { path: pagePath, headers: { cookie: w.cookie } })).status, 404, "and its page");
  assert.equal(w.viewer.upgrades.length, 1, "no new socket reached the run's port");
});

test("a runner-path run's viewer token is in the owner's browser answer alone: in no other API answer, no file under the data directory, no journal or command row, no plaintext browser_viewers column", { timeout: 120_000 }, async (t) => {
  const w = await watched(t);
  const answer = await browserOf(w, { cookie: w.cookie });
  assert.ok(answer.text.includes(w.token), "the owner's browser answer holds it");
  assert.equal((await w.server.api("POST", `/runs/${w.runId}/messages`, { content: "Go on." })).status < 500, true, "a command row for the run");
  for (const path of [`/runs/${w.runId}`, "/runs", "/agents/watch/runs", `/runs/${w.runId}/files`, "/agents/watch/home/files", "/capabilities", "/stats", `/runs/${w.runId}/browser`]) {
    const res = await w.server.api("GET", path);
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes(w.token) && !text.includes(w.id), `${path} (${res.status}) holds no token and no viewer id`);
  }
  assert.equal((await w.server.api("POST", `/runs/${w.runId}/archive`)).status, 200);
  assert.ok(!JSON.stringify((await w.server.api("GET", `/runs/${w.runId}`)).body).includes(w.token), "archived, the same");
  // The store holds it sealed, nowhere in the clear: no column of its row, no command or journal row, no file.
  const db = new DatabaseSync(join(w.server.data, STORE_FILE), { readOnly: true, timeout: 5_000 });
  let rows;
  try {
    rows = db.prepare("SELECT * FROM browser_viewers").all();
  } finally {
    db.close();
  }
  assert.equal(rows.length, 1);
  assert.ok(rows.every((row) => Object.values(row).every((value) => !(value instanceof Uint8Array ? Buffer.from(value).includes(w.token) : String(value).includes(w.token)))), "no browser_viewers column holds it in plaintext");
  assert.ok(!JSON.stringify(await w.store.commands(w.runId, 0)).includes(w.token), "no command row");
  assert.deepEqual(filesUnder(w.server.data).filter(([, bytes]) => bytes.includes(w.token)).map(([path]) => path), [], "no file under the data directory (the store's journal and command tables among them)");
});

test.todo("a runner-path run's timeline (GET /runs/{id}/timeline) holds no viewer token and no viewer id: waits on E2c's timeline over the store (server.ts timeline() is runReadsTodo, its rejection unawaited at the getRunTimeline route)");

test.todo("the runner's own browser tool opens a session on a runner-path run and hands its viewer over by itself (a real frame through the proxy), and its release takes it back: waits on E2r3: the runner binds the browser tool");
