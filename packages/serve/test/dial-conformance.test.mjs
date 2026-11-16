// scripts/dial-conformance.mjs end to end on 127.0.0.1: serve's attach routes on $PORT, a dial host's machines (the
// fixture, computer's fake host) fetching the daemon and dialing over the network, and Core with --long run in the
// script's own process. The report is the JSON between the marker lines, and no machine token is in anything it writes.
// The daemon route serves the built computerd (the drift case changes its version string), so it is gated like the
// other built-binary tests: CI's build job builds computerd, so the shards run it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { connect, createServer } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/dial-conformance.mjs", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/dial-fake-provider.mjs", import.meta.url));
const DAEMON = fileURLToPath(new URL("../../computer/dist/computerd-linux-amd64", import.meta.url));
const MINTED = /art_[0-9a-f]{64}/;
/** Why the runs that serve the daemon skip, or false: the fixture's machines run the served build's `computerd version`. */
const BUILT = !existsSync(DAEMON) ? "no computerd-linux-amd64: run npm run build:daemon -w @parcha/agentrun-computer (CI's build job does)" : process.arch !== "x64" && "the fixture's machines run the amd64 computerd, and this machine is not x86-64";
/** What the fake's daemon answers: Core's provider and drift groups whole, and health but for the declaration and the
 *  planted key, which a module given by path has none of. The exec, files and process groups need a real daemon. */
const ONLY = "provider,drift,health.hello,health.ping,health.unknown-method,health.kind-consistent,health.kind-served";

/** A port nothing listens on now. */
async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

/** The script run with `args` and `env` (beside PATH alone): its exit code and what it wrote; `onLine` sees stderr. */
function run(args, env, onLine = () => {}) {
  const child = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    for (const line of String(chunk).split("\n")) if (line) onLine(line);
  });
  return new Promise((done) => child.once("exit", (code) => done({ code, stdout, stderr })));
}

/** The report between the marker lines, parsed. */
function reportOf(stdout) {
  const lines = stdout.split("\n");
  const begin = lines.indexOf("DIAL-CONFORMANCE-REPORT-BEGIN");
  const end = lines.indexOf("DIAL-CONFORMANCE-REPORT-END");
  assert.ok(begin >= 0 && end > begin, `the markers, in order: ${stdout.slice(0, 500)}`);
  return JSON.parse(lines.slice(begin + 1, end).join("\n"));
}

test(
  "the script stands up serve's attach routes on $PORT and runs Core with --long over a dial host whose machines dial it: every case it runs passes, provider.deadline, drift.arch and drift.version among them, the report lands between the markers, and no token is written",
  { skip: BUILT, timeout: 300_000 },
  async () => {
    const port = await freePort();
    let health;
    const ran = await run(["--provider", FIXTURE, "--only", ONLY], { PORT: String(port), AGENTRUN_PUBLIC_URL: `http://127.0.0.1:${port}` }, (line) => {
      if (line.startsWith("dial-conformance: listening on port ")) health = fetch(`http://127.0.0.1:${port}/v2/health`).then((res) => res.status);
    });
    assert.equal(await health, 200, "GET /v2/health while the run is on");
    const report = reportOf(ran.stdout);
    const status = (id) => report.results.find((result) => result.id === id)?.status;
    assert.deepEqual(
      report.results.filter((result) => result.status === "fail").map(({ id, reason }) => `${id}: ${reason}`),
      [],
    );
    for (const id of ["provider.dial-token", "provider.deadline", "drift.arch", "drift.version"]) assert.equal(status(id), "pass", id);
    // Every Core case it ran passed; the ones --only left out make the verdict partial, which a narrowed run exits 0 on.
    assert.deepEqual(report.results.filter((result) => result.level === "core" && result.status !== "pass" && result.undeclared === undefined).map(({ id }) => id), []);
    assert.equal(report.core, "partial");
    assert.equal(ran.code, 0, ran.stderr);
    for (const [where, said] of [["stdout", ran.stdout], ["stderr", ran.stderr]]) assert.equal(MINTED.test(said), false, `no machine token on ${where}`);
  },
);

test("a run whose Core does not pass still prints its report between the markers, and exits 1", { skip: BUILT, timeout: 120_000 }, async () => {
  const port = await freePort();
  // A module given by path declares nothing, so health.declared skips, which Core counts against it.
  const ran = await run(["--provider", FIXTURE, "--only", "health.declared"], { PORT: String(port), AGENTRUN_PUBLIC_URL: `http://127.0.0.1:${port}` });
  const report = reportOf(ran.stdout);
  assert.deepEqual(report.results.map(({ id, status }) => [id, status]), [["health.declared", "skip"]]);
  assert.equal(report.core, "fail");
  assert.equal(ran.code, 1, ran.stderr);
});

/** The status line `request` (raw HTTP/1.1, sent as is) gets from 127.0.0.1:`port`, or the error that ended it. */
function statusLine(port, request) {
  return new Promise((done) => {
    let said = "";
    const socket = connect(port, "127.0.0.1", () => socket.write(request));
    socket.on("data", (chunk) => (said += chunk));
    socket.on("error", (error) => done(`error: ${error.code ?? error.message}`));
    socket.on("close", () => done(said.split("\r\n")[0]));
  });
}

test("a request target no URL parses (//[/) is refused, a socket's and a plain request's alike, and the run goes on to its report", { skip: BUILT, timeout: 120_000 }, async () => {
  const port = await freePort();
  let refused;
  const ran = await run(["--provider", FIXTURE, "--only", "health.declared"], { PORT: String(port), AGENTRUN_PUBLIC_URL: `http://127.0.0.1:${port}` }, (line) => {
    if (!line.startsWith("dial-conformance: listening on port ")) return;
    refused = Promise.all([
      statusLine(port, "GET //[/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"),
      statusLine(port, "GET //[/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"),
    ]);
  });
  assert.deepEqual(await refused, ["HTTP/1.1 404 Not Found", "HTTP/1.1 404 Not Found"]);
  assert.deepEqual(reportOf(ran.stdout).results.map(({ id }) => id), ["health.declared"]);
  assert.equal(ran.code, 1, ran.stderr);
});

test("the script refuses in words, and exits 1, without --provider, AGENTRUN_PUBLIC_URL or PORT, or with an --only that names nothing in the suite", async () => {
  for (const [args, env, words] of [
    [["--provider", FIXTURE, "--only", "provider.deadlin"], { PORT: "0", AGENTRUN_PUBLIC_URL: "http://127.0.0.1:1" }, "--only: provider.deadlin is neither a group nor a case id of the provider's suite"],
    [["--provider", FIXTURE, "--only", ","], { PORT: "0", AGENTRUN_PUBLIC_URL: "http://127.0.0.1:1" }, "--only names no group or case id"],
    [[], { PORT: "0", AGENTRUN_PUBLIC_URL: "http://127.0.0.1:1" }, "usage: node dial-conformance.mjs --provider <registry id or module path>"],
    [["--provider", FIXTURE], { PORT: "0" }, "AGENTRUN_PUBLIC_URL is not set: the provider's machines dial it"],
    [["--provider", FIXTURE], { AGENTRUN_PUBLIC_URL: "http://127.0.0.1:1" }, 'PORT is the port this process listens on, not ""'],
  ]) {
    const ran = await run(args, env);
    assert.equal(ran.code, 1, words);
    assert.equal(ran.stdout, "", words);
    assert.ok(ran.stderr.includes(`dial-conformance: ${words}`), ran.stderr);
  }
});
