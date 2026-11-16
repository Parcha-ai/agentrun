// exec that carries text, in pieces (src/hosted/framed-exec.ts): a vendor whose exec is a start call, an NDJSON event
// stream and a call per write, with no end of stdin and no kill (fake-text-host.mjs), passes the exec pre-check on real
// processes, and carries the shared adapter's create (the daemon's upload through exec, as base64) on the adapter's fake
// host. Then framedExec's own rules, ndjson, and the REST client's streamed body.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { runConformance } from "../dist/index.js";
import { checkExecStream, formatExecStream } from "../dist/conformance/exec-stream.js";
import { framedExec } from "../dist/hosted/framed-exec.js";
import { PID_KILL, PID_WRAPPER } from "../dist/hosted/scripts.js";
import { ndjson, rest } from "../dist/hosted/rest.js";
import { fakeExecHost } from "./fake-exec-host.mjs";
import { fakeHost } from "./fake-host.mjs";
import { textExec, textVendor, withSh } from "./fake-text-host.mjs";

const { HostedProvider } = await import("../dist/hosted/provider.js");

const QUICK = { longMs: 2_000, stepMs: 5_000, largeBytes: 1024 * 1024, largeMs: 30_000, unreadMs: 200 };
const TIMEOUTS = { requestMs: 2_000, createMs: 2_000, uploadMs: 5_000, execMs: 2_000, helloMs: 1_000, probeMs: 1_000, listMs: 2_000, goneMs: 500, pollMs: 5, listedMs: 500, listedStableMs: 0, mountMs: 2_000 };
/** The Core cases the adapter's fake host answers (its daemon is a stand-in): the ones a byte exec passes there too. */
const HOSTED_CORE = ["health.hello", "health.kind-consistent", "health.kind-served", "exec.abort", "provider.check-refuses", "provider.list", "provider.stop", "provider.owner", "provider.detach", "provider.network-change", "drift.hello-matches", "drift.network"];

/** The pid wrapper and its kill read /proc/<pid>/stat, which a Linux machine has; macOS has no /proc. */
const HAS_PROC = existsSync("/proc/self/stat");
const NO_PROC = "no /proc here: the pid wrapper and its kill read /proc/<pid>/stat";

const dir = mkdtempSync(join(tmpdir(), "computer-framed-"));
const DAEMON_PATH = join(dir, "computerd");
/** A stand-in daemon of every byte value: no text, so only the base64 upload carries it through a text exec. */
const DAEMON_BYTES = Buffer.from(Array.from({ length: 3 * 256 + 1 }, (_, i) => i % 256));
writeFileSync(DAEMON_PATH, DAEMON_BYTES);
test.after(() => rmSync(dir, { recursive: true, force: true }));

test("a text-only exec in pieces (a start, NDJSON events, a call per write; no end of stdin, no kill) on framedExec passes every check of the exec pre-check", async (t) => {
	if (!HAS_PROC) return t.skip(NO_PROC);
	const local = fakeExecHost();
	const vendor = await textVendor(local);
	t.after(async () => {
		local.stopAll();
		await vendor.close();
	});
	const report = await checkExecStream({ descriptor: { id: "fake-text" }, exec: textExec(vendor.base) }, "machine-1", QUICK);
	assert.equal(report.pass, true, formatExecStream(report));
	assert.ok(!vendor.requests.some((request) => /\/(end|kill)$/.test(request)), "the vendor has no end or kill to call");
});

