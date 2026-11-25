// A paired computer on a server whose runner runs in a process of its own (--no-runner; the image's server-and-runner):
// the computer's socket is held by the server's process, where no run reaches it. The pairing code, the pair answer and
// the computer's row each say so before any run starts, and name the fix in the words a run's refusal uses
// (workspace/attached-computers.ts). A server with its runner beside it says nothing of the kind.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { client, FAUX, printed, scratch, startServe } from "./support.mjs";
import { pairDriver } from "./fixtures/attach-driver.mjs";

const words = await import("../dist/workspace/attached-computers.js");
const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const TOKEN = `ar_test_${"b".repeat(40)}`;
/** The fix in one line, as an operator reads it wherever it is said. */
const FIX = "start the image with the server options alone, without server-and-runner";
/** The other fix: a runner that knows the server's public address takes a paired computer's relayed socket. */
const RELAY_FIX = "give the runner AGENTRUN_PUBLIC_URL";

/** `said` is the runner-apart line: no run here can use the computer, and both fixes. */
function saysRunnerApart(said, where) {
  assert.equal(typeof said, "string", `${where}: ${JSON.stringify(said)}`);
  assert.match(said, /^no run on this server can use a paired computer: /, where);
  assert.ok(said.includes(FIX), `${where} names the fix: ${said}`);
  assert.ok(said.includes(RELAY_FIX), `${where} names the relay's fix: ${said}`);
}

test("on a server started with --no-runner, the pairing code, the pair answer and the computer's row each say no run here can use a paired computer, and name the fix a run's refusal names", { timeout: 120_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const child = spawn(process.execPath, [CLI, "--data", data, "--port", "0", "--faux", FAUX, "--no-runner"], { env: { ...process.env, AGENTRUN_ACCOUNTS: "0", AGENTRUN_TOKEN: TOKEN }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await exited;
  });
  const out = await printed(child, /^Open /m);
  const port = Number(/^agentrun-serve on http:\/\/127\.0\.0\.1:(\d+)\/v2 /m.exec(out)[1]);
  const address = `http://127.0.0.1:${port}`;
  const api = client(`${address}/v2`, TOKEN);

  const pairing = await api("POST", "/computers/pairings", {});
  assert.equal(pairing.status, 201, JSON.stringify(pairing.body));
  saysRunnerApart(pairing.body.runs_refused, "the pairing code, before any computer pairs");
  const paired = await pairDriver({ address, code: pairing.body.code, name: "desk-1" });
  assert.equal(paired.status, 201, `the computer still pairs: ${JSON.stringify(paired.body)}`);
  saysRunnerApart(paired.body.runs_refused, "the pair answer");
  const listed = await api("GET", "/computers");
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  saysRunnerApart(listed.body.paired.find((one) => one.id === paired.body.computer)?.runs_refused, "the computer's row");
  // It is one more provider of its kind too, whose row says the same.
  const asProvider = listed.body.kinds.flatMap((kind) => kind.providers).filter((one) => one.id === paired.body.computer);
  assert.ok(asProvider.length > 0, "listed as a provider of its kind");
  for (const row of asProvider) saysRunnerApart(row.runs_refused, "its provider row");

  // A run's refusal, from a runner of its own process, names the same fix in the same words.
  assert.ok(String(words.ONE_PROCESS_WORDS).includes(FIX), `the run's refusal names the fix: ${words.ONE_PROCESS_WORDS}`);
  assert.equal(pairing.body.runs_refused, paired.body.runs_refused);
});

test("on a server with its runner beside it, the pairing code, the pair answer and the computer's row say nothing of a runner apart", { timeout: 120_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const server = await startServe({ data, port: 0, faux: FAUX });
  t.after(() => server.close());
  const api = client(server.baseUrl, server.token);
  const address = server.baseUrl.replace(/\/v2$/, "");
  const pairing = await api("POST", "/computers/pairings", {});
  assert.equal(pairing.status, 201, JSON.stringify(pairing.body));
  assert.equal(pairing.body.runs_refused, null);
  const paired = await pairDriver({ address, code: pairing.body.code, name: "desk-1" });
  assert.equal(paired.status, 201, JSON.stringify(paired.body));
  assert.equal(paired.body.runs_refused, null);
  const row = (await api("GET", "/computers")).body.paired.find((one) => one.id === paired.body.computer);
  assert.equal(row?.runs_refused, null);
});
