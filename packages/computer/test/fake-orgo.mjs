// A fake Orgo for the provider's unit tests, as docs.orgo.ai describes its API: a fake fetch for the REST calls the
// provider makes (computers create, get, delete and extend; a workspace's computers; the bash and file-upload calls the
// terminal channel makes), a fake OrgoChannel holding each computer's files, its labels file, its X socket and a fake
// computerd behind the stdio bridge, and a fake terminal WebSocket (JSON frames, a root shell in a PTY) for the channel's
// own test. It records every request with its headers. Nothing reaches the network, and no key leaves the fake.
import { createHash } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import { scriptOf } from "./fake-e2b.mjs";
import { netDevText } from "./net-dev.mjs";

export const VERSION = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../package.json", import.meta.url), "utf8")).version;
export const KEY = "sk_fake_orgo_key_0123456789abcdef";
export const WORKSPACE = "ws-0000-agentrun";
export const API = "https://orgo.example/api";
export const VNC = "vnc-fake-password-0123456789";
export const DAEMON = "/opt/agentrun/computerd";
export const LABELS_PATH = "/opt/agentrun/labels.json";
export const DESKTOP_GROUPS = ["exec", "files", "processes", "screen", "input.pointer", "input.keys"];
const NO_CAPS = "0000000000000000";

let counter = 0;
const newId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const json = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/**
 * A fake Orgo REST API, as a fetch. Options:
 *  - create: "ok" (default), "fail" (400 in words), "unauthorized" (401), or "creating" (the computer answers status
 *    creating for its first `creatingReads` reads);
 *  - waking: how many DELETEs answer 409 computer_waking before one deletes (default 0);
 *  - lingers: how many reads a deleted computer still answers before it is 404 (default 0);
 *  - bash: (computerId, command, timeout) => { exit_code, output } for POST /computers/{id}/bash;
 * fake.requests holds every request: { method, path, headers, body, form }; fake.computers each computer's record.
 */
