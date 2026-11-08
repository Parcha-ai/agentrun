// A fake of the slice of E2B's JS SDK (the `e2b` package, its Sandbox class) that E2BProvider takes, for its unit
// tests. It records every call with the options it was given, and plays the SDK's behaviour as e2b@2.63.0's
// dist/index.mjs has it: create (statics on the class, :6009-6040) keeps the metadata, timeout and network it is given;
// getInfo throws SandboxNotFoundError for a sandbox it does not know (:5421-5465); kill answers false for one it does not
// know (:5398-5410); setTimeout sets the end to now plus the timeout in whole seconds (:5529-5541, :502-504); list pages
// running and paused sandboxes whose metadata holds every pair asked for (:5785-5849); connect hands back a sandbox
// with commands and files (:6065-6083). A sandbox's commands.run runs the provider's three shell commands as a root
// shell would: install (the upload's sha256), init (background, a daemon that answers on its socket from then on) and
// stdio (background, with stdin: requests sent with sendStdin are answered through onStdout as computerd would). An SDK
// call whose signal is aborted rejects, as the SDK's fetch does. Nothing reaches the network, and no SDK is loaded.
import { createHash } from "node:crypto";

export const VERSION = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../package.json", import.meta.url), "utf8")).version;
export const DAEMON = "/opt/agentrun/computerd";
export const KEY = "e2b_fake_computer_key_0123456789";
export const DESKTOP_GROUPS = ["exec", "files", "processes", "screen", "input.pointer", "input.keys"];
export const LINUX_GROUPS = ["exec", "files", "processes"];
const NO_CAPS = "0000000000000000";

export class SandboxNotFoundError extends Error {
	name = "SandboxNotFoundError";
}
export class AuthenticationError extends Error {
	name = "AuthenticationError";
}
export class InvalidArgumentError extends Error {
	name = "InvalidArgumentError";
}
export class TimeoutError extends Error {
	name = "TimeoutError";
}
export class CommandExitError extends Error {
	name = "CommandExitError";
	constructor(result) {
		super(result.error ?? `exit status ${result.exitCode}`);
		this.result = result;
	}
	get exitCode() {
		return this.result.exitCode;
	}
	get stdout() {
		return this.result.stdout;
	}
	get stderr() {
		return this.result.stderr;
	}
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

const aborted = () => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });

/** The words of a shell command the provider builds: sh -c '<script>' sh '<arg>'..., each word single-quoted. */
export function wordsOf(command) {
	const words = [];
	let at = 0;
	while (at < command.length) {
		if (command[at] === " ") {
			at++;
			continue;
		}
		let word = "";
		while (at < command.length && command[at] !== " ") {
			if (command[at] === "'") {
				const end = command.indexOf("'", at + 1);
				word += command.slice(at + 1, end);
				at = end + 1;
			} else if (command[at] === "\\") {
				word += command[at + 1];
				at += 2;
			} else word += command[at++];
		}
		words.push(word);
	}
	return words;
}

/** Which of the provider's scripts a command is, and its arguments. */
export function scriptOf(command) {
	const words = wordsOf(command);
	const mark = /^# agentrun-computer: (\w+)\n/.exec(words[2] ?? "");
	if (words[0] !== "sh" || words[1] !== "-c" || mark === null) return undefined;
	return { kind: mark[1], args: words.slice(4) };
}

let counter = 0;
const newId = () => `i${String(++counter).padStart(19, "0")}`;

