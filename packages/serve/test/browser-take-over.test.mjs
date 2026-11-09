// The owner takes over a run's browser and hands it back, and the agent can ask them to (browser-person.ts), end to end
// through serve's proxy of the run's own viewer, on the fake browser's loopback DevTools endpoint. Outside a hold the run
// drops the viewer's input; Take over holds the browser for the owner (their time held under the run's cap first, refused
// in the cap's words without room), their input reaches the browser, the agent's browser call waits and is then told the
// person had it, and the run stays working. The agent's ask makes the run input_required with pending.kind browser, a
// waiting row and run.needs_input; the owner's hand-back answers it, first answer wins; unanswered it expires. The ask's
// record and the viewer's token are in no row, view, file list or other file. On fakes: no network, no key.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { ASK } from "./fixtures/faux-browse-handoff.mjs";
import { connect } from "./fixtures/ws-client.mjs";
import { builtConsole, call, cookieOf, follow, runDir as runFolder, runRecordOf, scratch, serve, withEnv } from "./support.mjs";
import { runsTestHooks } from "../dist/runs.js";

const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
const BROWSE_ASK = new URL("./fixtures/faux-browse-ask.mjs", import.meta.url).pathname;
const BROWSE_WAIT = new URL("./fixtures/faux-browse-wait.mjs", import.meta.url).pathname;
const BROWSE_HANDOFF = new URL("./fixtures/faux-browse-handoff.mjs", import.meta.url).pathname;
const KEYS = ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "KERNEL_API_KEY", "FAUX_BROWSER_LOG", "FAUX_BROWSER_PERSON_MS", "AGENTRUN_SEAL_KEY", "FAUX_BROWSER_STATE", "FAUX_HELD_API_KEY", "FAUX_ECHO_VALUE", "FAUX_BROWSER_ASK_DIES"];
const json = { "content-type": "application/json" };
/** A test password, no real one. */
const PASSWORD = ["not-a-secret", "owner"].join("-");
const PERSON_HAD = "This call waited while the person had the browser: they took it over through the live view and have handed it back.";
const PERSON_DROVE = "A person used this browser through the live view since your last call, so the page may have changed";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 15_000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) { const value = await check(); if (value) return value; } return false; };
const filesUnder = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [[path, readFileSync(path)]] : [];
});
/** An ask's id, as browser-person.ts makes it: a digest of its session's tag and the model's request id. */
const askIdOf = (sessionTag, requestId) => createHash("sha256").update(`${sessionTag}\n${requestId}`).digest("base64url").slice(0, 32);

/** A signed-in owner's server with the fake browser, and a run of `faux` started (with `cap`, if any) and come to
 *  input_required with its session open and its viewer handed over. `env`: more of the run's environment. */
/** `settled`: awaited once the run reads input_required, before the viewer's hand-over is looked for (a test's way to
 *  let the run's process move on first, as a slow machine does). `viewer: false`: no hand-over is waited for, for a run
 *  that need not keep one (paused at its cap, its process is let go, and its viewer with it). */