export function fakeOrgoApi({ create = "ok", creatingReads = 1, waking = 0, lingers = 0, bash = () => ({ exit_code: 0, output: "" }) } = {}) {
	const computers = new Map();
	const requests = [];
	let wakingLeft = waking;
	const add = ({ name, workspace_id = WORKSPACE, status = "running", ends_at = null, ram = 4, cpu = 1, created_at = new Date().toISOString() }) => {
		const id = newId();
		computers.set(id, { id, name, workspace_id, project_id: workspace_id, os: "linux", ram, cpu, status, ends_at, created_at, vnc_password: VNC, deleted: false, reads: 0 });
		return computers.get(id);
	};
	const visible = (record) => record !== undefined && !(record.deleted && record.lingered >= lingers);
	const fetch = async (url, init = {}) => {
		const { pathname, searchParams } = new URL(url);
		const path = pathname.replace(/^\/api/, "");
		const headers = Object.fromEntries(new Headers(init.headers).entries());
		const form = init.body instanceof FormData ? init.body : undefined;
		const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
		requests.push({ method: init.method ?? "GET", path, query: Object.fromEntries(searchParams), headers, body, form });
		if (headers.authorization !== `Bearer ${KEY}`) return json(401, { error: "Invalid API key", code: "unauthorized" });
		if (init.signal?.aborted) throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
		const method = init.method ?? "GET";
		let match;
		if (method === "POST" && path === "/computers") {
			if (create === "unauthorized") return json(401, { error: "Invalid API key", code: "unauthorized" });
			if (create === "fail") return json(400, { error: "ram must be one of 4, 8, 16, 32, 64", code: "invalid_ram" });
			if ([...computers.values()].some((c) => !c.deleted && c.name === body.name && c.workspace_id === body.workspace_id)) return json(409, { error: "name in use", code: "name_taken" });
			const record = add({ name: body.name, workspace_id: body.workspace_id, ram: body.ram, cpu: body.cpu, status: create === "creating" ? "creating" : "running", ends_at: body.ends_in_hours ? new Date(Date.now() + body.ends_in_hours * 3_600_000).toISOString() : null });
			record.creatingLeft = create === "creating" ? creatingReads : 0;
			record.asked = body;
			const { deleted: _d, reads: _r, creatingLeft: _c, asked: _a, ...answer } = record;
			return json(201, answer);
		}
		if ((match = /^\/computers\/([^/]+)$/.exec(path))) {
			const record = computers.get(match[1]);
			if (method === "GET") {
				if (!visible(record)) return json(404, { error: "Computer not found", code: "computer_not_found" });
				if (record.deleted) record.lingered = (record.lingered ?? 0) + 1;
				if (record.creatingLeft > 0) {
					record.creatingLeft--;
					if (record.creatingLeft === 0) record.status = "running";
					else return json(200, { ...publicOf(record), status: "creating" });
				}
				return json(200, publicOf(record));
			}
			if (method === "DELETE") {
				if (record === undefined || record.deleted) return json(404, { error: "Computer not found", code: "computer_not_found" });
				if (wakingLeft > 0) {
					wakingLeft--;
					return json(409, { error: "Computer is waking", code: "computer_waking" });
				}
				record.deleted = true;
				record.lingered = 0;
				return json(200, { success: true });
			}
		}
		if ((match = /^\/computers\/([^/]+)\/extend$/.exec(path)) && method === "POST") {
			const record = computers.get(match[1]);
			if (!visible(record) || record.deleted) return json(404, { error: "Computer not found", code: "computer_not_found" });
			if (!headers["idempotency-key"]) return json(400, { error: "Idempotency-Key is required", code: "idempotency_key_required" });
			const from = record.ends_at === null ? Date.now() : Date.parse(record.ends_at);
			record.ends_at = new Date(from + body.hours * 3_600_000).toISOString();
			return json(200, { success: true, ends_at: record.ends_at });
		}
		if ((match = /^\/computers\/([^/]+)\/bash$/.exec(path)) && method === "POST") {
			const record = computers.get(match[1]);
			if (!visible(record) || record.deleted) return json(404, { error: "Computer not found", code: "computer_not_found" });
			return json(200, { success: true, ...bash(match[1], body.command, body.timeout) });
		}
		if (path === "/files/upload" && method === "POST") return json(200, { success: true, file: { id: "f1", filename: form?.get("file")?.name } });
		if ((match = /^\/workspaces\/([^/]+)$/.exec(path)) && method === "GET") {
			if (match[1] !== WORKSPACE) return json(404, { error: "Workspace not found", code: "workspace_not_found" });
			const desktops = [...computers.values()].filter((c) => !c.deleted && c.workspace_id === WORKSPACE).map((c) => ({ id: c.id, name: c.name, status: c.status, created_at: c.created_at }));
			return json(200, { id: WORKSPACE, name: "agentrun", desktops });
		}
		return json(404, { error: `no route ${method} ${path}`, code: "not_found" });
	};
	const publicOf = (record) => {
		const { deleted: _d, reads: _r, creatingLeft: _c, asked: _a, lingered: _l, ...answer } = record;
		return answer;
	};
	return { fetch, requests, computers, add, routes: () => requests.map(({ method, path }) => `${method} ${path}`) };
}

/** A command line the provider sends: its mark and arguments, from argv ["sh", "-c", <script or a child command>, ...]. */
export function markOf(argv) {
	if (argv[0] !== "sh" || argv[1] !== "-c" || typeof argv[2] !== "string") return undefined;
	if (argv[2].startsWith("sh -c ")) return scriptOf(argv[2]);
	const mark = /^# agentrun-computer: ([\w-]+)\n/.exec(argv[2]);
	return mark === null ? undefined : { kind: mark[1], args: argv.slice(4) };
}

/**
 * A fake OrgoChannel. Each computer (by id) holds its files, its labels file, whether its X socket is there, init (when
 * started) and what its daemon reports. Options:
 *  - install: the install script's exit code (default 0); sha: "ok" or "lie";
 *  - x11: false, and no computer has the X server's path socket;
 *  - box: what each daemon reports over the defaults (hello patch, uid/gid patch, reached, kernel, display: false for
 *    a daemon that does not reach the display);
 *  - notListening: how many stdio bridges find no daemon listening before one does;
 *  - startFails: words the start of init fails with;
 *  - bridge: "ok" (default), or "timeout": every stdio fails as the terminal channel does when its marker never comes;
 *  - initDies: init is gone once the start's call returns (as when bash's end takes it), and its log says why;
 *  - rootPorts: the TCP ports root listens on in Orgo's own network (its agent, its VNC), as the ports script reads
 *    them (default 8231 and 5900);
 *  - sockets: the path sockets of Orgo's desktop the lockdown script makes root's alone, as it prints them (default
 *    root's D-Bus buses, as live run 4 found them).
 * The status script answers what the computer holds: init running or not, its socket, its log's tail. The daemon holds
 * its programs to their own loopback when init was started with --own-network, and else shares Orgo's network.
 * channel.calls holds every call, { op, computer, argv | path, how }; channel.boxes each computer's state, its
 * probes' targets in box.probes.
 */
