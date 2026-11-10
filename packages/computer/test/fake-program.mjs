// A fake CLI for a test, run in the test's own process: the provider execs a real program at `path` (the Go client in
// fake-program-client.go, built once per machine and source, or a Node client where there is no Go), and the client
// hands its argv, pid and stdin to the program's body here over a unix socket named by a hash of path (socketOf), then gives back its
// stdout, stderr and exit code. The exec, the argv, the pipes and the exit code stay real; only the Node start per call
// is gone, which made the Docker tests half the package's unit time.
//
// The body is the script a fake used to write as its own Node program, run unchanged: `process` (argv, pid, stdin,
// stdout, stderr, exit, exitCode) and `require` are the call's, and its timers belong to the call. As in a process, the
// call ends at process.exit, or once the body returned with no timer and no stdin listener left; a call whose client is
// killed ends then, and nothing of it runs after.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const SOURCE = fileURLToPath(new URL("./fake-program-client.go", import.meta.url));

/** The Node client: the Go client's protocol, for a machine with no Go (slower: a Node start per call). */
const NODE_CLIENT = `
const net = require("node:net");
const name = "agentrun-fake-" + require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0, 32);
const conn = net.connect(process.platform === "linux" ? "\\0" + name : "/tmp/" + name + ".sock");
conn.write(JSON.stringify({ argv: process.argv.slice(2), pid: process.pid }) + "\\n");
const frame = (kind, data) => { const head = Buffer.alloc(5); head[0] = kind; head.writeUInt32BE(data.length, 1); return Buffer.concat([head, data]); };
process.stdin.on("data", (data) => conn.write(frame(0, data)));
process.stdin.on("end", () => conn.write(frame(1, Buffer.alloc(0))));
process.stdin.on("error", () => {});
let buffer = Buffer.alloc(0);
conn.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	while (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt32BE(1)) {
		const kind = buffer[0];
		const body = buffer.subarray(5, 5 + buffer.readUInt32BE(1));
		buffer = buffer.subarray(5 + body.length);
		if (kind === 1) process.stdout.write(body);
		else if (kind === 2) process.stderr.write(body);
		else if (kind === 3) process.stdout.write("", () => process.exit(body.readUInt32BE(0)));
	}
});
conn.on("close", () => process.exit(2));
`;

/** The client's path: built once per machine and source into the temp dir, shared by every test file. */
const CLIENT = (() => {
	const dir = join(tmpdir(), `agentrun-fake-program-${createHash("sha256").update(fs.readFileSync(SOURCE)).update(`${process.platform}-${process.arch}`).digest("hex").slice(0, 16)}`);
	const binary = join(dir, "client");
	fs.mkdirSync(dir, { recursive: true });
	if (fs.existsSync(binary)) return binary;
	const building = `${binary}.${process.pid}`;
	try {
		execFileSync("go", ["build", "-o", building, SOURCE], { env: { ...process.env, CGO_ENABLED: "0" }, stdio: "pipe" });
		// Another test file may build it at once: the rename is atomic, and either build is the same program.
		fs.renameSync(building, binary);
		return binary;
	} catch {
		fs.rmSync(building, { force: true });
		const script = join(dir, `client-node-${process.pid}`);
		fs.writeFileSync(script, `#!${process.execPath}\n${NODE_CLIENT}`, { mode: 0o755 });
		after(() => fs.rmSync(script, { force: true }));
		return script;
	}
})();

const servers = [];
after(() => {
	for (const server of servers) server.close();
});

/** Thrown by a call's process.exit, so nothing after it runs. */
const EXIT = Symbol("exit");

/**
 * Where the fake program at path takes its calls: a socket whose name is a hash of path, which the client computes from
 * its argv[0] too. On Linux an abstract socket (no file, and no path a long TMPDIR can push past a unix socket's 108
 * bytes); elsewhere a short file in /tmp.
 */
export function socketOf(path) {
	const name = `agentrun-fake-${createHash("sha256").update(path).digest("hex").slice(0, 32)}`;
	return process.platform === "linux" ? `\0${name}` : `/tmp/${name}.sock`;
}

/**
 * Makes `path` a program whose calls run `body` here. `wholeStdin(argv)` says a call reads all of stdin at once
 * (readFileSync(0)): it then starts once stdin has ended. Returns `path`. A fake that cannot listen throws here, in
 * words: a unix socket binds as listen() is called, so its failure is known now, never as an error after the test.
 */
export function fakeProgram(path, body, { wholeStdin = () => false } = {}) {
	const run = new Function("require", "process", "setTimeout", "setInterval", "clearTimeout", "clearInterval", body);
	const at = socketOf(path);
	if (process.platform !== "linux") fs.rmSync(at, { force: true });
	const server = createServer((socket) => call(socket, path, run, wholeStdin));
	let failed;
	server.on("error", (error) => (failed ??= error));
	server.listen(at);
	if (!server.listening) {
		throw new Error(`the fake program ${path} cannot listen at ${JSON.stringify(at)}${failed ? `: ${failed.message}` : ""}`);
	}
	fs.symlinkSync(CLIENT, path);
	server.unref();
	servers.push(server);
	return path;
}

