// GroundboxProvider's host against a stand-in for Groundbox's API (fake-groundbox.mjs: a fetch that answers in the
// API's shapes, and the command stream as a socket whose commands are real processes here): what the host sends for
// create, get, list, delete, exec, upload and extend, and how it reads the answers back. The adapter's lifecycle is
// tested once, against its fake host (hosted-provider.test.mjs); Groundbox's own is proven live.
import assert from "node:assert/strict";
import { chmodSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fakeCommands, recorder } from "./fake-groundbox.mjs";

const { GroundboxProvider, create } = await import("../dist/groundbox.js");
const { GROUNDBOX, GROUNDBOX_OWN_IMAGE } = await import("../dist/descriptors/index.js");
const { checkExecStream, formatExecStream } = await import("../dist/conformance/exec-stream.js");
const { GROUNDBOX_ENV: ENV, settingsFromEnv, createProvider, createHost, conformanceImage, sweepScope } = await import("../dist/conformance/groundbox.js");

const KEY = "gbx_fake_key_0123456789";
const API = "https://api.example.test/v1";
const CTX = { timeoutMs: 5_000 };
const ID = "sbx_0123456789ab";
const NAME = "computer-0123456789ab";
const LABELS = { "agentrun.computer": "1", "agentrun.computer.name": NAME };
/** The pre-check's probes read /proc/<pid>/status, which a Linux machine has; macOS has no /proc. */
const HAS_PROC = existsSync("/proc/self/stat");
/** The kill runs the shared pid kill as root: as root already, or through passwordless sudo, as in a sandbox. */
const CAN_KILL = HAS_PROC && (process.getuid() === 0 || (() => { try { execFileSync("sudo", ["-n", "true"], { stdio: "ignore" }); return true; } catch { return false; } })());
/**
 * The pids of process group `pgid` still running, from /proc. A killed process is no longer running though kill(-pgid, 0)
 * still finds it until it is reaped: a zombie (Z), or one its reaper has taken and not yet released (X).
 */
const runningIn = (pgid) =>
	readdirSync("/proc").filter((pid) => {
		if (!/^\d+$/.test(pid)) return false;
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const [state, , group] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			return Number(group) === pgid && state !== "Z" && state !== "X";
		} catch {
			return false; // it ended while the scan ran
		}
	});

const sandbox = (fields = {}) => ({ id: ID, status: "running", metadata: LABELS, created_at: "2026-11-18T00:00:00.000Z", stop_reason: null, ...fields });
const refusal = (code, message) => ({ error: { code, message } });

/** Every fake command stream a host here was given: at the end, the directory each start named goes. */
const allStreams = new Set();
after(() => {
	// A command the stand-in killed at a test's end (stopAll) is past removing its own directory, as a sandbox's would be.
	for (const { opened } of allStreams) for (const { sent } of opened) if (sent[0]?.type === "start") rmSync(sent[0].args[4], { recursive: true, force: true });
});

/** A host over a recorder of the API and, for exec, the fake command stream. */
function hostOf(route, streams = fakeCommands(), options = {}) {
	allStreams.add(streams);
	// POST .../exec is the stand-in's own: a write to a command's fifo, or its kill, run for real.
	const { calls, fetch } = recorder((method, path, body, headers) => (method === "POST" && path.endsWith("/exec") && streams.exec ? streams.exec(body) : route(method, path, body, headers)));
	const { host } = new GroundboxProvider({ apiKey: KEY, apiUrl: API, fetch, webSocket: streams.webSocket, daemonPath: "/nonexistent/computerd", ...options });
	return { calls, host, streams };
}

const request = (fields = {}) => ({ name: NAME, image: GROUNDBOX_OWN_IMAGE, labels: LABELS, lifetimeMs: 600_000, backstopAt: new Date(Date.now() + 3_600_000).toISOString(), egress: false, ...fields });

/** What a stream gave, as text. */
const textOf = async (stream) => Buffer.concat(await Array.fromAsync(stream, (chunk) => Buffer.from(chunk))).toString("utf8");

test("the descriptor: a sandbox under GROUNDBOX_API_KEY, every network form through init, the run's folder a synced folder, no default image but the box image prepareImage() answers", async () => {
	assert.deepEqual([GROUNDBOX.id, GROUNDBOX.label, GROUNDBOX.metered], ["groundbox", "Groundbox", true]);
	assert.deepEqual(GROUNDBOX.keys, [{ name: "GROUNDBOX_API_KEY", option: "apiKey", required: true }]);
	assert.equal(GROUNDBOX.defaultImage, undefined);
	assert.equal(GROUNDBOX.prepareImage, true);
	assert.equal(GROUNDBOX_OWN_IMAGE, "default");
	// The box image the release publishes, by its public tag, with no call to Groundbox.
	const prepared = await new GroundboxProvider({ apiKey: KEY, daemonPath: "/nonexistent/computerd", fetch: async () => assert.fail("prepareImage called Groundbox") }).prepareImage();
	assert.equal(prepared.ok, true);
	assert.match(prepared.value, /^ghcr\.io\/parcha-ai\/agentrun-box:[0-9a-f]{12}$/);
	const { host } = hostOf(() => undefined);
	const capabilities = new GroundboxProvider({ apiKey: KEY, daemonPath: "/nonexistent/computerd" }).capabilities();
	assert.deepEqual([capabilities.kind, capabilities.os, capabilities.daemon, capabilities.isolation], ["linux", "linux", "child", "microvm"]);
	assert.deepEqual(capabilities.groups, ["exec", "files", "processes"]);
	assert.deepEqual(capabilities.network, ["none", "open", "allow"]);
	assert.deepEqual(capabilities.mount, ["sync"]);
	// A day unless the provider is given another, up to Groundbox's 30 days less the backstop's margin.
	assert.equal(capabilities.maxLifetimeMs, 24 * 3_600_000);
	assert.deepEqual([host.facts.lifetime, host.facts.arch, host.facts.vendorAgentPorts, host.facts.maxLifetimeMs], ["janitor", "amd64", [], (30 * 24 * 60 - 6) * 60_000]);
});

