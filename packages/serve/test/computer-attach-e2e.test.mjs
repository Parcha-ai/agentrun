// A person's own computer, paired and used by a run, end to end on the real path (spec/computer/attach.md): the CLI's
// start (a server on a port, its runner beside it in the same process), a pairing code from the owner's API, and the
// test driver (fixtures/attach-driver.mjs: a real WebSocket client that keeps its socket as any driver must) trading the
// code for its token over HTTP with no token of the server's, then dialing the attach WebSocket with that token and the
// protocol's subprotocol. The computer is listed as its hello says; quitting the driver shows it offline and opening it
// again online, with no new code. A run whose agent's computer names it claims it, takes a screenshot and types through it
// (a faux model's tool calls), holds it until a deadline it lists, and releases it at its end. Removing the computer
// closes its socket with 4401, after which the driver dials no more, and its token is refused.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import WebSocket from "ws";
import { agent, client, follow, printed, scratch } from "./support.mjs";
import { attachDriver, DRIVER_HELLO, pairDriver } from "./fixtures/attach-driver.mjs";
import { TYPED } from "./fixtures/faux-attach.mjs";

const { ATTACH_PATH, ATTACH_SUBPROTOCOL } = await import("@parcha/agentrun-computer");

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const FAUX_ATTACH = new URL("./fixtures/faux-attach.mjs", import.meta.url).pathname;
const TOKEN = `ar_test_${"a".repeat(40)}`;
const NAME = "desk-1";

