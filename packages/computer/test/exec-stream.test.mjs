// The exec pre-check (src/conformance/exec-stream.ts) on a fake host whose exec runs real processes on this machine
// (fake-exec-host.mjs): a good exec passes every check, and each broken one (a terminal's \r\n, output decoded a piece
// at a time, output held until exit, stdout closed early, slow writes, stdin held until end, stderr merged, a command
// timeout, a wrong exit code, a kill that leaves the process) fails the check that names it, in words that say what is
// wrong. Then the CLI: --exec-stream builds the host with the module's createHost and calls nothing but exec.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../dist/conformance/cli.js";
import { checkExecStream, EXEC_STREAM_CHECKS, EXEC_STREAM_FACTS, formatExecStream, PID_STATE_SCRIPT, randomText, readFacts, tcpListeners, textProblem } from "../dist/conformance/exec-stream.js";
import { fakeExecHost } from "./fake-exec-host.mjs";

/** Short bounds: the no-timeout check sleeps 2 s, each step waits at most 3 s, the large payload is 1 MiB, stdout is left unread 200 ms. */
const QUICK = { longMs: 2_000, stepMs: 3_000, largeBytes: 1024 * 1024, largeMs: 20_000, unreadMs: 200 };

async function run(options = {}, checkOptions = {}) {
	const host = fakeExecHost(options);
	try {
		const report = await checkExecStream(host, "machine-1", { ...QUICK, ...checkOptions });
		return { report, host, byId: Object.fromEntries(report.checks.map((check) => [check.id, check])) };
	} finally {
		host.stopAll();
	}
}

const failed = (report) => report.checks.filter((check) => check.status === "fail").map((check) => check.id);

test("a live, two-way exec that keeps text intact, with no timeout, passes every check, and the pre-check calls exec alone", async () => {
	const { report, host } = await run();
	assert.deepEqual(failed(report), [], formatExecStream(report));
	assert.equal(report.pass, true);
	assert.deepEqual(
		report.checks.map((check) => check.id),
		[...EXEC_STREAM_CHECKS],
	);
	assert.ok(host.calls.every((call) => call.id === "machine-1"));
	assert.match(formatExecStream(report), /exec PASS/);
});

test("kill's probe reads a killed process its parent has not reaped yet (a zombie) as gone, and a live one as running", async (t) => {
	if (!existsSync("/proc/self/status")) return t.skip("no /proc here: the probe falls back to kill -0 alone");
	const probe = (pid) => spawnSync("sh", ["-c", PID_STATE_SCRIPT, "sh", String(pid)], { encoding: "utf8" }).stdout.trim();
	const child = spawn("sh", ["-c", "exec sleep 600"], { stdio: "ignore" });
	await new Promise((done) => child.once("spawn", done));
	t.after(() => child.kill("SIGKILL"));
	assert.equal(probe(child.pid), "running", "a sleeping process runs");
	child.kill("SIGKILL");
	// spawnSync holds this event loop, so the child is not reaped until the probe has answered: the window CI hit.
	for (let at = 0; at < 200 && !/^State:\s*Z/m.test(readFileSync(`/proc/${child.pid}/status`, "utf8")); at++) spawnSync("sleep", ["0.01"]);
	assert.match(readFileSync(`/proc/${child.pid}/status`, "utf8"), /^State:\s*Z/m, "the killed child is a zombie until this loop reaps it");
	assert.equal(probe(child.pid), "gone", "a zombie has ended: kill -0 alone would read it as running");
	await new Promise((done) => (child.exitCode !== null || child.signalCode !== null ? done() : child.once("exit", done)));
	assert.equal(probe(child.pid), "gone", "once reaped, it has no state to read, and kill -0 finds nothing");
});

test("kill's probe reads the same under busybox sh, where a machine has it", async (t) => {
	const busybox = spawnSync("busybox", ["true"]);
	if (busybox.error || busybox.status !== 0) return t.skip("no busybox here");
	const probe = (pid) => spawnSync("busybox", ["sh", "-c", PID_STATE_SCRIPT, "sh", String(pid)], { encoding: "utf8" }).stdout.trim();
	assert.equal(probe(process.pid), "running", "this test's own process runs");
	assert.equal(probe(2 ** 22 + 1), "gone", "a pid past the kernel's limit is no process");
});