test("the options are checked in words that never hold the key: the key, the API URL, the disk, and a daemon user that is the sandbox's own", async () => {
	assert.throws(() => new GroundboxProvider({}), /options\.apiKey, the Groundbox API key, is required/);
	assert.throws(() => new GroundboxProvider({ apiKey: KEY, apiUrl: "api.groundbox.dev" }), (error) => /the Groundbox API URL is not a URL/.test(error.message) && !error.message.includes(KEY));
	assert.throws(() => new GroundboxProvider({ apiKey: KEY, diskGb: 500 }), /diskGb is a whole number of GB, 1 to 100/);
	assert.throws(() => new GroundboxProvider({ apiKey: KEY, daemonUser: "1001:1001" }), /the uid of the sandbox's own user/);
	assert.throws(() => new GroundboxProvider({ apiKey: KEY, maxLifetimeMs: 30 * 24 * 3_600_000 }), /at most 2591640000 ms/, "the cap may only lower the fact");
	assert.equal(new GroundboxProvider({ apiKey: KEY, maxLifetimeMs: 7 * 24 * 3_600_000, daemonPath: "/nonexistent/computerd" }).capabilities().maxLifetimeMs, 7 * 24 * 3_600_000);
	assert.equal((await create({ apiKey: KEY, daemonPath: "/nonexistent/computerd" })).id, "groundbox");
});

test("check takes \"default\", a template or a public image, whole CPUs and whole GiB up to 4 a CPU, and labels Groundbox's metadata holds", () => {
	const { host } = hostOf(() => undefined);
	const fields = (spec) => host.check(spec).map((one) => one.field);
	for (const image of ["default", "python-ml", "python-ml:3", "tpl_0123456789ab", "ubuntu:24.04", "ghcr.io/org/image", "ghcr.io/parcha-ai/agentrun-box:87f44537b8b7", "python@sha256:abc"]) assert.deepEqual(fields({ image }), [], image);
	for (const image of ["", "ubuntu 24.04", "a\nb", "x".repeat(513), 7]) assert.deepEqual(fields({ image }), ["image"], String(image));
	assert.deepEqual(fields({ cpus: 16, memoryMb: 65_536 }), []);
	assert.deepEqual(fields({ cpus: 1.5 }), ["cpus"]);
	assert.deepEqual(fields({ cpus: 17 }), ["cpus"]);
	assert.deepEqual(fields({ memoryMb: 1500 }), ["memoryMb"]);
	// With no CPUs named Groundbox gives 2, so 8 GiB at most.
	assert.deepEqual(fields({ memoryMb: 8192 }), []);
	assert.match(host.check({ memoryMb: 16_384 })[0].message, /at most 4 GiB of memory a CPU \(8192 with 2 CPUs\): name more cpus, up to 16/);
	assert.deepEqual(fields({ cpus: 4, memoryMb: 16_384 }), []);
	assert.deepEqual(fields({ labels: { team: "x".repeat(512) } }), []);
	assert.match(host.check({ labels: { team: "x".repeat(513) } })[0].message, /at most 512 characters: team holds 513/);
	assert.match(host.check({ labels: { ["n".repeat(65)]: "1" } })[0].message, /label names of 1 to 64 characters/);
});

test("create posts the labels as metadata, Groundbox's timer at the backstop, a size only when the spec names one, and an Idempotency-Key of the request", async () => {
	const { calls, host } = hostOf((method) => (method === "POST" ? [200, sandbox({ status: "starting" })] : undefined));
	const backstopAt = new Date(Date.now() + 3_600_000).toISOString();
	assert.deepEqual(await host.create(request({ backstopAt }), CTX), { id: ID });
	assert.deepEqual([calls[0].method, calls[0].path], ["POST", "/v1/sandboxes"]);
	assert.deepEqual(calls[0].body, { timeout_minutes: 60, metadata: LABELS });
	assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`);
	assert.equal(calls[0].headers["Idempotency-Key"], `agentrun-${NAME}-${backstopAt}`);
	// A template, a size and the provider's disk: memory in the whole GB Groundbox takes.
	const sized = hostOf(() => [200, sandbox()], undefined, { diskGb: 40 });
	await sized.host.create(request({ image: "python-ml:3", cpus: 4, memoryMb: 8192, backstopAt }), CTX);
	assert.deepEqual(sized.calls[0].body, { template: "python-ml:3", cpus: 4, memory_gb: 8, disk_gb: 40, timeout_minutes: 60, metadata: LABELS });
	// A second create of the same computer is another request: its backstop, and so its key, differ.
	await sized.host.create(request({ backstopAt: new Date(Date.parse(backstopAt) + 1).toISOString() }), CTX);
	assert.notEqual(sized.calls[1].headers["Idempotency-Key"], sized.calls[0].headers["Idempotency-Key"]);
	// Any image that is not "default" or a template is a public image, sent as image (the box image among them).
	const imaged = hostOf(() => [200, sandbox()]);
	for (const image of ["ghcr.io/parcha-ai/agentrun-box:87f44537b8b7", "ubuntu:24.04", "python@sha256:abc"]) await imaged.host.create(request({ image, backstopAt }), CTX);
	assert.deepEqual(
		imaged.calls.map((call) => call.body),
		["ghcr.io/parcha-ai/agentrun-box:87f44537b8b7", "ubuntu:24.04", "python@sha256:abc"].map((image) => ({ image, timeout_minutes: 60, metadata: LABELS })),
	);
});

test("create is sent again on no answer under the same Idempotency-Key and body, so Groundbox starts one sandbox", async () => {
	let sent = 0;
	const { calls, host } = hostOf(() => (++sent === 1 ? [503, refusal("no_capacity", "No box has room right now")] : [200, sandbox()]));
	assert.deepEqual(await host.create(request(), CTX), { id: ID });
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[1].body, calls[0].body);
	assert.equal(calls[1].headers["Idempotency-Key"], calls[0].headers["Idempotency-Key"]);
});

test("create's refusals: the API's code as the adapter's, in its words and never the key; a sandbox Groundbox could not start; a label its metadata can't hold", async () => {
	const refused = async (status, code, message) => {
		const { host } = hostOf(() => [status, refusal(code, message)]);
		return host.create(request(), CTX).then(
			() => assert.fail("create answered"),
			(error) => error,
		);
	};
	const capped = await refused(429, "concurrency_limit", "This team can run 5 sandboxes at once");
	assert.deepEqual([capped.code, capped.message], ["limit", "POST /v1/sandboxes answered 429 concurrency_limit: This team can run 5 sandboxes at once"]);
	assert.equal((await refused(402, "insufficient_balance", "Add credits")).code, "limit");
	assert.equal((await refused(401, "unauthorized", "Unknown API key")).code, "denied");
	assert.equal((await refused(402, "paid_plan_required", "Sandboxes need the paid plan")).code, "denied");
	assert.equal((await refused(403, "missing_scope", "This key lacks sandboxes:write")).code, "denied");
	assert.equal((await refused(400, "bad_request", "template: no such template")).code, "invalid");
	assert.equal((await refused(409, "idempotency_key_reused", "This Idempotency-Key was used for a different request")).code, "refused");
	for (const error of [capped, await refused(401, "unauthorized", "Unknown API key")]) assert.doesNotMatch(error.message, new RegExp(KEY));
	const failed = hostOf(() => [200, sandbox({ status: "failed", stop_reason: "error" })]);
	await assert.rejects(failed.host.create(request(), CTX), (error) => error.code === "vendor" && /did not start sbx_0123456789ab: its status is failed \(error\)/.test(error.message));
	const long = hostOf(() => assert.fail("the API was called"));
	await assert.rejects(long.host.create(request({ labels: { ...LABELS, "agentrun.computer.network": `allow:${"a".repeat(600)}` } }), CTX), (error) => error.code === "limit" && /agentrun\.computer\.network holds 606/.test(error.message));
});

test("get reads Groundbox's statuses as the adapter's, an ended sandbox's record as none, and a 404 as not found", async () => {
	const states = { queued: "starting", starting: "starting", resuming: "starting", running: "running", pausing: "stopped", paused: "stopped", shutting_down: "stopped", shut_down: "stopped", stopping: "gone" };
	for (const [status, state] of Object.entries(states)) {
		const { calls, host } = hostOf(() => [200, sandbox({ status })]);
		assert.deepEqual(await host.get(ID, CTX), { id: ID, labels: LABELS, state, createdAt: new Date("2026-11-18T00:00:00.000Z") }, status);
		assert.deepEqual([calls[0].method, calls[0].path], ["GET", `/v1/sandboxes/${ID}`]);
	}
	for (const status of ["stopped", "failed"]) assert.equal(await hostOf(() => [200, sandbox({ status })]).host.get(ID, CTX), undefined, `${status} is a record of a sandbox that will not come back`);
	// A status this host does not know is there and not running, so the janitor still ends it.
	const unknown = await hostOf(() => [200, sandbox({ status: "migrating" })]).host.get(ID, CTX);
	assert.deepEqual([unknown.state, unknown.why], ["stopped", "Groundbox reads its status as migrating"]);
	await assert.rejects(hostOf(() => [404, refusal("not_found", "No sandbox sbx_0123456789ab")]).host.get(ID, CTX), (error) => error.code === "not_found");
});

test("list is one listing of the live sandboxes that carry every label, the labels as the API's metadata filter, every page", async () => {
	const query = "live=true&limit=200&metadata%5Bagentrun.computer%5D=1&metadata%5Bagentrun.computer.name%5D=computer-0123456789ab";
	const pages = {
		[query]: { data: [sandbox({ id: "sbx_a" }), sandbox({ id: "sbx_starting", status: "starting" })], next_cursor: "page 2" },
		[`${query}&cursor=page%202`]: { data: [sandbox({ id: "sbx_kept", status: "shut_down" }), sandbox({ id: "sbx_going", status: "stopping" })], next_cursor: null },
	};
	const { calls, host } = hostOf((method, path) => [200, pages[path.split("?")[1]]]);
	const listed = await host.list(LABELS, CTX);
	assert.deepEqual(
		listed.map(({ id, state }) => [id, state]),
		[["sbx_a", "running"], ["sbx_starting", "starting"], ["sbx_kept", "stopped"], ["sbx_going", "gone"]],
	);
	assert.deepEqual(calls.map((call) => call.path), [`/v1/sandboxes?${query}`, `/v1/sandboxes?${query}&cursor=page%202`]);
	// With no label asked, every live sandbox of the team; a listing that fails fails the list.
	const all = hostOf(() => [200, { data: [], next_cursor: null }]);
	await all.host.list({}, CTX);
	assert.equal(all.calls[0].path, "/v1/sandboxes?live=true&limit=200");
	await assert.rejects(hostOf(() => [200, { data: "nothing" }]).host.list(LABELS, CTX), /a page that is not a list of sandboxes/);
	await assert.rejects(hostOf(() => [401, refusal("unauthorized", "Unknown API key")]).host.list(LABELS, CTX), (error) => error.code === "denied");
});

test("delete deletes the sandbox, and one Groundbox no longer has is not found, which the adapter reads as done", async () => {
	const { calls, host } = hostOf(() => [200, sandbox({ status: "stopped", stop_reason: "deleted" })]);
	await host.delete(ID, CTX);
	assert.deepEqual([calls[0].method, calls[0].path], ["DELETE", `/v1/sandboxes/${ID}`]);
	await assert.rejects(hostOf(() => [404, refusal("not_found", "No sandbox")]).host.delete(ID, CTX), (error) => error.code === "not_found");
});

test("upload puts the bytes through the files API; extend sends the whole metadata back with the deadline label alone changed", async () => {
	const stored = { ...LABELS, "agentrun.computer.deadline": "2026-11-18T00:30:00.000Z", team: "research" };
	const { calls, host } = hostOf((method) => (method === "PUT" ? [200, { path: "/tmp/agentrun-computerd-0123", size_bytes: 3 }] : [200, sandbox({ metadata: stored })]));
	await host.upload(ID, "/tmp/agentrun-computerd-0123", new Uint8Array([1, 2, 3]), CTX);
	assert.deepEqual([calls[0].method, calls[0].path, [...calls[0].body]], ["PUT", `/v1/sandboxes/${ID}/files?path=%2Ftmp%2Fagentrun-computerd-0123`, [1, 2, 3]]);
	await host.extend(ID, new Date("2026-11-18T00:45:00.000Z"), CTX);
	assert.deepEqual([calls[1].method, calls[2].method, calls[2].path], ["GET", "PATCH", `/v1/sandboxes/${ID}`]);
	assert.deepEqual(calls[2].body, { metadata: { ...stored, "agentrun.computer.deadline": "2026-11-18T00:45:00.000Z" } });
});

test("exec starts argv as a resumable command under the fifo's sh, its output as base64, the key on the upgrade alone; a write is one answered call into the fifo; stderr apart, the exit code", async (t) => {
	const { calls, host, streams } = hostOf(() => undefined);
	t.after(streams.stopAll);
	const proc = await host.exec(ID, ["sh", "-c", 'read -r line; echo "got $line and $1"; echo "to stderr" >&2; exit 7', "sh", "it's"], CTX);
	const [opened] = streams.opened;
	assert.equal(opened.url, `wss://api.example.test/v1/sandboxes/${ID}/exec/stream`);
	assert.deepEqual(opened.headers, { Authorization: `Bearer ${KEY}` });
	const { args, ...start } = opened.sent[0];
	assert.deepEqual(start, { type: "start", resumable: true, encoding: "base64", timeout_s: 30 * 24 * 3600 });
	const dir = args[4];
	assert.match(dir, /^\/tmp\/\.agentrun-exec-[0-9a-f]{16}$/);
	assert.deepEqual([args[0], args[1], args[3], ...args.slice(5)], ["sh", "-c", "sh", "sh", "-c", 'read -r line; echo "got $line and $1"; echo "to stderr" >&2; exit 7', "sh", "it's"]);
	const text = "héllo \r wörld \u{1F600} ﻿ end\n";
	await proc.write(Buffer.from(text));
	// No end of stdin: a fifo held open has none, and end() answers all the same.
	await proc.end();
	assert.deepEqual([await textOf(proc.stdout), await textOf(proc.stderr), await proc.wait()], [`got ${text.trimEnd()} and it's\n`, "to stderr\n", 7]);
	const writes = calls.filter((call) => call.path === `/v1/sandboxes/${ID}/exec`);
	// The write's script, its directory and its stdin; what the script takes is tested by sh below.
	assert.deepEqual(
		writes.map(({ body: { args, ...rest } }) => [args.slice(0, 2), args.slice(3), rest]),
		[[["sh", "-c"], ["sh", dir], { timeout_s: 60, stdin_base64: Buffer.from(text).toString("base64") }]],
	);
	assert.equal(existsSync(dir), false, "the sh removed its directory, with its fifo and its pid record");
	assert.doesNotMatch(JSON.stringify(opened.sent), new RegExp(KEY));
	await assert.rejects(proc.write(Buffer.from("a secret line\n")), (error) => !/secret/.test(error.message));
});

test("a long write goes in calls of at most 256 KiB, one after another, and every byte comes back as it was written", async (t) => {
	const { calls, host, streams } = hostOf(() => undefined);
	t.after(streams.stopAll);
	const text = `x${"\u{1F600}".repeat(100_000)}${"\u0000".repeat(150_000)}\r\n`;
	const bytes = Buffer.from(text);
	const proc = await host.exec(ID, ["head", "-c", String(bytes.length)], CTX);
	await proc.write(bytes);
	const out = Buffer.concat(await Array.fromAsync(proc.stdout, (chunk) => Buffer.from(chunk)));
	assert.ok(out.equals(bytes), "every byte came back as it was written");
	assert.equal(await proc.wait(), 0);
	const sizes = calls.filter((call) => call.path.endsWith("/exec")).map((call) => Buffer.from(call.body.stdin_base64, "base64").length);
	assert.deepEqual(sizes, [262_144, 262_144, bytes.length - 524_288]);
});

test("a socket that goes while the command runs is no end: another attaches from the position read to, no output lost or read twice, and writes go on meanwhile", { timeout: 30_000 }, async (t) => {
	const { host, streams } = hostOf(() => undefined);
	t.after(streams.stopAll);
	const proc = await host.exec(ID, ["sh", "-c", 'while read -r l; do echo "echo $l"; [ "$l" = end ] && exit 0; done'], CTX);
	let read = "";
	let ended = false;
	let more = () => {};
	const reading = (async () => {
		try {
			for await (const chunk of proc.stdout) {
				read += Buffer.from(chunk).toString();
				more();
			}
		} finally {
			ended = true;
			more();
		}
	})();
	/** Answers once what was read holds text: woken by each chunk and by the stream's end, never by a clock; fails if the stream ends without it. */
	const until = async (text) => {
		while (!read.includes(text)) {
			assert.ok(!ended, `stdout ended without ${JSON.stringify(text)}: it read ${JSON.stringify(read)}`);
			await new Promise((done) => (more = done));
		}
	};
	await proc.write(Buffer.from("a\n"));
	await until("echo a\n");
	streams.drop();
	// Written with no socket at all: the write is its own call, and what it wrote is read once a socket is back.
	await proc.write(Buffer.from("b\n"));
	await until("echo b\n");
	streams.drop();
	await proc.write(Buffer.from("end\n"));
	assert.equal(await proc.wait(), 0);
	await reading;
	assert.equal(read, "echo a\necho b\necho end\n");
	const execId = [...streams.commands.keys()][0];
	// Each position counts the start's mark (1 byte of stderr) and the output read before the drop: 1 + 7, then 8 + 7.
	assert.deepEqual(
		streams.opened.slice(1).map(({ sent }) => sent[0]),
		[
			{ type: "attach", exec_id: execId, seq: 8, encoding: "base64" },
			{ type: "attach", exec_id: execId, seq: 15, encoding: "base64" },
		],
	);
	// A socket dropped to open another is never closed with 1000, which would end the command.
	assert.deepEqual(streams.opened.map(({ closed }) => closed), [1006, 1006, 1000]);
});

test("a stream that cannot be read on because the sandbox is gone fails at once, in words; output Groundbox no longer keeps fails it too", async (t) => {
	let answer = [404, refusal("not_found", `No sandbox ${ID}`)];
	const { host, streams } = hostOf(() => answer);
	t.after(streams.stopAll);
	for (const [code, words] of [["not_found", /No sandbox/], ["gone", /Groundbox reads the sandbox as "stopped"/]]) {
		streams.refuse(false);
		const proc = await host.exec(ID, ["sleep", "600"], CTX);
		if (code === "gone") answer = [200, sandbox({ status: "stopped" })];
		streams.refuse(true);
		streams.drop();
		await assert.rejects(proc.wait(), (error) => error.code === code && words.test(error.message) && !error.message.includes(KEY));
	}
	// A stream whose socket says `skipped`: part of the output is lost, so the stream is broken, never patched over.
	const listeners = {};
	const socket = { readyState: 1, bufferedAmount: 0, addEventListener: (type, listener) => (listeners[type] = listener), send() {}, close() {} };
	const lossy = hostOf(() => undefined, { opened: [], webSocket: () => socket });
	// The listeners are on the socket before the start's first await.
	const starting = lossy.host.exec(ID, ["true"], CTX);
	listeners.open({});
	listeners.message({ data: JSON.stringify({ type: "started", exec_id: "ex_0123456789abcdef" }) });
	const proc = await starting;
	listeners.message({ data: JSON.stringify({ type: "skipped", bytes: 10, seq: 10 }) });
	await assert.rejects(proc.wait(), /no longer keeps 10 bytes of the command's output/);
});

test("a stream that does not start says why: the sandbox read for a refused upgrade, the stream's own error by its code, the call's bound for one that never opens", async () => {
	const refused = (route) => {
		const streams = fakeCommands();
		streams.refuse(true);
		return hostOf(route, streams).host.exec(ID, ["true"], CTX);
	};
	await assert.rejects(refused(() => [404, refusal("not_found", `No sandbox ${ID}`)]), (error) => error.code === "not_found" && /the command stream failed/.test(error.message) && !error.message.includes(KEY));
	await assert.rejects(refused(() => [200, sandbox({ status: "paused" })]), /Groundbox reads the sandbox as "paused"/);
	const stub = (onOpen) => {
		const listeners = {};
		const socket = { readyState: 1, bufferedAmount: 0, addEventListener: (type, listener) => (listeners[type] = listener), send: () => onOpen?.(listeners), close() {} };
		const webSocket = () => {
			queueMicrotask(() => listeners.open?.({}));
			return socket;
		};
		return { opened: [], webSocket };
	};
	const saying = stub((listeners) => listeners.message({ data: JSON.stringify({ type: "error", message: "Sandbox sbx_0123456789ab is paused", code: "conflict" }) }));
	await assert.rejects(hostOf(() => undefined, saying).host.exec(ID, ["true"], CTX), (error) => error.code === "refused" && /Groundbox ended the command: Sandbox sbx_0123456789ab is paused/.test(error.message));
	// No `started` within the call's bound (an image with no Node runs no resumable command): the call's timeout. The
	// bound's timer is unref'd, as a caller's would be, so the test holds the event loop open while it waits.
	const alive = setInterval(() => {}, 1_000);
	try {
		await assert.rejects(hostOf(() => undefined, stub()).host.exec(ID, ["true"], { timeoutMs: 50 }), (error) => error.name === "TimeoutError");
	} finally {
		clearInterval(alive);
	}
});

test("kill is the shared pid kill of the sh's recorded pid, as root: the command and every process under it end, wait answers, and its directory goes", async (t) => {
	if (!CAN_KILL) return t.skip("needs /proc and root (or passwordless sudo)");
	const { calls, host, streams } = hostOf(() => undefined);
	t.after(streams.stopAll);
	const proc = await host.exec(ID, ["sh", "-c", "sleep 600 & sleep 600"], CTX);
	const dir = streams.opened[0].sent[0].args[4];
	const { child } = [...streams.commands.values()][0];
	await proc.kill();
	assert.equal(await proc.wait(), 137);
	const kill = calls.findLast((call) => call.path.endsWith("/exec")).body;
	assert.deepEqual([kill.args.slice(0, 2), kill.args.slice(3, 5), kill.stdin_base64], [["sh", "-c"], ["sh", dir], undefined]);
	assert.equal(existsSync(dir), false, "the kill removed the command's directory");
	// wait answered once every process of the group had closed the command's output, which a killed process does as it
	// exits. Its parent, or init when the parent died first, reaps it a moment later, and a process that has closed its
	// files can still read as running until it is a zombie: the group gets 2 s, and one the kill missed runs on past it.
	for (let at = 0; at < 100 && runningIn(child.pid).length > 0; at++) await new Promise((done) => setTimeout(done, 20));
	assert.deepEqual(runningIn(child.pid), [], "nothing of the command's process group is left running");
});

test("the exec passes every check of the exec pre-check, over the command stream's own messages", async (t) => {
	if (!CAN_KILL) return t.skip("needs /proc and root (or passwordless sudo)");
	const { host, streams } = hostOf(() => undefined);
	t.after(streams.stopAll);
	const report = await checkExecStream(host, ID, { longMs: 2_000, stepMs: 5_000, largeBytes: 1024 * 1024, largeMs: 30_000, unreadMs: 1_000 });
	assert.equal(report.pass, true, formatExecStream(report));
});

test("the conformance module reads COMPUTER_GROUNDBOX_* alone, after its live switch; the sweep's host needs none and its scope never shows the key", async () => {
	assert.throws(() => settingsFromEnv({ GROUNDBOX_API_KEY: KEY }), (error) => /set COMPUTER_GROUNDBOX_API_KEY/.test(error.message) && !error.message.includes(KEY));
	const env = { [ENV.key]: KEY };
	assert.deepEqual(settingsFromEnv({ ...env, [ENV.apiUrl]: API, [ENV.user]: "3000:3000" }), { apiKey: KEY, apiUrl: API, daemonUser: "3000:3000" });
	assert.deepEqual(settingsFromEnv({ ...env, [ENV.kind]: "desktop" }), { apiKey: KEY, kind: "desktop" });
	await assert.rejects(createProvider({ env }), /set AGENTRUN_COMPUTER_LIVE_GROUNDBOX=1/);
	assert.equal((await createProvider({ env: { ...env, [ENV.live]: "1" } })).capabilities().maxLifetimeMs, 30 * 60_000);
	assert.equal((await createHost({ env })).descriptor.id, "groundbox");
	assert.match(await conformanceImage({ env: {} }), /^ghcr\.io\/parcha-ai\/agentrun-box:[0-9a-f]{12}$/);
	assert.equal(await conformanceImage({ env: { [ENV.image]: "python-ml" } }), "python-ml");
	assert.equal(await conformanceImage({ env: { [ENV.image]: "default" } }), "default");
	assert.match(sweepScope({ env }), /sha256:[0-9a-f]{12} at https:\/\/api\.groundbox\.dev\/v1/);
	assert.doesNotMatch(sweepScope({ env }), new RegExp(KEY));
});

test("kind desktop: the box image's X server and window manager through the daemon, the screen, pointer, keys and apps declared, and Groundbox's own image refused for it", async () => {
	const descriptorKinds = GROUNDBOX.capabilities.map((one) => [one.kind, one.options ?? {}]);
	assert.deepEqual(descriptorKinds, [["linux", {}], ["desktop", { kind: "desktop" }]]);
	const desktop = new GroundboxProvider({ apiKey: KEY, daemonPath: "/nonexistent/computerd", kind: "desktop" });
	const capabilities = desktop.capabilities();
	assert.equal(capabilities.kind, "desktop");
	assert.deepEqual(capabilities.groups, ["exec", "files", "processes", "screen", "input.pointer", "input.keys", "apps"]);
	assert.equal(desktop.host.facts.windowManager, true);
	// The same box image for both kinds.
	assert.match((await desktop.prepareImage()).value, /^ghcr\.io\/parcha-ai\/agentrun-box:[0-9a-f]{12}$/);
	const fields = (provider, spec) => provider.host.check(spec).map((one) => one.field);
	assert.deepEqual(fields(desktop, { image: "default" }), ["image"]);
	assert.match(desktop.host.check({ image: "default" })[0].message, /lacks \(xfwm4\): name the box image, ghcr\.io\/parcha-ai\/agentrun-box:/);
	for (const image of ["ghcr.io/parcha-ai/agentrun-box:87f44537b8b7", "my-desktop", "ghcr.io/org/desktop:1"]) assert.deepEqual(fields(desktop, { image }), [], image);
	// Kind linux still takes Groundbox's own image.
	assert.deepEqual(fields(new GroundboxProvider({ apiKey: KEY, daemonPath: "/nonexistent/computerd" }), { image: "default" }), []);
	assert.throws(() => new GroundboxProvider({ apiKey: KEY, kind: "phone" }), /kind is desktop or linux/);
});

/** Sockets scripted by the test: each records what was sent to it and how it was closed, and never closes on its own. */
function scriptedSockets() {
	const opened = [];
	const webSocket = () => {
		const listeners = {};
		const socket = {
			readyState: 1,
			bufferedAmount: 0,
			sent: [],
			closed: [],
			addEventListener: (type, listener) => (listeners[type] = listener),
			send: (text) => socket.sent.push(JSON.parse(text)),
			// A peer that is gone answers no close frame: the close event never comes unless the test emits it.
			close: (code) => socket.closed.push(code),
			emit: (type, event = {}) => listeners[type]?.(event),
			say: (message) => listeners.message?.({ data: JSON.stringify(message) }),
		};
		opened.push(socket);
		queueMicrotask(() => socket.emit("open"));
		return socket;
	};
	return { opened, webSocket, exec: undefined, stopAll: () => {} };
}

const out = (text, seq) => ({ type: "stdout", data: Buffer.from(text).toString("base64"), seq });
/** START_SCRIPT's mark (the first byte on stderr, once the command's directory, fifo and pid record are made), with what follows it. */
const marked = (text = "", seq = 1 + Buffer.byteLength(text)) => ({ type: "stderr", data: Buffer.from(`\n${text}`).toString("base64"), seq });
/** One turn of the event loop: what a promise or a stream moves on to next has run. No clock. */
const turn = () => new Promise(setImmediate);

/** What `promise` gives, or a failure naming `what` once `ms` have passed: a process that never ends fails its test. */
const within = async (promise, what, ms = 10_000) => {
	let timer;
	try {
		return await Promise.race([promise, new Promise((_, fail) => (timer = setTimeout(() => fail(new Error(`no ${what} within ${ms} ms`)), ms)))]);
	} finally {
		clearTimeout(timer);
	}
};
/** SIGKILL to the process group `child` leads (spawned detached), so nothing it started outlives a test. */
const stopGroup = (child) => {
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		// Gone already.
	}
};

test("a socket gone silent with no close is let go at once: another attaches from the position read to, once, and the old one's later messages and close are ignored", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const streams = scriptedSockets();
	const { host } = hostOf(() => undefined, streams, { streamBounds: { silenceMs: 100 } });
	const starting = host.exec(ID, ["sh", "-c", "echo a; sleep 1; echo b"], CTX);
	const [first] = streams.opened;
	await turn();
	first.say({ type: "started", exec_id: "ex_0123456789abcdef" });
	const proc = await starting;
	const reading = textOf(proc.stdout);
	first.say(out("a\n", 2));
	t.mock.timers.tick(99);
	assert.equal(streams.opened.length, 1, "not let go before the silence bound");
	// No heartbeat and no close: the watchdog lets the socket go and attaches on a new one without waiting for a close.
	t.mock.timers.tick(1);
	assert.equal(streams.opened.length, 2, "a second socket, with no close from the first");
	assert.deepEqual(first.closed, [4000]);
	const [, second] = streams.opened;
	await turn();
	assert.deepEqual(second.sent, [{ type: "attach", exec_id: "ex_0123456789abcdef", seq: 2, encoding: "base64" }]);
	// The old socket wakes up late: what it says is not read, and its close opens no other socket.
	first.say(out("stale\n", 8));
	first.emit("close", { code: 1006 });
	assert.equal(streams.opened.length, 2, "the late close opened no third socket");
	second.say(out("b\n", 4));
	second.say({ type: "exit", exit_code: 0 });
	assert.equal(await proc.wait(), 0);
	assert.equal(await reading, "a\nb\n");
});