async function watched(t, { faux, cap, env = {}, hook, settled, viewer = true } = {}) {
  const log = join(await scratch(t), "browser.jsonl");
  withEnv(t, { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project", FAUX_BROWSER_LOG: log, ...env }, KEYS);
  const server = await serve(t, { accounts: true, openSetup: true, console: await builtConsole(t), fauxBrowser: FAUX_BROWSER, faux });
  const origin = `http://127.0.0.1:${server.port}`;
  const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: PASSWORD } });
  assert.equal(made.status, 201, made.text);
  const cookie = cookieOf(made);
  if (hook) assert.equal((await server.api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  assert.equal((await server.api("POST", "/agents", { definition: { id: "drive", name: "drive", instructions: "Browse.", tools: ["browser", "ask_person"] } })).status, 201);
  const started = await server.api("POST", "/agents/drive/runs", { input: { content: "Browse the example page." }, ...(cap ? { max_cost_usd: cap } : {}) });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  const followed = await follow(server.api, runId, ["input_required"]);
  const dir = join(runFolder(server.data, runId), "browser-live");
  if (settled) await settled(server, runId, dir);
  if (!viewer) {
    const w = { server, origin, cookie, runId, log, after: followed.after, firstRows: followed.rows };
    w.view = async () => (await server.api("GET", `/runs/${runId}`)).body;
    w.rows = async () => (await server.api("GET", `/runs/${runId}/timeline`)).body.rows;
    w.handBack = (outcome, headers = { cookie }) => call(server.port, { method: "POST", path: `/v2/runs/${runId}/browser/hand-back`, headers: { ...json, origin, ...headers }, body: { outcome } });
    return w;
  }
  assert.ok(await until(() => readdir(dir).then((names) => names.some((name) => name.endsWith(".json")), () => false)), "the run's process handed its viewer over");
  const handed = JSON.parse(readFileSync(join(dir, (await readdir(dir)).find((name) => name.endsWith(".json"))), "utf8"));
  const wsPath = `/v2/runs/${runId}/browser/live/v/${handed.id}/ws`;
  const w = { server, origin, cookie, runId, handed, wsPath, log, after: followed.after, firstRows: followed.rows };
  /** The viewer, signed in as the owner and past its hello, and its first message; once its stream follows the page. */
  w.viewer = async ({ cookie: as = cookie, headers = {} } = {}) => {
    const c = await connect(`ws://127.0.0.1:${server.port}${wsPath}`, { origin, headers: { ...(as ? { cookie: as } : {}), ...headers } });
    if (c.status !== 101) return c;
    c.ws.sendJson({ type: "hello", token: handed.token });
    const first = JSON.parse((await c.ws.next(5_000)).data);
    assert.ok((await c.ws.until((m) => m.type === "text" && JSON.parse(m.data).type === "page", 10_000)).item, "the viewer follows the page");
    return { ...c, first };
  };
  /** The next message of `type` on `ws`. */
  w.next = async (ws, type, ms = 10_000) => JSON.parse((await ws.until((m) => m.type === "text" && JSON.parse(m.data).type === type, ms)).item?.data ?? "null");
  /** What the run's browser was sent through the DevTools endpoint as input. */
  w.inputs = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((line) => line.op === "devtools").map((line) => line.method);
  /** The owner types `text` while holding the browser, and it reaches the browser: sent again while the run's viewer says it
   *  was not delivered (a stream still following the page, under load), whatever it said kept for the failure. */
  w.typed = async (ws, text) => {
    const said = [];
    for (const end = Date.now() + 30_000; Date.now() < end; ) {
      ws.sendJson({ type: "text", text });
      const { item } = await ws.until((m) => m.type === "text" && JSON.parse(m.data).type === "held", 2_000);
      if (item) said.push(JSON.parse(item.data).reason);
      if (await until(() => w.inputs().includes("Input.insertText"), item ? 200 : 2_000)) return;
    }
    assert.fail(`the owner's input never reached the browser; the viewer said: ${JSON.stringify(said)}`);
  };
  w.view = async () => (await server.api("GET", `/runs/${runId}`)).body;
  w.rows = async () => (await server.api("GET", `/runs/${runId}/timeline`)).body.rows;
  w.handBack = (outcome, headers = { cookie }) => call(server.port, { method: "POST", path: `/v2/runs/${runId}/browser/hand-back`, headers: { ...json, origin, ...headers }, body: { outcome } });
  return w;
}

const summaries = (rows) => rows.map((row) => row.summary);

test("take over and hand back over the proxied socket: input outside a hold is dropped by the run; Take over holds the browser, the owner's input reaches it, the agent's call waits, then goes on told plainly the person had it; the run stays working, and the timeline says who had it", { timeout: 180_000 }, async (t) => {
  const w = await watched(t, { faux: BROWSE_WAIT });
  const { ws, first } = await w.viewer();
  assert.deepEqual(first, { type: "ready", drive: "idle", takeOver: true, held: false });
  ws.sendJson({ type: "text", text: "typed before taking over" });
  assert.deepEqual(await w.next(ws, "held"), { type: "held", reason: "not_taken" });
  ws.sendJson({ type: "mouse", action: "down", x: 3, y: 4 });
  assert.deepEqual(await w.next(ws, "held"), { type: "held", reason: "not_taken" });
  await sleep(300);
  assert.deepEqual(w.inputs(), [], "nothing reached the browser outside a hold");

  const tookAt = Date.now();
  ws.sendJson({ type: "take" });
  assert.deepEqual(await w.next(ws, "hold"), { type: "hold", held: true });
  assert.ok(await until(async () => summaries(await w.rows()).includes("You took over the browser")), "the timeline says the owner took it");
  await w.typed(ws, "tomsmith");

  // The agent's next browser call waits while the owner holds the browser; the run is working, not waiting on anyone.
  assert.equal((await w.server.api("POST", `/runs/${w.runId}/messages`, { content: "Look again." })).status, 202);
  const snapshots = async () => (await w.rows()).filter((row) => row.kind === "tool_result" && row.tool_name === "snapshot").length;
  await sleep(2_000);
  const during = await w.view();
  assert.equal(during.status, "working", "a take-over leaves the run working");
  assert.equal(during.pending, null);
  assert.equal(await snapshots(), 1, "the agent's call is still waiting");

  const gaveAt = Date.now();
  ws.sendJson({ type: "give" });
  assert.deepEqual(await w.next(ws, "hold"), { type: "hold", held: false, reason: "given" });
  const back = await follow(w.server.api, w.runId, ["input_required"], { after: w.after });
  // Each turn's row at its own time, so the hold reads as long as it was; the call that waited for it says so.
  const rows = await w.rows();
  const timeOf = (summary) => Date.parse(rows.find((row) => row.summary === summary)?.timestamp ?? "");
  assert.ok(timeOf("You took over the browser") >= tookAt && timeOf("You took over the browser") < gaveAt, `the take's row at the take: ${JSON.stringify(rows.map((r) => [r.timestamp, r.summary]))}`);
  assert.ok(timeOf("You handed the browser back") >= gaveAt, "the hand-back's row at the hand-back");
  const parked = rows.filter((row) => row.kind === "tool_use" && row.tool_name === "snapshot").at(-1);
  assert.match(parked.summary, /^Waited for you \d+(\.\d+)? (ms|s), then looked at the page structure$/, "the call that waited says so");
  const question = (await w.view()).pending?.question ?? "";
  assert.ok(question.includes(PERSON_HAD), `the model was told the person had the browser: ${question}`);
  assert.ok(question.includes(PERSON_DROVE), "and that the page may have changed");
  assert.equal(await snapshots(), 2, "then its call went on");
  const said = summaries(back.rows);
  assert.ok(said.includes("You handed the browser back"), JSON.stringify(said));
  assert.equal(said.filter((s) => s === "You took over the browser").length, 1, "one take");
  ws.sendJson({ type: "text", text: "after handing back" });
  assert.deepEqual(await w.next(ws, "held"), { type: "held", reason: "not_taken" });
  ws.destroy();
});

test("taking over gets the Host check every route gets: a page that rebound a name of its own cannot reach the viewer's socket to take the browser, whatever its Origin and cookie; this machine's name on another port (a tunnel) takes over", { timeout: 120_000 }, async (t) => {
  const w = await watched(t, { faux: BROWSE_ASK });
  const at = (name) => ({ origin: `http://${name}`, headers: { host: name, cookie: w.cookie } });
  const rebound = await connect(`ws://127.0.0.1:${w.server.port}${w.wsPath}`, at(`rebound.example:${w.server.port}`));
  assert.equal(rebound.status, 403, "a rebound name never reaches the socket");
  const tunnel = await connect(`ws://127.0.0.1:${w.server.port}${w.wsPath}`, at(`localhost:${w.server.port + 1}`));
  assert.equal(tunnel.status, 101, "a tunnel's port is this machine's name");
  tunnel.ws.sendJson({ type: "hello", token: w.handed.token });
  assert.equal(JSON.parse((await tunnel.ws.next(5_000)).data).type, "ready");
  tunnel.ws.sendJson({ type: "take" });
  assert.deepEqual(await w.next(tunnel.ws, "hold"), { type: "hold", held: true });
  tunnel.ws.destroy();
});

test("only the owner's signed-in page takes over or answers: a token, or no credential, never opens the socket or the hand-back", { timeout: 120_000 }, async (t) => {
  const w = await watched(t, { faux: BROWSE_ASK });
  assert.equal((await w.viewer({ cookie: null })).status, 401, "no session: no socket, so no take");
  assert.equal((await w.viewer({ cookie: null, headers: { authorization: `Bearer ${w.server.token}` } })).status, 401, "a token is no session");
  assert.equal((await w.handBack("done", {})).status, 401);
  assert.equal((await w.handBack("done", { authorization: `Bearer ${w.server.token}` })).status, 403, "a token never answers for the owner");
  const none = await w.handBack("done");
  assert.deepEqual([none.status, none.json.error.message], [404, "this run's agent has not asked for you in its browser"], "an agent that asked for nobody");
  // The browser's own routes and the computer family's both answer the owner, and refuse a token alike.
  for (const path of [`/v2/runs/${w.runId}/browser`, `/v2/runs/${w.runId}/computer`]) {
    assert.equal((await call(w.server.port, { path, headers: { cookie: w.cookie } })).status, 200, path);
    assert.equal((await call(w.server.port, { path, headers: { authorization: `Bearer ${w.server.token}` } })).status, 403, `${path} with a token`);
  }
});

test("cap: Take over holds the owner's 15 minutes of session time first, and with no room it is refused in the cap's words and nothing is held; with room, the hold is dropped when they hand back", { timeout: 180_000 }, async (t) => {
  // $0.12 an hour: a browser call holds $0.018, a session's reserve $0.009, 15 minutes of the owner's time $0.03.
  const tight = await watched(t, { faux: BROWSE_ASK, cap: 0.03 });
  const { ws } = await tight.viewer();
  ws.sendJson({ type: "take" });
  const refused = await tight.next(ws, "take_refused");
  assert.match(refused?.message ?? "", /^spend_cap_reached: Not sent: this run has spent \$[\d.]+( and holds \$[\d.]+ for steps still running)?, of its \$0\.03 cap, and the next step, taking over the browser, could cost up to \$0\.03 \(browserbase's session time at \$0\.12 an hour for the 15 minutes it may last\)\. Raise the cap to at least \$0\.04 to continue\.$/);
  ws.sendJson({ type: "text", text: "x" });
  assert.deepEqual(await tight.next(ws, "held"), { type: "held", reason: "not_taken" }, "no hold started");
  assert.ok(!summaries(await tight.rows()).includes("You took over the browser"));
  ws.destroy();
  // The owner's refused take-over is no step of the agent's: the run is not paused at its cap for it, and the person's next
  // message has its turn.
  assert.equal((await tight.server.api("POST", `/runs/${tight.runId}/messages`, { content: "That is all." })).status, 202);
  const ended = await follow(tight.server.api, tight.runId, ["completed", "input_required"], { after: tight.after });
  assert.equal(ended.last.status, "completed", `not paused for the owner's take-over: ${JSON.stringify((await tight.view()).pending)}`);

  // $0.05: the take fits beside the reserve; were its $0.03 still held after the hand back, the agent's next call
  // ($0.018 beside the reserve) would not.
  const roomy = await watched(t, { faux: BROWSE_WAIT, cap: 0.05 });
  const viewer = await roomy.viewer();
  viewer.ws.sendJson({ type: "take" });
  assert.deepEqual(await roomy.next(viewer.ws, "hold"), { type: "hold", held: true });
  viewer.ws.sendJson({ type: "give" });
  assert.deepEqual(await roomy.next(viewer.ws, "hold"), { type: "hold", held: false, reason: "given" });
  assert.equal((await roomy.server.api("POST", `/runs/${roomy.runId}/messages`, { content: "Look again." })).status, 202);
  await follow(roomy.server.api, roomy.runId, ["input_required"], { after: roomy.after });
  const question = (await roomy.view()).pending?.question ?? "";
  assert.doesNotMatch(question, /spend_cap_reached/, "the take's hold went with the take");
  assert.match(question, /Saw:/);
  viewer.ws.destroy();
});

test("the agent asks: input_required with pending.kind browser, a waiting row and run.needs_input; the owner takes over meanwhile; the hand-back answers, first answer wins (409 for another), ends the take, and the agent hears done", { timeout: 180_000 }, async (t) => {
  const got = [];
  const receiver = createServer((req, res) => { const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => { try { got.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { /* not a message */ } res.writeHead(200).end(); }); });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (receiver.close(resolve), receiver.closeAllConnections())));
  const w = await watched(t, { faux: BROWSE_HANDOFF, env: { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, hook: { url: `http://127.0.0.1:${receiver.address().port}/hook` } });
  const view = await w.view();
  assert.deepEqual([view.status, view.state], ["input_required", "waiting"]);
  assert.deepEqual(Object.keys(view.pending).sort(), ["asked_at", "completion_condition", "expires_at", "instruction", "kind"]);
  assert.deepEqual([view.pending.kind, view.pending.instruction, view.pending.completion_condition], ["browser", ASK.instruction, ASK.completion_condition]);
  assert.equal(Date.parse(view.pending.expires_at) - Date.parse(view.pending.asked_at), 15 * 60_000, "it expires in 15 minutes");
  const waiting = w.firstRows.findLast((row) => row.kind === "waiting");
  assert.equal(waiting?.summary, `Waiting for you: ${ASK.instruction}`);
  const needs = await until(() => got.find((m) => m.type === "run.needs_input" && m.data.run_id === w.runId));
  assert.deepEqual(needs?.data.pending, { kind: "browser" }, "run.needs_input says the run waits on the browser");

  // The record is the run's directory's alone (0600 in 0700, outside work/): its bytes are in no other file, and nothing the
  // API serves names its id. (pi-browser's own store keeps the id, a digest of the session's tag and the model's request
  // id, to resume its wait.)
  const askFolder = join(runFolder(w.server.data, w.runId), "browser-ask");
  const named = readdirSync(askFolder).filter((name) => /^[A-Za-z0-9_-]{32}\.json$/.test(name));
  assert.equal(named.length, 1, JSON.stringify(readdirSync(askFolder)));
  const recordFile = join(askFolder, named[0]);
  const record = readFileSync(recordFile, "utf8").trim();
  const id = askIdOf(JSON.parse(record).tag, ASK.request_id);
  assert.equal(named[0], `${id}.json`, "named by its session and request id");
  assert.deepEqual([statSync(recordFile).mode & 0o777, statSync(join(recordFile, "..")).mode & 0o777], [0o600, 0o700]);
  assert.deepEqual(Object.keys(JSON.parse(record)).sort(), ["asked_at", "completion_condition", "expires_at", "id", "instruction", "tag"], "no live view link, no token");
  assert.deepEqual(filesUnder(w.server.data).filter(([, bytes]) => bytes.includes(record)).map(([path]) => path), [recordFile]);
  for (const path of [`/runs/${w.runId}`, `/runs/${w.runId}/timeline`, "/runs", `/runs/${w.runId}/files`]) assert.ok(!JSON.stringify((await w.server.api("GET", path)).body).includes(id), path);
  for (const path of [`/runs/${w.runId}/files/..%2Fbrowser-ask/${id}.json`, `/runs/${w.runId}/files/browser-ask/${id}.json`]) assert.ok((await w.server.api("GET", path)).status >= 400, path);

  // Meanwhile the owner takes over (the ask already holds their time) and drives.
  const { ws } = await w.viewer();
  ws.sendJson({ type: "take" });
  assert.deepEqual(await w.next(ws, "hold"), { type: "hold", held: true });
  await w.typed(ws, "my own password");

  assert.equal((await w.handBack("finished")).status, 422);
  const done = await w.handBack("done");
  assert.deepEqual([done.status, done.json], [200, { outcome: "done" }]);
  assert.equal((await w.view()).status, "working", "answered: working again at once");
  assert.deepEqual(await w.next(ws, "hold"), { type: "hold", held: false, reason: "answered" }, "the answer ended the take");
  assert.deepEqual([(await w.handBack("done")).status], [200], "the same answer again is that answer");
  const other = await w.handBack("cancelled");
  assert.deepEqual([other.status, other.json.error.code, other.json.error.details], [409, "handoff_answered", { outcome: "done" }]);

  const after = await follow(w.server.api, w.runId, ["input_required"], { after: w.after });
  const question = (await w.view()).pending?.question ?? "";
  assert.match(question, /"outcome":"done"/, `the agent heard done: ${question}`);
  const said = summaries(after.rows);
  assert.deepEqual(said.filter((s) => /took over|handed the browser back|hand-over/.test(s ?? "")), ["You took over the browser", "You handed the browser back"]);
  assert.equal(got.filter((m) => m.type === "run.needs_input" && m.data.pending?.kind === "browser").length, 1, "one run.needs_input for the ask");

  // The viewer's token, and the ask's record, are in no file but their own.
  assert.deepEqual(filesUnder(w.server.data).filter(([, bytes]) => bytes.includes(w.handed.token)).map(([path]) => path), [join(runFolder(w.server.data, w.runId), "browser-live", `${w.handed.tag}.json`)]);
  assert.equal((await w.server.api("POST", `/runs/${w.runId}/messages`, { content: "That is all." })).status, 202);
  await follow(w.server.api, w.runId, ["completed"], { after: after.after });
  assert.deepEqual(filesUnder(w.server.data).filter(([, bytes]) => bytes.includes(record) || bytes.includes(w.handed.token)), [], "gone with the run's process");
  assert.equal((await w.server.api("POST", `/runs/${w.runId}/archive`)).status, 200);
  assert.ok(!JSON.stringify((await w.server.api("GET", `/runs/${w.runId}`)).body).includes(w.handed.token));
  ws.destroy();
});

test("an ask nobody answers expires: the agent hears expired, the timeline says so, and a hand-back after it is 409 with expired", { timeout: 180_000 }, async (t) => {
  const w = await watched(t, { faux: BROWSE_HANDOFF, env: { FAUX_BROWSER_PERSON_MS: "1500,60000" } });
  const answered = await until(async () => /Hand-off:/.test((await w.view()).pending?.question ?? "") && (await w.view()).pending.question, 30_000);
  assert.match(answered || "", /"outcome":"expired"/, JSON.stringify({ view: await w.view(), rows: summaries(await w.rows()) }));
  assert.ok(summaries(await w.rows()).includes("The agent's hand-over expired before you answered it"));
  const late = await w.handBack("done");
  assert.deepEqual([late.status, late.json.error.code, late.json.error.details], [409, "handoff_answered", { outcome: "expired" }]);
  assert.equal(late.json.error.message, "The agent's hand-over expired before this answer: the agent was told it expired.");
});

/** Kills the run's process while its agent's ask is open (its session kept at the vendor), and waits for the run's next
 *  process: the server opens the run again, since its turn is still open. */
async function restartedMidAsk(w) {
  const holderOf = () => runRecordOf(w.server.data, w.runId).holder?.pid;
  const first = holderOf();
  process.kill(first, "SIGKILL");
  assert.ok(await until(() => { const pid = holderOf(); return pid !== undefined && pid !== first; }, 60_000), "the run's process was started again");
  const view = await w.view();
  assert.deepEqual([view.status, view.pending?.kind], ["input_required", "browser"], "and the run still waits on the person in its browser");
}

test("a restart while the ask is open: the new process takes up the wait, and the owner's hand-back reaches the agent", { timeout: 180_000 }, async (t) => {
  const w = await watched(t, { faux: BROWSE_HANDOFF, env: { FAUX_BROWSER_STATE: join(await scratch(t), "vendor-sessions.json") } });
  await restartedMidAsk(w);
  const done = await w.handBack("done");
  assert.deepEqual([done.status, done.json], [200, { outcome: "done" }]);
  const answered = await until(async () => /Hand-off:/.test((await w.view()).pending?.question ?? "") && (await w.view()).pending.question, 30_000);
  assert.match(answered || "", /"outcome":"done"/, "the agent's call returned done");
});

test("a restart while the ask is open and nobody answers: the new process expires it, and the agent hears expired", { timeout: 180_000 }, async (t) => {
  const w = await watched(t, { faux: BROWSE_HANDOFF, env: { FAUX_BROWSER_STATE: join(await scratch(t), "vendor-sessions.json"), FAUX_BROWSER_PERSON_MS: "15000,60000" } });
  await restartedMidAsk(w);
  const answered = await until(async () => /Hand-off:/.test((await w.view()).pending?.question ?? "") && (await w.view()).pending.question, 60_000);
  assert.match(answered || "", /"outcome":"expired"/, "the agent heard expired");
});

test("a restart between the ask's record and its waiting row: the next process commits the row, so the run shows the request and run.needs_input is sent once", { timeout: 240_000 }, async (t) => {
  const got = [];
  const receiver = createServer((req, res) => { const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => { got.push(Buffer.concat(chunks).toString("utf8")); res.writeHead(200).end(); }); });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (receiver.close(resolve), receiver.closeAllConnections())));
  // The run's first process dies once, right after it writes the ask's record and before its row is committed.
  const died = join(await scratch(t), "died");
  const w = await watched(t, { faux: BROWSE_HANDOFF, env: { FAUX_BROWSER_STATE: join(await scratch(t), "vendor-sessions.json"), FAUX_BROWSER_ASK_DIES: died, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, hook: { url: `http://127.0.0.1:${receiver.address().port}/hook` } });
  assert.ok(existsSync(died), "the first process died between the record and the row");
  const view = await w.view();
  assert.deepEqual([view.status, view.pending?.kind, view.pending?.instruction], ["input_required", "browser", ASK.instruction]);
  assert.equal((await w.rows()).filter((row) => row.kind === "waiting").length, 1, "one waiting row");
  assert.ok(await until(() => got.some((body) => body.includes("run.needs_input"))), "run.needs_input sent");
  await sleep(1_500);
  assert.equal(got.filter((body) => body.includes("run.needs_input")).length, 1, "once");
  const done = await w.handBack("done");
  assert.deepEqual([done.status, done.json], [200, { outcome: "done" }]);
});

