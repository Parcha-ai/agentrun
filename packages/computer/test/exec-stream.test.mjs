// The exec pre-check (src/conformance/exec-stream.ts) on a fake host whose exec runs real processes on this machine
// (fake-exec-host.mjs): a good exec passes every check, and each broken one (UTF-8 decode, output held until exit, stdout
// closed early, slow writes, stdin held until end, stderr merged, a command timeout, a wrong exit code, a kill that leaves
// the process) fails the check
// that names it, in words that say what is wrong. Then the CLI: --exec-stream builds the host with the module's
// createHost and calls nothing but exec.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../dist/conformance/cli.js";
import { bytesProblem, checkExecStream, EXEC_STREAM_CHECKS, formatExecStream } from "../dist/conformance/exec-stream.js";
import { fakeExecHost } from "./fake-exec-host.mjs";

/** Short bounds: the no-timeout check sleeps 2 s, each step waits at most 3 s, the large payload is 1 MiB. */
const QUICK = { longMs: 2_000, stepMs: 3_000, largeBytes: 1024 * 1024, largeMs: 20_000 };

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

test("a live, two-way, byte-exact exec with no timeout passes every check, and the pre-check calls exec alone", async () => {
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

test("an exec that decodes stdout as UTF-8 fails the byte checks, and says byte 0x80 came back as ef bf bd", async () => {
	const { report, byId } = await run({ decodeUtf8: true });
	assert.equal(report.pass, false);
	assert.deepEqual(failed(report), ["stdout-bytes", "stdin-bytes", "large"]);
	assert.match(byId["stdout-bytes"].words, /^byte 0x80 came back on stdout as ef bf bd: your exec decodes UTF-8/);
	assert.match(formatExecStream(report), /exec FAIL: 3 of 9 checks failed/);
});

test("an exec that holds output until the process exits fails stdout-live in those words", async () => {
	const { byId } = await run({ bufferOutput: true });
	assert.equal(byId["stdout-live"].status, "fail");
	assert.match(byId["stdout-live"].words, /holds output until the process exits/);
	assert.equal(byId["stdin-live"].status, "fail");
	assert.equal(byId["stdout-bytes"].status, "pass");
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
	assert.match(byId.large.words, /^writing 1048576 random bytes ran past 1 s, with \d+ bytes written/);
	assert.equal(byId["stdin-bytes"].status, "pass");
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
		assert.match(byId.large.words, /^writing 1048576 random bytes ran past 1 s, with \d+ bytes written/);
	} finally {
		Date.now = real;
	}
});

test("large stopped by the caller during a write its deadline bounds says it was stopped, never that the deadline ran out", async () => {
	const stop = new AbortController();
	const host = fakeExecHost({ slowWriteMs: 400 });
	const exec = host.exec.bind(host);
	let largeWrites = 0;
	host.exec = async (...args) => {
		const answer = await exec(...args);
		const write = answer.write.bind(answer);
		answer.write = (bytes) => {
			// The second 256 KiB chunk starts 400 ms in, so what is left of the 1 s deadline bounds it, not the step.
			if (bytes.length === 256 * 1024 && ++largeWrites === 2) stop.abort();
			return write(bytes);
		};
		return answer;
	};
	try {
		const report = await checkExecStream(host, "machine-1", { ...QUICK, largeMs: 1_000, signal: stop.signal });
		const large = report.checks.find((check) => check.id === "large");
		assert.equal(large.status, "fail");
		assert.match(large.words, /^aborted: writing 1048576 random bytes was stopped, with 262144 bytes written/);
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
	assert.equal(byId["stdin-bytes"].status, "pass");
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
		id: "refusing",
		exec: async () => {
			throw new Error("no such machine");
		},
	};
	const refused = await checkExecStream(refusing, "m", QUICK);
	assert.ok(refused.checks.every((check) => check.status === "fail" && /failed: no such machine/.test(check.words)), JSON.stringify(refused.checks.map((check) => check.words)));
	const throwing = {
		id: "throwing",
		exec: () => {
			throw new Error("not written yet");
		},
	};
	const threw = await checkExecStream(throwing, "m", QUICK);
	assert.ok(threw.checks.every((check) => check.status === "fail" && /threw: not written yet/.test(check.words)));
});

test("bytesProblem names the usual manglings: Latin-1 read as UTF-8, \\n to \\r\\n, a short read, bytes added", () => {
	const sent = Uint8Array.from([0x41, 0xe9, 0x0a, 0x42]);
	assert.equal(bytesProblem(sent, sent, "back"), undefined);
	assert.match(bytesProblem(sent, Uint8Array.from([0x41, 0xc3, 0xa9, 0x0a, 0x42]), "on stdout"), /byte 0xe9 came back on stdout as c3 a9 0a: your exec reads bytes as Latin-1/);
	assert.match(bytesProblem(Uint8Array.from([0x41, 0x0a]), Uint8Array.from([0x41, 0x0d, 0x0a]), "on stdout"), /turns \\n into \\r\\n/);
	assert.match(bytesProblem(Uint8Array.from([0x41, 0x00, 0x42]), Uint8Array.from([0x41]), "on stdout"), /only 1 of 3 bytes came back on stdout: the first missing byte is 0x00/);
	assert.match(bytesProblem(Uint8Array.from([0x41]), Uint8Array.from([0x41, 0x0a]), "on stdout"), /1 bytes came back on stdout that were never sent/);
});

test("the CLI's --exec-stream builds the host with the module's createHost and runs the pre-check alone; --quick shortens the long check", async () => {
	const dir = mkdtempSync(join(tmpdir(), "computer-exec-stream-"));
	try {
		const module = join(dir, "vendor.mjs");
		writeFileSync(
			module,
			`import { fakeExecHost } from ${JSON.stringify(new URL("./fake-exec-host.mjs", import.meta.url).href)};
export const given = [];
export function createHost(options) { given.push(options); return fakeExecHost(options.broken ? { decodeUtf8: true } : {}); }
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
		assert.match(broken.join(""), /✗ stdout-bytes +byte 0x80 came back on stdout as ef bf bd/);
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
