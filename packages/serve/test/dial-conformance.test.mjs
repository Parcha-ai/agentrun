// scripts/dial-conformance.mjs end to end on 127.0.0.1: serve's attach routes on $PORT, a dial host's machines (the
// fixture, computer's fake host) fetching the daemon and dialing over the network, and Core with --long run in the
// script's own process. The report is the JSON between the marker lines, and no machine token is in anything it writes.
// The daemon route serves the built computerd (the drift case changes its version string), so it is gated like the
// other built-binary tests: CI's build job builds computerd, so the shards run it.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { conformanceCases, MACHINE_TOKEN_SOURCE, newMachineToken, readPng, runConformance } from "@parcha/agentrun-computer";
import { fakeDevices, fakeFetch, testClock } from "../../computer/test/fake-device.mjs";
import { driftedVersion, fixtureFor, frameLines, listenConformance, patchVersion, reachesThisRun, scrubMachineTokens } from "../scripts/dial-conformance.mjs";
// The script binds $PORT after the test picked it: a port below the ephemeral range, so no listen(0) or outbound
// connection of the suite's other files takes it in between. A listen(0) pick could be taken, and the script then
// died before its report.
import { freePort } from "./fixtures/ports.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/dial-conformance.mjs", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/dial-fake-provider.mjs", import.meta.url));
const DAEMON = fileURLToPath(new URL("../../computer/dist/computerd-linux-amd64", import.meta.url));
/** The computer package's version: what its computerd says, as the build stamps it. */
const VERSION = JSON.parse(readFileSync(new URL("../../computer/package.json", import.meta.url), "utf8")).version;
const MINTED = new RegExp(MACHINE_TOKEN_SOURCE);
/** Why the runs that serve the daemon skip, or false: the fixture's machines run the served build's `computerd version`. */
const BUILT = !existsSync(DAEMON) ? "no computerd-linux-amd64: run npm run build:daemon -w @parcha/agentrun-computer (CI's build job does)" : process.arch !== "x64" && "the fixture's machines run the amd64 computerd, and this machine is not x86-64";
/** What the fake's daemon answers: Core's provider and drift groups whole, and health but for the declaration and the
 *  planted key, which a module given by path has none of. The exec, files and process groups need a real daemon. */
const ONLY = "provider,drift,health.hello,health.ping,health.unknown-method,health.kind-consistent,health.kind-served";

/**
 * The script run with `args` and `env` (beside PATH alone), with --exit unless `exit` is false: its exit code and what it
 * wrote; `onLine` sees each stderr line whole, once its newline came (a pipe may split a line across chunks), and the
 * child. It binds 127.0.0.1 alone and asks its public address every 50 ms: on the loopback no host swaps instances.
 */
