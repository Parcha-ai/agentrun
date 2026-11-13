// A fake of the slice of boxd's TypeScript SDK (the `@boxd-sh/sdk` package, its Boxd class) that BoxdProvider takes,
// for its unit tests. It records every call with what it was given, and plays the SDK's behaviour as
// @boxd-sh/sdk@0.3.1's dist/*.d.ts describes it: the client is built from { apiKey, baseURL, region, timeout };
// machines.create keeps the name, labels, isolation and config it is given, and refuses a name taken (ConflictError);
// get throws NotFoundError for a machine it does not know; list answers the machines whose labels hold every pair asked
// for; setEgressAllow and setAutoHibernateTimeout change what get reports; exec runs the provider's shell commands as
// the machine's user with passwordless sudo would (install prints the upload's sha256, start starts init); streamExec
// runs `computerd stdio`: requests written to it are answered on its stdout as computerd would. Nothing reaches the
// network, and no SDK is loaded.
import { createHash } from "node:crypto";
import { PROTOCOL_VERSION } from "../dist/protocol.js";
import { scriptOf, wordsOf } from "./fake-shell.mjs";
import { netDevText } from "./net-dev.mjs";

export const VERSION = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../package.json", import.meta.url), "utf8")).version;
export const DAEMON = "/opt/agentrun/computerd";
export const KEY = "fake-boxd-computer-key-0123456789";
export const LINUX_GROUPS = ["exec", "files", "processes"];
export const DESKTOP_GROUPS = [...LINUX_GROUPS, "screen", "input.pointer", "input.keys"];
const NO_CAPS = "0000000000000000";

export class NotFoundError extends Error {
	name = "NotFoundError";
}
export class AuthenticationError extends Error {
	name = "AuthenticationError";
}
export class ConflictError extends Error {
	name = "ConflictError";
}
export class APIConnectionError extends Error {
	name = "APIConnectionError";
}
export class APIStatusError extends Error {
	name = "APIStatusError";
	constructor(message, grpcCode) {
		super(message);
		this.grpcCode = grpcCode;
	}
}

let counter = 0;
const newId = () => `m-${String(++counter).padStart(8, "0")}-fake`;

/** An async byte queue, as the SDK's AsyncByteQueue: push, close, iterate. */
function queue() {
	const chunks = [];
	let waiting;
	let closed = false;
	return {
		push(chunk) {
			chunks.push(chunk);
			waiting?.();
		},
		close() {
			closed = true;
			waiting?.();
		},
		async *[Symbol.asyncIterator]() {
			for (;;) {
				if (chunks.length > 0) yield chunks.shift();
				else if (closed) return;
				else await new Promise((done) => (waiting = done));
				waiting = undefined;
			}
		},
	};
}

/**
 * A fake boxd. Options:
 *  - create: "ok", "invalid" (INVALID_ARGUMENT, nothing made), "auth" (AuthenticationError), "lost" (makes the machine,
 *    then throws APIConnectionError: its id never comes back), "deadline" (throws the SDK's DEADLINE_EXCEEDED at once,
 *    and the machine lands landMs later), "hold" (settles, having made the machine, only when fake.release() is called);
 *  - landMs: with create "deadline", how long after the throw the machine lands (default 30);
 *  - snapshotLabels: labels a machine restored from a snapshot carries from it (a restore merges them);
 *  - machine: fields get reports over what create and the setters gave (egressAllow, idle, networking, deleteAt, ...);
 *  - sha: "ok" or "lie" (install prints a sha256 that is not the file's);
 *  - install: exit code of the install script (default 0);
 *  - initFails: words init writes to its log, and no daemon listens;
 *  - notListening: how many bridges find no daemon listening before one does;
 *  - box: what the daemon reports, over the defaults (hello, uid, gid, status fields, interfaces, reached, cwd, exe);
 *  - display: "ok" (Xvfb brings the display up after one hello) or "dies" (the server exits 1 at once);
 *  - lingers: after a delete, get still reads the machine running this many times;
 *  - onStep(step, machine): called at the start of every SDK call and every daemon request, by name.
 * fake.calls records [name, ...args] of every call; fake.clients each client's options.
 */
