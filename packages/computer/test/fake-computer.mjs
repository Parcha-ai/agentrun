// A fake provider whose computers are records in memory, each with a fake daemon on an in-memory stream: hello, ping,
// files.mkdir, files.write and files.list over paths in memory, exec.run, which answers id -u, cat /proc/self/status, env and a write to $HOME as a computer would
// and echoes any other argv, and process.start, read, write, wait, signal and list over a table of programs the test
// gives. Every other method is unsupported. No Docker, no daemon.
import { PassThrough } from "node:stream";
import { DaemonClient } from "../dist/index.js";

const fail = (code, message) => ({ ok: false, error: { code, message } });
const ok = (value) => ({ ok: true, value });
const b64 = (text) => Buffer.from(text).toString("base64");

const ALL_CAPABILITIES = "000001ffffffffff";
const NO_CAPABILITIES = "0000000000000000";

/** What exec.run of argv prints in a computer whose user is uid, as `user` (a name in users, or a uid) when given. */
function output(argv, { uid, caps, users, user }) {
	const who = user === undefined ? uid : String(users[user] ?? user);
	if (argv[0] === "id" && argv[1] === "-u") return `${who}\n`;
	if (argv[0] === "cat" && argv[1] === "/proc/self/status") return `Uid:\t${who}\nCapEff:\t${caps}\nCapPrm:\t${caps}\n`;
	if (argv[0] === "env") return "PATH=/usr/bin:/bin\nHOME=/home/fake\n";
	if (argv[0] === "sh" && argv[2]?.includes('echo ok > "$HOME/x"')) return "ok\n";
	return `${argv.slice(1).join(" ")}\n`;
}

/** A refusal as the daemon gives one: its kind and its words. */
const refusal = (kind, message) => Object.assign(new Error(message), { kind });

/** The most bytes one process.read returns, as computerd's. */
const MAX_READ = 512 * 1024;

/** A process's end, as wait and list report it. */
const exitOf = (entry) => ({ running: entry.running, exitCode: entry.exitCode, signal: entry.signal });
/** A process as process.list reports it. */
const infoOf = (entry) => ({ id: entry.id, pid: entry.pid, argv: entry.argv, argvClipped: false, pty: entry.pty, ...exitOf(entry), startedAt: entry.startedAt, endedAt: entry.endedAt });

/** Waits until `entry` changes (output or its end), or ms pass. */
const changed = (entry, ms) =>
	new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		entry.waiters.push(() => {
			clearTimeout(timer);
			resolve();
		});
	});
const notify = (entry) => {
	for (const wake of entry.waiters.splice(0)) wake();
};

/**
 * The handle a program gets on its own process: `write(text)` to its output (stdout, or the terminal's), `end({ exitCode,
 * signal })`, and `entry`, the process as the table holds it.
 */
function handleOf(entry) {
	return {
		entry,
		write(text) {
			if (!entry.running) return;
			entry.output = Buffer.concat([entry.output, Buffer.from(text)]);
			if (entry.log) entry.computer.contents.set(entry.log, entry.output.subarray(0, entry.computer.logBytes));
			notify(entry);
		},
		end({ exitCode = null, signal = null } = {}) {
			if (!entry.running) return;
			Object.assign(entry, { running: false, exitCode, signal, endedAt: Date.now() });
			notify(entry);
		},
	};
}

/**
 * process.start, read, write, wait, signal and list over a computer's table. A program is what `programs(argv, params)`
 * returns for its argv: `{ refuse: [kind, message] }` refuses the start; else `start(handle)`, `input(text, handle)`
 * and `signal(name, handle)` (true keeps it running; KILL always ends it) run it. With no program, echo ends at once and
 * anything else runs until a signal ends it. Output goes to one stream, stdout (or pty), kept whole but read as a ring of
 * the computer's ringBytes: a read before the ring's start begins at its start and says how much it dropped. A start
 * with a log makes the file in the tree (refused through a "symlink" entry at it or a parent, or where one is), keeps
 * the first logBytes of the output in `contents` at it, and reads them as the "log" stream.
 */
