// The synced folder's delta against a real computerd on this host (sync-folder-cases.mjs): computerd's init in a user
// namespace of its own (unshare -Ur), as root there, over its socket. Skipped, in words, where the host has no
// dist/computerd-linux-<arch> (npm run build:daemon) or refuses a user namespace its capabilities (Ubuntu's AppArmor
// default); docker/sync-folder.docker.test.mjs runs the same cases in a Docker computer. Then the engine's own rules
// against a scripted client: the confinement rule, the caps, and a sink that fails.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DaemonClient, FolderSync, folderPathProblem, SYNC_MAX_BYTES, SYNC_MAX_ENTRIES } from "../dist/index.js";
import { computerdListening } from "./computerd-listening.mjs";
import { CASES, fakeSink, folderOf } from "./sync-folder-cases.mjs";

const ARCH = { x64: "amd64", arm64: "arm64" }[process.arch];
const DAEMON = fileURLToPath(new URL(`../dist/computerd-linux-${ARCH}`, import.meta.url));
/** A user namespace whose root holds its capabilities there: making a network namespace in it is one use of them. */
const userns = spawnSync("unshare", ["-Ur", "unshare", "-n", "true"]).status === 0;
const skip = !existsSync(DAEMON) ? `needs ${DAEMON}: npm run build:daemon` : !userns ? "needs a user namespace with its capabilities (unshare -Ur), which this host refuses" : false;