test("an ask whose words echo a value the server holds as a key shows it cut, never in the clear: in the run's pending, the run list, its waiting row and the run.needs_input message", { timeout: 180_000 }, async (t) => {
  const held = `held-${randomBytes(16).toString("hex")}`;
  const got = [];
  const receiver = createServer((req, res) => { const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => { got.push(Buffer.concat(chunks).toString("utf8")); res.writeHead(200).end(); }); });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (receiver.close(resolve), receiver.closeAllConnections())));
  const w = await watched(t, { faux: BROWSE_HANDOFF, env: { FAUX_HELD_API_KEY: held, FAUX_ECHO_VALUE: held, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, hook: { url: `http://127.0.0.1:${receiver.address().port}/hook` } });
  const view = await w.view();
  assert.equal(view.pending?.kind, "browser");
  assert.ok(!view.pending.instruction.includes(held) && view.pending.instruction.includes(ASK.instruction), `pending.instruction: ${view.pending.instruction}`);
  assert.ok(!view.pending.completion_condition.includes(held), `pending.completion_condition: ${view.pending.completion_condition}`);
  const waiting = (await w.rows()).findLast((row) => row.kind === "waiting");
  assert.ok(waiting?.summary.startsWith(`Waiting for you: ${ASK.instruction} using `), waiting?.summary);
  for (const path of [`/runs/${w.runId}`, `/runs/${w.runId}/timeline`, "/runs", "/agents/drive/runs"]) assert.ok(!JSON.stringify((await w.server.api("GET", path)).body).includes(held), `${path} holds no held value`);
  assert.ok(await until(() => got.some((body) => body.includes("run.needs_input"))), "run.needs_input sent");
  assert.ok(!got.some((body) => body.includes(held)), "the message holds no held value");
});

