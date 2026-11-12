// A fake of the phone harness's cloud (its HTTPS API, given to the provider as `fetch`) and of the cloud Android it
// rents (reached with adb, given to the provider as its `adb` transport). Nothing listens on a port and nothing waits on
// the wall clock: the API and the phone share `clock`, whose sleep() moves time on at once.
//
// The phone is what the provider meets over adb: the vendor's lock (`unlock <code>` once per connection), a file
// system under /data/local/tmp that `adb push`, `sha256sum` and `mv` work on, and adb's exec: service, which starts
// phoned from a jar the phone holds. phoned itself is a stand-in in this file (hello, ping, apps.list, and an exec.run
// that answers only when cancelled), or what the `phoned` option starts: test/phoned/ starts the real Java core over
// its scripted phone there. Every adb call and every API request is recorded.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duplexPair } from "node:stream";
import { PHONE_GROUPS } from "../dist/index.js";
import { PROTOCOL_VERSION } from "../dist/protocol.js";

export const KEY = "fake-test-key";
export const SETTINGS = "com.android.settings";
export const SCREEN = { width: 360, height: 640 };
/** The phone's adb endpoint and unlock code in the vendor's own shapes (OpenAPI SessionAdb): a DNS name, and ph_ with 26 base32 letters. */
export const ADB_HOST = "live.phone-harness.test";
export const ADB_CODE = "ph_mfwcc5nknqaod7a4nwojzw2lzq";
/** The version phoned reports by default: this package's, as the jar built beside it says. */
export const PHONED_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
/** A jar for the provider to push: its bytes are a stand-in, since the phone here never runs them. */
const jarDir = mkdtempSync(join(tmpdir(), "computer-phoned-"));
process.once("exit", () => rmSync(jarDir, { recursive: true, force: true }));
export const PHONED_JAR = join(jarDir, "phoned.jar");
writeFileSync(PHONED_JAR, "phoned stand-in jar\n");
/** The service adb's exec: runs to start phoned, as the provider sends it: the jar, app_process, and stderr to a log. */
export const PHONED_SERVICE = /^exec:CLASSPATH=(\/data\/local\/tmp\/phoned-[0-9a-f]{16}\.jar) app_process \/ ai\.agentrun\.phoned\.android\.Main 2>(\/data\/local\/tmp\/phoned-[0-9a-f]{16}\.log)$/;

/** A clock whose sleep() moves time on at once: no test waits on the wall clock. */
export function fakeClock(start = Date.now()) {
	let now = start;
	return {
		now: () => now,
		sleep: async (ms) => {
			now += Math.max(0, ms);
		},
	};
}

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/**
 * A stand-in phoned on one end of a stream pair, answering JSON-RPC lines as phoned does: hello (its facts), ping,
 * apps.list, and exec.run, which answers only when $/cancelRequest names it (cancelled, -32800). Any other method is
 * -32601. Closing the stream's input ends it, as closing phoned's stdin does. `record` gets each request it reads.
 */
export function stubPhoned({ version = PHONED_VERSION, abi = "x86_64", release = "15", record = () => {}, onEnd = () => {} } = {}) {
	const [provider, phone] = duplexPair();
	const held = new Map();
	const send = (message) => {
		if (!phone.destroyed && phone.writable) phone.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	};
	const arch = { "arm64-v8a": "arm64", x86_64: "amd64" }[abi] ?? abi;
	const answer = ({ id, method, params }) => {
		if (method === "$/cancelRequest") {
			const waiting = held.get(params?.id);
			if (waiting !== undefined) {
				held.delete(params.id);
				send({ id: params.id, error: { code: -32800, message: "the request was cancelled" } });
			}
			return;
		}
		if (method === "hello") return send({ id, result: { protocol: PROTOCOL_VERSION, version, os: "android", ...(release ? { osVersion: release } : {}), kind: "android", arch, groups: [...PHONE_GROUPS] } });
		if (method === "ping") return send({ id, result: {} });
		if (method === "apps.list") return send({ id, result: { apps: [{ id: SETTINGS, name: "Settings" }] } });
		if (method === "exec.run") return void held.set(id, true);
		send({ id, error: { code: -32601, message: `phoned has no method ${method}` } });
	};
	let buffer = "";
	phone.setEncoding("utf8");
	phone.on("data", (chunk) => {
		buffer += chunk;
		for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
			const line = buffer.slice(0, at);
			buffer = buffer.slice(at + 1);
			const request = JSON.parse(line);
			record(request);
			answer(request);
		}
	});
	// stdin closed: phoned cancels what still runs and exits, which closes adb's exec: stream.
	phone.on("end", () => {
		held.clear();
		phone.end();
		onEnd();
	});
	return provider;
}