/**
 * A fake E2B. Options:
 *  - templates: alias → template id (default desktop → tpl-desktop, base → tpl-base);
 *  - info: fields a new sandbox's getInfo reports over what create gave (allowInternetAccess, network, lifecycle, ...);
 *  - create: "ok", "fail" (InvalidArgumentError, nothing made), "auth" (AuthenticationError), "hold" (settles only
 *    when fake.release() is called), "lost" (makes the sandbox, then throws TimeoutError: its id never comes back),
 *    "broken" (makes the sandbox, then throws a plain error, as a 5xx whose sandbox was made anyway);
 *  - unlisted: how many listings a sandbox create makes is left out of before list shows it (default 0);
 *  - sha: "ok" or "lie" (install prints a sha256 that is not the file's);
 *  - install: exit code of the install script (default 0);
 *  - initFails: words init writes to stderr before it exits 1 (no daemon listens);
 *  - notListening: how many bridges find no daemon listening before one does;
 *  - box: what the daemon reports, over the defaults (hello, uid, gid, status fields, kernel, reached, accepted (the
 *    probe targets that accept and send nothing back: by default every IPv4 TCP one with no internet access), display),
 *    udpAnswers (with no internet access, a host:port/udp target answers anyway, as it would were E2B's firewall to let
 *    DNS over UDP out), probe: "no-accepted" (the probe's report has no accepted list), and what
 *    `computerd probe --diagnose` prints (diagnosis), or diagnose: "fails" (exit 1) or "garbage" (not JSON);
 *  - display: "ok" (Xvfb brings the display up after one hello), "never" (the server runs, the display never comes),
 *    "dies" (the server exits 1 at once);
 *  - lingers: { reads, lists }: after a kill, getInfo still reads it running for `reads` reads, and list still lists it
 *    for `lists` listings;
 *  - onStep(step, sandbox): called at the start of every SDK call and every daemon request, by name, so a test can
 *    abort the caller's signal there;
 *  - processPage: how many processes one process.list reply holds before it is truncated (default 8), as the daemon's
 *    reply fills;
 *  - killMs: how long a signalled process takes to end (default 30): process.signal only sends the signal, as the
 *    daemon's does, and process.wait waits up to its timeoutMs for the end.
 * The stream's servers hold their ports, x11vnc its -rfbport and noVNC its --listen (or a test's entry its port): one
 * started while a running process holds its port ends at once, unable to bind, and netstat lists a port only while a
 * running process holds it.
 */
