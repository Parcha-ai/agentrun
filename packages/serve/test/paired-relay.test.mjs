// A person's own computer, paired with a server whose runner runs in a process of its own (--no-runner and
// `agentrun-serve runner`; the image's server-and-runner): the box's driver dials the server's one public address, and
// the server relays its socket to the runner that holds a run using it, by #3170's relay (dial-relay.ts): the proxy's
// proof under the seal key (live-reach.ts), its host allow-list, joinSockets' limits. The box's route, one server setting
// (`paired_route:<computer id>`: the runner, its incarnation, the run, the hold's end, a refusal) written by
// compare-and-set as computer_kept:<run id> is, says where the socket goes: the server's own hub while no run holds the
// box, the holding runner's listener while one does. A route goes stale only when its runner is not live or restarted,
// or its run is over (ended, stopped or failed); its `until` is the hold's end, shown, never judged. A move is the
// server's close with 1001 and the box's own redial; nothing changes on the box.
//
// Shape copied from dial-relay.test.mjs (its two-process test, relayServer, runnerSide, relayOf and its machine dial)
// and computer-attach-e2e.test.mjs (the paired driver). The first two tests are two processes; the rest drive the
// relay's parts against a server in this process and a runner's relay over the same data.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

/** The serve package's folder. */
const SERVE = new URL("../", import.meta.url);
const at = (path) => new URL(path, SERVE);

const { default: WebSocket } = await import(at("../../node_modules/ws/wrapper.mjs").href);
const { ATTACH_PATH, ATTACH_SUBPROTOCOL, RUN_LABEL } = await import(at("../computer/dist/index.js").href);
const { agent, client, follow, printed, scratch, startServe } = await import(at("test/support.mjs").href);
const { attachDriver, DRIVER_HELLO, pairDriver } = await import(at("test/fixtures/attach-driver.mjs").href);
const { TYPED } = await import(at("test/fixtures/faux-attach.mjs").href);
const { sha256Hex } = await import(at("dist/computer-attach.js").href);
const { LIVE_PROOF_HEADER, relayKeyOf, relayProof } = await import(at("dist/live-reach.js").href);
const { openRunnerStore } = await import(at("dist/runner/main.js").href);
const { keepPresence } = await import(at("dist/runner/presence.js").href);
const { bootSealKey } = await import(at("dist/seal-key.js").href);
const { pairedRelayOn, startRunnerRelay } = await import(at("dist/dial-relay.js").href);
const { pairedProvider } = await import(at("dist/workspace/attached-computers.js").href);

const CLI = fileURLToPath(at("dist/cli.js"));
/** A faux model that takes a screenshot, types, then answers "Typed it." (the attach end-to-end test's). */
const FAUX_ATTACH = fileURLToPath(at("test/fixtures/faux-attach.mjs"));
const TOKEN = `ar_test_${"e".repeat(40)}`;
const NAME = "desk-1";
/** A paired computer's token as pairing gives one: art_ and its random part. Never in a log line or an error. */
const PAIRED_TOKEN = /art_[A-Za-z0-9_-]{16,}/;
/** The one-process fix every runner-apart line names (workspace/attached-computers.ts ONE_PROCESS_FIX). */
const FIX = "start the image with the server options alone, without server-and-runner (outside the image: agentrun-serve without --no-runner)";
/** A hold's end an hour out, as a run's route carries it. */
const UNTIL = () => Date.now() + 3_600_000;

async function until(read, done, what, ms = 20_000) {
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
  const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, AGENTRUN_TELEMETRY: "0", ...env }, stdio: ["ignore", "pipe", "pipe"] });
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

/** A runner apart over `data`, with `publicUrl` as the server's public address ("" for none), once it says it is ready. */
async function apartRunner(t, data, publicUrl) {
  const runner = cliChild(t, ["runner", "--data", data, "--faux", FAUX_ATTACH], { AGENTRUN_PUBLIC_URL: publicUrl });
  await until(async () => runner.said.out, (out) => /^Runner .* ready: /m.test(out) || runner.child.exitCode !== null, "the runner says it is ready", 60_000);
  assert.equal(runner.child.exitCode, null, `the runner runs: ${runner.said.err}`);
  return runner;
}

/** Waits until the server sees a runner of its relaying (#3170: faux-dial's row goes null then). */
async function relaying(api) {
  await until(async () => (await api("GET", "/computers")).body.kinds.flatMap((kind) => kind.providers).find((one) => one.id === "faux-dial"), (row) => row?.runs_refused === null, "a runner apart relays (faux-dial's runs_refused null)", 30_000);
}

const pairedRow = (view, id) => view.paired?.find((one) => one.id === id);

