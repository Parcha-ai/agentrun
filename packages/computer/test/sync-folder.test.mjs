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
		init = spawn("unshare", ["-Ur", DAEMON, "init", "--deadline", deadline], { env: { PATH: process.env.PATH, AGENTRUN_COMPUTERD_SOCKET: socket }, stdio: ["ignore", "ignore", "pipe"] });
		init.stderr.on("data", (chunk) => (stderr += chunk));
		for (let tries = 0; !existsSync(socket); tries++) {
			assert.ok(tries < 200 && init.exitCode === null, `computerd's init did not listen at ${socket}: ${stderr}`);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
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
