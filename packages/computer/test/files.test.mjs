// The files helpers and the client's notification routing against a fake daemon on in-memory streams: no Go, no Docker.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import test from "node:test";
import { CANCEL_METHOD, DaemonClient, MAX_CHUNK_BYTES, pullTar, pullTarStream, pushTar, readFile, TAR_DATA_METHOD, writeFile } from "../dist/index.js";

/**
 * A fake daemon: `answer(request, daemon)` handles each request the client writes and may send lines back with
 * `daemon.send`. Every request and notification the client wrote is kept in `seen`.
 */
function fake(answer) {
	const toDaemon = new PassThrough();
	const fromDaemon = new PassThrough();
	const client = new DaemonClient({ readable: fromDaemon, writable: toDaemon });
	const seen = [];
	const daemon = {
		send: (message) => fromDaemon.write(`${JSON.stringify(message)}\n`),
		reply: (request, result) => daemon.send({ jsonrpc: "2.0", id: request.id, result }),
		error: (request, kind, message) => daemon.send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message, data: { kind } } }),
		note: (request, data) => daemon.send({ jsonrpc: "2.0", method: TAR_DATA_METHOD, params: { request: request.id, data: Buffer.from(data).toString("base64") } }),
	};
	let buffered = "";
	toDaemon.on("data", (chunk) => {
		buffered += chunk.toString("utf8");
		let at;
		while ((at = buffered.indexOf("\n")) >= 0) {
			const line = buffered.slice(0, at);
			buffered = buffered.slice(at + 1);
			assert.ok(Buffer.byteLength(line) <= 1024 * 1024, `the client wrote a ${Buffer.byteLength(line)}-byte line`);
			const message = JSON.parse(line);
			seen.push(message);
			answer(message, daemon);
		}
	});
	return { client, seen, daemon, fromDaemon };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const bytesOf = (base64) => Buffer.from(base64, "base64");

test("a notification reaches the call whose id it names, and only while that call is pending", async () => {
	const requests = [];
	const { client, daemon } = fake((request) => requests.push(request));
	const got = { a: [], b: [] };
	const a = client.call("tar.pull", { path: "/a" }, { onNotification: (n) => got.a.push(n) });
	const b = client.call("tar.pull", { path: "/b" }, { onNotification: (n) => got.b.push(n) });
	await tick();
	const [ra, rb] = requests;
	daemon.note(rb, "b1");
	daemon.note(ra, "a1");
	daemon.send({ jsonrpc: "2.0", method: TAR_DATA_METHOD, params: { request: 999, data: "" } });
	daemon.send({ jsonrpc: "2.0", method: "something.else", params: {} });
	daemon.note(rb, "b2");
	daemon.reply(rb, { bytes: 4 });
	daemon.note(rb, "late");
	daemon.note(ra, "a2");
	daemon.reply(ra, { bytes: 4 });
	assert.deepEqual(await b, { ok: true, value: { bytes: 4 } });
	assert.deepEqual(await a, { ok: true, value: { bytes: 4 } });
	assert.deepEqual(
		got.a.map((n) => [n.method, bytesOf(n.params.data).toString()]),
		[
			["tar.data", "a1"],
			["tar.data", "a2"],
		],
	);
	assert.deepEqual(
		got.b.map((n) => bytesOf(n.params.data).toString()),
		["b1", "b2"],
	);
	client.close();
});

test("a notification handler's promise holds back reading until it settles", async () => {
	const requests = [];
	const { client, daemon } = fake((request) => requests.push(request));
	let release;
	const held = new Promise((resolve) => {
		release = resolve;
	});
	const order = [];
	const first = client.call("tar.pull", { path: "/a" }, { onNotification: () => (order.push("note"), held) });
	await tick();
	daemon.note(requests[0], "x");
	await tick();
	const second = client.call("ping", {});
	await tick();
	daemon.reply(requests[1], {});
	second.then(() => order.push("ping"));
	await tick();
	await tick();
	assert.deepEqual(order, ["note"], "the ping's reply is not read while the handler holds");
	release();
	assert.deepEqual(await second, { ok: true, value: {} });
	daemon.reply(requests[0], { bytes: 1 });
	assert.deepEqual(await first, { ok: true, value: { bytes: 1 } });
	client.close();
});

