// How the Orgo provider reaches Orgo: its REST API (orgoRest), and, inside one computer, a channel (OrgoChannel) that
// runs a command as root, starts one that outlives the call, puts a file there, and carries computerd's stdio bridge.
// The provider sees only the OrgoChannel interface, so another transport (SSH: root on the computer's public port) can
// replace the terminal one without touching it. Every fact here is from docs.orgo.ai:
// - REST: https://www.orgo.ai/api, `Authorization: Bearer <key>`; an error answers { error, code } with its status.
// - POST /computers/{id}/bash { command, timeout }: synchronous, root (HOME=/root), the timeout clamped to 1-300 s, the
//   proxy waiting 30 s past it; it answers { exit_code, output }, stdout then stderr in output.
// - POST /files/upload, multipart: file, workspaceId, desktopId, destPath; with destPath the file goes to that computer
//   alone, at <destPath>/<file name>; at most 10 MB.
// - The terminal: wss://www.orgo.ai/desktops/{id}/ws/terminal?token=<the computer's VNC password>, a root `bash -l` in
//   a PTY, JSON text frames: input { type: "input", data } in, { type: "output", data } and { type: "exit", code } out.
//   It ends with the socket unless `session=<name>` names it; then the shell survives the socket.
// The key goes in the Authorization header and nowhere else; the VNC password only in the terminal socket's URL, held in
// memory for the call. Neither is in a word this module returns.
import { randomBytes } from "node:crypto";
import { PassThrough, type Readable, Writable } from "node:stream";
import { type ComputerErrorCode, errorOf, failFor, ok, type Result, vendorFail } from "./result.js";

/** This module's failures: one with code vendor names Orgo. */
const fail = failFor("orgo");

/** Orgo's API. */
export const ORGO_API_URL = "https://www.orgo.ai/api";
/** The most Orgo's one-step upload takes. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Orgo's bash call's longest timeout, in seconds. */
const BASH_MAX_S = 300;
/** How much longer than the command's own timeout Orgo's proxy waits for a bash call. */
const BASH_PROXY_MS = 30_000;
/** Where a detached start writes what it prints. */
export const START_LOG = "/tmp/agentrun-init.log";
/** The terminal session a session start runs in: it survives the socket. */
const SESSION = "agentrun-init";

/** One word for bash: single-quoted. */
export const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
/** An argv as one bash command line. */
export const commandLine = (argv: readonly string[]) => argv.map(quote).join(" ");

/** An Orgo REST failure: the error's code and words, and Orgo's status and code when it answered. */
export type OrgoFailure = Result<never> & { status?: number; orgoCode?: string };

export interface OrgoRest {
	/** Orgo's origin, from which the terminal socket's URL is made. */
	readonly origin: string;
	request<T>(method: string, path: string, options: { body?: unknown; form?: FormData; headers?: Record<string, string>; timeoutMs: number; signal?: AbortSignal }): Promise<Result<T> | OrgoFailure>;
}

const codeOfStatus = (status: number): ComputerErrorCode =>
	status === 401 || status === 403 ? "denied" : status === 404 ? "not_found" : status === 429 ? "limit" : status === 400 || status === 422 ? "invalid" : status === 409 ? "refused" : "vendor";

