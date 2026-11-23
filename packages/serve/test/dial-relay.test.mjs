// A dial provider's machine under a runner in a process of its own (--no-runner and `agentrun-serve runner`; the image's
// server-and-runner): the machine dials the server's one public address, and the server relays its socket to the runner
// that made it (dial-relay.ts). The runner mints the machine's token into the shared store with its name and incarnation
// on the row, and serves its own attach hub on a private listener; the server's attach upgrade sees another runner owns
// the token and opens a socket to that listener with the proxy's proof (live-reach.ts), keeping its own attach limits.
//
// The first test is two processes: a server started with --no-runner, and a runner started apart on the same data with
// the server's public address. A run whose agent's computer is --faux's dial provider (faux-computers.ts faux-dial, whose
// machine dials the address it is given, as agentrun-dial does) uses its computer, and the provider's row says nothing of
// a runner apart. The rest drive the relay's parts against a server: a runner's relay in this process over the same data
// (a runner-role store, the server's seal key), machines that dial the server, and stand-in runner listeners.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket, { WebSocketServer } from "ws";
import { agent, client, follow, printed, scratch, startServe } from "./support.mjs";

const { ATTACH_PATH, ATTACH_SUBPROTOCOL, AttachHub, HostedProvider, MAX_LINE_BYTES, RUN_LABEL } = await import("@parcha/agentrun-computer");
const { fakeHost } = await import("../../computer/test/fake-host.mjs");
const { createAttachRoutes, liveRelays, sha256Hex } = await import("../dist/computer-attach.js");
const { LIVE_PROOF_HEADER, liveReachOf } = await import("../dist/live-reach.js");
const { ofStore, openRunnerStore, startRunnerProcess } = await import("../dist/runner/main.js");
const { keepPresence } = await import("../dist/runner/presence.js");
const { openSqliteStore } = await import("../dist/store/index.js");
const { bootSealKey } = await import("../dist/seal-key.js");
const { fauxComputers } = await import("../dist/faux-computers.js");

/** The relay's own module and the proof's: absent before the relay, so each test that needs them says so alone. */
const relayModule = () => import("../dist/dial-relay.js");
async function proofs() {
  const live = await import("../dist/live-reach.js");
  assert.equal(typeof live.relayProof, "function", "live-reach.ts gives the relay's proof (relayProof)");
  return live;
}

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
/** A faux model that takes a screenshot, types, then answers "Typed it." (the attach end-to-end test's). */
const FAUX_ATTACH = new URL("./fixtures/faux-attach.mjs", import.meta.url).pathname;
const TOKEN = `ar_test_${"d".repeat(40)}`;
const YEAR_MS = 365 * 24 * 3_600_000;
/** A machine token as the server mints one: art_ and its random part. Never in a log line or an error. */
const MINTED = /art_[A-Za-z0-9_-]{16,}/;
/** The fix a runner with no relay names for a dial provider (workspace/attached-computers.ts ONE_PROCESS_FIX). */
const FIX = "start the image with the server options alone, without server-and-runner (outside the image: agentrun-serve without --no-runner)";
const DIAL_APART = `no run on this server can use Faux dial: its machines dial this server, and its runner runs in a process of its own, with no attach hub to take their socket: ${FIX}`;
/** The hello a minted desktop's machine says, as faux-dial's does. */
const HELLO = { protocol: "0.2", version: "test", os: "linux", kind: "desktop", arch: "amd64", groups: ["screen", "input.pointer", "input.keys"], screen: { width: 1, height: 1, scale: 1 } };
/** A mint as a dial provider's create makes one, for a computer of run `run` (its agentrun.run label) where given. */
const MINT = (run) => ({ kind: "desktop", os: "linux", arch: "amd64", expiresAt: new Date(Date.now() + 3_600_000), ...(run ? { run } : {}) });
const FAUX_DIAL_ENTRY = () => fauxComputers().kinds.PROVIDERS.find((one) => one.id === "faux-dial");

/** Every row of provider `id` in GET /v2/computers' kinds. */
const rowsOf = (view, id) => view.kinds.flatMap((kind) => kind.providers.filter((one) => one.id === id));

async function until(read, done, what, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() >= end) assert.fail(`${what}: last ${JSON.stringify(value)}`);
    await sleep(100);
  }
}

/** A child process of the CLI, its output kept, stopped (SIGTERM, then SIGKILL) at the test's end. */
function cliChild(t, args, env) {
  const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const said = { out: "", err: "" };
  child.stdout.on("data", (chunk) => void (said.out += chunk));
  child.stderr.on("data", (chunk) => void (said.err += chunk));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([exited, sleep(10_000).then(() => child.kill("SIGKILL"))]);
  });
  return { child, said };
}

