// The adapter's one fake host: a MachineHost (src/host.ts) over machines in memory, for the adapter's own unit tests
// (hosted-provider.test.mjs, hosted-sweep.test.mjs). It plays no vendor: it keeps what create is given, answers get and
// list from it, and runs the adapter's scripts (src/hosted/scripts.ts) the way a root shell would: install (the
// upload's sha256), start (init, detached; its words to the log), log, stdio (a bridge whose requests a computerd answers
// as the real one does), an Archil computer's root steps by verb, and a pid1 machine's entrypoint. Nothing reaches the
// network, and no vendor SDK is loaded.
import { createHash } from "node:crypto";
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
 * A fake host. Options:
 *  - facts: over the defaults (child daemon, vendor lifetime, network read back, archil mounts);
 *  - create: "ok", "fail" (refused: nothing made), "hold" (answers once fake.release() is called), "lost" (makes the
 *    machine, then throws Late: its id never comes back), "broken" (makes it, then throws a plain error);
 *  - starting: how many reads a new machine answers starting before it runs;
 *  - unlisted: how many listings a new machine is left out of;
 *  - flaps: for a new machine, whether each listing after its create shows it (true) or leaves it out (false), in turn,
 *    until they run out; then every listing shows it;
 *  - born(n): the creation time of the n-th machine made (1, 2, ...), or undefined for none; default the order made;
 *  - size: the size every machine reads back; a machine reads back the GPUs its create asked for;
 *  - sha: "ok" or "lie"; install: the install's exit code; initFails: words init writes before it exits;
 *  - notListening: how many bridges find no daemon before one does;
 *  - box: what the daemon reports (hello patch, uid, gid, status, interfaces, reached, accepted, quiet, raised);
 *  - display: "ok", "never" or "dies"; drift: the vendor's own drift words a read gives;
 *  - network: the vendor's network read back, over what create asked ("none"/"open"/{ other });
 *  - lingers: { reads, lists } after a delete; fileApi: false for a host with no upload;
 *  - onStep(step, machine): at the start of every host call and daemon request, so a test can abort a signal there;
 *  - hang: a script's kind ("install", ...) whose process never ends; killHangs: a process's kill that never settles;
 *  - archil: root verbs' answers, as fake-archil.mjs's;
 *  - sockets: the path sockets every machine holds, which the sockets script closes where a pattern names them;
 *    socketsFail: a path among them whose chmod fails.
 * fake.events records every exec by script or verb, every daemon method and every delete, per machine.
 */