test("cap: the agent's ask holds the person's 15 minutes first; with no room no ask is made and the tool's result says why", { timeout: 180_000 }, async (t) => {
  // Paused at its cap, the run's process is let go, its browser's session and its viewer's hand-over with it: the test
  // goes on only once that has happened (as on a slow machine), so it never depends on catching the hand-over first.
  const handoverGone = async (server, runId, dir) => assert.ok(await until(async () => !(await readdir(dir).then((names) => names.some((name) => name.endsWith(".json")), () => false)) && runRecordOf(server.data, runId).holder?.pid === undefined, 60_000), "the paused run's process let go");
  const w = await watched(t, { faux: BROWSE_HANDOFF, cap: 0.03, settled: handoverGone, viewer: false });
  const view = await w.view();
  // The agent's own step the cap refused: its tool's result says so, and the run waits on a raise, as for any paid call.
  assert.equal(view.pending?.kind, "budget", `no browser ask; paused at the cap: ${JSON.stringify(view.pending)}`);
  assert.match(view.pending.said, /the next step, handing the browser to you, could cost up to \$0\.03 /);
  const result = (await w.rows()).findLast((row) => row.kind === "tool_result" && row.tool_name === "browser_request_handoff");
  assert.match(JSON.stringify(result), /No person could take the browser: spend_cap_reached/);
  assert.ok(!(await w.rows()).some((row) => row.kind === "waiting" && row.summary?.startsWith("Waiting for you: Sign in")));
  assert.equal((await w.handBack("done")).status, 404);
});