/** A server with --no-runner in a process of its own: its address, its API, and what it printed. */
async function apartServer(t, data) {
  const { child, said } = cliChild(t, ["--data", data, "--port", "0", "--faux", FAUX_ATTACH, "--no-runner"], { AGENTRUN_ACCOUNTS: "0", AGENTRUN_TOKEN: TOKEN, AGENTRUN_PUBLIC_URL: "" });
  const out = await printed(child, /^Open /m);
  const port = Number(/^agentrun-serve on http:\/\/127\.0\.0\.1:(\d+)\/v2 /m.exec(out)[1]);
  const address = `http://127.0.0.1:${port}`;
  return { address, api: client(`${address}/v2`, TOKEN), said: () => `${out}${said.out}${said.err}` };
}

test("two processes: a server with --no-runner and a runner apart with the server's public address; a run on a dial provider uses its computer through the relay, and the provider's row says nothing of a runner apart", { timeout: 180_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const server = await apartServer(t, data);
  const runner = cliChild(t, ["runner", "--data", data, "--faux", FAUX_ATTACH], { AGENTRUN_PUBLIC_URL: server.address });
  await until(async () => runner.said.out, (out) => /^Runner .* ready: /m.test(out) || runner.child.exitCode !== null, "the runner says it is ready", 60_000);
  assert.equal(runner.child.exitCode, null, `the runner runs: ${runner.said.err}`);

  // Settings → Computers: the dial provider's row says nothing of a runner apart, and its test reads its account.
  const row = await until(async () => rowsOf((await server.api("GET", "/computers")).body, "faux-dial")[0], (one) => one?.runs_refused === null, "faux-dial's runs_refused goes null while the runner relays its dials");
  assert.equal(row.ready, true, JSON.stringify(row));
  const tested = await server.api("POST", "/computers/faux-dial/test");
  assert.equal(tested.body.ok, true, JSON.stringify(tested.body));

  // The run: its computer's machine dials the server, which relays the socket to the runner; a screenshot, then typing.
  const made = await server.api("POST", "/agents", agent("typist", { computer: { kind: "desktop", provider: "faux-dial" } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const run = await server.api("POST", "/agents/typist/runs", { input: { content: "Open a text editor and type." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { last, rows } = await follow(server.api, run.body.run_id, ["completed", "failed", "cancelled"], { deadlineMs: 120_000 });
  const read = await server.api("GET", `/runs/${run.body.run_id}`);
  assert.equal(last.status, "completed", `the run ended ${last.status}: ${JSON.stringify(read.body)}\n${runner.said.err}`);
  assert.equal(read.body.result?.final_answer, "Typed it.");
  const tools = JSON.stringify(rows);
  assert.ok(!/computer_unavailable|did not dial|no attach hub/.test(tools), `no computer call was refused: ${tools.slice(0, 2_000)}`);
  // The server relayed the machine's socket and the runner's hub took it; neither side's output carries its token.
  assert.match(server.said(), new RegExp(`event=machine_relayed run=${run.body.run_id} machine=faux-dial-`), "the server relayed the machine's dial, its line naming the run");
  assert.match(runner.said.err, /machine_attached/, "the runner's hub took the machine");
  assert.doesNotMatch(`${server.said()}${runner.said.out}${runner.said.err}`, MINTED, "no machine token in either process's output");
});

test("two processes: a runner apart with no public address of the server's relays nothing, and a dial provider's row and test keep the runner-apart words", { timeout: 120_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const server = await apartServer(t, data);
  const runner = cliChild(t, ["runner", "--data", data, "--faux", FAUX_ATTACH], { AGENTRUN_PUBLIC_URL: "" });
  await until(async () => runner.said.out, (out) => /^Runner .* ready: /m.test(out) || runner.child.exitCode !== null, "the runner says it is ready", 60_000);
  const row = rowsOf((await server.api("GET", "/computers")).body, "faux-dial")[0];
  assert.equal(row?.runs_refused, DIAL_APART);
  const tested = await server.api("POST", "/computers/faux-dial/test");
  assert.deepEqual(tested.body, { ok: false, why: DIAL_APART });
});

/** A server in this process with no runner beside it, its log lines kept, on its own data. */
async function relayServer(t, options = {}) {
  const data = join(await scratch(t), "agents");
  const lines = [];
  const server = await startServe({ data, port: 0, faux: FAUX_ATTACH, runnerApart: true, log: (line) => void lines.push(line), ...options });
  t.after(() => server.close());
  return { data, lines, server, address: server.baseUrl.replace(/\/v2$/, "") };
}

/** The runner's side over the server's data, as a runner apart opens it: its own store connection and the seal key. */
async function runnerSide(t, data) {
  const warned = [];
  const { store } = await openRunnerStore(data, {}, (line) => void warned.push(line), undefined);
  const seal = await bootSealKey(store, data, { given: undefined, role: "runner" });
  t.after(async () => {
    seal.release();
    await store.close();
  });
  return { store, seal, warned };
}

/** A runner's word that it is there over the runner's side (presence.ts), as a runner process keeps it, closed at the
 *  test's end after its relay. */
function presenceOf(t, side, runner) {
  const presence = keepPresence(side.store.runners, runner, null);
  t.after(() => presence.close());
  return presence;
}

/** A runner's relay over the runner's side, on its presence, its log lines kept, closed at the test's end. */
async function relayOf(t, side, address, runner = "runner-a") {
  const { startRunnerRelay } = await relayModule();
  const lines = [];
  const presence = presenceOf(t, side, runner);
  const relay = await startRunnerRelay({ store: side.store, sealKey: side.seal.key, runner, presence, env: { AGENTRUN_PUBLIC_URL: address }, log: (line) => void lines.push(line) });
  assert.ok(relay, "a runner with the server's public address has a relay");
  assert.equal(relay.incarnation, presence.incarnation, "the relay's incarnation is its runner's");
  t.after(() => relay.close());
  return { relay, lines, presence };
}

/** Every machine's socket a test dialed, ended at the file's end (one a test paused never answers a close). */
const machines = new Set();
after(() => {
  for (const ws of machines) ws.terminate();
});

/**
 * A machine's dial of `address`'s attach socket with `token`, as agentrun-dial makes it: hello and ping answered, every
 * text frame and the close kept. `opened` settles with true once open, or the refusal's status and words.
 */
function machine(address, token, { maxPayload = MAX_LINE_BYTES, headers = {} } = {}) {
  const ws = new WebSocket(`${address.replace(/^http/, "ws")}${ATTACH_PATH}`, ATTACH_SUBPROTOCOL, { headers: { authorization: `Bearer ${token}`, ...headers }, maxPayload, perMessageDeflate: false });
  machines.add(ws);
  const texts = [];
  ws.on("error", () => undefined);
  const closed = new Promise((resolve) => ws.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") })));
  const opened = new Promise((resolve) => {
    ws.once("open", () => resolve(true));
    ws.once("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (chunk) => void (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    ws.once("error", (error) => resolve({ error: error.message }));
  });
  ws.on("message", (data, binary) => {
    if (binary) return;
    const text = data.toString("utf8");
    texts.push(text);
    // A line that is no JSON (the frame-limit test's, should the relay ever let one through) is kept in `texts`, where
    // the test's assertions read it, and never throws out of this handler.
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.method === "hello") ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: HELLO }));
    else if (message.method === "ping") ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
  });
  return { ws, texts, opened, closed };
}

/** A token minted for `runner` in `incarnation` into `store`, as that runner's attach routes mint one (for run `run`). */
async function mintedFor(store, runner, incarnation, name = `m-${randomBytes(4).toString("hex")}`, run = undefined) {
  const routes = createAttachRoutes({ store, hub: new AttachHub(), machinesOnly: true, owner: { runner, incarnation } });
  return { name, token: await routes.machineTokens.mint(name, MINT(run)) };
}

/** A stand-in runner listener on loopback, recorded where `runner` answers: `onSocket` is given each socket it takes. */
async function standIn(t, store, runner, incarnation, onSocket, host = "127.0.0.1") {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: () => ATTACH_SUBPROTOCOL });
  const http = createServer((_req, res) => void res.writeHead(404).end());
  http.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, req)));
  await new Promise((resolve) => http.listen(0, host, resolve));
  t.after(() => {
    for (const ws of wss.clients) ws.terminate();
    return new Promise((resolve) => (http.closeAllConnections(), http.close(() => resolve())));
  });
  await store.runners.put({ runner, incarnation, refused: null, host, port: http.address().port });
}

