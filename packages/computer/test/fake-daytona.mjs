// A fake Daytona, in process, for DaytonaProvider's unit tests: an injected fetch and WebSocket that record every request
// and answer as Daytona's v0 REST API and toolbox do, per the pinned spec (daytona/clients@8006f63e openapi-specs/api.json
// and toolbox.json) and the open daemon's session code (daytonaio/daytona@b5a5d9e7 apps/daemon/pkg/session). Hosts are
// under .test, which never resolves: nothing here touches a network. Inside each sandbox a fake computerd answers hello,
// ping, files.read of /proc/self/status, files.stat of /proc/self/cwd and /proc/self/exe, and exec.run (an echo).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const API = "https://api.daytona.test/api";
export const PROXY = "https://proxy.daytona.test/toolbox";
export const HOSTS = ["api.daytona.test", "proxy.daytona.test"];
export const KEY = "fake-key-for-tests";
export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
/** The snapshot the fake gives a create that names none: the open platform takes its configured default snapshot
 *  (daytonaio/daytona@b5a5d9e7 apps/api/src/sandbox/services/sandbox.service.ts:471-475). The name is the fake's own. */
export const DEFAULT_SNAPSHOT = "fake-default-snapshot";
const OUT = Buffer.from([1, 1, 1]);
const ERR = Buffer.from([2, 2, 2]);

/** /proc/self/status of a daemon run as uid:gid with no capabilities and no_new_privs, as the start script makes it. */
export function statusText({ uid = 1000, gid = uid, capEff = "0000000000000000", capBnd = "0000000000000000", noNewPrivs = 1, groups = "" } = {}) {
	return [
		"Name:\tcomputerd",
		"State:\tS (sleeping)",
		`Uid:\t${uid}\t${uid}\t${uid}\t${uid}`,
		`Gid:\t${gid}\t${gid}\t${gid}\t${gid}`,
		`Groups:\t${groups}`,
		`NoNewPrivs:\t${noNewPrivs}`,
		"CapInh:\t0000000000000000",
		`CapPrm:\t${capEff}`,
		`CapEff:\t${capEff}`,
		`CapBnd:\t${capBnd}`,
		"CapAmb:\t0000000000000000",
		"",
	].join("\n");
}

/** The words of a command the provider builds (sh -c '<script>' sh '<arg>' ...): single quotes and '\'' escapes. */
export function wordsOf(command) {
	const words = [];
	let word;
	let quoted = false;
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (quoted) {
			if (c === "'") quoted = false;
			else word += c;
		} else if (c === "'") {
			word ??= "";
			quoted = true;
		} else if (c === "\\") {
			word = (word ?? "") + command[++i];
		} else if (c === " ") {
			if (word !== undefined) words.push(word);
			word = undefined;
		} else word = (word ?? "") + c;
	}
	if (word !== undefined) words.push(word);
	return words;
}

/** Which of the provider's scripts a command runs, by the marker on its first line, and its arguments. */
export function scriptOf(command) {
	const words = wordsOf(command);
	const marker = /^# agentrun-computer: (\w+)/.exec(words[2] ?? "");
	return { kind: marker?.[1], args: words.slice(4) };
}

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const abortError = (signal) => signal?.reason ?? new DOMException("This operation was aborted", "AbortError");

