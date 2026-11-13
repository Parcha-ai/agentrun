// The fake computerd (fake-computerd.mjs) answers the daemon's exec, file and process calls as the protocol says, in a temp
// folder: what the serve tests' box runs depend on.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { computerd } from "./fake-computerd.mjs";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function computer() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "fake-computerd-")));
	dirs.push(root);
	const folder = join(root, "run");
	mkdirSync(folder);
	const made = computerd({ mounts: [{ src: folder, dst: "/workspace" }], root: join(root, "own"), env: { HOME: "/work" } });
	return { ...made, folder, call: (method, params) => made.handle(method, params) };
}
const b64 = (text) => Buffer.from(text).toString("base64");
const kindOf = async (promise) => promise.then(() => undefined, (error) => error.kind);

test("files: /workspace is the run's folder; write, read, stat, list, move and remove answer as the daemon does", async () => {
	const c = computer();
	assert.deepEqual(await c.call("files.write", { path: "/workspace/a/b.txt", data: b64("hello"), parents: true }), { size: 5 });
	assert.equal(readFileSync(join(c.folder, "a/b.txt"), "utf8"), "hello");
	assert.deepEqual(await c.call("files.read", { path: "/workspace/a/b.txt", offset: 1, length: 2 }), { data: b64("el"), eof: false, size: 5 });
	assert.equal((await c.call("files.read", { path: "/workspace/a/b.txt" })).eof, true);
	assert.deepEqual(await c.call("files.write", { path: "/workspace/a/b.txt", data: b64("!"), append: true }), { size: 6 });
	const stat = await c.call("files.stat", { path: "/workspace/a/b.txt" });
	assert.deepEqual([stat.type, stat.size, stat.mode], ["file", 6, 0o644]);
	assert.deepEqual((await c.call("files.list", { path: "/workspace", depth: 2 })).entries.map((entry) => [entry.path, entry.type]), [["/workspace/a", "dir"], ["/workspace/a/b.txt", "file"]]);
	await c.call("files.move", { from: "/workspace/a/b.txt", to: "/workspace/c.txt" });
	assert.equal(await kindOf(c.call("files.stat", { path: "/workspace/a/b.txt" })), "not_found");
	await c.call("files.write", { path: "/workspace/d.txt", data: b64("d") });
	assert.equal(await kindOf(c.call("files.move", { from: "/workspace/d.txt", to: "/workspace/c.txt" })), "exists");
	await c.call("files.move", { from: "/workspace/d.txt", to: "/workspace/c.txt", overwrite: true });
	assert.equal(readFileSync(join(c.folder, "c.txt"), "utf8"), "d");
	assert.equal(await kindOf(c.call("files.read", { path: "/workspace/a" })), "is_dir");
	assert.equal(await kindOf(c.call("files.stat", { path: "workspace" })), "invalid");
	await c.call("files.remove", { path: "/workspace/a", recursive: true });
	assert.equal(await kindOf(c.call("files.stat", { path: "/workspace/a" })), "not_found");
	c.close();
});

test("exec.run runs in the computer's folders with a minimal environment; process.start's output is read by offset, and its end waited for", async () => {
	const c = computer();
	const ran = await c.call("exec.run", { argv: ["sh", "-c", "printf '%s:%s' \"$HOME\" \"$(pwd)\" > out.txt; echo out; echo err >&2; exit 3"], cwd: "/workspace", timeoutMs: 10_000 });
	assert.deepEqual([ran.exitCode, Buffer.from(ran.stdout, "base64").toString(), Buffer.from(ran.stderr, "base64").toString(), ran.timedOut], [3, "out\n", "err\n", false]);
	assert.equal(readFileSync(join(c.folder, "out.txt"), "utf8").endsWith(`:${c.folder}`), true, "pwd is the folder /workspace is");
	const slow = await c.call("exec.run", { argv: ["sleep", "30"], timeoutMs: 100 });
	assert.deepEqual([slow.timedOut, slow.exitCode, slow.signal], [true, null, "KILL"]);
	const started = await c.call("process.start", { argv: ["sh", "-c", "echo one; sleep 0.2; echo two"], cwd: "/workspace", log: "/workspace/background/1/log" });
	const first = await c.call("process.read", { id: started.id, stream: "stdout", offset: 0, waitMs: 5000 });
	assert.equal(Buffer.from(first.data, "base64").toString().startsWith("one"), true);
	assert.deepEqual(await c.call("process.wait", { id: started.id, timeoutMs: 5000 }), { running: false, exitCode: 0, signal: null });
	const rest = await c.call("process.read", { id: started.id, stream: "stdout", offset: first.nextOffset });
	assert.deepEqual([Buffer.from(rest.data, "base64").toString(), rest.exited], ["one\ntwo\n".slice(first.nextOffset), true]);
	assert.equal(readFileSync(join(c.folder, "background/1/log"), "utf8"), "one\ntwo\n");
	assert.equal(await kindOf(c.call("process.start", { argv: ["sh"], log: "/workspace/background/1/log" })), "exists");
	assert.equal(await kindOf(c.call("process.read", { id: "p99", stream: "stdout", offset: 0 })), "not_found");
	assert.equal(await kindOf(c.call("exec.run", { argv: ["no-such-program-here"], timeoutMs: 1000 })), "not_found");
	c.close();
});
