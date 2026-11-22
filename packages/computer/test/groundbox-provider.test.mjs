// GroundboxProvider's host against a stand-in for Groundbox's API (fake-groundbox.mjs: a fetch that answers in the
// API's shapes, and the command stream as a socket whose commands are real processes here): what the host sends for
// create, get, list, delete, exec, upload and extend, and how it reads the answers back. The adapter's lifecycle is
// tested once, against its fake host (hosted-provider.test.mjs); Groundbox's own is proven live.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { execFileSync } from "node:child_process";
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

const sandbox = (fields = {}) => ({ id: ID, status: "running", metadata: LABELS, created_at: "2026-11-18T00:00:00.000Z", stop_reason: null, ...fields });
const refusal = (code, message) => ({ error: { code, message } });

/** A host over a recorder of the API and, for exec, the fake command stream. */
function hostOf(route, streams = fakeCommands(), options = {}) {
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
	assert.throws(() => new GroundboxProvider({ apiKey: KEY, apiUrl: "api.groundbox.dev" }), (error) => /must be an http\(s\) URL/.test(error.message) && !error.message.includes(KEY));
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
	const fifo = args[4];
	assert.match(fifo, /^\/tmp\/\.agentrun-stdin-[0-9a-f]{16}$/);
	assert.deepEqual([args[0], args[1], args[3], ...args.slice(5)], ["sh", "-c", "sh", "sh", "-c", 'read -r line; echo "got $line and $1"; echo "to stderr" >&2; exit 7', "sh", "it's"]);
	const text = "héllo \r wörld \u{1F600} ﻿ end\n";
	await proc.write(Buffer.from(text));
	// No end of stdin: a fifo held open has none, and end() answers all the same.
	await proc.end();
	assert.deepEqual([await textOf(proc.stdout), await textOf(proc.stderr), await proc.wait()], [`got ${text.trimEnd()} and it's\n`, "to stderr\n", 7]);
	const writes = calls.filter((call) => call.path === `/v1/sandboxes/${ID}/exec`);
	assert.deepEqual(writes.map((call) => call.body), [{ args: ["sh", "-c", 'i=0; until [ -p "$1" ]; do [ "$i" -lt 50 ] || exit 3; i=$((i + 1)); sleep 0.1; done; cat >"$1"', "sh", fifo], timeout_s: 60, stdin_base64: Buffer.from(text).toString("base64") }]);
	assert.equal(existsSync(fifo) || existsSync(`${fifo}.pid`), false, "the sh removed its fifo and its pid record");
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

test("a socket that goes while the command runs is no end: another attaches from the position read to, no output lost or read twice, and writes go on meanwhile", async (t) => {
	const { host, streams } = hostOf(() => undefined);
	t.after(streams.stopAll);
	const proc = await host.exec(ID, ["sh", "-c", 'while read -r l; do echo "echo $l"; [ "$l" = end ] && exit 0; done'], CTX);
	let read = "";
	const reading = (async () => {
		for await (const chunk of proc.stdout) read += Buffer.from(chunk).toString();
	})();
	const until = async (text) => {
		for (let i = 0; i < 200 && !read.includes(text); i++) await new Promise((done) => setTimeout(done, 10));
		assert.ok(read.includes(text), `read ${JSON.stringify(read)}, waiting for ${JSON.stringify(text)}`);
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
	assert.deepEqual(
		streams.opened.slice(1).map(({ sent }) => sent[0]),
		[
			{ type: "attach", exec_id: execId, seq: 7, encoding: "base64" },
			{ type: "attach", exec_id: execId, seq: 14, encoding: "base64" },
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
	const starting = lossy.host.exec(ID, ["true"], CTX);
	await new Promise((done) => setTimeout(done, 5));
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
		setTimeout(() => listeners.open?.({}), 1);
		return { opened: [], webSocket: () => socket };
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

test("kill is the shared pid kill of the sh's recorded pid, as root: the command and every process under it end, wait answers, and the fifo goes", async (t) => {
	if (!CAN_KILL) return t.skip("needs /proc and root (or passwordless sudo)");
	const { calls, host, streams } = hostOf(() => undefined);
	t.after(streams.stopAll);
	const proc = await host.exec(ID, ["sh", "-c", "sleep 600 & sleep 600"], CTX);
	const fifo = streams.opened[0].sent[0].args[4];
	const { child } = [...streams.commands.values()][0];
	await proc.kill();
	assert.equal(await proc.wait(), 137);
	const kill = calls.findLast((call) => call.path.endsWith("/exec")).body;
	assert.deepEqual([kill.args.slice(0, 2), kill.args.slice(3, 5), kill.stdin_base64], [["sh", "-c"], ["sh", fifo], undefined]);
	assert.equal(existsSync(fifo) || existsSync(`${fifo}.pid`), false);
	assert.throws(() => process.kill(-child.pid, 0), "nothing of the command's process group is left");
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
const settle = () => new Promise((done) => setTimeout(done, 20));

/** Waits up to 2 s for check() to hold. */
const until = async (check, what) => {
	for (let i = 0; i < 200 && !check(); i++) await new Promise((done) => setTimeout(done, 10));
	assert.ok(check(), what);
};

test("a socket gone silent with no close is let go at once: another attaches from the position read to, once, and the old one's later messages and close are ignored", async () => {
	const streams = scriptedSockets();
	const { host } = hostOf(() => undefined, streams, { streamBounds: { silenceMs: 100 } });
	const starting = host.exec(ID, ["sh", "-c", "echo a; sleep 1; echo b"], CTX);
	await until(() => streams.opened.length === 1, "the first socket");
	const [first] = streams.opened;
	first.say({ type: "started", exec_id: "ex_0123456789abcdef" });
	const proc = await starting;
	const reading = textOf(proc.stdout);
	first.say(out("a\n", 2));
	// No heartbeat and no close: the watchdog lets the socket go and attaches on a new one without waiting for a close.
	await until(() => streams.opened.length === 2, "a second socket, with no close from the first");
	assert.deepEqual(first.closed, [4000]);
	const [, second] = streams.opened;
	await until(() => second.sent.length === 1, "the attach");
	assert.deepEqual(second.sent, [{ type: "attach", exec_id: "ex_0123456789abcdef", seq: 2, encoding: "base64" }]);
	// The old socket wakes up late: what it says is not read, and its close opens no other socket.
	first.say(out("stale\n", 8));
	first.emit("close", { code: 1006 });
	await settle();
	assert.equal(streams.opened.length, 2, "the late close opened no third socket");
	second.say(out("b\n", 4));
	second.say({ type: "exit", exit_code: 0 });
	assert.equal(await proc.wait(), 0);
	assert.equal(await reading, "a\nb\n");
});

test("a socket silent from its `started` on, with no output, heartbeat or close, is let go too: another attaches from the start of the output", async () => {
	const streams = scriptedSockets();
	const { host } = hostOf(() => undefined, streams, { streamBounds: { silenceMs: 100 } });
	const starting = host.exec(ID, ["sh", "-c", "sleep 1; echo a"], CTX);
	await until(() => streams.opened.length === 1, "the first socket");
	const [first] = streams.opened;
	first.say({ type: "started", exec_id: "ex_0123456789abcdef" });
	const proc = await starting;
	const reading = textOf(proc.stdout);
	await until(() => streams.opened.length === 2, "a second socket, after `started` alone and silence");
	assert.deepEqual(first.closed, [4000]);
	const [, second] = streams.opened;
	await until(() => second.sent.length === 1, "the attach");
	assert.deepEqual(second.sent, [{ type: "attach", exec_id: "ex_0123456789abcdef", seq: 0, encoding: "base64" }]);
	second.say(out("a\n", 2));
	second.say({ type: "exit", exit_code: 0 });
	assert.equal(await proc.wait(), 0);
	assert.equal(await reading, "a\n");
});

test("output the reader has not taken is bounded: past the high mark the socket is let go, and reading resumes from the position read to once the reader catches up", async () => {
	const streams = scriptedSockets();
	const { host } = hostOf(() => undefined, streams, { streamBounds: { queueHighBytes: 200_000, queueLowBytes: 50_000 } });
	const starting = host.exec(ID, ["yes"], CTX);
	await until(() => streams.opened.length === 1, "the first socket");
	const [first] = streams.opened;
	first.say({ type: "started", exec_id: "ex_0123456789abcdef" });
	const proc = await starting;
	// Nobody reads stdout. The first chunks fill the stdout stream's own buffer; then the output queued here passes the
	// 200 kB mark with the chunk that ends at 350 kB, and the socket is let go there with the command running: the last
	// chunk it then says is not queued.
	const chunks = Array.from({ length: 8 }, (_, i) => String.fromCharCode(97 + i).repeat(50_000));
	chunks.slice(0, 3).forEach((text, i) => first.say(out(text, (i + 1) * 50_000)));
	await settle();
	assert.deepEqual(first.closed, []);
	chunks.slice(3).forEach((text, i) => first.say(out(text, (i + 4) * 50_000)));
	await settle();
	assert.deepEqual(first.closed, [4000]);
	// Anything the dropped socket still says is not queued, and its close opens no other.
	first.say(out("late", 400_004));
	first.emit("close", { code: 1006 });
	await settle();
	assert.equal(streams.opened.length, 1, "no socket while the reader is behind");
	// The reader catches up: a new socket attaches from the last position queued, and nothing is lost or read twice.
	const reading = textOf(proc.stdout);
	await until(() => streams.opened.length === 2 && streams.opened[1].sent.length === 1, "a socket once the reader caught up");
	const [, second] = streams.opened;
	assert.deepEqual(second.sent, [{ type: "attach", exec_id: "ex_0123456789abcdef", seq: 350_000, encoding: "base64" }]);
	// The new socket reads on from there: the chunk the old one said after it was let go comes again, once.
	second.say(out(chunks[7], 400_000));
	second.say(out("end", 400_003));
	second.say({ type: "exit", exit_code: 0 });
	assert.equal(await proc.wait(), 0);
	assert.equal(await reading, `${chunks.join("")}end`);
});
