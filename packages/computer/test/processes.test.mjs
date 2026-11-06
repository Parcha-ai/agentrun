// The process helpers against a fake daemon on in-memory streams: no Go, no Docker.
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { DaemonClient, listProcesses, MAX_CHUNK_BYTES, MAX_PROCESSES, MAX_READ_WAIT_MS, PROCESS_RING_BYTES, readAll } from "../dist/index.js";

/** A fake daemon: `answer(request, daemon)` handles each request the client writes; every request is kept in `seen`. */
function fake(answer) {
	const toDaemon = new PassThrough();
	const fromDaemon = new PassThrough();
	const client = new DaemonClient({ readable: fromDaemon, writable: toDaemon });
	const seen = [];
	const daemon = {
		reply: (request, result) => fromDaemon.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`),
		error: (request, kind, message) =>
			fromDaemon.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message, data: { kind } } })}\n`),
	};
	let buffered = "";
	toDaemon.on("data", (chunk) => {
		buffered += chunk.toString("utf8");
		let at;
		while ((at = buffered.indexOf("\n")) >= 0) {
			const message = JSON.parse(buffered.slice(0, at));
			buffered = buffered.slice(at + 1);
			seen.push(message);
			answer(message, daemon);
		}
	});
	return { client, seen };
}

const b64 = (text) => Buffer.from(text).toString("base64");

test("the protocol's process bounds", () => {
	assert.equal(PROCESS_RING_BYTES, 8 * 1024 * 1024);
	assert.equal(MAX_PROCESSES, 256);
	assert.equal(MAX_READ_WAIT_MS, 30_000);
});

test("readAll pages by nextOffset, long-polls while the process runs, and stops when it has exited", async () => {
	// The stream as the daemon sees it: "hello " at once, nothing for a poll, then "world" and the end.
	const pages = [
		{ data: b64("hello "), nextOffset: 6, dropped: 0, exited: false },
		{ data: "", nextOffset: 6, dropped: 0, exited: false },
		{ data: b64("world"), nextOffset: 11, dropped: 0, exited: true },
	];
	const { client, seen } = fake((request, daemon) => daemon.reply(request, pages.shift()));
	const read = await readAll(client, "p1", "stdout");
	assert.equal(read.ok, true, JSON.stringify(read));
	assert.equal(Buffer.from(read.value.data).toString(), "hello world");
	assert.equal(read.value.nextOffset, 11);
	assert.equal(read.value.dropped, 0);
	assert.deepEqual(
		seen.map((r) => [r.method, r.params.id, r.params.stream, r.params.offset, r.params.maxBytes, r.params.waitMs > 0]),
		[
			["process.read", "p1", "stdout", 0, MAX_CHUNK_BYTES, true],
			["process.read", "p1", "stdout", 6, MAX_CHUNK_BYTES, true],
			["process.read", "p1", "stdout", 6, MAX_CHUNK_BYTES, true],
		],
	);
	client.close();
});

test("readAll starts at an offset, adds up what the ring dropped, and passes waitMs", async () => {
	const pages = [
		{ data: b64("tail"), nextOffset: 104, dropped: 90, exited: false },
		{ data: b64("!"), nextOffset: 105, dropped: 0, exited: true },
	];
	const { client, seen } = fake((request, daemon) => daemon.reply(request, pages.shift()));
	const read = await readAll(client, "p2", "pty", { offset: 10, waitMs: 250 });
	assert.equal(read.ok, true, JSON.stringify(read));
	assert.equal(Buffer.from(read.value.data).toString(), "tail!");
	assert.equal(read.value.dropped, 90);
	assert.equal(read.value.nextOffset, 105);
	assert.deepEqual(
		seen.map((r) => [r.params.stream, r.params.offset, r.params.waitMs]),
		[
			["pty", 10, 250],
			["pty", 104, 250],
		],
	);
	client.close();
});

test("readAll returns the daemon's error as a result", async () => {
	const { client } = fake((request, daemon) => daemon.error(request, "not_found", "no process p9"));
	assert.deepEqual(await readAll(client, "p9", "stdout"), { ok: false, error: { code: "not_found", message: "no process p9" } });
	client.close();
});

test("readAll stops when aborted, and sends the daemon a cancel", async () => {
	const { client, seen } = fake(() => {});
	const controller = new AbortController();
	const pending = readAll(client, "p1", "stdout", { signal: controller.signal });
	await new Promise((resolve) => setImmediate(resolve));
	controller.abort();
	const read = await pending;
	assert.equal(read.ok, false);
	assert.equal(read.error.code, "aborted");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(
		seen.map((m) => m.method),
		["process.read", "$/cancelRequest"],
	);
	client.close();
});

test("listProcesses pages by offset until a page is not truncated", async () => {
	const p = (id) => ({ id, pid: 10, argv: ["sh"], argvClipped: false, pty: false, running: true, exitCode: null, signal: null, startedAt: 1, endedAt: null });
	const pages = [
		{ processes: [p("p1"), p("p2")], truncated: true },
		{ processes: [p("p3")], truncated: true },
		{ processes: [], truncated: false },
	];
	const { client, seen } = fake((request, daemon) => daemon.reply(request, pages.shift()));
	const listed = await listProcesses(client);
	assert.equal(listed.ok, true, JSON.stringify(listed));
	assert.deepEqual(
		listed.value.map((x) => x.id),
		["p1", "p2", "p3"],
	);
	assert.deepEqual(
		seen.map((r) => [r.method, r.params.offset]),
		[
			["process.list", 0],
			["process.list", 2],
			["process.list", 3],
		],
	);
	client.close();
});

test("listProcesses returns the daemon's error as a result", async () => {
	const { client } = fake((request, daemon) => daemon.error(request, "invalid", "bad offset"));
	assert.deepEqual(await listProcesses(client), { ok: false, error: { code: "invalid", message: "bad offset" } });
	client.close();
});
