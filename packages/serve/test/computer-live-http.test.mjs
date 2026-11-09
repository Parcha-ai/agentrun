// A desktop's live view through the server (computer-live.ts on the runner side, the server's store read): the runner's
// row in the store under the run's claim makes GET /computer live with kind desktop and its link under /computer/live;
// the server serves the computer viewer's own page there (LIVE_CSP), and proxies the viewer's WebSocket to the runner's
// endpoint, from its own origin with the owner's cookie alone; Take over, input to the fake watch, Hand back. The
// browser's own route never shows a desktop. The token is in the owner's GET alone. Fakes only: no network, no key.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { openComputerView } from "../dist/computer-live.js";
import { fakeHold, fakeWatch } from "./computer-live-support.mjs";
import { connect } from "./fixtures/ws-client.mjs";
import { builtConsole, call, cookieOf, follow, serve, storeOfData, withEnv } from "./support.mjs";

const json = { "content-type": "application/json" };
/** A test password, no real one. */
const PASSWORD = ["not-a-secret", "owner"].join("-");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 7, 7, 7]);

/** A signed-in owner's server with the store's viewers and a seal key, a run of an agent with no browser, and that run
 *  claimed in the store by a runner that opened its desktop's view. */
async function desktop(t) {
  const sealKey = randomBytes(32);
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey.toString("base64") }, ["AGENTRUN_SEAL_KEY"]);
  const server = await serve(t, { accounts: true, openSetup: true, console: await builtConsole(t) });
  const origin = `http://127.0.0.1:${server.port}`;
  const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: PASSWORD } });
  assert.equal(made.status, 201, made.text);
  const cookie = cookieOf(made);
  assert.equal((await server.api("POST", "/agents", { definition: { id: "desk", name: "desk", instructions: "Answer.", tools: [] } })).status, 201);
  const started = await server.api("POST", "/agents/desk/runs", { input: { content: "hi" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(server.api, runId, ["completed", "input_required"]);
  // The runner's side, on the same store: the run as the store holds it, claimed, and its desktop's view opened.
  const store = storeOfData(server.data);
  if (!(await store.runs.get(runId))) {
    if (!(await store.agents.get("desk"))) await store.agents.create({ id: "desk", name: "desk" }, { id: "rev-desk", kind: "agentic", body: { instructions: "Answer." } });
    await store.runs.create({ id: runId, agentId: "desk", revisionId: (await store.agents.get("desk")).currentRevisionId ?? "rev-desk" });
  }
  const claims = await store.runs.claimMany("runner-a", 10, { leaseMs: 600_000 });
  const claim = claims.find((c) => c.runId === runId);
  assert.ok(claim, `the run is claimed: ${JSON.stringify(claims)}`);
  const watch = fakeWatch();
  const hold = fakeHold({ grant: true });
  const opened = await openComputerView({ store, sealKey, claim, kind: "desktop", input: "desktop", tag: "cmp-desk-1", watch: watch.watch, hold: hold.hold });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  t.after(() => opened.view.close("ended"));
  return { server, origin, cookie, runId, watch, hold, view: opened.view };
}

const get = (w, path, headers) => call(w.server.port, { path, headers });
const next = async (ws, type) => JSON.parse((await ws.until((m) => m.type === "text" && JSON.parse(m.data).type === type, 5_000)).item?.data ?? "null");

test("GET /computer is live with kind desktop and its link under /computer/live, for the owner alone; the browser's own route shows no desktop; the computer viewer's page is served under LIVE_CSP; its socket goes to the runner's endpoint: Take over, input to the computer, Hand back", { timeout: 120_000 }, async (t) => {
  const w = await desktop(t);
  const path = `/v2/runs/${w.runId}/computer`;
  assert.equal((await get(w, path, {})).status, 401);
  assert.equal((await get(w, path, { authorization: `Bearer ${w.server.token}` })).status, 403);
  const answer = await get(w, path, { cookie: w.cookie });
  assert.equal(answer.status, 200, answer.text);
  const [, id, token] = /^\/v2\/runs\/[^/]+\/computer\/live\/v\/([A-Za-z0-9_-]{22})#t=([A-Za-z0-9_-]{43})$/.exec(answer.json.viewer ?? "") ?? [];
  assert.ok(id && token, JSON.stringify(answer.json));
  assert.deepEqual({ ...answer.json, viewer: "" }, { state: "live", kind: "desktop", viewer: "", hold: "agent" });
  // The browser's own route: this run has no browser, and a desktop's viewer is never its.
  assert.deepEqual((await get(w, `/v2/runs/${w.runId}/browser`, { cookie: w.cookie })).json, { state: "off", reason: "this run's agent has no browser tool" });
  assert.equal((await get(w, `/v2/runs/${w.runId}/browser/live/v/${id}`, { cookie: w.cookie })).status, 404);

  // The page: the computer viewer's own, under this route's CSP, owner only.
  const pagePath = `/v2/runs/${w.runId}/computer/live/v/${id}`;
  assert.equal((await get(w, pagePath, {})).status, 401);
  const page = await get(w, pagePath, { cookie: w.cookie });
  assert.equal(page.status, 200, page.text);
  assert.match(page.text, /computer-viewer\.js/);
  assert.match(page.headers["content-security-policy"], /frame-ancestors 'self'/);
  const script = await get(w, `/v2/runs/${w.runId}/computer/live/computer-viewer.js`, { cookie: w.cookie });
  assert.equal(script.status, 200);
  assert.match(script.text, /This computer has ended/);

  // The socket: this server's origin and the owner's cookie, proxied to the runner's endpoint.
  const wsPath = `${pagePath}/ws`;
  assert.equal((await connect(`ws://127.0.0.1:${w.server.port}${wsPath}`, { origin: "http://evil.example", headers: { cookie: w.cookie } })).status, 403);
  assert.equal((await connect(`ws://127.0.0.1:${w.server.port}${wsPath}`, { origin: w.origin })).status, 401);
  assert.equal((await connect(`ws://127.0.0.1:${w.server.port}/v2/runs/${w.runId}/browser/live/v/${id}/ws`, { origin: w.origin, headers: { cookie: w.cookie } })).status, 404, "never under the browser's own route");
  const c = await connect(`ws://127.0.0.1:${w.server.port}${wsPath}`, { origin: w.origin, headers: { cookie: w.cookie } });
  assert.equal(c.status, 101);
  const ws = c.ws;
  t.after(() => ws.destroy());
  ws.sendJson({ type: "hello", token });
  assert.equal((await next(ws, "ready")).kind, "desktop");
  await w.watch.opened();
  const acked = w.watch.push({ bytes: JPEG, width: 1024, height: 768 });
  const frame = (await ws.until((m) => m.type === "binary", 5_000)).item;
  assert.deepEqual([frame.data.readUInt16BE(0), frame.data.readUInt16BE(2)], [1024, 768]);
  ws.sendJson({ type: "ack" });
  await acked;
  ws.sendJson({ type: "take" });
  assert.deepEqual(await next(ws, "hold"), { type: "hold", held: true });
  const sent = w.watch.nextInput();
  ws.sendJson({ type: "key", action: "char", key: "x", code: "KeyX", text: "x", modifiers: 0 });
  assert.deepEqual(await sent, [{ type: "type", text: "x" }]);
  ws.sendJson({ type: "give" });
  assert.deepEqual(await next(ws, "hold"), { type: "hold", held: false, reason: "given" });

  // The token is in the owner's GET alone.
  for (const p of [`/runs/${w.runId}`, `/runs/${w.runId}/timeline`, "/runs"]) assert.ok(!JSON.stringify((await w.server.api("GET", p)).body).includes(token), p);
  // Closed by its runner: none.
  await w.view.close("released");
  assert.equal((await next(ws, "ended")).reason, "released");
  assert.equal((await get(w, path, { cookie: w.cookie })).json.state === "live", false, "no viewer once closed");
});