test("a socket silent from its `started` on, with no output, heartbeat or close, is let go too: another attaches from the start of the output", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const streams = scriptedSockets();
	const { host } = hostOf(() => undefined, streams, { streamBounds: { silenceMs: 100 } });
	const starting = host.exec(ID, ["sh", "-c", "sleep 1; echo a"], CTX);
	const [first] = streams.opened;
	await turn();
	first.say({ type: "started", exec_id: "ex_0123456789abcdef" });
	const proc = await starting;
	const reading = textOf(proc.stdout);
	t.mock.timers.tick(100);
	assert.equal(streams.opened.length, 2, "a second socket, after `started` alone and silence");
	assert.deepEqual(first.closed, [4000]);
	const [, second] = streams.opened;
	await turn();
	assert.deepEqual(second.sent, [{ type: "attach", exec_id: "ex_0123456789abcdef", seq: 0, encoding: "base64" }]);
	second.say(out("a\n", 2));
	second.say({ type: "exit", exit_code: 0 });
	assert.equal(await proc.wait(), 0);
	assert.equal(await reading, "a\n");
});

test("output the reader has not taken is bounded: past the high mark the socket is let go, and reading resumes from the position read to once the reader catches up", { timeout: 30_000 }, async () => {
	const streams = scriptedSockets();
	const { host } = hostOf(() => undefined, streams, { streamBounds: { queueHighBytes: 200_000, queueLowBytes: 50_000 } });
	const starting = host.exec(ID, ["yes"], CTX);
	const [first] = streams.opened;
	await turn();
	first.say({ type: "started", exec_id: "ex_0123456789abcdef" });
	const proc = await starting;
	// Nobody reads stdout. The first chunks fill the stdout stream's own buffer; then the output queued here passes the
	// 200 kB mark with the chunk that ends at 350 kB, and the socket is let go there with the command running: the last
	// chunk it then says is not queued.
	const chunks = Array.from({ length: 8 }, (_, i) => String.fromCharCode(97 + i).repeat(50_000));
	chunks.slice(0, 3).forEach((text, i) => first.say(out(text, (i + 1) * 50_000)));
	// One turn: the events move the chunks the stdout stream's buffer takes.
	await turn();
	assert.deepEqual(first.closed, []);
	// The queue's mark is checked as each chunk comes, so the socket is let go at once.
	chunks.slice(3).forEach((text, i) => first.say(out(text, (i + 4) * 50_000)));
	assert.deepEqual(first.closed, [4000]);
	// Anything the dropped socket still says is not queued, and its close opens no other.
	first.say(out("late", 400_004));
	first.emit("close", { code: 1006 });
	assert.equal(streams.opened.length, 1, "no socket while the reader is behind");
	// The reader catches up: a new socket attaches from the last position queued, and nothing is lost or read twice.
	const reading = textOf(proc.stdout);
	let second;
	// Bounded in turns, not time: a reconnect that never comes fails here in words instead of stalling the run.
	for (let turns = 0; (second = streams.opened[1]) === undefined || second.sent.length === 0; turns++) {
		assert.ok(turns < 1_000, "the reader caught up and no socket attached");
		await turn();
	}
	assert.deepEqual(second.sent, [{ type: "attach", exec_id: "ex_0123456789abcdef", seq: 350_000, encoding: "base64" }]);
	// The new socket reads on from there: the chunk the old one said after it was let go comes again, once.
	second.say(out(chunks[7], 400_000));
	second.say(out("end", 400_003));
	second.say({ type: "exit", exit_code: 0 });
	assert.equal(await proc.wait(), 0);
	assert.equal(await reading, `${chunks.join("")}end`);
});

