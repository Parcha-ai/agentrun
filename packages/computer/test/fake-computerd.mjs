// A fake computerd for the fake docker (fake-docker.mjs, with its `computerd` option): the daemon's file, exec and process
// calls, over the protocol the real daemon speaks (protocol.ts), run on this machine in a temp folder, so a run in a Docker
// computer does its work with no Docker and no daemon binary. Run as `node fake-computerd.mjs <socket> <json>`, it is the
// computer's init: it listens on the unix socket (as `computerd init` does) and the fake docker's `exec ... computerd stdio`
// bridges a client to it, so a process started on one connection is there on the next, as in a real computer.
//
// What it stands for, and where it is not the real daemon: a path in the computer is the folder a mount binds there
// (/workspace is the run's folder), else a folder of the computer's own under `root`; a path inside an argv or a script that
// names a mount's target is mapped the same way (as the fake docker's own `exec` maps it); programs run as this user with
// a minimal environment (PATH, HOME, USER, LOGNAME, then the call's), never as the computer's user, with no no_new_privs,
// no capability drop and no fence; no pty, no tar calls, no desktop methods (each answers `unsupported`). It ends, with
// every process it started, at SIGTERM or once its socket is gone (the host's temp folder removed).
import { spawn } from "node:child_process";
import { chmodSync, constants, existsSync, mkdirSync, promises as fs, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_CHUNK_BYTES, MAX_LIST_DEPTH, MAX_LIST_ENTRIES, MAX_OUTPUT_BYTES, MAX_READ_WAIT_MS } from "../dist/protocol.js";

const fail = (kind, message) => Object.assign(new Error(message), { kind });
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const KINDS = { ENOENT: "not_found", EACCES: "denied", EPERM: "denied", EROFS: "denied", EEXIST: "exists", ENOTDIR: "not_dir", EISDIR: "is_dir", ENOSPC: "limit", EFBIG: "limit", EXDEV: "unsupported" };
/** An error from the file system, as the protocol's kind with the error's own words. */
const fsError = (error) => (error.kind ? error : fail(KINDS[error.code] ?? "invalid", error.message));
const SIGNALS = { TERM: "SIGTERM", INT: "SIGINT", KILL: "SIGKILL", HUP: "SIGHUP" };
const NAME = (signal) => (signal ? signal.replace(/^SIG/, "") : null);

/**
 * One computer's calls: `mounts` are [{ src, dst }] (a host folder and where the computer has it), `root` a host folder for
 * every other path, `env` the computer's own environment (HOME at least). Returns { handle(method, params, signal), close() }.
 */