export function fakeE2B({
	templates = { desktop: "tpl-desktop", base: "tpl-base" },
	info: infoPatch = {},
	create = "ok",
	sha = "ok",
	install = 0,
	initFails,
	notListening = 0,
	box: boxPatch = {},
	display = "ok",
	lingers,
	onStep = () => {},
	processPage = 8,
	killMs = 30,
	unlisted = 0,
} = {}) {
	const calls = [];
	const sandboxes = new Map();
	const held = [];
	const fake = { calls, sandboxes, requests: [], uploads: [], kills: [], bridges: [], logs: [] };
	let waitingBridges = notListening;
	const record = (name, ...args) => calls.push([name, ...args]);
	const step = async (name, opts, sandbox) => {
		await onStep(name, sandbox);
		if (opts?.signal?.aborted) throw aborted();
	};

	const add = ({ template = "desktop", metadata = {}, timeoutMs = 300_000, allowInternetAccess = true, network = {}, lifecycle, state = "running", box: extra = {} } = {}) => {
		const id = newId();
		const now = Date.now();
		const sandbox = {
			id,
			template,
			templateId: templates[template] ?? template,
			metadata: { ...metadata },
			startedAt: new Date(now),
			endAt: new Date(now + Math.ceil(timeoutMs / 1000) * 1000),
			state,
			allowInternetAccess,
			network: { ...network },
			lifecycle,
			files: new Map(),
			daemon: undefined,
			init: undefined,
			processes: [],
			killed: false,
			lingering: undefined,
			box: {
				hello: { version: VERSION, os: "linux", kind: "linux", arch: "amd64", groups: [...LINUX_GROUPS] },
				uid: 1000,
				gid: 1000,
				status: {},
				kernel: "6.1.102",
				cwd: "/work",
				exe: DAEMON,
				...boxPatch,
				...extra,
			},
		};
		sandboxes.set(id, sandbox);
		return sandbox;
	};

	/** What getInfo reports of a sandbox (index.mjs:5432-5465). */
	const infoOf = (sb) => ({
		sandboxId: sb.id,
		templateId: sb.templateId,
		...(sb.template !== sb.templateId ? { name: sb.template } : {}),
		metadata: { ...sb.metadata },
		allowInternetAccess: sb.allowInternetAccess,
		envdVersion: "0.6.4",
		startedAt: new Date(sb.startedAt),
		endAt: new Date(sb.endAt),
		state: sb.state,
		cpuCount: 2,
		memoryMB: 2048,
		network: { allowOut: undefined, denyOut: sb.allowInternetAccess === false ? ["0.0.0.0/0"] : undefined, allowPublicTraffic: sb.network.allowPublicTraffic },
		lifecycle: sb.lifecycle === undefined ? undefined : { onTimeout: sb.lifecycle.onTimeout, autoResume: false },
		volumeMounts: [],
		...infoPatch,
	});

	const gone = (sb) => sb === undefined || (sb.killed && !(sb.lingering?.reads > 0));

	/** The port a stream server listens on, by its argv, or undefined for any other program. */
	const portOf = (argv) => {
		const after = (flag, fallback) => (argv.includes(flag) ? Number(argv[argv.indexOf(flag) + 1]) : fallback);
		if (/(^|\/)x11vnc$/.test(argv[0])) return after("-rfbport", 5900);
		if (/(^|\/)novnc_proxy$/.test(argv[0])) return after("--listen", 6080);
		return undefined;
	};
	/** A process ends: its exit fields set, and every process.wait on it answered. */
	const finish = (entry, fields) => {
		if (!entry.running) return;
		Object.assign(entry, { running: false, exitCode: null, signal: null, ...fields });
		for (const wake of (entry.waiters ?? []).splice(0)) wake();
	};
	const exitOf = (entry) => ({ running: entry.running, exitCode: entry.exitCode, signal: entry.signal });

	/** What the daemon in sb answers to one request, or undefined for none. */
	function answer(sb, request) {
		const { method, params } = request;
		const result = (value) => ({ result: value });
		const error = (kind, message) => ({ error: { code: -32000, message, data: { kind } } });
		const displayUp = sb.init?.display && sb.displayUp;
		if (method === "hello") {
			const groups = displayUp ? [...LINUX_GROUPS, "screen", "input.pointer", "input.keys"] : [...LINUX_GROUPS];
			const kind = displayUp ? "desktop" : "linux";
			if (sb.xvfb && display === "ok") sb.displayUp = true;
			return result({ ...sb.box.hello, groups, kind, ...(sb.box.helloPatch ?? {}) });
		}
		if (method === "ping") return result({});
		if (method === "files.read" && params.path === "/proc/self/status") {
			const fields = { Uid: `${sb.box.uid}\t${sb.box.uid}\t${sb.box.uid}\t${sb.box.uid}`, Gid: `${sb.box.gid}\t${sb.box.gid}\t${sb.box.gid}\t${sb.box.gid}`, Groups: "", NoNewPrivs: "1", CapInh: NO_CAPS, CapPrm: NO_CAPS, CapEff: NO_CAPS, CapBnd: NO_CAPS, CapAmb: NO_CAPS, ...sb.box.status };
			const text = Object.entries(fields).map(([k, v]) => `${k}:\t${v}\n`).join("");
			return result({ data: Buffer.from(text).toString("base64"), size: text.length, eof: true });
		}
		if (method === "files.stat") {
			if (params.path === "/proc/self/cwd") return result({ path: params.path, type: "symlink", target: sb.box.cwd });
			if (params.path === "/proc/self/exe") return result({ path: params.path, type: "symlink", target: sb.box.exe });
			return error("not_found", `${params.path}: no such file`);
		}
		if (method === "files.write") {
			sb.files.set(params.path, Buffer.from(params.data ?? "", "base64"));
			return result({ size: Buffer.from(params.data ?? "", "base64").length });
		}
		if (method === "exec.run") {
			const argv = params.argv;
			const out = (text, exitCode = 0) => result({ exitCode, stdout: Buffer.from(text).toString("base64"), stderr: "", timedOut: false, truncated: false });
			if (argv[0] === DAEMON && argv[1] === "probe" && argv[2] === "--diagnose") {
				if (sb.box.diagnose === "fails") return result({ exitCode: 1, stdout: "", stderr: Buffer.from("computerd: probe: a diagnosis failed\n").toString("base64"), timedOut: false, truncated: false });
				if (sb.box.diagnose === "garbage") return out("not a diagnosis\n");
				const diagnosis = sb.box.diagnosis ?? { uid: sb.box.uid, gid: sb.box.gid, kernel: sb.box.kernel, verdict: "none", results: [] };
				return out(`${JSON.stringify(diagnosis)}\n`);
			}
			if (argv[0] === DAEMON && argv[1] === "probe") {
				const targets = argv.slice(2).filter((_, i) => i % 2 === 1);
				// With no internet access, E2B's firewall accepts each IPv4 TCP connection and then closes it with nothing
				// sent back (docs network/internet-access, "Behavior of blocked TCP connections"; e2b-dev/infra@ff3922213
				// tcpfirewall/handlers.go); the live runs of 2026-11-07 read the IPv6 target refused. Non-TCP to the deny
				// set denyOut fills is dropped in nftables (infra@ff3922213 sandbox/network/firewall.go, installRules rule
				// 5), so a host:port/udp target gets no reply: refused, as the live diagnostic read 53/udp everywhere. Open
				// answers every target.
				const udp = (target) => target.endsWith("/udp");
				const none = sb.allowInternetAccess === false;
				const reached = sb.box.reached ?? (none ? (sb.box.udpAnswers ? targets.filter(udp) : []) : targets);
				const accepted = sb.box.accepted ?? (none ? targets.filter((target) => !udp(target) && !target.startsWith("[")) : []);
				const report = { uid: sb.box.uid, gid: sb.box.gid, kernel: sb.box.kernel, reached, accepted };
				if (sb.box.probe === "no-accepted") delete report.accepted;
				return out(`${JSON.stringify(report)}\n`);
			}
			if (argv[0] === "sh" && /netstat/.test(argv[2] ?? "")) {
				const ports = [...argv[2].matchAll(/:(\d+) /g)].map((match) => Number(match[1]));
				return out("", ports.length > 0 && ports.every((port) => sb.processes.some((p) => p.running && p.port === port)) ? 0 : 1);
			}
			return out(`${argv.join(" ")}\n`);
		}
		if (method === "process.start") {
			const entry = { id: `p${sb.processes.length + 1}`, pid: 100 + sb.processes.length, argv: params.argv, running: true, exitCode: null, signal: null, stderr: "" };
			if (params.argv[0] === "Xvfb") {
				sb.xvfb = entry;
				if (display === "dies") Object.assign(entry, { running: false, exitCode: 1, stderr: "(EE) Fatal server error:\n(EE) Cannot establish any listening sockets\n" });
			}
			const port = portOf(params.argv);
			if (port !== undefined) {
				if (sb.processes.some((p) => p.running && p.port === port)) Object.assign(entry, { running: false, exitCode: 1, stderr: `bind: port ${port}: address already in use\n` });
				else entry.port = port;
			}
			sb.processes.push(entry);
			return result({ id: entry.id, pid: entry.pid });
		}
		if (method === "process.wait") {
			const entry = sb.processes.find((p) => p.id === params.id);
			if (entry === undefined) return error("not_found", `no process ${params.id}`);
			if (!entry.running || !(params.timeoutMs > 0)) return result(exitOf(entry));
			return new Promise((done) => {
				const answer = () => {
					clearTimeout(timer);
					done(result(exitOf(entry)));
				};
				const timer = setTimeout(answer, params.timeoutMs);
				(entry.waiters ??= []).push(answer);
			});
		}
		if (method === "process.read") {
			const entry = sb.processes.find((p) => p.id === params.id);
			return result({ data: Buffer.from(entry.stderr).toString("base64"), offset: 0, next: entry.stderr.length, exited: !entry.running });
		}
		if (method === "process.list") {
			const from = params?.from ?? 0;
			const page = sb.processes.slice(from, from + processPage);
			const processes = page.map((p) => ({ id: p.id, pid: p.pid, argv: p.argv, argvClipped: false, running: p.running, exitCode: p.exitCode, signal: p.signal }));
			return result({ processes, truncated: from + page.length < sb.processes.length, next: from + page.length });
		}
		if (method === "process.signal") {
			const entry = sb.processes.find((p) => p.id === params.id);
			if (entry === undefined) return error("not_found", `no process ${params.id}`);
			// The signal is sent; the process ends a moment later, and holds its port until then.
			if (entry.running) setTimeout(() => finish(entry, { signal: params.signal }), killMs);
			return result({});
		}
		if (method === "deadline.extend") {
			const to = Date.parse(params.at);
			if (sb.init.max === "") return error("unsupported", "this computer's deadline cannot move");
			if (to > Date.parse(sb.init.max)) return error("limit", `${params.at} is past the maximum deadline ${sb.init.max}`);
			if (to < Date.parse(sb.init.deadline)) return error("invalid", `${params.at} is earlier than the deadline`);
			sb.init.deadline = new Date(to).toISOString();
			return result({ at: sb.init.deadline });
		}
		return error("unsupported", `${method} is not a method`);
	}

	/** A background command handle (CommandHandle, index.mjs:2683-2810). */
	function handleOf(sb, { onStdout, onStderr } = {}) {
		const exited = deferred();
		const pid = 1000 + sb.processes.length + fake.bridges.length + Math.floor(Math.random() * 1000);
		const handle = {
			pid,
			stdout: "",
			stderr: "",
			exitCode: undefined,
			killed: false,
			disconnected: false,
			end(exitCode, stderr = "") {
				if (handle.exitCode !== undefined) return;
				if (stderr) {
					handle.stderr += stderr;
					onStderr?.(stderr);
				}
				handle.exitCode = exitCode;
				exited.resolve({ exitCode, stdout: handle.stdout, stderr: handle.stderr });
			},
			async wait() {
				const result = await exited.promise;
				if (result.exitCode !== 0) throw new CommandExitError(result);
				return result;
			},
			async kill() {
				handle.killed = true;
				handle.end(137);
				return true;
			},
			async disconnect() {
				handle.disconnected = true;
			},
			out(text) {
				onStdout?.(text);
			},
		};
		return handle;
	}

	/** The connected sandbox: commands and files (index.mjs:5917-6000, 4972-5150, 2332-2435). */
	function connected(sb) {
		const handles = new Map();
		return {
			sandboxId: sb.id,
			getHost(port) {
				return `${port}-${sb.id}.e2b.app`;
			},
			files: {
				async write(path, data, opts) {
					record("files.write", sb.id, path, opts);
					await step("files.write", opts, sb);
					if (gone(sb)) throw new SandboxNotFoundError(`Sandbox ${sb.id} not found`);
					const bytes = Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
					sb.files.set(path, bytes);
					fake.uploads.push({ sandbox: sb.id, path, bytes, user: opts?.user });
					return { name: path.split("/").pop(), path, type: "file" };
				},
			},
			commands: {
				async run(cmd, opts = {}) {
					const script = scriptOf(cmd);
					record("commands.run", sb.id, script?.kind ?? cmd, opts);
					await step(`commands.run ${script?.kind ?? "other"}`, opts, sb);
					if (gone(sb)) throw new SandboxNotFoundError(`Sandbox ${sb.id} not found`);
					if (script?.kind === "install") {
						const [staging, daemon] = script.args;
						const bytes = sb.files.get(staging);
						const result = { exitCode: install, stdout: "", stderr: "", error: undefined };
						if (install === 0 && bytes !== undefined) {
							const read = createHash("sha256").update(bytes).digest("hex");
							result.stdout = `sha256 ${sha === "lie" ? "0".repeat(64) : read}\n`;
							sb.files.delete(staging);
							sb.daemon = { path: daemon, bytes };
						} else if (install !== 0) result.stdout = `installing the daemon at ${daemon} failed\n`;
						if (result.exitCode !== 0) throw new CommandExitError(result);
						return result;
					}
					if (script?.kind === "init") {
						const [, deadline, user, , , display = "", max = ""] = script.args;
						const handle = handleOf(sb, opts);
						if (initFails !== undefined || sb.daemon === undefined) {
							queueMicrotask(() => handle.end(1, `${initFails ?? "sh: /opt/agentrun/computerd: not found"}\n`));
						} else {
							const [uid, gid] = user.split(":").map(Number);
							Object.assign(sb.box, { uid, gid });
							sb.init = { deadline, user, display, max, handle, timeoutMs: opts.timeoutMs };
						}
						return handle;
					}
					if (script?.kind === "stdio") {
						const handle = handleOf(sb, opts);
						handles.set(handle.pid, handle);
						fake.bridges.push({ sandbox: sb.id, handle, opts });
						const listening = sb.init !== undefined && !(waitingBridges > 0);
						if (sb.init !== undefined && waitingBridges > 0) waitingBridges--;
						if (!listening) queueMicrotask(() => handle.end(1, "computerd stdio: no daemon listens at /run/agentrun/computerd.sock (connect: no such file or directory)\n"));
						handle.buffered = "";
						return handle;
					}
					throw new Error(`the fake runs only the provider's scripts, not ${cmd}`);
				},
				async sendStdin(pid, data, opts) {
					const handle = handles.get(pid);
					if (handle === undefined || handle.exitCode !== undefined) throw new Error(`process ${pid} not found`);
					handle.buffered += typeof data === "string" ? data : Buffer.from(data).toString("utf8");
					let at;
					while ((at = handle.buffered.indexOf("\n")) >= 0) {
						const request = JSON.parse(handle.buffered.slice(0, at));
						handle.buffered = handle.buffered.slice(at + 1);
						if (typeof request.id !== "number") continue;
						fake.requests.push({ sandbox: sb.id, method: request.method, params: request.params });
						await onStep(request.method, sb);
						const reply = await answer(sb, request);
						if (reply !== undefined) handle.out(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...reply })}\n`);
					}
					void opts;
				},
			},
		};
	}

	const Sandbox = {
		async create(template, opts) {
			record("Sandbox.create", template, opts);
			await step("Sandbox.create", opts);
			if (create === "fail") throw new InvalidArgumentError("400: template not found");
			if (create === "auth") throw new AuthenticationError("401: Invalid API key");
			const make = () => {
				const sb = add({
					template,
					metadata: opts.metadata,
					timeoutMs: opts.timeoutMs,
					allowInternetAccess: opts.allowInternetAccess,
					network: opts.network,
					lifecycle: opts.lifecycle,
				});
				sb.hiddenLists = unlisted;
				return connected(sb);
			};
			if (create === "lost") {
				make();
				throw new TimeoutError("Request timed out: the sandbox may have been made, its id never came back");
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
			return make();
		},
		async connect(id, opts) {
			record("Sandbox.connect", id, opts);
			await step("Sandbox.connect", opts, sandboxes.get(id));
			const sb = sandboxes.get(id);
			if (gone(sb)) throw new SandboxNotFoundError(`Paused sandbox ${id} not found`);
			return connected(sb);
		},
		async getInfo(id, opts) {
			record("Sandbox.getInfo", id, opts);
			await step("Sandbox.getInfo", opts, sandboxes.get(id));
			const sb = sandboxes.get(id);
			if (sb?.killed && sb.lingering?.reads > 0) {
				sb.lingering.reads--;
				return infoOf(sb);
			}
			if (gone(sb)) throw new SandboxNotFoundError(`Sandbox ${id} not found`);
			return infoOf(sb);
		},
		async setTimeout(id, timeoutMs, opts) {
			record("Sandbox.setTimeout", id, timeoutMs, opts);
			await step("Sandbox.setTimeout", opts, sandboxes.get(id));
			const sb = sandboxes.get(id);
			if (gone(sb)) throw new SandboxNotFoundError(`Sandbox ${id} not found`);
			sb.endAt = new Date(Date.now() + Math.ceil(timeoutMs / 1000) * 1000);
		},
		async kill(id, opts) {
			record("Sandbox.kill", id, opts);
			await step("Sandbox.kill", opts, sandboxes.get(id));
			const sb = sandboxes.get(id);
			if (gone(sb) || sb.killed) return false;
			sb.killed = true;
			fake.kills.push(id);
			if (lingers) sb.lingering = { reads: lingers.reads ?? 0, lists: lingers.lists ?? 0 };
			return true;
		},
		list(opts) {
			record("Sandbox.list", opts);
			const wanted = opts?.query?.metadata ?? {};
			let pages = 0;
			return {
				get hasNext() {
					return pages === 0;
				},
				async nextItems(pageOpts) {
					record("paginator.nextItems", pageOpts);
					await step("Sandbox.list", pageOpts);
					pages++;
					const matched = [...sandboxes.values()].filter((sb) => Object.entries(wanted).every(([k, v]) => sb.metadata[k] === v));
					const listed = matched.filter((sb) => (!sb.killed || sb.lingering?.lists > 0) && !(sb.hiddenLists > 0));
					for (const sb of matched) if (sb.hiddenLists > 0) sb.hiddenLists--;
					for (const sb of listed) if (sb.killed && sb.lingering?.lists > 0) sb.lingering.lists--;
					return listed.map((sb) => ({ sandboxId: sb.id, templateId: sb.templateId, metadata: { ...sb.metadata }, startedAt: sb.startedAt, endAt: sb.endAt, state: sb.state, cpuCount: 2, memoryMB: 2048, envdVersion: "0.6.4", volumeMounts: [] }));
				},
			};
		},
	};

	/** Lets every held create go on. */
	fake.release = async () => {
		for (const one of held.splice(0)) one.resolve();
		await new Promise((done) => setTimeout(done, 10));
	};
	fake.Sandbox = Sandbox;
	fake.add = add;
	fake.names = () => calls.map(([name]) => name);
	/** Every options object any SDK call was given. */
	fake.options = () => calls.map((call) => call.find((arg, i) => i > 0 && typeof arg === "object" && arg !== null && !Array.isArray(arg) && ("apiKey" in arg || "requestTimeoutMs" in arg || "signal" in arg)));
	return fake;
}
