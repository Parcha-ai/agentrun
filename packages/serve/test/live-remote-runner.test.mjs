// A runner on another host than its server (one image, a server and its runners apart): a viewer's row names the host
// the runner answers at (AGENTRUN_RUNNER_LIVE_HOST on the runner), and the server dials it only when it is one of its
// runners' hosts (AGENTRUN_RUNNER_HOSTS on the server), with the proxy's proof (an HMAC under a key derived from the seal
// key both hold) on each request. The runner's endpoint takes no request without that proof, before any WebSocket, and
// the viewer's hello token still decides who watches. "Another host" is 127.0.0.2 here: Linux answers all of 127/8 on
// loopback, so the server's dial of a row's host is the one under test, with no network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { proxyLiveUpgrade, readLiveViewers, viewerAnswers } from "../dist/browser-live.js";
import { openComputerView } from "../dist/computer-live.js";
import { LIVE_PROOF_HEADER, liveProof, liveReachOf, runnerLiveOf } from "../dist/live-reach.js";
import { fakeHold, fakeWatch } from "./computer-live-support.mjs";
import { connect } from "./fixtures/ws-client.mjs";
import { fakeLiveViewersStore } from "./live-viewers-support.mjs";

const SKIP = process.platform === "linux" ? false : "127.0.0.2 answers as loopback on Linux alone";
/** A test seal key, no real one. */
const KEY = randomBytes(32);
const REMOTE = "127.0.0.2";
const reachOf = (hosts) => liveReachOf({ AGENTRUN_RUNNER_HOSTS: hosts }, KEY);
const next = async (ws, type) => JSON.parse((await ws.until((m) => m.type === "text" && JSON.parse(m.data).type === type, 5_000)).item?.data ?? "null");

/** A desktop's view opened by a runner that answers at 127.0.0.2, and its row as the server reads it. */
async function remoteView(t, env = { AGENTRUN_RUNNER_LIVE_HOST: REMOTE }) {
  const store = fakeLiveViewersStore();
  const claim = store.claim("run-1");
  const watch = fakeWatch();
  const opened = await openComputerView({ store, sealKey: KEY, claim, kind: "desktop", input: "desktop", tag: "cmp-remote", watch: watch.watch, hold: fakeHold({ grant: true }).hold, at: runnerLiveOf(env, KEY) });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  t.after(() => opened.view.close("ended"));
  const [row] = await readLiveViewers(store, KEY, "run-1");
  return { row, watch };
}

/** The server's side of the viewer's socket, as server.ts proxies it, with `reach`. */
async function proxyOf(t, row, reach) {
  const server = createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => proxyLiveUpgrade(req, socket, head, row, `/v/${row.id}/ws`, undefined, reach));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))));
  return server.address().port;
}

test("a runner's live host goes in its viewer's row; with none, the row is the server's own machine's, as before", { skip: SKIP }, async (t) => {
  const remote = await remoteView(t);
  assert.equal(remote.row.host, REMOTE);
  assert.equal(runnerLiveOf({}, KEY), undefined, "no live host: loopback alone");
  const store = fakeLiveViewersStore();
  const claim = store.claim("run-2");
  const local = await openComputerView({ store, sealKey: KEY, claim, kind: "desktop", input: "desktop", tag: "cmp-local", watch: fakeWatch().watch, hold: fakeHold().hold });
  t.after(() => local.view.close("ended"));
  assert.equal((await readLiveViewers(store, KEY, "run-2"))[0].host, undefined);
});

test("the server asks a remote viewer whether it answers only when its host is one of this server's runners', and with the proxy's proof", { skip: SKIP }, async (t) => {
  const { row } = await remoteView(t);
  assert.equal(await viewerAnswers(row), false, "no reach: loopback alone, and this viewer is not there");
  assert.equal(await viewerAnswers(row, reachOf("runner-9")), false, "a host not of this server's runners is never dialled");
  assert.equal(await viewerAnswers(row, reachOf(`runner-9, ${REMOTE}`)), true);
});

test("the runner's endpoint takes no request without the proxy's proof: no proof, a wrong one, or a stale one is refused before any WebSocket", { skip: SKIP }, async (t) => {
  const { row } = await remoteView(t);
  const direct = `ws://${REMOTE}:${row.port}/v/${row.id}/ws`;
  const origin = `http://${REMOTE}:${row.port}`;
  const reach = reachOf(REMOTE);
  assert.equal((await connect(direct, { origin })).status, 403, "no proof");
  assert.equal((await connect(direct, { origin, headers: { [LIVE_PROOF_HEADER]: `${Date.now()}.${"0".repeat(64)}` } })).status, 403, "a wrong proof");
  assert.equal((await connect(direct, { origin, headers: { [LIVE_PROOF_HEADER]: liveProof(reach, row.id, Date.now() - 120_000) } })).status, 403, "a stale proof");
  assert.equal((await connect(direct, { origin, headers: { [LIVE_PROOF_HEADER]: liveProof(reachOf(REMOTE), "A".repeat(22), Date.now()) } })).status, 403, "another viewer's proof");
  // Another seal key's proof is no proof.
  const stranger = liveReachOf({ AGENTRUN_RUNNER_HOSTS: REMOTE }, randomBytes(32));
  assert.equal((await connect(direct, { origin, headers: { [LIVE_PROOF_HEADER]: liveProof(stranger, row.id, Date.now()) } })).status, 403, "another key's proof");
});

test("the viewer's socket through the server reaches the remote runner's endpoint, and the hello's token still decides; to a host not of its runners the server dials nothing", { skip: SKIP }, async (t) => {
  const { row, watch } = await remoteView(t);
  const port = await proxyOf(t, row, reachOf(REMOTE));
  const c = await connect(`ws://127.0.0.1:${port}/v/${row.id}/ws`, { origin: "http://127.0.0.1" });
  assert.equal(c.status, 101);
  c.ws.sendJson({ type: "hello", token: "A".repeat(43) });
  assert.deepEqual(await next(c.ws, "refused"), { type: "refused", reason: "unauthorized" });
  const ok = await connect(`ws://127.0.0.1:${port}/v/${row.id}/ws`, { origin: "http://127.0.0.1" });
  ok.ws.sendJson({ type: "hello", token: row.token });
  assert.equal((await next(ok.ws, "ready")).kind, "desktop");
  await watch.opened();
  ok.ws.destroy();
  const elsewhere = await proxyOf(t, row, reachOf("runner-9"));
  assert.equal((await connect(`ws://127.0.0.1:${elsewhere}/v/${row.id}/ws`, { origin: "http://127.0.0.1" })).status, 404);
  const none = await proxyOf(t, row, undefined);
  assert.equal((await connect(`ws://127.0.0.1:${none}/v/${row.id}/ws`, { origin: "http://127.0.0.1" })).status, 404);
});
