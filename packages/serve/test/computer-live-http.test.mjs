// A desktop's live view on the real runner path: a run of an agent whose computer is a desktop is claimed by the runner
// beside the server, composed as the CLI's runner composes it (runner/main.ts runnerComputers), its desktop made at the
// claim through the provider loader (a fake desktop: no vendor, no network), and its view opened there under the run's
// claim (computer-live.ts openClaimView). The agent looks at its desktop (desktop_screen, the tool the desktop brings);
// its second look waits inside the shot until the test lets it go. GET /computer is live with kind desktop and its link
// under /computer/live, for the owner's session alone; the computer viewer's page is served there under LIVE_CSP, and its
// socket is proxied to the runner's endpoint from this server's origin with the owner's cookie. Take over is a take-over
// row the runner applies to the run's hold: pending while the agent's look is in flight, then the person's, the agent's
// next look parked meanwhile; input reaches the desktop's watch; Hand back gives it back, the parked look runs, and the
// run ends, which closes the view. The token is in the owner's GET alone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeDesktopProvider } from "./computer-live-support.mjs";
import { onComputerHold } from "../dist/runner/computer-journal.js";
import { connect } from "./fixtures/ws-client.mjs";
import { agent, call, clientOwnerSession, follow, serve, withEnv } from "./support.mjs";