/**
 * The fake. Knobs, all optional and changeable between calls through `knobs`:
 * - `startAfterReads` (1): single reads before a creating sandbox is started; `stuck`: it stays in pending_build;
 *   `startError`: it goes to error with that reason.
 * - `fail`: [{ method, path: RegExp, status, body?, times }]: answer that status for the first `times` matches.
 * - `hang`: [{ method, path: RegExp }]: never answer, until the request's signal aborts.
 * - `readBack(sandbox)`: fields merged over each single read; `listBack(item)`: over each listed item.
 * - `uploadStatus`: the daemon upload's answer. `install`: { exitCode, result } of the install script, or `installSha`.
 * - `initFails`: init writes that to stderr and exits 1. `bridgeStderr`: a line the bridge writes to stderr at start.
 * - `hello`, `status`, `cwd`, `exe`: what the daemon reports. `echoInput`: input is echoed to stdout, as with
 *   suppressInputEcho unset. `pageSize`: items a listing page holds. `sandboxClass` ("container").
 * - `networkStatus`: the answer to a network-settings change; `networkIgnored`: it answers 200 and changes nothing.
 * - `stopStopped` (400): the answer to a stop of a stopped sandbox. `stoppingReads`: after a stop the sandbox reads back,
 *   and is listed, as stopping for that many single reads, then stopped (Infinity: it never stops).
 * - `deleteIgnored`: a DELETE answers 200 and the sandbox stays, started. `lingerReads`: after a DELETE the sandbox reads
 *   back, and is listed, as destroying for that many single reads, then is gone (404) (Infinity: it never goes).
 * - `listStale`: the listing shows a sandbox as it was before its last stop or delete for that many listings, as
 *   Daytona's listing trails a change (Infinity: it never catches up).
 * A sandbox whose autoDeleteInterval is 0 is deleted as soon as it stops (api.json:12199), destroying for `lingerReads`.
 */