/** A stream that says words and closes, as a program that fails to start does on adb's exec: service. */
function says(words) {
	const [provider, phone] = duplexPair();
	phone.end(words);
	phone.resume();
	return provider;
}

/**
 * The fake. Options: `readyAfter`, how many GETs a new session stays provisioning (default 1); `start`, what a create
 * meets ("ok", "busy", "limit", "credit", "error": the session fails while provisioning); `loseAnswer`, the POST is
 * admitted and then its answer is lost (fetch rejects); `others`, sessions on the account this provider never made;
 * `loseRecovery`, the GET that recovers a create by its key is lost too; `cancelPost`, called once a POST /sessions is
 * admitted (a test aborts the create's signal in it), after which that fetch rejects as an aborted one does; `stall`,
 * called with each request's { method, path }: when it answers true, the request is never answered, and only its
 * signal ends it; `onList`, given GET /sessions' snapshot once it is taken and before it is answered, answers the
 * list to send (a test makes a phone in between, or leaves a live one out, as a lagging listing would); `postAnswer`,
 * what POST /sessions answers in place of its 202: "503" (the phone is made, and a gateway answers 503), "empty" (the
 * phone is made, and the 202 holds no session), "503-unmade" (a 503, and nothing is made);
 * `code`, the unlock code the phone takes (default the one the API gives); `endLag`, a DELETE ends the session
 * asynchronously, as the live service did in run 7: it stays listed and readable as `closing` for endLag more reads of
 * it (GET /sessions/{id}), then is gone (404); `unlockEcho`, a wrong unlock code is answered with the code it was given,
 * twice, on the reply's first line; `onServer(service, stage)`, called with each request to the local adb server
 * before it is handled ("before") and before its answer goes back ("after"): a promise it answers holds the request at
 * that stage until it settles, so a test can order a disconnect against a connect.
 *
 * The phone's phoned: `startPhoned({ jar, log, transport })` starts it when exec: names a jar the phone holds, and
 * answers the provider's end of its stdio (default the stand-in above, with `phonedVersion`, `abi` and `release`);
 * `pushFails`, adb push fails; `pushCorrupts`, a pushed jar lands with other bytes. The provider pushes PHONED_JAR
 * (give it as the provider's phoned option). `pm install -r` installs a file the phone holds (phone.installed, by its
 * sha256), or answers pm's Failure line with `installFails`.
 */