test("capabilities say the owner may watch, take over and answer the agent's ask", async (t) => {
  const { api } = await serve(t);
  assert.deepEqual((await api("GET", "/capabilities")).body.features.browser_live, { read_only: false, take_over: true, ask: true });
});

test("an answer the owner gives after the run's process died, before the server finds it gone, still reaches the agent: the run is started again, and its hand-off's result says done", { timeout: 240_000 }, async (t) => {
  const w = await watched(t, { faux: BROWSE_HANDOFF, env: { FAUX_BROWSER_STATE: join(await scratch(t), "vendor-sessions.json") } });
  // The server's check of a gone process is held, so the owner answers in between, as a slow check would let them.
  let entered;
  const reached = new Promise((resolve) => (entered = resolve));
  let letGo;
  const held = new Promise((resolve) => (letGo = resolve));
  runsTestHooks.beforeRestartCheck = async (runDir) => { if (runDir.endsWith(w.runId)) { entered(); await held; } };
  t.after(() => { delete runsTestHooks.beforeRestartCheck; });
  const holderOf = () => runRecordOf(w.server.data, w.runId).holder?.pid;
  const first = holderOf();
  process.kill(first, "SIGKILL");
  await reached;
  const done = await w.handBack("done");
  assert.deepEqual([done.status, done.json], [200, { outcome: "done" }]);
  letGo();
  assert.ok(await until(() => { const pid = holderOf(); return pid !== undefined && pid !== first; }, 60_000), "a replacement process started");
  const answered = await until(async () => /Hand-off:/.test((await w.view()).pending?.question ?? "") && (await w.view()).pending.question, 30_000);
  assert.match(answered || "", /"outcome":"done"/, "the agent's call returned done");
});