/** Polls `read` until `done` holds of its answer, or fails after `ms` with the last answer. */
async function until(read, done, what, ms = 20_000) {
  const deadline = Date.now() + ms;
  let last;
  for (;;) {
    last = await read();
    if (done(last)) return last;
    if (Date.now() > deadline) assert.fail(`${what}: ${JSON.stringify(last)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** A dial of the attach socket: open with the server's chosen subprotocol, or refused at the upgrade with its status. */
function dial(wsUrl, headers, protocol = ATTACH_SUBPROTOCOL) {
  const ws = new WebSocket(wsUrl, protocol, { headers });
  ws.on("error", () => undefined);
  return new Promise((resolve) => {
    ws.once("open", () => {
      resolve({ open: true, protocol: ws.protocol });
      ws.terminate();
    });
    ws.once("unexpected-response", (req, res) => {
      resolve({ open: false, status: res.statusCode });
      req.destroy();
    });
  });
}

test("pair a computer with a code; it is listed as its hello says, offline once its driver quits and online once it opens again with no new code; a run whose agent names it takes a screenshot and types through it, holding it until a listed deadline, then releases it; removing it closes its socket and its token dials no more", { timeout: 180_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const child = spawn(process.execPath, [CLI, "--data", data, "--port", "0", "--faux", FAUX_ATTACH], { env: { ...process.env, AGENTRUN_ACCOUNTS: "0", AGENTRUN_TOKEN: TOKEN }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await exited;
  });
  const out = await printed(child, /^Open /m);
  const port = Number(/^agentrun-serve on http:\/\/127\.0\.0\.1:(\d+)\/v2 /m.exec(out)[1]);
  const address = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}${ATTACH_PATH}`;
  const api = client(`${address}/v2`, TOKEN);
  const listed = () => api("GET", "/computers");

  // The owner's code, then the driver's trade of it for its token.
  const pairing = await api("POST", "/computers/pairings", {});
  assert.equal(pairing.status, 201, JSON.stringify(pairing.body));
  assert.match(pairing.body.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal((await pairDriver({ address, code: "ZZZZ-ZZZZ", name: NAME })).status, 404, "a wrong code");
  assert.equal((await pairDriver({ address, code: pairing.body.code, name: NAME, hello: { ...DRIVER_HELLO, protocol: "0.1" } })).status, 422, "another protocol version");
  const lacking = await pairDriver({ address, code: pairing.body.code, name: NAME, hello: { ...DRIVER_HELLO, groups: ["screen"] } });
  assert.equal(lacking.status, 422, "a hello that serves no kind");
  assert.equal(lacking.body.error.fields?.[0]?.message, `${NAME}'s driver serves no kind: it says desktop but declares no input.pointer, input.keys: update the driver on ${NAME}`);
  const paired = await pairDriver({ address, code: pairing.body.code.toLowerCase(), name: NAME });
  assert.equal(paired.status, 201, `the code stays good after the protocol and kind refusals: ${JSON.stringify(paired.body)}`);
  const { computer, token } = paired.body;
  assert.match(computer, /^cmp-[a-z2-9]{16}$/);
  assert.match(token, /^art_/);
  assert.equal((await pairDriver({ address, code: pairing.body.code, name: NAME })).status, 404, "a used code");

  // The upgrade checks the token, then the protocol.
  assert.deepEqual(await dial(wsUrl, {}), { open: false, status: 401 }, "no token");
  assert.deepEqual(await dial(wsUrl, { authorization: `Bearer art_${"x".repeat(43)}` }), { open: false, status: 401 }, "a token no computer has");
  assert.deepEqual(await dial(wsUrl, { authorization: `Bearer ${TOKEN}` }), { open: false, status: 401 }, "the server's own token is no computer's");
  assert.deepEqual(await dial(wsUrl, { authorization: `Bearer ${token}` }, "agentrun.computer.0.1"), { open: false, status: 426 }, "another protocol version");

  // The driver attaches: the server calls hello, and the computer is listed online as its hello says, and offered as a
  // desktop by its name and os.
  let atInput;
  const driver = attachDriver({ address, token, onActions: async () => void (atInput = (await listed()).body.paired[0]) });
  t.after(() => driver.stop());
  driver.start();
  const online = await until(listed, (res) => res.body.paired?.[0]?.online === true, "the computer is listed online");
  const { created_at, seen_at, ...view } = online.body.paired[0];
  assert.deepEqual(view, {
    id: computer,
    name: NAME,
    kind: "desktop",
    serves: ["desktop"],
    os: DRIVER_HELLO.os,
    os_version: DRIVER_HELLO.osVersion,
    device: null,
    arch: DRIVER_HELLO.arch,
    screen: DRIVER_HELLO.screen,
    groups: DRIVER_HELLO.groups,
    features: {},
    driver: DRIVER_HELLO.version,
    online: true,
    held_by_run: null,
    held_until: null,
  });
  assert.ok(Date.parse(created_at) <= Date.parse(seen_at), `${created_at} ${seen_at}`);
  const offered = () => listed().then((res) => res.body.kinds.find((kind) => kind.kind === "desktop").providers.find((provider) => provider.id === computer));
  assert.deepEqual(await offered().then((one) => ({ name: one?.name, ready: one?.ready })), { name: `${NAME} (${DRIVER_HELLO.os})`, ready: true }, "a desktop provider by name and os, ready while attached");
  assert.equal(driver.calls[0]?.method, "hello", "the server's first call is hello");

  // Its driver quits: the computer is listed offline and offered as not ready. Opened again, it dials with the token it
  // kept: online, the same computer, with no new code.
  driver.stop();
  await until(listed, (res) => res.body.paired?.[0]?.online === false, "the computer is listed offline once its driver quits");
  assert.equal((await offered())?.ready, false, "not ready while its driver is closed");
  driver.start();
  const back = await until(listed, (res) => res.body.paired?.[0]?.online === true, "the computer is listed online once its driver opens again");
  assert.deepEqual(back.body.paired.map((one) => one.id), [computer], "the same computer, paired once");

  // A run whose agent's computer is the paired one claims it, takes a screenshot, types, and releases it at its end; while
  // it holds it, the list names the run and the deadline its hold ends by.
  const made = await api("POST", "/agents", agent("typist", { computer: { kind: "desktop", provider: computer } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const started = Date.now();
  const run = await api("POST", "/agents/typist/runs", { input: { content: "Open a text editor and type." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { last } = await follow(api, run.body.run_id, ["completed", "failed", "cancelled"], { deadlineMs: 90_000 });
  const read = await api("GET", `/runs/${run.body.run_id}`);
  assert.equal(last.status, "completed", `the run ended ${last.status}: ${JSON.stringify(read.body)}`);
  const methods = driver.calls.map((call) => call.method).filter((method) => method !== "screen.read");
  assert.deepEqual(methods, ["hello", "hello", "screen.shot", "input.actions"], `the calls the computer answered, a hello on each socket: ${methods}`);
  assert.deepEqual(driver.calls.find((call) => call.method === "input.actions").params.actions, [{ type: "type", text: TYPED }]);
  assert.equal(atInput?.held_by_run, run.body.run_id, "the run held the computer while it typed");
  assert.ok(Date.parse(atInput.held_until) > started, `a hold ends by a deadline after the run's start: ${atInput.held_until}`);
  await until(listed, (res) => res.body.paired?.[0]?.held_by_run === null && res.body.paired[0].held_until === null && res.body.paired[0].online === true, "released at the run's end, still attached");

  // Removed: its socket is closed with 4401, the driver dials no more, it is no longer listed, and its token is refused.
  const removed = await api("DELETE", `/computers/${computer}`);
  assert.equal(removed.status, 204, removed.text);
  await until(async () => driver.stopped, (stopped) => stopped !== undefined, "the driver stops dialing once removed");
  assert.deepEqual(driver.stopped, { code: 4401 });
  assert.deepEqual((await listed()).body.paired, []);
  assert.deepEqual(await dial(wsUrl, { authorization: `Bearer ${token}` }), { open: false, status: 401 }, "a removed computer's token");
  assert.equal((await api("DELETE", `/computers/${computer}`)).status, 404, "removed once");
});
