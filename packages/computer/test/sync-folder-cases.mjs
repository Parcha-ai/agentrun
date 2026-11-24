// The synced folder's delta (src/sync-folder.ts) against a real computerd: each change made in the folder by a shell
// in the computer (a write, a move, rm -rf, chmod, a symlink, a same-ms same-size rewrite, one in a push's own tick, a
// new tree) lands on a fake sink exactly once, through the reads it should take (files.read up to 512 KiB, a tar.pull
// above it and for a new tree). Run on a computerd on this host in a user namespace (sync-folder.test.mjs), and in a
// Docker computer (docker/sync-folder.docker.test.mjs).
import assert from "node:assert/strict";
import { FolderSync } from "../dist/index.js";

const RACY_MS = 1000;

/** A sink that records each call, in order, a body as its text, or its length past 64 bytes. */
export function fakeSink() {
	const calls = [];
	const done = { ok: true, value: undefined };
	return {
		calls,
		async put(path, body) {
			calls.push(["put", path, body.length > 64 ? `${body.length} bytes` : Buffer.from(body).toString()]);
			return done;
		},
		async mkdir(path) {
			calls.push(["mkdir", path]);
			return done;
		},
		async remove(path, type) {
			calls.push(["remove", path, type]);
			return done;
		},
		async meta(meta) {
			calls.push(["meta", meta]);
			return done;
		},
	};
}

/** The client with each read of bytes it is asked for recorded, by its path under root. */
function counting(client, root, reads) {
	const under = (path) => path.slice(root.length + 1);
	return {
		call(method, params, options) {
			if (method === "files.read") reads.push(["files.read", under(params.path)]);
			if (method === "tar.pull.begin") reads.push(["tar.pull", under(params.path)]);
			return client.call(method, params, options);
		},
		close() {},
	};
}