test("an exec on a terminal, whose \\n comes back as \\r\\n, fails the text checks, and says which character and why", async () => {
	const { report, byId } = await run({ tty: true });
	assert.equal(report.pass, false);
	assert.deepEqual(failed(report), ["stdout-text", "stdin-text", "large", "stdin-live"]);
	assert.match(byId["stdout-text"].words, /^U\+000A \(at byte 12\) came back on stdout as 0d 0a 0b 0c: your exec turns \\n into \\r\\n, as a terminal does/);
	assert.match(formatExecStream(report), /exec FAIL: 4 of 10 checks failed/);
});

test("an exec that decodes each piece of output as text on its own fails stdout-text on the U+FEFF it drops, and large on the U+FFFD a split character became", async () => {
	const { byId } = await run({ decodePieces: true });
	assert.match(byId["stdout-text"].words, /^U\+FEFF \(at byte 0\) came back on stdout as 01 02 03 04: your exec drops a U\+FEFF that starts its text/);
	assert.equal(byId.large.status, "fail");
	// The split character is random, so the fourth byte shown after ef bf bd is too (none at the very end).
	assert.match(byId.large.words, /came back through cat as ef bf bd( [0-9a-f]{2})?: U\+FFFD \(ef bf bd\), as a decoder makes of half a character/);
});

test("an exec that holds output until the process exits fails stdout-live in those words", async () => {
	const { byId } = await run({ bufferOutput: true });
	assert.equal(byId["stdout-live"].status, "fail");
	assert.match(byId["stdout-live"].words, /holds output until the process exits/);
	assert.equal(byId["stdin-live"].status, "fail");
	assert.equal(byId["stdout-text"].status, "pass");
});

test("an exec whose stdout ends after the first output, while the process still runs, fails stdout-live", async () => {
	const { byId } = await run({ closeStdoutEarly: true });
	assert.equal(byId["stdout-live"].status, "fail");
	assert.match(byId["stdout-live"].words, /^stdout ended right after "early", while the process still slept/);
});