export function fakeBoxd({ create = "ok", landMs = 30, snapshotLabels = {}, machine: machinePatch = {}, sha = "ok", install = 0, initFails, notListening = 0, box: boxPatch = {}, display = "ok", lingers = 0, onStep = () => {} } = {}) {
	const calls = [];
	const machines = new Map();
	const fake = { calls, machines, clients: [], uploads: [], bridges: [], requests: [], deletes: [] };
	const held = [];
	let waitingBridges = notListening;
	const record = (name, ...args) => calls.push([name, ...args]);

	const add = ({ name = `computer-${"0".repeat(12)}`, labels = {}, isolated = true, config = {}, fromSnapshot, org = "acme", status = "running" } = {}) => {
		const id = newId();
		const m = {
			id,
			name,
			status,
			labels: { ...labels },
			egressAllow: [],
			idle: { suspendAfter: config.autoSuspendTimeout ?? 900, hibernateAfter: 14_400, destroyAfter: 0 },
			resources: { vcpu: config.vcpu ?? 2, memoryBytes: Number.parseInt(config.memory ?? "8G", 10) * 1024 ** 3 },
			networking: { isolated, networks: [] },
			org: { id: `org-${org}`, name: org },
			region: "fra",
			deleteAt: null,
			source: fromSnapshot === undefined ? null : { kind: "snapshot", name: fromSnapshot, version: 1, id: "snap-1" },
			files: new Map(),
			daemon: undefined,
			init: undefined,
			processes: [],
			deleted: false,
			lingering: 0,
			box: { hello: { protocol: PROTOCOL_VERSION, version: VERSION, os: "linux", kind: "linux", arch: "amd64", groups: [...LINUX_GROUPS], fence: "netns" }, uid: 2510, gid: 2510, status: {}, kernel: "6.18.0", interfaces: ["lo"], cwd: "/work", exe: DAEMON, ...boxPatch },
		};
		machines.set(id, m);
		return m;
	};
	const view = (m) => {
		const { files, daemon, init, processes, deleted, lingering, box, xvfb, displayUp, ...rest } = m;
		return { ...structuredClone({ ...rest, deleteAt: null }), deleteAt: m.deleteAt, ...machinePatch };
	};
	const gone = (m) => m === undefined || (m.deleted && !(m.lingering > 0));
	const find = (id) => {
		const m = machines.get(id);
		if (gone(m)) throw new NotFoundError(`machine ${id} not found`);
		return m;
	};

	/** What the daemon in m answers to one request. */
	function answer(m, { method, params }) {
		const result = (value) => ({ result: value });
		const error = (kind, message) => ({ error: { code: -32000, message, data: { kind } } });
		const displayUp = m.init?.display && m.displayUp;
		if (method === "hello") {
			if (m.xvfb && display === "ok") m.displayUp = true;
			return result({ ...m.box.hello, groups: displayUp ? [...DESKTOP_GROUPS] : [...LINUX_GROUPS], kind: displayUp ? "desktop" : "linux", ...(m.box.helloPatch ?? {}) });
		}
		if (method === "ping") return result({});
		if (method === "files.read" && params.path === "/proc/self/status") {
			const fields = { Uid: `${m.box.uid}\t`.repeat(4).trim(), Gid: `${m.box.gid}\t`.repeat(4).trim(), Groups: "", NoNewPrivs: "1", CapInh: NO_CAPS, CapPrm: NO_CAPS, CapEff: NO_CAPS, CapBnd: NO_CAPS, CapAmb: NO_CAPS, Seccomp: "2", ...m.box.status };
			const text = Object.entries(fields).map(([k, v]) => `${k}:\t${v}\n`).join("");
			return result({ data: Buffer.from(text).toString("base64"), size: text.length, eof: true });
		}
		if (method === "files.read" && params.path === "/proc/self/net/dev") {
			const text = netDevText(m.box.interfaces);
			return result({ data: Buffer.from(text).toString("base64"), size: text.length, eof: true });
		}
		if (method === "files.stat") {
			if (params.path === "/proc/self/cwd") return result({ path: params.path, type: "symlink", target: m.box.cwd });
			if (params.path === "/proc/self/exe") return result({ path: params.path, type: "symlink", target: m.box.exe });
			return error("not_found", `${params.path}: no such file`);
		}
		if (method === "exec.run") {
			const argv = params.argv;
			const out = (text) => result({ exitCode: 0, stdout: Buffer.from(text).toString("base64"), stderr: "", timedOut: false, truncated: false });
			if (argv[0] === DAEMON && argv[1] === "probe") {
				// In the daemon's own network namespace nothing answers and nothing accepts.
				const report = { uid: m.box.uid, gid: m.box.gid, kernel: m.box.kernel, interfaces: m.box.interfaces, quiet: [], raised: [], reached: m.box.reached ?? [], accepted: [] };
				return out(`${JSON.stringify(report)}\n`);
			}
			return out(`${argv.join(" ")}\n`);
		}
		if (method === "process.start") {
			const entry = { id: `p${m.processes.length + 1}`, pid: 100 + m.processes.length, argv: params.argv, running: true, exitCode: null, signal: null, stderr: "" };
			if (params.argv[0] === "Xvfb") {
				m.xvfb = entry;
				if (display === "dies") Object.assign(entry, { running: false, exitCode: 1, stderr: "(EE) Cannot establish any listening sockets\n" });
			}
			m.processes.push(entry);
			return result({ id: entry.id, pid: entry.pid });
		}
		if (method === "process.wait") {
			const entry = m.processes.find((p) => p.id === params.id);
			return entry === undefined ? error("not_found", `no process ${params.id}`) : result({ running: entry.running, exitCode: entry.exitCode, signal: entry.signal });
		}
		if (method === "process.read") {
			const entry = m.processes.find((p) => p.id === params.id);
			return result({ data: Buffer.from(entry.stderr).toString("base64"), offset: 0, next: entry.stderr.length, exited: !entry.running });
		}
		if (method === "deadline.extend") {
			const to = Date.parse(params.at);
			if (!m.init.max) return error("unsupported", "this computer's deadline cannot move");
			if (to > Date.parse(m.init.max)) return error("limit", `${params.at} is past the maximum deadline ${m.init.max}`);
			if (to < Date.parse(m.init.deadline)) return error("invalid", `${params.at} is earlier than the deadline ${m.init.deadline}: deadline.extend only moves it later`);
			m.init.deadline = new Date(to).toISOString();
			return result({ at: m.init.deadline });
		}
		return error("unsupported", `${method} is not a method`);
	}

	const machinesApi = {
		async create(params) {
			record("machines.create", params);
			await onStep("machines.create");
			if (create === "invalid") throw new APIStatusError("snapshot not found", 3);
			if (create === "auth") throw new AuthenticationError("invalid_api_key");
			if ([...machines.values()].some((m) => m.name === params.name && !m.deleted)) throw new ConflictError(`a machine named ${params.name} exists`);
			const make = () => {
				const m = add({ name: params.name, labels: { ...(params.fromSnapshot === undefined ? {} : snapshotLabels), ...params.labels }, isolated: params.isolated, config: params.config, fromSnapshot: params.fromSnapshot, org: params.org ?? "personal" });
				if (params.deleteAfter !== undefined) m.deleteAt = new Date(Date.now() + params.deleteAfter * 1000);
				return m;
			};
			if (create === "deadline") {
				setTimeout(make, landMs);
				throw new APIStatusError("Deadline exceeded", 4);
			}
			if (create === "hold") {
				let done;
				const wait = new Promise((resolve) => (done = resolve));
				held.push(done);
				await wait;
			}
			const m = make();
			if (create === "lost") throw new APIConnectionError("connection reset: the machine may have been made");
			return view(m);
		},
		async get(id) {
			record("machines.get", id);
			const m = machines.get(id);
			await onStep("machines.get", m);
			if (m?.deleted && m.lingering > 0) {
				m.lingering--;
				return view(m);
			}
			return view(find(id));
		},
		async list(params) {
			record("machines.list", params);
			await onStep("machines.list");
			const wanted = params?.labels ?? {};
			const list = [...machines.values()].filter((m) => !m.deleted && Object.entries(wanted).every(([k, v]) => m.labels[k] === v)).map(view);
			return Object.assign(list, { elsewhere: {}, unavailable: [] });
		},
		async delete(id) {
			record("machines.delete", id);
			const m = find(id);
			await onStep("machines.delete", m);
			m.deleted = true;
			m.lingering = lingers;
			fake.deletes.push(id);
		},
		async waitUntilReady(id, params) {
			record("machines.waitUntilReady", id, params);
			const m = find(id);
			await onStep("machines.waitUntilReady", m);
			return view(m);
		},
		async setEgressAllow(id, entries) {
			record("machines.setEgressAllow", id, entries);
			const m = find(id);
			m.egressAllow = [...entries];
			return [...entries];
		},
		async setAutoHibernateTimeout(id, seconds) {
			record("machines.setAutoHibernateTimeout", id, seconds);
			find(id).idle.hibernateAfter = seconds;
		},
		async updateLabels(id, { set }) {
			record("machines.updateLabels", id, set);
			const m = find(id);
			await onStep("machines.updateLabels", m);
			Object.assign(m.labels, set);
			return { ...m.labels };
		},
		async exec(id, params) {
			const script = scriptOf(params.command);
			record("machines.exec", id, script?.kind ?? params.command, params);
			const m = find(id);
			await onStep(`exec ${script?.kind ?? "other"}`, m);
			if (script?.kind === "install") {
				const [staging, daemon] = script.args;
				const bytes = m.files.get(staging);
				if (install !== 0 || bytes === undefined) return { exitCode: install || 5, stdout: `installing the daemon at ${daemon} failed\n`, stderr: "" };
				m.files.delete(staging);
				m.daemon = { path: daemon, bytes };
				const read = createHash("sha256").update(bytes).digest("hex");
				return { exitCode: 0, stdout: `installer 1000 boxd sudo\nsha256 ${sha === "lie" ? "0".repeat(64) : read}\n`, stderr: "" };
			}
			if (script?.kind === "start") {
				// The start script's first argument is init's command; the second where its words go.
				const init = scriptOf(script.args[0]);
				const [, deadline, user, , , shown = "", max = ""] = init?.args ?? [];
				m.startedWith = { init: script.args[0], log: script.args[1] };
				if (initFails !== undefined || m.daemon === undefined) {
					m.log = `${initFails ?? "sh: /opt/agentrun/computerd: not found"}\n`;
					return { exitCode: 0, stdout: "", stderr: "" };
				}
				const [uid, gid] = user.split(":").map(Number);
				Object.assign(m.box, { uid, gid });
				m.init = { deadline, user, display: shown, max };
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			if (script?.kind === "log") return { exitCode: 0, stdout: m.log ?? "", stderr: "" };
			throw new Error(`the fake runs only the provider's scripts, not ${params.command}`);
		},
		streamExec(id, params) {
			const script = scriptOf(params.command);
			record("machines.streamExec", id, script?.kind ?? params.command);
			const m = find(id);
			if (script?.kind !== "stdio") throw new Error(`the fake streams only the stdio bridge, not ${params.command}`);
			const stdout = queue();
			const stderr = queue();
			let buffered = "";
			let closed = false;
			const listening = m.init !== undefined && !(waitingBridges > 0);
			if (m.init !== undefined && waitingBridges > 0) waitingBridges--;
			const end = () => {
				if (closed) return;
				closed = true;
				stdout.close();
				stderr.close();
			};
			const stream = {
				stderr,
				[Symbol.asyncIterator]: () => stdout[Symbol.asyncIterator](),
				write(data) {
					if (closed) throw new Error("the stream is closed");
					buffered += typeof data === "string" ? data : Buffer.from(data).toString("utf8");
					let at;
					while ((at = buffered.indexOf("\n")) >= 0) {
						const request = JSON.parse(buffered.slice(0, at));
						buffered = buffered.slice(at + 1);
						if (typeof request.id !== "number") continue;
						fake.requests.push({ machine: m.id, method: request.method, params: request.params });
						void (async () => {
							await onStep(request.method, m);
							const reply = answer(m, request);
							if (!closed) stdout.push(Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...reply })}\n`));
						})();
					}
				},
				end() {},
				async wait() {
					return 0;
				},
				close() {
					bridge.closed = true;
					end();
				},
			};
			const bridge = { machine: m.id, closed: false };
			fake.bridges.push(bridge);
			if (!listening) {
				queueMicrotask(() => {
					stderr.push(Buffer.from("computerd stdio: no daemon listens at /run/agentrun/computerd.sock (connect: no such file or directory)\n"));
					end();
				});
			}
			return stream;
		},
		files: {
			async upload(id, path, data) {
				record("files.upload", id, path);
				const m = find(id);
				await onStep("files.upload", m);
				m.files.set(path, Buffer.from(data));
				fake.uploads.push({ machine: id, path, bytes: Buffer.from(data) });
				return data.length;
			},
		},
	};

	class Boxd {
		constructor(options) {
			fake.clients.push(options);
			this.machines = machinesApi;
		}
	}
	fake.Boxd = Boxd;
	/** Lets every held create go on. */
	fake.release = async () => {
		for (const done of held.splice(0)) done();
		await new Promise((resolve) => setTimeout(resolve, 20));
	};
	fake.add = add;
	fake.names = () => calls.map(([name]) => name);
	return fake;
}

export { wordsOf };