/** Orgo's REST API with a key: every call bounded, every failure a code and words that never hold the key. */
export function orgoRest({ apiKey, apiUrl = ORGO_API_URL, fetch: fetcher = globalThis.fetch }: { apiKey: string; apiUrl?: string; fetch?: typeof fetch }): OrgoRest {
	const base = apiUrl.replace(/\/+$/, "");
	const scrub = (text: string) => text.replaceAll(apiKey, "[key]").replace(/\s+/g, " ").slice(0, 300);
	return {
		origin: new URL(base).origin,
		async request<T>(method: string, path: string, { body, form, headers = {}, timeoutMs, signal }: { body?: unknown; form?: FormData; headers?: Record<string, string>; timeoutMs: number; signal?: AbortSignal }) {
			const what = `Orgo's ${method} ${path}`;
			if (signal?.aborted) return fail("aborted", `${what} was aborted before it was sent`);
			const bound = AbortSignal.timeout(timeoutMs);
			let response: Response;
			try {
				response = await fetcher(`${base}${path}`, {
					method,
					headers: { authorization: `Bearer ${apiKey}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
					...(form !== undefined ? { body: form } : body === undefined ? {} : { body: JSON.stringify(body) }),
					redirect: "error",
					signal: signal ? AbortSignal.any([signal, bound]) : bound,
				});
			} catch (error) {
				if (signal?.aborted) return fail("aborted", `${what} was aborted`);
				if (bound.aborted) return fail("timeout", `${what} did not answer within ${timeoutMs / 1000} s`);
				return vendorFail("orgo",`${what} failed: ${scrub(error instanceof Error ? error.message : String(error))}`);
			}
			const text = await response.text().catch(() => "");
			let parsed: unknown;
			try {
				parsed = text === "" ? undefined : JSON.parse(text);
			} catch {
				parsed = undefined;
			}
			if (response.ok) return ok(parsed as T);
			const { error, code } = (parsed ?? {}) as { error?: unknown; code?: unknown };
			const words = typeof error === "string" ? error : text || response.statusText;
			const orgoCode = typeof code === "string" ? code : undefined;
			const error_ = errorOf(codeOfStatus(response.status), `${what} answered ${response.status}: ${scrub(words)}${orgoCode ? ` (${orgoCode})` : ""}`, "orgo");
			return { ok: false as const, error: error_, status: response.status, ...(orgoCode ? { orgoCode } : {}) };
		},
	};
}

/** computerd's stdio bridge as a byte stream: what it prints, what it reads, and its end. */
export interface OrgoStream {
	readable: Readable;
	writable: Writable;
	close(): Promise<void>;
	/** What ended the stream, in words (an exit code, an error frame, a close code), or "" while it runs. */
	said(): string;
}

/** How a long-lived command is started: from bash, detached, or typed into a named terminal session. */
export type OrgoStart = "bash" | "session";

/** A provider's way into one of its Orgo computers, as root. Every result's words hold no key or password. */
export interface OrgoChannel {
	/** argv as root, in the foreground, within timeoutMs (at most 300 s): its exit code and what it printed. */
	run(computer: string, argv: readonly string[], options: { timeoutMs: number; signal?: AbortSignal }): Promise<Result<{ exitCode: number; output: string }>>;
	/** argv started as root so that it outlives this call and its channel; its output goes to a log in the computer. */
	start(computer: string, argv: readonly string[], options: { how: OrgoStart; timeoutMs: number; signal?: AbortSignal }): Promise<Result<void>>;
	/** argv as root with its stdin and stdout as a byte stream, from its first byte: computerd's bridge. */
	stdio(computer: string, argv: readonly string[], options: { timeoutMs: number; signal?: AbortSignal }): Promise<Result<OrgoStream>>;
	/** bytes as the file at path (an absolute path) in the computer. */
	upload(computer: string, path: string, bytes: Uint8Array, options: { timeoutMs: number; signal?: AbortSignal }): Promise<Result<void>>;
}

/** The parts of a WebSocket the terminal channel uses: Node's global WebSocket, or a fake. */
export interface OrgoSocket {
	addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown; code?: number; reason?: string }) => void): void;
	send(data: string): void;
	close(code?: number, reason?: string): void;
}
export type OrgoWebSocketFactory = (url: string) => OrgoSocket;

const defaultWebSocket: OrgoWebSocketFactory = (url) => new WebSocket(url) as unknown as OrgoSocket;

/** An open terminal: its frames as they come, and its end. */
interface Terminal {
	socket: OrgoSocket;
	onOutput(listener: (data: string) => void): void;
	onEnd(listener: (words: string) => void): void;
	send(data: string): void;
	close(): void;
	/** The frames seen so far, by kind (output, text, binary, exit, error, other), in words: "2 frames (1 output, 1 text)". */
	seen(): string;
	/** All the output so far: its last 64 KiB. */
	text(): string;
	/** What ended the terminal, in words, or undefined while it is open. */
	ended(): string | undefined;
	/** Resolves true once cond holds (checked on each output and at the end), false when ms pass first. */
	waitFor(cond: () => boolean, ms: number): Promise<boolean>;
}

/** How many times a line the shell never echoed is typed in all. */
const TYPE_TRIES = 3;

/**
 * Types line into the terminal's shell once it has prompted (any output: a shell still starting drops what is typed,
 * as Orgo's `bash -l` did live), and types it again when the shell has not heard it (heard(): its echo, or what it
 * prints) within echoMs, at most TYPE_TRIES times in all, all before deadline. Its error's words are the reason alone.
 */
async function typeLine(terminal: Terminal, line: string, heard: () => boolean, { deadline, echoMs }: { deadline: number; echoMs: number }): Promise<Result<void>> {
	const left = () => Math.max(1, deadline - Date.now());
	const prompted = await terminal.waitFor(() => terminal.text() !== "" || terminal.ended() !== undefined, left());
	if (!prompted) return fail("timeout", "the shell never prompted");
	for (let tries = 1; tries <= TYPE_TRIES; tries++) {
		const ended = terminal.ended();
		if (ended !== undefined) return vendorFail("orgo",ended);
		terminal.send(line);
		if (await terminal.waitFor(() => heard() || terminal.ended() !== undefined, Math.min(echoMs, left()))) {
			const after = terminal.ended();
			return after !== undefined && !heard() ? vendorFail("orgo",after) : ok(undefined);
		}
		if (Date.now() >= deadline) return fail("timeout", `the line was typed ${tries} ${tries === 1 ? "time" : "times"}, and the shell had not echoed it`);
	}
	return vendorFail("orgo",`the line was typed ${TYPE_TRIES} times, and the shell never echoed it`);
}

/** A frame's bytes as text, when they are: a string, an ArrayBuffer or a typed array; a Blob is read, in order. */
function frameText(data: unknown): { text: string; binary: boolean } | Promise<{ text: string; binary: boolean }> | undefined {
	if (typeof data === "string") return { text: data, binary: false };
	if (data instanceof ArrayBuffer) return { text: Buffer.from(data).toString("utf8"), binary: true };
	if (ArrayBuffer.isView(data)) return { text: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8"), binary: true };
	if (typeof Blob !== "undefined" && data instanceof Blob) return data.text().then((text) => ({ text, binary: true }));
	return undefined;
}

/**
 * The channel over Orgo's own calls: run is the bash call, upload the file upload, start a bash call that detaches the
 * command with setsid (or the command typed into the named terminal session, which survives the socket), and stdio the
 * root terminal made raw (`stty raw -echo`, so the PTY neither echoes nor rewrites a byte), whose output before a marker
 * line (the prompt, the typed line's echo) is dropped. The marker is printed from two words, so the echo of the line
 * that prints it never holds it.
 */
export function orgoTerminalChannel({
	rest,
	workspaceId,
	webSocket = defaultWebSocket,
	echoMs = 3_000,
}: {
	rest: OrgoRest;
	workspaceId: string;
	webSocket?: OrgoWebSocketFactory;
	/** How long a typed line waits for the shell's echo before it is typed again. */
	echoMs?: number;
}): OrgoChannel {
	const bash = async (computer: string, command: string, timeoutMs: number, signal?: AbortSignal): Promise<Result<{ exitCode: number; output: string }>> => {
		const timeout = Math.min(BASH_MAX_S, Math.max(1, Math.ceil(timeoutMs / 1000)));
		const ran = await rest.request<{ exit_code?: unknown; output?: unknown }>("POST", `/computers/${encodeURIComponent(computer)}/bash`, { body: { command, timeout }, timeoutMs: timeout * 1000 + BASH_PROXY_MS, ...(signal ? { signal } : {}) });
		if (!ran.ok) return ran;
		const { exit_code: exitCode, output } = ran.value ?? {};
		if (typeof exitCode !== "number") return vendorFail("orgo",`Orgo's bash call answered no exit code (${JSON.stringify(ran.value)?.slice(0, 200)})`);
		return ok({ exitCode, output: typeof output === "string" ? output : "" });
	};

	const open = async (computer: string, { session, timeoutMs, signal }: { session?: string; timeoutMs: number; signal?: AbortSignal }): Promise<Result<Terminal>> => {
		const read = await rest.request<{ vnc_password?: unknown }>("GET", `/computers/${encodeURIComponent(computer)}`, { timeoutMs, ...(signal ? { signal } : {}) });
		if (!read.ok) return read;
		const password = read.value?.vnc_password;
		if (typeof password !== "string" || password === "") return vendorFail("orgo",`Orgo gave no terminal password for ${computer}: is it running?`);
		const url = new URL(`/desktops/${encodeURIComponent(computer)}/ws/terminal`, rest.origin.replace(/^http/, "ws"));
		url.searchParams.set("token", password);
		if (session !== undefined) url.searchParams.set("session", session);
		let socket: OrgoSocket;
		try {
			socket = webSocket(url.href);
		} catch (error) {
			return vendorFail("orgo",`the terminal of ${computer} could not be opened: ${String((error as Error)?.message ?? error).replaceAll(password, "[password]").slice(0, 200)}`);
		}
		const outputs: Array<(data: string) => void> = [];
		const ends: Array<(words: string) => void> = [];
		let ended: string | undefined;
		let transcript = "";
		const waiters = new Set<() => void>();
		const poke = () => {
			for (const waiter of [...waiters]) waiter();
		};
		const end = (words: string) => {
			if (ended !== undefined) return;
			ended = words;
			for (const listener of ends) listener(words);
			poke();
		};
		// Binary frames as ArrayBuffers, where the socket takes the setting: no Blob to read out of order.
		if ("binaryType" in socket) (socket as { binaryType: string }).binaryType = "arraybuffer";
		const kinds = new Map<string, number>();
		const count = (kind: string) => kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
		// Output before the first listener (the prompt, which comes as the socket opens) is kept for it.
		const backlog: string[] = [];
		const output = (data: string) => {
			transcript = (transcript + data).slice(-65536);
			if (outputs.length === 0) backlog.push(data);
			for (const listener of outputs) listener(data);
			poke();
		};
		// The docs give JSON text frames; output that comes as plain text or binary frames is taken as the bytes it is.
		const take = ({ text, binary }: { text: string; binary: boolean }) => {
			let frame: { type?: unknown; data?: unknown; message?: unknown; code?: unknown } | undefined;
			try {
				const parsed: unknown = JSON.parse(text);
				frame = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && typeof (parsed as { type?: unknown }).type === "string" ? parsed : undefined;
			} catch {
				frame = undefined;
			}
			if (frame === undefined) {
				count(binary ? "binary" : "text");
				return output(text);
			}
			if (frame.type === "output" && typeof frame.data === "string") {
				count("output");
				output(frame.data);
			} else if (frame.type === "exit") {
				count("exit");
				end(`the terminal's program exited with ${String(frame.code)}`);
			} else if (frame.type === "error") {
				count("error");
				end(`the terminal said: ${String(frame.message).replaceAll(password, "[password]").slice(0, 200)}`);
			} else count("other");
		};
		// A frame read at once is taken at once; a Blob is read in order, and frames after it wait their turn.
		let order: Promise<void> = Promise.resolve();
		let reading = 0;
		socket.addEventListener("message", ({ data }) => {
			const read = frameText(data);
			if (read === undefined) return void count("other");
			if (!(read instanceof Promise) && reading === 0) return take(read);
			reading++;
			order = order
				.then(() => (read instanceof Promise ? read.then(take, () => void count("other")) : take(read)))
				.finally(() => {
					reading--;
				});
		});
		socket.addEventListener("close", ({ code, reason }) => end(`the terminal closed with ${code ?? "no code"}${reason ? ` (${String(reason).slice(0, 100)})` : ""}`));
		socket.addEventListener("error", () => end("the terminal's socket failed"));
		const terminal: Terminal = {
			socket,
			onOutput: (listener) => {
				outputs.push(listener);
				for (const data of backlog.splice(0)) listener(data);
			},
			onEnd: (listener) => (ended === undefined ? ends.push(listener) : listener(ended)),
			send: (data) => socket.send(JSON.stringify({ type: "input", data })),
			close: () => {
				try {
					socket.close(1000);
				} catch {
					// Closed already.
				}
			},
			seen: () => {
				const total = [...kinds.values()].reduce((sum, n) => sum + n, 0);
				return `${total} frame${total === 1 ? "" : "s"}${total === 0 ? "" : ` (${[...kinds].map(([kind, n]) => `${n} ${kind}`).join(", ")})`}`;
			},
			text: () => transcript,
			ended: () => ended,
			waitFor: (cond, ms) =>
				new Promise<boolean>((done) => {
					if (cond()) return done(true);
					const finish = (value: boolean) => {
						clearTimeout(timer);
						waiters.delete(check);
						done(value);
					};
					const check = () => {
						if (cond()) finish(true);
					};
					const timer = setTimeout(() => finish(cond()), ms);
					waiters.add(check);
				}),
		};
		const opened = await new Promise<Result<void>>((settle) => {
			const timer = setTimeout(() => settle(fail("timeout", `the terminal of ${computer} did not open within ${timeoutMs / 1000} s`)), timeoutMs);
			socket.addEventListener("open", () => {
				clearTimeout(timer);
				settle(ok(undefined));
			});
			terminal.onEnd((words) => {
				clearTimeout(timer);
				settle(vendorFail("orgo",`the terminal of ${computer} did not open: ${words}`));
			});
		});
		if (!opened.ok) {
			terminal.close();
			return opened;
		}
		return ok(terminal);
	};

	return {
		run: (computer, argv, { timeoutMs, signal }) => bash(computer, commandLine(argv), timeoutMs, signal),

		async upload(computer, path, bytes, { timeoutMs, signal }) {
			if (bytes.length > MAX_UPLOAD_BYTES) return fail("invalid", `Orgo's upload takes at most 10 MB, and ${path} is ${bytes.length} bytes`);
			const at = path.lastIndexOf("/");
			if (at < 0 || path.slice(at + 1) === "") return fail("invalid", `an upload goes to an absolute file path, not ${JSON.stringify(path)}`);
			const form = new FormData();
			form.set("file", new Blob([new Uint8Array(bytes)]), path.slice(at + 1));
			form.set("workspaceId", workspaceId);
			form.set("desktopId", computer);
			form.set("destPath", path.slice(0, at) || "/");
			const put = await rest.request("POST", "/files/upload", { form, timeoutMs, ...(signal ? { signal } : {}) });
			return put.ok ? ok(undefined) : put;
		},

		async start(computer, argv, { how, timeoutMs, signal }) {
			const detached = `${commandLine(argv)} </dev/null >>${START_LOG} 2>&1`;
			if (how === "bash") {
				const ran = await bash(computer, `setsid -f ${detached}`, timeoutMs, signal);
				if (!ran.ok) return ran;
				return ran.value.exitCode === 0 ? ok(undefined) : vendorFail("orgo",`starting ${argv[0]} from bash exited ${ran.value.exitCode}: ${ran.value.output.trim().slice(0, 300)}`);
			}
			const deadline = Date.now() + timeoutMs;
			const terminal = await open(computer, { session: SESSION, timeoutMs, ...(signal ? { signal } : {}) });
			if (!terminal.ok) return terminal;
			const typed = await typeLine(terminal.value, `exec ${detached}\r`, () => terminal.value.text().includes("exec "), { deadline, echoMs });
			terminal.value.close();
			return typed.ok ? ok(undefined) : fail(typed.error.code, `starting ${argv[0]} in the terminal session ${SESSION} failed: ${typed.error.message}`);
		},

		async stdio(computer, argv, { timeoutMs, signal }) {
			const deadline = Date.now() + timeoutMs;
			const opened = await open(computer, { timeoutMs, ...(signal ? { signal } : {}) });
			if (!opened.ok) return opened;
			const terminal = opened.value;
			const nonce = randomBytes(8).toString("hex");
			const marker = `AGENTRUN-BRIDGE-${nonce}`;
			const readable = new PassThrough();
			let said = "";
			let before = "";
			let through = false;
			let settle: (result: Result<void>) => void = () => {};
			const ready = new Promise<Result<void>>((done) => (settle = done));
			terminal.onOutput((data) => {
				if (through) return void readable.write(data);
				before = (before + data).slice(-65536);
				const at = before.indexOf(marker);
				if (at < 0) return;
				const after = before.slice(at + marker.length).replace(/^\r?\n/, "");
				through = true;
				settle(ok(undefined));
				if (after !== "") readable.write(after);
			});
			// What came before the marker, for the words of a bridge that never started: by kind, and its last bytes escaped.
			const sent = () => `the terminal sent ${terminal.seen()} and no marker; its last bytes: ${JSON.stringify(before.slice(-300))}`;
			terminal.onEnd((words) => {
				said = words;
				settle(vendorFail("orgo",`computerd's bridge in ${computer} ended before it started: ${words}; ${sent()}`));
				readable.end();
			});
			const late = (why: string) => fail("timeout", `computerd's bridge in ${computer} did not start within ${timeoutMs / 1000} s: ${why}; ${sent()}`);
			// Typed once the shell prompts, and again if it never echoed (it was still starting); then the marker, by the deadline.
			const line = `stty raw -echo; printf '%s%s\\n' AGENTRUN- BRIDGE-${nonce}; exec ${commandLine(argv)}\r`;
			const typed = await typeLine(terminal, line, () => through || before.includes("stty raw -echo"), { deadline, echoMs });
			if (!typed.ok) settle(typed.error.code === "timeout" ? late(typed.error.message) : fail(typed.error.code, `computerd's bridge in ${computer} did not start: ${typed.error.message}; ${sent()}`));
			else if (!(await terminal.waitFor(() => through || terminal.ended() !== undefined, Math.max(1, deadline - Date.now())))) settle(late("the shell echoed the line and printed no marker"));
			const started = await ready;
			if (!started.ok) {
				terminal.close();
				return started;
			}
			const writable = new Writable({
				write(chunk: Buffer, _encoding, done) {
					try {
						terminal.send(chunk.toString("utf8"));
						done();
					} catch (error) {
						done(error instanceof Error ? error : new Error(String(error)));
					}
				},
			});
			return ok({
				readable,
				writable,
				close: async () => {
					terminal.close();
					readable.end();
				},
				said: () => said,
			});
		},
	};
}
