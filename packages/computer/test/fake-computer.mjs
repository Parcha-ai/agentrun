// A fake provider whose computers are records in memory, each with a fake daemon on an in-memory stream: hello, ping,
// files.mkdir, files.write and files.list over paths in memory, and exec.run, which answers id -u, cat /proc/self/status, env and a write to $HOME as a computer would
// and echoes any other argv. Every other method is unsupported. No Docker, no daemon.
// A computer made with a mount has the run's folder at /workspace: files.read, files.write and `cat` (with a cwd) there
// reach the folder on this machine, the way a bind or an Archil mount reaches it.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { DaemonClient } from "../dist/index.js";

const fail = (code, message) => ({ ok: false, error: { code, message } });
const ok = (value) => ({ ok: true, value });
const b64 = (text) => Buffer.from(text).toString("base64");

const ALL_CAPABILITIES = "000001ffffffffff";
const NO_CAPABILITIES = "0000000000000000";
const WORKSPACE = "/workspace";

/** The folder on this machine a path in the computer reaches through its mount, or undefined when it reaches none. */
function bound(computer, path) {
	if (computer.bound === undefined || !(path === WORKSPACE || path.startsWith(`${WORKSPACE}/`))) return undefined;
	return join(computer.bound, path.slice(WORKSPACE.length));
}

/** What `cat <path>` with cwd prints in a computer with a mount, or undefined when argv is not that. */
function catOf(argv, cwd, computer) {
	if (argv[0] !== "cat" || argv.length !== 2) return undefined;
	const path = argv[1].startsWith("/") ? argv[1] : `${cwd ?? "/work"}/${argv[1]}`;
	if (!path.startsWith(`${WORKSPACE}/`)) return undefined;
	const host = bound(computer, path);
	try {
		if (host === undefined) throw new Error("nothing is mounted at /workspace");
		return { exitCode: 0, stdout: readFileSync(host, "utf8"), stderr: "" };
	} catch {
		return { exitCode: 1, stdout: "", stderr: `cat: ${argv[1]}: No such file or directory\n` };
	}
}

/** What /proc/self/status reads in a computer that leaves its programs nothing: every set empty, no_new_privs set. */
const UNPRIVILEGED = { CapInh: NO_CAPABILITIES, CapPrm: NO_CAPABILITIES, CapEff: NO_CAPABILITIES, CapBnd: NO_CAPABILITIES, CapAmb: NO_CAPABILITIES, NoNewPrivs: "1" };

/** What exec.run of argv prints in a computer whose user is uid, as `user` (a name in users, or a uid) when given. */
function output(argv, { uid, status, users, user }) {
	const who = user === undefined ? uid : String(users[user] ?? user);
	if (argv[0] === "id" && argv[1] === "-u") return `${who}\n`;
	if (argv[0] === "cat" && argv[1] === "/proc/self/status") {
		const lines = Object.entries(status).filter(([, value]) => value !== undefined);
		return `Uid:\t${who}\n${lines.map(([field, value]) => `${field}:\t${value}\n`).join("")}`;
	}
	if (argv[0] === "env") return "PATH=/usr/bin:/bin\nHOME=/home/fake\n";
	if (argv[0] === "sh" && argv[2]?.includes('echo ok > "$HOME/x"')) return "ok\n";
	return `${argv.slice(1).join(" ")}\n`;
}

/** process.start, wait, signal and list over a computer's table: echo ends at once, anything else runs until a signal. */
function processes(computer, method, params) {
	const table = computer.processes;
	if (method === "process.start") {
		const entry = { id: `p${table.length + 1}`, pid: 100 + table.length, argv: params.argv, argvClipped: false, pty: params.pty !== undefined, startedAt: Date.now() };
		Object.assign(entry, params.argv[0] === "echo" ? { running: false, exitCode: 0, signal: null, endedAt: Date.now() } : { running: true, exitCode: null, signal: null, endedAt: null });
		table.push(entry);
		return { id: entry.id, pid: entry.pid };
	}
	const entry = table.find((one) => one.id === params.id);
	if (method === "process.list") {
		const from = params.from ?? 0;
		const page = table.slice(from, from + computer.listPage);
		return { processes: page, truncated: from + page.length < table.length, next: from + page.length };
	}
	if (entry === undefined) return undefined;
	if (method === "process.signal") Object.assign(entry, entry.running ? { running: false, signal: params.signal, endedAt: Date.now() } : {});
	if (method === "process.signal") return {};
	return { running: entry.running, exitCode: entry.exitCode, signal: entry.signal };
}