async function processes(computer, method, params) {
	const table = computer.processes;
	if (method === "process.start") {
		if (params.log !== undefined) {
			const parts = params.log.split("/");
			for (let i = 2; i <= parts.length; i++) {
				const at = parts.slice(0, i).join("/");
				if (computer.tree.get(at) === "symlink") throw refusal("denied", `${at} is a link: a log is never written through one`);
			}
			if (computer.tree.has(params.log)) throw refusal("exists", `${params.log} exists: a log is a new file`);
		}
		const program = computer.programs?.(params.argv, params);
		if (program?.refuse) throw refusal(...program.refuse);
		if (params.log !== undefined) {
			const parts = params.log.split("/");
			for (let i = 2; i < parts.length; i++) computer.tree.set(parts.slice(0, i).join("/"), "dir");
			computer.tree.set(params.log, "file");
			computer.contents.set(params.log, Buffer.alloc(0));
		}
		const pty = params.pty !== undefined;
		const entry = { id: `p${table.length + 1}`, pid: 100 + table.length, argv: params.argv, pty, startedAt: Date.now(), program, stdin: pty || params.stdin === true, closed: false, output: Buffer.alloc(0), waiters: [], log: params.log, computer };
		Object.assign(entry, program === undefined && params.argv[0] === "echo" ? { running: false, exitCode: 0, signal: null, endedAt: Date.now() } : { running: true, exitCode: null, signal: null, endedAt: null });
		table.push(entry);
		program?.start?.(handleOf(entry));
		return { id: entry.id, pid: entry.pid };
	}
	if (method === "process.list") {
		const from = params.from ?? 0;
		const page = table.filter((one) => Number(one.id.slice(1)) >= from).slice(0, computer.listPage);
		const next = page.length > 0 ? Number(page.at(-1).id.slice(1)) + 1 : from;
		return { processes: page.map(infoOf), truncated: table.some((one) => Number(one.id.slice(1)) >= next), next };
	}
	const entry = table.find((one) => one.id === params.id);
	if (entry === undefined) throw refusal("not_found", `no process ${params.id}`);
	if (method === "process.read" && params.stream === "log") {
		if (!entry.log) throw refusal("invalid", `process ${entry.id} has no log`);
		const head = () => entry.output.subarray(0, computer.logBytes);
		if (params.offset > head().length) throw refusal("invalid", `offset ${params.offset} is past the end of ${entry.id}'s log, ${head().length} bytes so far`);
		if (params.offset === head().length && entry.running && (params.waitMs ?? 0) > 0) await changed(entry, params.waitMs);
		const now = head();
		const data = now.subarray(params.offset, Math.min(now.length, params.offset + (params.maxBytes ?? MAX_READ)));
		const nextOffset = params.offset + data.length;
		return { data: data.toString("base64"), nextOffset, dropped: 0, exited: !entry.running && nextOffset === now.length, size: now.length, ...(entry.output.length > computer.logBytes ? { capped: true } : {}) };
	}
	if (method === "process.read") {
		const stream = entry.pty ? "pty" : "stdout";
		if (params.stream !== stream && !(params.stream === "stderr" && !entry.pty)) throw refusal("invalid", `process ${entry.id} has no stream ${params.stream}`);
		const maxBytes = params.maxBytes ?? MAX_READ;
		if (maxBytes > MAX_READ) throw refusal("limit", `maxBytes ${maxBytes} is over ${MAX_READ}`);
		const bytes = params.stream === "stderr" ? Buffer.alloc(0) : entry.output;
		if (params.offset > bytes.length) throw refusal("invalid", `offset ${params.offset} is past the end of ${entry.id}'s ${params.stream}, ${bytes.length} bytes so far`);
		if (params.offset === bytes.length && entry.running && (params.waitMs ?? 0) > 0) await changed(entry, params.waitMs);
		const now = params.stream === "stderr" ? Buffer.alloc(0) : entry.output;
		const first = Math.max(0, now.length - computer.ringBytes);
		const from = Math.max(params.offset, first);
		const data = now.subarray(from, Math.min(now.length, from + maxBytes));
		const nextOffset = from + data.length;
		return { data: data.toString("base64"), nextOffset, dropped: from - params.offset, exited: !entry.running && nextOffset === now.length, size: now.length };
	}
	if (method === "process.write") {
		if (entry.pty && params.close) throw refusal("invalid", 'a terminal has no stdin to close: write "\\x04" for the end of input, or signal HUP');
		if (!entry.stdin) throw refusal("invalid", `process ${entry.id} was started without stdin`);
		if (!entry.running) throw refusal("invalid", `process ${entry.id} has ended`);
		if (entry.closed) throw refusal("invalid", `process ${entry.id}'s stdin is closed`);
		if (entry.program?.stuck) throw refusal("timeout", `process ${entry.id} did not read its input: 0 of ${Buffer.from(params.data ?? "", "base64").length} bytes were written in 10s`);
		const text = Buffer.from(params.data ?? "", "base64").toString();
		computer.inputs.push([entry.id, text, params.close === true]);
		if (params.close) entry.closed = true;
		entry.program?.input?.(text, handleOf(entry), params.close === true);
		return {};
	}
	if (method === "process.signal") {
		if (!entry.running) return {};
		computer.signals.push([entry.id, params.signal]);
		const keep = params.signal !== "KILL" && entry.program?.signal?.(params.signal, handleOf(entry)) === true;
		if (!keep) handleOf(entry).end({ signal: params.signal });
		return entry.program?.note ? { note: entry.program.note } : {};
	}
	if (method === "process.wait") {
		if (entry.running && params.timeoutMs > 0) {
			const by = Date.now() + params.timeoutMs;
			while (entry.running && Date.now() < by) await changed(entry, by - Date.now());
		}
		return exitOf(entry);
	}
	throw refusal("invalid", `${method} is not a process method`);
}