export function computerd({ mounts, root, env = {} }) {
	const own = ["/work", "/tmp", "/home"].map((dst) => ({ src: join(root, dst), dst }));
	const all = [...mounts, ...own.filter((one) => !mounts.some((mount) => mount.dst === one.dst))].sort((a, b) => b.dst.length - a.dst.length);
	for (const { src } of own) mkdirSync(src, { recursive: true });
	/** The host's path for a path in the computer. */
	const host = (path) => {
		const at = all.find((mount) => path === mount.dst || path.startsWith(`${mount.dst}/`));
		return at ? join(at.src, path.slice(at.dst.length)) : join(root, path);
	};
	const clean = (field, path) => {
		if (typeof path !== "string" || !isAbsolute(path)) throw fail("invalid", `${field} must be an absolute path, not ${JSON.stringify(path)}`);
		if (path.includes("\0")) throw fail("invalid", `${field} has a NUL byte`);
		return normalize(path).replace(/(.)\/$/, "$1");
	};
	const pathOf = (field, path) => host(clean(field, path));
	// A mount's target inside a program's argument or script is the host's folder, in one pass (no replacement is scanned again).
	const targets = new RegExp(`(?<![\\w./-])(${all.map((mount) => escape(mount.dst)).join("|")})(?![\\w.-])`, "g");
	const mapText = (text) => text.replace(targets, (found) => all.find((mount) => mount.dst === found).src);
	const environment = (given = {}) => {
		const base = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: env.HOME ?? "/work", USER: "agentrun-tool", LOGNAME: "agentrun-tool" };
		const made = { ...base, ...env, ...given };
		return Object.fromEntries(Object.entries(made).map(([name, value]) => [name, name === "HOME" ? host(String(value)) : mapText(String(value))]));
	};
	const argvOf = (argv) => {
		if (!Array.isArray(argv) || argv.length === 0 || argv.some((arg) => typeof arg !== "string")) throw fail("invalid", "argv must be a program and its arguments");
		return argv.map(mapText);
	};
	const start = (params, options) => {
		const argv = argvOf(params.argv);
		const child = spawn(argv[0], argv.slice(1), { cwd: params.cwd === undefined ? host(env.HOME ?? "/work") : params.cwd.startsWith("/") ? pathOf("cwd", params.cwd) : join(host(env.HOME ?? "/work"), params.cwd), env: environment(params.env), detached: true, stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"] });
		const spawned = new Promise((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", (error) => reject(fail(error.code === "ENOENT" ? "not_found" : error.code === "EACCES" ? "denied" : "invalid", `${params.argv[0]}: ${error.message}`)));
		});
		return { child, spawned };
	};
	const killGroup = (child, signal) => {
		try {
			process.kill(-child.pid, signal);
		} catch {
			// Gone already.
		}
	};

	const table = new Map();
	const everyChild = new Set();
	let nextId = 1;
	/** Resolvers of a wait on a process's output or end. */
	const wake = (entry) => {
		for (const resolve of entry.waiters.splice(0)) resolve();
	};
	const waitFor = (entry, ms, signal) =>
		new Promise((resolve) => {
			const timer = setTimeout(done, ms);
			function done() {
				clearTimeout(timer);
				signal?.removeEventListener("abort", done);
				const at = entry.waiters.indexOf(done);
				if (at >= 0) entry.waiters.splice(at, 1);
				resolve();
			}
			entry.waiters.push(done);
			signal?.addEventListener("abort", done, { once: true });
		});
	const info = (entry) => ({ id: entry.id, pid: entry.child.pid, argv: entry.argv.slice(0, 16), argvClipped: entry.argv.length > 16, pty: false, startedAt: entry.startedAt, endedAt: entry.endedAt, running: !entry.ended, exitCode: entry.ended ? entry.exitCode : null, signal: entry.ended ? entry.signal : null });

	const methods = {
		ping: () => ({}),
		"exec.run": async (params) => {
			const { child, spawned } = start(params, {});
			everyChild.add(child);
			const keep = Math.min(params.maxOutput ?? MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
			const out = { stdout: [], stderr: [] };
			const sizes = { stdout: 0, stderr: 0 };
			let truncated = false;
			for (const name of ["stdout", "stderr"]) {
				child[name].on("data", (chunk) => {
					const room = Math.max(0, keep - sizes[name]);
					if (chunk.length > room) truncated = true;
					out[name].push(chunk.subarray(0, room));
					sizes[name] += Math.min(room, chunk.length);
				});
			}
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				killGroup(child, "SIGKILL");
			}, params.timeoutMs);
			const ended = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
			try {
				await spawned;
			} catch (error) {
				clearTimeout(timer);
				everyChild.delete(child);
				throw error;
			}
			const { code, signal } = await ended;
			clearTimeout(timer);
			everyChild.delete(child);
			return { exitCode: code, ...(signal ? { signal: NAME(signal) } : {}), stdout: Buffer.concat(out.stdout).toString("base64"), stderr: Buffer.concat(out.stderr).toString("base64"), timedOut, truncated };
		},

		"files.stat": async ({ path, follow }) => {
			const real = pathOf("path", path);
			try {
				return entryOf(real, follow ? await fs.stat(real) : await fs.lstat(real));
			} catch (error) {
				throw fsError(error);
			}
		},
		"files.read": async ({ path, offset = 0, length = MAX_CHUNK_BYTES }) => {
			const real = pathOf("path", path);
			if (offset < 0) throw fail("invalid", "offset must be 0 or more");
			if (length < 1) throw fail("invalid", "length must be 1 or more");
			if (length > MAX_CHUNK_BYTES) throw fail("limit", `a files.read returns at most ${MAX_CHUNK_BYTES} bytes: read again from offset + the bytes read`);
			let file;
			try {
				file = await fs.open(real, constants.O_RDONLY | constants.O_NONBLOCK);
				const stat = await file.stat();
				const { size } = stat;
				if (!stat.isFile()) throw Object.assign(new Error(`${path} is not a regular file`), { code: stat.isDirectory() ? "EISDIR" : "EINVAL" });
				const data = Buffer.alloc(length);
				const { bytesRead } = await file.read(data, 0, length, offset);
				return { data: data.subarray(0, bytesRead).toString("base64"), eof: bytesRead < length || offset + bytesRead >= size, size };
			} catch (error) {
				throw fsError(error);
			} finally {
				await file?.close();
			}
		},
		"files.write": async ({ path, data, offset, append, mode, parents }) => {
			const real = pathOf("path", path);
			if (offset !== undefined && append) throw fail("invalid", "offset and append cannot both be given");
			if (offset !== undefined && offset < 0) throw fail("invalid", "offset must be 0 or more");
			if (mode !== undefined && mode > 0o7777) throw fail("invalid", `mode ${mode.toString(8)} has bits beyond 07777`);
			const bytes = Buffer.from(typeof data === "string" ? data : "", "base64");
			try {
				if (parents) await fs.mkdir(dirname(real), { recursive: true });
				const existed = existsSync(real);
				const flags = constants.O_WRONLY | constants.O_CREAT | (append ? constants.O_APPEND : offset === undefined ? constants.O_TRUNC : 0);
				const file = await fs.open(real, flags, mode === undefined ? 0o644 : mode & 0o777);
				try {
					if ((await file.stat()).isDirectory()) throw Object.assign(new Error(`${path} is a directory`), { code: "EISDIR" });
					if (append || offset === undefined) await file.write(bytes);
					else await file.write(bytes, 0, bytes.length, offset);
					if (!existed || mode !== undefined) await file.chmod(mode === undefined ? 0o644 : mode);
					return { size: (await file.stat()).size };
				} finally {
					await file.close();
				}
			} catch (error) {
				throw fsError(error);
			}
		},
		"files.mkdir": async ({ path, parents, mode }) => {
			const real = pathOf("path", path);
			try {
				if (parents) await fs.mkdir(real, { recursive: true, mode: mode ?? 0o755 });
				else await fs.mkdir(real, { mode: mode ?? 0o755 });
				chmodSync(real, mode ?? 0o755);
				return {};
			} catch (error) {
				throw fsError(error);
			}
		},
		"files.move": async ({ from, to, overwrite }) => {
			const source = pathOf("from", from);
			const target = pathOf("to", to);
			try {
				await fs.lstat(source);
				if (!overwrite && (await fs.lstat(target).then(() => true, () => false))) throw Object.assign(new Error(`${to} exists`), { code: "EEXIST" });
				await fs.rename(source, target);
				return {};
			} catch (error) {
				throw fsError(error);
			}
		},
		"files.remove": async ({ path, recursive }) => {
			const real = pathOf("path", path);
			try {
				const stat = await fs.lstat(real);
				if (stat.isDirectory() && !recursive) await fs.rmdir(real);
				else await fs.rm(real, { recursive: Boolean(recursive), force: false });
				return {};
			} catch (error) {
				throw fsError(error.code === "ENOTEMPTY" ? Object.assign(error, { code: "EINVAL" }) : error);
			}
		},
		"files.list": async ({ path, depth = 1, offset = 0 }) => {
			const given = clean("path", path);
			if (depth < 1 || depth > MAX_LIST_DEPTH) throw fail("invalid", `depth must be from 1 to ${MAX_LIST_DEPTH}`);
			if (offset < 0) throw fail("invalid", "offset must be 0 or more");
			let top;
			try {
				top = await fs.realpath(host(given));
				if (!(await fs.stat(top)).isDirectory()) throw fail("not_dir", `${given} is not a directory`);
			} catch (error) {
				throw fsError(error);
			}
			const entries = [];
			let skipped = 0;
			let full = false;
			const walk = async (dir, level) => {
				const names = (await fs.readdir(dir)).sort();
				for (const name of names) {
					if (full) return;
					const real = join(dir, name);
					let stat;
					try {
						stat = await fs.lstat(real);
					} catch {
						continue;
					}
					if (skipped < offset) skipped++;
					else if (entries.length === MAX_LIST_ENTRIES) {
						full = true;
						return;
					} else entries.push({ path: join(given, relative(top, real)), ...entryOf(real, stat) });
					if (stat.isDirectory() && level < depth) await walk(real, level + 1).catch(() => {});
				}
			};
			await walk(top, 1);
			return { entries, truncated: full };
		},

		"process.start": async (params) => {
			if (params.pty !== undefined) throw fail("unsupported", "the fake computer has no terminal");
			if (table.size >= 256) throw fail("limit", "too many processes");
			let logPath;
			if (params.log !== undefined) {
				logPath = pathOf("log", params.log);
				if (existsSync(logPath)) throw fail("exists", `${params.log} exists`);
			}
			// The log exists before the program starts, and every listener is on the child before this call yields again: a program
			// that ends at once, or is not there, is seen as it is.
			if (logPath !== undefined) {
				await fs.mkdir(dirname(logPath), { recursive: true });
				await fs.writeFile(logPath, "", { mode: 0o644, flag: "wx" });
			}
			const { child, spawned } = start(params, { stdin: params.stdin === true });
			spawned.catch(() => {});
			const entry = { id: `p${nextId++}`, child, argv: params.argv, startedAt: Date.now(), endedAt: null, ended: false, exitCode: null, signal: null, streams: { stdout: [], stderr: [], log: [] }, sizes: { stdout: 0, stderr: 0, log: 0 }, waiters: [], keep: params.orphans === "keep" };
			table.set(entry.id, entry);
			everyChild.add(child);
			// Log writes go in order, and the end is reported once they are written (as the real daemon writes the log before waking readers).
			let writing = Promise.resolve();
			for (const name of ["stdout", "stderr"]) {
				child[name].on("data", (chunk) => {
					for (const stream of [name, "log"]) {
						entry.streams[stream].push(chunk);
						entry.sizes[stream] += chunk.length;
					}
					if (logPath !== undefined) writing = writing.then(() => fs.appendFile(logPath, chunk)).catch(() => {});
					wake(entry);
				});
			}
			let status;
			const finish = () => {
				if (entry.ended || status === undefined) return;
				void writing.then(() => {
					if (entry.ended) return;
					entry.ended = true;
					entry.endedAt = Date.now();
					entry.exitCode = status.code;
					entry.signal = NAME(status.signal);
					everyChild.delete(child);
					wake(entry);
				});
			};
			// The program's own exit ends the process: what it left running is killed unless orphans are kept, and a leftover
			// holding the output pipes does not keep the program "running". Its output is read to the end, on close, first.
			child.once("exit", (code, signal) => {
				status = { code, signal };
				if (!entry.keep) killGroup(child, "SIGKILL");
				else finish();
			});
			child.once("close", () => finish());
			await spawned.catch((error) => {
				table.delete(entry.id);
				everyChild.delete(child);
				throw error;
			});
			return { id: entry.id, pid: child.pid };
		},
		"process.read": async ({ id, stream, offset = 0, maxBytes = MAX_CHUNK_BYTES, waitMs = 0 }, signal) => {
			const entry = table.get(id);
			if (!entry) throw fail("not_found", `no process ${id}`);
			if (!(stream in entry.streams)) throw fail("invalid", `process ${id} has no ${stream} stream`);
			if (maxBytes > MAX_CHUNK_BYTES) throw fail("limit", `a process.read returns at most ${MAX_CHUNK_BYTES} bytes`);
			if (offset >= entry.sizes[stream] && !entry.ended && waitMs > 0) await waitFor(entry, Math.min(waitMs, MAX_READ_WAIT_MS), signal);
			const bytes = Buffer.concat(entry.streams[stream]).subarray(offset, offset + maxBytes);
			const nextOffset = offset + bytes.length;
			return { data: bytes.toString("base64"), nextOffset, dropped: 0, exited: entry.ended && nextOffset >= entry.sizes[stream], size: entry.sizes[stream] };
		},
		"process.write": async ({ id, data, close }) => {
			const entry = table.get(id);
			if (!entry) throw fail("not_found", `no process ${id}`);
			const stdin = entry.child.stdin;
			if (!stdin) throw fail("invalid", `process ${id} was not started with stdin`);
			if (data) await new Promise((resolve, reject) => stdin.write(Buffer.from(data, "base64"), (error) => (error ? reject(fail("invalid", error.message)) : resolve())));
			if (close) stdin.end();
			return {};
		},
		"process.signal": async ({ id, signal }) => {
			const entry = table.get(id);
			if (!entry) throw fail("not_found", `no process ${id}`);
			if (!SIGNALS[signal]) throw fail("invalid", `no signal ${signal}`);
			if (!entry.ended) killGroup(entry.child, SIGNALS[signal]);
			return {};
		},
		"process.wait": async ({ id, timeoutMs }, signal) => {
			const entry = table.get(id);
			if (!entry) throw fail("not_found", `no process ${id}`);
			// Output wakes a waiter too: wait again until the end, the deadline or a cancel.
			const until = Date.now() + Math.min(timeoutMs, 86_400_000);
			while (!entry.ended && !signal?.aborted && Date.now() < until) await waitFor(entry, until - Date.now(), signal);
			return { running: !entry.ended, exitCode: entry.ended ? entry.exitCode : null, signal: entry.ended ? entry.signal : null };
		},
		"process.list": async ({ from = 0 } = {}) => {
			const entries = [...table.values()].slice(from);
			return { processes: entries.map(info), truncated: false, next: from + entries.length };
		},
	};

	return {
		async handle(method, params, signal) {
			const call = methods[method];
			if (!call) throw Object.assign(new Error(`the fake computer has no ${method}`), { code: -32601 });
			return call(params ?? {}, signal);
		},
		close() {
			for (const child of everyChild) killGroup(child, "SIGKILL");
		},
	};
}

