// The adapter's one fake host: a MachineHost (src/host.ts) over machines in memory, for the adapter's own unit tests
// (hosted-provider.test.mjs, hosted-sweep.test.mjs). It plays no vendor: it keeps what create is given, answers get and
// list from it, and runs the adapter's scripts (src/hosted/scripts.ts) the way a root shell would: install (the
// upload's sha256), start (init, detached; its words to the log), log, stdio (a bridge whose requests a computerd answers
// as the real one does), an Archil computer's root steps by verb, and a pid1 machine's entrypoint. Nothing reaches the
// network, and no vendor SDK is loaded.
import { createHash } from "node:crypto";
import { DEADLINE_LABEL } from "../dist/drift.js";
import { HostError } from "../dist/host.js";
import { EGRESS_POLICY as POLICY, EGRESS_RELAY as RELAY } from "../dist/hosted/network.js";
import { PROTOCOL_VERSION } from "../dist/protocol.js";
import { GOOD_PREFLIGHT, mountsOf, rootVerb } from "./fake-archil.mjs";
import { scriptOfWords } from "./fake-shell.mjs";
import { netDevText } from "./net-dev.mjs";

export const VERSION = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../package.json", import.meta.url), "utf8")).version;
export const DAEMON = "/opt/agentrun/computerd";
export const LINUX_GROUPS = ["exec", "files", "processes"];
export const DESKTOP_GROUPS = ["exec", "files", "processes", "screen", "input.pointer", "input.keys", "apps"];
const NO_CAPS = "0000000000000000";
const STDIN_VERBS = new Set(["mount", "revoke"]);
/** Where the adapter keeps a machine's labels for a host that keeps none (src/hosted/scripts.ts, LABEL_FILE). */
export const LABEL_FILE = "/var/lib/agentrun/labels.json";

/** The fake's descriptor, as a vendor's (src/descriptors/*): its network, mounts and configurations. */
export const FAKE_DESCRIPTOR = {
	id: "fakehost",
	label: "Fakehost",
	network: ["none"],
	mounts: ["archil"],
	capabilities: [
		{ kind: "linux", groups: [...LINUX_GROUPS] },
		{ kind: "desktop", groups: [...DESKTOP_GROUPS] },
	],
};

/** The fake's descriptor declaring every network form, as the hosted vendors that run init's egress proxy do. */
export const NETWORK_DESCRIPTOR = { ...FAKE_DESCRIPTOR, network: ["none", "open", "allow"] };

/** The fake's descriptor with GPUs on its linux configuration. */
export const gpuDescriptor = (gpu) => ({ ...FAKE_DESCRIPTOR, capabilities: [{ kind: "linux", groups: [...LINUX_GROUPS], gpu }, FAKE_DESCRIPTOR.capabilities[1]] });

export class NotFound extends Error {
	name = "NotFound";
}
export class Refused extends Error {
	name = "Refused";
}
export class Late extends Error {
	name = "Late";
}

/** A deferred: a promise and the hands that settle it. */
export function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

/** A stream an exec'd process writes, read as an async iterable until it ends. */
function feed() {
	const queue = [];
	let ended = false;
	let wake;
	return {
		push(text) {
			if (ended) return;
			queue.push(new Uint8Array(Buffer.from(text)));
			wake?.();
		},
		end() {
			ended = true;
			wake?.();
		},
		iterable: {
			async *[Symbol.asyncIterator]() {
				for (;;) {
					if (queue.length > 0) yield queue.shift();
					else if (ended) return;
					else await new Promise((done) => (wake = done));
				}
			},
		},
	};
}

let counter = 0;
const START = Date.now();