test("readFile reads in chunks until eof", async () => {
	const file = randomBytes(MAX_CHUNK_BYTES * 2 + 1000);
	const { client, seen } = fake((request, daemon) => {
		const { offset = 0, length } = request.params;
		const data = file.subarray(offset, offset + length);
		daemon.reply(request, { data: data.toString("base64"), eof: offset + data.length >= file.length, size: file.length });
	});
	const read = await readFile(client, "/f");
	assert.equal(read.ok, true, JSON.stringify(read.error));
	assert.ok(Buffer.from(read.value).equals(file));
	assert.deepEqual(
		seen.map((r) => [r.method, r.params.path, r.params.offset, r.params.length]),
		[
			["files.read", "/f", 0, MAX_CHUNK_BYTES],
			["files.read", "/f", MAX_CHUNK_BYTES, MAX_CHUNK_BYTES],
			["files.read", "/f", MAX_CHUNK_BYTES * 2, MAX_CHUNK_BYTES],
		],
	);
	client.close();
});

test("readFile returns the daemon's error", async () => {
	const { client } = fake((request, daemon) => daemon.error(request, "not_found", "no such file"));
	assert.deepEqual(await readFile(client, "/f"), { ok: false, error: { code: "not_found", message: "no such file" } });
	client.close();
});

test("writeFile replaces the file with its first chunk, then writes the rest at offsets", async () => {
	const file = randomBytes(MAX_CHUNK_BYTES * 2 + 7);
	const written = Buffer.alloc(file.length);
	const { client, seen } = fake((request, daemon) => {
		const data = bytesOf(request.params.data);
		data.copy(written, request.params.offset ?? 0);
		daemon.reply(request, { size: (request.params.offset ?? 0) + data.length });
	});
	const wrote = await writeFile(client, "/f", file, { mode: 0o755, parents: true });
	assert.deepEqual(wrote, { ok: true, value: { size: file.length } });
	assert.ok(written.equals(file));
	assert.deepEqual(
		seen.map(({ params: { data, ...rest } }) => [bytesOf(data).length, rest]),
		[
			[MAX_CHUNK_BYTES, { path: "/f", mode: 0o755, parents: true }],
			[MAX_CHUNK_BYTES, { path: "/f", offset: MAX_CHUNK_BYTES }],
			[7, { path: "/f", offset: MAX_CHUNK_BYTES * 2 }],
		],
	);
	client.close();
});

test("writeFile of no bytes is one call that makes an empty file", async () => {
	const { client, seen } = fake((request, daemon) => daemon.reply(request, { size: 0 }));
	assert.deepEqual(await writeFile(client, "/empty", new Uint8Array()), { ok: true, value: { size: 0 } });
	assert.deepEqual(
		seen.map((r) => [r.method, r.params]),
		[["files.write", { path: "/empty", data: "" }]],
	);
	client.close();
});

/** A daemon end for tar pushes: it keeps what each push was sent. */
function pushDaemon({ failWrite } = {}) {
	const pushed = [];
	const fakeDaemon = fake((request, daemon) => {
		if (request.method === "tar.push.begin") return daemon.reply(request, { id: "p1" });
		if (request.method === "tar.push.write") {
			pushed.push(bytesOf(request.params.data));
			if (failWrite === pushed.length) return daemon.error(request, "denied", 'entry "../x" is outside the target directory');
			return daemon.reply(request, {});
		}
		if (request.method === "tar.push.end") return daemon.reply(request, { entries: 3 });
	});
	return { ...fakeDaemon, pushed };
}

test("pushTar sends bytes in order, in chunks of at most 512 KiB, then ends the push", async () => {
	const tar = randomBytes(MAX_CHUNK_BYTES + 100);
	const { client, seen, pushed } = pushDaemon();
	assert.deepEqual(await pushTar(client, "/dst", tar), { ok: true, value: { entries: 3 } });
	assert.deepEqual(
		seen.map((r) => r.method),
		["tar.push.begin", "tar.push.write", "tar.push.write", "tar.push.end"],
	);
	assert.deepEqual(seen[0].params, { path: "/dst" });
	assert.ok(pushed.every((p) => p.length <= MAX_CHUNK_BYTES));
	assert.ok(Buffer.concat(pushed).equals(tar));
	client.close();
});