const FAUX = new URL("./fixtures/faux-desktop-look.mjs", import.meta.url).pathname;
/** Until `check()` holds, bounded; each try after the next turn of the timers. */
async function until(check, what, ms = 30_000) {
  for (const deadline = Date.now() + ms; !(await check());) {
    assert.ok(Date.now() < deadline, what);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
const next = async (ws, type) => JSON.parse((await ws.until((m) => m.type === "text" && JSON.parse(m.data).type === type, 10_000)).item?.data ?? "null");

test("a runner run's desktop registers its live view: GET /computer is live with kind desktop for the owner alone, the viewer's page and socket reach the runner's endpoint, and Take over, input and Hand back go through the run's hold", { timeout: 120_000 }, async (t) => {
  // The desktop's provider key, as the server and its runner read it: a stand-in, which only the fake desktop is given.
  withEnv(t, { E2B_API_KEY: "e2b-test-not-a-key" }, ["E2B_API_KEY"]);
  // The agent's second look waits inside the shot until the test lets it go.
  const desktop = fakeDesktopProvider({ holdShot: 2 });
  t.after(() => desktop.letGo());
  const server = await serve(t, { accounts: true, openSetup: true, faux: FAUX, computers: { load: desktop.load } });
  const owner = await clientOwnerSession(server);
  const made = await server.api("POST", "/agents", agent("desk", { computer: { kind: "desktop", provider: "e2b" } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const started = await server.api("POST", "/agents/desk/runs", { input: { content: "Look at the desktop." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  const path = `/v2/runs/${runId}/computer`;
  const get = (p, headers) => call(server.port, { path: p, headers });
  // The run's desktop is made at the claim and its view opened there: GET /computer goes live.
  await until(async () => (await get(path, { cookie: owner.cookie })).json?.state === "live", "the run's desktop went live");
  assert.equal(desktop.record.created.length, 1, "one desktop made at the claim");

  // GET /computer: the owner's session alone.
  assert.equal((await get(path, {})).status, 401);
  assert.equal((await get(path, { authorization: `Bearer ${server.token}` })).status, 403);
  const answer = await get(path, { cookie: owner.cookie });
  assert.equal(answer.status, 200, answer.text);
  const [, id, token] = /^\/v2\/runs\/[^/]+\/computer\/live\/v\/([A-Za-z0-9_-]{22})#t=([A-Za-z0-9_-]{43})$/.exec(answer.json.viewer ?? "") ?? [];
  assert.ok(id && token, "the viewer's link, its token in the fragment");
  assert.deepEqual({ ...answer.json, viewer: "" }, { state: "live", kind: "desktop", viewer: "", hold: "agent" });
  assert.equal(answer.headers["cache-control"], "no-store");
  assert.equal((await get(`/v2/runs/${runId}/browser/live/v/${id}`, { cookie: owner.cookie })).status, 404, "a desktop's viewer is never under the browser's route");

  // The page: the computer viewer's own, under LIVE_CSP, for the owner alone.
  const pagePath = `/v2/runs/${runId}/computer/live/v/${id}`;
  assert.equal((await get(pagePath, {})).status, 401);
  const page = await get(pagePath, { cookie: owner.cookie });
  assert.equal(page.status, 200, page.text);
  assert.match(page.text, /computer-viewer\.js/);
  assert.match(page.headers["content-security-policy"], /frame-ancestors 'self'/);
  const script = await get(`/v2/runs/${runId}/computer/live/computer-viewer.js`, { cookie: owner.cookie });
  assert.equal(script.status, 200);
  assert.match(script.text, /This computer has ended/);

  // The socket: this server's origin and the owner's cookie, proxied to the runner's endpoint.
  const wsUrl = `ws://127.0.0.1:${server.port}${pagePath}/ws`;
  assert.equal((await connect(wsUrl, { origin: "http://evil.example", headers: { cookie: owner.cookie } })).status, 403);
  assert.equal((await connect(wsUrl, { origin: owner.origin })).status, 401);
  const c = await connect(wsUrl, { origin: owner.origin, headers: { cookie: owner.cookie } });
  assert.equal(c.status, 101);
  const ws = c.ws;
  t.after(() => ws.destroy());
  ws.sendJson({ type: "hello", token });
  assert.deepEqual(await next(ws, "ready"), { type: "ready", drive: "agent", takeOver: true, held: false, kind: "desktop", input: "desktop" });
  const frame = (await ws.until((m) => m.type === "binary", 10_000)).item;
  assert.deepEqual([frame.data.readUInt16BE(0), frame.data.readUInt16BE(2)], [1280, 800], "the screen's own pixels");
  ws.sendJson({ type: "ack" });

  // Take over while the agent's second look is in the shot (its first turn committed, so the run's journal says its desktop
  // is up): a take-over row the runner applies to the run's hold, pending until the look ends, then the person's.
  await desktop.inShot;
  await until(async () => (await server.api("GET", `/runs/${runId}`)).body.computer?.state === "ready", "the run's journal says its desktop is up");
  // The runner applies the take-over row to the run's hold while the look is in flight: pending, said in this process
  // (onComputerHold, the in-process runner's), and only then does the look end.
  const applied = new Promise((resolve) => {
    const off = onComputerHold(runId, (change) => change.state === "pending" && (off(), resolve()));
  });
  ws.sendJson({ type: "take" });
  assert.deepEqual(await next(ws, "status"), { type: "status", drive: "pending" });
  await applied;
  desktop.letGo();
  assert.deepEqual(await next(ws, "hold"), { type: "hold", held: true });
  assert.equal((await get(path, { cookie: owner.cookie })).json.hold, "person");
  const typed = desktop.nextInput();
  ws.sendJson({ type: "key", action: "char", key: "q", code: "KeyQ", text: "q", modifiers: 0 });
  assert.deepEqual(await typed, [{ type: "type", text: "q" }]);
  // The agent's next look is parked while the person holds the desktop.
  assert.equal(desktop.record.shots, 2, "no look while the person drives");
  // Hand back: the agent drives again, its parked look runs, and the run ends, and its view with it.
  ws.sendJson({ type: "give" });
  const given = await next(ws, "hold");
  assert.deepEqual([given.held, given.reason], [false, "given"]);
  assert.equal((await next(ws, "ended")).reason, "released");
  await follow(server.api, runId, ["completed"]);
  assert.notEqual((await get(path, { cookie: owner.cookie })).json.state, "live", "no viewer once the run ended");
  assert.deepEqual(desktop.record.released, [["desk-1", "delete"]]);
  assert.equal(desktop.record.shots, 3, "the parked look ran after the hand-back");

  // The token is in the owner's GET alone.
  for (const p of [`/runs/${runId}`, `/runs/${runId}/timeline`, "/runs"]) assert.ok(!JSON.stringify((await server.api("GET", p)).body).includes(token), p);
  const said = JSON.stringify((await server.api("GET", `/runs/${runId}/timeline`)).body);
  assert.match(said, /You took over the desktop/);
  assert.match(said, /You handed the desktop back/);
});

// #2170: a desktop or phone run whose screen is not open (no runner has it, or its viewer does not answer) has a computer
// all the same: GET /computer reads none with its kind, never off with "this run's agent has no computer".
test("a desktop or phone run whose screen is not open reads none with its kind; only an agent with no computer reads off (#2170)", { timeout: 120_000 }, async (t) => {
  withEnv(t, { E2B_API_KEY: "e2b-test-not-a-key" }, ["E2B_API_KEY"]);
  // No runner: the runs stay queued, their computers never made, so no viewer answers.
  const server = await serve(t, { runner: false, accounts: true, openSetup: true, faux: FAUX });
  const owner = await clientOwnerSession(server);
  const read = async (id, definition) => {
    assert.equal((await server.api("POST", "/agents", agent(id, definition))).status, 201);
    const runId = (await server.api("POST", `/agents/${id}/runs`, { input: { content: "Look." } })).body.run_id;
    return (await call(server.port, { path: `/v2/runs/${runId}/computer`, headers: { cookie: owner.cookie } })).json;
  };
  assert.deepEqual(await read("desk", { computer: { kind: "desktop", provider: "e2b" } }), { state: "none", kind: "desktop", hold: "agent" });
  assert.deepEqual(await read("plain", {}), { state: "off", hold: "agent", why: "this run's agent has no computer" });
});
