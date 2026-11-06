// The files helpers against a fake daemon on in-memory streams: no Go, no Docker.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import test from "node:test";
import { DaemonClient, MAX_CHUNK_BYTES, pullTar, pullTarStream, pushTar, readFile, writeFile } from "../dist/index.js";

/**
 * A fake daemon: `answer(request, daemon)` handles each request the client writes and may send lines back with
 * `daemon.send`. Every request and notification the client wrote is kept in `seen`. A method `answer` leaves unanswered
 * and not pending is answered as the real daemon answers a method it lacks.
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
		missing: (request) => daemon.send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `this daemon has no method "${request.method}"` } }),
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

test("writeFile replaces the file with its first chunk, then writes the rest at offsets, the mode again with the last", async () => {
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
			[7, { path: "/f", offset: MAX_CHUNK_BYTES * 2, mode: 0o755 }],
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


/** Settles as promise does, or rejects once ms pass: a hang becomes a failure that says what hung. */
function within(promise, ms, what) {
	let timer;
	const late = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms / 1000} s`)), ms);
	});
	return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

test("writeFile of a read-only mode over many chunks writes them all, then sets the mode", async () => {
	const file = randomBytes(1536 * 1024);
	let stored;
	// As the daemon does: an existing file without owner write cannot be opened for writing; a mode given is set after
	// the open.
	const { client } = fake((request, daemon) => {
		const { offset, mode, data } = request.params;
		if (stored !== undefined && (stored.mode & 0o200) === 0) return daemon.error(request, "denied", `open ${request.params.path}: permission denied`);
		stored ??= { mode: 0o644, bytes: Buffer.alloc(0) };
		if (offset === undefined) stored.bytes = Buffer.alloc(0);
		if (mode !== undefined) stored.mode = mode;
		const piece = bytesOf(data);
		const at = offset ?? 0;
		stored.bytes = Buffer.concat([stored.bytes.subarray(0, at), piece, stored.bytes.subarray(at + piece.length)]);
		daemon.reply(request, { size: stored.bytes.length });
	});
	assert.deepEqual(await writeFile(client, "/secret", file, { mode: 0o400 }), { ok: true, value: { size: file.length } });
	assert.ok(stored.bytes.equals(file), "the bytes written differ");
	assert.equal(stored.mode, 0o400);
	client.close();
});

/**
 * A fake daemon for tar pulls and pushes that keeps sessions as the real one does: at most 8 of each a connection, a
 * pull reads `archive` in chunks of `chunk`, and its end is idempotent. What each push was sent is in `pushed`.
 */
function tarDaemon({ archive = Buffer.alloc(0), chunk = MAX_CHUNK_BYTES, failRead } = {}) {
	const pulls = new Map();
	const pushes = new Map();
	const pushed = [];
	let next = 0;
	const fakeDaemon = fake((request, daemon) => {
		const { id } = request.params ?? {};
		switch (request.method) {
			case "ping":
				return daemon.reply(request, {});
			case "tar.pull.begin":
				if (pulls.size >= 8) return daemon.error(request, "limit", "a connection has at most 8 pulls open: end one first");
				pulls.set(`pull-${++next}`, 0);
				return daemon.reply(request, { id: `pull-${next}` });
			case "tar.pull.read": {
				if (!pulls.has(id)) return daemon.error(request, "not_found", `no pull "${id}" on this connection`);
				if (failRead !== undefined && pulls.get(id) >= failRead) return daemon.error(request, "not_found", "a file went away while it was read");
				const at = pulls.get(id);
				const data = archive.subarray(at, at + chunk);
				pulls.set(id, at + data.length);
				return daemon.reply(request, { data: data.toString("base64"), eof: at + data.length >= archive.length });
			}
			case "tar.pull.end":
				pulls.delete(id);
				return daemon.reply(request, {});
			case "tar.push.begin":
				if (pushes.size >= 8) return daemon.error(request, "limit", "a connection has at most 8 pushes open: end one first");
				pushes.set(`push-${++next}`, []);
				return daemon.reply(request, { id: `push-${next}` });
			case "tar.push.write":
				if (!pushes.has(id)) return daemon.error(request, "not_found", `no push "${id}" on this connection`);
				pushes.get(id).push(bytesOf(request.params.data));
				return daemon.reply(request, {});
			case "tar.push.end":
				if (!pushes.has(id)) return daemon.error(request, "not_found", `no push "${id}" on this connection`);
				pushed.push(Buffer.concat(pushes.get(id)));
				pushes.delete(id);
				return daemon.reply(request, { entries: 1 });
			default:
				return daemon.missing(request);
		}
	});
	return { ...fakeDaemon, pulls, pushes, pushed };
}

const methods = (seen) => seen.map((r) => r.method ?? "reply");

test("pullTarStream reads one chunk each time the loop asks for one, then ends the pull", async () => {
	const archive = randomBytes(MAX_CHUNK_BYTES * 2 + 100);
	const { client, seen, pulls } = tarDaemon({ archive });
	const { chunks, done } = pullTarStream(client, "/src");
	const iterator = chunks[Symbol.asyncIterator]();
	const first = await within(iterator.next(), 10_000, "the first chunk");
	assert.equal(first.done, false);
	assert.equal(first.value.length, MAX_CHUNK_BYTES);
	await tick();
	await tick();
	assert.deepEqual(methods(seen), ["tar.pull.begin", "tar.pull.read"], "nothing is read ahead of the loop");
	assert.deepEqual(seen[0].params, { path: "/src" });
	const got = [first.value];
	for (let step = await iterator.next(); !step.done; step = await iterator.next()) got.push(step.value);
	assert.ok(Buffer.concat(got).equals(archive));
	assert.deepEqual(methods(seen), ["tar.pull.begin", "tar.pull.read", "tar.pull.read", "tar.pull.read", "tar.pull.end"]);
	assert.deepEqual(await done, { ok: true, value: { bytes: archive.length } });
	assert.equal(pulls.size, 0);
	client.close();
});

test("a pull whose chunks are not read holds back no other reply on the connection", async () => {
	const { client } = tarDaemon({ archive: randomBytes(MAX_CHUNK_BYTES * 8) });
	const { chunks } = pullTarStream(client, "/src");
	const iterator = chunks[Symbol.asyncIterator]();
	const first = await within(iterator.next(), 10_000, "the first chunk");
	assert.equal(first.done, false, "the pull gave no chunk");
	assert.deepEqual(await within(client.call("ping", {}), 10_000, "a ping beside an unread pull"), { ok: true, value: {} });
	await iterator.return();
	client.close();
});

test("leaving the loop early ends the pull, and the connection carries on", async () => {
	const { client, seen, pulls } = tarDaemon({ archive: randomBytes(MAX_CHUNK_BYTES * 4) });
	const { chunks, done } = pullTarStream(client, "/src");
	let got = 0;
	for await (const chunk of chunks) {
		got += chunk.length;
		break;
	}
	assert.equal(got, MAX_CHUNK_BYTES);
	const ended = await within(done, 10_000, "done");
	assert.equal(ended.ok, false);
	assert.equal(ended.error.code, "aborted");
	assert.equal(seen.at(-1).method, "tar.pull.end");
	assert.equal(pulls.size, 0, "the daemon still holds the pull");
	assert.deepEqual(await within(client.call("ping", {}), 10_000, "a ping after the pull"), { ok: true, value: {} });
	client.close();
});

test("an abort ends the pull at once, while the loop asks for nothing", async () => {
	const { client, pulls } = tarDaemon({ archive: randomBytes(MAX_CHUNK_BYTES * 8) });
	const controller = new AbortController();
	const { chunks, done } = pullTarStream(client, "/src", { signal: controller.signal });
	const iterator = chunks[Symbol.asyncIterator]();
	assert.equal((await within(iterator.next(), 10_000, "the first chunk")).done, false, "the pull gave no chunk");
	controller.abort();
	const ended = await within(done, 10_000, "done after the abort");
	assert.equal(ended.ok, false);
	assert.equal(ended.error.code, "aborted");
	assert.deepEqual(await within(client.call("ping", {}), 10_000, "a ping after the abort"), { ok: true, value: {} });
	assert.equal(pulls.size, 0, "the daemon still holds the pull");
	await assert.rejects(iterator.next(), /aborted/);
	client.close();
});

test("a pull piped into a push on the same client copies the archive", async () => {
	const archive = randomBytes(3 * 1024 * 1024 + 4321);
	const { client, pushed, pulls, pushes } = tarDaemon({ archive });
	const copied = await within(pushTar(client, "/dst", pullTarStream(client, "/src").chunks), 30_000, "the pull piped into the push");
	assert.deepEqual(copied, { ok: true, value: { entries: 1 } });
	assert.equal(pushed.length, 1);
	assert.ok(pushed[0].equals(archive), "the pushed bytes differ from the pulled ones");
	assert.equal(pulls.size + pushes.size, 0);
	client.close();
});

test("pullTar gathers the whole archive", async () => {
	const archive = randomBytes(MAX_CHUNK_BYTES * 2 + 5);
	const { client } = tarDaemon({ archive });
	const pulled = await within(pullTar(client, "/src"), 10_000, "pullTar");
	assert.equal(pulled.ok, true, JSON.stringify(pulled.error));
	assert.ok(Buffer.from(pulled.value).equals(archive));
	client.close();
});

test("a pull the daemon refuses, or fails while reading, returns its error, and the loop throws it", async () => {
	const refusing = fake((request, daemon) => daemon.error(request, "not_found", "no such path"));
	assert.deepEqual(await within(pullTar(refusing.client, "/nope"), 10_000, "pullTar"), { ok: false, error: { code: "not_found", message: "no such path" } });
	refusing.client.close();
	const { client, seen, pulls } = tarDaemon({ archive: randomBytes(MAX_CHUNK_BYTES * 3), failRead: MAX_CHUNK_BYTES });
	const { chunks, done } = pullTarStream(client, "/src");
	const got = [];
	await assert.rejects(async () => {
		for await (const chunk of chunks) got.push(chunk);
	}, /went away/);
	assert.equal(got.length, 1);
	assert.deepEqual(await done, { ok: false, error: { code: "not_found", message: "a file went away while it was read" } });
	assert.equal(seen.at(-1).method, "tar.pull.end");
	assert.equal(pulls.size, 0);
	client.close();
});

/**
 * Runs 8 pushes of `archive` on one client, all open at once: no source gives its bytes until every push has begun
 * (or ended without beginning).
 */
function eightAtOnce(client, dir, archive) {
	let arrived = 0;
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	const one = (i) => {
		let here = false;
		const arrive = () => {
			if (here) return;
			here = true;
			if (++arrived === 8) release();
		};
		async function* source() {
			arrive();
			await gate;
			yield archive;
		}
		return pushTar(client, `${dir}/${i}`, source()).finally(arrive);
	};
	return Promise.all(Array.from({ length: 8 }, (_, i) => one(i)));
}

test("a push aborted after its source ends still ends, so the connection's 8 pushes stay free", async () => {
	const { client, seen, pushes } = tarDaemon();
	const controller = new AbortController();
	async function* source() {
		yield randomBytes(MAX_CHUNK_BYTES);
		controller.abort();
	}
	const aborted = await within(pushTar(client, "/dst", source(), { signal: controller.signal }), 10_000, "the aborted push");
	assert.equal(aborted.ok, false);
	assert.equal(aborted.error.code, "aborted");
	await tick();
	assert.ok(seen.some((r) => r.method === "tar.push.end"), "the aborted push was never ended");
	assert.equal(pushes.size, 0, "the aborted push still holds a slot");
	const eight = await within(eightAtOnce(client, "/more", Buffer.from("x")), 10_000, "8 pushes at once");
	assert.deepEqual(
		eight.map((r) => (r.ok ? "ok" : r.error.code)),
		Array(8).fill("ok"),
	);
	client.close();
});

test("a push aborted while it begins still ends what it began", async () => {
	const { client, seen, pushes } = tarDaemon();
	const controller = new AbortController();
	const pushing = pushTar(client, "/dst", Buffer.from("x"), { signal: controller.signal });
	controller.abort();
	const result = await within(pushing, 10_000, "the aborted push");
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "aborted");
	await within(
		(async () => {
			while (pushes.size > 0 || !seen.some((r) => r.method === "tar.push.end")) await tick();
		})(),
		10_000,
		"the end of the begun push",
	);
	client.close();
});