/** A fifo the test holds open to read and write: a write into it never blocks, and read() answers what it was given. */
function heldFifo(path) {
	execFileSync("mkfifo", ["-m", "666", path]);
	const fd = openSync(path, constants.O_RDWR | constants.O_NONBLOCK);
	return {
		read: () => {
			const bytes = Buffer.alloc(4096);
			try {
				return bytes.subarray(0, readSync(fd, bytes)).toString();
			} catch (error) {
				if (error.code === "EAGAIN") return "";
				throw error;
			}
		},
		close: () => closeSync(fd),
	};
}

/** A process of the test's own and the pid record that names it, as a command's sh writes one: what a planted record would aim the kill at. */
function victim() {
	const child = spawn("sleep", ["600"], { stdio: "ignore" });
	const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
	return { child, line: `${child.pid} ${stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19]}\n` };
}

/** Whether a process runs: its /proc stat is there and its state is no zombie, which a killed process is until it is reaped. */
function running(pid) {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return !/^[ZX]/.test(stat.slice(stat.lastIndexOf(") ") + 2));
	} catch {
		return false;
	}
}

/**
 * A command whose sh made its directory and has since ended, removing it: the stream said `started` and the mark, and
 * whatever is at the path its start names now is the tool user's. Its writes and its kill run for real here (the
 * stand-in's POST .../exec).
 */