function run(args, env, onLine = () => {}, { exit = true } = {}) {
  const child = spawn(process.execPath, [SCRIPT, ...args, ...(exit ? ["--exit"] : [])], { env: { PATH: process.env.PATH, AGENTRUN_BIND_HOST: "127.0.0.1", AGENTRUN_REACH_EVERY_MS: "50", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let partial = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    const lines = (partial + chunk).split("\n");
    partial = lines.pop();
    for (const line of lines) if (line) onLine(line, child);
  });
  // "close", not "exit": a child that wrote its report and ended at once can exit before its stdout is read to the end.
  return new Promise((done) => child.once("close", (code, signal) => done({ code, signal, stdout, stderr })));
}

/** The report between the marker lines of a run's stdout, parsed; without them, the run's stderr says why. */
function reportOf({ stdout, stderr, code }) {
  const lines = stdout.split("\n");
  const begin = lines.indexOf("DIAL-CONFORMANCE-REPORT-BEGIN");
  const end = lines.indexOf("DIAL-CONFORMANCE-REPORT-END");
  assert.ok(begin >= 0 && end > begin, `the markers, in order (exit ${code}): ${stdout.slice(0, 500)}\nstderr: ${stderr.slice(-1500)}`);
  return JSON.parse(lines.slice(begin + 1, end).join("\n"));
}

test("the conformance listener binds an explicitly local interface while preserving the unset public default", async () => {
  const local = createHttpServer();
  try {
    await listenConformance(local, 0, "127.0.0.1");
    assert.equal(local.address().address, "127.0.0.1", "the actual socket is not a wildcard listener");
  } finally {
    await new Promise((done) => local.close(done));
  }
  // Observe Node's listen boundary for the public default without publishing a test listener on the host.
  const listener = new EventEmitter();
  let supplied;
  listener.listen = (options) => { supplied = options; listener.emit("listening"); };
  await listenConformance(listener, 7340);
  assert.deepEqual(supplied, { port: 7340 }, "unset host leaves Node's existing wildcard default intact");
});

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
    const report = reportOf(ran);
    const status = (id) => report.results.find((result) => result.id === id)?.status;
    assert.deepEqual(
      report.results.filter((result) => result.status === "fail").map(({ id, reason }) => `${id}: ${reason}`),
      [],
    );
    for (const id of ["provider.dial-token", "provider.deadline", "drift.arch", "drift.version"]) assert.equal(status(id), "pass", id);
    // The drifted twin's daemon copy by its sha256 and version, and the version its machines' refused hellos reported.
    const { copies, hellos, matches } = report.driftedDaemon;
    assert.deepEqual(copies.map(({ arch, version }) => [arch, version]), [["amd64", `${VERSION.slice(0, -1)}x`]]);
    assert.match(copies[0].sha256, /^[0-9a-f]{64}$/);
    assert.notEqual(copies[0].sha256, createHash("sha256").update(readFileSync(DAEMON)).digest("hex"));
    assert.deepEqual([hellos, matches], [[copies[0].version], true]);
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
  const report = reportOf(ran);
  assert.deepEqual(report.results.map(({ id, status }) => [id, status]), [["health.declared", "skip"]]);
  assert.equal(report.core, "fail");
  assert.equal(ran.code, 1, ran.stderr);
});

test("every machine token in what the script writes is redacted by its shape, one this run never minted too (a token a second mint replaced)", () => {
  const minted = newMachineToken();
  const replaced = newMachineToken();
  const said = scrubMachineTokens(`fail provider.dial-token: dialed with ${minted}, then "${replaced}"\n`);
  assert.equal(said, `fail provider.dial-token: dialed with art_[redacted], then "art_[redacted]"\n`);
});

test("a desktop run is given computerd-fixture (without it the screen and input cases skip and Core cannot pass); another kind gets none", () => {
	assert.equal(fixtureFor("desktop", "/fixture"), "/fixture");
	assert.equal(fixtureFor("linux", "/fixture"), undefined);
});