/** What files.stat answers, from an fs.Stats. */
function entryOf(real, stat) {
	const type = stat.isFile() ? "file" : stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "symlink" : "other";
	return { type, size: stat.size, mode: stat.mode & 0o7777, mtimeMs: Math.trunc(stat.mtimeMs), uid: stat.uid, gid: stat.gid, ...(type === "symlink" ? { target: readlinkSync(real) } : {}) };
}

/** The computer's init: listens on `socket`, a line of JSON-RPC at a time, each call answered as the real daemon answers. */
function serve(socket, config) {
	const computer = computerd(config);
	const server = createServer((connection) => {
		// Request ids are numbered per connection (each client starts at 1), so what a cancel may reach is this connection's.
		const aborts = new Map();
		let buffered = "";
		connection.on("error", () => {});
		connection.on("data", (chunk) => {
			buffered += chunk;
			for (let at; (at = buffered.indexOf("\n")) >= 0; ) {
				const line = buffered.slice(0, at);
				buffered = buffered.slice(at + 1);
				if (line.trim() !== "") void answer(connection, aborts, JSON.parse(line));
			}
		});
	});
	async function answer(connection, aborts, request) {
		if (request.method === "$/cancelRequest") return void aborts.get(`${request.params?.id}`)?.abort();
		const abort = new AbortController();
		aborts.set(`${request.id}`, abort);
		const reply = (body) => connection.writable && connection.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...body })}\n`);
		try {
			const result = await computer.handle(request.method, request.params, abort.signal);
			if (abort.signal.aborted) reply({ error: { code: -32800, message: "the request was cancelled", data: { kind: "aborted" } } });
			else reply({ result });
		} catch (error) {
			reply({ error: { code: error.code === -32601 ? -32601 : -32000, message: error.message, ...(error.kind ? { data: { kind: error.kind } } : {}) } });
		} finally {
			aborts.delete(`${request.id}`);
		}
	}
	const end = () => {
		computer.close();
		server.close();
		rmSync(socket, { force: true });
		rmSync(`${socket}.ready`, { force: true });
		process.exit(0);
	};
	process.on("SIGTERM", end);
	process.on("SIGINT", end);
	server.listen(socket, () => {
		writeFileSync(`${socket}.ready`, "");
		// The host's temp folder holding the socket is removed when the test ends: nothing outlives it.
		setInterval(() => existsSync(socket) || end(), 500);
	});
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) serve(process.argv[2], JSON.parse(process.argv[3]));