async function endedCommand() {
	const streams = { ...scriptedSockets(), exec: fakeCommands().exec };
	const { host } = hostOf(() => undefined, streams);
	const starting = host.exec(ID, ["cat"], CTX);
	await turn();
	const path = streams.opened[0].sent[0].args[4];
	streams.opened[0].say({ type: "started", exec_id: "ex_0123456789abcdef" });
	streams.opened[0].say(marked());
	return { path, proc: await starting };
}

test("a write and the kill wait for the mark the start's sh puts first on stderr once its directory, fifo and pid record are made: none runs before it, the mark is no output, and a stream that ends with none lets them through", async () => {
	const steps = [];
	const streams = scriptedSockets();
	const { host } = hostOf((method, path, body) => (method === "POST" && path.endsWith("/exec") ? (steps.push(body.stdin_base64 === undefined ? "kill" : "write"), [200, { exit_code: 0, timed_out: false }]) : undefined), streams);
	const exec = async () => {
		const starting = host.exec(ID, ["cat"], CTX);
		const socket = streams.opened.at(-1);
		await turn();
		socket.say({ type: "started", exec_id: "ex_0123456789abcdef" });
		return { socket, proc: await starting };
	};
	const { socket, proc } = await exec();
	const stderr = textOf(proc.stderr);
	const wrote = proc.write(Buffer.from("x"));
	await turn();
	assert.deepEqual(steps, [], "a write before the mark waits for it");
	// The mark and the command's own stderr in one chunk: the mark is taken off, the rest is the command's.
	socket.say(marked("its own\n"));
	await wrote;
	assert.deepEqual(steps, ["write"]);
	socket.say({ type: "exit", exit_code: 0 });
	assert.equal(await proc.wait(), 0);
	assert.equal(await stderr, "its own\n");

	// A start whose sh refused its path ends with no mark: its words are stderr whole, and the kill waiting then goes on
	// to its script, which finds no record.
	steps.length = 0;
	const refused = await exec();
	const words = textOf(refused.proc.stderr);
	const killing = refused.proc.kill();
	await turn();
	assert.deepEqual(steps, [], "a kill before the mark waits for it");
	refused.socket.say({ type: "stderr", data: Buffer.from("agentrun: it is already there\n").toString("base64"), seq: 30 });
	refused.socket.say({ type: "exit", exit_code: 126 });
	await killing;
	assert.deepEqual(steps, ["kill"]);
	assert.equal(await words, "agentrun: it is already there\n");
});