test("the screen case hands the run's onScreenshot its last whole shot once, a PNG that decodes, and frameLines prints it between its markers with its sha256; a desktop case that ends before its fixture's shot still hands its first", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dial-conformance-frame-"));
	try {
		// The fake knows the fixture by where the case puts it, not by what it is.
		const fixture = join(dir, "fixture.bin");
		writeFileSync(fixture, Buffer.alloc(16, 7));
		const screen = async (given) => {
			const shots = [];
			const report = await runConformance(fakeDevices({ kind: "desktop" }).provider, {
				image: "fixture:image",
				cases: conformanceCases.filter(({ id }) => id === "screen.screenshot-size"),
				...(given ? { fixture: given } : {}),
				fetch: fakeFetch,
				clock: testClock,
				patience: 1000,
				onScreenshot: (png) => shots.push(png),
			});
			return { status: report.results.map(({ id, status }) => [id, status]), shots };
		};
		const early = await screen(undefined);
		assert.notDeepEqual(early.status, [["screen.screenshot-size", "pass"]], "no fixture: the desktop case ends before the painted shot");
		assert.equal(early.shots.length, 1, "its first whole shot, handed over all the same");
		assert.deepEqual((({ width, height }) => [width, height])(readPng(Buffer.from(early.shots[0]))), [320, 240]);
		const { status, shots } = await screen(fixture);
		assert.deepEqual(status, [["screen.screenshot-size", "pass"]]);
		assert.equal(shots.length, 1);
		const png = Buffer.from(shots[0]);
		const image = readPng(png);
		assert.deepEqual([image.width, image.height], [320, 240], "the fake desktop's whole screen");
		const lines = frameLines(shots[0], 8);
		const sha256 = createHash("sha256").update(png).digest("hex");
		assert.equal(lines[0], `DIAL-CONFORMANCE-FRAME-BEGIN ${sha256} ${png.length}`);
		assert.equal(lines.at(-1), "DIAL-CONFORMANCE-FRAME-END");
		assert.ok(lines.slice(1, -1).every((line) => line.length <= 8));
		assert.deepEqual(Buffer.from(lines.slice(1, -1).join(""), "base64"), png);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the drift case's patch writes the version string over where it occurs exactly once, the same length and printable, and refuses anything else", () => {
  const to = driftedVersion(VERSION);
  assert.equal(to.length, VERSION.length);
  const bytes = Buffer.from(`\0go:${VERSION}\0`);
  assert.equal(String(patchVersion(bytes, VERSION, to)), `\0go:${to}\0`);
  assert.equal(String(bytes), `\0go:${VERSION}\0`, "the bytes it was given are left as they were");
  assert.equal(driftedVersion("1.0.x"), "1.0.y");
  // A daemon built at a release tag: Go's build info holds the module version twice more, as v<version> (once with
  // +dirty on a modified tree). Only the stamp changes.
  const tagged = Buffer.from(`\0go:${VERSION}\0mod\tcomputerd\tv${VERSION}\t\0dep v${VERSION}+dirty\0`);
  assert.equal(String(patchVersion(tagged, VERSION, to)), `\0go:${to}\0mod\tcomputerd\tv${VERSION}\t\0dep v${VERSION}+dirty\0`);
  for (const [given, from, into, words] of [
    [Buffer.from("no version here"), VERSION, to, "nowhere"],
    [Buffer.from(`build info only: v${VERSION}`), VERSION, to, "nowhere"],
    [Buffer.from(`${VERSION} and ${VERSION}`), VERSION, to, "more than once"],
    [bytes, VERSION, `${to}x`, "printable characters"],
    [bytes, VERSION, `${to.slice(0, -1)} `, "printable characters"],
  ]) {
    assert.throws(() => patchVersion(given, from, into), (error) => error.message.includes(words), words);
  }
});