export function fakeHost({
	facts = {},
	create = "ok",
	starting = 0,
	unlisted = 0,
	flaps = [],
	born,
	size,
	sha = "ok",
	install = 0,
	initFails,
	notListening = 0,
	box: boxPatch = {},
	display = "ok",
	drift,
	network: networkPatch,
	lingers,
	fileApi = true,
	onStep = () => {},
	archil = {},
	timer = "ok",
	hang,
	killHangs = false,
	sockets = [],
	socketsFail,
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

	const add = ({ labels = {}, network = "none", image = "img", lifetimeMs = 600_000, state = "running", startingReads = 0, box: extra = {} } = {}) => {
		const n = ++counter;
		const id = `m${String(n).padStart(8, "0")}`;
		const createdAt = born === undefined ? new Date(START + n) : born(machines.size + 1);
		const machine = {
			id,
			createdAt,
			labels: { ...labels },
			network,
			image,
			state,
			startingReads,
			endsAt: new Date(Date.now() + lifetimeMs),
			timerMoved: false,
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

	/** The machine as get reads it. */
	const view = (m) => ({
		id: m.id,
		labels: { ...m.labels },
		state: m.deleted ? "going" : m.state,
		...(networkPatch !== undefined ? { network: networkPatch } : { network: m.network }),
		image: { resolved: `${m.image}-id` },
		...(m.createdAt === undefined ? {} : { createdAt: new Date(m.createdAt) }),
		...(size === undefined ? {} : { size: { ...size } }),
		...(m.request?.gpu === undefined ? {} : { gpu: { ...m.request.gpu } }),
		endsAt: new Date(m.endsAt),
		timerMoved: m.timerMoved,
		...(drift ? { drift: [...drift] } : {}),
	});

	/** What the daemon in m answers to one request. */
	function answer(m, { method, params }) {
		const result = (value) => ({ result: value });
		const error = (kind, message) => ({ error: { code: -32000, message, data: { kind } } });
		const displayUp = m.init?.display && m.displayUp;
		if (method === "hello") {
			const groups = displayUp ? [...DESKTOP_GROUPS] : [...LINUX_GROUPS];
			if (m.xvfb && display === "ok") m.displayUp = true;
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
				const targets = argv.slice(2).filter((_, i) => i % 2 === 1);
				const report = { uid: m.box.uid, gid: m.box.gid, kernel: m.box.kernel, interfaces: m.box.interfaces, quiet: m.box.quiet ?? [], raised: m.box.raised ?? [], reached: m.box.reached ?? [], accepted: m.box.accepted ?? targets.filter((t) => !t.endsWith("/udp") && !t.startsWith("[")) };
				if (m.box.probe === "no-accepted") delete report.accepted;
				return result({ exitCode: 0, stdout: Buffer.from(`${JSON.stringify(report)}\n`).toString("base64"), stderr: "", timedOut: false, truncated: false });
			}
			return result({ exitCode: 0, stdout: Buffer.from(`${argv.join(" ")}\n`).toString("base64"), stderr: "", timedOut: false, truncated: false });
		}
		if (method === "process.start") {
			if (params.argv[0] === "no-such-program") return error("not_found", "no-such-program: executable file not found in $PATH");
			const entry = { id: `p${m.processes.length + 1}`, pid: 100 + m.processes.length, argv: params.argv, running: true, exitCode: null, signal: null, stderr: "" };
			if (params.argv[0] === "Xvfb") {
				m.xvfb = entry;
				if (display === "dies") Object.assign(entry, { running: false, exitCode: 1, stderr: "(EE) Fatal server error:\n(EE) Cannot establish any listening sockets\n" });
			}
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
	function startInit(m, { deadline, user, display: shown = "", max = "" }) {
		if (initFails !== undefined || m.daemon === undefined) {
			m.initLog = `${initFails ?? `sh: ${DAEMON}: not found`}\n`;
			return;
		}
		const [uid, gid] = user.split(":").map(Number);
		Object.assign(m.box, { uid, gid });
		m.init = { deadline, user, display: shown, max };
	}

	/** Runs one argv as the machine's root shell would. */
	function run(m, argv) {
		const script = scriptOfWords(argv);
		const verb = script === undefined ? rootVerb(argv) : undefined;
		const kind = verb ?? script?.kind ?? (argv[2]?.includes("cat >") ? "upload" : argv[2]?.includes("touch") ? "touch" : argv.join(" "));
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
		if (kind === "upload") {
			proc.onEnd = async () => {
				m.files.set(argv[4], Buffer.concat(proc.chunks));
				fake.uploads.push({ machine: m.id, path: argv[4], through: "exec" });
				proc.exit(0);
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
			// start: [log, "sh", "-c", INIT, "sh", d, t, w, h, r, v?, m?]
			const [, , , , , , deadline, user, , , shown = "", max = ""] = script.args;
			queueMicrotask(() => {
				startInit(m, { deadline, user, display: shown, max });
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
			let buffered = "";
			proc.onWrite = async (bytes) => {
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
		startInit(m, { deadline: flag("--deadline"), user: flag("--user"), display: m.pid1.display, max: args.includes("--max-deadline") ? flag("--max-deadline") : "" });
	}
	const chunks = (proc) => (proc.chunks.length === 0 ? undefined : Buffer.concat(proc.chunks).toString("utf8"));

	const host = {
		id: "fakehost",
		facts: {
			daemon: "child",
			isolation: "microvm",
			lifetime: "vendor",
			maxLifetimeMs: 24 * 3_600_000,
			arch: "amd64",
			vendorAgentPorts: [7777],
			networkReadBack: true,
			gpuReadBack: true,
			network: ["none"],
			mounts: ["archil"],
			release: ["delete"],
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
				const m = add({ labels: req.labels, network: req.network, image: req.image, lifetimeMs: req.lifetimeMs ?? 600_000, state: starting > 0 ? "starting" : "running", startingReads: starting });
				m.hidden = unlisted;
				m.flaps = [...flaps];
				m.request = req;
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
			return { ok: true, value: { id: make().id } };
		},
		async get(id, ctx) {
			const m = machines.get(id);
			await step("get", ctx, m);
			if (m?.deleted && m.lingering?.reads > 0) {
				m.lingering.reads--;
				return { ok: true, value: { ...view(m), state: "running" } };
			}
			if (gone(m)) return { ok: true, value: undefined };
			if (m.startingReads > 0 && --m.startingReads === 0) m.state = "running";
			return { ok: true, value: view(m) };
		},
		async list(labels, ctx) {
			await step("list", ctx);
			const matched = [...machines.values()].filter((m) => Object.entries(labels).every(([k, v]) => m.labels[k] === v));
			const flapped = new Set(matched.filter((m) => m.flaps?.length > 0 && m.flaps.shift() === false));
			const listed = matched.filter((m) => (!m.deleted || m.lingering?.lists > 0) && !(m.hidden > 0) && !flapped.has(m));
			for (const m of matched) if (m.hidden > 0) m.hidden--;
			for (const m of listed) if (m.deleted && m.lingering?.lists > 0) m.lingering.lists--;
			return { ok: true, value: listed.map(view) };
		},
		async delete(id, ctx) {
			const m = machines.get(id);
			await step("delete", ctx, m);
			if (gone(m) || m.deleted) return { ok: true, value: undefined };
			m.deleted = true;
			fake.events.push({ machine: id, what: "delete" });
			if (lingers) m.lingering = { reads: lingers.reads ?? 0, lists: lingers.lists ?? 0 };
			return { ok: true, value: undefined };
		},
		async exec(id, argv, opts, ctx) {
			const m = machines.get(id);
			await step(`exec ${scriptOfWords(argv)?.kind ?? rootVerb(argv) ?? "other"}`, ctx, m);
			if (gone(m)) throw new NotFound(`machine ${id} not found`);
			void opts;
			return { ok: true, value: run(m, argv).api };
		},
		...(fileApi
			? {
					async upload(id, path, bytes, ctx) {
						const m = machines.get(id);
						await step("upload", ctx, m);
						if (gone(m)) throw new NotFound(`machine ${id} not found`);
						m.files.set(path, Buffer.from(bytes));
						fake.uploads.push({ machine: id, path, through: "upload" });
						return { ok: true, value: undefined };
					},
				}
			: {}),
		async setTimer(id, { end, most }, ctx) {
			const m = machines.get(id);
			await step("setTimer", ctx, m);
			if (gone(m)) throw new NotFound(`machine ${id} not found`);
			if (timer === "limit") return { ok: false, error: { code: "limit", message: "no whole number of seconds reaches it; nothing moved" } };
			m.endsAt = new Date(Math.min(end.getTime(), most.getTime()));
			m.timerMoved = true;
			return { ok: true, value: undefined };
		},
	};

	fake.host = host;
	fake.add = add;
	/** Lets every held create go on. */
	fake.release = async () => {
		for (const one of held.splice(0)) one.resolve();
		await new Promise((done) => setTimeout(done, 10));
	};
	/** Every machine not deleted. */
	fake.live = () => [...machines.values()].filter((m) => !m.deleted);
	fake.creates = () => fake.calls.filter(([name]) => name === "create").length;
	return fake;
}