export function fakeDaytona(initial = {}) {
	const knobs = { startAfterReads: 1, pageSize: 100, sandboxClass: "container", stopStopped: 400, ...initial };
	const requests = [];
	const sockets = [];
	const sandboxes = new Map();
	const inside = new Map();
	/** Listing items as they were before a stop or a delete, and how many more listings show them. */
	const stale = new Map();
	let next = 0;

	const find = (idOrName) => sandboxes.get(idOrName) ?? [...sandboxes.values()].find((sb) => sb.name === idOrName);
	const failure = (method, path) => {
		const rule = (knobs.fail ?? []).find((r) => r.method === method && r.path.test(path) && (r.times ?? 1) > 0);
		if (rule === undefined) return undefined;
		rule.times = (rule.times ?? 1) - 1;
		return json(rule.status, rule.body ?? { statusCode: rule.status, message: `fake failure ${rule.status}` });
	};

	function sandboxOf(body) {
		const id = `${(++next).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
		const now = new Date().toISOString();
		const ttl = body.ttlMinutes ?? 0;
		return {
			id,
			organizationId: "org-test",
			name: body.name ?? id,
			snapshot: typeof body.snapshot === "string" && body.snapshot.trim() !== "" ? body.snapshot : DEFAULT_SNAPSHOT,
			user: "daytona",
			env: body.env ?? {},
			labels: { ...(body.labels ?? {}) },
			public: body.public ?? false,
			networkBlockAll: body.networkBlockAll ?? false,
			...(body.networkAllowList ? { networkAllowList: body.networkAllowList } : {}),
			...(body.domainAllowList ? { domainAllowList: body.domainAllowList } : {}),
			kvm: false,
			target: body.target ?? "us",
			cpu: 1,
			gpu: 0,
			memory: 1,
			disk: 3,
			state: knobs.stuck ? "pending_build" : "creating",
			desiredState: "started",
			autoStopInterval: body.autoStopInterval ?? 15,
			autoArchiveInterval: 10080,
			autoDeleteInterval: body.autoDeleteInterval ?? -1,
			...(ttl > 0 ? { autoDestroyAt: new Date(Date.now() + ttl * 60_000).toISOString() } : {}),
			volumes: [],
			createdAt: now,
			updatedAt: now,
			sandboxClass: knobs.sandboxClass,
			daemonVersion: "0.230.0",
			toolboxProxyUrl: PROXY,
		};
	}

	/** The listing keeps showing sb as it is now, for `listStale` listings. */
	function remember(sb) {
		if (knobs.listStale > 0) stale.set(sb.id, { item: listItem(sb), listings: knobs.listStale });
	}

	/** Daytona destroys sb: at once, or after `lingerReads` reads of destroying. */
	function destroy(sb) {
		if (knobs.lingerReads > 0) Object.assign(sb, { state: "destroying", desiredState: "destroyed", lingering: knobs.lingerReads });
		else sandboxes.delete(sb.id);
	}

	function single(sb) {
		const box = inside.get(sb.id);
		if (sb.stopping !== undefined) {
			if (sb.stopping > 0) sb.stopping--;
			else {
				delete sb.stopping;
				sb.state = "stopped";
				if (sb.autoDeleteInterval === 0) destroy(sb);
				if (!sandboxes.has(sb.id)) return undefined;
			}
		}
		if (sb.lingering !== undefined) {
			if (sb.lingering <= 0) {
				sandboxes.delete(sb.id);
				return undefined;
			}
			sb.lingering--;
		}
		if (sb.state === "creating" || sb.state === "pending_build") {
			box.reads++;
			if (knobs.startError) Object.assign(sb, { state: "error", errorReason: knobs.startError });
			else if (!knobs.stuck && box.reads >= knobs.startAfterReads) sb.state = "started";
		}
		return { ...sb, ...(knobs.readBack ? knobs.readBack(sb) : {}) };
	}

	function listItem(sb) {
		const { env: _env, volumes: _volumes, kvm: _kvm, ...item } = sb;
		return { ...item, ...(knobs.listBack ? knobs.listBack(item) : {}) };
	}

	/** Every command of every session in a sandbox ends, and its log streams close: a stop or a delete. */
	function endAll(box) {
		box.running = false;
		for (const session of box.sessions.values()) for (const command of session.commands.values()) end(command, 137);
	}

	function end(command, exitCode) {
		if (command.exitCode !== null) return;
		command.exitCode = exitCode;
		for (const socket of command.sockets) socket.finish();
	}

	function append(command, prefix, text) {
		const bytes = Buffer.concat([prefix, Buffer.from(text)]);
		command.log = Buffer.concat([command.log, bytes]);
		for (const socket of command.sockets) socket.deliver(bytes);
	}

	/** The fake daemon's answer to one request line, or undefined for a notification. */
	function answer(box, line) {
		let request;
		try {
			request = JSON.parse(line);
		} catch {
			return undefined;
		}
		if (typeof request.id !== "number") return undefined;
		const reply = (body) => `${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...body })}\n`;
		const { method, params = {} } = request;
		if (method === "hello") return reply({ result: { version: VERSION, os: "linux", arch: "amd64", capabilities: ["exec", "files", "processes"], ...(knobs.hello ?? {}) } });
		if (method === "ping") return reply({ result: {} });
		if (method === "files.read" && params.path === "/proc/self/status") {
			const text = knobs.status ?? statusText();
			return reply({ result: { data: Buffer.from(text).toString("base64"), eof: true, size: 0 } });
		}
		if (method === "files.stat" && (params.path === "/proc/self/cwd" || params.path === "/proc/self/exe")) {
			const target = params.path.endsWith("cwd") ? (knobs.cwd ?? "/work") : (knobs.exe ?? "/opt/agentrun/computerd");
			return reply({ result: { type: "symlink", size: 0, mode: 0o777, mtimeMs: 0, uid: 1000, gid: 1000, target } });
		}
		if (method === "exec.run") {
			const stdout = Buffer.from(`${params.argv.slice(1).join(" ")}\n`).toString("base64");
			return reply({ result: { exitCode: 0, stdout, stderr: "", timedOut: false, truncated: false } });
		}
		if (method === "files.read" || method === "files.stat") return reply({ error: { code: -32000, message: `no such file ${params.path}`, data: { kind: "not_found" } } });
		box.unknown.push(method);
		return reply({ error: { code: -32601, message: `${method} is not a method` } });
	}

	async function toolbox(method, sb, rest, url, body) {
		const box = inside.get(sb.id);
		if (sb.state !== "started") return json(409, { statusCode: 409, message: `sandbox ${sb.id} is ${sb.state}` });
		if (method === "POST" && rest === "files/upload-v2") {
			if (knobs.uploadStatus) return json(knobs.uploadStatus, { statusCode: knobs.uploadStatus, message: "upload refused by the fake" });
			const file = body.get("file");
			box.files.set(url.searchParams.get("path"), Buffer.from(await file.arrayBuffer()));
			return json(200, {});
		}
		if (method === "POST" && rest === "process/execute") {
			const { kind, args } = scriptOf(body.command);
			if (kind === "install") {
				box.installed.push(args);
				if (knobs.install) return json(200, knobs.install);
				const bytes = box.files.get(args[0]) ?? Buffer.alloc(0);
				box.files.delete(args[0]);
				box.files.set(args[1], bytes);
				const sha = knobs.installSha ?? createHash("sha256").update(bytes).digest("hex");
				return json(200, { exitCode: 0, result: `sha256 ${sha}\n` });
			}
			return json(200, { exitCode: 0, result: "" });
		}
		if (method === "POST" && rest === "process/session") {
			if (box.sessions.has(body.sessionId)) return json(409, { statusCode: 409, message: "session already exists" });
			box.sessions.set(body.sessionId, { commands: new Map() });
			return new Response(null, { status: 201 });
		}
		const parts = rest.split("/");
		if (parts[0] !== "process" || parts[1] !== "session") return json(404, { statusCode: 404, message: `no route ${rest}` });
		const session = box.sessions.get(parts[2]);
		if (session === undefined) return json(404, { statusCode: 404, message: "session not found" });
		if (method === "GET" && parts.length === 3) {
			return json(200, { sessionId: parts[2], commands: [...session.commands.values()].map(({ id, command, exitCode }) => ({ id, command, ...(exitCode === null ? {} : { exitCode }) })) });
		}
		if (method === "DELETE" && parts.length === 3) {
			for (const command of session.commands.values()) {
				if (command.kind === "init") box.running = false;
				end(command, 143);
			}
			box.sessions.delete(parts[2]);
			return new Response(null, { status: 204 });
		}
		if (method === "POST" && parts[3] === "exec") {
			const { kind, args } = scriptOf(body.command);
			const command = { id: `cmd-${++box.commandCount}`, command: body.command, kind, args, body, log: Buffer.alloc(0), exitCode: null, sockets: [], inputs: [] };
			session.commands.set(command.id, command);
			if (kind === "init") {
				if (knobs.initFails) {
					append(command, ERR, `computerd: ${knobs.initFails}\n`);
					command.exitCode = 1;
				} else {
					box.running = true;
					box.deadline = args[1];
				}
			} else if (kind === "stdio") {
				if (!box.running) {
					append(command, ERR, "computerd: stdio: cannot reach the daemon at /run/agentrun/computerd.sock\n");
					command.exitCode = 1;
				} else if (knobs.bridgeStderr) append(command, ERR, `${knobs.bridgeStderr}\n`);
			} else command.exitCode = 0;
			return json(202, { cmdId: command.id });
		}
		const command = session.commands.get(parts[4]);
		if (parts[3] !== "command" || command === undefined) return json(404, { statusCode: 404, message: "command not found" });
		if (method === "POST" && parts[5] === "input") {
			if (command.exitCode !== null) return json(410, { statusCode: 410, message: `command has already completed with exit code ${command.exitCode}` });
			const data = body.data.endsWith("\n") ? body.data : `${body.data}\n`;
			command.inputs.push(data);
			if (knobs.echoInput || command.body.suppressInputEcho !== true) append(command, OUT, data);
			for (const line of data.split("\n").filter(Boolean)) {
				const reply = answer(box, line);
				if (reply !== undefined) append(command, OUT, reply);
			}
			return new Response(null, { status: 204 });
		}
		if (method === "GET" && parts[5] === "logs") return new Response(command.log, { status: 200, headers: { "content-type": "text/plain" } });
		return json(404, { statusCode: 404, message: `no route ${rest}` });
	}

	async function control(method, path, url, body) {
		if (method === "POST" && path === "/api/sandbox") {
			if (knobs.createStatus) return json(knobs.createStatus, { statusCode: knobs.createStatus, message: "create refused by the fake" });
			const sb = sandboxOf(body);
			sandboxes.set(sb.id, sb);
			inside.set(sb.id, { reads: 0, files: new Map(), sessions: new Map(), running: false, installed: [], unknown: [], commandCount: 0 });
			return json(200, sb);
		}
		if (method === "GET" && path === "/api/sandbox") {
			const wanted = JSON.parse(url.searchParams.get("labels") ?? "{}");
			const shown = new Map([...sandboxes.values()].map((sb) => [sb.id, listItem(sb)]));
			for (const [id, entry] of stale) {
				if (entry.listings <= 0) stale.delete(id);
				else {
					entry.listings--;
					shown.set(id, entry.item);
				}
			}
			const all = [...shown.values()].filter((item) => Object.entries(wanted).every(([k, v]) => item.labels[k] === v));
			const from = Number(url.searchParams.get("cursor") ?? 0);
			const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), knobs.pageSize);
			const items = all.slice(from, from + limit);
			return json(200, { items, nextCursor: from + limit < all.length ? String(from + limit) : null });
		}
		const match = /^\/api\/sandbox\/([^/]+)(?:\/(.+))?$/.exec(path);
		if (match === null) return json(404, { statusCode: 404, message: `no route ${path}` });
		const sb = find(decodeURIComponent(match[1]));
		const rest = match[2] ?? "";
		if (sb === undefined) return json(404, { statusCode: 404, message: `Sandbox with ID or name ${match[1]} not found` });
		if (method === "GET" && rest === "") {
			const read = single(sb);
			return read === undefined ? json(404, { statusCode: 404, message: `Sandbox with ID or name ${match[1]} not found` }) : json(200, read);
		}
		if (method === "GET" && rest === "toolbox-proxy-url") return json(200, { url: PROXY });
		if (method === "DELETE" && rest === "") {
			if (knobs.deleteIgnored) return json(200, sb);
			remember(sb);
			endAll(inside.get(sb.id));
			destroy(sb);
			return json(200, { ...sb, state: "destroying", desiredState: "destroyed" });
		}
		if (method === "POST" && rest.startsWith("stop")) {
			if (sb.state === "stopped") return json(knobs.stopStopped, { statusCode: knobs.stopStopped, message: "Sandbox is already stopped" });
			if (sb.state === "stopping" || sb.state === "destroying") return json(409, { statusCode: 409, message: "Sandbox state change in progress" });
			remember(sb);
			endAll(inside.get(sb.id));
			if (knobs.stoppingReads > 0) Object.assign(sb, { state: "stopping", desiredState: "stopped", stopping: knobs.stoppingReads });
			else {
				Object.assign(sb, { state: "stopped", desiredState: "stopped" });
				if (sb.autoDeleteInterval === 0) destroy(sb);
			}
			return json(200, { ...sb });
		}
		if (method === "POST" && rest === "network-settings") {
			if (knobs.networkStatus) return json(knobs.networkStatus, { statusCode: knobs.networkStatus, message: "Network settings cannot be overridden on this tier" });
			const set = [body.networkBlockAll === true, Boolean(body.networkAllowList), Boolean(body.domainAllowList)].filter(Boolean).length;
			if (set > 1) return json(400, { statusCode: 400, message: "networkAllowList, domainAllowList and networkBlockAll are mutually exclusive" });
			if (!knobs.networkIgnored) {
				if (body.networkBlockAll === true || body.networkBlockAll === false) {
					sb.networkBlockAll = body.networkBlockAll;
					delete sb.networkAllowList;
					delete sb.domainAllowList;
				}
				for (const field of ["networkAllowList", "domainAllowList"]) {
					if (body[field] === undefined) continue;
					if (body[field] === "") delete sb[field];
					else Object.assign(sb, { [field]: body[field], networkBlockAll: false });
				}
			}
			return json(200, sb);
		}
		return json(404, { statusCode: 404, message: `no route ${path}` });
	}

	async function fetch(input, init = {}) {
		const url = new URL(String(input));
		const method = (init.method ?? "GET").toUpperCase();
		const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
		let body;
		if (typeof init.body === "string") body = JSON.parse(init.body);
		else if (init.body instanceof FormData) body = init.body;
		const record = { method, url: url.href, host: url.host, path: url.pathname, query: Object.fromEntries(url.searchParams), headers, redirect: init.redirect, body };
		if (body instanceof FormData) {
			const file = body.get("file");
			const bytes = Buffer.from(await file.arrayBuffer());
			record.body = { file: { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } };
		}
		requests.push(record);
		const signal = init.signal;
		if (signal?.aborted) throw abortError(signal);
		if (!HOSTS.includes(url.host)) throw new TypeError(`fake Daytona: no host ${url.host}`);
		const failed = failure(method, url.pathname);
		if (failed) return failed;
		if ((knobs.hang ?? []).some((rule) => rule.method === method && rule.path.test(url.pathname))) {
			return new Promise((_, reject) => {
				if (signal === undefined) return;
				signal.addEventListener("abort", () => reject(abortError(signal)), { once: true });
			});
		}
		if (url.host === "api.daytona.test") return control(method, url.pathname, url, body);
		const toolboxMatch = /^\/toolbox\/([^/]+)\/(.+)$/.exec(url.pathname);
		const sb = toolboxMatch ? sandboxes.get(decodeURIComponent(toolboxMatch[1])) : undefined;
		if (sb === undefined) return json(404, { statusCode: 404, message: "sandbox not found" });
		return toolbox(method, sb, toolboxMatch[2], url, body);
	}

	/** The fake socket of one session command's log stream: its log so far, then what it writes, in two frames each. */
	function webSocket(address, init = {}) {
		const url = new URL(address);
		const record = { url: url.href, host: url.host, protocol: url.protocol, headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])), protocols: init.protocols };
		sockets.push(record);
		const target = new EventTarget();
		const socket = Object.assign(target, {
			binaryType: "blob",
			readyState: 0,
			closed: undefined,
			close(code = 1000) {
				if (socket.readyState === 3) return;
				socket.readyState = 3;
				socket.closed = code;
				const event = new Event("close");
				Object.assign(event, { code, reason: "" });
				queueMicrotask(() => target.dispatchEvent(event));
			},
		});
		const fail = (why) => {
			queueMicrotask(() => {
				target.dispatchEvent(Object.assign(new Event("error"), { message: why }));
				socket.close(1006);
			});
			return socket;
		};
		if (!HOSTS.includes(url.host)) return fail(`fake Daytona: no host ${url.host}`);
		const match = /^\/toolbox\/([^/]+)\/process\/session\/([^/]+)\/command\/([^/]+)\/logs$/.exec(url.pathname);
		const sb = match ? sandboxes.get(match[1]) : undefined;
		const command = sb && inside.get(sb.id).sessions.get(match[2])?.commands.get(match[3]);
		if (command === undefined || url.searchParams.get("follow") !== "true") return fail("no such command");
		const send = (bytes) => {
			if (socket.readyState !== 1) return;
			const cut = Math.min(2, bytes.length - 1);
			for (const part of cut > 0 ? [bytes.subarray(0, cut), bytes.subarray(cut)] : [bytes]) {
				const data = part.buffer.slice(part.byteOffset, part.byteOffset + part.length);
				target.dispatchEvent(new MessageEvent("message", { data }));
			}
		};
		Object.assign(socket, {
			deliver: (bytes) => queueMicrotask(() => send(bytes)),
			finish: () => queueMicrotask(() => socket.close(1000)),
		});
		setImmediate(() => {
			if (socket.readyState !== 0) return;
			socket.readyState = 1;
			target.dispatchEvent(new Event("open"));
			if (command.log.length > 0) send(command.log);
			if (command.exitCode !== null) socket.close(1000);
			else command.sockets.push(socket);
		});
		return socket;
	}

	return {
		fetch,
		webSocket,
		requests,
		sockets,
		sandboxes,
		knobs,
		inside: (id) => inside.get(id),
		/** A sandbox made outside the provider, as the provider makes one unless `fields` say otherwise; started, with init running. */
		seed(fields = {}) {
			const sb = { ...sandboxOf({ snapshot: "agentrun-debian", ttlMinutes: 10, autoStopInterval: 0, autoDeleteInterval: -1, networkBlockAll: true }), state: "started", ...fields };
			sandboxes.set(sb.id, sb);
			inside.set(sb.id, { reads: 0, files: new Map(), sessions: new Map([["agentrun-computerd", { commands: new Map() }]]), running: sb.state === "started", installed: [], unknown: [], commandCount: 0 });
			return sb;
		},
	};
}