test("the patch pinned on the built computerd: its version string is there once, and the patched copy runs and says the drifted version", { skip: BUILT }, () => {
  const dir = mkdtempSync(join(tmpdir(), "dial-conformance-pin-"));
  try {
    const copy = join(dir, "computerd");
    writeFileSync(copy, patchVersion(readFileSync(DAEMON), VERSION, driftedVersion(VERSION)));
    chmodSync(copy, 0o755);
    assert.equal(execFileSync(DAEMON, ["version"], { encoding: "utf8", env: {} }).trim(), VERSION);
    assert.equal(execFileSync(copy, ["version"], { encoding: "utf8", env: {} }).trim(), driftedVersion(VERSION));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without --exit the run's report is printed, then the script idles, /v2/health still answered, until SIGTERM ends it with the run's status", { skip: BUILT, timeout: 120_000 }, async () => {
  const port = await freePort();
  let idled;
  const ran = await run(
    ["--provider", FIXTURE, "--only", "health.declared"],
    { PORT: String(port), AGENTRUN_PUBLIC_URL: `http://127.0.0.1:${port}` },
    (line, child) => {
      if (!line.startsWith("dial-conformance: the run is over (exit status 1); idling until stopped")) return;
      idled = (async () => {
        await new Promise((done) => setTimeout(done, 6_000));
        const status = (await fetch(`http://127.0.0.1:${port}/v2/health`)).status;
        child.kill("SIGTERM");
        return status;
      })();
    },
    { exit: false },
  );
  assert.equal(await idled, 200, "health while it idles, past the 5 s an exiting run is given");
  assert.deepEqual(reportOf(ran).results.map(({ id }) => id), ["health.declared"]);
  assert.deepEqual([ran.code, ran.signal], [1, null], ran.stderr);
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
  assert.deepEqual(reportOf(ran).results.map(({ id }) => id), ["health.declared"]);
  assert.equal(ran.code, 1, ran.stderr);
});

test("nothing runs until AGENTRUN_PUBLIC_URL reaches the script: an address still answered by another process (a host's previous instance) is waited out", { skip: BUILT, timeout: 120_000 }, async () => {
  const port = await freePort();
  // The public address, as a host that picks an instance per connection moves it over: the first four connections whose
  // first request is the script's ask (GET /v2/health with cache-control: no-store, as reachesThisRun asks) stay with the
  // previous instance, which answers every request on them with its own /v2/health (no run id) and keeps them open, so an
  // ask that kept one alive would never reach the script; every other connection goes to the script as is (the machine's
  // daemon fetch with its token, and its attach socket). A connection is routed by its first request, not by its order:
  // the front listens on an ephemeral port, where a stray client on a busy machine (a daemon of another suite redialing a
  // port its server left, saying GET / as Go-http-client) could otherwise take one of the four, and the script would then
  // count fewer answers from another than it was given.
  const isAsk = (head) => head.startsWith("GET /v2/health HTTP/1.1\r\n") && /\r\ncache-control: no-store\r\n/i.test(head.slice(0, head.indexOf("\r\n\r\n") + 2));
  let stale = 0;
  // Every connection the front took, ended with it: one that never sends a request holds no close open.
  const taken = new Set();
  const front = createServer((socket) => {
    taken.add(socket);
    socket.on("close", () => taken.delete(socket));
    socket.on("error", () => undefined);
    let said = "";
    const first = (chunk) => {
      said += chunk.toString("latin1");
      if (!said.includes("\r\n\r\n")) return;
      socket.off("data", first);
      if (stale < 4 && isAsk(said)) {
        stale += 1;
        const old = (more) => {
          said += more;
          for (; said.includes("\r\n\r\n"); said = said.slice(said.indexOf("\r\n\r\n") + 4)) socket.write('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 15\r\nconnection: keep-alive\r\n\r\n{"status":"ok"}');
        };
        old("");
        return void socket.on("data", old);
      }
      const behind = connect(port, "127.0.0.1");
      behind.on("error", () => socket.destroy());
      behind.write(Buffer.from(said, "latin1"));
      socket.pipe(behind).pipe(socket);
    };
    socket.on("data", first);
  });
  await new Promise((done) => front.listen(0, "127.0.0.1", done));
  try {
    const ran = await run(["--provider", FIXTURE, "--only", "health.declared"], { PORT: String(port), AGENTRUN_PUBLIC_URL: `http://127.0.0.1:${front.address().port}/` });
    const lines = ran.stderr.split("\n");
    const at = (start) => lines.findIndex((line) => line.startsWith(`dial-conformance: ${start}`));
    const health = `http://127.0.0.1:${front.address().port}/v2/health`;
    assert.ok(at(`${health} reaches another process`) >= 0, ran.stderr);
    assert.ok(at(`${health} reaches this process (3 answers in a row, after`) > at(`${health} reaches another process`), ran.stderr);
    assert.match(ran.stderr, /and 4 answers from another\)/);
    assert.ok(at("skip health.declared") > at(`${health} reaches this process`), "the run's first case comes after");
    assert.deepEqual(reportOf(ran).results.map(({ id }) => id), ["health.declared"]);
  } finally {
    for (const socket of taken) socket.destroy();
    await new Promise((done) => front.close(done));
  }
});