test("the shared adapter over that exec, with no file API, uploads the daemon as base64 with no end of stdin, reaches it, and passes the Core cases its fake host answers", async (t) => {
	const fake = fakeHost({ fileApi: false });
	const vendor = await textVendor({ exec: withSh(fake.host) });
	t.after(() => vendor.close());
	const host = { ...fake.host, exec: textExec(vendor.base) };
	const provider = new HostedProvider(host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS, kind: "linux" });
	const made = await provider.create({ image: "img", lifetimeMs: 600_000, network: "none" }, { requestId: "req-framed" });
	assert.equal(made.ok, true, made.ok ? "" : `${made.error.code}: ${made.error.message}`);
	assert.deepEqual(fake.uploads.map(({ through }) => through), ["exec"]);
	assert.deepEqual([...fake.machines.values()][0].daemon.bytes, DAEMON_BYTES, "every byte value came through as base64 text");
	assert.equal((await provider.release(made.value, "delete")).ok, true);
	const report = await runConformance(provider, { image: "img", only: HOSTED_CORE, caseTimeoutMs: 10_000 });
	assert.deepEqual(
		report.results.filter((r) => r.status !== "pass").map((r) => `${r.id}: ${r.reason}`),
		[],
	);
	assert.deepEqual(report.results.map((r) => r.id).sort(), [...HOSTED_CORE].sort());
	assert.deepEqual(fake.live(), [], "nothing left behind");
});

/** Pieces in memory: each call recorded, writes held until released, events pushed by the test. */
function memoryPieces({ kill = false, end = false } = {}) {
	const calls = [];
	const writes = [];
	const streams = new Map();
	let next = 0;
	const pieces = {
		async start(argv) {
			const id = ++next;
			calls.push(["start", id, argv]);
			const queue = [];
			let wake = () => {};
			streams.set(id, {
				push(event) {
					queue.push(event);
					wake();
				},
				queued: () => queue.length,
			});
			streams.get(id).events = (async function* () {
				for (;;) {
					while (queue.length > 0) {
						const event = queue.shift();
						if (event === "close") return;
						if (event instanceof Error) throw event;
						yield event;
					}
					await new Promise((done) => (wake = done));
				}
			})();
			return id;
		},
		events: (id) => streams.get(id).events,
		write(id, text) {
			calls.push(["write", id, text]);
			return new Promise((done, failed) => writes.push({ text, done, failed }));
		},
		...(end ? { end: async (id) => void calls.push(["end", id]) } : {}),
		...(kill ? { kill: async (id) => void calls.push(["kill", id]) } : {}),
	};
	return { pieces, calls, writes, stream: (id) => streams.get(id) };
}

const ctx = { timeoutMs: 1_000 };
const tick = () => new Promise((done) => setImmediate(done));
const text = (bytes) => Buffer.concat(bytes).toString("utf8");
const collect = async (stream) => {
	const chunks = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return chunks;
};

test("framedExec sends writes one call at a time, in order, each answered before the next; one that fails fails every one after", async () => {
	const { pieces, calls, writes } = memoryPieces({ kill: true });
	const proc = await framedExec(pieces, ["cat"], ctx);
	const first = proc.write(Buffer.from("one "));
	const second = proc.write(Buffer.from("two "));
	await tick();
	assert.deepEqual(calls.filter(([what]) => what === "write").map(([, , text]) => text), ["one "], "the second waits for the first's answer");
	writes[0].done();
	await first;
	await tick();
	assert.deepEqual(calls.filter(([what]) => what === "write").map(([, , text]) => text), ["one ", "two "]);
	writes[1].failed(new Error("409: stdin is closed"));
	await assert.rejects(second, /409/);
	await assert.rejects(proc.write(Buffer.from("three")), /409/, "a write after a failed one fails with it");
	assert.equal(calls.filter(([what]) => what === "write").length, 2);
});

test("framedExec holds half a character until its write is whole, and end() sends what is left before the vendor's end", async () => {
	const { pieces, calls, writes } = memoryPieces({ kill: true, end: true });
	const proc = await framedExec(pieces, ["cat"], ctx);
	const euro = Buffer.from("€");
	const first = proc.write(euro.subarray(0, 1));
	await tick();
	await first;
	const second = proc.write(euro.subarray(1));
	await tick();
	writes[0].done();
	await second;
	const ended = proc.end();
	await tick();
	assert.deepEqual(
		calls.filter(([what]) => what !== "start").map(([what, , text]) => [what, text]),
		[
			["write", "€"],
			["end", undefined],
		],
	);
	await ended;
});