test("two processes: a server with --no-runner and a runner apart that relays; a run whose agent's computer is a paired box takes a screenshot and types through it, its socket relayed to the runner that holds the run, and the box comes back to the server idle at the run's end", { timeout: 240_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const server = await apartServer(t, data);
  const runner = await apartRunner(t, data, server.address);
  await relaying(server.api);
  const listed = () => server.api("GET", "/computers");

  const pairing = await server.api("POST", "/computers/pairings", {});
  assert.equal(pairing.status, 201, JSON.stringify(pairing.body));
  const paired = await pairDriver({ address: server.address, code: pairing.body.code, name: NAME });
  assert.equal(paired.status, 201, JSON.stringify(paired.body));
  const { computer, token } = paired.body;
  let atInput;
  const driver = attachDriver({ address: server.address, token, scale: 0.05, onActions: async () => void (atInput = pairedRow((await listed()).body, computer)) });
  t.after(() => driver.stop());
  driver.start();
  await until(listed, (res) => pairedRow(res.body, computer)?.online === true, "the box is listed online, idle on the server");

  const made = await server.api("POST", "/agents", agent("typist", { computer: { kind: "desktop", provider: computer } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const run = await server.api("POST", "/agents/typist/runs", { input: { content: "Open a text editor and type." } });
  assert.equal(run.status, 202, `a run on a paired box starts while a runner apart relays: ${JSON.stringify(run.body)}`);
  const { last, rows } = await follow(server.api, run.body.run_id, ["completed", "failed", "cancelled"], { deadlineMs: 150_000 });
  const read = await server.api("GET", `/runs/${run.body.run_id}`);
  assert.equal(last.status, "completed", `the run whose computer is a paired box ends completed, its socket relayed to the runner that holds the run; it ended ${last.status}: ${JSON.stringify(read.body).slice(0, 2_000)}\n${runner.said.err.slice(-2_000)}`);
  assert.equal(read.body.result?.final_answer, "Typed it.");
  const tools = JSON.stringify(rows);
  assert.ok(!/computer_unavailable|held by the server process|relays no computer/.test(tools), `no computer call was refused: ${tools.slice(0, 2_000)}`);
  const methods = driver.calls.map((call) => call.method);
  assert.ok(methods.includes("screen.shot") && methods.includes("input.actions"), `the box answered the run's calls: ${methods}`);
  assert.deepEqual(driver.calls.find((call) => call.method === "input.actions").params.actions, [{ type: "type", text: TYPED }]);

  // While the run typed, the row named the run and the runner whose hub held the box.
  assert.equal(atInput?.held_by_run, run.body.run_id, `the row names the run that holds the box: ${JSON.stringify(atInput)}`);
  assert.equal(typeof atInput?.held_on, "string", `the row names the runner that holds it (held_on): ${JSON.stringify(atInput)}`);
  assert.equal(atInput.online, true, "a relayed box is listed online");
  assert.equal(atInput.runs_refused, null);

  // The server relayed the box's socket, the runner's hub took it, and no token is in either process's output.
  assert.match(server.said(), new RegExp(`event=computer_relayed run=${run.body.run_id} computer=${computer}`), "the server relayed the box's dial, its line naming the run");
  assert.match(runner.said.err, new RegExp(`computer_attached.*computer=${computer}`), "the runner's hub took the box");
  assert.doesNotMatch(`${server.said()}${runner.said.out}${runner.said.err}`, PAIRED_TOKEN, "no paired token in either process's output");

  // At the run's end the box comes back to the server, idle and still attached.
  await until(listed, (res) => {
    const row = pairedRow(res.body, computer);
    return row?.online === true && row.held_by_run === null && row.held_on === null;
  }, "released at the run's end and back on the server, still attached", 30_000);
});

test("two processes: while a runner apart relays, the pairing code, the pair answer, the box's row and its provider row say nothing of a runner apart; on a server whose runner has no relay they keep the words, which name AGENTRUN_PUBLIC_URL and the one-process fix", { timeout: 240_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const server = await apartServer(t, data);
  await apartRunner(t, data, server.address);
  await relaying(server.api);
  const pairing = await server.api("POST", "/computers/pairings", {});
  assert.equal(pairing.status, 201, JSON.stringify(pairing.body));
  assert.equal(pairing.body.runs_refused, null, "the pairing code says nothing of a runner apart while a runner relays");
  const paired = await pairDriver({ address: server.address, code: pairing.body.code, name: NAME });
  assert.equal(paired.status, 201, JSON.stringify(paired.body));
  assert.equal(paired.body.runs_refused, null, "the pair answer says nothing of a runner apart while a runner relays");
  const view = (await server.api("GET", "/computers")).body;
  assert.equal(pairedRow(view, paired.body.computer)?.runs_refused, null, "the box's row says nothing of a runner apart");
  for (const row of view.kinds.flatMap((kind) => kind.providers).filter((one) => one.id === paired.body.computer)) assert.equal(row.runs_refused, null, "its provider row says nothing of a runner apart");

  // A runner with no public address of the server's relays nothing: the words stay, naming both fixes.
  const bare = join(await scratch(t), "agents");
  const lone = await apartServer(t, bare);
  await apartRunner(t, bare, "");
  const refused = await lone.api("POST", "/computers/pairings", {});
  assert.equal(refused.status, 201, JSON.stringify(refused.body));
  assert.match(String(refused.body.runs_refused), /^no run on this server can use a paired computer: /);
  assert.ok(String(refused.body.runs_refused).includes("AGENTRUN_PUBLIC_URL"), `the words name the relay's fix: ${refused.body.runs_refused}`);
  assert.ok(String(refused.body.runs_refused).includes(FIX), `the words name the one-process fix: ${refused.body.runs_refused}`);
});

/** A server in this process with no runner beside it (`runnerApart` false: with its runner beside it), its log lines
 *  kept, on its own data. */
async function relayServer(t, { runnerApart = true } = {}) {
  const data = join(await scratch(t), "agents");
  const lines = [];
  const server = await startServe({ data, port: 0, faux: FAUX_ATTACH, runnerApart, log: (line) => void lines.push(line) });
  t.after(() => server.close());
  return { data, lines, server, api: client(server.baseUrl, server.token), address: server.baseUrl.replace(/\/v2$/, "") };
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

/** A runner's relay over the runner's side, on a presence of its own, its log lines kept, closed at the test's end. */
async function relayOf(t, side, address, runner = "runner-a") {
  const lines = [];
  const presence = keepPresence(side.store.runners, runner, null);
  t.after(() => presence.close());
  const relay = await startRunnerRelay({ store: side.store, sealKey: side.seal.key, runner, presence, env: { AGENTRUN_PUBLIC_URL: address }, log: (line) => void lines.push(line) });
  assert.ok(relay, "a runner with the server's public address has a relay");
  t.after(() => relay.close());
  return { relay, lines, presence };
}

/** The runner beside a server in this process, as runner/beside.ts starts it: a presence under the name and incarnation
 *  the server made for it (Serve.beside), with no relay, and the paired computers' bring and let-go over the server's own
 *  hub (dial-relay.js pairedRelayOn). Absent before this work, which is the beside route this file asks for. */
function besideOf(t, side, server) {
  assert.equal(typeof server.beside?.runner, "string", "the server names the runner beside it (Serve.beside.runner), the name its routes carry");
  assert.equal(typeof server.beside.incarnation, "string", "and that runner's incarnation (Serve.beside.incarnation), new at each start");
  assert.equal(typeof pairedRelayOn, "function", "the runner beside the server brings a paired box over the server's own hub (dial-relay.js pairedRelayOn)");
  const { runner, incarnation } = server.beside;
  const presence = keepPresence(side.store.runners, runner, null, { incarnation });
  t.after(() => presence.close());
  const relayed = pairedRelayOn({ store: side.store, hub: server.attachHub, runner, incarnation });
  t.after(() => relayed.stop());
  return { runner, incarnation, paired: relayed.paired, stopSweep: () => relayed.stop() };
}

/** A box paired with the server in this process: its id and token. */
async function pairedBox(api, address) {
  const pairing = await api("POST", "/computers/pairings", {});
  assert.equal(pairing.status, 201, JSON.stringify(pairing.body));
  const paired = await pairDriver({ address, code: pairing.body.code, name: NAME });
  assert.equal(paired.status, 201, JSON.stringify(paired.body));
  return paired.body;
}

/** The routes of paired computers, kept in the store's settings (workspace/paired-route.js): absent before this work,
 *  which is the relay this file asks for. `route` takes it (true when taken), `took` says what a take came to (its words
 *  when refused), `unroute` drops a runner's own, `get` reads it (runner null when none). `runs` is what a take reads the
 *  route's run from (the store's runs unless a test gives its own). */
async function routing(store, { runs = store.runs } = {}) {
  const module = await import(at("dist/workspace/paired-route.js").href).catch(() => undefined);
  assert.equal(typeof module?.takeRoute, "function", "the server routes a paired computer to the runner that holds its run, in its settings row paired_route:<id> (workspace/paired-route.js takeRoute)");
  assert.equal(typeof module.dropRoute, "function", "a runner drops its own route of a paired computer (paired-route.js dropRoute)");
  const deps = { settings: store.settings, runners: store.runners, runs };
  return {
    route: async (id, want) => (await module.takeRoute(deps, id, want)).taken,
    took: (id, want) => module.takeRoute(deps, id, want, { name: NAME }),
    unroute: (id, mine) => module.dropRoute(store.settings, id, mine),
    get: (id) => module.readRoute(store.settings, id),
  };
}

/** Every box socket a test dialed, ended at the file's end. */
const boxes = new Set();
after(() => {
  for (const ws of boxes) ws.terminate();
});

/** One dial of `address`'s attach socket with the box's `token`, as its driver makes it: hello and ping answered, every
 *  close kept. `opened` settles with true once open, or the refusal's status and words. With `answer` (a promise), the
 *  box answers hello only once it settles; `asked` settles when the hello comes. */
function box(address, token, { headers = {}, answer } = {}) {
  const ws = new WebSocket(`${address.replace(/^http/, "ws")}${ATTACH_PATH}`, ATTACH_SUBPROTOCOL, { headers: { authorization: `Bearer ${token}`, ...headers }, perMessageDeflate: false });
  boxes.add(ws);
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
  let heard;
  const asked = new Promise((resolve) => (heard = resolve));
  ws.on("message", (data, binary) => {
    if (binary) return;
    let message;
    try {
      message = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    if (message.method === "hello") {
      heard();
      void Promise.resolve(answer).then(() => ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: DRIVER_HELLO })));
    } else if (message.method === "ping") ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
  });
  return { ws, opened, closed, asked };
}

test("the runner's attach listener takes a paired box's socket only with the server's proof and only while the box's row routes it to this runner and incarnation: a row routed nowhere or elsewhere, no proof and a replay are each 401", { timeout: 60_000 }, async (t) => {
  const { data, api, address } = await relayServer(t);
  const side = await runnerSide(t, data);
  const { relay } = await relayOf(t, side, address, "runner-a");
  const { computer, token } = await pairedBox(api, address);
  const listener = `http://${relay.host}:${relay.port}`;
  const key = relayKeyOf(side.seal.key);
  const to = { tokenSha256: sha256Hex(token), runner: "runner-a", incarnation: relay.incarnation };
  const tried = async (proof) => {
    const dial = box(listener, token, proof === undefined ? {} : { headers: { [LIVE_PROOF_HEADER]: proof } });
    const opened = await dial.opened;
    if (opened === true) dial.ws.close();
    return opened === true ? 101 : opened.status;
  };
  assert.equal(await tried(relayProof(key, to)), 401, "a good proof for a box whose row routes it nowhere");
  const paired = await routing(side.store);
  assert.equal(await paired.route(computer, { runner: "runner-b", incarnation: "inc-b", run: "run-b", until: UNTIL() }), true);
  assert.equal(await tried(relayProof(key, to)), 401, "a good proof for a box routed to another runner");
  assert.equal(await paired.unroute(computer, { runner: "runner-b", incarnation: "inc-b" }), true);
  assert.equal(await paired.route(computer, { runner: "runner-a", incarnation: relay.incarnation, run: "run-a", until: UNTIL() }), true);
  assert.equal(await tried(undefined), 401, "no proof");
  assert.equal(await tried(relayProof(key, { ...to, incarnation: "another" })), 401, "a proof for another incarnation");
  const proof = relayProof(key, to);
  assert.equal(await tried(proof), 101, "the server's proof for this token, runner and incarnation opens it, the row routing the box here");
  assert.equal(await tried(proof), 401, "the same proof again (a captured one) opens no second socket");
});

test("a paired box routed to a runner that is gone, or that restarted since, is answered 503 in words naming the box and the run, never a hang and never its token; the stale route is dropped, its words kept on the row, and its next dial lands on the server, idle", { timeout: 60_000 }, async (t) => {
  const { data, lines, api, address } = await relayServer(t);
  const side = await runnerSide(t, data);
  const { computer, token } = await pairedBox(api, address);
  const paired = await routing(side.store);
  const rowOf =async () => pairedRow((await api("GET", "/computers")).body, computer);

  // Gone: its relay closed, its runner's row answering nowhere.
  const { relay: gone } = await relayOf(t, side, address, "runner-gone");
  assert.equal(await paired.route(computer, { runner: "runner-gone", incarnation: gone.incarnation, run: "run-gone", until: UNTIL() }), true);
  await gone.close();
  const first = await Promise.race([box(address, token).opened, sleep(10_000).then(() => "hung")]);
  assert.equal(first.status, 503, JSON.stringify(first));
  assert.match(first.body, new RegExp(`^${NAME} \\(${computer}\\) for run run-gone: runner runner-gone, which holds it, is not running now`));
  assert.doesNotMatch(first.body, PAIRED_TOKEN);
  assert.equal((await paired.get(computer)).runner, null, "the stale route is dropped");
  assert.match(String((await rowOf())?.hold_note), /runner runner-gone, which holds it, is not running now/, "the row says why, until the box attaches again");
  const home = box(address, token);
  assert.equal(await home.opened, true, "the box's next dial lands on the server");
  await until(rowOf, (row) => row?.online === true && row.held_by_run === null && row.held_on === null && row.hold_note === null, "online and idle on the server");
  home.ws.close();
  await until(rowOf, (row) => row?.online === false, "offline once its socket closes");

  // Restarted: the same runner's name under a new incarnation; the route names the earlier process's.
  const { relay: before } = await relayOf(t, side, address, "runner-r");
  assert.equal(await paired.route(computer, { runner: "runner-r", incarnation: before.incarnation, run: "run-r", until: UNTIL() }), true);
  const { relay: later } = await relayOf(t, side, address, "runner-r");
  assert.notEqual(later.incarnation, before.incarnation);
  const old = await Promise.race([box(address, token).opened, sleep(10_000).then(() => "hung")]);
  assert.equal(old.status, 503, JSON.stringify(old));
  assert.match(old.body, new RegExp(`^${NAME} \\(${computer}\\) for run run-r: runner runner-r, which holds it, restarted since`));
  const back = box(address, token);
  assert.equal(await back.opened, true, "its next dial lands on the server");
  back.ws.close();

  // The server's lines say the box and the run, never its token.
  await until(async () => lines.filter((line) => line.includes("computer_relay_refused")).length, (count) => count >= 2, "the server's refusal lines");
  assert.match(lines.find((line) => line.includes("computer_relay_refused") && line.includes("run-gone")), new RegExp(`computer=${computer}`));
  assert.doesNotMatch(lines.join("\n"), PAIRED_TOKEN, "no paired token in the server's lines");
});

test("a close on either side of a relayed paired socket closes the other: the box's close takes it off the runner's hub, and the runner's stop closes the box's socket with 1001, which it redials", { timeout: 60_000 }, async (t) => {
  const { data, lines, api, address } = await relayServer(t);
  const side = await runnerSide(t, data);
  const { relay, lines: runnerLines } = await relayOf(t, side, address, "runner-a");
  const { computer, token } = await pairedBox(api, address);
  assert.equal(await (await routing(side.store)).route(computer, { runner: "runner-a", incarnation: relay.incarnation, run: "run-a", until: UNTIL() }), true);

  const first = box(address, token);
  assert.equal(await first.opened, true, "the box's dial is relayed to the runner the row names");
  await until(async () => relay.dial.hub.online(computer), Boolean, "the runner's hub takes the box");
  first.ws.close(1000, "done");
  await until(async () => relay.dial.hub.online(computer), (online) => online === false, "the box's close takes it off the runner's hub");

  const second = box(address, token);
  assert.equal(await second.opened, true);
  await until(async () => relay.dial.hub.online(computer), Boolean, "the runner's hub takes the box again");
  await relay.close();
  const closed = await Promise.race([second.closed, sleep(10_000).then(() => "hung")]);
  assert.equal(closed?.code, 1001, `the runner's stop closes the box's socket with 1001: ${JSON.stringify(closed)}`);
  assert.match(lines.join("\n"), new RegExp(`computer_relayed run=run-a computer=${computer}`), "the server's line names the run and the box");
  assert.doesNotMatch(`${lines.join("\n")}\n${runnerLines.join("\n")}`, PAIRED_TOKEN, "no paired token in either side's lines");
});

test("a paired box whose route leaves the runner while it says hello there (its run's bring cancelled, the route dropped) is closed with 1001 in words saying it moved, never 4401: its pairing stays good and its redial to the runner its route names attaches; a box whose pairing is revoked at the same point is closed with 4401", { timeout: 60_000 }, async (t) => {
  const { data, api, address } = await relayServer(t);
  const side = await runnerSide(t, data);
  const { relay } = await relayOf(t, side, address, "runner-a");
  const { computer, token } = await pairedBox(api, address);
  const listener = `http://${relay.host}:${relay.port}`;
  const key = relayKeyOf(side.seal.key);
  const mine = { runner: "runner-a", incarnation: relay.incarnation };
  const proved = { tokenSha256: sha256Hex(token), ...mine };
  // Each dial carries a proof of its own (the listener takes a proof once).
  let proofs = 0;
  const proof = () => ({ [LIVE_PROOF_HEADER]: relayProof(key, proved, Date.now() + proofs++) });
  const paired = await routing(side.store);
  /** A dial of the runner's listener whose box answers hello only once `then` (called at the hello) is done. */
  const heldDial = async (then) => {
    let answer;
    const dial = box(listener, token, { headers: proof(), answer: new Promise((resolve) => (answer = resolve)) });
    assert.equal(await dial.opened, true, "the runner's listener takes the box, its route naming this runner");
    await dial.asked;
    await then();
    answer();
    return Promise.race([dial.closed, sleep(10_000).then(() => "hung")]);
  };

  // Moved: the route dropped between the box's dial and its hello's answer, as a cancelled bring drops it.
  assert.equal(await paired.route(computer, { ...mine, run: "run-a", until: UNTIL() }), true);
  const moved = await heldDial(async () => assert.equal(await paired.unroute(computer, { ...mine, run: "run-a" }), true));
  assert.equal(moved?.code, 1001, `a box whose route left this runner while it said hello is closed with 1001, its redial routed, never 4401 (pair again): ${JSON.stringify(moved)}`);
  assert.match(moved.reason, new RegExp(`^${NAME} moved while it said hello`), "the close's words say it moved");
  await until(async () => relay.dial.hub.online(computer), (online) => online === false, "the runner's hub does not keep it");
  assert.equal((await side.store.pairedComputers.get(computer))?.revokedAt, null, "its pairing stays good");
  assert.ok(pairedRow((await api("GET", "/computers")).body, computer), "the server still lists it as paired");
  assert.equal(await paired.route(computer, { ...mine, run: "run-b", until: UNTIL() }), true);
  const again = box(listener, token, { headers: proof() });
  assert.equal(await again.opened, true, "its redial, routed to this runner again, is taken");
  await until(async () => relay.dial.hub.online(computer), Boolean, "the runner's hub takes the box again: nothing of it was revoked");
  again.ws.close(1000, "done");
  await until(async () => relay.dial.hub.online(computer), (online) => online === false, "off the runner's hub once it closes");

  // Revoked: the pairing revoked at the same point (its row alone, so only the check after hello sees it).
  const revoked = await heldDial(async () => assert.equal(await side.store.pairedComputers.revoke(computer), true));
  assert.equal(revoked?.code, 4401, `a box whose pairing was revoked while it said hello is closed with 4401: ${JSON.stringify(revoked)}`);
  assert.match(revoked.reason, /pair it again/, "its words say to pair it again");
});

test("a paired box's hold holds across the relay: the runner lets the box go only once every remove or KILL its hold sent has answered; meanwhile its row still routes it there and no other run's runner takes it; then the box comes back to the server", { timeout: 60_000 }, async (t) => {
  const { data, api, address } = await relayServer(t);
  const side = await runnerSide(t, data);
  const { relay } = await relayOf(t, side, address, "runner-a");
  const { computer, token } = await pairedBox(api, address);
  const paired = await routing(side.store);
  assert.equal(typeof relay.paired?.letGo, "function", "the runner's relay lets a paired box go once its hold ended (RunnerRelay.paired.letGo)");
  assert.equal(await paired.route(computer, { runner: "runner-a", incarnation: relay.incarnation, run: "run-a", until: UNTIL() }), true);
  const driver = attachDriver({ address, token, scale: 0.05 });
  t.after(() => driver.stop());
  driver.start();
  await until(async () => relay.dial.hub.online(computer), Boolean, "the runner's hub takes the box");

  const hub = relay.dial.hub;
  const hold = hub.claim(computer, { [RUN_LABEL]: "run-a" });
  assert.ok(hold, "the run holds the box on the runner's hub");
  let answer;
  hub.changing(computer, new Promise((resolve) => (answer = resolve)));
  const letting = relay.paired.letGo(computer, hold);
  await sleep(1_500);
  assert.equal((await paired.get(computer)).runner, "runner-a","while a remove or KILL it sent is unanswered, the box stays routed to the runner that holds it");
  assert.equal(await paired.route(computer, { runner: "runner-b", incarnation: "inc-b", run: "run-b", until: UNTIL() }), false, "no other run's runner takes it meanwhile");
  assert.equal(hub.online(computer), true, "the box stays on the runner's hub meanwhile");
  answer();
  await letting;
  assert.equal((await paired.get(computer)).runner, null, "its route goes once the answer came");
  // The row reads idle at once (no route), while the box is still relayed until the server's next tick moves it.
  await until(async () => hub.online(computer), (online) => online === false, "the server's tick takes the box off the runner's hub once its route went");
  await until(async () => pairedRow((await api("GET", "/computers")).body, computer), (row) => row?.online === true && row.held_on === null && row.held_by_run === null, "the box comes back to the server, idle");
});

test("a run that moves runners takes its box along: a route moved to runner B for the same run moves the box's socket there by the same relay (the server's 1001 and the box's redial), runner A lets the run's hold go, and no other run's runner takes the route while B holds it", { timeout: 60_000 }, async (t) => {
  const { data, api, address } = await relayServer(t);
  const side = await runnerSide(t, data);
  const { relay: a } = await relayOf(t, side, address, "runner-a");
  const { relay: b } = await relayOf(t, side, address, "runner-b");
  const { computer, token } = await pairedBox(api, address);
  const paired = await routing(side.store);
  assert.equal(await paired.route(computer, { runner: "runner-a", incarnation: a.incarnation, run: "run-m", until: UNTIL() }), true);
  const driver = attachDriver({ address, token, scale: 0.05 });
  t.after(() => driver.stop());
  driver.start();
  await until(async () => a.dial.hub.online(computer), Boolean, "runner A's hub takes the box");
  assert.ok(a.dial.hub.claim(computer, { [RUN_LABEL]: "run-m" }), "the run holds the box on A");

  // The run parked on A and resumed on B: B's claim takes the route, the run's own.
  assert.equal(await paired.route(computer, { runner: "runner-b", incarnation: b.incarnation, run: "run-m", until: UNTIL() }), true, "the same run's resume on another runner takes its route");
  await until(async () => b.dial.hub.online(computer) && !a.dial.hub.online(computer), Boolean, "the box's socket moves to B", 20_000);
  await until(async () => a.dial.hub.hold(computer), (held) => held === undefined, "A lets the run's hold go once its box left for another runner");
  assert.equal(await paired.route(computer, { runner: "runner-a", incarnation: a.incarnation, run: "run-other", until: UNTIL() }), false, "another run's runner takes no route B holds");
  const row = pairedRow((await api("GET", "/computers")).body, computer);
  assert.equal(row?.held_on, "runner-b", `the row names B: ${JSON.stringify(row)}`);
  assert.equal(row?.held_by_run, "run-m");
});

test("a run past its route's first until keeps its box: until is the hold's end, shown and never judged, and a route goes stale only when its runner is not live or restarted, or its run is over; so the box stays relayed to the runner that holds the run, and a second run's take is refused", { timeout: 60_000 }, async (t) => {
  const { data, api, address } = await relayServer(t);
  const side = await runnerSide(t, data);
  const { relay: a } = await relayOf(t, side, address, "runner-a");
  const { relay: b } = await relayOf(t, side, address, "runner-b");
  const { computer, token } = await pairedBox(api, address);
  const paired = await routing(side.store);
  // The first until two seconds out; the run goes on past it.
  const first = Date.now() + 2_000;
  assert.equal(await paired.route(computer, { runner: "runner-a", incarnation: a.incarnation, run: "run-long", until: first }), true);
  const driver = attachDriver({ address, token, scale: 0.05 });
  t.after(() => driver.stop());
  driver.start();
  await until(async () => a.dial.hub.online(computer), Boolean, "runner A's hub takes the box");
  const hold = a.dial.hub.claim(computer, { [RUN_LABEL]: "run-long" });
  assert.ok(hold, "the run holds the box on A");

  // Past the first until, and three of the server's 1 s route ticks after it.
  await sleep(Math.max(0, first - Date.now()) + 3_500);
  assert.equal((await paired.get(computer)).runner, "runner-a", "past its first until, the route still names the runner that holds the run");
  assert.equal(a.dial.hub.online(computer), true, "the box stays on A's hub past its first until: no tick moved it");
  assert.equal(a.dial.hub.hold(computer), hold, "and the run's hold there is the same one");
  assert.equal(await paired.route(computer, { runner: "runner-b", incarnation: b.incarnation, run: "run-next", until: UNTIL() }), false, "a second run's take is refused while A is live, its until passed or not");
  await sleep(1_500);
  assert.equal(b.dial.hub.online(computer), false, "the box never moves to B");
  assert.equal(a.dial.hub.online(computer), true);
  const row = pairedRow((await api("GET", "/computers")).body, computer);
  assert.equal(row?.held_by_run, "run-long", `the row still names the long run: ${JSON.stringify(row)}`);
  assert.equal(row?.held_on, "runner-a");
});

test("a route left by a run that is over is taken by a new run, its runner still live: one left by a completed run, one by a cancelled run and one by a failed run; a route held by a live run on a live runner still refuses, and so does one whose run has no row or whose read throws, each after one read of the run", { timeout: 60_000 }, async (t) => {
  const { data, api, address } = await relayServer(t);
  const side = await runnerSide(t, data);
  const { relay: a } = await relayOf(t, side, address, "runner-a");
  const { relay: b } = await relayOf(t, side, address, "runner-b");
  const { computer } = await pairedBox(api, address);
  const paired = await routing(side.store);
  const made = await api("POST", "/agents", agent("plain"));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const revisionId = (await side.store.agents.get("plain")).currentRevision;
  /** A run of its own, claimed by `runner`: its claim, which ends it. */
  const runOf = async (id, runner) => {
    await side.store.runs.create({ id, agentId: "plain", revisionId }, { body: { input: { content: "Answer." } } });
    const claim = await side.store.claim(id, runner, { leaseMs: 60_000 });
    assert.ok(claim, `${runner} claims ${id}`);
    return claim;
  };

  // Completed: A's run ended and its route stayed (its release's drop never landed); A is still live.
  const done = await runOf("run-done", "runner-a");
  assert.equal(await paired.route(computer, { runner: "runner-a", incarnation: a.incarnation, run: "run-done", until: UNTIL() }), true);
  await side.store.runs.update(done, { state: "ended", outcome: "completed", summary: "done", endedAt: Date.now() });
  assert.equal(await paired.route(computer, { runner: "runner-b", incarnation: b.incarnation, run: "run-next-b", until: UNTIL() }), true, "a new run takes a route its completed run left, A live");
  assert.deepEqual([(await paired.get(computer)).runner, (await paired.get(computer)).run], ["runner-b", "run-next-b"]);
  assert.equal(await paired.unroute(computer, { runner: "runner-b", incarnation: b.incarnation }), true);

  // Cancelled: B's run stopped by a cancel, its route left; B is still live.
  const cancelled = await runOf("run-cancelled", "runner-b");
  assert.equal(await paired.route(computer, { runner: "runner-b", incarnation: b.incarnation, run: "run-cancelled", until: UNTIL() }), true);
  await side.store.runs.update(cancelled, { state: "stopped", outcome: "cancelled", endedAt: Date.now() });
  assert.equal(await paired.route(computer, { runner: "runner-a", incarnation: a.incarnation, run: "run-next-a", until: UNTIL() }), true, "a new run takes a route its cancelled run left, B live");
  assert.deepEqual([(await paired.get(computer)).runner, (await paired.get(computer)).run], ["runner-a", "run-next-a"]);
  assert.equal(await paired.unroute(computer, { runner: "runner-a", incarnation: a.incarnation }), true);

  // Failed: A's run failed, its route left; A is still live.
  const failed = await runOf("run-failed", "runner-a");
  assert.equal(await paired.route(computer, { runner: "runner-a", incarnation: a.incarnation, run: "run-failed", until: UNTIL() }), true);
  await side.store.runs.update(failed, { state: "failed", summary: "failed", endedAt: Date.now() });
  assert.equal(await paired.route(computer, { runner: "runner-b", incarnation: b.incarnation, run: "run-next-f", until: UNTIL() }), true, "a new run takes a route its failed run left, A live");
  assert.deepEqual([(await paired.get(computer)).runner, (await paired.get(computer)).run], ["runner-b", "run-next-f"]);
  assert.equal(await paired.unroute(computer, { runner: "runner-b", incarnation: b.incarnation }), true);

  // Live: A's run still going, A live: a new run on B is refused, and the route stays A's.
  await runOf("run-live", "runner-a");
  assert.equal(await paired.route(computer, { runner: "runner-a", incarnation: a.incarnation, run: "run-live", until: UNTIL() }), true);
  const live = await paired.took(computer, { runner: "runner-b", incarnation: b.incarnation, run: "run-next-live", until: UNTIL() });
  assert.equal(live.taken, false, "a route held by a live run on a live runner refuses");
  assert.equal(live.why, `${NAME} is held by run run-live on runner runner-a: one run at a time`);
  assert.deepEqual([(await paired.get(computer)).runner, (await paired.get(computer)).run], ["runner-a", "run-live"]);
  assert.equal(await paired.unroute(computer, { runner: "runner-a", incarnation: a.incarnation }), true);

  // Missing: A's route names a run the store has no row of (never made, or purged since); A is live. The take reads
  // that run once, finds nothing, and refuses as for a live run: a route is never taken on what the store can't say.
  assert.equal(await paired.route(computer, { runner: "runner-a", incarnation: a.incarnation, run: "run-gone", until: UNTIL() }), true);
  let reads = 0;
  const counted = await routing(side.store, { runs: { get: async (id) => (reads++, side.store.runs.get(id)) } });
  const missing = await counted.took(computer, { runner: "runner-b", incarnation: b.incarnation, run: "run-next-m", until: UNTIL() });
  assert.equal(missing.taken, false, "a route whose run has no row refuses");
  assert.equal(missing.why, `${NAME} is held by run run-gone on runner runner-a: one run at a time`);
  assert.equal(reads, 1, "one read of the route's run per refusal");
  assert.deepEqual([(await paired.get(computer)).runner, (await paired.get(computer)).run], ["runner-a", "run-gone"]);

  // Throws: the read of the route's run fails (the store away); the take refuses in the same words, never takes over,
  // and reads once, no retry.
  reads = 0;
  const blind = await routing(side.store, { runs: { get: async () => { reads++; throw new Error("the store is away"); } } });
  const threw = await blind.took(computer, { runner: "runner-b", incarnation: b.incarnation, run: "run-next-t", until: UNTIL() });
  assert.equal(threw.taken, false, "a route whose run's read throws refuses");
  assert.equal(threw.why, `${NAME} is held by run run-gone on runner runner-a: one run at a time`);
  assert.equal(reads, 1, "one read of the route's run, no retry");
  assert.deepEqual([(await paired.get(computer)).runner, (await paired.get(computer)).run], ["runner-a", "run-gone"]);
});

test("a server whose runner runs beside it moves a paired box too: a runner apart (on another host) takes its route, the server relays the box's socket there, and once that route is dropped the server's tick brings the box home, idle", { timeout: 60_000 }, async (t) => {
  const { data, api, address } = await relayServer(t, { runnerApart: false });
  const side = await runnerSide(t, data);
  const { relay } = await relayOf(t, side, address, "runner-a");
  const { computer, token } = await pairedBox(api, address);
  const paired = await routing(side.store);
  assert.equal(await paired.route(computer, { runner: "runner-a", incarnation: relay.incarnation, run: "run-a", until: UNTIL() }), true);
  const driver = attachDriver({ address, token, scale: 0.05 });
  t.after(() => driver.stop());
  driver.start();
  await until(async () => relay.dial.hub.online(computer), Boolean, "the runner apart's hub takes the box, relayed by a server whose runner runs beside it");

  // The runner apart's drop leaves no row (no note): only the server's tick, comparing the box's relayed socket with no
  // route, sends it home.
  assert.equal(await paired.unroute(computer, { runner: "runner-a", incarnation: relay.incarnation }), true);
  await until(async () => relay.dial.hub.online(computer), (online) => online === false, "the server's tick takes the box off the runner's hub once its route went, its own runner beside it", 10_000);
  await until(async () => pairedRow((await api("GET", "/computers")).body, computer), (row) => row?.online === true && row.held_on === null && row.held_by_run === null, "the box comes back to the server, idle");
});

test("a run's claim cancelled while its box is on its way ends the bring at once in words, the route it took let go; a claim cancelled before its bring takes nothing; and the provider's create answers aborted, never a hang", { timeout: 60_000 }, async (t) => {
  const { data, address } = await relayServer(t);
  const side = await runnerSide(t, data);
  const { relay } = await relayOf(t, side, address, "runner-a");
  const paired = await routing(side.store);
  const noRoute = { runner: null, incarnation: null, run: null, until: null, refused: null };
  const cancelledWords = `${NAME} was not brought to runner runner-a: this run's claim was cancelled while it waited for the box, and its route was let go`;
  /** How a bring or a create ended within three seconds: its value, its error, or "hung". */
  const within = (pending) => Promise.race([pending.then((value) => value, (error) => error), sleep(3_000).then(() => "hung")]);

  // No computer is paired with this server, so its tick leaves these routes alone: each bring waits for a box that
  // never comes, as it would for a driver slow to redial (PAIRED_BRING_MS is past a minute).
  const waiting = { id: "cmp-cancel0000000000a", name: NAME };
  const cancel = new AbortController();
  const bringing = relay.paired.bring(waiting, { run: "run-c", until: UNTIL(), signal: cancel.signal });
  await until(() => paired.get(waiting.id), (route) => route.runner === "runner-a" && route.run === "run-c", "the bring takes the route");
  cancel.abort();
  const ended = await within(bringing);
  assert.equal(ended?.code, "computer_unavailable", `the cancelled bring ends at once, in words: ${ended?.message ?? ended}`);
  assert.equal(ended.message, cancelledWords);
  assert.deepEqual(await paired.get(waiting.id), noRoute, "the route it took is let go, no note left");

  const early = { id: "cmp-cancel0000000000b", name: NAME };
  const before = await within(relay.paired.bring(early, { run: "run-d", until: UNTIL(), signal: AbortSignal.abort() }));
  assert.equal(before?.message, cancelledWords, `a bring whose claim was cancelled before it ends in the same words: ${before?.message ?? before}`);
  assert.deepEqual(await paired.get(early.id), noRoute, "and takes no route");

  // The provider passes its create's signal (the claim's cancel) to the bring, and answers aborted in its words.
  const desk = { id: "cmp-cancel0000000000c", name: NAME, hello: DRIVER_HELLO, labels: {} };
  const made = await within(pairedProvider(desk, undefined, relay.paired).create({ lifetimeMs: 3_600_000, labels: { [RUN_LABEL]: "run-e" } },{ requestId: "req-e", signal: AbortSignal.abort() }));
  assert.deepEqual(made, { ok: false, error: { code: "aborted", message: cancelledWords } }, "a create under a cancelled claim answers aborted");
  assert.deepEqual(await paired.get(desk.id), noRoute);
});

/** A server with its runner beside it, that runner's bring over the server's hub, a runner apart with a relay, and a
 *  paired box attached to the server: the provider of each runner for the box, and the box's driver. */
async function besideAndApart(t) {
  const { data, api, address, server } = await relayServer(t, { runnerApart: false });
  const side = await runnerSide(t, data);
  const beside = besideOf(t, side, server);
  const { relay } = await relayOf(t, side, address, "runner-a");
  const { computer, token } = await pairedBox(api, address);
  const paired = await routing(side.store);
  const driver = attachDriver({ address, token, scale: 0.05 });
  t.after(() => driver.stop());
  driver.start();
  await until(async () => server.attachHub.online(computer), Boolean, "the box attaches to the server's hub");
  const desk = { id: computer, name: NAME, hello: DRIVER_HELLO, labels: {} };
  return { api, server, beside, relay, computer, paired, driver, here: pairedProvider(desk, undefined, beside.paired), apart: pairedProvider(desk, undefined, relay.paired) };
}

/** A create's spec for run `run` on a paired box, an hour long, on its own network (the only one a paired box takes). */
const specOf = (run) => ({ lifetimeMs: 3_600_000, network: "open", labels: { [RUN_LABEL]: run } });

test("a run of the runner beside the server holds a paired box by a route of its own: a runner apart's take for another run is refused in words, and the box stays in the server's hub for the whole hold, no tick moving it; once that run releases it the route goes and the run apart takes the box; a beside take is then refused in the same words", { timeout: 60_000 }, async (t) => {
  const { api, server, beside, relay, computer, paired, driver, here, apart } = await besideAndApart(t);

  const made = await here.create(specOf("run-beside"), { requestId: "req-beside" });
  assert.equal(made.ok, true, `the beside run's create holds the box: ${JSON.stringify(made)}`);
  const hold = server.attachHub.hold(computer);
  assert.ok(hold, "the beside run holds the box on the server's hub");
  const route = await paired.get(computer);
  assert.deepEqual([route.runner, route.incarnation, route.run, route.refused], [beside.runner, beside.incarnation, "run-beside", null], "the beside run's hold takes a route naming the runner beside the server, as a runner apart's does");

  const refused = await apart.create(specOf("run-apart"), { requestId: "req-apart" });
  assert.deepEqual(refused, { ok: false, error: { code: "refused", message: `${NAME} is held by run run-beside on runner ${beside.runner}: one run at a time` } }, "a runner apart's take for another run is refused in words while the beside run holds the box");

  // Three of the server's 1 s route ticks: none moves the box, whose route names the runner beside the server.
  await sleep(3_500);
  assert.equal(server.attachHub.online(computer), true, "the box stays in the server's hub for the whole hold");
  assert.equal(server.attachHub.hold(computer), hold, "and the beside run's hold there is the same one");
  assert.equal(relay.dial.hub.online(computer), false, "the box never moved to the runner apart");
  assert.deepEqual(driver.closes, [], "no tick closed the box's socket mid-hold");
  assert.equal((await paired.get(computer)).run, "run-beside", "the route still names the beside run");
  const row = pairedRow((await api("GET", "/computers")).body, computer);
  assert.equal(row?.held_by_run, "run-beside", `the row names the beside run: ${JSON.stringify(row)}`);
  assert.equal(row?.online, true);

  assert.equal((await here.release(made.value, "delete")).ok, true);
  assert.equal(server.attachHub.hold(computer), undefined, "the release ends the beside run's hold");
  assert.equal((await paired.get(computer)).runner, null, "and its route goes with it");

  const took = await Promise.race([apart.create(specOf("run-apart"), { requestId: "req-apart-2" }), sleep(20_000).then(() => "hung")]);
  assert.equal(took?.ok, true, `the run apart takes the box once the beside run let it go: ${JSON.stringify(took)}`);
  assert.equal(relay.dial.hub.online(computer), true, "the box's socket moved to the runner apart");
  assert.equal(server.attachHub.online(computer), false);

  const besideRefused = await here.create(specOf("run-beside-2"), { requestId: "req-beside-2" });
  assert.deepEqual(besideRefused, { ok: false, error: { code: "refused", message: `${NAME} is held by run run-apart on runner runner-a: one run at a time` } }, "a beside take while a runner apart holds the box fails in the same words");
  assert.equal(relay.dial.hub.online(computer), true, "the refused beside take leaves the box where it is");
  assert.equal((await apart.release(took.value, "delete")).ok, true);
});

test("a beside run cancelled mid-hold lets the box go as it unwinds: its loop's finally releases the computer (closeSession, the spec's release), which ends its hold on the server's hub and drops its route; a run apart then takes the box, relayed to its runner", { timeout: 60_000 }, async (t) => {
  const { server, beside, relay, computer, paired, here, apart } = await besideAndApart(t);
  // The beside runner's sweep stopped, so only the run's own release can drop the route here.
  beside.stopSweep();
  const cancel = new AbortController();
  const made = await here.create(specOf("run-beside"), { requestId: "req-beside", signal: cancel.signal });
  assert.equal(made.ok, true, `the beside run's create holds the box: ${JSON.stringify(made)}`);
  assert.equal((await paired.get(computer)).runner, beside.runner);
  assert.ok(server.attachHub.hold(computer), "the beside run holds the box on the server's hub");

  // The run as the adapter loop runs it: its pass ends on the cancel, and its finally releases the computer
  // (adapter-loop.ts closeSession, then the spec's release, then the computer's: this provider's release).
  const unwound = (async () => {
    try {
      await new Promise((resolve) => cancel.signal.addEventListener("abort", resolve, { once: true }));
    } finally {
      const released = await here.release(made.value, "delete");
      assert.equal(released.ok, true, `the unwinding run's release answers ok: ${JSON.stringify(released)}`);
    }
  })();
  cancel.abort();
  await until(() => paired.get(computer), (route) => route.runner === null, "the cancelled beside run's route is gone once it unwinds", 5_000);
  await unwound;
  assert.equal(server.attachHub.hold(computer), undefined, "its hold on the server's hub ended with it");

  const took = await Promise.race([apart.create(specOf("run-apart"), { requestId: "req-apart" }), sleep(20_000).then(() => "hung")]);
  assert.equal(took?.ok, true, `a run apart takes the box the cancelled run let go: ${JSON.stringify(took)}`);
  assert.equal(relay.dial.hub.online(computer), true, "the box's socket moved to the runner apart");
  assert.equal(server.attachHub.online(computer), false, "and left the server's hub");
  const route = await paired.get(computer);
  assert.deepEqual([route.runner, route.run], ["runner-a", "run-apart"], "the route names the run apart on its runner");
  assert.equal((await apart.release(took.value, "delete")).ok, true);
});