function call(socket, path, run, wholeStdin) {
	socket.unref();
	let header;
	let pending = Buffer.alloc(0);
	let done = false;
	let returned = false;
	let exitCode;
	const timers = new Set();
	const listeners = { data: [], end: [] };
	const stdin = [];
	let stdinEnded = false;
	const send = (kind, data) => {
		if (socket.destroyed) return;
		const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
		const head = Buffer.alloc(5);
		head[0] = kind;
		head.writeUInt32BE(bytes.length, 1);
		socket.write(Buffer.concat([head, bytes]));
	};
	const finish = (code) => {
		if (done) return;
		done = true;
		timers.clear();
		const word = Buffer.alloc(4);
		word.writeUInt32BE(code >>> 0);
		send(3, word);
		socket.end();
	};
	// A process with no timer and no stdin reader left exits, with its exitCode.
	const idle = () => {
		if (!done && returned && timers.size === 0 && listeners.data.length === 0 && listeners.end.length === 0) finish(exitCode ?? 0);
	};
	// Each piece of the body runs as a process's would: process.exit ends the call, a throw exits 1 with its stack.
	const guard = (fn) => {
		if (done) return;
		try {
			fn();
		} catch (error) {
			if (error === EXIT) return;
			send(2, `${error?.stack ?? error}\n`);
			finish(1);
			return;
		}
		idle();
	};
	// A timer of a call that ended clears itself when it next fires, with the API that made it. The call never clears
	// them from outside: a test that mocks setTimeout (node:test's mock.timers) numbers its timers afresh each time it
	// enables them, so an id from an earlier round could name, and clear, a timer of the test's own.
	const timer = (repeat) => (fn, ms, ...rest) => {
		const unset = repeat ? clearInterval : clearTimeout;
		const id = (repeat ? setInterval : setTimeout)(() => {
			if (done) return unset(id);
			if (!repeat) timers.delete(id);
			guard(() => fn(...rest));
		}, ms);
		timers.add(id);
		return id;
	};
	const clear = (id) => {
		clearTimeout(id);
		timers.delete(id);
	};
	const fsForCall = () => ({
		...fs,
		readFileSync: (file, ...rest) => {
			if (file !== 0) return fs.readFileSync(file, ...rest);
			const all = Buffer.concat(stdin);
			const encoding = typeof rest[0] === "string" ? rest[0] : rest[0]?.encoding;
			return encoding ? all.toString(encoding) : all;
		},
	});
	const start = () => {
		const proc = {
			argv: [process.execPath, path, ...header.argv],
			pid: header.pid,
			env: process.env,
			get exitCode() {
				return exitCode;
			},
			set exitCode(code) {
				exitCode = code;
			},
			stdout: { write: (data, ...rest) => (send(1, data), rest.find((r) => typeof r === "function")?.(), true) },
			stderr: { write: (data, ...rest) => (send(2, data), rest.find((r) => typeof r === "function")?.(), true) },
			stdin: {
				on(event, fn) {
					if (event !== "data" && event !== "end") return this;
					listeners[event].push(fn);
					// Bytes or an end that came before the listener reach it on the next turn, as a stream's do.
					if (event === "data" && stdin.length > 0) setImmediate(() => guard(() => stdin.forEach((chunk) => fn(chunk))));
					if (event === "end" && stdinEnded) setImmediate(() => guard(() => fn()));
					return this;
				},
			},
			exit(code = exitCode ?? 0) {
				finish(code);
				throw EXIT;
			},
		};
		const requireForCall = (name) => (name === "node:fs" || name === "fs" ? fsForCall() : require(name));
		guard(() => {
			run(requireForCall, proc, timer(false), timer(true), clear, clear);
			returned = true;
		});
		returned = true;
		idle();
	};
	socket.on("data", (chunk) => {
		pending = Buffer.concat([pending, chunk]);
		if (header === undefined) {
			const at = pending.indexOf(10);
			if (at < 0) return;
			header = JSON.parse(pending.subarray(0, at).toString("utf8"));
			pending = pending.subarray(at + 1);
			if (!wholeStdin(header.argv)) start();
		}
		while (pending.length >= 5 && pending.length >= 5 + pending.readUInt32BE(1)) {
			const kind = pending[0];
			const data = pending.subarray(5, 5 + pending.readUInt32BE(1));
			pending = pending.subarray(5 + data.length);
			if (kind === 0) {
				stdin.push(data);
				for (const fn of [...listeners.data]) guard(() => fn(data));
			} else if (kind === 1 && !stdinEnded) {
				stdinEnded = true;
				if (wholeStdin(header.argv)) start();
				else for (const fn of [...listeners.end]) guard(() => fn());
			}
		}
	});
	// A client killed, or gone, ends its call: none of the program runs after, as none of a killed process does.
	socket.on("close", () => {
		done = true;
		timers.clear();
	});
	socket.on("error", () => undefined);
}