test("a close on either side of a relayed socket closes the other: the machine's close takes it off the runner's hub, and the runner's revoke closes the machine's socket with 4401", { timeout: 60_000 }, async (t) => {
  const { data, address } = await relayServer(t);
  const side = await runnerSide(t, data);
  const { relay } = await relayOf(t, side, address);
  const one = "m-close-1";
  const first = machine(address, await relay.dial.tokens.mint(one, MINT()));
  assert.equal(await first.opened, true);
  await until(async () => relay.dial.hub.online(one), Boolean, "the runner's hub takes the machine");
  first.ws.close(1000, "done");
  await until(async () => relay.dial.hub.online(one), (online) => online === false, "the machine's close takes it off the runner's hub");

  const two = "m-close-2";
  const second = machine(address, await relay.dial.tokens.mint(two, MINT()));
  assert.equal(await second.opened, true);
  await until(async () => relay.dial.hub.online(two), Boolean, "the runner's hub takes the second machine");
  await relay.dial.tokens.revoke(two);
  const closed = await Promise.race([second.closed, sleep(10_000).then(() => "hung")]);
  assert.equal(closed?.code, 4401, `the machine's socket closes with the runner's code: ${JSON.stringify(closed)}`);
});

test("a dial whose runner is gone (its relay closed), whose listener does not answer, or which restarted since is answered 503 in words naming the run (its machine after), never a hang, and the provider's wait ends in words", { timeout: 60_000 }, async (t) => {
  const { data, lines, address } = await relayServer(t);
  const side = await runnerSide(t, data);
  const { startRunnerRelay } = await relayModule();

  // Gone: its relay closed, its row answering nowhere.
  const gone = await startRunnerRelay({ store: side.store, sealKey: side.seal.key, runner: "runner-gone", presence: presenceOf(t, side, "runner-gone"), env: { AGENTRUN_PUBLIC_URL: address } });
  const left = await gone.dial.tokens.mint("m-gone", MINT("run-gone"));
  await gone.close();
  const refusedGone = await Promise.race([machine(address, left).opened, sleep(10_000).then(() => "hung")]);
  assert.equal(refusedGone.status, 503, JSON.stringify(refusedGone));
  assert.match(refusedGone.body, /^a dial for run run-gone \(machine m-gone\): runner runner-gone, which made it, is not running now/);
  await until(async () => lines.find((line) => line.includes("machine_relay_refused") && line.includes("m-gone")), Boolean, "the server's refusal line");
  assert.match(lines.find((line) => line.includes("machine_relay_refused") && line.includes("m-gone")), /"a dial for run run-gone \(machine m-gone\): runner runner-gone, which made it, is not running now/, "the server's line says the run too");

  // Not answering: its row names a port nothing listens on (a runner killed with no close).
  const dead = createServer();
  await new Promise((resolve) => dead.listen(0, "127.0.0.1", resolve));
  const port = dead.address().port;
  await new Promise((resolve) => dead.close(resolve));
  await side.store.runners.put({ runner: "runner-dead", incarnation: "inc-dead", refused: null, host: "127.0.0.1", port });
  const { token: deadToken } = await mintedFor(side.store, "runner-dead", "inc-dead", "m-dead", "run-dead");
  const refusedDead = await Promise.race([machine(address, deadToken).opened, sleep(15_000).then(() => "hung")]);
  assert.equal(refusedDead.status, 503, JSON.stringify(refusedDead));
  assert.match(refusedDead.body, /^a dial for run run-dead \(machine m-dead\): runner runner-dead, which made it, did not answer at 127\.0\.0\.1:\d+/);
  // A machine of no run (its create named none) is named by itself.
  const { token: noRunToken } = await mintedFor(side.store, "runner-dead", "inc-dead", "m-no-run");
  const refusedNoRun = await Promise.race([machine(address, noRunToken).opened, sleep(15_000).then(() => "hung")]);
  assert.equal(refusedNoRun.status, 503, JSON.stringify(refusedNoRun));
  assert.match(refusedNoRun.body, /^a dial for machine m-no-run: runner runner-dead, which made it, did not answer at /);

  // Restarted: the same runner's name under a new incarnation; the old machine's re-dial is refused, the new one's lands.
  // The earlier process's listener still up (it has not noticed): only its row's incarnation tells the server.
  const before = await startRunnerRelay({ store: side.store, sealKey: side.seal.key, runner: "runner-r", presence: presenceOf(t, side, "runner-r"), env: { AGENTRUN_PUBLIC_URL: address } });
  t.after(() => before.close());
  const old = await before.dial.tokens.mint("m-old", MINT("run-old"));
  const { relay: after } = await relayOf(t, side, address, "runner-r");
  assert.notEqual(after.incarnation, before.incarnation);
  const refusedOld = await Promise.race([machine(address, old).opened, sleep(10_000).then(() => "hung")]);
  assert.equal(refusedOld.status, 503, JSON.stringify(refusedOld));
  assert.match(refusedOld.body, /^a dial for run run-old \(machine m-old\): runner runner-r, which made it, restarted since/);
  const fresh = machine(address, await after.dial.tokens.mint("m-new", MINT()));
  assert.equal(await fresh.opened, true, "a fresh token of the runner's new incarnation lands");
  fresh.ws.close();

  // The provider's wait: its machine refused, the launch ends in words, naming no token.
  const routes = createAttachRoutes({ store: side.store, hub: new AttachHub(), machinesOnly: true, owner: { runner: "runner-dead", incarnation: "inc-dead" } });
  const waited = await fauxComputers().launch(FAUX_DIAL_ENTRY(), { kind: "desktop", keys: {}, run: "run-wait" }, { dial: { url: address, tokens: routes.machineTokens, hub: new AttachHub() } }).then(() => undefined, (error) => error);
  assert.ok(waited instanceof Error, "the launch fails");
  assert.match(waited.message, /^the faux dial machine faux-dial-[0-9a-f]+'s dial to http:\/\/127\.0\.0\.1:\d+ was refused: HTTP 503: a dial for run run-wait \(machine faux-dial-[0-9a-f]+\): runner runner-dead, which made it, did not answer at /);
  assert.doesNotMatch(waited.message, MINTED);
});

test("one incarnation per runner process: its word that it is there and the tokens its relay mints name the same process, and a token its earlier process minted is refused as restarted since", { timeout: 60_000 }, async (t) => {
  const { data, address } = await relayServer(t);
  const side = await runnerSide(t, data);
  /** A runner process named runner-one over the server's data, with the server's public address: the dial its relay
   *  hands its loops (no run is queued, so none is claimed). */
  const start = async () => {
    let dial;
    const started = await startRunnerProcess({
      dataDir: data, name: "runner-one", env: { AGENTRUN_PUBLIC_URL: address }, warn: () => undefined,
      createLoop: ofStore((_store, _key, given) => ((dial = given), () => assert.fail("no run is queued here"))),
    });
    t.after(() => started.close());
    assert.ok(dial, "a runner with the server's public address hands its loops its relay's dial");
    return { started, dial };
  };
  const rowOf = async () => (await side.store.runners.list()).find((row) => row.runner === "runner-one");
  const first = await start();
  const token = await first.dial.tokens.mint("m-first", MINT("run-first"));
  const minted = await side.store.mintedTokens.byToken(sha256Hex(token));
  const row = await until(rowOf, Boolean, "the runner's word that it is there");
  assert.equal(row.incarnation, minted?.incarnation, "the runner's row and the token its relay minted name one incarnation");
  assert.equal(row.host, "127.0.0.1", "its row says where its relay answers");
  assert.equal(typeof row.port, "number");
  const landed = machine(address, token);
  assert.equal(await landed.opened, true, "its machine's dial lands");
  landed.ws.close();
  // Its next process under the same name (a restart): the earlier process's token is refused, in words that say so.
  await first.started.close();
  await start();
  await until(rowOf, (one) => one !== undefined && one.incarnation !== row.incarnation, "the restart's row");
  const refused = await Promise.race([machine(address, token).opened, sleep(10_000).then(() => "hung")]);
  assert.equal(refused.status, 503, JSON.stringify(refused));
  assert.match(refused.body, /^a dial for run run-first \(machine m-first\): runner runner-one, which made it, restarted since/);
});

test("a relay's liveness is read on the store's clock: over a store whose clock is a year behind this process's, a runner whose relay said it is there is live, and its machine's dial is relayed to it", { timeout: 60_000 }, async (t) => {
  const store = await openSqliteStore({ file: join(await scratch(t), "store.sqlite"), now: () => Date.now() - YEAR_MS });
  t.after(() => store.close());
  let took = false;
  await standIn(t, store, "runner-behind", "inc-behind", () => void (took = true));
  // The server's attach socket over that store, reading its runners' relays.
  const routes = createAttachRoutes({ store, hub: new AttachHub(), relay: { runners: store.runners, reach: liveReachOf({}, randomBytes(32)) } });
  const http = createServer((_req, res) => void res.writeHead(404).end());
  http.on("upgrade", (req, socket, head) => routes.upgrade(req, socket, head, (status, words = "") => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\ncontent-length: ${Buffer.byteLength(words)}\r\n\r\n${words}`)));
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await routes.close();
    http.closeAllConnections();
    await new Promise((resolve) => http.close(() => resolve()));
  });
  const { token } = await mintedFor(store, "runner-behind", "inc-behind", "m-behind", "run-behind");
  const dial = machine(`http://127.0.0.1:${http.address().port}`, token);
  assert.equal(await dial.opened, true, "its dial is relayed: on the store's clock its runner is there");
  await until(async () => took, Boolean, "the runner's listener took the socket");
  dial.ws.close();
  // And the server's read of which runners relay (server.ts relayed, Settings → Computers): the same row, on the same clock.
  assert.deepEqual((await liveRelays(store.runners)).map((one) => [one.runner, one.host]), [["runner-behind", "127.0.0.1"]]);
});

test("a runner that answers at an address in one of the server's runners' blocks (AGENTRUN_RUNNER_HOSTS as an IPv4 block) has its machine's dial relayed there; one outside every block is refused 503 in words", { timeout: 60_000, skip: process.platform === "linux" ? false : "127.0.0.2 answers as loopback on Linux alone" }, async (t) => {
  const store = await openSqliteStore({ file: join(await scratch(t), "store.sqlite") });
  t.after(() => store.close());
  let took = 0;
  // A runner on "another host": 127.0.0.2, which Linux answers on loopback, so the server's dial of the row's host is the
  // one under test, with no network.
  await standIn(t, store, "runner-pod", "inc-pod", () => void (took += 1), "127.0.0.2");
  const serverOn = async (hosts) => {
    const routes = createAttachRoutes({ store, hub: new AttachHub(), relay: { runners: store.runners, reach: liveReachOf({ AGENTRUN_RUNNER_HOSTS: hosts }, randomBytes(32)) } });
    const http = createServer((_req, res) => void res.writeHead(404).end());
    http.on("upgrade", (req, socket, head) => routes.upgrade(req, socket, head, (status, words = "") => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\ncontent-length: ${Buffer.byteLength(words)}\r\n\r\n${words}`)));
    await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      await routes.close();
      http.closeAllConnections();
      await new Promise((resolve) => http.close(() => resolve()));
    });
    return `http://127.0.0.1:${http.address().port}`;
  };
  const inside = machine(await serverOn("127.0.0.0/8"), (await mintedFor(store, "runner-pod", "inc-pod", "m-pod-1", "run-pod")).token);
  assert.equal(await inside.opened, true, "an address in the block is dialled");
  await until(async () => took, (n) => n === 1, "the runner's listener took the socket");
  inside.ws.close();
  const outside = machine(await serverOn("10.32.0.0/14"), (await mintedFor(store, "runner-pod", "inc-pod", "m-pod-2", "run-pod")).token);
  const refused = await outside.opened;
  assert.equal(refused.status, 503);
  assert.match(refused.body, /runner runner-pod, which made it, answers at 127\.0\.0\.2, which is not one of this server's runners' hosts/);
  assert.equal(took, 1, "nothing outside the block is dialled");
});

test("a real dial provider's create on a runner apart ends at once in the server's words when the server will not relay its machine's dial (the runner answers at a host this server does not dial), not at createMs", { timeout: 60_000 }, async (t) => {
  const { data, lines, address } = await relayServer(t);
  const side = await runnerSide(t, data);
  const { relay, presence } = await relayOf(t, side, address, "runner-far");
  // The runner's row names a host the server was not given (AGENTRUN_RUNNER_HOSTS): a runner on another host the
  // server's operator did not list.
  await presence.relay({ host: "runner-far.example", port: relay.port });
  // A dial host whose machine dials the server's public address with its token, as agentrun-dial does.
  const fake = fakeHost({ facts: { connect: "dial", lifetime: "janitor" }, onBoot: (m) => void machine(address, m.boot.AGENTRUN_ATTACH_TOKEN) });
  const daemonPath = join(await scratch(t), "computerd");
  writeFileSync(daemonPath, "a stand-in for computerd\n");
  const createMs = 30_000;
  const provider = new HostedProvider(fake.host, { daemonPath, timeouts: { createMs, pollMs: 50 }, dial: relay.dial });
  const started = Date.now();
  const made = await provider.create({ image: "img", lifetimeMs: 600_000, network: "none", labels: { [RUN_LABEL]: "run-far" } }, { requestId: "relay-refused-1" });
  const took = Date.now() - started;
  assert.equal(made.ok, false, "the create fails");
  assert.equal(made.error.code, "refused", made.error.message);
  assert.match(made.error.message, /the server refused a dial for run run-far \(machine computer-[0-9a-f]{12}\): runner runner-far, which made it, answers at runner-far\.example, which is not one of this server's runners' hosts/);
  assert.doesNotMatch(made.error.message, MINTED);
  assert.ok(took < createMs / 3, `the create ended at the server's refusal, not at createMs: ${took} ms`);
  assert.deepEqual(fake.live(), [], "the machine was deleted");
  assert.ok(lines.some((line) => line.includes("machine_relay_refused") && line.includes("run-far")), lines.join("\n"));
  assert.ok(!lines.some((line) => MINTED.test(line)), "no token in the server's lines");
});

test("the runner's attach listener answers nothing without the server's proof, on loopback too: none, a wrong key's, a stale one's, another runner's, another token's, and a replay are each 401; the server's own proof opens it once", { timeout: 60_000 }, async (t) => {
  const { data, address } = await relayServer(t);
  const side = await runnerSide(t, data);
  const { relay } = await relayOf(t, side, address);
  const { relayProof, relayKeyOf, RELAY_PROOF_MS } = await proofs();
  const listener = `http://${relay.host}:${relay.port}`;
  const key = relayKeyOf(side.seal.key);
  const token = await relay.dial.tokens.mint("m-proof", MINT());
  const to = { tokenSha256: sha256Hex(token), runner: "runner-a", incarnation: relay.incarnation };
  const tried = async (proof) => {
    const dial = machine(listener, token, proof === undefined ? {} : { headers: { [LIVE_PROOF_HEADER]: proof } });
    const opened = await dial.opened;
    if (opened === true) dial.ws.close();
    return opened === true ? 101 : opened.status;
  };
  assert.equal(await tried(undefined), 401, "no proof");
  assert.equal(await tried(relayProof(relayKeyOf(randomBytes(32)), to)), 401, "another seal key's proof");
  assert.equal(await tried(relayProof(key, to, Date.now() - RELAY_PROOF_MS - 1_000)), 401, "a proof older than its window");
  assert.equal(await tried(relayProof(key, to, Date.now() + RELAY_PROOF_MS + 1_000)), 401, "a proof from past its window");
  assert.equal(await tried(relayProof(key, { ...to, runner: "runner-b" })), 401, "a proof for another runner");
  assert.equal(await tried(relayProof(key, { ...to, incarnation: "another" })), 401, "a proof for another incarnation");
  assert.equal(await tried(relayProof(key, { ...to, tokenSha256: sha256Hex("art_another") })), 401, "a proof for another token");
  const proof = relayProof(key, to);
  assert.equal(await tried(proof), 101, "the server's proof for this token, runner and incarnation opens it");
  assert.equal(await tried(proof), 401, "the same proof again (a captured one) opens no second socket");
  assert.equal(await tried(`0${proof}`), 401, "the same proof with a leading zero on its time opens no second socket");
  assert.equal(await tried(`00${proof}`), 401, "the same proof with two leading zeros on its time opens no second socket");
});

test("the runner takes a relay proof once under any spelling of its time: one taken plain is refused with one or two leading zeros, one taken with a leading zero is refused plain, and a proof at another time is still taken", async () => {
  const { relayProof, relayProofs, relayKeyOf, LIVE_PROOF_HEADER: header } = await proofs();
  const key = relayKeyOf(randomBytes(32));
  const to = { tokenSha256: sha256Hex("art_respelled"), runner: "runner-a", incarnation: "inc-a" };
  const at = 1_800_000_000_000;
  const taker = relayProofs(key, () => at);
  const proven = (req) => taker(req, to);
  const said = (proof) => ({ headers: { [header]: proof } });
  const proof = relayProof(key, to, at);
  assert.equal(proven(said(proof)), true, "the server's proof is taken");
  assert.equal(proven(said(`0${proof}`)), false, "taken plain, then resent with a leading zero on its time");
  assert.equal(proven(said(`00${proof}`)), false, "taken plain, then resent with two leading zeros on its time");
  const later = relayProof(key, to, at - 1);
  assert.equal(proven(said(`0${later}`)), true, "a proof at another time is taken, here with a leading zero first");
  assert.equal(proven(said(later)), false, "taken with a leading zero, then resent plain");
});

test("the runner's attach listener refuses, with the server's proof, a token whose row names another runner, and one the server's own process minted", { timeout: 60_000 }, async (t) => {
  const { data, address } = await relayServer(t);
  const side = await runnerSide(t, data);
  const { relay } = await relayOf(t, side, address);
  const { relayProof, relayKeyOf } = await proofs();
  const listener = `http://${relay.host}:${relay.port}`;
  const key = relayKeyOf(side.seal.key);
  const proven = async (token) => {
    const dial = machine(listener, token, { headers: { [LIVE_PROOF_HEADER]: relayProof(key, { tokenSha256: sha256Hex(token), runner: "runner-a", incarnation: relay.incarnation }) } });
    const opened = await dial.opened;
    if (opened === true) dial.ws.close();
    return opened === true ? 101 : opened.status;
  };
  // Another runner's, in this very incarnation's id: the runner's name alone decides it.
  const { token: theirs } = await mintedFor(side.store, "runner-b", relay.incarnation);
  assert.equal(await proven(theirs), 401, "a token whose row names runner-b");
  const server = createAttachRoutes({ store: side.store, hub: new AttachHub(), machinesOnly: true });
  assert.equal(await proven(await server.machineTokens.mint("m-server", MINT())), 401, "a token the server's own process minted");
  assert.equal(await proven(await relay.dial.tokens.mint("m-own", MINT())), 101, "its own token opens it");
});

test("no dial token goes into a log line or an error on either side: the server's and the runner's lines and every refusal say the run and its machine, never its token", { timeout: 60_000 }, async (t) => {
  const { data, lines, address } = await relayServer(t);
  const side = await runnerSide(t, data);
  const { relay, lines: relayLines } = await relayOf(t, side, address);
  const tokens = [];
  const said = [];
  const mint = async (name) => {
    const token = await relay.dial.tokens.mint(name, MINT(`run-of-${name}`));
    tokens.push(token);
    return token;
  };
  // Relayed and taken, then closed.
  const ok = machine(address, await mint("m-said-1"));
  assert.equal(await ok.opened, true);
  await until(async () => relay.dial.hub.online("m-said-1"), Boolean, "taken");
  ok.ws.close();
  // Refused by the runner's listener (revoked between the server's read and the runner's), and by the server (gone).
  const revoked = await mint("m-said-2");
  await side.store.mintedTokens.revoke("m-said-2");
  const refused = await machine(address, revoked).opened;
  said.push(JSON.stringify(refused));
  const stale = await mint("m-said-3");
  await relay.close();
  const gone = await machine(address, stale).opened;
  assert.equal(gone.status, 503, JSON.stringify(gone));
  said.push(gone.body);
  await sleep(200);
  const all = [...lines, ...relayLines, ...side.warned, ...said].join("\n");
  assert.ok(all.includes("a dial for run run-of-m-said-3 (machine m-said-3)"), `the words name the run, then the machine: ${all}`);
  assert.ok([...lines].join("\n").includes("a dial for run run-of-m-said-3"), `the server's line names the run: ${lines.join("\n")}`);
  for (const token of tokens) {
    assert.ok(!all.includes(token), `a token in a line: ${all}`);
    assert.ok(!all.includes(sha256Hex(token)), `a token's hash in a line: ${all}`);
  }
  assert.doesNotMatch(all, MINTED);
});

test("the relay keeps the server's attach limits: a frame over MAX_LINE_BYTES from either side ends both sockets with 1009, and never reaches the other", { timeout: 60_000 }, async (t) => {
  const { data, address } = await relayServer(t);
  const side = await runnerSide(t, data);
  const { relayKeyOf, relayProofs } = await proofs();
  const proven = relayProofs(relayKeyOf(side.seal.key));
  const big = "x".repeat(MAX_LINE_BYTES + 1);

  // From the runner's side: a stand-in listener that takes the server's proof, then sends one frame over the limit.
  const runnerClosed = [];
  await standIn(t, side.store, "runner-big", "inc-big", (ws, req) => {
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    if (!proven(req, { tokenSha256: sha256Hex(bearer), runner: "runner-big", incarnation: "inc-big" })) return ws.close(4401);
    ws.on("close", (code) => runnerClosed.push(code));
    ws.send(big);
  });
  const { token } = await mintedFor(side.store, "runner-big", "inc-big");
  // The machine itself would take the frame: only the server's limit stops it.
  const dial = machine(address, token, { maxPayload: 4 * MAX_LINE_BYTES });
  assert.equal(await dial.opened, true);
  const closed = await Promise.race([dial.closed, sleep(10_000).then(() => "hung")]);
  assert.equal(closed?.code, 1009, `the machine's socket ends 1009: ${JSON.stringify(closed)}`);
  assert.deepEqual(dial.texts.filter((text) => text.length > MAX_LINE_BYTES), [], "the frame over the limit never reached the machine");

  // From the machine's side: one frame over the limit ends both, the runner's with it.
  const taken = [];
  await standIn(t, side.store, "runner-big-2", "inc-big-2", (ws) => {
    ws.on("message", (frame) => void taken.push(frame.length));
    ws.on("close", (code) => runnerClosed.push(code));
  });
  const { token: second } = await mintedFor(side.store, "runner-big-2", "inc-big-2");
  const sender = machine(address, second);
  assert.equal(await sender.opened, true);
  sender.ws.send(big);
  const senderClosed = await Promise.race([sender.closed, sleep(10_000).then(() => "hung")]);
  assert.equal(senderClosed?.code, 1009, JSON.stringify(senderClosed));
  await until(async () => runnerClosed.length, (count) => count >= 2, "both runner-side sockets closed");
  assert.deepEqual(taken, [], "the frame over the limit never reached the runner");
});

test("the relay keeps the server's attach idle timeout: a machine that answers nothing is closed 4408, and the runner's side with it", { timeout: 60_000 }, async (t) => {
  const { data, address } = await relayServer(t, { attachTiming: { heartbeatMs: 100, idleMs: 600 } });
  const side = await runnerSide(t, data);
  let ended;
  const closedRunner = new Promise((resolve) => (ended = resolve));
  await standIn(t, side.store, "runner-idle", "inc-idle", (ws) => ws.on("close", (code) => ended(code)));
  const { token } = await mintedFor(side.store, "runner-idle", "inc-idle");
  const dial = machine(address, token);
  assert.equal(await dial.opened, true);
  // Nothing read from here on, so no ping is answered.
  dial.ws._socket.pause();
  const code = await Promise.race([closedRunner, sleep(10_000).then(() => "hung")]);
  assert.equal(code, 4408, "the runner's side closes with the server's idle code");
});