test("pushTar takes an async iterable and merges small pieces up to a chunk", async () => {
	const pieces = Array.from({ length: 12 }, () => randomBytes(100 * 1024));
	const { client, pushed } = pushDaemon();
	async function* source() {
		for (const piece of pieces) yield piece;
	}
	assert.deepEqual(await pushTar(client, "/dst", source()), { ok: true, value: { entries: 3 } });
	assert.deepEqual(
		pushed.map((p) => p.length),
		[MAX_CHUNK_BYTES, MAX_CHUNK_BYTES, 12 * 100 * 1024 - 2 * MAX_CHUNK_BYTES],
	);
	assert.ok(Buffer.concat(pushed).equals(Buffer.concat(pieces)));
	client.close();
});

test("pushTar stops at a refused write and returns its error", async () => {
	const { client, seen } = pushDaemon({ failWrite: 1 });
	const pushed = await pushTar(client, "/dst", randomBytes(MAX_CHUNK_BYTES * 3));
	assert.deepEqual(pushed, { ok: false, error: { code: "denied", message: 'entry "../x" is outside the target directory' } });
	assert.deepEqual(
		seen.map((r) => r.method),
		["tar.push.begin", "tar.push.write"],
	);
	client.close();
});

test("pushTar ends the push when its source fails", async () => {
	const { client, seen } = pushDaemon();
	async function* source() {
		yield randomBytes(10);
		throw new Error("disk gone");
	}
	const pushed = await pushTar(client, "/dst", source());
	assert.equal(pushed.ok, false);
	assert.equal(pushed.error.code, "invalid");
	assert.match(pushed.error.message, /disk gone/);
	assert.equal(seen.at(-1).method, "tar.push.end");
	client.close();
});

/** A daemon end for tar pulls: it sends `chunks` as tar.data, then the reply. */
function pullDaemon(chunks, { bytes } = {}) {
	return fake((request, daemon) => {
		if (request.method !== "tar.pull") return;
		for (const chunk of chunks) daemon.note(request, chunk);
		daemon.reply(request, { bytes: bytes ?? chunks.reduce((n, c) => n + c.length, 0) });
	});
}

test("pullTar gathers every tar.data of its call", async () => {
	const chunks = [randomBytes(MAX_CHUNK_BYTES), randomBytes(MAX_CHUNK_BYTES), randomBytes(5)];
	const { client, seen } = pullDaemon(chunks);
	const pulled = await pullTar(client, "/src");
	assert.equal(pulled.ok, true, JSON.stringify(pulled.error));
	assert.ok(Buffer.from(pulled.value).equals(Buffer.concat(chunks)));
	assert.deepEqual(seen[0].params, { path: "/src" });
	client.close();
});

test("pullTar refuses an archive whose length is not the reply's", async () => {
	const { client } = pullDaemon([randomBytes(10)], { bytes: 11 });
	const pulled = await pullTar(client, "/src");
	assert.equal(pulled.ok, false);
	assert.equal(pulled.error.code, "invalid");
	client.close();
});

test("pullTarStream yields chunks as they come, and done says how it ended", async () => {
	const chunks = Array.from({ length: 10 }, () => randomBytes(1000));
	const { client } = pullDaemon(chunks);
	const { chunks: stream, done } = pullTarStream(client, "/src");
	const got = [];
	for await (const chunk of stream) got.push(Buffer.from(chunk));
	assert.ok(Buffer.concat(got).equals(Buffer.concat(chunks)));
	assert.deepEqual(await done, { ok: true, value: { bytes: 10_000 } });
	client.close();
});

test("pullTarStream: leaving the loop early cancels the pull", async () => {
	const requests = [];
	const { client, seen, daemon } = fake((request) => requests.push(request));
	const { chunks: stream, done } = pullTarStream(client, "/src");
	const iterator = stream[Symbol.asyncIterator]();
	const first = iterator.next();
	await tick();
	daemon.note(requests[0], "one");
	assert.equal(Buffer.from((await first).value).toString(), "one");
	await iterator.return();
	const ended = await done;
	assert.equal(ended.ok, false);
	assert.equal(ended.error.code, "aborted");
	await tick();
	assert.deepEqual(seen.at(-1), { jsonrpc: "2.0", method: CANCEL_METHOD, params: { id: requests[0].id } });
	client.close();
});

test("pullTarStream returns the daemon's error through done", async () => {
	const { client } = fake((request, daemon) => daemon.error(request, "not_found", "no such path"));
	const { chunks: stream, done } = pullTarStream(client, "/nope");
	const got = [];
	for await (const chunk of stream) got.push(chunk);
	assert.deepEqual(got, []);
	assert.deepEqual(await done, { ok: false, error: { code: "not_found", message: "no such path" } });
	client.close();
});