/**
 * A fake host. Its calls answer plain values or throw, as src/host.ts says. Options:
 *  - facts: over the defaults (child daemon, vendor lifetime). With labels "machine" it keeps no labels: a machine has
 *    the name create gave it (add's name), get and list answer no labels, list answers every machine, and the label
 *    script reads and writes the machine's label file (add's file);
 *  - descriptor: the host's, FAKE_DESCRIPTOR by default (network none, an archil mount, a linux and a desktop
 *    configuration, no GPU);
 *  - create: "ok", "fail" (refused: nothing made), "hold" (answers once fake.release() is called, or throws the error
 *    fake.release(error) is given, having made nothing), "lost" (makes the
 *    machine, then throws Late: its id never comes back), "broken" (makes it, then throws a plain error);
 *  - starting: how many reads a new machine answers starting before it runs;
 *  - failed: words a new machine reads gone in, as the vendor's why, once it is done starting;
 *  - unlisted: how many listings a new machine is left out of;
 *  - flaps: for a new machine, whether each listing after its create shows it (true) or leaves it out (false), in turn,
 *    until they run out; then every listing shows it;
 *  - born(n): the creation time of the n-th machine made (1, 2, ...), or undefined for none; default the order made;
 *  - sha: "ok" or "lie"; install: the install's exit code; initFails: words init writes before it exits;
 *  - notListening: how many bridges find no daemon before one does;
 *  - box: what the daemon reports (hello patch, uid, gid, status, interfaces, reached, accepted, quiet, raised);
 *  - display: "ok", "never", "dies", or, with the display up, "manager missing" (the window manager does not start) or
 *    "manager dies" (it ends at once);
 *  - lingers: { reads, lists, state } after a delete, a lingering read in state (running unless given); fileApi: false
 *    for a host with no upload;
 *  - timer: "ok" (extend moves the end and the deadline label: the vendor's timer, or with lifetime janitor the label
 *    alone, rounded up to a whole second), "limit" (extend throws a HostError limit, nothing moves), or "none" (a host
 *    with no extend);
 *  - onStep(step, machine): at the start of every host call and daemon request, so a test can abort a signal there;
 *  - hang: a script's kind ("install", ...) whose process never ends; killHangs: a process's kill that never settles;
 *  - archil: root verbs' answers, as fake-archil.mjs's;
 *  - sockets: the path sockets every machine holds, which the sockets script closes where a pattern names them;
 *    socketsFail: a path among them whose chmod fails;
 *  - stale: the listing reads each machine as its create made it, running, forever: it keeps a deleted machine, and
 *    shows create's end and labels after a timer moved (E2B's Sandbox.list, read live 11-14). get stays current.
 * fake.events records every exec by script or verb, every daemon method and every delete, per machine.
 */