const byPath = (a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
const sorted = (calls) => [...calls].sort(byPath);

/**
 * The cases, each in a folder of its own under base: { name, setup, run(folder) }. setup is the shell that makes the
 * folder's state before baseline(); run makes the change and holds what the sink and the reads show.
 */
export const CASES = [
	{
		name: "a write: a changed file and a new one by files.read, a large one by tar.pull, each put once; a re-read of the same bytes puts nothing",
		setup: "printf 'a\\n' > a.txt && head -c 614400 /dev/zero > big.bin && printf 'old\\n' > old.txt",
		async run(folder) {
			await folder.sh("printf 'aa\\n' > a.txt && printf 'new\\n' > b.txt && head -c 614401 /dev/zero > big.bin");
			assert.deepEqual(await folder.sync(10_000), { put: 3, mkdir: 0, removed: 0, meta: false });
			assert.deepEqual(sorted(folder.sink.calls), [
				["put", "a.txt", "aa\n"],
				["put", "b.txt", "new\n"],
				["put", "big.bin", "614401 bytes"],
			]);
			assert.deepEqual(sorted(folder.reads), [
				["files.read", "a.txt"],
				["files.read", "b.txt"],
				["tar.pull", "big.bin"],
			]);
			assert.deepEqual(await folder.sync(10_000), { put: 0, mkdir: 0, removed: 0, meta: false }, "nothing changed");
			assert.deepEqual(await folder.sync(10_000 + RACY_MS), { put: 0, mkdir: 0, removed: 0, meta: false }, "the racy re-read finds the same bytes");
			assert.equal(folder.sink.calls.length, 3, "each change landed once");
			const after = folder.reads.length;
			await folder.sync(20_000);
			assert.equal(folder.reads.length, after, "settled: nothing read again");
		},
	},
	{
		name: "a move: the file put at its new path before it is removed from its old, each once",
		setup: "printf 'a\\n' > a.txt && mkdir keep && printf 'k\\n' > keep/k",
		async run(folder) {
			await folder.sh("mkdir b && mv a.txt b/a.txt && mv keep/k keep/k2");
			assert.deepEqual(await folder.sync(10_000), { put: 2, mkdir: 0, removed: 2, meta: false });
			assert.deepEqual(sorted(folder.sink.calls), [
				["put", "b/a.txt", "a\n"],
				["put", "keep/k2", "k\n"],
				["remove", "a.txt", "file"],
				["remove", "keep/k", "file"],
			]);
			const at = (op, path) => folder.sink.calls.findIndex((call) => call[0] === op && call[1] === path);
			assert.ok(at("put", "b/a.txt") < at("remove", "a.txt") && at("put", "keep/k2") < at("remove", "keep/k"), JSON.stringify(folder.sink.calls));
			assert.deepEqual(sorted(folder.reads), [
				["files.read", "keep/k2"],
				["tar.pull", "b"],
			]);
			assert.deepEqual(await folder.sync(10_000), { put: 0, mkdir: 0, removed: 0, meta: false });
		},
	},
	{
		name: "rm -rf: every file and directory under it removed once, deepest first, nothing read",
		setup: "mkdir -p d/e/f && printf x > d/x && printf y > d/e/y && printf t > t",
		async run(folder) {
			await folder.sh("rm -rf d");
			assert.deepEqual(await folder.sync(10_000), { put: 0, mkdir: 0, removed: 5, meta: false });
			assert.deepEqual(folder.sink.calls, [
				["remove", "d/e/f", "dir"],
				["remove", "d/e/y", "file"],
				["remove", "d/e", "dir"],
				["remove", "d/x", "file"],
				["remove", "d", "dir"],
			]);
			assert.deepEqual(folder.reads, []);
			assert.deepEqual(await folder.sync(10_000), { put: 0, mkdir: 0, removed: 0, meta: false });
		},
	},
	{
		name: "chmod: the folder's modes written once, no bytes read; back to the default, written once more",
		setup: "printf x > a.sh && mkdir bin",
		async run(folder) {
			await folder.sh("chmod 0755 a.sh && chmod 0700 bin");
			assert.deepEqual(await folder.sync(10_000), { put: 0, mkdir: 0, removed: 0, meta: true });
			assert.deepEqual(folder.sink.calls, [["meta", { modes: { "a.sh": 0o755, bin: 0o700 }, links: {} }]]);
			assert.deepEqual(folder.reads, []);
			assert.deepEqual(await folder.sync(10_000), { put: 0, mkdir: 0, removed: 0, meta: false });
			await folder.sh("chmod 0644 a.sh && chmod 0755 bin");
			assert.deepEqual(await folder.sync(10_000), { put: 0, mkdir: 0, removed: 0, meta: true });
			assert.deepEqual(folder.sink.calls[1], ["meta", { modes: {}, links: {} }]);
		},
	},
	{
		name: "a symlink: its target, as written, in the folder's links once, never followed; removed, gone from them",
		setup: "printf a > a.txt",
		async run(folder) {
			await folder.sh("ln -s a.txt l && ln -s ../outside up");
			assert.deepEqual(await folder.sync(10_000), { put: 0, mkdir: 0, removed: 0, meta: true });
			assert.deepEqual(folder.sink.calls, [["meta", { modes: {}, links: { l: "a.txt", up: "../outside" } }]]);
			assert.deepEqual(folder.reads, []);
			await folder.sh("rm l");
			assert.deepEqual(await folder.sync(10_000), { put: 0, mkdir: 0, removed: 0, meta: true });
			assert.deepEqual(folder.sink.calls, [
				["meta", { modes: {}, links: { l: "a.txt", up: "../outside" } }],
				["meta", { modes: {}, links: { up: "../outside" } }],
			]);
		},
	},
	{
		name: "a same-ms same-size rewrite: not seen within 1 s of the listing that found the file racy, put once at the first sync 1 s after",
		setup: "true",
		async run(folder) {
			await folder.sh("printf aaaa > f");
			assert.deepEqual(await folder.sync(10_000), { put: 1, mkdir: 0, removed: 0, meta: false });
			// The same size and mtime as the listing read: the rewrite of a file within the clock's tick.
			await folder.sh('touch -r f "$OUT" && printf bbbb > f && touch -r "$OUT" f');
			assert.deepEqual(await folder.sync(10_000 + RACY_MS / 2), { put: 0, mkdir: 0, removed: 0, meta: false }, "not due yet");
			assert.deepEqual(await folder.sync(10_000 + RACY_MS), { put: 1, mkdir: 0, removed: 0, meta: false });
			assert.deepEqual(await folder.sync(20_000), { put: 0, mkdir: 0, removed: 0, meta: false });
			assert.deepEqual(folder.sink.calls, [
				["put", "f", "aaaa"],
				["put", "f", "bbbb"],
			]);
		},
	},
	{
		name: "a same-size rewrite in a push's own clock tick: put at the next sync; the pushed files that did not change are never read",
		setup: "true",
		async run(folder) {
			const file = (name, text) => ({ name, type: "file", mode: 0o644, body: Buffer.from(text) });
			await folder.push([file("f", "aaaa"), file("keep", "k"), { name: "d", type: "dir", mode: 0o755 }, file("d/g", "g")]);
			// The mtime a coarse clock (a jiffy) gives a write in the push's own tick: the ctime its extraction left on f.
			await folder.sh('t="$(stat -c %z f)" && printf bbbb > f && touch -d "$t" f');
			assert.deepEqual(await folder.sync(10_000), { put: 1, mkdir: 0, removed: 0, meta: false }, "the rewrite, seen");
			assert.deepEqual(await folder.sync(10_000 + RACY_MS), { put: 0, mkdir: 0, removed: 0, meta: false }, "the racy re-read finds the same bytes");
			assert.deepEqual(folder.sink.calls, [["put", "f", "bbbb"]]);
			assert.deepEqual(folder.reads, [["files.read", "f"], ["files.read", "f"]], "f and its racy re-read; keep and d/g, as pushed, are never read");
		},
	},
	{
		name: "a new tree: pulled as one tar, each file put once, an empty directory in it made once",
		setup: "printf t > top",
		async run(folder) {
			await folder.sh("mkdir -p n/a/b n/e && printf 1 > n/1 && printf 2 > n/a/2 && printf 3 > n/a/b/3");
			assert.deepEqual(await folder.sync(10_000), { put: 3, mkdir: 1, removed: 0, meta: false });
			assert.deepEqual(sorted(folder.sink.calls), [
				["mkdir", "n/e"],
				["put", "n/1", "1"],
				["put", "n/a/2", "2"],
				["put", "n/a/b/3", "3"],
			]);
			assert.deepEqual(folder.reads, [["tar.pull", "n"]]);
			assert.deepEqual(await folder.sync(10_000), { put: 0, mkdir: 0, removed: 0, meta: false });
		},
	},
	{
		// computerd runs under umask 077 where init on the exec path does (sync-folder.test.mjs starts it so): a mode the
		// extraction took from the umask would be recorded as the folder's own and written to the sink with the next change.
		name: "a push under any umask: a directory the tar names gets its own mode and one only a file's path names gets 0755, so the modes recorded are the user's alone",
		setup: "true",
		async run(folder) {
			const file = (name, text) => ({ name, type: "file", mode: 0o644, body: Buffer.from(text) });
			// The runner's push names every directory (synced-folder.ts); a push may also name a file alone.
			await folder.push([{ name: "named", type: "dir", mode: 0o755 }, file("named/a", "a"), { name: "private", type: "dir", mode: 0o700 }, file("unnamed/deep/b", "b")]);
			await folder.sh("chmod 0600 named/a");
			assert.deepEqual(await folder.sync(10_000), { put: 0, mkdir: 0, removed: 0, meta: true });
			assert.deepEqual(folder.sink.calls, [["meta", { modes: { "named/a": 0o600, private: 0o700 }, links: {} }]]);
		},
	},
];

/**
 * One case's folder under base through client: the shell its setup is (exec.run, in the folder, umask 022 so its modes
 * are the defaults, OUT a path outside it),
 * then a FolderSync on a fake sink with its baseline taken; sync(now) syncs at the runner's time now and answers counts.
 */
export async function folderOf(client, base, name, setup) {
	const root = `${base}/${name}`;
	const sh = async (script) => {
		const ran = await client.call("exec.run", { argv: ["sh", "-c", `umask 022 && cd "$1" && ${script}`, "sh", root], env: { OUT: `${root}.out` }, timeoutMs: 30_000 });
		assert.equal(ran.ok, true, JSON.stringify(ran));
		const words = `${Buffer.from(ran.value.stdout, "base64")}${Buffer.from(ran.value.stderr, "base64")}`;
		assert.equal(ran.value.exitCode, 0, `${script}: ${words}`);
	};
	const made = await client.call("exec.run", { argv: ["sh", "-c", 'rm -rf "$1" && mkdir -p "$1" && chmod 0755 "$1"', "sh", root], timeoutMs: 30_000 });
	assert.equal(made.ok && made.value.exitCode, 0, JSON.stringify(made));
	await sh(setup);
	const sink = fakeSink();
	const reads = [];
	let clock = 0;
	const engine = new FolderSync(counting(client, root, reads), sink, { root, now: () => clock });
	const baseline = await engine.baseline();
	assert.equal(baseline.ok, true, JSON.stringify(baseline));
	return {
		sh,
		sink,
		reads,
		/** `entries` pushed into the folder as a runner pushes them (FolderSync.push), its baseline taken again. */
		async push(entries) {
			const pushed = await engine.push(entries);
			assert.equal(pushed.ok, true, JSON.stringify(pushed));
		},
		async sync(now) {
			clock = now;
			const synced = await engine.sync();
			assert.equal(synced.ok, true, JSON.stringify(synced));
			return synced.value;
		},
	};
}