export function fakeOrgoChannel({ install = 0, sha = "ok", x11 = true, box: boxPatch = {}, notListening = 0, startFails, bridge = "ok", initDies = false, rootPorts = [8231, 5900], sockets = ["/run/dbus/system_bus_socket", "/tmp/dbus-3fd5ustF2v"] } = {}) {
	const boxes = new Map();
	const calls = [];
	let waiting = notListening;
	const boxOf = (id) => {
		if (!boxes.has(id)) boxes.set(id, { files: new Map(), labels: undefined, x11, init: undefined, daemon: undefined, streams: [], extended: [], probes: [] });
		return boxes.get(id);
	};
	const channel = {
		calls,
		boxes,
		boxOf,
		async upload(computer, path, bytes) {
			calls.push({ op: "upload", computer, path, size: bytes.length });
			boxOf(computer).files.set(path, Buffer.from(bytes));
			return { ok: true, value: undefined };
		},
		async run(computer, argv) {
			const mark = markOf(argv);
			calls.push({ op: "run", computer, argv: [...argv], kind: mark?.kind });
			const box = boxOf(computer);
			const done = (exitCode, output = "") => ({ ok: true, value: { exitCode, output } });
			if (mark?.kind === "install") {
				const [staging, daemon] = mark.args;
				const bytes = box.files.get(staging);
				if (install !== 0 || bytes === undefined) return done(install || 5, `installing the daemon at ${daemon} failed`);
				box.daemon = { path: daemon, bytes };
				box.files.delete(staging);
				const read = createHash("sha256").update(bytes).digest("hex");
				return done(0, `sha256 ${sha === "lie" ? "0".repeat(64) : read}\n`);
			}
			if (mark?.kind === "orgo-x11") return box.x11 ? done(0) : done(1, `no X socket at ${mark.args[0]}`);
			if (mark?.kind === "orgo-labels") {
				box.labels = mark.args[1];
				return done(0);
			}
			if (mark?.kind === "orgo-labels-read") return box.labels === undefined ? done(1, `cat: ${mark.args[0]}: No such file or directory`) : done(0, box.labels);
			if (mark?.kind === "orgo-ports") return done(0, rootPorts.map((port) => `${port}\n`).join(""));
			if (mark?.kind === "orgo-lockdown") return done(0, sockets.map((path) => `locked ${path}\n`).join(""));
			if (mark?.kind === "orgo-status") {
				const up = box.init !== undefined;
				return done(0, [`init ${up ? "running" : "not running"}`, `socket ${up ? "present" : "absent"}`, `log ${box.log ?? (up ? "computerd: init: listening" : "")}`].join("\n"));
			}
			return done(127, `the fake runs only the provider's scripts, not ${argv.join(" ")}`);
		},
		async start(computer, argv, { how }) {
			const mark = markOf(argv);
			calls.push({ op: "start", computer, argv: [...argv], how, kind: mark?.kind });
			if (startFails) return { ok: false, error: { code: "orgo", message: startFails } };
			const box = boxOf(computer);
			if (mark?.kind !== "init" || box.daemon === undefined) return { ok: true, value: undefined };
			const [, deadline, user, , , display = "", max = ""] = mark.args;
			const [uid, gid] = user.split(":").map(Number);
			if (initDies) box.log = "computerd: init: terminated by signal 15 (SIGTERM)";
			else box.init = { deadline, user, uid, gid, display, max, ownNetwork: argv.join(" ").includes("--own-network") };
			return { ok: true, value: undefined };
		},
		async stdio(computer, argv) {
			const mark = markOf(argv);
			calls.push({ op: "stdio", computer, argv: [...argv], kind: mark?.kind });
			if (bridge === "timeout") return { ok: false, error: { code: "timeout", message: `computerd's bridge in ${computer} did not start within 0.5 s` } };
			const box = boxOf(computer);
			const readable = new PassThrough();
			const listening = box.init !== undefined && !(waiting > 0);
			if (box.init !== undefined && waiting > 0) waiting--;
			let buffered = "";
			const writable = new Writable({
				write(chunk, _encoding, callback) {
					// No daemon listens: what is written goes nowhere, and the stream ends.
					if (!listening) return callback();
					buffered += chunk.toString("utf8");
					let at;
					while ((at = buffered.indexOf("\n")) >= 0) {
						const request = JSON.parse(buffered.slice(0, at));
						buffered = buffered.slice(at + 1);
						if (typeof request.id !== "number") continue;
						const reply = answer(box, request, boxPatch);
						if (reply !== undefined) readable.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...reply })}\n`);
					}
					callback();
				},
			});
			const stream = { readable, writable, close: async () => void readable.end(), said: () => (listening ? "" : "computerd stdio: no daemon listens at /run/agentrun/computerd.sock") };
			box.streams.push(stream);
			if (!listening) queueMicrotask(() => readable.end());
			return { ok: true, value: stream };
		},
	};
	return channel;
}

/** What the fake computerd in a box answers to one request. */
function answer(box, { method, params }, patch) {
	const result = (value) => ({ result: value });
	const error = (kind, message) => ({ error: { code: -32000, message, data: { kind } } });
	const { uid, gid, display, ownNetwork } = box.init;
	const reaches = display !== "" && patch.display !== false;
	// Init started with --own-network holds its programs to their own loopback; without it they share Orgo's network,
	// which reaches the internet and Orgo's agent alike (as live runs 2 and 3 read).
	const interfaces = patch.interfaces ?? (ownNetwork ? ["lo"] : ["lo", "eth0"]);
	if (method === "files.read" && params.path === "/proc/self/net/dev") {
		const text = netDevText(interfaces);
		return result({ data: Buffer.from(text).toString("base64"), size: text.length, eof: true });
	}
	if (method === "hello") return result({ version: VERSION, os: "linux", arch: "amd64", kind: reaches ? "desktop" : "linux", groups: reaches ? [...DESKTOP_GROUPS] : DESKTOP_GROUPS.slice(0, 3), ...patch.hello });
	if (method === "ping") return result({});
	if (method === "files.read" && params.path === "/proc/self/status") {
		const fields = { Uid: `${uid}\t${uid}\t${uid}\t${uid}`, Gid: `${gid}\t${gid}\t${gid}\t${gid}`, Groups: "", NoNewPrivs: "1", CapInh: NO_CAPS, CapPrm: NO_CAPS, CapEff: NO_CAPS, CapBnd: NO_CAPS, CapAmb: NO_CAPS, Seccomp: "2", ...patch.status };
		const text = Object.entries(fields).map(([k, v]) => `${k}:\t${v}\n`).join("");
		return result({ data: Buffer.from(text).toString("base64"), size: text.length, eof: true });
	}
	if (method === "files.stat") {
		if (params.path === "/proc/self/cwd") return result({ path: params.path, type: "symlink", target: "/work" });
		if (params.path === "/proc/self/exe") return result({ path: params.path, type: "symlink", target: DAEMON });
		return error("not_found", `${params.path}: no such file`);
	}
	if (method === "exec.run" && params.argv[0] === DAEMON && params.argv[1] === "probe") {
		const targets = params.argv.slice(2).filter((_, at) => at % 2 === 1);
		box.probes.push(targets);
		const report = { uid, gid, kernel: patch.kernel ?? "6.8.0", interfaces, quiet: [], raised: [], reached: patch.reached ?? (ownNetwork ? [] : targets), accepted: [] };
		return result({ exitCode: 0, stdout: Buffer.from(`${JSON.stringify(report)}\n`).toString("base64"), stderr: "", timedOut: false, truncated: false });
	}
	if (method === "exec.run") return result({ exitCode: 0, stdout: Buffer.from(`${params.argv.join(" ")}\n`).toString("base64"), stderr: "", timedOut: false, truncated: false });
	if (method === "deadline.extend") {
		if (box.init.max === "") return error("unsupported", "this computer's deadline cannot move");
		if (Date.parse(params.at) > Date.parse(box.init.max)) return error("limit", `${params.at} is past the maximum deadline ${box.init.max}`);
		box.init.deadline = new Date(Date.parse(params.at)).toISOString();
		box.extended.push(params.at);
		return result({ at: box.init.deadline });
	}
	return error("unsupported", `${method} is not a method`);
}

/**
 * A fake of Orgo's terminal WebSocket, as a factory (url) => socket: a root shell in a PTY that speaks JSON text frames.
 * Typed input is echoed until `stty raw -echo` runs; the shell prints a prompt first. A line that runs the provider's
 * marker printf prints the marker; `exec <...>` then hands the PTY to `onExec(command, io)`, where io.write sends output
 * and io.input receives what the client types from then on. A socket whose URL carries a session= name is recorded.
 * terminal.sockets holds every socket, with its url, the frames it sent, and closed. `frames` is how output comes:
 * "json" ({ type: "output", data } text frames, as the docs say), "text" (the bytes as plain text frames), "binary" (the
 * bytes as ArrayBuffer frames), or "deaf" (the prompt, then nothing: typed input is never run). As Orgo's `bash -l`
 * does while it starts (seen live), input typed before the prompt has reached the client is dropped, never echoed or
 * run; `drops` more typed lines after it are dropped too.
 */
export function fakeTerminal({ onExec = () => {}, frames = "json", drops = 0 } = {}) {
	const sockets = [];
	const factory = (url) => {
		const listeners = { open: [], message: [], close: [], error: [] };
		let raw = false;
		let execd;
		let ready = false;
		let dropping = drops;
		const socket = {
			url,
			sent: [],
			closed: false,
			readyState: 0,
			addEventListener(type, fn) {
				listeners[type].push(fn);
			},
			send(text) {
				socket.sent.push(text);
				const frame = JSON.parse(text);
				if (frame.type !== "input" || frames === "deaf") return;
				if (execd) return execd(frame.data);
				// The shell is still starting: what was typed is lost.
				if (!ready) return;
				if (dropping > 0) {
					dropping--;
					return;
				}
				if (!raw) emit({ type: "output", data: frame.data.replace(/\r/g, "\r\n") });
				const line = frame.data.replace(/\r$/, "");
				if (/stty raw -echo/.test(line)) raw = true;
				const printed = /printf '%s%s\\n' ([^\s;]+) ([^\s;]+)/.exec(line);
				if (printed) emit({ type: "output", data: `${printed[1]}${printed[2]}\n` });
				const exec = /exec (.*)$/.exec(line);
				if (exec) {
					const io = {
						write: (data) => emit({ type: "output", data }),
						exit: (code) => {
							emit({ type: "exit", code });
							// The server closes after the frames it sent before.
							queueMicrotask(() => queueMicrotask(() => socket.close()));
						},
						input: () => {},
					};
					execd = (data) => io.input(data);
					onExec(exec[1], io, socket);
				}
			},
			close() {
				if (socket.closed) return;
				socket.closed = true;
				socket.readyState = 3;
				for (const fn of listeners.close) fn({ code: 1000 });
			},
		};
		const encode = (frame) => {
			if (frame.type !== "output" || frames === "json" || frames === "deaf") return JSON.stringify(frame);
			if (frames === "text") return frame.data;
			const bytes = Buffer.from(frame.data, "utf8");
			return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		};
		const emit = (frame) => queueMicrotask(() => {
			if (!socket.closed) for (const fn of listeners.message) fn({ data: encode(frame) });
		});
		sockets.push(socket);
		queueMicrotask(() => {
			socket.readyState = 1;
			for (const fn of listeners.open) fn({});
			// The prompt says the shell reads its input: from then on, what is typed is run. The shell starts after the socket
			// opens, not with it: the prompt comes a turn of the event loop later.
			setImmediate(() => {
				if (socket.closed) return;
				for (const fn of listeners.message) fn({ data: encode({ type: "output", data: "\u001b[?2004hroot@orgo:~/Desktop# " }) });
				ready = true;
			});
		});
		return socket;
	};
	return { factory, sockets };
}