export function fakeHost({
	facts = {},
	create = "ok",
	starting = 0,
	failed,
	unlisted = 0,
	flaps = [],
	born,
	sha = "ok",
	install = 0,
	initFails,
	notListening = 0,
	box: boxPatch = {},
	display = "ok",
	lingers,
	fileApi = true,
	onStep = () => {},
	archil = {},
	timer = "ok",
	hang,
	killHangs = false,
	sockets = [],
	socketsFail,
	rootOnlyFail,
	stale = false,
	descriptor = FAKE_DESCRIPTOR,
} = {}) {
	const machines = new Map();
	const held = [];
	const fake = { machines, calls: [], events: [], requests: [], rootRuns: [], syncs: [], uploads: [] };
	let waitingBridges = notListening;
	const step = async (name, ctx, machine) => {
		fake.calls.push([name, machine?.id]);
		await onStep(name, machine);
		if (ctx?.signal?.aborted) throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
	};
	const gone = (m) => m === undefined || (m.deleted && !(m.lingering?.reads > 0));

	const add = ({ labels = {}, name, file, network = "none", image = "img", lifetimeMs = 600_000, state = "running", startingReads = 0, box: extra = {} } = {}) => {
		const n = ++counter;
		const id = `m${String(n).padStart(8, "0")}`;
		const createdAt = born === undefined ? new Date(START + n) : born(machines.size + 1);
		const machine = {
			id,
			createdAt,
			labels: { ...labels },
			...(name === undefined ? {} : { name }),
			...(file === undefined ? {} : { file: JSON.stringify(file) }),
			network,
			image,
			state,
			startingReads,
			endsAt: new Date(Date.now() + lifetimeMs),
			files: new Map(),
			processes: [],
			deleted: false,
			hidden: 0,
			box: {
				hello: { protocol: PROTOCOL_VERSION, version: VERSION, os: "linux", kind: "linux", arch: "amd64", groups: [...LINUX_GROUPS], fence: "netns" },
				uid: 2510,
				gid: 2510,
				status: {},
				kernel: "6.1.102",
				interfaces: ["lo"],
				cwd: "/work",
				exe: DAEMON,
				...boxPatch,
				...extra,
			},
		};
		machines.set(id, machine);
		return machine;
	};

	/** The machine as get and list read it. */
	const keeps = () => host.facts.labels === "machine";
	const view = (m) => ({
		id: m.id,
		labels: keeps() ? {} : { ...m.labels },
		...(m.name === undefined ? {} : { name: m.name }),
		state: m.deleted || m.why !== undefined ? "gone" : m.state,
		...(m.createdAt === undefined ? {} : { createdAt: new Date(m.createdAt) }),
		endsAt: new Date(m.endsAt),
		...(m.why === undefined ? {} : { why: m.why }),
	});

	/** What the daemon in m answers to one request. */
	function answer(m, { method, params }) {
		const result = (value) => ({ result: value });
		const error = (kind, message) => ({ error: { code: -32000, message, data: { kind } } });
		const displayUp = m.init?.display && m.displayUp;
		if (method === "hello") {
			const groups = displayUp ? [...DESKTOP_GROUPS] : [...LINUX_GROUPS];
			if (m.xvfb && (display === "ok" || display.startsWith("manager "))) m.displayUp = true;
			return result({ ...m.box.hello, groups, kind: displayUp ? "desktop" : "linux", ...(m.box.helloPatch ?? {}) });
		}
		if (method === "files.read" && params.path === "/proc/self/mounts") return result({ data: Buffer.from(mountsOf(m.box)).toString("base64"), size: 0, eof: true });
		if (method === "mount.sync") {
			fake.syncs.push(m.id);
			if (!m.box.served) return error("not_found", "no Archil sync server at /run/agentrun-archil/archil.sock");
			return result({ exitCode: m.box.syncExit ?? 0 });
		}
		if (method === "files.read" && params.path === "/proc/self/status") {
			const { uid, gid } = m.box;
			const fields = { Uid: `${uid}\t${uid}\t${uid}\t${uid}`, Gid: `${gid}\t${gid}\t${gid}\t${gid}`, Groups: "", NoNewPrivs: "1", CapInh: NO_CAPS, CapPrm: NO_CAPS, CapEff: NO_CAPS, CapBnd: NO_CAPS, CapAmb: NO_CAPS, Seccomp: "2", ...m.box.status };
			const text = Object.entries(fields).map(([k, v]) => `${k}:\t${v}\n`).join("");
			return result({ data: Buffer.from(text).toString("base64"), size: text.length, eof: true });
		}
		if (method === "files.read" && params.path === POLICY) {
			// The form init's proxy serves, as init wrote it; box.policy stands for another.
			if (!m.init?.network) return error("not_found", `${params.path}: no such file`);
			const text = `${m.box.policy ?? m.init.network}\n`;
			return result({ data: Buffer.from(text).toString("base64"), size: text.length, eof: true });
		}
		// The label file is root's alone: the daemon's user reads none of it.
		if (method === "files.read" && params.path === LABEL_FILE) return m.file === undefined ? error("not_found", `${params.path}: no such file`) : error("denied", `${params.path}: permission denied`);
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
			if (argv[0] === DAEMON && argv[1] === "probe") {
				// Init's egress relay answers on the loopback where init started a proxy, unless the box says it is down.
				const relayed = m.init?.network && m.box.relay !== "down" ? [RELAY] : [];
				const targets = argv.slice(2).filter((_, i) => i % 2 === 1);
				const report = {
					uid: m.box.uid,
					gid: m.box.gid,
					kernel: m.box.kernel,
					interfaces: m.box.interfaces,
					quiet: m.box.quiet ?? [],
					raised: m.box.raised ?? [],
					reached: [...(m.box.reached ?? []), ...relayed.filter((t) => targets.includes(t))],
					accepted: m.box.accepted ?? targets.filter((t) => !t.endsWith("/udp") && !t.startsWith("[") && t !== RELAY),
				};
				if (m.box.probe === "no-accepted") delete report.accepted;
				return result({ exitCode: 0, stdout: Buffer.from(`${JSON.stringify(report)}\n`).toString("base64"), stderr: "", timedOut: false, truncated: false });
			}
			// A command still running: its answer comes once it ends, which a test never lets it.
			if (argv[0] === "sleep") return undefined;
			return result({ exitCode: 0, stdout: Buffer.from(`${argv.join(" ")}\n`).toString("base64"), stderr: "", timedOut: false, truncated: false });
		}
		if (method === "process.start") {
			const manager = params.argv.some((arg) => arg.includes("xfwm4"));
			if (manager && display === "manager missing") return error("not_found", `${params.argv[0]}: executable file not found in $PATH`);
			const entry = { id: `p${m.processes.length + 1}`, pid: 100 + m.processes.length, argv: params.argv, running: true, exitCode: null, signal: null, stderr: "" };
			if (params.argv[0] === "Xvfb") {
				m.xvfb = entry;
				if (display === "dies") Object.assign(entry, { running: false, exitCode: 1, stderr: "(EE) Fatal server error:\n(EE) Cannot establish any listening sockets\n" });
			}
			// A window manager that starts and ends at once, as xfwm4 does with no session bus.
			if (manager && display === "manager dies") Object.assign(entry, { running: false, exitCode: 1, stderr: "Xfconf could not be initialized\n" });
			m.processes.push(entry);
			return result({ id: entry.id, pid: entry.pid });
		}
		if (method === "process.wait") {
			const entry = m.processes.find((p) => p.id === params.id);
			return entry ? result({ running: entry.running, exitCode: entry.exitCode, signal: entry.signal }) : error("not_found", `no process ${params.id}`);
		}
		if (method === "process.read") {
			const entry = m.processes.find((p) => p.id === params.id);
			return result({ data: Buffer.from(entry.stderr).toString("base64"), offset: 0, next: entry.stderr.length, exited: !entry.running });
		}
		if (method === "deadline.extend") {
			const to = Date.parse(params.at);
			if (!m.init?.max) return error("unsupported", "this computer's deadline cannot move");
			if (to > Date.parse(m.init.max)) return error("limit", `${params.at} is past the maximum deadline ${m.init.max}`);
			if (to < Date.parse(m.init.deadline)) return error("invalid", `${params.at} is earlier than the deadline`);
			m.init.deadline = new Date(to).toISOString();
			return result({ at: m.init.deadline });
		}
		return error("unsupported", `${method} is not a method`);
	}

	/** One process: what it writes, its stdin, its end. */
	function processOf(m, what) {
		const out = feed();
		const err = feed();
		const done = deferred();
		let exitCode;
		const chunks = [];
		const proc = {
			m,
			out,
			err,
			chunks,
			stdinEnded: false,
			onEnd: undefined,
			onWrite: undefined,
			exit(code, stderr = "") {
				if (exitCode !== undefined) return;
				if (stderr) err.push(stderr);
				exitCode = code;
				out.end();
				err.end();
				done.resolve(code);
			},
			api: {
				stdout: out.iterable,
				stderr: err.iterable,
				async write(bytes) {
					if (exitCode !== undefined) throw new Error(`${what} has ended`);
					chunks.push(Buffer.from(bytes));
					await proc.onWrite?.(Buffer.from(bytes));
				},
				async end() {
					proc.stdinEnded = true;
					await proc.onEnd?.();
				},
				wait: () => done.promise,
				async kill() {
					fake.events.push({ machine: m.id, what: `kill ${what}` });
					if (killHangs) return new Promise(() => {});
					proc.exit(137);
				},
			},
		};
		return proc;
	}

	/** init, once the daemon is in place: what start (child) or the entrypoint (pid1) runs. */
	function startInit(m, { deadline, user, display: shown = "", max = "", network = "" }) {
		if (initFails !== undefined || m.daemon === undefined) {
			m.initLog = `${initFails ?? `sh: ${DAEMON}: not found`}\n`;
			return;
		}
		const [uid, gid] = user.split(":").map(Number);
		Object.assign(m.box, { uid, gid });
		m.init = { deadline, user, display: shown, max, network };
	}

	/** Runs one argv as the machine's root shell would. */
	function run(m, argv) {
		const script = scriptOfWords(argv);
		const verb = script === undefined ? rootVerb(argv) : undefined;
		const kind = verb ?? script?.kind ?? (argv[2]?.includes("base64 -d") ? "upload" : argv[2]?.includes("touch") ? "touch" : argv.join(" "));
		fake.events.push({ machine: m.id, what: `run ${kind}` });
		const proc = processOf(m, kind);
		if (hang !== undefined && hang === kind) return proc;
		if (verb !== undefined) {
			const go = () => {
				const stdin = chunks(proc);
				fake.rootRuns.push({ machine: m.id, verb, argv, stdin });
				const given = archil[verb];
				if (given === "hang") return;
				const answered = typeof given === "function" ? given(argv, stdin, m.box) : (given ?? (verb === "preflight" ? { exitCode: 0, output: GOOD_PREFLIGHT } : { exitCode: 0, output: "" }));
				if (answered.exitCode === 0) {
					if (verb === "mount" || verb === "revoke") m.box.mounted = { disk: argv[2], region: argv[3], folder: argv[4] };
					if (verb === "serve") m.box.served = true;
					if (verb === "checkin") Object.assign(m.box, { mounted: undefined, served: false });
				}
				if (answered.output) proc.out.push(answered.output);
				proc.exit(answered.exitCode);
			};
			if (STDIN_VERBS.has(verb)) proc.onEnd = async () => go();
			else queueMicrotask(go);
			return proc;
		}
		if (kind === "labels") {
			// The label file, root's alone: written from stdin with "write", then printed; exit 3 when there is none.
			const [path, write] = script.args;
			const print = () => (m.file === undefined ? proc.exit(3) : (proc.out.push(m.file), proc.exit(0)));
			fake.labelRuns = [...(fake.labelRuns ?? []), { machine: m.id, path, write: write === "write" }];
			if (write === "write") proc.onEnd = async () => ((m.file = Buffer.concat(proc.chunks).toString("utf8")), print());
			else queueMicrotask(print);
			return proc;
		}
		if (kind === "upload") {
			// `head -c <length> | base64 -d > <path>`: done once the base64 text's length has come, end of stdin or not.
			const length = Number(argv[5]);
			let stored = false;
			const done = async () => {
				const text = Buffer.concat(proc.chunks).toString("latin1");
				if (text.length < length || stored) return;
				stored = true;
				m.files.set(argv[4], Buffer.from(text.slice(0, length), "base64"));
				fake.uploads.push({ machine: m.id, path: argv[4], through: "exec" });
				proc.exit(0);
			};
			proc.onWrite = done;
			proc.onEnd = async () => {
				await done();
				proc.exit(1, "base64: invalid input\n");
			};
			return proc;
		}
		if (kind === "touch") {
			queueMicrotask(() => {
				m.files.set(argv[4], Buffer.alloc(0));
				if (m.pid1 && m.files.has(m.pid1.gate ?? "")) maybeEntry(m);
				proc.exit(0);
			});
			return proc;
		}
		if (kind === "install") {
			const [staging, daemon, , , atomic, sha256, nonce] = script.args;
			queueMicrotask(() => {
				const bytes = m.files.get(staging);
				if (install !== 0 || bytes === undefined) {
					proc.out.push(`installing the daemon at ${daemon} failed\n`);
					return proc.exit(install || 5);
				}
				m.files.delete(staging);
				m.daemon = { path: daemon, bytes, atomic: atomic === "1", sha256, ...(nonce ? { marker: nonce } : {}) };
				proc.out.push(`installer 0 root\nsha256 ${sha === "lie" ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex")}\n`);
				if (m.pid1) maybeEntry(m);
				proc.exit(0);
			});
			return proc;
		}
		if (kind === "start") {
			// start: [log, "sh", "-c", INIT, "sh", d, t, w, h, r, v?, m?, n?]
			const [, , , , , , deadline, user, , , shown = "", max = "", network = ""] = script.args;
			queueMicrotask(() => {
				startInit(m, { deadline, user, display: shown, max, network });
				proc.exit(0);
			});
			return proc;
		}
		if (kind === "sockets") {
			// The script's patterns, matched as a shell's: * any characters but "/", the rest as written.
			const named = (path) => script.args.some((pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*")}$`).test(path));
			queueMicrotask(() => {
				let failed = 0;
				for (const path of sockets.filter(named).sort()) {
					if (path === socketsFail) failed = 1;
					proc.out.push(`${path === socketsFail ? "failed" : "closed"} ${path}\n`);
				}
				proc.exit(failed);
			});
			return proc;
		}
		if (kind === "root-only") {
			// The paths made root's alone, recorded on the machine; rootOnlyFail: the script's words and exit 5.
			queueMicrotask(() => {
				if (rootOnlyFail !== undefined) {
					proc.out.push(`${rootOnlyFail}\n`);
					return proc.exit(5);
				}
				m.rootOnly = [...script.args];
				proc.exit(0);
			});
			return proc;
		}
		if (kind === "log") {
			queueMicrotask(() => {
				proc.out.push(m.initLog ?? "");
				proc.exit(0);
			});
			return proc;
		}
		if (kind === "stdio") {
			fake.bridges = (fake.bridges ?? 0) + 1;
			const listening = m.init !== undefined && !(waitingBridges > 0);
			if (m.init !== undefined && waitingBridges > 0) waitingBridges--;
			if (!listening) {
				queueMicrotask(() => proc.exit(1, "computerd stdio: no daemon listens at /run/agentrun/computerd.sock (connect: no such file or directory)\n"));
				return proc;
			}
			m.bridges = [...(m.bridges ?? []), proc];
			let buffered = "";
			proc.onWrite = async (bytes) => {
				// A machine that vanished under a hung transport: what is sent is taken, and nothing ever answers.
				if (m.hung) return;
				buffered += bytes.toString("utf8");
				let at;
				while ((at = buffered.indexOf("\n")) >= 0) {
					const request = JSON.parse(buffered.slice(0, at));
					buffered = buffered.slice(at + 1);
					if (typeof request.id !== "number") continue;
					fake.requests.push({ machine: m.id, method: request.method, params: request.params });
					fake.events.push({ machine: m.id, what: `daemon ${request.method}` });
					await onStep(request.method, m);
					const reply = answer(m, request);
					if (reply === undefined) continue;
					proc.out.push(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...reply })}\n`);
				}
			};
			return proc;
		}
		queueMicrotask(() => proc.exit(127, `the fake host runs only the adapter's scripts, not ${argv.join(" ").slice(0, 80)}`));
		return proc;
	}

	/** A pid1 machine's entrypoint becomes init once the daemon is in place with its marker this create's nonce, and the
	 *  gate when it has one. A daemon with no marker, or another (one the image had), is never started. */
	function maybeEntry(m) {
		if (m.init || m.daemon === undefined || m.daemon.marker === undefined || m.daemon.marker !== m.pid1.nonce) return;
		if (m.pid1.gate !== undefined && !m.files.has(m.pid1.gate)) return;
		const args = m.pid1.initArgs;
		const flag = (name) => args[args.indexOf(name) + 1];
		startInit(m, {
			deadline: flag("--deadline"),
			user: flag("--user"),
			display: m.pid1.display,
			max: args.includes("--max-deadline") ? flag("--max-deadline") : "",
			network: args.includes("--network") ? flag("--network") : "",
		});
	}
	const chunks = (proc) => (proc.chunks.length === 0 ? undefined : Buffer.concat(proc.chunks).toString("utf8"));

	const host = {
		descriptor,
		facts: {
			daemon: "child",
			isolation: "microvm",
			lifetime: "vendor",
			maxLifetimeMs: 24 * 3_600_000,
			arch: "amd64",
			vendorAgentPorts: [7777],
			...facts,
		},
		errorCode(error) {
			const name = error?.name;
			if (name === "AbortError") return "aborted";
			if (name === "NotFound") return "not_found";
			if (name === "Refused") return "invalid";
			if (name === "Late") return "timeout";
			return "vendor";
		},
		async create(req, ctx) {
			fake.calls.push(["create", req]);
			await onStep("create", undefined);
			if (create === "fail") throw new Refused("400: no such image");
			const make = () => {
				const kept = keeps() ? { name: req.name } : { labels: req.labels };
				const m = add({ ...kept, network: req.egress ? "open" : "none", image: req.image, lifetimeMs: req.lifetimeMs, state: starting > 0 ? "starting" : "running", startingReads: starting });
				m.hidden = unlisted;
				m.flaps = [...flaps];
				m.request = req;
				if (stale) m.listedAs = { ...view(m), state: "running" };
				if (req.command) {
					// The entrypoint's words: the daemon, the wait, the home, the display, the nonce, then --gate <path> or not,
					// then init's.
					const args = req.command.slice(4);
					const gate = args[5] === "--gate" ? args[6] : undefined;
					m.pid1 = { display: args[3], nonce: args[4], gate, initArgs: args.slice(gate === undefined ? 5 : 7) };
				}
				return m;
			};
			if (create === "lost") {
				make();
				throw new Late("the answer never came back");
			}
			if (create === "lost-answered") {
				// A host whose own client gave up on the create's reply, thrown as a HostError timeout (Agent37's REST, Daytona's).
				make();
				throw new HostError("timeout", "POST /v1/instances did not answer within 300 s");
			}
			if (create === "broken") {
				make();
				throw new Error("502: Bad Gateway");
			}
			if (create === "hold") {
				const wait = deferred();
				held.push(wait);
				await wait.promise;
			}
			void ctx;
			return { id: make().id };
		},
		async get(id, ctx) {
			const m = machines.get(id);
			await step("get", ctx, m);
			if (m?.deleted && m.lingering?.reads > 0) {
				m.lingering.reads--;
				return { ...view(m), state: m.lingering.state };
			}
			if (gone(m)) return undefined;
			if (m.startingReads > 0 && --m.startingReads === 0) m.state = "running";
			if (m.state === "running" && failed !== undefined && m.request !== undefined) m.why = failed;
			return view(m);
		},
		async list(labels, ctx) {
			await step("list", ctx);
			// A host that keeps no labels lists every machine.
			const matched = [...machines.values()].filter((m) => keeps() || Object.entries(labels).every(([k, v]) => m.labels[k] === v));
			if (stale) return matched.filter((m) => m.listedAs !== undefined).map((m) => structuredClone(m.listedAs));
			const flapped = new Set(matched.filter((m) => m.flaps?.length > 0 && m.flaps.shift() === false));
			const listed = matched.filter((m) => (!m.deleted || m.lingering?.lists > 0) && !(m.hidden > 0) && !flapped.has(m));
			for (const m of matched) if (m.hidden > 0) m.hidden--;
			for (const m of listed) if (m.deleted && m.lingering?.lists > 0) m.lingering.lists--;
			return listed.map(view);
		},
		async delete(id, ctx) {
			const m = machines.get(id);
			await step("delete", ctx, m);
			if (gone(m) || m.deleted) return;
			m.deleted = true;
			fake.events.push({ machine: id, what: "delete" });
			if (lingers) m.lingering = { reads: lingers.reads ?? 0, lists: lingers.lists ?? 0, state: lingers.state ?? "running" };
		},
		async exec(id, argv, ctx) {
			const m = machines.get(id);
			await step(`exec ${scriptOfWords(argv)?.kind ?? rootVerb(argv) ?? "other"}`, ctx, m);
			if (gone(m)) throw new NotFound(`machine ${id} not found`);
			return run(m, argv).api;
		},
		...(fileApi
			? {
					async upload(id, path, bytes, ctx) {
						const m = machines.get(id);
						await step("upload", ctx, m);
						if (gone(m)) throw new NotFound(`machine ${id} not found`);
						m.files.set(path, Buffer.from(bytes));
						// What the root-only script had made root's alone when the daemon came in, if it ran.
						fake.uploads.push({ machine: id, path, through: "upload", ...(m.rootOnly ? { rootOnly: [...m.rootOnly] } : {}) });
					},
				}
			: {}),
		...(timer === "none"
			? {}
			: {
					// The vendor's timer, or the janitor's deadline label, which this fake rounds up to a whole second.
					async extend(id, end, ctx) {
						const m = machines.get(id);
						await step("extend", ctx, m);
						if (gone(m)) throw new NotFound(`machine ${id} not found`);
						if (timer === "limit") throw new HostError("limit", "no whole number of seconds reaches it; nothing moved");
						const most = Date.parse((keeps() ? JSON.parse(m.file ?? "{}") : m.labels)["agentrun.computer.max-deadline"]);
						if (host.facts.lifetime === "janitor") {
							m.labels[DEADLINE_LABEL] = new Date(Math.min(Math.ceil(end.getTime() / 1000) * 1000, most)).toISOString();
							return;
						}
						m.endsAt = new Date(Math.min(end.getTime(), most));
						// A vendor that keeps no label change reads its moved end as the deadline label (src/host.ts, extend).
						m.labels[DEADLINE_LABEL] = m.endsAt.toISOString();
					},
				}),
	};

	fake.host = host;
	fake.add = add;
	/** Lets every held create go on, or, given an error, fail with it (having made nothing). */
	fake.release = async (error) => {
		for (const one of held.splice(0)) error === undefined ? one.resolve() : one.reject(error);
		await new Promise((done) => setTimeout(done, 10));
	};
	/**
	 * A machine deleted out from under the adapter, by the vendor's own API: get reads it gone and the listing leaves it
	 * out. stream "end": every bridge into it ends, as a VM that died closes its exec streams; "hang": the bridges stay
	 * open and nothing answers, as a dead tunnel nobody has noticed yet.
	 */
	fake.vanish = (id, stream = "end") => {
		const m = machines.get(id);
		m.deleted = true;
		fake.events.push({ machine: id, what: `vanish (${stream})` });
		if (stream === "hang") m.hung = true;
		else for (const bridge of m.bridges ?? []) bridge.exit(255);
	};
	/** Every machine not deleted. */
	fake.live = () => [...machines.values()].filter((m) => !m.deleted);
	fake.creates = () => fake.calls.filter(([name]) => name === "create").length;
	return fake;
}
