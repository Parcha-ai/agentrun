// A person's own computer, paired and used by a run, end to end on the real path (spec/computer/attach.md): the CLI's
// start (a server on a port, its runner beside it in the same process), a pairing code from the owner's API, a driver
// that trades it for its token over HTTP with no token of the server's, then dials the attach WebSocket with that token
// and the protocol's subprotocol and answers the server's calls as Computerd would (hello, screen.shot, input.actions:
// a small driver of this test's, on a real WebSocket client). A run whose agent's computer names the paired computer
// claims it, takes a screenshot and types through it (a faux model's tool calls), and releases it at its end. Removing
// the computer closes its socket with 4401 and its token dials no more.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import WebSocket from "ws";
import { agent, client, follow, printed, scratch } from "./support.mjs";
import { TYPED } from "./fixtures/faux-attach.mjs";

const { ATTACH_PATH, ATTACH_SUBPROTOCOL, PROTOCOL_VERSION } = await import("@parcha/agentrun-computer");

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const FAUX_ATTACH = new URL("./fixtures/faux-attach.mjs", import.meta.url).pathname;
const TOKEN = `ar_test_${"a".repeat(40)}`;
const HELLO = { protocol: PROTOCOL_VERSION, version: "0.2.0-test", os: "macos", osVersion: "26.1", kind: "desktop", arch: "arm64", groups: ["screen", "input.pointer", "input.keys"], screen: { width: 1, height: 1, scale: 1 } };
/** A 1x1 PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

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
  const outcome = new Promise((resolve) => {
    ws.once("open", () => resolve({ open: true, protocol: ws.protocol }));
    ws.once("unexpected-response", (req, res) => {
      resolve({ open: false, status: res.statusCode });
      req.destroy();
    });
  });
  return { ws, outcome };
}

/** The test's driver over an open attach socket: each request answered as Computerd answers it, each call kept. */
function driverOn(ws, onActions) {
  const calls = [];
  const closed = new Promise((resolve) => ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  ws.on("message", async (data, binary) => {
    assert.equal(binary, false, "the server sends text frames");
    const message = JSON.parse(data.toString());
    if (message.id === undefined) return;
    calls.push(message);
    const answer = (result) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "hello") return answer(HELLO);
    if (message.method === "screen.shot" || message.method === "screen.read") return answer({ id: "shot-1", data: PNG, eof: true, size: Buffer.from(PNG, "base64").length, width: 1, height: 1 });
    if (message.method === "input.actions") {
      await onActions(message.params);
      return answer({ done: message.params.actions.length });
    }
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no method ${message.method}` } }));
  });
  return { calls, closed };
}

test("pair a computer with a code, attach it over the WebSocket, and a run whose agent names it takes a screenshot and types through it, then releases it; removing it closes its socket and its token dials no more", { timeout: 180_000 }, async (t) => {
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
  const baseUrl = `http://127.0.0.1:${port}/v2`;
  const wsUrl = `ws://127.0.0.1:${port}${ATTACH_PATH}`;
  const api = client(baseUrl, TOKEN);
  /** The driver's own request: no token of the server's. */
  const pair = (body) => fetch(`${baseUrl}/computers/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (res) => ({ status: res.status, body: await res.json() }));

  // The owner's code, then the driver's trade of it for its token.
  const pairing = await api("POST", "/computers/pairings", {});
  assert.equal(pairing.status, 201, JSON.stringify(pairing.body));
  assert.match(pairing.body.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal((await pair({ code: "ZZZZ-ZZZZ", name: "vesper-mac", hello: HELLO })).status, 404, "a wrong code");
  assert.equal((await pair({ code: pairing.body.code, name: "vesper-mac", hello: { ...HELLO, protocol: "0.1" } })).status, 422, "another protocol version");
  const paired = await pair({ code: pairing.body.code.toLowerCase(), name: "vesper-mac", hello: HELLO });
  assert.equal(paired.status, 201, `the code stays good after the protocol refusal: ${JSON.stringify(paired.body)}`);
  const { computer, token } = paired.body;
  assert.match(computer, /^cmp-[a-z2-9]{16}$/);
  assert.match(token, /^art_/);
  assert.equal((await pair({ code: pairing.body.code, name: "vesper-mac", hello: HELLO })).status, 404, "a used code");

  // The upgrade checks the token, then the protocol.
  assert.deepEqual(await dial(wsUrl, {}).outcome, { open: false, status: 401 }, "no token");
  assert.deepEqual(await dial(wsUrl, { authorization: `Bearer art_${"x".repeat(43)}` }).outcome, { open: false, status: 401 }, "a token no computer has");
  assert.deepEqual(await dial(wsUrl, { authorization: `Bearer ${TOKEN}` }).outcome, { open: false, status: 401 }, "the server's own token is no computer's");
  assert.deepEqual(await dial(wsUrl, { authorization: `Bearer ${token}` }, "agentrun.computer.0.1").outcome, { open: false, status: 426 }, "another protocol version");

  // The driver attaches: the server calls hello, and the computer is listed online, and offered as a desktop.
  let heldAtInput;
  const attached = dial(wsUrl, { authorization: `Bearer ${token}` });
  const driver = driverOn(attached.ws, async () => {
    heldAtInput = (await api("GET", "/computers")).body.paired[0]?.held_by_run;
  });
  assert.deepEqual(await attached.outcome, { open: true, protocol: ATTACH_SUBPROTOCOL });
  const online = await until(() => api("GET", "/computers"), (res) => res.body.paired?.[0]?.online === true, "the computer is listed online");
  assert.deepEqual(online.body.paired.map(({ id, name, kind, os, driver: build, online: on, held_by_run }) => ({ id, name, kind, os, build, on, held_by_run })), [{ id: computer, name: "vesper-mac", kind: "desktop", os: "macos", build: "0.2.0-test", on: true, held_by_run: null }]);
  const offered = online.body.kinds.find((kind) => kind.kind === "desktop").providers.find((provider) => provider.id === computer);
  assert.deepEqual({ name: offered?.name, ready: offered?.ready }, { name: "vesper-mac", ready: true }, "a desktop provider, ready while attached");
  assert.equal(driver.calls[0]?.method, "hello", "the server's first call is hello");

  // A run whose agent's computer is the paired one claims it, takes a screenshot, types, and releases it at its end.
  const created = await api("POST", "/agents", agent("mac-typist", { computer: { kind: "desktop", provider: computer } }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const run = await api("POST", "/agents/mac-typist/runs", { input: { content: "Open TextEdit and type." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { last } = await follow(api, run.body.run_id, ["completed", "failed", "cancelled"], { deadlineMs: 90_000 });
  const read = await api("GET", `/runs/${run.body.run_id}`);
  assert.equal(last.status, "completed", `the run ended ${last.status}: ${JSON.stringify(read.body)}`);
  const methods = driver.calls.map((call) => call.method);
  assert.deepEqual(methods.filter((method) => method !== "screen.read"), ["hello", "screen.shot", "input.actions"], `the calls the computer answered: ${methods}`);
  assert.deepEqual(driver.calls.find((call) => call.method === "input.actions").params.actions, [{ type: "type", text: TYPED }]);
  assert.equal(heldAtInput, run.body.run_id, "the run held the computer while it typed");
  await until(() => api("GET", "/computers"), (res) => res.body.paired?.[0]?.held_by_run === null && res.body.paired[0].online === true, "released at the run's end, still attached");

  // Removed: its socket is closed with 4401, it is no longer listed, and its token is refused at the upgrade.
  const removed = await api("DELETE", `/computers/${computer}`);
  assert.equal(removed.status, 204, removed.text);
  assert.equal((await driver.closed).code, 4401);
  assert.deepEqual((await api("GET", "/computers")).body.paired, []);
  assert.deepEqual(await dial(wsUrl, { authorization: `Bearer ${token}` }).outcome, { open: false, status: 401 }, "a removed computer's token");
  assert.equal((await api("DELETE", `/computers/${computer}`)).status, 404, "removed once");
});
