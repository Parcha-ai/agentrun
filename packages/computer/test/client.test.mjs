// DaemonClient's framing against an in-memory pair of streams: no daemon, no Docker.
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { CANCEL_METHOD, DaemonClient, MAX_LINE_BYTES } from "../dist/index.js";

/** A fake daemon's end: the lines the client wrote, one at a time, and a way to answer. */
function pair() {
	const toDaemon = new PassThrough();
	const fromDaemon = new PassThrough();
	const client = new DaemonClient({ readable: fromDaemon, writable: toDaemon });
	let buffered = "";
	const lines = [];
	const waiters = [];
	toDaemon.on("data", (chunk) => {
		buffered += chunk.toString("utf8");
		let at;
		while ((at = buffered.indexOf("\n")) >= 0) {
			const line = JSON.parse(buffered.slice(0, at));
			buffered = buffered.slice(at + 1);
			const waiter = waiters.shift();
			if (waiter) waiter(line);
			else lines.push(line);
		}
	});
	const next = () =>
		lines.length > 0
			? Promise.resolve(lines.shift())
			: new Promise((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error("the client wrote no line within 2 s")), 2000);
					waiters.push((line) => {
						clearTimeout(timer);
						resolve(line);
					});
				});
	const send = (message) => fromDaemon.write(`${JSON.stringify(message)}\n`);
	return { client, next, send, fromDaemon, toDaemon, written: () => lines.length };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a request is one JSON-RPC 2.0 line with a numeric id", async () => {
	const { client, next, send } = pair();
	const pending = client.call("hello", { client: "test" });
	const request = await next();
	assert.equal(request.jsonrpc, "2.0");
	assert.equal(typeof request.id, "number");
	assert.equal(request.method, "hello");
	assert.deepEqual(request.params, { client: "test" });
	send({ jsonrpc: "2.0", id: request.id, result: { version: "1", os: "linux", kind: "linux", arch: "amd64", groups: ["exec"] } });
	assert.deepEqual(await pending, { ok: true, value: { version: "1", os: "linux", kind: "linux", arch: "amd64", groups: ["exec"] } });
	client.close();
});

test("a reply split across chunks resolves its call", async () => {
	const { client, next, fromDaemon } = pair();
	const pending = client.call("ping", {});
	const { id } = await next();
	const line = `${JSON.stringify({ jsonrpc: "2.0", id, result: {} })}\n`;
	fromDaemon.write(line.slice(0, 5));
	await tick();
	fromDaemon.write(line.slice(5, 17));
	await tick();
	fromDaemon.write(line.slice(17));
	assert.deepEqual(await pending, { ok: true, value: {} });
	client.close();
});

test("two replies in one chunk, out of order, each reach their own call", async () => {
	const { client, next, fromDaemon } = pair();
	const first = client.call("exec.run", { argv: ["sleep", "1"], timeoutMs: 5000 });
	const second = client.call("ping", {});
	const a = await next();
	const b = await next();
	assert.notEqual(a.id, b.id);
	const result = { exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
	fromDaemon.write(`${JSON.stringify({ jsonrpc: "2.0", id: b.id, result: {} })}\n${JSON.stringify({ jsonrpc: "2.0", id: a.id, result })}\n`);
	assert.deepEqual(await second, { ok: true, value: {} });
	assert.deepEqual(await first, { ok: true, value: result });
	client.close();
});

test("an abort sends $/cancelRequest for that id and returns aborted", async () => {
	const { client, next } = pair();
	const controller = new AbortController();
	const pending = client.call("exec.run", { argv: ["sleep", "60"], timeoutMs: 60_000 }, { signal: controller.signal });
	const request = await next();
	controller.abort();
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "aborted");
	const cancel = await next();
	assert.equal(CANCEL_METHOD, "$/cancelRequest");
	assert.deepEqual(cancel, { jsonrpc: "2.0", method: CANCEL_METHOD, params: { id: request.id } });
	assert.equal("id" in cancel, false, "a cancel is a notification");
	client.close();
});

test("a signal aborted before the call sends nothing", async () => {
	const { client, written } = pair();
	const result = await client.call("ping", {}, { signal: AbortSignal.abort() });
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "aborted");
	await tick();
	assert.equal(written(), 0);
	client.close();
});

test("a daemon error keeps its kind as the code", async () => {
	const { client, next, send } = pair();
	const denied = client.call("exec.run", { argv: ["id"], user: "nobody", timeoutMs: 1000 });
	send({ jsonrpc: "2.0", id: (await next()).id, error: { code: -32000, message: "cannot switch users", data: { kind: "denied" } } });
	assert.deepEqual(await denied, { ok: false, error: { code: "denied", message: "cannot switch users" } });
	const unknown = client.call("ping", {});
	send({ jsonrpc: "2.0", id: (await next()).id, error: { code: -32601, message: "no such method" } });
	assert.deepEqual(await unknown, { ok: false, error: { code: "unsupported", message: "no such method" } });
	client.close();
});

test("a request over 1 MiB is refused and nothing is written", async () => {
	const { client, written } = pair();
	const result = await client.call("exec.run", { argv: ["echo", "x".repeat(MAX_LINE_BYTES)], timeoutMs: 1000 });
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "limit");
	await tick();
	assert.equal(written(), 0);
	client.close();
});

test("a line over 1 MiB from the daemon ends the client and fails what is pending", async () => {
	const { client, next, fromDaemon } = pair();
	const pending = client.call("ping", {});
	await next();
	fromDaemon.write(Buffer.alloc(MAX_LINE_BYTES + 10, 0x61));
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "gone");
	assert.match(result.error.message, /1 MiB/);
	const later = await client.call("ping", {});
	assert.equal(later.ok, false);
	assert.equal(later.error.code, "gone");
});

test("the end of the stream fails pending calls, and later ones, with gone", async () => {
	const { client, next, fromDaemon } = pair();
	const pending = client.call("exec.run", { argv: ["sleep", "60"], timeoutMs: 60_000 });
	await next();
	fromDaemon.end();
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "gone");
	const later = await client.call("ping", {});
	assert.equal(later.ok, false);
	assert.equal(later.error.code, "gone");
});

test("close() fails pending calls with gone", async () => {
	const { client, next } = pair();
	const pending = client.call("ping", {});
	await next();
	client.close();
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "gone");
});