test("large holds one deadline across its writes: slow writes fail it once largeMs passes, not a step per write later", async () => {
	const started = Date.now();
	const { byId } = await run({ slowWriteMs: 400 }, { largeMs: 1_000 });
	assert.equal(byId.large.status, "fail");
	assert.match(byId.large.words, /^writing 1048576 bytes of random text ran past 1 s, with \d+ bytes written/);
	assert.equal(byId["stdin-text"].status, "pass");
	assert.match(byId["stdout-unread"].words, /^the 64 writes to cat ran past 3 s after stdout was read, with \d+ bytes written: your exec's writes are too slow$/, "one deadline there too");
	assert.ok(Date.now() - started < 30_000);
});

test("large says its deadline ran out even when the timer the deadline cut short fires before the clock reads the deadline", async () => {
	// A timer and Date.now() keep different clocks: a timer may fire a millisecond before Date.now() reads its end. Here
	// Date.now() runs 1% slow, so the write that the deadline bounds always times out with the deadline not yet "passed".
	const real = Date.now;
	const from = real();
	Date.now = () => from + Math.floor((real() - from) * 0.99);
	try {
		const { byId } = await run({ slowWriteMs: 400 }, { largeMs: 1_000 });
		assert.equal(byId.large.status, "fail");
		assert.match(byId.large.words, /^writing 1048576 bytes of random text ran past 1 s, with \d+ bytes written/);
	} finally {
		Date.now = real;
	}
});

test("large stopped by the caller during a write its deadline bounds says it was stopped, never that the deadline ran out", async () => {
	const stop = new AbortController();
	const host = fakeExecHost({ slowWriteMs: 400 });
	const exec = host.exec.bind(host);
	let execs = 0;
	host.exec = async (...args) => {
		const answer = await exec(...args);
		// large's is the third exec: stdout-text's and stdin-text's come before it.
		if (++execs !== 3) return answer;
		const write = answer.write.bind(answer);
		let writes = 0;
		answer.write = (bytes) => {
			// The second piece starts 400 ms in, so what is left of the 1 s deadline bounds it, not the step.
			if (++writes === 2) stop.abort();
			return write(bytes);
		};
		return answer;
	};
	try {
		const report = await checkExecStream(host, "machine-1", { ...QUICK, largeMs: 1_000, signal: stop.signal });
		const large = report.checks.find((check) => check.id === "large");
		assert.equal(large.status, "fail");
		assert.match(large.words, /^aborted: writing 1048576 bytes of random text was stopped, with 26214\d bytes written/);
		assert.doesNotMatch(large.words, /ran past/);
	} finally {
		host.stopAll();
	}
});

test("an exec that holds stdin until end() fails stdin-live, and names stdin since output streams", async () => {
	const { byId } = await run({ holdStdin: true });
	assert.equal(byId["stdout-live"].status, "pass");
	assert.equal(byId["stdin-live"].status, "fail");
	assert.match(byId["stdin-live"].words, /holds stdin until end\(\)/);
	// No check ends stdin, so stdin held until then never comes back at all.
	assert.match(byId["stdin-text"].words, /^only 0 of \d+ bytes of text came back through cat within 3 s of the last write: your exec holds stdin/);
});

test("an exec that merges stderr into stdout fails stderr", async () => {
	const { byId } = await run({ mergeStderr: true });
	assert.equal(byId.stderr.status, "fail");
	assert.match(byId.stderr.words, /merges the two streams/);
});

test("an exec with a command timeout fails no-timeout", async () => {
	const { byId } = await run({ commandTimeoutMs: 1_000 });
	assert.equal(byId["no-timeout"].status, "fail");
	assert.match(byId["no-timeout"].words, /command timeout/);
});

test("a wait() that answers 0 for every process fails exit-code", async () => {
	const { report, byId } = await run({ exitCode: 0 });
	assert.deepEqual(failed(report), ["exit-code"]);
	assert.match(byId["exit-code"].words, /gave 0 from wait\(\), not 7/);
});

test("a kill() that lets go of the streams and leaves the process running fails kill", async () => {
	const { byId } = await run({ killDetaches: true });
	assert.equal(byId.kill.status, "fail");
	assert.match(byId.kill.words, /still runs in the machine/);
});

test("an exec that rejects fails every check with its own words, and one that throws at once is read the same", async () => {
	const refusing = {
		descriptor: { id: "refusing" },
		exec: async () => {
			throw new Error("no such machine");
		},
	};
	const refused = await checkExecStream(refusing, "m", QUICK);
	assert.ok(refused.checks.every((check) => check.status === "fail" && /failed: no such machine/.test(check.words)), JSON.stringify(refused.checks.map((check) => check.words)));
	const throwing = {
		descriptor: { id: "throwing" },
		exec: () => {
			throw new Error("not written yet");
		},
	};
	const threw = await checkExecStream(throwing, "m", QUICK);
	assert.ok(threw.checks.every((check) => check.status === "fail" && /threw: not written yet/.test(check.words)));
});

test("textProblem names the usual ways text changes: UTF-8 read as Latin-1, \\n to \\r\\n, \\r dropped, a leading U+FEFF dropped, a normalizer, a short read, bytes added", () => {
	const utf8 = (text) => new Uint8Array(Buffer.from(text, "utf8"));
	const sent = utf8("Aé\nB");
	assert.equal(textProblem(sent, sent, "back"), undefined);
	assert.match(textProblem(sent, utf8(Buffer.from("Aé\nB", "utf8").toString("latin1")), "on stdout"), /^U\+00E9 \(at byte 1\) came back on stdout as c3 83 c2 a9: your exec reads UTF-8 as Latin-1/);
	assert.match(textProblem(utf8("A\n"), utf8("A\r\n"), "on stdout"), /^U\+000A \(at byte 1\) came back on stdout as 0d 0a: your exec turns \\n into \\r\\n/);
	assert.match(textProblem(utf8("a\rb"), utf8("ab"), "on stdout"), /^U\+000D \(at byte 1\) came back on stdout as 62: your exec drops \\r/);
	assert.match(textProblem(utf8("e\u0301"), utf8("é"), "on stdout"), /^U\+0065 \(at byte 0\) came back on stdout as c3 a9: your exec changes text/);
	assert.match(textProblem(utf8("﻿Aé"), utf8("Aé"), "on stdout"), /^U\+FEFF \(at byte 0\) came back on stdout as 41 c3 a9: your exec drops a U\+FEFF that starts its text, as a TextDecoder does unless given ignoreBOM: true/);
	assert.match(textProblem(utf8("A𝄞"), utf8("A"), "on stdout"), /^only 1 of 5 bytes of text came back on stdout/);
	assert.match(textProblem(utf8("A"), utf8("A\n"), "on stdout"), /^1 bytes came back on stdout that were never sent/);
});

test("randomText is valid UTF-8 of the length asked, with characters of every width", () => {
	const text = randomText(64 * 1024);
	assert.equal(text.length, 64 * 1024);
	const decoded = new TextDecoder("utf-8", { fatal: true }).decode(text);
	const widths = new Set([...decoded].map((c) => Buffer.byteLength(c)));
	assert.deepEqual([...widths].sort(), [1, 2, 3, 4]);
	assert.ok(!decoded.includes("\0"));
});

test("an exec whose stdin waits on stdout being read, and never goes on once it is, fails stdout-unread in those words", async () => {
	const { byId } = await run({ stdinWaitsOnStdout: true });
	assert.equal(byId["stdout-unread"].status, "fail");
	assert.match(byId["stdout-unread"].words, /^write \d+ to cat, made while its stdout was left unread, still had no answer 3 s after stdout was read again \(\d+ bytes written\): your exec's stdin waits for stdout to be read and does not go on once it is/);
	assert.equal(byId["stdin-live"].status, "pass", "a reader that keeps up never stalls it");
});

test("an exec whose stdin waits while stdout is unread, and goes on once it is read, passes stdout-unread with every write", async () => {
	const { byId } = await run({ stdinWaitsForReader: true });
	assert.equal(byId["stdout-unread"].status, "pass", byId["stdout-unread"].words);
	assert.equal(byId["stdout-unread"].words, "4194304 bytes written to cat while its stdout was left unread for 0.2 s all came back, in order, once it was read");
});

/** A directory holding stand-ins for the probe's programs, each a sh script, put first on PATH for every exec. */
function shadowed(host, programs) {
	const dir = mkdtempSync(join(tmpdir(), "computer-exec-probe-"));
	for (const [name, body] of Object.entries(programs)) {
		writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
		chmodSync(join(dir, name), 0o755);
	}
	const exec = host.exec.bind(host);
	host.exec = (id, argv, ctx) => exec(id, ["env", `PATH=${dir}:${process.env.PATH}`, ...argv], ctx);
	return () => rmSync(dir, { recursive: true, force: true });
}

const factsOf = (report) => Object.fromEntries(report.facts.map((fact) => [fact.id, fact]));

test("after the checks, the report carries what the machine offers, read through exec: this machine's uid, arch, kernel and listeners", async () => {
	const { report } = await run();
	assert.equal(report.pass, true);
	assert.equal(report.factsProblem, undefined);
	assert.deepEqual(
		report.facts.map((fact) => fact.id),
		[...EXEC_STREAM_FACTS],
	);
	const facts = factsOf(report);
	const local = (argv) => spawnSync(argv[0], argv.slice(1), { encoding: "utf8" }).stdout.trim();
	assert.equal(facts.root.value, `uid ${process.getuid()}`);
	assert.equal(facts.arch.value, local(["uname", "-m"]));
	assert.match(facts.arch.means, /^facts\.arch "(amd64|arm64)"$/);
	assert.ok(facts.kernel.value.startsWith(local(["uname", "-sr"])), facts.kernel.value);
	assert.equal(facts.fuse.value === "no /dev/fuse", !existsSync("/dev/fuse"), facts.fuse.value);
	assert.notEqual(facts.listeners.value, "", "a listener line, or none");
	const text = formatExecStream(report);
	assert.match(text, /what the machine offers \(facts for the rest of your host, not checks of exec\):\n· root /);
	assert.match(text, /\n· arch +\S+: facts\.arch "(amd64|arm64)"\n/);
	assert.match(text, /\nexec PASS: .*\n$/, "the verdict is still the last line");
});

test("an exec whose unshare fails, both ways, says no netns and what it means; gVisor in dmesg is named; the facts never fail exec", async () => {
	const host = fakeExecHost();
	const restore = shadowed(host, { unshare: 'echo "unshare: unshare failed: Operation not permitted" >&2; exit 1', dmesg: 'echo "[    0.000000] Starting gVisor..."' });
	try {
		const report = await checkExecStream(host, "machine-1", QUICK);
		assert.equal(report.pass, true, formatExecStream(report));
		const facts = factsOf(report);
		assert.equal(facts.netns.value, "unshare -n failed (unshare: unshare failed: Operation not permitted); unshare -Urn failed (unshare: unshare failed: Operation not permitted)");
		assert.equal(facts.netns.means, "no netns: network none, open and allow can't be held by our fence on this vendor");
		assert.match(facts.kernel.value, /^gVisor \(.* as it reports; dmesg: \[ +0\.000000\] Starting gVisor\.\.\.\)$/);
		assert.match(formatExecStream(report), /\n· netns +unshare -n failed .*: no netns: network none, open and allow can't be held by our fence on this vendor\n/);
	} finally {
		restore();
		host.stopAll();
	}
	const working = fakeExecHost();
	const back = shadowed(working, { unshare: "exit 0" });
	try {
		const facts = factsOf(await checkExecStream(working, "machine-1", QUICK));
		assert.deepEqual([facts.netns.value, facts.netns.means], ["unshare -n works", "root makes a network namespace: our fence holds network none, open and allow (netns)"]);
	} finally {
		back();
		working.stopAll();
	}
});

test("readFacts and tcpListeners: listeners from the kernel's tables, v4 and v6, LISTEN alone; a machine with no unshare or /dev/fuse says so", () => {
	const tables = [
		"sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
		"0: 0100007F:C383 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1",
		"1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2 1",
		"2: 0100007F:C383 0100007F:9C40 01 00000000:00000000 00:00000000 00000000     0        0 3 1",
		"0: 00000000000000000000000001000000:0277 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 4 1",
		"1: 00000000000000000000000000000000:0016 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 5 1",
	];
	assert.deepEqual(tcpListeners(tables), ["127.0.0.1:50051", "0.0.0.0:22", "[::1]:631", "[::]:22"]);
	const read = ["table\t/proc/net/tcp", "table\t/proc/net/tcp6", ...tables.map((l) => `tcp\t${l}`)];
	const facts = Object.fromEntries(readFacts(["uid\t0", "arch\taarch64", "kernel\tLinux 6.1.0", "gvisor\t", "netns\tnone", "fuse\tabsent", ...read].join("\n")).map((f) => [f.id, f]));
	assert.equal(facts.root.value, "uid 0");
	assert.equal(facts.arch.means, 'facts.arch "arm64"');
	assert.match(facts.netns.means, /^not read: the machine has no unshare/);
	assert.equal(facts.fuse.means, "no Archil mount (mount:archil) on this vendor: the Archil client needs /dev/fuse");
	assert.deepEqual([facts.kernel.value, facts.kernel.means], ["Linux 6.1.0 (no gVisor marker in dmesg)", "the kernel as it reports itself: the isolation cases show how its fences hold"]);
	assert.equal(facts.listeners.value, "127.0.0.1:50051, 0.0.0.0:22, [::1]:631, [::]:22");
});

test("readFacts never reads a table it could not open as no listeners, nor a dmesg it could not read as no gVisor", () => {
	const of = (lines) => Object.fromEntries(readFacts(["uid\t0", ...lines].join("\n")).map((f) => [f.id, f]));
	const both = of(["table\t/proc/net/tcp", "table\t/proc/net/tcp6", "gvisor\t"]);
	assert.deepEqual([both.listeners.value, both.listeners.means], ["none", "no TCP listener before AgentRun runs anything: facts.vendorAgentPorts may be []"]);
	const one = of(["table\t/proc/net/tcp", "unreadable\t/proc/net/tcp6"]);
	assert.deepEqual([one.listeners.value, one.listeners.means], ["none (/proc/net/tcp6 could not be read)", "no TCP listener in /proc/net/tcp: check the table that could not be read before you set facts.vendorAgentPorts to []"]);
	const neither = of(["unreadable\t/proc/net/tcp", "unreadable\t/proc/net/tcp6", "gvisor\tunread"]);
	assert.equal(neither.listeners.value, "not read (/proc/net/tcp and /proc/net/tcp6 could not be read)");
	assert.match(neither.listeners.means, /^the listeners are unknown/);
	assert.match(neither.kernel.value, /\(dmesg could not be read, so gVisor is not ruled out\)$/);
	assert.doesNotMatch(neither.kernel.means, /Docker/);
});

test("a probe whose sh exits other than 0 is a facts problem, never facts read from what it printed", async () => {
	const { report } = await run({ exitCode: 3 });
	assert.deepEqual(report.facts, []);
	assert.equal(report.factsProblem, "the probe's sh exited 3 (stderr: none)");
});

test("the CLI's --exec-stream builds the host with the module's createHost and runs the pre-check alone; --quick shortens the long check", async () => {
	const dir = mkdtempSync(join(tmpdir(), "computer-exec-stream-"));
	try {
		const module = join(dir, "vendor.mjs");
		writeFileSync(
			module,
			`import { fakeExecHost } from ${JSON.stringify(new URL("./fake-exec-host.mjs", import.meta.url).href)};
export const given = [];
export function createHost(options) { given.push(options); return fakeExecHost(options.broken ? { tty: true } : {}); }
`,
		);
		const output = (into) => ({ write: (text, done) => (into.push(text), done?.()) });
		const out = [];
		const err = [];
		const started = Date.now();
		const code = await main(["--provider", module, "--exec-stream", "--machine", "box-7", "--quick", "--json"], { stdout: output(out), stderr: output(err), providerOptions: { env: {} } });
		assert.equal(code, 0, err.join(""));
		const report = JSON.parse(out.join(""));
		assert.equal(report.machine, "box-7");
		assert.equal(report.pass, true);
		assert.ok(Date.now() - started < 60_000, "--quick does not sleep 75 s");
		const broken = [];
		assert.equal(await main(["--provider", module, "--exec-stream", "--machine", "box-7", "--quick"], { stdout: output(broken), stderr: output([]), providerOptions: { env: {}, broken: true } }), 1);
		assert.match(broken.join(""), /✗ stdout-text +U\+000A \(at byte 12\) came back on stdout as 0d 0a/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the CLI refuses --exec-stream without --machine, beside a suite flag, and --machine or --quick without it; a module with no createHost is a usage error", async () => {
	const sink = { write: (_text, done) => done?.() };
	const err = [];
	const errs = { write: (text, done) => (err.push(text), done?.()) };
	assert.equal(await main(["--provider", "e2b", "--exec-stream"], { stdout: sink, stderr: errs }), 2);
	assert.match(err.join(""), /--exec-stream needs --machine <id>/);
	err.length = 0;
	assert.equal(await main(["--provider", "e2b", "--exec-stream", "--machine", "m", "--kind", "sandbox"], { stdout: sink, stderr: errs }), 2);
	assert.match(err.join(""), /--exec-stream runs alone: drop --kind/);
	err.length = 0;
	assert.equal(await main(["--provider", "e2b", "--machine", "m"], { stdout: sink, stderr: errs }), 2);
	assert.match(err.join(""), /--machine goes with --exec-stream/);
	err.length = 0;
	assert.equal(await main(["--provider", "docker", "--exec-stream", "--machine", "m"], { stdout: sink, stderr: errs }), 2);
	assert.match(err.join(""), /does not export createHost\(options\)/);
});
