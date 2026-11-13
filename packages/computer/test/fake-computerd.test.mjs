// The fake computerd (fake-computerd.mjs) answers the daemon's exec, file and process calls as the protocol says, in a temp
// folder: what the serve tests' box runs depend on.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
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

test("process.start: a program that ends at once has its whole log, a missing one is not_found, and a leftover child does not keep the program running", async () => {
	const c = computer();
	for (let i = 0; i < 20; i++) {
		const fast = await c.call("process.start", { argv: ["sh", "-c", "printf last"], cwd: "/workspace", log: `/workspace/fast/${i}/log` });
		assert.deepEqual(await c.call("process.wait", { id: fast.id, timeoutMs: 5000 }), { running: false, exitCode: 0, signal: null });
		assert.equal(readFileSync(join(c.folder, `fast/${i}/log`), "utf8"), "last", "the end is reported after the log is written");
	}
	assert.equal(await kindOf(c.call("process.start", { argv: ["no-such-program-here"], log: "/workspace/missing/log" })), "not_found");
	const left = await c.call("process.start", { argv: ["sh", "-c", "sleep 30 & exit 0"], cwd: "/workspace" });
	const began = Date.now();
	assert.deepEqual(await c.call("process.wait", { id: left.id, timeoutMs: 10_000 }), { running: false, exitCode: 0, signal: null });
	assert.ok(Date.now() - began < 5000, "the shell's exit ends it, not the sleep's");
	c.close();
});

test("a cancel reaches a request of its own connection, not another connection's with the same id", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "fake-computerd-serve-")));
	dirs.push(root);
	const socket = join(root, "c.sock");
	const init = spawn(process.execPath, [fileURLToPath(new URL("./fake-computerd.mjs", import.meta.url)), socket, JSON.stringify({ mounts: [], root: join(root, "own"), env: { HOME: "/work" } })], { stdio: "ignore" });
	try {
		for (let i = 0; i < 500 && !existsSync(`${socket}.ready`); i++) await new Promise((resolve) => setTimeout(resolve, 10));
		const client = () => {
			const connection = connect(socket);
			const replies = [];
			let buffered = "";
			connection.on("data", (chunk) => {
				buffered += chunk;
				for (let at; (at = buffered.indexOf("\n")) >= 0; ) {
					replies.push(JSON.parse(buffered.slice(0, at)));
					buffered = buffered.slice(at + 1);
				}
			});
			const send = (message) => connection.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
			return { connection, replies, send };
		};
		const a = client();
		const b = client();
		a.send({ id: 1, method: "process.start", params: { argv: ["sleep", "30"] } });
		await new Promise((resolve) => setTimeout(resolve, 300));
		const started = a.replies.find((reply) => reply.id === 1).result;
		a.send({ id: 2, method: "process.wait", params: { id: started.id, timeoutMs: 20_000 } });
		b.send({ id: 2, method: "process.wait", params: { id: started.id, timeoutMs: 20_000 } });
		await new Promise((resolve) => setTimeout(resolve, 300));
		a.send({ method: "$/cancelRequest", params: { id: 2 } });
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.equal(a.replies.find((reply) => reply.id === 2)?.error?.code, -32800, "A's own wait was cancelled");
		assert.equal(b.replies.find((reply) => reply.id === 2), undefined, "B's wait, with the same id, is still waiting");
		a.connection.destroy();
		b.connection.destroy();
	} finally {
		init.kill("SIGTERM");
	}
});