/** files.mkdir, files.write and files.list over a computer's tree of paths; list pages hold filesPage entries. A write's
 *  bytes are kept in `contents`, replaced or appended to. */
function files(computer, method, params) {
	const tree = computer.tree;
	if (method === "files.mkdir") tree.set(params.path, "dir");
	if (method === "files.write") {
		tree.set(params.path, "file");
		const data = Buffer.from(params.data, "base64");
		const had = params.append ? (computer.contents.get(params.path) ?? Buffer.alloc(0)) : Buffer.alloc(0);
		computer.contents.set(params.path, Buffer.concat([had, data]));
		return { size: had.length + data.length };
	}
	if (method !== "files.list") return {};
	const depth = params.depth ?? 1;
	const walk = (dir, level) =>
		[...tree.keys()]
			.filter((path) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes("/"))
			.sort()
			.flatMap((path) => [{ path, type: tree.get(path) }, ...(tree.get(path) === "dir" && level < depth ? walk(path, level + 1) : [])]);
	const all = walk(params.path, 1);
	const from = params.offset ?? 0;
	const page = all.slice(from, from + computer.filesPage);
	return { entries: page, truncated: from + page.length < all.length };
}

/** A daemon's end of a connection: answers each request line. */
function fakeDaemon(hello, computer) {
	const toDaemon = new PassThrough();
	const fromDaemon = new PassThrough();
	let buffered = "";
	toDaemon.on("data", (chunk) => {
		buffered += chunk.toString("utf8");
		let at;
		while ((at = buffered.indexOf("\n")) >= 0) {
			const request = JSON.parse(buffered.slice(0, at));
			buffered = buffered.slice(at + 1);
			if (typeof request.id !== "number") continue;
			const reply = (body) => fromDaemon.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...body })}\n`);
			computer.requests.push([request.method, request.params]);
			if (request.method === "hello") reply({ result: hello });
			else if (request.method === "ping") reply({ result: {} });
			else if (request.method === "exec.run") {
				const stdout = output(request.params.argv, { ...computer, user: request.params.user });
				reply({ result: { exitCode: 0, stdout: b64(stdout), stderr: "", timedOut: false, truncated: false } });
			} else if (request.method === "files.stat") {
				const type = computer.tree.get(request.params.path);
				if (type === undefined) reply({ error: { code: -32000, message: `${request.params.path} does not exist`, data: { kind: "not_found" } } });
				else reply({ result: { type, size: 0, mode: 0o755, mtimeMs: 0, uid: 1000, gid: 1000 } });
			} else if (["files.mkdir", "files.write", "files.list"].includes(request.method)) reply({ result: files(computer, request.method, request.params) });
			else if (["process.start", "process.read", "process.write", "process.wait", "process.signal", "process.list"].includes(request.method)) {
				processes(computer, request.method, request.params).then(
					(result) => reply({ result }),
					(error) => reply({ error: { code: -32000, message: error.message, data: { kind: error.kind ?? "invalid" } } }),
				);
			}
			else reply({ error: { code: -32601, message: `${request.method} is not a method` } });
		}
	});
	return { readable: fromDaemon, writable: toDaemon };
}

/**
 * The provider, and what it saw: `made` (every computer's name and labels), `alive()` (names not yet deleted),
 * `calls` (list and release calls), `open()` (connections not yet closed).
 * - `createHangs`, `releaseHangs`: those calls never answer. `createDelays`: ms before each create answers, by call.
 * - `connectThrows`: connect throws that message. `uid`: the default user's uid; `users`: names to uids.
 * - `capsForUser`: a computer whose spec asked for a user has every capability.
 * - `createRejects`: create rejects with that message. `createIgnoresCheck`: create makes a computer check refuses.
 * - `listPage`: how many processes one process.list page holds. `filesPage`: how many entries one files.list page holds.
 * - `networkSwitches`: network() applies a change to a network the provider declares, instead of refusing every change.
 *   Each network() call that asks for a policy is in `calls` as ["network", name, policy].
 * - `attachSpec`: merged over the spec attach reports (null: attach reports none).
 * - `kind`, `mode` (capabilities().daemon), `groups`, `maxLifetimeMs`: what capabilities() declares; check() refuses a
 *   lifetime past maxLifetimeMs. `hello` is merged over the hello the daemon gives.
 * - `programs(argv, params)`: what each process.start runs (see processes); `ringBytes`: how much of a process's output
 *   a read reaches, its last bytes; `logBytes`: how much of it a log keeps, its first bytes. The tree's paths hold
 *   "dir", "file" or "symlink" (files.stat answers its type).
 * `daemon(name)` is computer `name`'s daemon record: its `requests` ([method, params] of every request), `processes`,
 * `signals` and `inputs` ([id, signal] and [id, text, close] of each one sent), and `contents` (written files' bytes).
 */
export function fakeComputers({
	id = "fake",
	version = "1.0.0",
	kind = "linux",
	mode = "pid1",
	groups = ["exec", "files", "processes"],
	maxLifetimeMs = 24 * 60 * 60_000,
	hello = {},
	network = ["none"],
	lifetime = "janitor",
	failCreate,
	keepOnRelease = false,
	user,
	createHangs = false,
	releaseHangs = false,
	createDelays = [],
	connectThrows,
	uid = 1000,
	users = {},
	capsForUser = false,
	createRejects,
	createIgnoresCheck = false,
	listPage = 100,
	networkSwitches = false,
	attachSpec = {},
	filesPage = 100,
	programs,
	ringBytes = 8 * 1024 * 1024,
	logBytes = 16 * 1024 * 1024,
} = {}) {
	const computers = new Map();
	const made = [];
	const calls = [];
	let connections = 0;
	let next = 0;
	const provider = {
		id,
		version,
		capabilities: () => ({ kind, lifetime, network, isolation: "container", os: "linux", daemon: mode, groups, maxLifetimeMs, ...(user ? { user } : {}) }),
		check(spec) {
			const refusals = [];
			if (!(Number.isSafeInteger(spec.lifetimeMs) && spec.lifetimeMs > 0)) refusals.push({ field: "lifetimeMs", message: "lifetimeMs is required" });
			else if (spec.lifetimeMs > maxLifetimeMs) refusals.push({ field: "lifetimeMs", message: `lifetimeMs is at most ${maxLifetimeMs} ms` });
			const kind = typeof spec.network === "string" ? spec.network : "allow";
			if (!network.includes(kind)) refusals.push({ field: "network", message: `network ${kind} is not offered` });
			return refusals;
		},
		async create(spec) {
			if (createHangs) return new Promise(() => {});
			if (createRejects) throw new Error(createRejects);
			const wait = createDelays[next] ?? 0;
			if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
			if (failCreate) return fail("refused", failCreate);
			const refusals = provider.check(spec);
			if (refusals.length > 0 && !createIgnoresCheck) return fail("refused", refusals.map((r) => r.message).join("; "));
			const name = `fake-${++next}`;
			const record = {
				ref: { id: `id-${next}`, name },
				image: spec.image,
				labels: { ...spec.labels },
				network: spec.network,
				deadline: new Date(Date.now() + spec.lifetimeMs),
				state: "running",
				daemon: {
					uid: spec.user ?? String(uid),
					caps: capsForUser && spec.user !== undefined ? ALL_CAPABILITIES : NO_CAPABILITIES,
					users,
					processes: [],
					listPage,
					tree: new Map(),
					filesPage,
					programs,
					ringBytes,
					logBytes,
					requests: [],
					signals: [],
					inputs: [],
					contents: new Map(),
				},
			};
			computers.set(name, record);
			made.push({ name, labels: record.labels });
			return ok(record.ref);
		},
		async attach(ref) {
			const found = [...computers.values()].filter((c) =>
				"id" in ref ? c.ref.id === ref.id : Object.entries(ref.labels).every(([k, v]) => c.labels[k] === v),
			);
			if (found.length === 0) return fail("not_found", "no such computer");
			if (found.length > 1) return fail("invalid", `${found.length} computers match`);
			const [c] = found;
			const [u, g = u] = c.daemon.uid.split(":");
			const read = { image: c.image, user: `${u}:${g}`, network: c.network, deadline: c.deadline };
			return ok(attachSpec === null ? { ...c.ref } : { ...c.ref, spec: { ...read, ...attachSpec } });
		},
		async list(labels) {
			calls.push(["list", labels]);
			const found = [...computers.values()].filter((c) => Object.entries(labels).every(([k, v]) => c.labels[k] === v));
			return ok(found.map((c) => ({ ref: c.ref, labels: c.labels, deadline: c.deadline, state: c.state, network: c.network })));
		},
		async network(ref, policy) {
			const record = computers.get(ref.name);
			if (!record) return fail("not_found", `no computer ${ref.name}`);
			if (policy !== undefined) calls.push(["network", ref.name, policy]);
			if (policy !== undefined && JSON.stringify(policy) !== JSON.stringify(record.network)) {
				if (!networkSwitches || !network.includes(typeof policy === "string" ? policy : "allow")) return fail("refused", "the network is fixed");
				record.network = policy;
			}
			return ok(record.network);
		},
		async connect(ref) {
			if (connectThrows) throw new Error(connectThrows);
			if (!computers.has(ref.name)) return fail("not_found", `no computer ${ref.name}`);
			const value = { version, os: "linux", kind, arch: "amd64", groups, ...hello };
			connections++;
			let closed = false;
			const client = new DaemonClient(fakeDaemon(value, computers.get(ref.name).daemon));
			const close = async () => {
				client.close();
				if (!closed) connections--;
				closed = true;
			};
			return ok({ client, hello: value, close });
		},
		async release(ref, how) {
			calls.push(["release", ref.name, how]);
			if (releaseHangs) return new Promise(() => {});
			const record = computers.get(ref.name);
			if (record && how === "stop") record.state = "stopped";
			if (record && how === "delete" && !keepOnRelease) computers.delete(ref.name);
			return ok(undefined);
		},
	};
	return { provider, made, calls, alive: () => [...computers.keys()], open: () => connections, daemon: (name) => computers.get(name)?.daemon };
}