test("a write never reaches a fifo the tool user planted at the path a command's start names: stdin of a command that ended goes nowhere", async (t) => {
	const plants = {
		// The fifo's own path before this fix: free for anyone in /tmp once the command's sh removed its fifo.
		"a fifo at the path": (path) => heldFifo(path),
		"a directory open to all, a fifo in it": (path) => {
			mkdirSync(path);
			chmodSync(path, 0o755);
			return heldFifo(join(path, "in"));
		},
		"a link to a 0700 directory of the same user, a fifo in it": (path) => {
			const target = mkdtempSync("/tmp/agentrun-planted-");
			t.after(() => rmSync(target, { recursive: true, force: true }));
			symlinkSync(target, path);
			return heldFifo(join(target, "in"));
		},
	};
	for (const [what, plant] of Object.entries(plants)) {
		const { path, proc } = await endedCommand();
		t.after(() => rmSync(path, { recursive: true, force: true }));
		const planted = plant(path);
		t.after(planted.close);
		await assert.rejects(proc.write(Buffer.from("a disk token\n")), (error) => !/token/.test(error.message), what);
		assert.equal(planted.read(), "", `${what}: the planted fifo was written to`);
	}
});

test("a kill never takes its target from a pid record the tool user planted at a command's path: the process it names lives on", async (t) => {
	if (!CAN_KILL) return t.skip("needs /proc and root (or passwordless sudo)");
	const plants = {
		// The record's own path before this fix: beside the fifo, in /tmp.
		"a record beside the path": (path, line) => writeFileSync(`${path}.pid`, line),
		"a directory open to all, a record in it": (path, line) => {
			mkdirSync(path);
			chmodSync(path, 0o755);
			writeFileSync(join(path, "pid"), line);
		},
		"a link to a 0700 directory of the same user, a record in it": (path, line) => {
			const target = mkdtempSync("/tmp/agentrun-planted-");
			t.after(() => rmSync(target, { recursive: true, force: true }));
			writeFileSync(join(target, "pid"), line);
			symlinkSync(target, path);
		},
	};
	for (const [what, plant] of Object.entries(plants)) {
		const { path, proc } = await endedCommand();
		t.after(() => rmSync(path, { recursive: true, force: true }));
		t.after(() => rmSync(`${path}.pid`, { force: true }));
		const { child, line } = victim();
		t.after(() => child.kill("SIGKILL"));
		plant(path, line);
		// The kill answers once its script has ended: a kill it sent has landed by then.
		await proc.kill();
		assert.ok(running(child.pid), `${what}: the planted record's process was killed`);
	}
});

