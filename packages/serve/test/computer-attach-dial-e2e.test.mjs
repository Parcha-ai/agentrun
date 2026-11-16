// A hosted machine dialing this server, end to end with the real Go client: the built `computerd attach`
// (packages/computer/daemon/internal/attach) dials the attach socket with a token serve minted for the machine and
// carries the socket to init's, a line a message. The machine's init here is a stand-in on a unix socket that answers
// as computerd init does: the real init drops every capability from the bounding set before it serves, which needs root
// or a user namespace, and the test shards have neither (computer's Docker job runs the real init). Gated like the other
// built-binary tests: CI's build job builds computerd, so the shards run it.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { serve } from "./support.mjs";

const { ATTACH_PATH, PROTOCOL_VERSION } = await import("@parcha/agentrun-computer");

const DAEMON = fileURLToPath(new URL("../../computer/dist/computerd-linux-amd64", import.meta.url));
/** A computerd from before `attach` exits 2 with its usage; one with it names the URL it lacks. */
const ATTACHES = existsSync(DAEMON) && spawnSync(DAEMON, ["attach"], { env: {}, encoding: "utf8" }).stderr.includes("AGENTRUN_ATTACH_URL");
const MACHINE = "computer-0000000000d1";
/** What computerd init says for a linux computer on amd64. */
const HELLO = { protocol: PROTOCOL_VERSION, version: "0.1.0-test", os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] };

/** Polls `read` until `done` holds of its answer, or fails after `ms` with the last answer. */
async function until(read, done, what, ms = 15_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const last = await read();
    if (done(last)) return last;
    if (Date.now() > deadline) assert.fail(`${what}: ${JSON.stringify(last)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A stand-in for the machine's init on a unix socket: hello answers HELLO, any other method its own params back. */
async function fakeInit(t) {
  const dir = mkdtempSync(join(tmpdir(), "dial-e2e-"));
  const socket = join(dir, "computerd.sock");
  const calls = [];
  const server = createServer((conn) => {
    conn.on("error", () => undefined);
    createInterface({ input: conn }).on("line", (line) => {
      const message = JSON.parse(line);
      calls.push(message.method);
      conn.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.method === "hello" ? HELLO : { echoed: message.params } })}\n`);
    });
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  t.after(() => (server.close(), rmSync(dir, { recursive: true, force: true })));
  return { socket, calls };
}

test("the real computerd attach dials with its minted token: the machine is in the hub, init's hello is what it was minted as, a call round-trips, and a revoke closes it with 4401 and it stops; no log line on either side holds the token", { skip: !ATTACHES && (existsSync(DAEMON) ? "this computerd has no attach: rebuild it with npm run build:daemon -w @parcha/agentrun-computer" : "no computerd-linux-amd64: run npm run build:daemon -w @parcha/agentrun-computer (CI's build job does)") }, async (t) => {
  const lines = [];
  const server = await serve(t, { runner: false, log: (line) => lines.push(line) });
  const init = await fakeInit(t);
  const token = await server.dial.tokens.mint(MACHINE, { kind: HELLO.kind, os: HELLO.os, arch: HELLO.arch, expiresAt: new Date(Date.now() + 60_000) });

  const env = { PATH: process.env.PATH, AGENTRUN_ATTACH_URL: `${server.url.replace(/^http/, "ws")}${ATTACH_PATH}`, AGENTRUN_ATTACH_TOKEN: token, AGENTRUN_COMPUTERD_SOCKET: init.socket };
  const child = spawn(DAEMON, ["attach"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  t.after(() => child.exitCode === null && child.kill("SIGKILL"));

  await until(async () => server.attachHub.online(MACHINE), Boolean, "the machine is in the hub under its name");
  assert.deepEqual(server.attachHub.hello(MACHINE), HELLO, "init's hello, carried by attach");
  const connection = server.attachHub.connection(MACHINE);
  assert.deepEqual(await connection.client.call("processes.list", { probe: 7 }), { ok: true, value: { echoed: { probe: 7 } } }, "a call round-trips through attach to init and back");
  assert.deepEqual(init.calls, ["hello", "processes.list"]);

  await server.dial.tokens.revoke(MACHINE);
  assert.equal(await exited, 3, `attach exits 3, the server refused its token: ${stderr}`);
  assert.match(stderr, /4401/, "the socket was closed with 4401");
  assert.equal(server.attachHub.online(MACHINE), false);

  for (const [side, said] of [["serve", lines.join("\n")], ["computerd attach", stderr]]) {
    assert.equal(said.includes(token), false, `no line of ${side}'s holds the token`);
  }
});