test("the owner's Hand back in the viewer answers the agent's open ask on that session done: the agent hears done at once, and a later Done from the console is that answer, not a second", { timeout: 180_000 }, async (t) => {
  const w = await watched(t, { faux: BROWSE_HANDOFF });
  const { ws } = await w.viewer();
  ws.sendJson({ type: "take" });
  assert.deepEqual(await w.next(ws, "hold"), { type: "hold", held: true });
  await w.typed(ws, "my own password");
  ws.sendJson({ type: "give" });
  assert.deepEqual(await w.next(ws, "hold"), { type: "hold", held: false, reason: "given" });
  // Within a few seconds, not at the ask's 15-minute expiry.
  const question = await until(async () => /Hand-off:/.test((await w.view()).pending?.question ?? "") && (await w.view()).pending.question, 15_000);
  assert.match(question || "", /"outcome":"done"/, `the agent heard done: ${JSON.stringify({ question, rows: summaries(await w.rows()) })}`);
  const later = await w.handBack("done");
  assert.deepEqual([later.status, later.json], [200, { outcome: "done" }], "the same answer again is that answer");
  const other = await w.handBack("cancelled");
  assert.deepEqual([other.status, other.json.error.code, other.json.error.details], [409, "handoff_answered", { outcome: "done" }]);
  assert.equal((await w.rows()).filter((row) => row.kind === "tool_result" && row.tool_name === "browser_request_handoff" && row.tool_result_size_bytes !== null).length, 1, "one result for the ask");
  ws.destroy();
});