/** The start, write and kill scripts as the host sends them: its write and its kill answered here, never run. */
async function sentScripts() {
	const steps = [];
	const streams = scriptedSockets();
	const { host } = hostOf((method, path, body) => (method === "POST" && path.endsWith("/exec") ? (steps.push(body.args), [200, { exit_code: 0, timed_out: false }]) : undefined), streams);
	const starting = host.exec(ID, ["true"], CTX);
	await turn();
	const startScript = streams.opened[0].sent[0].args[2];
	streams.opened[0].say({ type: "started", exec_id: "ex_0123456789abcdef" });
	streams.opened[0].say(marked());
	const proc = await starting;
	await proc.write(Buffer.from("x"));
	await proc.kill();
	const [[, , writeScript], [, , killScript, , , pidKill]] = steps;
	return { startScript, writeScript, killScript, pidKill };
}

test("the scripts, run by sh against paths of the test's: the start refuses a path already there; the write and the kill take only a directory the command's user owns with mode 0700, not through a link, and a fifo or record there of that user's", async (t) => {
	if (!HAS_PROC) return t.skip("needs /proc");
	const { startScript, writeScript, killScript, pidKill } = await sentScripts();
	const root = realpathSync(mkdtempSync("/tmp/agentrun-groundbox-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	// `id` answering another uid stands in for a directory and files of another user's, which this test can't make.
	mkdirSync(join(root, "bin"));
	writeFileSync(join(root, "bin", "id"), "#!/bin/sh\necho 4242\n", { mode: 0o755 });
	const sh = (script, args, { input = "", otherUser = false } = {}) =>
		spawnSync("sh", ["-c", script, "sh", ...args], { input, encoding: "utf8", timeout: 20_000, env: { ...process.env, ...(otherUser ? { PATH: `${join(root, "bin")}:${process.env.PATH}` } : {}) } });
	let n = 0;
	const fresh = () => join(root, `c${++n}`);

	// The start: a path already there is never its own, and no mark; a path it makes is a 0700 directory holding the fifo
	// and the pid record before the mark, gone once the command ends.
	const taken = fresh();
	mkdirSync(taken, { mode: 0o700 });
	const refused = sh(startScript, [taken, "sh", "-c", "echo ran"]);
	assert.deepEqual([refused.status, refused.stdout], [126, ""]);
	assert.match(refused.stderr, /^agentrun: .* is already there/);
	const own = fresh();
	const ran = sh(startScript, [own, "sh", "-c", 'stat -c "%u %a" "$1"; [ -p "$1/in" ] && [ -s "$1/pid" ] && echo made', "sh", own]);
	assert.deepEqual([ran.status, ran.stdout, ran.stderr], [0, `${process.getuid()} 700\nmade\n`, "\n"]);
	assert.equal(existsSync(own), false, "the start removed its directory");

	/** A directory at a fresh path the way the tool user might leave it, with `file` made in it by make(path). */
	const planted = (shape, file, make) => {
		const dir = fresh();
		const real = shape === "link" ? `${dir}-target` : dir;
		mkdirSync(real, { mode: 0o700 });
		if (shape === "open") chmodSync(real, 0o755);
		if (shape === "link") symlinkSync(real, dir);
		if (shape === "linked file") {
			make(`${dir}-file`);
			symlinkSync(`${dir}-file`, join(real, file));
		} else make(join(real, file));
		return dir;
	};
	const shapes = { open: {}, link: {}, "linked file": {}, "another user's": { otherUser: true } };

	// The write: into the fifo of its own directory, and nowhere else.
	const fifos = [];
	const fifo = (path) => fifos.push(heldFifo(path));
	t.after(() => fifos.forEach((one) => one.close()));
	const written = sh(writeScript, [planted("own", "in", fifo)], { input: "abc" });
	assert.equal(written.status, 0, written.stderr);
	assert.equal(fifos.at(-1).read(), "abc");
	for (const [shape, options] of Object.entries(shapes)) {
		const wrote = sh(writeScript, [planted(shape, "in", fifo)], { input: "a disk token", ...options });
		assert.equal(wrote.status, 4, `${shape}: ${wrote.stderr}`);
		assert.match(wrote.stderr, /is not the command's own/, shape);
		assert.equal(fifos.at(-1).read(), "", `${shape}: the planted fifo was written to`);
	}

	// The kill: refused before it reads a record that is not its own (exit 4, which comes before its kill line), so the
	// process the record names lives on.
	const { child, line } = victim();
	t.after(() => child.kill("SIGKILL"));
	for (const [shape, options] of Object.entries(shapes)) {
		const killed = sh(killScript, [planted(shape, "pid", (path) => writeFileSync(path, line)), pidKill], options);
		assert.equal(killed.status, 4, `${shape}: ${killed.stderr}`);
		assert.match(killed.stderr, /is not the command's own/, shape);
	}
	assert.ok(running(child.pid), "a planted record's process was killed");
	// With nothing at the path (the command ended): the write is exit 3 and the kill exit 0, at once, with no wait.
	assert.equal(sh(writeScript, [fresh()], { input: "x" }).status, 3);
	assert.equal(sh(killScript, [fresh(), pidKill]).status, 0);
});

test("a write is made once its bytes are in the command's fifo, though the command reads them and ends, and its directory goes, before the write answers; a fifo gone before the write opens it takes nothing, and the write leaves no file of its own", async (t) => {
	if (!HAS_PROC) return t.skip("needs /proc");
	const { startScript, writeScript } = await sentScripts();
	const root = realpathSync(mkdtempSync("/tmp/agentrun-groundbox-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	// A command that ends on the line it reads, as a shell ends on `exit`; its sh then removes the directory. The command
	// and the write each lead a process group, and every wait on them is bounded: a write that never reaches the command
	// leaves it waiting in `read`, and the test then fails and stops both groups instead of waiting with them.
	const dir = join(root, "c1");
	const command = spawn("sh", ["-c", startScript, "sh", dir, "sh", "-c", 'read -r line; echo "read $line"'], { stdio: ["ignore", "pipe", "pipe"], detached: true });
	t.after(() => stopGroup(command));
	let said = "";
	command.stdout.on("data", (bytes) => (said += bytes));
	const ended = new Promise((done) => command.on("close", done));
	// START_SCRIPT's mark, its first byte on stderr: the directory and the fifo are made.
	await within(once(command.stderr, "data"), "mark from the start script");
	// The write's stdin stays open past the line, so the write answers only after the command has read it and gone.
	const write = spawn("sh", ["-c", writeScript, "sh", dir], { stdio: ["pipe", "ignore", "pipe"], detached: true });
	t.after(() => stopGroup(write));
	let complaint = "";
	write.stderr.on("data", (bytes) => (complaint += bytes));
	const wrote = new Promise((done) => write.on("close", done));
	write.stdin.write("end\n");
	assert.equal(await within(ended, "end of the command after the write's line"), 0);
	assert.equal(said, "read end\n");
	assert.equal(existsSync(dir), false, "the command's sh removed its directory");
	write.stdin.end();
	assert.equal(await within(wrote, "answer from the write"), 0, `the command read the line, so the write was made: ${complaint}`);

	// A fifo that goes between the write's checks and its open, as when the command ends then: `stat`, asked for the fifo's
	// owner (the last check), answers and then removes it.
	const bin = join(root, "bin");
	mkdirSync(bin);
	const realStat = execFileSync("sh", ["-c", "command -v stat"], { encoding: "utf8" }).trim();
	writeFileSync(join(bin, "stat"), `#!/bin/sh\n"${realStat}" "$@"; s=$?\n[ "$3" = in ] && rm -f in\nexit $s\n`, { mode: 0o755 });
	const gone = join(root, "c2");
	mkdirSync(gone, { mode: 0o700 });
	execFileSync("mkfifo", ["-m", "600", join(gone, "in")]);
	const late = spawnSync("sh", ["-c", writeScript, "sh", gone], { input: "a disk token", encoding: "utf8", timeout: 20_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
	assert.equal(late.status, 3, late.stderr);
	assert.equal(existsSync(join(gone, "in")), false, "the write left no file of its own");
});

test("a start that does not hear `started` within its bound ends the command: its socket closes with 1000, so a late `started` leaves nothing running", async (t) => {
	const streams = fakeCommands();
	t.after(streams.stopAll);
	streams.startedAfter(300);
	const { host } = hostOf(() => undefined, streams);
	// The bound's timer is unref'd, as a caller's would be: the test holds the event loop open while it waits.
	const alive = setInterval(() => {}, 1_000);
	try {
		await assert.rejects(host.exec(ID, ["sleep", "600"], { timeoutMs: 100 }), (error) => error.name === "TimeoutError");
	} finally {
		clearInterval(alive);
	}
	const [opened] = streams.opened;
	assert.equal(opened.closed, 1000, "a close that is not 1000 leaves the command running");
	const [command] = streams.commands.values();
	if (command.exit === undefined) await once(command.child, "close");
	assert.notEqual(command.exit, undefined, "the command ended in the sandbox");
});

test("the API URL is https alone, loopback included, so the key never crosses in the clear", () => {
	for (const apiUrl of ["http://api.groundbox.dev/v1", "http://10.0.0.5:8080/v1", "http://127.0.0.1:8080/v1", "http://[::1]:8080/v1", "http://localhost:8080/v1", "ws://api.groundbox.dev/v1"]) {
		assert.throws(() => new GroundboxProvider({ apiKey: KEY, apiUrl, daemonPath: "/nonexistent/computerd" }), (error) => /^the Groundbox API URL must be https, so the key never crosses in the clear/.test(error.message) && !error.message.includes(KEY), apiUrl);
	}
	assert.doesNotThrow(() => new GroundboxProvider({ apiKey: KEY, apiUrl: "https://api.groundbox.dev/v1", daemonPath: "/nonexistent/computerd" }));
});

test("a peer that takes every attach and then says nothing fails wait() in words within the give-up bound, never hangs", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const streams = scriptedSockets();
	const { host } = hostOf((method) => (method === "GET" ? [200, sandbox()] : undefined), streams, { streamBounds: { silenceMs: 100, resumeGiveUpMs: 500 } });
	const starting = host.exec(ID, ["sleep", "600"], CTX);
	await turn();
	streams.opened[0].say({ type: "started", exec_id: "ex_0123456789abcdef" });
	const proc = await starting;
	// The first socket goes; the next opens, takes its attach, and never says a word.
	streams.opened[0].emit("close", { code: 1006 });
	await turn();
	assert.deepEqual(streams.opened[1].sent.map((one) => one.type), ["attach"]);
	t.mock.timers.tick(100);
	const outcome = await proc.wait().catch((error) => error);
	assert.ok(outcome instanceof Error, `wait() is ${outcome}`);
	assert.match(outcome.message, /could not be read on again within 0\.5 s: the command stream said nothing for 0\.1 s after its attach/);
	assert.equal(streams.opened.length, 2, "no try that would start past the bound");
});