test("framedExec with the vendor's kill runs argv as given and kills through it; base64 output is bytes; an end with no exit event waits -1", async () => {
	const { pieces, calls, stream } = memoryPieces({ kill: true });
	const proc = await framedExec(pieces, ["printf", "x"], ctx);
	assert.deepEqual(calls[0], ["start", 1, ["printf", "x"]]);
	stream(1).push({ stream: "stdout", text: "a\r\n" });
	stream(1).push({ stream: "stdout", base64: Buffer.from([0x80, 0xff]).toString("base64") });
	stream(1).push({ stream: "stderr", text: "oops" });
	stream(1).push("close");
	const [out, err, code] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.wait()]);
	assert.deepEqual(Buffer.concat(out), Buffer.from([0x61, 0x0d, 0x0a, 0x80, 0xff]));
	assert.equal(text(err), "oops");
	assert.equal(code, -1);
	await proc.kill();
	assert.deepEqual(calls.at(-1), ["kill", 1]);
	await assert.rejects(proc.write(Buffer.from("late")), /the process has ended/);
});

test("framedExec fails wait() in the words of an event stream that broke, its output ended, and a kill after it is still the vendor's", async () => {
	const { pieces, calls, stream } = memoryPieces({ kill: true });
	const proc = await framedExec(pieces, ["sleep", "600"], ctx);
	stream(1).push({ stream: "stdout", text: "before\n" });
	stream(1).push(new Error("reading the command's exit code failed (denied): 403"));
	await assert.rejects(proc.wait(), /reading the command's exit code failed \(denied\): 403/);
	assert.equal(text(await collect(proc.stdout)), "before\n");
	await proc.kill();
	assert.deepEqual(calls.at(-1), ["kill", 1]);
});

test("framedExec with no vendor kill starts argv under a pid wrapper, keeps its line off stderr, and kills that pid while it has that start time", async () => {
	const { pieces, calls, stream } = memoryPieces();
	const proc = await framedExec(pieces, ["sleep", "600"], ctx);
	assert.deepEqual(calls[0], ["start", 1, [...PID_WRAPPER, "sleep", "600"]]);
	const err = collect(proc.stderr);
	stream(1).push({ stream: "stderr", text: "42" });
	stream(1).push({ stream: "stderr", text: "17 9876\nits own words" });
	const killing = proc.kill();
	await tick();
	assert.deepEqual(calls[1], ["start", 2, ["sh", "-c", PID_KILL, "sh", "4217", "9876"]]);
	stream(2).push({ exit: 0 });
	await killing;
	stream(1).push({ exit: 137 });
	assert.equal(await proc.wait(), 137);
	assert.equal(text(await err), "its own words");
});

test("framedExec with no vendor kill still kills by pid when the event stream broke with no exit read, and never once the exit was read", async () => {
	const lost = memoryPieces();
	const proc = await framedExec(lost.pieces, ["sleep", "600"], ctx);
	lost.stream(1).push({ stream: "stderr", text: "4217 9876\n" });
	lost.stream(1).push("close");
	assert.equal(await proc.wait(), -1, "no exit was read");
	const killing = proc.kill();
	await tick();
	assert.deepEqual(lost.calls[1], ["start", 2, ["sh", "-c", PID_KILL, "sh", "4217", "9876"]], "the process may still run: it is killed, if its pid still has its start time");
	lost.stream(2).push({ exit: 0 });
	await killing;

	const done = memoryPieces();
	const ran = await framedExec(done.pieces, ["true"], ctx);
	done.stream(1).push({ stream: "stderr", text: "4218 9877\n" });
	done.stream(1).push({ exit: 0 });
	assert.equal(await ran.wait(), 0);
	await ran.kill();
	assert.equal(done.calls.length, 1, "an exit read: the pid may be another process's, so no kill starts");
});

test("the pid wrapper's line is the pid and its start time, and the kill script kills that pid and every process under it only while the start time matches", async (t) => {
	if (!HAS_PROC) return t.skip(NO_PROC);
	// A pipeline under its sh, as the upload is: its children outlive a kill of the sh alone, waiting on stdin.
	const child = spawn(PID_WRAPPER[0], [...PID_WRAPPER.slice(1), "sh", "-c", "sleep 600 | cat; :"], { stdio: ["pipe", "ignore", "pipe"] });
	const stat = (pid) => {
		try {
			return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
		} catch {
			return undefined;
		}
	};
	const under = (pid) => readdirSync("/proc").filter((p) => /^\d+$/.test(p) && stat(p)?.[1] === pid);
	let kids = [];
	t.after(() => {
		child.kill("SIGKILL");
		for (const kid of kids) spawnSync("kill", ["-KILL", kid]);
	});
	const [line] = await once(child.stderr, "data");
	const [pid, start] = line.toString().trim().split(" ");
	assert.equal(pid, String(child.pid));
	assert.equal(start, stat(pid)[19], "field 22 of its stat");
	for (let at = 0; at < 100 && kids.length < 2; at++) {
		await pause(20);
		kids = under(pid);
	}
	assert.equal(kids.length, 2, "sleep and cat");
	const kill = (startTime) => spawnSync("sh", ["-c", PID_KILL, "sh", pid, startTime]).status;
	assert.equal(kill(String(Number(start) + 1)), 0);
	assert.equal(child.exitCode ?? child.signalCode, null, "another start time: another process, let be");
	assert.ok(kids.every((kid) => stat(kid) !== undefined), "and its children too");
	assert.equal(kill(start), 0);
	assert.deepEqual(await once(child, "exit"), [null, "SIGKILL"]);
	// One read of its stat per check: a process that ends between two reads is gone, not a TypeError.
	const running = (kid) => (stat(kid)?.[0] ?? "Z") !== "Z";
	for (let at = 0; at < 100 && kids.some(running); at++) await pause(20);
	assert.deepEqual(kids.filter(running), [], "every process under it is killed");
});

test("the kill script also kills a process left in the group the pid leads, whose parent exited: an sshd session's background job", async (t) => {
	if (!HAS_PROC) return t.skip(NO_PROC);
	// detached: the wrapper leads its own group, as a command an sshd starts does. The subshell's sleep is orphaned at
	// once (its parent, the subshell, exits), so it is under no process the tree walk finds, but still in the group.
	const child = spawn(PID_WRAPPER[0], [...PID_WRAPPER.slice(1), "sh", "-c", "(sleep 600 </dev/null >/dev/null 2>&1 &); exec sleep 601"], { stdio: ["ignore", "ignore", "pipe"], detached: true });
	const stat = (pid) => {
		try {
			return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
		} catch {
			return undefined;
		}
	};
	const [line] = await once(child.stderr, "data");
	const [pid, start] = line.toString().trim().split(" ");
	const inGroup = () => readdirSync("/proc").filter((p) => /^\d+$/.test(p) && p !== pid && stat(p)?.[2] === pid && stat(p)?.[0] !== "Z");
	t.after(() => {
		for (const kid of [pid, ...inGroup()]) spawnSync("kill", ["-KILL", kid]);
	});
	let orphans = [];
	for (let at = 0; at < 100 && orphans.length === 0; at++) {
		await pause(20);
		orphans = inGroup().filter((p) => stat(p)?.[1] !== pid);
	}
	assert.equal(orphans.length, 1, "the background sleep, out of the tree, in the group");
	assert.equal(spawnSync("sh", ["-c", PID_KILL, "sh", pid, start]).status, 0);
	for (let at = 0; at < 100 && inGroup().length > 0; at++) await pause(20);
	assert.deepEqual(inGroup(), [], "nothing is left in the group the pid led");
});

test("framedExec reads events no faster than stdout is read, and kill() lets a held reader go", async () => {
	const { pieces, stream } = memoryPieces({ kill: true });
	const proc = await framedExec(pieces, ["yes"], ctx);
	const piece = "y\n".repeat(32 * 1024);
	for (let i = 0; i < 64; i++) stream(1).push({ stream: "stdout", text: piece });
	for (let i = 0; i < 10; i++) await tick();
	const held = stream(1).queued();
	assert.ok(held > 50, `the events wait for the reader: ${held} of 64 still with the vendor`);
	const reader = proc.stdout[Symbol.asyncIterator]();
	for (let read = 0; read < 8 * piece.length; ) read += (await reader.next()).value.length;
	assert.ok(stream(1).queued() < held, "reading lets the events go on");
	await proc.kill();
	for (let i = 0; i < 10; i++) await tick();
	assert.equal(stream(1).queued(), 0, "once killed, the rest is read and dropped, never held");
	stream(1).push("close");
	assert.equal(await proc.wait(), -1);
});

test("framedExec drops output once its reader let go, so the exit still comes", async () => {
	const { pieces, stream } = memoryPieces({ kill: true });
	const proc = await framedExec(pieces, ["yes"], ctx);
	const piece = "y\n".repeat(32 * 1024);
	for (let i = 0; i < 8; i++) stream(1).push({ stream: "stdout", text: piece });
	await tick();
	proc.stdout.destroy();
	stream(1).push({ exit: 0 });
	assert.equal(await proc.wait(), 0);
});

test("framedExec keeps a U+FEFF that starts stdin: it is text, never a mark to drop", async () => {
	const { pieces, calls, writes } = memoryPieces({ kill: true });
	const proc = await framedExec(pieces, ["cat"], ctx);
	const wrote = proc.write(Buffer.from("﻿hello"));
	await tick();
	writes[0].done();
	await wrote;
	assert.deepEqual(calls[1], ["write", 1, "﻿hello"]);
});

test("ndjson reads each line's JSON as it comes, a line or a character split across chunks included", async () => {
	const body = (async function* () {
		yield Buffer.from('{"a":1}\n{"te');
		const euro = Buffer.from('xt":"€"}\n');
		yield euro.subarray(0, 7);
		yield euro.subarray(7);
		yield Buffer.from('\n{"last":true}');
	})();
	const got = [];
	for await (const value of ndjson(body)) got.push(value);
	assert.deepEqual(got, [{ a: 1 }, { text: "€" }, { last: true }]);
});

test("rest's stream hands back an accepted body as it comes, never cut by the call's bound; a refusal is a failure in words", async (t) => {
	// The call's bound is a timer: mocked, and moved past while the body is still coming.
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let body;
	let signal;
	const fetch = async (url, init) => {
		if (new URL(url).pathname === "/refused") return new Response("stdin is closed", { status: 409 });
		signal = init.signal;
		const stream = new ReadableStream({ start: (controller) => (body = controller) });
		body.enqueue(new TextEncoder().encode('{"n":1}\n'));
		return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
	};
	const api = rest({ base: "https://vendor.example.test", headers: () => ({}), vendor: "acme", timeoutMs: 200, fetch });
	const opened = await api.stream("GET", api.url("/events"));
	assert.equal(opened.ok, true);
	const lines = ndjson(opened.value.body)[Symbol.asyncIterator]();
	assert.deepEqual((await lines.next()).value, { n: 1 }, "the first line comes before the body ends");
	t.mock.timers.tick(400);
	assert.equal(signal.aborted, false, "the call's 200 ms bound let go once the answer was taken");
	body.enqueue(new TextEncoder().encode('{"n":2}\n'));
	body.close();
	assert.deepEqual((await lines.next()).value, { n: 2 }, "a body read past the call's 200 ms bound is not cut by it");
	assert.equal((await lines.next()).done, true);
	assert.deepEqual(await api.stream("POST", api.url("/refused")), { ok: false, error: { code: "invalid", message: "POST /refused: 409 stdin is closed" } });
});