export function fakePhoneHarness({ readyAfter = 1, start = "ok", loseAnswer = false, loseRecovery = false, cancelPost, stall, onList, postAnswer, others = [], code, abi = "x86_64", release = "15", phonedVersion = PHONED_VERSION, startPhoned, pushFails = false, pushCorrupts = false, installFails = false, endLag = 0, unlockEcho = false, onServer, clock = fakeClock() } = {}) {
	const requests = [];
	const adbCalls = [];
	const sessions = new Map(others.map((s) => [s.id, { ...s }]));
	let next = 0;

	async function fetch(url, init = {}) {
		const u = new URL(url);
		const method = init.method ?? "GET";
		const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
		const body = init.body === undefined ? undefined : JSON.parse(init.body);
		requests.push({ method, path: u.pathname, headers, body });
		if (stall?.({ method, path: u.pathname })) {
			// A request that never answers: only its signal ends it, as an aborted fetch rejects.
			return new Promise((_, reject) => {
				const stop = () => reject(init.signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
				if (init.signal?.aborted) stop();
				else init.signal?.addEventListener("abort", stop, { once: true });
			});
		}
		if (headers.authorization !== `Bearer ${KEY}`) return json(401, { error: "invalid API key" });
		const path = u.pathname;
		if (method === "GET" && path === "/me") return json(200, { id: "acct_1", available: [] });
		if (method === "POST" && path === "/sessions") {
			const key = headers["idempotency-key"];
			if (!/^[A-Za-z0-9_-]{16,128}$/.test(key ?? "")) return json(400, { error: "bad Idempotency-Key" });
			if (start === "busy") return json(503, { error: "every phone is busy", code: "phones_busy", retry_after_seconds: 30 }, { "retry-after": "30" });
			if (start === "limit") return json(409, { error: "the account's sessions are full", code: "session_limit", session_limit: 1 });
			if (start === "credit") return json(403, { error: "insufficient credits", balance_cents: 0 });
			if (postAnswer === "503-unmade") return json(503, { error: "the gateway timed out" });
			const id = `sess_${(++next).toString().padStart(4, "0")}`;
			const session = {
				id,
				state: "provisioning",
				platform: body?.platform ?? "android",
				kind: body?.kind ?? "emulator",
				timeout_seconds: body?.timeout_seconds ?? 300,
				expires_at: clock.now() / 1000 + (body?.timeout_seconds ?? 300),
				request_key: key,
				screen: null,
				gets: 0,
			};
			sessions.set(id, session);
			if (loseAnswer) throw new TypeError("fetch failed: the connection was reset");
			if (cancelPost) {
				// The caller cancels once the service has admitted the request: fetch rejects as it does on an abort.
				cancelPost();
				if (init.signal?.aborted) throw init.signal.reason ?? new DOMException("This operation was aborted", "AbortError");
			}
			// The phone is made, and the answer says otherwise: a 5xx from a gateway, or a 2xx with no session in it.
			if (postAnswer === "503") return json(503, { error: "the gateway timed out" });
			if (postAnswer === "empty") return json(202, {});
			return json(202, view(session));
		}
		if (method === "GET" && path === "/sessions") {
			const snapshot = [...sessions.values()].map(view);
			return json(200, onList ? await onList(snapshot) : snapshot);
		}
		const byKey = /^\/sessions\/requests\/([^/]+)$/.exec(path);
		if (method === "GET" && byKey) {
			if (loseRecovery) throw new TypeError("fetch failed: the connection was reset");
			const found = [...sessions.values()].find((s) => s.request_key === byKey[1]);
			return found ? json(200, view(found)) : json(404, { error: "no such request" });
		}
		const adb = /^\/sessions\/([^/]+)\/adb$/.exec(path);
		if (method === "POST" && adb) {
			const s = sessions.get(adb[1]);
			if (!s) return json(404, { error: "no such session" });
			// The vendor's AdbConnection, unwrapped: 201, enabled, transport, host, port, code, expires_at.
			return json(201, { enabled: true, transport: "adb", host: ADB_HOST, port: 22220 + Number(s.id.slice(5)), code: ADB_CODE, expires_at: s.expires_at });
		}
		const one = /^\/sessions\/([^/]+)$/.exec(path);
		if (one) {
			const s = sessions.get(one[1]);
			if (!s) return json(404, { error: "no such session" });
			if (method === "DELETE") {
				// The end is asynchronous with endLag: the session stays, closing, for endLag more reads of it, then is gone.
				if (endLag > 0) {
					if (s.state !== "closing") Object.assign(s, { state: "closing", closingReads: endLag });
					return json(200, view(s));
				}
				sessions.delete(s.id);
				return json(200, { ...view(s), state: "closing" });
			}
			if (method === "GET" && s.state === "closing") {
				if (s.closingReads-- <= 0) {
					sessions.delete(s.id);
					return json(404, { error: "no such session" });
				}
				return json(200, view(s));
			}
			if (method === "GET") {
				if (s.state === "provisioning" && ++s.gets >= readyAfter) {
					if (start === "error") s.state = "error";
					else Object.assign(s, { state: "ready", screen: { w: SCREEN.width, h: SCREEN.height } });
				}
				if (s.state === "error") s.error = "the emulator did not boot";
				return json(200, view(s));
			}
		}
		return json(404, { error: `no route ${method} ${path}` });
	}

	const view = ({ gets, closingReads, ...s }) => ({ ...s, ...(s.state === "provisioning" ? { progress: { phase: "booting" } } : {}) });

	// --- the phone ---------------------------------------------------------------------------------------------------
	/**
	 * connected and unlocked: the adb server's endpoints, and those whose connection took the code; files: the phone's
	 * files by path, as their sha256; phoned: each phoned the phone started ({ jar, log, ended, stream: the provider's
	 * end of its stdio, which a test destroys as a phone that kills phoned does }), in order; calls: every
	 * request the stand-in phoneds read.
	 */
	const phone = { connected: new Set(), unlocked: new Set(), files: new Map(), phoned: [], calls: [], installed: [] };
	const expected = code ?? ADB_CODE;
	const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

	/** One shell command on the phone, by its command string: a chain of `a && b` runs while each exits 0. */
	function shell(command) {
		const result = (stdout = "", exitCode = 0) => ({ exitCode, stdout: Buffer.from(stdout), stderr: "" });
		if (command.includes(" && ")) {
			let out = "";
			for (const part of command.split(" && ")) {
				const one = shell(part.trim());
				out += one.stdout.toString("utf8");
				if (one.exitCode !== 0) return result(out, one.exitCode);
			}
			return result(out);
		}
		const w = command.split(/\s+/);
		if (w[0] === "echo") return result(`${w.slice(1).join(" ")}\n`);
		if (w[0] === "unlock") {
			// unlockEcho: a vendor that echoes the code it was given, twice, on the reply's first line.
			if (w[1] !== expected) return result(unlockEcho ? `wrong code ${w[1]}: ${w[1]} is not this phone's\n` : "wrong code\n");
			phone.unlockedNow = true;
			return result("unlocked\n");
		}
		// toybox sha256sum; the provider sends its stderr to /dev/null.
		if (w[0] === "sha256sum") {
			const sum = phone.files.get(w[1]);
			return sum === undefined ? result("", 1) : result(`${sum}  ${w[1]}\n`);
		}
		if (w[0] === "mv") {
			const sum = phone.files.get(w[1]);
			if (sum === undefined) return result("", 1);
			phone.files.delete(w[1]);
			phone.files.set(w[2], sum);
			return result();
		}
		// pm install -r <file> 2>&1: Success, or pm's Failure line (installFails) for a file the phone holds.
		if (w[0] === "pm" && w[1] === "install" && w[2] === "-r" && w[4] === "2>&1") {
			if (!phone.files.has(w[3])) return result(`Error: Unable to open file: ${w[3]}\nConsider using a file under /data/local/tmp/\n`, 1);
			if (installFails) return result("Performing Streamed Install\nFailure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package ai.agentrun.uifixture signatures do not match newer version; ignoring!]\n", 1);
			phone.installed.push(phone.files.get(w[3]));
			return result("Performing Streamed Install\nSuccess\n");
		}
		// What the live probe times phoned against: `input` (taps and swipes, which change nothing here) and a dump of the
		// tree to the terminal, as uiautomator writes it.
		if (w[0] === "input" && ["tap", "swipe", "keyevent"].includes(w[1])) return result();
		if (w[0] === "am" && w[1] === "start") return result(`Starting: Intent { ${w.slice(2).join(" ")} }\n`);
		if (w[0] === "wm" && w[1] === "size") return result("Physical size: 1080x2400\n");
		if (w[0] === "uiautomator" && w[1] === "dump" && w[2] === "/dev/tty") {
			return result(`<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="Network &amp; internet" package="com.android.settings" clickable="true" bounds="[0,300][1080,420]" /></hierarchy>UI hierchary dumped to: /dev/tty\n`);
		}
		if (w[0] === "getprop") return result(`${{ "ro.build.version.release": release, "ro.build.version.sdk": "35", "ro.product.model": "sdk_gphone64_x86_64", "ro.product.manufacturer": "Google" }[w[1]] ?? ""}\n`);
		return result(`/system/bin/sh: ${w[0]}: inaccessible or not found\n`, 127);
	}

	// --- adb: the spawned CLI (run, every argv recorded), the local adb server's socket protocol (server), and a
	// service's raw stream (open) --------------------------------------------------------------------------------------
	/** Each connected endpoint's transport id, as `adb devices -l` names it. */
	const transports = new Map();
	let nextTransport = 0;
	/** The streams open on each endpoint's transport: a disconnect closes them. */
	const streams = new Map();
	/** Every shell command the phone ran, in order. */
	const ran = [];
	const result = (stdout, exitCode = 0, stderr = "") => ({ ok: true, value: { exitCode, stdout: Buffer.from(stdout), stderr } });
	/** What a locked connection answers every shell, in the vendor's words (phone probe 1, 2026-11-08). */
	const LOCKED = "locked: run `adb shell unlock <code>` first\n";

	/**
	 * The adb server's one TCP transport per endpoint: a second connect reuses it, with its lock state, as the live run
	 * showed ("already connected to …"). The vendor's lock is per TCP connection, so a reused transport is still unlocked.
	 */
	function connectTo(endpoint) {
		if (phone.connected.has(endpoint)) return `already connected to ${endpoint}`;
		phone.connected.add(endpoint);
		if (!transports.has(endpoint)) transports.set(endpoint, String(++nextTransport));
		return `connected to ${endpoint}`;
	}
	function disconnectFrom(endpoint) {
		for (const stream of streams.get(endpoint) ?? []) stream.destroy();
		streams.delete(endpoint);
		phone.connected.delete(endpoint);
		phone.unlocked.delete(endpoint);
		transports.delete(endpoint);
		return `disconnected ${endpoint}`;
	}
	const serialOf = (transport) => [...transports].find(([, id]) => id === transport)?.[0];

	/**
	 * One shell service on the phone at serial, by its command string, as the vendor's endpoint answers it (docs,
	 * guides/connect-adb): until the connection is unlocked by the command `unlock <code>`, every shell answers `locked`.
	 */
	function shellOn(serial, command) {
		ran.push(command);
		if (!phone.unlocked.has(serial) && !/^unlock /.test(command)) return result(LOCKED);
		// Once unlocked, the vendor's endpoint passes every shell through, `unlock` included, to the phone's own sh, which
		// has no such command (live run 4).
		if (phone.unlocked.has(serial) && /^unlock /.test(command)) return result("/system/bin/sh: unlock: inaccessible or not found\n", 127);
		const out = shell(command.replace(/ 2>\/dev\/null$/, ""));
		if (phone.unlockedNow) {
			phone.unlocked.add(serial);
			phone.unlockedNow = false;
		}
		return { ok: true, value: out };
	}

	/** The spawned adb CLI: args, each recorded as /proc would show them. */
	async function run(args, options = {}) {
		adbCalls.push({ args: [...args], timeoutMs: options.timeoutMs });
		if (args[0] === "start-server") return result("");
		if (args[0] !== "-t") return result("", 1, "adb: usage");
		const serial = serialOf(args[1]);
		if (serial === undefined || !phone.connected.has(serial)) return result("", 1, `adb: device '${args[1]}' not found`);
		const rest = args.slice(2);
		if (rest[0] === "shell") return shellOn(serial, rest.slice(1).join(" "));
		if (rest[0] === "push") {
			// adb push goes over the sync service, which the vendor's lock does not stop: only a shell is locked.
			if (pushFails) return result("", 1, `adb: error: failed to copy '${rest[1]}' to '${rest[2]}': remote couldn't create file: Permission denied\n`);
			const bytes = readFileSync(rest[1]);
			phone.files.set(rest[2], sha256(pushCorrupts ? Buffer.concat([bytes, Buffer.from("x")]) : bytes));
			return result(`${rest[1]}: 1 file pushed, 0 skipped. 31.4 MB/s (${bytes.length} bytes in 0.002s)\n`);
		}
		return result("", 1, "adb: unknown command");
	}

	/**
	 * The local adb server, by its socket protocol: host:connect:<endpoint>, host:disconnect:<endpoint>, host:devices-l;
	 * and with { transport }, a socket bound to that phone first (host:transport-id:<id>), then a shell service with its
	 * command string (shell:<command>), answered with the command's output.
	 */
	async function server(service, options = {}) {
		serverCalls.push(options.transport === undefined ? service : `host:transport-id:${options.transport} ${service.replace(/unlock \S+/, "unlock [code]")}`);
		// A test may hold a request before the server handles it, or hold its answer after (onServer answers a promise to
		// wait on, for the stage "before" or "after").
		const before = onServer?.(service, "before");
		if (before) await before;
		const answer = handle(service, options);
		const after = onServer?.(service, "after");
		if (after) await after;
		return answer;
	}
	function handle(service, options) {
		if (options.transport !== undefined) {
			const serial = serialOf(options.transport);
			if (serial === undefined || !phone.connected.has(serial)) return { ok: false, error: { code: "vendor", vendor: "phone-harness", message: "the adb server refused host:transport-id: device not found" } };
			const shellService = /^shell:(.*)$/s.exec(service);
			if (!shellService) return { ok: false, error: { code: "vendor", vendor: "phone-harness", message: `the adb server does not know ${service.split(":")[0]}` } };
			const ran = shellOn(serial, shellService[1]);
			return { ok: true, value: ran.value.stdout.toString("utf8") };
		}
		const connect = /^host:connect:(.+)$/.exec(service);
		if (connect) return { ok: true, value: connectTo(connect[1]) };
		const disconnect = /^host:disconnect:(.+)$/.exec(service);
		if (disconnect) return { ok: true, value: disconnectFrom(disconnect[1]) };
		if (service === "host:devices-l") {
			return { ok: true, value: [...transports].map(([endpoint, id]) => `${endpoint}          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:${id}\n`).join("") };
		}
		return { ok: false, error: { code: "vendor", vendor: "phone-harness", message: `the adb server does not know ${service}` } };
	}
	const serverCalls = [];

	/**
	 * A service's raw stream on the phone (adb's exec:): the only one the provider opens is phoned's start. A locked
	 * connection answers `locked` and closes; a jar the phone does not hold fails as app_process does, in words, and
	 * closes; otherwise phoned starts and the stream is its stdio. When a disconnect drops the transport, the stream
	 * closes, as adb's does.
	 */
	async function open(service, options = {}) {
		serverCalls.push(`host:transport-id:${options.transport} ${service}`);
		const serial = serialOf(options.transport);
		if (serial === undefined || !phone.connected.has(serial)) return { ok: false, error: { code: "vendor", vendor: "phone-harness", message: "the adb server refused host:transport-id: device not found" } };
		if (!phone.unlocked.has(serial)) return { ok: true, value: says(LOCKED) };
		const start = PHONED_SERVICE.exec(service);
		if (!start) return { ok: true, value: says(`/system/bin/sh: ${service.slice("exec:".length).split(" ")[0]}: inaccessible or not found\n`) };
		const [, jar, log] = start;
		if (!phone.files.has(jar)) return { ok: true, value: says("Error: Could not find class 'ai.agentrun.phoned.android.Main'\n") };
		const started = { jar, log, ended: false };
		phone.phoned.push(started);
		const onEnd = () => (started.ended = true);
		const stream = startPhoned
			? await startPhoned({ jar, log, transport: options.transport })
			: stubPhoned({ version: phonedVersion, abi, release, record: (request) => phone.calls.push(request), onEnd });
		started.stream = stream;
		stream.once("close", onEnd);
		if (!streams.has(serial)) streams.set(serial, new Set());
		streams.get(serial).add(stream);
		stream.once("close", () => streams.get(serial)?.delete(stream));
		stream.pause();
		return { ok: true, value: stream };
	}

	/** The provider's adb transport: the spawned CLI, the server's socket protocol, and a service's raw stream. */
	const adb = { run, server, open };

	return {
		fetch,
		adb,
		clock,
		phone,
		sessions,
		/** Every API request, as { method, path, headers, body }. */
		requests: () => requests,
		/** Every spawned adb's argv. */
		adbCalls: () => adbCalls.map((c) => c.args),
		/** Every spawned adb's argv, with the bound it was given. */
		adbRuns: () => adbCalls.map((c) => ({ args: c.args, timeoutMs: c.timeoutMs })),
		/** Every request to the local adb server, and every stream opened through it. */
		serverCalls: () => [...serverCalls],
		/** The shell commands the phone ran, in order. */
		shells: () => [...ran],
		/** The phoneds the phone started that have not ended. */
		running: () => phone.phoned.filter((one) => !one.ended),
	};
}