/** files.mkdir, files.write and files.list over a computer's tree of paths; list pages hold filesPage entries. */
function files(computer, method, params) {
	const tree = computer.tree;
	const host = bound(computer, params.path);
	if (host !== undefined && method === "files.write") {
		writeFileSync(host, Buffer.from(params.data, "base64"), { mode: 0o644 });
		return { size: Buffer.from(params.data, "base64").length };
	}
	if (method === "files.read") {
		const data = host === undefined ? undefined : (() => { try { return readFileSync(host); } catch { return undefined; } })();
		if (data === undefined) return { error: { code: -32000, message: `no such file: ${params.path}`, data: { kind: "not_found" } } };
		return { data: data.toString("base64"), eof: true, size: data.length };
	}
	if (method === "files.mkdir") tree.set(params.path, "dir");
	if (method === "files.write") tree.set(params.path, "file");
	if (method === "files.write") return { size: Buffer.from(params.data, "base64").length };
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
			if (request.method === "hello") reply({ result: hello });
			else if (request.method === "ping") reply({ result: {} });
			else if (request.method === "exec.run") {
				const cat = catOf(request.params.argv, request.params.cwd, computer);
				const ran = cat ?? { exitCode: 0, stdout: output(request.params.argv, { ...computer, user: request.params.user }), stderr: "" };
				reply({ result: { exitCode: ran.exitCode, stdout: b64(ran.stdout), stderr: b64(ran.stderr), timedOut: false, truncated: false } });
			} else if (["files.mkdir", "files.write", "files.list", "files.read"].includes(request.method)) {
				const result = files(computer, request.method, request.params);
				reply(result.error ? { error: result.error } : { result });
			}
			else if (["process.start", "process.wait", "process.signal", "process.list"].includes(request.method)) {
				const result = processes(computer, request.method, request.params);
				if (result === undefined) reply({ error: { code: -32000, message: `no process ${request.params.id}`, data: { kind: "not_found" } } });
				else reply({ result });
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
 * - `status`: /proc/self/status fields over the unprivileged ones, in every computer (a value of undefined drops the
 *   line); `statusForUser`: the same, in a computer whose spec asked for a user.
 * - `createRejects`: create rejects with that message. `createIgnoresCheck`: create makes a computer check refuses.
 * - `listPage`: how many processes one process.list page holds. `filesPage`: how many entries one files.list page holds.
 * - `declaresStopDeletes`: capabilities().stopDeletes, left out unless given. `stopIgnored`: a stop does nothing, and the
 *   computer runs on.
 * - `networkSwitches`: network() applies a change to a network the provider declares, instead of refusing every change.
 *   Each network() call that asks for a policy is in `calls` as ["network", name, policy].
 * - `attachSpec`: merged over the spec attach reports (null: attach reports none).
 * - `release`: what capabilities().release declares (default stop and delete). A stop it does not declare is refused as
 *   `unsupported` and leaves the computer running, unless `stopAnyway`; `stopDeletes`: a stop deletes the computer.
 * - `kind`, `mode` (capabilities().daemon), `groups`, `maxLifetimeMs`: what capabilities() declares; check() refuses a
 *   lifetime past maxLifetimeMs. `hello` is merged over the hello the daemon gives.
 * - `mount`: the mount kinds capabilities() declares (absent: none); check() refuses any other kind. A computer made with
 *   a mount reaches the run's folder at /workspace: a bind's path, or an Archil mount's folder under `disks[disk]`, a
 *   folder on this machine standing for the disk. attach() and list() read the mount back, without the token.
 * - `brokenMount`: "unbound" (the mount is read back, but nothing is bound at /workspace), "no-read-back" (attach and
 *   list report no mount), "token-in-read-back" (attach reports the token), "token-in-label" (the computer carries the
 *   token as a label), "check-ignores" (check() takes any mount kind, declared or not), "host-refuses" (check()
 *   refuses even a kind the provider declares, as a Docker host that remaps user ids refuses a bind), "no-region"
 *   (an Archil mount reads back without its region).
 * - `listIgnoresLabels`: list() gives every computer, whatever labels it was asked for.
 * - `failRelease`: labels; a release of a computer that carries all of them fails ("refused", in words) and leaves it.
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
	status = {},
	statusForUser = {},
	createRejects,
	createIgnoresCheck = false,
	listPage = 100,
	declaresStopDeletes,
	stopIgnored = false,
	networkSwitches = false,
	attachSpec = {},
	release = ["stop", "delete"],
	stopAnyway = false,
	stopDeletes = false,
	filesPage = 100,
	mount,
	disks = {},
	brokenMount,
	listIgnoresLabels = false,
	failRelease,
} = {}) {
	/** The mount as attach and list read it back: its kind and source, never the token unless broken so. */
	const readBack = (asked) => {
		if (asked === undefined || brokenMount === "no-read-back") return {};
		if (asked.kind === "bind") return { mount: { kind: "bind", path: asked.path } };
		const region = brokenMount === "no-region" ? {} : { region: asked.region };
		return { mount: { kind: "archil", disk: asked.disk, ...region, folder: asked.folder, ...(brokenMount === "token-in-read-back" ? { token: asked.token } : {}) } };
	};
	const folderOf = (asked) => {
		if (asked === undefined || brokenMount === "unbound") return undefined;
		return asked.kind === "bind" ? asked.path : join(disks[asked.disk], asked.folder);
	};
	const computers = new Map();
	const made = [];
	const calls = [];
	let connections = 0;
	let next = 0;
	const provider = {
		id,
		version,
		capabilities: () => ({ kind, lifetime, network, isolation: "container", os: "linux", daemon: mode, groups, maxLifetimeMs, release, ...(user ? { user } : {}), ...(mount ? { mount } : {}) }),
		check(spec) {
			const refusals = [];
			if (spec.mount !== undefined && !(mount ?? []).includes(spec.mount.kind) && brokenMount !== "check-ignores") {
				refusals.push({ field: "mount", message: `this provider takes no mount of kind ${spec.mount.kind}` });
			} else if (spec.mount !== undefined && brokenMount === "host-refuses") {
				refusals.push({ field: "mount", message: "this host cannot bind the run folder" });
			}
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
				labels: { ...spec.labels, ...(brokenMount === "token-in-label" && spec.mount?.token ? { "mount.token": spec.mount.token } : {}) },
				network: spec.network,
				mount: spec.mount,
				deadline: new Date(Date.now() + spec.lifetimeMs),
				state: "running",
				daemon: {
					uid: spec.user ?? String(uid),
					status: {
						...UNPRIVILEGED,
						...status,
						...(spec.user !== undefined && capsForUser ? { CapEff: ALL_CAPABILITIES, CapPrm: ALL_CAPABILITIES } : {}),
						...(spec.user !== undefined ? statusForUser : {}),
					},
					users,
					processes: [],
					listPage,
					tree: new Map(),
					filesPage,
					bound: folderOf(spec.mount),
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
			const read = { image: c.image, user: `${u}:${g}`, network: c.network, deadline: c.deadline, ...readBack(c.mount) };
			return ok(attachSpec === null ? { ...c.ref } : { ...c.ref, spec: { ...read, ...attachSpec } });
		},
		async list(labels) {
			calls.push(["list", labels]);
			const found = [...computers.values()].filter((c) => listIgnoresLabels || Object.entries(labels).every(([k, v]) => c.labels[k] === v));
			return ok(found.map((c) => ({ ref: c.ref, labels: c.labels, deadline: c.deadline, state: c.state, network: c.network, ...readBack(c.mount) })));
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
			if (how === "stop" && stopIgnored) return ok(undefined);
			const record = computers.get(ref.name);
			if (record && failRelease && Object.entries(failRelease).every(([k, v]) => record.labels[k] === v)) {
				return fail("refused", `the fake cannot ${how} ${ref.name}`);
			}
			if (how === "stop" && !release.includes("stop") && !stopAnyway) return fail("unsupported", "this fake has no stop that keeps a computer; release it with delete");
			if (record && how === "stop" && stopDeletes) computers.delete(ref.name);
			if (record && how === "stop") record.state = "stopped";
			if (record && how === "delete" && !keepOnRelease) computers.delete(ref.name);
			return ok(undefined);
		},
	};
	// stopDeletes as declared, apart from the line that declares the rest.
	if (declaresStopDeletes !== undefined) {
		const declared = provider.capabilities;
		provider.capabilities = () => ({ ...declared(), stopDeletes: declaresStopDeletes });
	}
	return { provider, made, calls, alive: () => [...computers.keys()], open: () => connections };
}

/**
 * Run folders for the fake, as a provider's conformance module gives them: `mountFor(kind)` makes a fresh folder on this
 * machine and the mount that reaches it (a bind of it, or an Archil folder on the fake disk `disks` names), read and
 * written from outside the computer. `closed()` names each folder's mount once the runner has closed it.
 */
export function fakeRunFolders() {
	// Made on the first Archil folder only, so a run of bind folders leaves no disk behind.
	let made;
	const diskDir = () => (made ??= mkdtempSync(join(tmpdir(), "computer-fake-disk-")));
	const closed = [];
	const at = (dir, mount) => ({
		mount,
		read: async (path) => {
			try {
				return readFileSync(join(dir, path));
			} catch {
				return undefined;
			}
		},
		write: async (path, data) => writeFileSync(join(dir, path), data),
		close: async () => {
			closed.push(mount);
			rmSync(dir, { recursive: true, force: true });
		},
	});
	const mountFor = (kind) => {
		if (kind === "bind") {
			const dir = realpathSync(mkdtempSync(join(tmpdir(), "computer-run-")));
			return at(dir, { kind: "bind", path: dir });
		}
		if (kind !== "archil") return undefined;
		const folder = `runs/${randomBytes(4).toString("hex")}`;
		mkdirSync(join(diskDir(), folder), { recursive: true });
		return at(join(diskDir(), folder), { kind: "archil", disk: "fake-disk", region: "fake-region-1", folder, token: `archil-token-${randomBytes(8).toString("hex")}` });
	};
	const disks = {
		get "fake-disk"() {
			return diskDir();
		},
	};
	const remove = () => {
		if (made !== undefined) rmSync(made, { recursive: true, force: true });
	};
	return { mountFor, disks, closed: () => closed, remove };
}