test("reachesThisRun: three of this run's answers in a row, a miss or a failed ask starting the count again; past its time it refuses in words; its signal stops an ask in flight and the wait between asks", async () => {
  const answers = (said) => {
    const asked = [];
    const ask = async (url) => {
      asked.push(url);
      const one = said[asked.length - 1] ?? "old";
      if (one === "down") throw new Error("connect ECONNREFUSED");
      return { status: 200, run: one === "mine" ? "run-1" : undefined };
    };
    return { asked, ask };
  };
  const ok = answers(["old", "mine", "mine", "down", "mine", "old", "mine", "mine", "mine"]);
  await reachesThisRun("https://dial.example.test/", "run-1", undefined, { every: 1, ask: ok.ask });
  assert.deepEqual([ok.asked.length, new Set(ok.asked)], [9, new Set(["https://dial.example.test/v2/health"])]);
  const never = answers([]);
  await assert.rejects(reachesThisRun("https://dial.example.test", "run-1", undefined, { within: 50, every: 5, ask: never.ask }), {
    message: /^https:\/\/dial\.example\.test\/v2\/health did not reach this process within 0 s \(last: 200 from another process\): the machines would dial another, so nothing was created$/,
  });
  // Stopped while it waits a minute between asks, and while an ask that never answers is in flight: at once, either way.
  const stalled = (url, signal) => new Promise((_, fail) => signal.addEventListener("abort", () => fail(signal.reason), { once: true }));
  for (const ask of [never.ask, stalled]) {
    const stop = new AbortController();
    const begun = Date.now();
    setTimeout(() => stop.abort(new Error("stopped")), 50);
    await assert.rejects(reachesThisRun("https://dial.example.test", "run-1", stop.signal, { every: 60_000, ask }), { message: /stopped|aborted/ });
    assert.ok(Date.now() - begun < 5_000, `stopped after ${Date.now() - begun} ms`);
  }
});

test("reachesThisRun's ask opens a connection for each ask, even to a server that keeps them alive", async () => {
  let connections = 0;
  const server = createHttpServer((req, res) => res.writeHead(200, { "x-dial-conformance-run": "run-1", "content-length": "2", connection: "keep-alive" }).end("{}"));
  server.keepAliveTimeout = 60_000;
  server.on("connection", () => connections++);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    await reachesThisRun(`HTTP://127.0.0.1:${server.address().port}`, "run-1", undefined, { every: 1 });
    assert.equal(connections, 3);
    // A scheme in capitals is the URL's own: HTTPS:// goes to the TLS client, whose handshake this plain server fails,
    // rather than to the plain one, which would refuse the protocol.
    await assert.rejects(reachesThisRun(`HTTPS://127.0.0.1:${server.address().port}`, "run-1", undefined, { within: 200, every: 50 }), (error) => {
      assert.match(error.message, /did not reach this process within 0 s \(last: /);
      assert.doesNotMatch(error.message, /not supported/);
      return true;
    });
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

test("the script refuses in words, and exits 1, without --provider, AGENTRUN_PUBLIC_URL or PORT, with an AGENTRUN_REACH_EVERY_MS that is no whole number of ms, or with an --only that names nothing in the suite", async () => {
  for (const [args, env, words] of [
    [["--provider", FIXTURE, "--only", "provider.deadlin"], { PORT: "0", AGENTRUN_PUBLIC_URL: "http://127.0.0.1:1" }, "--only: provider.deadlin is neither a group nor a case id of the provider's suite"],
    [["--provider", FIXTURE, "--only", ","], { PORT: "0", AGENTRUN_PUBLIC_URL: "http://127.0.0.1:1" }, "--only names no group or case id"],
    [[], { PORT: "0", AGENTRUN_PUBLIC_URL: "http://127.0.0.1:1" }, "usage: node dial-conformance.mjs --provider <registry id or module path>"],
    [["--provider", FIXTURE], { PORT: "0" }, "AGENTRUN_PUBLIC_URL is not set: the provider's machines dial it"],
    [["--provider", FIXTURE], { AGENTRUN_PUBLIC_URL: "http://127.0.0.1:1" }, 'PORT is the port this process listens on, not ""'],
    [["--provider", FIXTURE], { PORT: "0", AGENTRUN_PUBLIC_URL: "http://127.0.0.1:1", AGENTRUN_REACH_EVERY_MS: "0" }, 'AGENTRUN_REACH_EVERY_MS is the ms between asks of the public address, a whole number from 1, not "0"'],
  ]) {
    const ran = await run(args, env);
    assert.equal(ran.code, 1, words);
    assert.equal(ran.stdout, "", words);
    assert.ok(ran.stderr.includes(`dial-conformance: ${words}`), ran.stderr);
  }
});