describe("the synced folder's delta against computerd in a user namespace", { skip }, () => {
	const dir = mkdtempSync(join(tmpdir(), "computer-sync-folder-"));
	const socket = join(dir, "computerd.sock");
	let init;
	let stream;
	let client;
	let stderr = "";

	before(async () => {
		const deadline = new Date(Date.now() + 10 * 60_000).toISOString();
		// Under umask 077, as init on the exec path runs (hosted/scripts.ts): computerd keeps it.
		init = spawn("sh", ["-c", 'umask 077 && exec "$@"', "sh", "unshare", "-Ur", DAEMON, "init", "--deadline", deadline], { env: { PATH: process.env.PATH, AGENTRUN_COMPUTERD_SOCKET: socket }, stdio: ["ignore", "ignore", "pipe"] });
		init.stderr.on("data", (chunk) => (stderr += chunk));
		await computerdListening(socket, init, () => stderr);
		stream = connect(socket);
		await new Promise((resolve, reject) => stream.once("connect", resolve).once("error", reject));
		client = new DaemonClient({ readable: stream, writable: stream });
	});

	after(async () => {
		stream?.destroy();
		if (init && init.exitCode === null) {
			const ended = new Promise((resolve) => init.once("exit", resolve));
			init.kill("SIGTERM");
			await ended;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	CASES.forEach(({ name, setup, run }, n) => {
		it(name, async () => run(await folderOf(client, join(dir, "folders"), `case-${n}`, setup)));
	});
});

/** A client answering files.list from `pages` (offset to a page) and nothing else. */
const listing = (pages) => ({
	calls: [],
	async call(method, params) {
		this.calls.push([method, params.offset]);
		if (method !== "files.list") return { ok: false, error: { code: "unsupported", message: `${method} is not scripted` } };
		const page = pages(params.offset ?? 0);
		return page === undefined ? { ok: false, error: { code: "invalid", message: `no page at ${params.offset}` } } : { ok: true, value: page };
	},
	close() {},
});
const file = (path, size = 1) => ({ path: `/workspace/${path}`, type: "file", size, mode: 0o644, mtimeMs: 1 });

test("folderPathProblem: a relative path of named segments alone", () => {
	assert.equal(folderPathProblem("a/b.txt"), undefined);
	for (const [path, why] of [
		["", "is empty"],
		["/a", "is absolute"],
		["a//b", "has an empty segment"],
		["a/../b", 'has a ".." segment'],
		["./a", 'has a "." segment'],
		["a\\b", "holds a backslash"],
		["a\0b", "holds a NUL"],
	])
		assert.equal(folderPathProblem(path), why, JSON.stringify(path));
});

test("a listing over the caps fails the sync, kind limit, in words; a path no sink can keep fails it, naming the path", async () => {
	const over = new FolderSync(listing(() => ({ entries: Array.from({ length: SYNC_MAX_ENTRIES + 1 }, (_, i) => file(`f${i}`)), truncated: false })), fakeSink());
	assert.deepEqual(await over.baseline(), { ok: false, error: { code: "limit", message: `the run's folder holds more than ${SYNC_MAX_ENTRIES} entries, the most a synced folder holds` } });
	const big = new FolderSync(listing(() => ({ entries: [file("a", SYNC_MAX_BYTES), file("b", 1)], truncated: false })), fakeSink());
	assert.deepEqual(await big.baseline(), { ok: false, error: { code: "limit", message: `the run's folder holds ${SYNC_MAX_BYTES + 1} bytes, more than ${SYNC_MAX_BYTES}, the most a synced folder holds` } });
	const odd = new FolderSync(listing(() => ({ entries: [file("a\\b")], truncated: false })), fakeSink());
	const refused = await odd.baseline();
	assert.equal(refused.ok, false);
	assert.equal(refused.error.message, `the run's folder holds "a\\\\b", which holds a backslash, so no sink can keep it: rename or remove it`);
});

test("a truncated listing is paged: the next page asked for at the count read so far, and asked again where a page came short", async () => {
	const all = Array.from({ length: 10 }, (_, i) => file(`f${i}`));
	// Pages of 4, then one cut short at 1, then the rest.
	const cuts = { 0: 4, 4: 1, 5: 5 };
	const client = listing((offset) => (cuts[offset] === undefined ? { entries: all.slice(offset, offset + 4), truncated: offset + 4 < all.length } : { entries: all.slice(offset, offset + cuts[offset]), truncated: offset + cuts[offset] < all.length }));
	const sync = new FolderSync(client, fakeSink());
	assert.deepEqual(await sync.baseline(), { ok: true, value: undefined });
	// 0; then 4 and, at the last page's count, 8 at once; 4 came short, so 8 is dropped and 5 asked, with 6 beside it.
	assert.deepEqual(client.calls, [
		["files.list", 0],
		["files.list", 4],
		["files.list", 8],
		["files.list", 5],
		["files.list", 6],
	]);
});

/**
 * A computer scripted by state: `state.entries` is the folder (a whole listing of /workspace), `state.unreadable` the
 * directories a files.list of their own refuses, as computerd does where it can't read one (its walk keeps the
 * directory, without what it holds); each file's bytes are "A", and a tar.pull is refused while `state.noTar`.
 */
const scripted = (state) => ({
	async call(method, params) {
		if (method === "files.list" && params.path === "/workspace") return { ok: true, value: { entries: state.entries, truncated: false } };
		if (method === "files.list") {
			if (state.unreadable?.includes(params.path)) return { ok: false, error: { code: "refused", message: `open ${params.path}: permission denied` } };
			return { ok: true, value: { entries: state.entries.filter((entry) => entry.path.startsWith(`${params.path}/`)), truncated: false } };
		}
		if (method === "files.read") return { ok: true, value: { data: Buffer.from("A").toString("base64"), size: 1, eof: true } };
		if (method === "tar.pull.begin" && state.noTar) return { ok: false, error: { code: "unreachable", message: "the computer is away" } };
		return { ok: false, error: { code: "unsupported", message: method } };
	},
	close() {},
});
const dir = (path, mode = 0o755) => ({ path: `/workspace/${path}`, type: "dir", size: 4096, mode, mtimeMs: 1 });
const link = (path, target) => ({ path: `/workspace/${path}`, type: "symlink", size: target.length, mode: 0o777, mtimeMs: 1, target });
/** The sink, whose calls named in `refusing` (a set of "method path") are refused until taken out of it. */
const refusingSink = (refusing) => {
	const sink = fakeSink();
	for (const method of ["put", "mkdir", "remove"]) {
		const real = sink[method];
		sink[method] = async (path, ...rest) => (refusing.has(`${method} ${path}`) ? { ok: false, error: { code: "unreachable", message: "the store is down" } } : real(path, ...rest));
	}
	return sink;
};

test("a directory the computer's user can't read hides what the sink holds under it: the sync writes nothing and says so; readable again, it goes on, and an emptied one empties", async () => {
	const state = { entries: [dir("d"), file("d/a"), link("d/l", "a"), dir("e"), file("e/b")] };
	const sink = fakeSink();
	const sync = new FolderSync(scripted(state), sink);
	assert.deepEqual(await sync.baseline(), { ok: true, value: undefined });
	// chmod 000 d: files.list keeps d, without what it holds, and a files.list of d alone is refused. rm e/b: e is empty.
	// A new file beside them waits too: nothing past an unknown is written.
	state.entries = [dir("d", 0), dir("e"), file("n")];
	state.unreadable = ["/workspace/d"];
	assert.deepEqual(await sync.sync(), { ok: false, error: { code: "refused", message: "the run's folder holds d/, which the computer's user can't read, so nothing is synced until it can (chmod u+rx)" } });
	assert.deepEqual(sink.calls, []);
	// Readable again, as it was: e empties, n lands, d is as the sink holds it.
	state.entries = [dir("d"), file("d/a"), link("d/l", "a"), dir("e"), file("n")];
	state.unreadable = [];
	assert.deepEqual(await sync.sync(), { ok: true, value: { put: 1, mkdir: 1, removed: 1, meta: false } });
	assert.deepEqual(sink.calls, [
		["put", "n", "A"],
		["mkdir", "e"],
		["remove", "e/b", "file"],
	]);
});

test("a path whose old entry the sink did not remove keeps it: the next sync removes it again before it writes the new one", async () => {
	const state = { entries: [file("l")] };
	const refusing = new Set(["remove l"]);
	const sink = refusingSink(refusing);
	const sync = new FolderSync(scripted(state), sink);
	assert.deepEqual(await sync.baseline(), { ok: true, value: undefined });
	state.entries = [link("l", "x")];
	assert.deepEqual(await sync.sync(), { ok: false, error: { code: "unreachable", message: "1 of the folder's changes did not land, and are sent again at the next sync: l: the store is down" } });
	assert.deepEqual(sink.calls, []);
	refusing.clear();
	assert.deepEqual(await sync.sync(), { ok: true, value: { put: 0, mkdir: 0, removed: 1, meta: true } });
	assert.deepEqual(sink.calls, [
		["remove", "l", "file"],
		["meta", { modes: {}, links: { l: "x" } }],
	]);
});

test("a new directory none of whose files landed is new again: emptied since, the next sync makes it", async () => {
	const state = { entries: [] };
	const sink = fakeSink();
	const sync = new FolderSync(scripted(state), sink);
	assert.deepEqual(await sync.baseline(), { ok: true, value: undefined });
	state.entries = [dir("d"), file("d/f")];
	state.noTar = true;
	assert.deepEqual(await sync.sync(), { ok: false, error: { code: "unreachable", message: "1 of the folder's changes did not land, and are sent again at the next sync: d/: the computer is away" } });
	state.entries = [dir("d")];
	assert.deepEqual(await sync.sync(), { ok: true, value: { put: 0, mkdir: 1, removed: 0, meta: false } });
	assert.deepEqual(sink.calls, [["mkdir", "d"]]);
});

test("a listing past the entry cap fails as its pages come, never held whole", async () => {
	const page = { entries: Array.from({ length: 1000 }, (_, i) => file(`f${i}`)), truncated: true };
	const client = listing(() => page);
	const sync = new FolderSync(client, fakeSink());
	assert.deepEqual(await sync.baseline(), { ok: false, error: { code: "limit", message: `the run's folder holds more than ${SYNC_MAX_ENTRIES} entries, the most a synced folder holds` } });
	assert.ok(client.calls.length <= SYNC_MAX_ENTRIES / 1000 + 3, `${client.calls.length} pages asked for`);
});

test("a link or a mode of a path named __proto__ is kept like any other", async () => {
	for (const [entry, json] of [
		[link("__proto__", "t"), '{"modes":{},"links":{"__proto__":"t"}}'],
		[{ ...file("__proto__"), mode: 0o600 }, '{"modes":{"__proto__":384},"links":{}}'],
	]) {
		const state = { entries: [] };
		const sink = fakeSink();
		const sync = new FolderSync(scripted(state), sink);
		assert.deepEqual(await sync.baseline(), { ok: true, value: undefined });
		state.entries = [entry];
		assert.equal((await sync.sync()).ok, true);
		assert.deepEqual(
			sink.calls.filter(([method]) => method === "meta").map(([, meta]) => JSON.stringify(meta)),
			[json],
		);
	}
});

test("a sink that fails a put: the sync fails in words, deletes and meta wait, and the next sync sends it again", async () => {
	let entries = [file("a")];
	const client = {
		async call(method, params) {
			if (method === "files.list") return { ok: true, value: { entries, truncated: false } };
			if (method === "files.read") return { ok: true, value: { data: Buffer.from("A").toString("base64"), size: 1, eof: true } };
			return { ok: false, error: { code: "unsupported", message: method } };
		},
		close() {},
	};
	const sink = fakeSink();
	let refuse = true;
	const put = sink.put;
	sink.put = async (path, body) => (refuse ? { ok: false, error: { code: "unreachable", message: "the store is down" } } : put(path, body));
	const sync = new FolderSync(client, sink);
	assert.deepEqual(await sync.baseline(), { ok: true, value: undefined });
	entries = [{ ...file("b"), mtimeMs: 2 }];
	assert.deepEqual(await sync.sync(), { ok: false, error: { code: "unreachable", message: "1 of the folder's changes did not land, and are sent again at the next sync: b: the store is down" } });
	assert.deepEqual(sink.calls, [], "a is not removed while b has not landed");
	refuse = false;
	assert.deepEqual(await sync.sync(), { ok: true, value: { put: 1, mkdir: 0, removed: 1, meta: false } });
	assert.deepEqual(sink.calls, [
		["put", "b", "A"],
		["remove", "a", "file"],
	]);
});

/** A ustar header of a file of `size` bytes, without its bytes. */
const fileHeader = (name, size) => {
	const block = Buffer.alloc(512);
	block.write(name, 0, "utf8");
	block.write("0000644\0", 100, "ascii");
	block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
	block.write("0", 156, "ascii");
	block.write("ustar\u000000", 257, "ascii");
	block.fill(0x20, 148, 156);
	let sum = 0;
	for (const byte of block) sum += byte;
	block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
	return block;
};

test("a file grown since the listing past the bytes a sync reads fails, kind limit, at its tar header, before its bytes are held", async () => {
	const huge = SYNC_MAX_BYTES + 1;
	for (const [entries, words] of [
		// Listed past a chunk: a tar.pull of it.
		[[file("big", 1024 ** 2)], `big: it grew since the listing past what is left of the ${SYNC_MAX_BYTES} bytes a sync reads`],
		// Listed at a byte, and read past a chunk now: a tar.pull of it too.
		[[file("small", 1)], `small: it grew since the listing past what is left of the ${SYNC_MAX_BYTES} bytes a sync reads`],
		// A new directory's tree.
		[[dir("d"), file("d/f", 1)], `d/: its files grew since the listing past what is left of the ${SYNC_MAX_BYTES} bytes a sync reads`],
	]) {
		let listed = [];
		const reads = [];
		const client = {
			async call(method, params) {
				if (method === "files.list" && params.path === "/workspace") return { ok: true, value: { entries: listed, truncated: false } };
				if (method === "files.list") return { ok: true, value: { entries: listed.filter((entry) => entry.path.startsWith(`${params.path}/`)), truncated: false } };
				// A chunk, then its end at the second (a read of the whole file would read it whole).
				if (method === "files.read") return { ok: true, value: { data: Buffer.alloc(params.length).toString("base64"), size: huge, eof: params.offset > 0 } };
				if (method === "tar.pull.begin") return { ok: true, value: { id: "t" } };
				if (method === "tar.pull.end") return { ok: true, value: {} };
				if (method === "tar.pull.read") {
					// The header, then zeros, as the file's bytes would come, for 8 reads (a cut archive, where nothing refuses it).
					reads.push(params.id);
					const name = entries[0].type === "dir" ? "./f" : entries[0].path.slice("/workspace/".length);
					return { ok: true, value: { data: (reads.length === 1 ? fileHeader(name, huge) : Buffer.alloc(512 * 1024)).toString("base64"), eof: reads.length === 8 } };
				}
				return { ok: false, error: { code: "unsupported", message: method } };
			},
			close() {},
		};
		const sink = fakeSink();
		const sync = new FolderSync(client, sink);
		assert.deepEqual(await sync.baseline(), { ok: true, value: undefined });
		listed = entries;
		assert.deepEqual(await sync.sync(), { ok: false, error: { code: "limit", message: `1 of the folder's changes did not land, and are sent again at the next sync: ${words}` } });
		assert.equal(reads.length, 1, "no read past the header");
		assert.deepEqual(sink.calls.filter(([method]) => method === "put"), []);
	}
});

test("adopt: a kept computer's folder with no manifest; the next sync puts every file it holds, removes what the sink holds beyond them, and writes the modes and links", async () => {
	const state = { entries: [file("a"), dir("d"), { ...file("b"), mode: 0o600 }, link("l", "a")] };
	const sink = fakeSink();
	const sync = new FolderSync(scripted(state), sink);
	sync.adopt([["a", "file"], ["d", "dir"], ["d/x", "file"], ["gone", "file"]]);
	// Every file, the sink's copy of a included, and every directory, as nothing of the computer's copy is known.
	assert.deepEqual(await sync.sync(), { ok: true, value: { put: 2, mkdir: 1, removed: 2, meta: true } });
	assert.deepEqual(sink.calls.slice(0, 3).sort(), [["mkdir", "d"], ["put", "a", "A"], ["put", "b", "A"]]);
	assert.deepEqual(sink.calls.slice(3, 5).sort(), [["remove", "d/x", "file"], ["remove", "gone", "file"]], "removed once every put landed");
	assert.deepEqual(sink.calls[5], ["meta", { modes: { b: 0o600 }, links: { l: "a" } }]);
	assert.deepEqual(await sync.sync(), { ok: true, value: { put: 0, mkdir: 0, removed: 0, meta: false } }, "settled");
});

/** A client for a push: tar.push.* answered and what was written kept; files.list answers `listed` (an error, or the entries). */
function pushing({ pushFails, listed = { entries: [], truncated: false } }) {
	const sent = { calls: [], bytes: [] };
	return {
		sent,
		async call(method, params) {
			sent.calls.push(method);
			if (method === "tar.push.begin") return pushFails ? { ok: false, error: { code: "refused", message: pushFails } } : { ok: true, value: { id: "p1" } };
			if (method === "tar.push.write") {
				sent.bytes.push(Buffer.from(params.data, "base64"));
				return { ok: true, value: {} };
			}
			if (method === "tar.push.end") return { ok: true, value: { entries: 2 } };
			if (method === "files.list") return listed.error ? { ok: false, error: listed.error } : { ok: true, value: listed };
			return { ok: false, error: { code: "unsupported", message: `${method} is not scripted` } };
		},
		close() {},
	};
}
/** The mtime a ustar header (the 512 bytes at `at`) carries, in seconds. */
const headerMtime = (bytes, at) => Number.parseInt(bytes.subarray(at + 136, at + 147).toString("latin1"), 8);

test("push: each file is stamped with the pushed mtime in the tar, a directory is not, and the baseline is taken after the push ends", async () => {
	const client = pushing({ listed: { entries: [file("d/f", 3)], truncated: false } });
	const sync = new FolderSync(client, fakeSink());
	const entries = [
		{ name: "d", type: "dir", mode: 0o755 },
		{ name: "d/f", type: "file", mode: 0o644, body: Buffer.from("abc"), mtime: 1_700_000_000 },
	];
	assert.deepEqual(await sync.push(entries), { ok: true, value: undefined });
	assert.deepEqual(client.sent.calls, ["tar.push.begin", "tar.push.write", "tar.push.end", "files.list"], "the baseline's listing is read once the push has ended");
	const tar = Buffer.concat(client.sent.bytes);
	assert.equal(headerMtime(tar, 512), 946_684_800, "the file's own mtime is replaced by the pushed one, the year 2000");
	assert.notEqual(headerMtime(tar, 0), 946_684_800, "a directory keeps what it was given");
	assert.deepEqual(await sync.sync(), { ok: true, value: { put: 0, mkdir: 0, removed: 0, meta: false } }, "the listing it took is the manifest: nothing to put");
});

test("push: a push that fails says it was the push, its code kept, and takes no baseline; a listing that fails says it was the listing; no entries push an empty tar", async () => {
	const down = pushing({ pushFails: "the computer is full" });
	const pushed = await new FolderSync(down, fakeSink()).push([{ name: "f", type: "file", mode: 0o644, body: Buffer.from("x") }]);
	assert.deepEqual(pushed, { ok: false, error: { code: "refused", message: "could not be pushed into the computer: the computer is full" } });
	assert.deepEqual(down.sent.calls, ["tar.push.begin"], "no listing after a push that failed");
	const blind = pushing({ listed: { error: { code: "gone", message: "the computer went away" } } });
	const listed = await new FolderSync(blind, fakeSink()).push([{ name: "f", type: "file", mode: 0o644, body: Buffer.from("x") }]);
	assert.deepEqual(listed, { ok: false, error: { code: "gone", message: "pushed into the computer could not be listed: files.list of /workspace at 0: the computer went away" } });
	const none = pushing({});
	assert.deepEqual(await new FolderSync(none, fakeSink()).push([]), { ok: true, value: undefined });
	assert.deepEqual(none.sent.calls, ["tar.push.begin", "tar.push.write", "tar.push.end", "files.list"], "an empty folder is an empty tar, then its baseline");
});

test("push: a source that throws is a failed push in words (the push ended, no baseline); an abort lets the source go", async () => {
	const broken = pushing({});
	const throwing = (async function* () {
		yield { name: "a", type: "file", mode: 0o644, body: Buffer.from("a") };
		throw new Error("the store lost a");
	})();
	const failed = await new FolderSync(broken, fakeSink()).push(throwing);
	assert.deepEqual(failed, { ok: false, error: { code: "invalid", message: "could not be pushed into the computer: the tar source failed: the store lost a" } });
	assert.deepEqual(broken.sent.calls, ["tar.push.begin", "tar.push.end"], "the push that began was ended, and no listing followed");

	const stopped = new AbortController();
	let closed = false;
	let next = 0;
	const endless = {
		[Symbol.asyncIterator]: () => ({
			next: async () => {
				if (++next === 3) stopped.abort();
				return { done: false, value: { name: `f${next}`, type: "file", mode: 0o644, body: Buffer.from("x") } };
			},
			return: async () => {
				closed = true;
				return { done: true, value: undefined };
			},
		}),
	};
	const aborted = await new FolderSync(pushing({}), fakeSink()).push(endless, { signal: stopped.signal });
	assert.equal(aborted.ok, false);
	assert.match(aborted.error.message, /^could not be pushed into the computer: .*aborted/);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(closed, true, "the caller's entries are let go, as a push lets go of its tar");
});
