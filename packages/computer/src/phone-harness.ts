// The phone kind on the phone harness's cloud phones (phone-harness.com): a cloud Android rented by the minute through
// its HTTPS API, and driven over adb. No computerd runs on a phone: connect() gives a client in this process that
// answers the protocol's phone groups (screen, input.touch, input.keys, apps, apps.ui_tree) with adb commands, and
// refuses the rest in words. A cloud iPhone (driven by the API's control URL) is a later change: platform "ios" is
// refused for now.
//
// The library reads no environment: the API key and every setting are options (serve passes PHONE_HARNESS_API_KEY as
// apiKey). The vendor keeps no labels on a session, so the provider keeps its own in a ledger (an option: serve's store,
// in memory by default): list, attach, release and the janitor see only the sessions the ledger names, never another
// session on the same account.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { crc32, deflateSync } from "node:zlib";
import { checkActions } from "./actions.js";
import type { KindCapabilities } from "./kinds.js";
import type { MountKind } from "./mount.js";
import {
	type ComputerClient,
	type DaemonErrorKind,
	type DaemonMethod,
	type DaemonMethods,
	type Group,
	type HelloResult,
	type InputAction,
	type InputActionsResult,
	MAX_CHUNK_BYTES,
	MAX_UI_NODES,
	type Rect,
	type UiNode,
} from "./protocol.js";
import {
	type AttachedComputer,
	type CallContext,
	type ComputerCapabilities,
	type ComputerConnection,
	type ComputerInfo,
	type ComputerProvider,
	type ComputerRef,
	type ComputerSpec,
	type CreatedComputer,
	checkLifetime,
	type NetworkPolicy,
	type NetworkSpec,
	type Refusal,
} from "./provider.js";
import { type ComputerErrorCode, fail, ok, type Result } from "./result.js";
import { listTested } from "./test-connection.js";

/** The phone harness's API. */
export const PHONE_HARNESS_URL = "https://api.phone-harness.com";
/** What a cloud Android offers through this provider, as its capabilities and hello declare them. */
export const PHONE_GROUPS: readonly Group[] = ["screen", "input.touch", "input.keys", "apps", "apps.ui_tree"];
/** A phone mounts no folder. */
export const MOUNT: readonly MountKind[] = [];
/** The one configuration it offers, as its capabilities() declare it: the kind registry's entry holds the same. */
export const CAPABILITIES: readonly KindCapabilities[] = [{ kind: "android", groups: [...PHONE_GROUPS] }];
/** The longest lifetime by default: a rented phone bills by the minute. */
export const DEFAULT_MAX_LIFETIME_MS = 30 * 60_000;
/** How long create waits for a phone to be ready by default: the service's own CLI waits 240 s. */
export const DEFAULT_READY_MS = 240_000;
/** How long one API request may take by default: a stalled request is cut off, and create's own calls stay bounded. */
const DEFAULT_REQUEST_MS = 30_000;
/** How long one adb call may take. */
const ADB_TIMEOUT_MS = 30_000;
/** The user every shell command on an Android runs as: shell, 2000. */
const SHELL_USER = "2000:2000";

const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** One phone this provider made, as its ledger keeps it. */
export interface PhoneLedgerEntry {
	/** The session's id, the computer's id and name. */
	id: string;
	labels: Record<string, string>;
	/** The image create was asked for, read back as asked. */
	image: string;
	/** When the service ends the session, ISO time. */
	deadline: string;
	/**
	 * The Idempotency-Key of a create not answered yet: the entry is put before the POST, under the id pending-<key>,
	 * so a phone made under a create whose answer and recovery were both lost is still found. list() takes the account's
	 * session whose request_key is exactly this key as the entry's phone.
	 */
	request?: string;
	/**
	 * When release sent the phone's DELETE, ISO time. The service ends a session asynchronously (live run 7): the
	 * entry is kept, marked, until the phone's own GET is a 404. A phone so marked is not listed, and attach, connect
	 * and network answer not_found, as for a deleted computer; a second release of it is ok.
	 */
	released?: string;
}

/** The ledger's id for a create not answered yet. */
const pendingId = (requestKey: string) => `pending-${requestKey}`;

/** Where the provider keeps its phones' labels: the vendor keeps none. Each call may be sync or async. */
export interface PhoneLedger {
	put(entry: PhoneLedgerEntry): void | Promise<void>;
	get(id: string): PhoneLedgerEntry | undefined | Promise<PhoneLedgerEntry | undefined>;
	list(): PhoneLedgerEntry[] | Promise<PhoneLedgerEntry[]>;
	remove(id: string): void | Promise<void>;
}

/** A ledger in this process's memory: the default, and enough for one process that makes and ends its phones. */
export function memoryLedger(): PhoneLedger {
	const entries = new Map<string, PhoneLedgerEntry>();
	return {
		put: (entry) => void entries.set(entry.id, structuredClone(entry)),
		get: (id) => structuredClone(entries.get(id)),
		list: () => [...entries.values()].map((entry) => structuredClone(entry)),
		remove: (id) => void entries.delete(id),
	};
}

/** A ledger call that threw: the store could not be read or written. */
class LedgerFailure extends Error {}

/** The ledger with every throw, sync or async, made a LedgerFailure in words. */
function guardedLedger(ledger: PhoneLedger): PhoneLedger {
	const guard =
		<A extends unknown[], T>(how: "read" | "written", call: (...args: A) => T | Promise<T>) =>
		async (...args: A): Promise<T> => {
			try {
				return await call(...args);
			} catch (error) {
				throw new LedgerFailure(`the phone ledger could not be ${how}: ${error instanceof Error ? error.message : String(error)}`);
			}
		};
	return {
		put: guard("written", (entry: PhoneLedgerEntry) => ledger.put(entry)),
		get: guard("read", (id: string) => ledger.get(id)),
		list: guard("read", () => ledger.list()),
		remove: guard("written", (id: string) => ledger.remove(id)),
	};
}

/** fn's result, or a ledger that failed as a result in words: a provider's calls answer, never throw. */
async function ledgerSafe<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof LedgerFailure) return fail("phone", error.message);
		throw error;
	}
}

/** What one adb call gave: its exit code and output. */
export interface AdbResult {
	exitCode: number;
	stdout: Buffer;
	stderr: string;
}

/**
 * How the provider reaches adb. A spawned process's argv is in /proc for every user of the host, so no secret goes
 * there: the phone's endpoint goes only to the local adb server, over its socket (server), and the unlock code only
 * through a spawned adb's stdin (run's input). A spawned adb names its device by the adb server's transport id.
 */
export interface AdbTransport {
	/**
	 * Runs adb with args, and input on its stdin when given. A result in words when adb could not run at all (missing,
	 * timed out); otherwise its exit code and output, whatever they are. The words never hold the args or the input.
	 */
	run(args: string[], options: { timeoutMs: number; signal?: AbortSignal; input?: string }): Promise<Result<AdbResult>>;
	/**
	 * One request to the local adb server by its socket protocol (host:connect:<endpoint>, host:disconnect:<endpoint>,
	 * host:devices-l), starting the server first if need be: the answer's words. With transport, the socket is bound to
	 * that phone first (host:transport-id:<id>) and the service is one of the phone's (shell:<command>), answered with
	 * its output: how the unlock code reaches the phone with no argv holding it. The words never hold the request.
	 */
	server(service: string, options: { timeoutMs: number; transport?: string }): Promise<Result<string>>;
}

/** One adb call on a connected phone: the args after its -t <transport id>, a bound, and stdin. */
type AdbRun = (args: string[], options?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<Result<AdbResult>>;

/** The adb server's port when none is given: adb's own default. */
export const ADB_SERVER_PORT = 5037;

/**
 * The adb CLI (Android platform-tools) at path, by execFile, never a shell, and the adb server it starts, on the
 * loopback at port (adb's own default), spoken to by its socket protocol.
 */
export function adbCli(path = "adb", { port = ADB_SERVER_PORT }: { port?: number } = {}): AdbTransport {
	// Every spawned adb names the server the socket requests go to: without -P it would take its own default, 5037 or
	// ANDROID_ADB_SERVER_PORT, and start or ask another server.
	const run: AdbTransport["run"] = (args, { timeoutMs, signal, input }) =>
		new Promise((resolve) => {
			const child = execFile(path, ["-P", String(port), ...args], { encoding: "buffer", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024, ...(signal ? { signal } : {}) }, (error, stdout, stderr) => {
				const code = (error as NodeJS.ErrnoException | null)?.code;
				if (code === "ENOENT") {
					return resolve(fail("not_found", `the phone provider needs adb (Android platform-tools) on this machine: ${path} is not there; install platform-tools or give the provider's adb option`));
				}
				if (error && (error as { killed?: boolean }).killed) return resolve(fail("timeout", `adb did not finish within ${timeoutMs / 1000} s, so it was killed`));
				if (error && signal?.aborted) return resolve(fail("aborted", "adb was aborted"));
				if (error && typeof (error as { code?: unknown }).code !== "number") return resolve(fail("phone", `adb could not run: ${error.message.split("\n")[0]}`));
				resolve(ok({ exitCode: typeof code === "number" ? code : error ? 1 : 0, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr).toString("utf8") }));
			});
			// stdin always ends, so no adb waits on it; it carries the input when there is one.
			child.stdin?.on("error", () => undefined);
			child.stdin?.end(input ?? "");
		});
	let started: Promise<Result<AdbResult>> | undefined;
	const server: AdbTransport["server"] = async (service, { timeoutMs, transport }) => {
		const what = serviceWords(service);
		started ??= run(["start-server"], { timeoutMs });
		const start = await started;
		if (!start.ok || start.value.exitCode !== 0) {
			started = undefined;
			return start.ok ? fail("phone", `adb start-server failed: ${start.value.stderr.trim().split("\n")[0] || `exit code ${start.value.exitCode}`}`) : start;
		}
		const frame = (request: string) => `${Buffer.byteLength(request).toString(16).padStart(4, "0")}${request}`;
		return new Promise((resolve) => {
			let buffer = Buffer.alloc(0);
			let settled = false;
			// With a transport: first host:transport-id, whose OKAY binds the socket to the phone; then the service.
			let bound = transport === undefined;
			const done = (result: Result<string>) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.destroy();
				resolve(result);
			};
			const socket = createConnection({ host: "127.0.0.1", port });
			const timer = setTimeout(() => done(fail("timeout", `the adb server did not answer ${what} within ${timeoutMs / 1000} s`)), timeoutMs);
			socket.on("connect", () => socket.write(frame(bound ? service : `host:transport-id:${transport}`)));
			socket.on("data", (chunk) => {
				buffer = Buffer.concat([buffer, chunk]);
				if (bound || buffer.length < 4) return;
				const status = buffer.subarray(0, 4).toString("latin1");
				if (status !== "OKAY") return done(adbAnswer(buffer, `host:transport-id:${transport}`));
				buffer = buffer.subarray(4);
				bound = true;
				socket.write(frame(service));
			});
			socket.on("error", (error) => done(fail("phone", `the adb server on 127.0.0.1:${port} could not be reached for ${what}: ${error.message}`)));
			socket.on("close", () => {
				if (!bound) return done(fail("phone", `the adb server closed host:transport-id:${transport} before it answered`));
				// A phone's service answers OKAY and then its output, with no length: the output is what follows.
				if (transport !== undefined && buffer.subarray(0, 4).toString("latin1") === "OKAY") return done(ok(buffer.subarray(4).toString("utf8")));
				done(adbAnswer(buffer, what));
			});
		});
	};
	return { run, server };
}

/** A service as error words name it: its kind and first word, never the rest (a shell command's code, an endpoint). */
export function serviceWords(service: string): string {
	const [kind, rest = ""] = service.split(/:(.*)/s);
	return `${kind}:${rest.split(/[\s:]/)[0]}`;
}

/** The adb server's answer: OKAY, or FAIL and its words, each optionally followed by a length-prefixed message. */
export function adbAnswer(raw: Buffer, what: string): Result<string> {
	const status = raw.subarray(0, 4).toString("latin1");
	const rest = raw.subarray(4);
	const length = rest.length >= 4 ? Number.parseInt(rest.subarray(0, 4).toString("latin1"), 16) : Number.NaN;
	const message = Number.isSafeInteger(length) && length >= 0 && rest.length >= 4 + length ? rest.subarray(4, 4 + length).toString("utf8") : rest.toString("utf8");
	if (status === "OKAY") return ok(message);
	if (status === "FAIL") return fail("phone", `the adb server refused ${what}: ${message.trim()}`);
	return fail("phone", `the adb server answered ${what} with ${JSON.stringify(raw.subarray(0, 40).toString("latin1"))}, not OKAY or FAIL`);
}

export interface PhoneProviderOptions {
	/** The phone harness API key; serve passes PHONE_HARNESS_API_KEY. Never logged, never in an error. */
	apiKey: string;
	/** Which phone: "android", a temporary cloud emulator (the default). "ios" is refused until it is built. */
	platform?: "android" | "ios";
	/** The API's base URL; default PHONE_HARNESS_URL. */
	baseUrl?: string;
	/** fetch; default the global one. Tests give a fake. */
	fetch?: typeof globalThis.fetch;
	/** How adb is reached (AdbTransport), or the adb CLI's path; default adbCli("adb"). */
	adb?: AdbTransport | string;
	/** Where the provider's phones and their labels are kept; default memoryLedger(). */
	ledger?: PhoneLedger;
	/** The longest lifetime; default 30 min. */
	maxLifetimeMs?: number;
	/** How long create waits for a phone to be ready; default 240 s. */
	readyMs?: number;
	/** How often create asks whether the phone is ready; default 2 s. */
	pollMs?: number;
	/** The longest one API request may take; default 30 s. A readiness read takes no longer than readyMs has left. */
	requestMs?: number;
	/** The clock: ms since the epoch, and a wait. Tests give a fake that moves at once. */
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** A signal that fires after ms, which bounds a request; default AbortSignal.timeout. Tests give one they fire. */
	timeout?: (ms: number) => AbortSignal;
	/** The version the phone's hello reports; default the provider's. Only the conformance drift case sets another. */
	daemonVersion?: string;
}

/** The phone-harness provider from its options alone; throws in words when one is missing or wrong. */
export async function create(options: PhoneProviderOptions): Promise<PhoneHarnessProvider> {
	return new PhoneHarnessProvider(options);
}

/** The conformance CLI's module for the phone harness. */
export const conformance = () => import("./conformance/phone-harness.js");

const show = (value: unknown) => JSON.stringify(value) ?? String(value);
/** One argument for the phone's sh: single-quoted. */
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
/** An Android package id: dotted Java names. */
const APP_ID = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
/** An activity component: package/class. */
const COMPONENT = /^[A-Za-z][A-Za-z0-9_.]*\/[A-Za-z0-9_.$]+$/;
/** Go's names for the ABIs a phone reports. */
const ARCH: Record<string, string> = { "arm64-v8a": "arm64", x86_64: "amd64", x86: "386", "armeabi-v7a": "arm" };

interface Session {
	id: string;
	state: "provisioning" | "ready" | "error" | "closing";
	expires_at?: number;
	error?: string;
	adb?: { host?: string; port?: number; code?: string } | null;
	/** The Idempotency-Key the session was made under. */
	request_key?: string;
}

export class PhoneHarnessProvider implements ComputerProvider {
	readonly id = "phone-harness";
	readonly version = VERSION;
	readonly #apiKey: string;
	readonly #baseUrl: string;
	readonly #fetch: typeof globalThis.fetch;
	readonly #adb: AdbTransport;
	readonly #ledger: PhoneLedger;
	readonly #maxLifetimeMs: number;
	readonly #readyMs: number;
	readonly #pollMs: number;
	readonly #now: () => number;
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #requestMs: number;
	readonly #timeout: (ms: number) => AbortSignal;
	readonly #daemonVersion: string;
	/** How many open connections hold each endpoint's adb transport: the last to let go disconnects it. */
	readonly #holders = new Map<string, number>();

	constructor(options: PhoneProviderOptions) {
		const { apiKey, platform = "android" } = options ?? ({} as PhoneProviderOptions);
		if (typeof apiKey !== "string" || apiKey === "") throw new Error("the phone-harness provider needs options.apiKey: serve passes PHONE_HARNESS_API_KEY");
		if (platform === "ios") throw new Error('platform "ios" is not offered yet: the phone-harness provider rents a cloud Android; an iPhone is a later change');
		if (platform !== "android") throw new Error(`platform ${show(platform)} is not one of android, ios`);
		this.#apiKey = apiKey;
		this.#baseUrl = (options.baseUrl ?? PHONE_HARNESS_URL).replace(/\/+$/, "");
		this.#fetch = options.fetch ?? globalThis.fetch;
		const adb = options.adb;
		if (adb !== undefined && typeof adb !== "string" && !(typeof adb?.run === "function" && typeof adb?.server === "function")) {
			throw new Error("options.adb is the adb CLI's path, or a transport with run() and server()");
		}
		this.#adb = adb === undefined || typeof adb === "string" ? adbCli(adb ?? "adb") : adb;
		this.#ledger = guardedLedger(options.ledger ?? memoryLedger());
		this.#maxLifetimeMs = options.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS;
		if (!(Number.isSafeInteger(this.#maxLifetimeMs) && this.#maxLifetimeMs > 0)) throw new Error(`maxLifetimeMs ${show(options.maxLifetimeMs)} is not a whole number of milliseconds above 0`);
		this.#readyMs = options.readyMs ?? DEFAULT_READY_MS;
		this.#pollMs = options.pollMs ?? 2000;
		this.#now = options.now ?? (() => Date.now());
		this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.#requestMs = options.requestMs ?? DEFAULT_REQUEST_MS;
		if (!(Number.isSafeInteger(this.#requestMs) && this.#requestMs > 0)) throw new Error(`requestMs ${show(options.requestMs)} is not a whole number of milliseconds above 0`);
		this.#timeout = options.timeout ?? ((ms) => AbortSignal.timeout(ms));
		this.#daemonVersion = options.daemonVersion ?? VERSION;
	}

	capabilities(): ComputerCapabilities {
		return {
			kind: "android",
			os: "android",
			daemon: "none",
			lifetime: "vendor",
			network: ["open"],
			isolation: "vm",
			groups: [...PHONE_GROUPS],
			maxLifetimeMs: this.#maxLifetimeMs,
			release: ["delete"],
		};
	}

	check(spec: ComputerSpec): Refusal[] {
		const refusals = checkLifetime(spec?.lifetimeMs, this.capabilities());
		if (typeof spec?.image !== "string" || spec.image === "") refusals.push({ field: "image", message: "image is required: a name the phone is read back by (a cloud Android has no image to choose)" });
		if (spec?.network !== "open") refusals.push({ field: "network", message: `network ${show(spec?.network)}: a cloud phone's network is open, and it cannot be closed or narrowed` });
		if (spec?.user !== undefined) refusals.push({ field: "user", message: "user: a cloud phone has no user to choose; every command runs as the phone's shell user" });
		for (const field of ["cpus", "memoryMb", "pids", "workdir"] as const) {
			if (spec?.[field] !== undefined) refusals.push({ field, message: `${field}: a cloud phone's size and folders are the vendor's, and cannot be asked for` });
		}
		if (spec?.mount !== undefined) refusals.push({ field: "mount", message: "mount: a cloud phone mounts no folder" });
		return refusals;
	}

	// --- the API ---------------------------------------------------------------------------------------------------

	/** Words without the key, whatever the vendor echoed. */
	#clean(text: string): string {
		return text.replaceAll(this.#apiKey, "[the key]");
	}

	/**
	 * One request, bounded by ms (default requestMs) and by the caller's signal. A request cut off by its bound is
	 * `thrown`, like a lost answer: the service may have acted on it.
	 */
	async #api(
		method: string,
		path: string,
		{ body, headers = {}, signal, ms = this.#requestMs }: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal; ms?: number } = {},
	): Promise<Result<{ status: number; json: unknown }> & { thrown?: boolean }> {
		const bound = this.#timeout(Math.max(1, Math.ceil(ms)));
		const either = signal ? AbortSignal.any([signal, bound]) : bound;
		const cut = (error: unknown): Result<never> & { thrown?: boolean } => {
			if (signal?.aborted) return fail("aborted", `${method} ${path} was aborted`);
			if (bound.aborted) return { ...fail("timeout", `${method} ${path}: the phone harness did not answer within ${Math.round(ms / 100) / 10} s`), thrown: true };
			return { ...fail("unreachable", `${method} ${path}: the phone harness could not be reached: ${this.#clean((error as Error)?.message ?? String(error))}`), thrown: true };
		};
		let response: Response;
		try {
			response = await this.#fetch(`${this.#baseUrl}${path}`, {
				method,
				headers: { Authorization: `Bearer ${this.#apiKey}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: either,
			});
		} catch (error) {
			return cut(error);
		}
		let text: string;
		try {
			text = await response.text();
		} catch (error) {
			// The answer's body stalled or broke: as a lost answer when it was cut off, else no words.
			if (signal?.aborted || bound.aborted) return cut(error);
			text = "";
		}
		let json: unknown;
		try {
			json = text === "" ? undefined : JSON.parse(text);
		} catch {
			json = undefined;
		}
		if (response.ok) return ok({ status: response.status, json });
		const answer = (typeof json === "object" && json !== null ? json : {}) as { error?: string; code?: string; retry_after_seconds?: number };
		const said = this.#clean(answer.error ?? (text.slice(0, 200) || response.statusText || "no words"));
		const where = `${method} ${path}`;
		if (response.status === 401) return fail("denied", `${where}: the phone harness refused the API key (401): ${said}`);
		if (response.status === 403) return fail("denied", `${where}: ${said} (403)`);
		if (answer.code === "phones_busy") {
			const retry = answer.retry_after_seconds ?? Number(response.headers.get("retry-after"));
			return fail("limit", `${where}: ${said}${Number.isFinite(retry) && retry > 0 ? `; try again in ${retry} s` : ""} (phones_busy)`);
		}
		if (answer.code === "session_limit") return fail("limit", `${where}: ${said} (session_limit)`);
		if (response.status === 404) return fail("not_found", `${where}: ${said} (404)`);
		return fail("phone", `${where}: ${said} (${response.status}${answer.code ? `, ${answer.code}` : ""})`);
	}

	async #session(id: string, signal?: AbortSignal, ms?: number): Promise<Result<Session>> {
		const got = await this.#api("GET", `/sessions/${encodeURIComponent(id)}`, { ...(signal ? { signal } : {}), ...(ms === undefined ? {} : { ms }) });
		if (!got.ok) return got.error.code === "not_found" ? fail("gone", `${id} has ended`) : got;
		return sessionOf(got.value.json, `GET /sessions/${id}`);
	}

	/**
	 * DELETE of the phone. The service ends a session asynchronously, so the ledger forgets it only once its own GET is
	 * a 404. Until then its entry stays, marked released, and a second release of it answers ok.
	 */
	async #end(id: string): Promise<Result<void>> {
		const ended = await this.#api("DELETE", `/sessions/${encodeURIComponent(id)}`);
		if (!ended.ok && ended.error.code !== "not_found") return ended;
		if (ended.ok) {
			const read = await this.#session(id);
			const entry = await this.#ledger.get(id);
			if (!(!read.ok && read.error.code === "gone") && entry !== undefined) {
				await this.#ledger.put({ ...entry, released: entry.released ?? new Date(this.#now()).toISOString() });
				return ok(undefined);
			}
		}
		await this.#ledger.remove(id);
		return ok(undefined);
	}

	#deadlineOf(session: Session, fallback: number): string {
		return new Date(typeof session.expires_at === "number" && Number.isFinite(session.expires_at) ? session.expires_at * 1000 : fallback).toISOString();
	}

	// --- the provider ----------------------------------------------------------------------------------------------

	create(spec: ComputerSpec, context: { signal?: AbortSignal } = {}): Promise<Result<CreatedComputer>> {
		return ledgerSafe(() => this.#create(spec, context));
	}

	attach(ref: { id: string } | { labels: Record<string, string> }, context: CallContext = {}): Promise<Result<AttachedComputer>> {
		return ledgerSafe(() => this.#attach(ref, context));
	}

	list(labels: Record<string, string>, context: CallContext = {}): Promise<Result<ComputerInfo[]>> {
		return ledgerSafe(() => this.#list(labels, context));
	}

	network(ref: ComputerRef, policy?: NetworkSpec): Promise<Result<NetworkPolicy>> {
		return ledgerSafe(() => this.#network(ref, policy));
	}

	release(ref: ComputerRef, how: "stop" | "delete"): Promise<Result<void>> {
		return ledgerSafe(() => this.#release(ref, how));
	}

	connect(ref: ComputerRef): Promise<Result<ComputerConnection>> {
		return ledgerSafe(() => this.#connect(ref));
	}

	async #create(spec: ComputerSpec, { signal }: { signal?: AbortSignal } = {}): Promise<Result<CreatedComputer>> {
		const refusals = this.check(spec);
		if (refusals.length > 0) return fail("refused", refusals.map(({ field, message }) => `${field}: ${message}`).join("; "));
		if (signal?.aborted) return fail("aborted", "create was aborted before the phone harness was asked");
		const from = this.#now();
		const requestKey = randomBytes(16).toString("hex");
		const body = { platform: "android", kind: "emulator", timeout_seconds: Math.ceil(spec.lifetimeMs / 1000) };
		// The key goes into the ledger before the POST: whatever answers are lost, list() can find the phone by it.
		const pending = pendingId(requestKey);
		await this.#ledger.put({ id: pending, labels: { ...(spec.labels ?? {}) }, image: spec.image, deadline: new Date(from + spec.lifetimeMs).toISOString(), request: requestKey });
		let posted = await this.#api("POST", "/sessions", { body, headers: { "Idempotency-Key": requestKey }, ...(signal ? { signal } : {}) });
		const cancelled = !posted.ok && posted.error.code === "aborted";
		if (!posted.ok && (posted.thrown || cancelled)) {
			// The request may have been admitted though its answer was lost or cancelled: ask by its key, never POST again.
			// The ask is create's own, not under the caller's signal, which may have fired; a phone it finds is ended below.
			const recovered = await this.#api("GET", `/sessions/requests/${requestKey}`);
			if (!recovered.ok) {
				return fail(cancelled ? "aborted" : "phone", `${posted.error.message}; and the service has no session for the request: ${recovered.error.message}; the ledger keeps the request's key, so list() finds the phone if it was made`);
			}
			posted = recovered;
		}
		if (!posted.ok) {
			// The phone harness refused the request: nothing was made, and the key is forgotten.
			await this.#ledger.remove(pending);
			return posted;
		}
		const first = sessionOf(posted.value.json, "POST /sessions");
		if (!first.ok) return first;
		const id = first.value.id;
		/** A ledger write about the phone, or the phone ended in words: a phone its ledger cannot record would bill unseen. */
		const record = async (write: () => void | Promise<void>): Promise<Result<void>> => {
			try {
				await write();
				return ok(undefined);
			} catch (error) {
				// Ended at once, by the API alone: the ledger has just failed.
				const ended = await this.#api("DELETE", `/sessions/${encodeURIComponent(id)}`);
				const after = ended.ok || ended.error.code === "not_found" ? "the phone was ended" : `the phone ${id} could not be ended (${ended.error.message})`;
				return fail("phone", `${error instanceof Error ? error.message : String(error)}; ${after}`);
			}
		};
		const named = await record(async () => {
			await this.#ledger.put({ id, labels: { ...(spec.labels ?? {}) }, image: spec.image, deadline: this.#deadlineOf(first.value, from + spec.lifetimeMs) });
			await this.#ledger.remove(pending);
		});
		if (!named.ok) return named;
		const ended = async (code: ComputerErrorCode, words: string) => {
			const gone = await this.#end(id);
			return fail(code, `${words}; ${gone.ok ? "it was ended" : `it could not be ended (${gone.error.message})`}`);
		};
		if (cancelled) return ended("aborted", `create was aborted during POST /sessions, after the service made the phone ${id}`);
		let session = first.value;
		for (;;) {
			if (signal?.aborted) return ended("aborted", `create was aborted while the phone ${id} started`);
			// A read takes no longer than readyMs has left, so a stalled one cannot hold create past it.
			const left = this.#readyMs - (this.#now() - from);
			const read = await this.#session(id, signal, Math.max(1, Math.min(this.#requestMs, left)));
			if (!read.ok && read.error.code === "timeout") return ended("timeout", `the phone ${id} was not ready within ${this.#readyMs / 1000} s: ${read.error.message}`);
			if (!read.ok) return ended(read.error.code === "gone" ? "phone" : read.error.code, `the phone ${id} did not start: ${read.error.message}`);
			session = read.value;
			if (session.state === "ready") break;
			if (session.state !== "provisioning") return ended("phone", `the phone ${id} did not start: ${this.#clean(session.error ?? session.state)}`);
			if (this.#now() - from >= this.#readyMs) return ended("timeout", `the phone ${id} was not ready within ${this.#readyMs / 1000} s`);
			await this.#sleep(this.#pollMs);
		}
		const deadline = this.#deadlineOf(session, from + spec.lifetimeMs);
		const kept = await record(() => this.#ledger.put({ id, labels: { ...(spec.labels ?? {}) }, image: spec.image, deadline }));
		if (!kept.ok) return kept;
		const took = this.#now() - from;
		if (this.#now() >= Date.parse(deadline)) {
			return ended("timeout", `the phone ${id}'s lifetime of ${spec.lifetimeMs / 1000} s ended before it was ready (it took ${Math.round(took / 100) / 10} s)`);
		}
		return ok({ id, name: id });
	}

	async #attach(ref: { id: string } | { labels: Record<string, string> }, { signal }: CallContext = {}): Promise<Result<AttachedComputer>> {
		let entry: PhoneLedgerEntry | undefined;
		if ("id" in ref) {
			entry = await this.#ledger.get(ref.id);
			if (entry === undefined) return fail("not_found", `${ref.id} is not a phone this provider made`);
			if (entry.released !== undefined) return fail("not_found", `${ref.id} was released, and the service is ending it`);
		} else {
			// A pending entry is a create not answered yet, not a phone: list() adopts it once its phone is seen. A released
			// one is ending.
			const found = (await this.#ledger.list()).filter((one) => one.request === undefined && one.released === undefined && carries(one.labels, ref.labels));
			if (found.length === 0) return fail("not_found", `no phone of this provider carries the labels ${show(ref.labels)}`);
			if (found.length > 1) return fail("invalid", `${found.length} phones of this provider (${found.map((one) => one.id).join(", ")}) carry the labels ${show(ref.labels)}: attach takes one`);
			entry = found[0];
		}
		const id = (entry as PhoneLedgerEntry).id;
		const session = await this.#session(id, signal);
		if (!session.ok) {
			if (session.error.code === "gone") await this.#ledger.remove(id);
			return session;
		}
		if (session.value.state !== "ready" && session.value.state !== "provisioning") return fail("gone", `${id} is ${session.value.state}`);
		const deadline = new Date(this.#deadlineOf(session.value, Date.parse((entry as PhoneLedgerEntry).deadline)));
		return ok({ id, name: id, spec: { image: (entry as PhoneLedgerEntry).image, user: SHELL_USER, network: "open", deadline, kind: "android" } });
	}

	/**
	 * Settings' test: one GET /sessions, the account's sessions joined to the ledger, and a GET of any phone of the
	 * ledger the listing leaves out. It rents nothing.
	 */
	async testConnection(context: CallContext = {}): Promise<Result<{ detail: string }>> {
		return listTested("Phone harness", await this.list({}, context));
	}

	async #list(labels: Record<string, string>, { signal }: CallContext = {}): Promise<Result<ComputerInfo[]>> {
		// The ledger is read before the account's sessions: a phone whose entry is read was made before the GET, so it is
		// in its answer unless it is gone. An entry a create writes later is not seen by this list, and so not forgotten.
		const entries = await this.#ledger.list();
		const got = await this.#api("GET", "/sessions", signal ? { signal } : {});
		if (!got.ok) return got;
		if (!Array.isArray(got.value.json)) return fail("phone", `GET /sessions answered ${show(got.value.json).slice(0, 200)}, not a list`);
		const live = new Map<string, Session>();
		for (const one of got.value.json) {
			const session = sessionOf(one, "GET /sessions");
			if (session.ok) live.set(session.value.id, session.value);
		}
		const out: ComputerInfo[] = [];
		for (const listed of entries) {
			let entry = listed;
			if (entry.request !== undefined) {
				// A create not answered yet: its phone is the account's session whose request_key is exactly its key.
				const made = [...live.values()].find((session) => session.request_key === entry.request);
				if (made === undefined) {
					// Still being made, or never made: after its deadline nothing of it can be alive, and it is forgotten.
					if (this.#now() > Date.parse(entry.deadline)) await this.#ledger.remove(entry.id);
					continue;
				}
				entry = { id: made.id, labels: { ...entry.labels }, image: entry.image, deadline: this.#deadlineOf(made, Date.parse(entry.deadline)) };
				await this.#ledger.put(entry);
				await this.#ledger.remove(listed.id);
			}
			if (entry.released !== undefined) {
				// Released, and being ended: never listed. Forgotten once the listing leaves it out and its own GET is a 404,
				// or once its deadline has passed.
				if (this.#now() > Date.parse(entry.deadline)) await this.#ledger.remove(entry.id);
				else if (!live.has(entry.id)) {
					const read = await this.#session(entry.id, signal);
					if (!read.ok && read.error.code === "gone") await this.#ledger.remove(entry.id);
				}
				continue;
			}
			let session = live.get(entry.id);
			if (session === undefined) {
				// Not in the listing: its own GET says whether the service ended it (404), and only then is it forgotten.
				const read = await this.#session(entry.id, signal);
				if (!read.ok && read.error.code === "gone") {
					await this.#ledger.remove(entry.id);
					continue;
				}
				if (!read.ok) return read;
				session = read.value;
			}
			if (!carries(entry.labels, labels)) continue;
			out.push({
				ref: { id: entry.id, name: entry.id },
				labels: { ...entry.labels },
				deadline: new Date(this.#deadlineOf(session, Date.parse(entry.deadline))),
				state: session.state === "ready" || session.state === "provisioning" ? "running" : "stopped",
				network: "open",
			});
		}
		return ok(out);
	}

	async #network(ref: ComputerRef, policy?: NetworkSpec): Promise<Result<NetworkPolicy>> {
		const entry = await this.#ledger.get(ref.id);
		if (entry === undefined) return fail("not_found", `${ref.id} is not a phone this provider made`);
		if (entry.released !== undefined) return fail("not_found", `${ref.id} was released, and the service is ending it`);
		if (policy === undefined || policy === "open") return ok("open");
		return fail("refused", `network ${show(policy)}: a cloud phone's network is open, and it cannot be closed or narrowed`);
	}

	async #release(ref: ComputerRef, how: "stop" | "delete"): Promise<Result<void>> {
		if (how === "stop") return fail("unsupported", "a cloud phone has no stop: release it with delete, which ends the session");
		const entry = await this.#ledger.get(ref.id);
		if (entry?.released !== undefined) {
			// Released already, and the service may still be ending it: ok. Its own GET says whether it is gone, and then it is
			// forgotten; a phone the service still holds running is sent its DELETE again.
			const read = await this.#session(ref.id);
			if (!read.ok && read.error.code === "gone") {
				await this.#ledger.remove(ref.id);
				return ok(undefined);
			}
			if (!read.ok) return read;
			return read.value.state === "ready" || read.value.state === "provisioning" ? this.#end(ref.id) : ok(undefined);
		}
		if (entry === undefined) {
			// Not this provider's to end. Its own GET tells a phone already gone (ok, as release is idempotent) from another
			// session on the account, which is refused and never sent a DELETE.
			const read = await this.#session(ref.id);
			if (!read.ok) return read.error.code === "gone" ? ok(undefined) : read;
			return fail("not_found", `${ref.id} is not a phone this provider made: it is not ended`);
		}
		return this.#end(ref.id);
	}

	/**
	 * The adb server's transport id of the phone at endpoint, from host:devices-l, once it is a device: a connected
	 * phone may show as offline for a moment first.
	 */
	async #transportOf(endpoint: string): Promise<Result<string>> {
		let last = "not listed";
		for (let tries = 0; tries < 10; tries++) {
			if (tries > 0) await this.#sleep(500);
			const listed = await this.#adb.server("host:devices-l", { timeoutMs: ADB_TIMEOUT_MS });
			if (!listed.ok) return listed;
			const line = listed.value.split("\n").find((one) => one.trim().split(/\s+/)[0] === endpoint);
			const state = line?.trim().split(/\s+/)[1];
			const id = /\btransport_id:(\d+)\b/.exec(line ?? "")?.[1];
			if (state === "device" && id !== undefined) return ok(id);
			last = state ?? "not listed";
		}
		return fail("phone", `adb connected to the phone, and the adb server still lists it as ${last}, not a device`);
	}

	async #connect(ref: ComputerRef): Promise<Result<ComputerConnection>> {
		const entry = await this.#ledger.get(ref.id);
		if (entry === undefined) return fail("not_found", `${ref.id} is not a phone this provider made`);
		if (entry.released !== undefined) return fail("not_found", `${ref.id} was released, and the service is ending it`);
		const session = await this.#session(ref.id);
		if (!session.ok) return session;
		if (session.value.state !== "ready") return fail("gone", `${ref.id} is ${session.value.state}, not ready`);
		let link = session.value.adb;
		if (!(link?.host && link.port && link.code)) {
			const asked = await this.#api("POST", `/sessions/${encodeURIComponent(ref.id)}/adb`);
			if (!asked.ok) return asked;
			link = asked.value.json as Session["adb"];
		}
		const { host, port, code } = link ?? {};
		// The vendor's shapes (OpenAPI SessionAdb): a DNS name, a port, and a code ph_ and base32 letters. Anything outside
		// these characters is refused rather than passed to adb.
		if (typeof host !== "string" || !/^[A-Za-z0-9.:-]+$/.test(host) || !Number.isSafeInteger(port) || typeof code !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(code)) {
			return fail("phone", `the phone harness gave ${ref.id} no adb link this provider can use (a host, a port and an unlock code)`);
		}
		// The endpoint and the code never reach an argv: the endpoint goes to the adb server over its socket, the unlock as
		// a shell service on a socket the server bound to the phone, and every spawned adb names the phone by its transport id.
		const endpoint = `${host}:${port}`;
		const server = (service: string) => this.#adb.server(service, { timeoutMs: ADB_TIMEOUT_MS });
		const onPhone = (service: string, id: string) => this.#adb.server(service, { timeoutMs: ADB_TIMEOUT_MS, transport: id });
		const connected = await server(`host:connect:${endpoint}`);
		if (!connected.ok) {
			// This connect holds nothing: it drops the transport only when no other connection of this provider holds it.
			if (!this.#holders.get(endpoint)) await server(`host:disconnect:${endpoint}`).catch(() => undefined);
			return connected;
		}
		// The adb server keeps one transport per endpoint, and a second connect reuses it ("already connected"): every
		// connection to the phone holds it, and only the last to let go disconnects it (live run 4).
		this.#holders.set(endpoint, (this.#holders.get(endpoint) ?? 0) + 1);
		let held = true;
		const release = async () => {
			if (!held) return;
			held = false;
			const left = (this.#holders.get(endpoint) ?? 1) - 1;
			if (left > 0) return void this.#holders.set(endpoint, left);
			this.#holders.delete(endpoint);
			await server(`host:disconnect:${endpoint}`).catch(() => undefined);
		};
		const letGo = async <T>(failed: Result<T>): Promise<Result<T>> => {
			await release();
			return failed;
		};
		const said = connected.value.trim();
		if (!said.includes("connected") || /cannot|failed|unable/i.test(said)) return letGo(fail("phone", `adb could not reach the phone of ${ref.id}: ${said.split("\n")[0]}`));
		const transport = await this.#transportOf(endpoint);
		if (!transport.ok) return letGo(transport);
		const id = transport.value;
		const adb: AdbRun = (args, { timeoutMs = ADB_TIMEOUT_MS, signal } = {}) => this.#adb.run(["-t", id, ...args], { timeoutMs, ...(signal ? { signal } : {}) });
		// Ask first: the vendor's lock is per TCP connection, so a transport another connection unlocked answers at once,
		// and an `unlock` on it would reach the phone's own sh ("unlock: inaccessible or not found", live run 4).
		const asked = await onPhone("shell:echo ph-ok", id);
		if (!asked.ok) return letGo(asked);
		if (!asked.value.includes("ph-ok")) {
			if (!/^locked\b/.test(asked.value.trim())) return letGo(fail("phone", `the phone of ${ref.id} answered neither ph-ok nor locked: ${asked.value.trim().split("\n")[0]}`));
			// The vendor's unlock is the shell command `unlock <code>`, once per connection (docs, guides/connect-adb): the
			// shell service's own string, sent over the adb server's socket bound to the phone, so no argv holds the code.
			// Probe 1 (2026-11-08) showed it live: "unlocked", and getprop answered after it.
			const unlocked = await onPhone(`shell:unlock ${code}`, id);
			if (!unlocked.ok) return letGo(unlocked);
			// Another connect may have unlocked the transport meanwhile: the probe below is the judge, the answer only words.
			const probe = await adb(["shell", "echo ph-ok"]);
			if (!probe.ok) return letGo(probe);
			if (!probe.value.stdout.toString("utf8").includes("ph-ok")) {
				const words = unlocked.value.trim().split("\n")[0].replace(code, "[code]");
				return letGo(fail("phone", /\bunlocked\b/.test(unlocked.value) ? `the phone of ${ref.id} stayed locked after its unlock code` : `the phone of ${ref.id} refused its unlock code: ${words}`));
			}
		}
		const client = new AdbClient(id, adb, release, this.#sleep);
		const opened = await client.open(this.#daemonVersion);
		if (!opened.ok) {
			await client.closed();
			return opened;
		}
		const hello = opened.value;
		if (hello.version !== this.version) {
			await client.closed();
			return fail("refused", `hello: the daemon reports version ${hello.version}, expected ${this.version}`);
		}
		return ok({ client, hello, close: () => client.closed() });
	}
}

/** Whether labels carries every one of wanted. */
const carries = (labels: Record<string, string>, wanted: Record<string, string>) => Object.entries(wanted ?? {}).every(([key, value]) => labels[key] === value);

function sessionOf(json: unknown, where: string): Result<Session> {
	const s = json as Session | undefined;
	if (typeof s !== "object" || s === null || typeof s.id !== "string" || typeof s.state !== "string") return fail("phone", `${where} answered ${show(json).slice(0, 200)}, not a session`);
	return ok(s);
}

// --- the client: the protocol over adb ---------------------------------------------------------------------------

/** Android's keycode for each key name in KEYS. */
const KEYCODES: Record<string, string> = {
	enter: "ENTER",
	tab: "TAB",
	space: "SPACE",
	backspace: "DEL",
	delete: "FORWARD_DEL",
	escape: "ESCAPE",
	insert: "INSERT",
	up: "DPAD_UP",
	down: "DPAD_DOWN",
	left: "DPAD_LEFT",
	right: "DPAD_RIGHT",
	home: "MOVE_HOME",
	end: "MOVE_END",
	pageup: "PAGE_UP",
	pagedown: "PAGE_DOWN",
	shift: "SHIFT_LEFT",
	ctrl: "CTRL_LEFT",
	alt: "ALT_LEFT",
	super: "META_LEFT",
	capslock: "CAPS_LOCK",
	...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`])),
};
const BUTTON_KEYS = { back: "BACK", home: "HOME", app_switch: "APP_SWITCH" } as const;

type Call = Result<unknown>;
/** One action's shell commands; waitMs, a wait before them; busyMs, how long they take on the phone by design. */
type Plan = { commands: string[]; waitMs?: number; busyMs?: number };
const refuse = (code: ComputerErrorCode, message: string): Call => fail(code, message);

/** The in-process client of one cloud Android: each protocol method is one or more adb commands. */
class AdbClient implements ComputerClient {
	#closed = false;
	#hello: HelloResult | undefined;
	#size: [number, number] = [0, 0];
	#scale = 1;
	#held: { id: string; bytes: Buffer } | undefined;

	/** The disconnect close started, which the connection's close waits for. */
	#gone: Promise<unknown> = Promise.resolve();

	constructor(
		/** The adb server's transport id of the phone: no secret, so it may be in an argv. */
		readonly transport: string,
		readonly adb: AdbRun,
		/** Lets the adb server drop the phone's transport, by its endpoint over the server's socket. */
		readonly disconnect: () => Promise<unknown>,
		readonly sleep: (ms: number) => Promise<void>,
	) {}

	/** What the phone is: its ABI, its screen's size and density; then the hello it answers. */
	async open(version: string): Promise<Result<HelloResult>> {
		const abi = await this.#shell("getprop ro.product.cpu.abi");
		if (!abi.ok) return abi;
		const size = await this.#shell("wm size");
		if (!size.ok) return size;
		const density = await this.#shell("wm density");
		if (!density.ok) return density;
		const sizes = [...size.value.matchAll(/(\d+)x(\d+)/g)];
		const last = sizes.at(-1);
		if (!last) return fail("phone", `the phone (adb transport ${this.transport}) did not say its screen's size: ${size.value.trim().slice(0, 100)}`);
		this.#size = [Number(last[1]), Number(last[2])];
		const dpi = [...density.value.matchAll(/(\d+)/g)].at(-1);
		this.#scale = dpi ? Number(dpi[1]) / 160 : 1;
		const reported = abi.value.trim();
		this.#hello = { version, os: "android", kind: "android", arch: ARCH[reported] ?? reported, groups: [...PHONE_GROUPS] };
		return ok(this.#hello);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#held = undefined;
		this.#gone = this.disconnect().catch(() => undefined);
	}

	/** Closes, and waits until the adb server has let the phone's transport go. */
	async closed(): Promise<void> {
		this.close();
		await this.#gone;
	}

	/** One shell command on the phone: its stdout, or the failure in words. */
	async #shell(command: string, signal?: AbortSignal, timeoutMs?: number): Promise<Result<string>> {
		const ran = await this.adb(["shell", command], { ...(signal ? { signal } : {}), ...(timeoutMs === undefined ? {} : { timeoutMs }) });
		if (!ran.ok) return ran;
		if (ran.value.exitCode !== 0) {
			const why = (ran.value.stderr.trim() || ran.value.stdout.toString("utf8").trim()).split("\n")[0] || `exit code ${ran.value.exitCode}`;
			return fail("phone", `${command.split(" ").slice(0, 2).join(" ")} on the phone failed: ${why}`);
		}
		return ok(ran.value.stdout.toString("utf8"));
	}

	async #execOut(command: string): Promise<Result<Buffer>> {
		const ran = await this.adb(["exec-out", command], { timeoutMs: 60_000 });
		if (!ran.ok) return ran;
		if (ran.value.exitCode !== 0) return fail("phone", `${command.split(" ")[0]} on the phone failed: ${ran.value.stderr.trim().split("\n")[0] || `exit code ${ran.value.exitCode}`}`);
		return ok(ran.value.stdout);
	}

	async call<M extends DaemonMethod>(method: M, params: DaemonMethods[M]["params"], options: { signal?: AbortSignal } = {}): Promise<Result<DaemonMethods[M]["result"]>> {
		if (this.#closed) return fail("gone", "the connection to the phone is closed");
		if (options.signal?.aborted) return fail("aborted", `${method} was aborted`);
		return (await this.#answer(method as string, (params ?? {}) as Record<string, unknown>, options.signal)) as Result<DaemonMethods[M]["result"]>;
	}

	async #answer(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Call> {
		switch (method) {
			case "hello":
				return ok(this.#hello);
			case "ping":
				return ok({});
			case "screen.shot":
				return this.#shot(params.region);
			case "screen.read":
				return this.#read(params.id, params.offset);
			case "input.actions":
				return this.#actions(params.actions, signal);
			case "apps.list":
				return this.#appsList();
			case "apps.launch":
				return this.#launch(params.id);
			case "apps.terminate":
				return this.#terminate(params.id);
			case "apps.ui_tree":
				return this.#tree();
		}
		const group = method.split(".")[0];
		if (["exec", "files", "process", "tar"].includes(group)) return refuse("unsupported", `${method}: a phone has no shell in the computer protocol, so it offers no exec, files or processes`);
		if (method === "apps.install") return refuse("unsupported", "apps.install: this phone takes no files to install from");
		if (method === "deadline.extend") return refuse("unsupported", "deadline.extend: a cloud phone's session ends when the phone harness says; it has no extend");
		return refuse("unsupported", `${method} is not a method this phone answers`);
	}

	// --- screen --------------------------------------------------------------------------------------------------

	async #shot(region: unknown): Promise<Call> {
		const raw = await this.#execOut("screencap");
		if (!raw.ok) return raw;
		const frame = decodeScreencap(raw.value);
		if (!frame.ok) return frame;
		const { width, height, rgba } = frame.value;
		this.#size = [width, height];
		let rect: Rect = [0, 0, width, height];
		if (region !== undefined) {
			const r = region as number[];
			if (!(Array.isArray(r) && r.length === 4 && r.every((v) => Number.isSafeInteger(v)) && r[0] >= 0 && r[1] >= 0 && r[2] > 0 && r[3] > 0 && r[0] + r[2] <= width && r[1] + r[3] <= height)) {
				return refuse("invalid", `region ${show(region)} is not [x, y, w, h] inside the ${width}x${height} screen`);
			}
			rect = r as Rect;
		}
		const bytes = encodePng(rgba, width, rect);
		const id = randomBytes(6).toString("hex");
		this.#held = { id, bytes };
		const data = bytes.subarray(0, MAX_CHUNK_BYTES);
		return ok({ id, size: bytes.length, data: data.toString("base64"), eof: data.length === bytes.length, width: rect[2], height: rect[3], scale: this.#scale });
	}

	#read(id: unknown, offset: unknown): Call {
		const held = this.#held;
		if (held === undefined || held.id !== id) return refuse("not_found", `no shot ${show(id)} is held: take one with screen.shot`);
		if (!(Number.isSafeInteger(offset) && (offset as number) >= 0 && (offset as number) <= held.bytes.length)) return refuse("invalid", `offset ${show(offset)} is not inside the shot's ${held.bytes.length} bytes`);
		const data = held.bytes.subarray(offset as number, (offset as number) + MAX_CHUNK_BYTES);
		const eof = (offset as number) + data.length >= held.bytes.length;
		if (eof) this.#held = undefined;
		return ok({ data: data.toString("base64"), eof });
	}

	// --- input ---------------------------------------------------------------------------------------------------

	/** The shell commands of one action, or why the phone cannot do it. Its adb call gets busyMs on top of its bound. */
	#commands(action: InputAction): Plan | { kind: DaemonErrorKind; message: string } {
		const point = ([x, y]: [number, number]) => `${Math.round(x)} ${Math.round(y)}`;
		switch (action.type) {
			case "tap":
				return { commands: Array.from({ length: action.count ?? 1 }, () => `input tap ${point(action.at)}`) };
			case "long_press":
				return { commands: [`input swipe ${point(action.at)} ${point(action.at)} ${action.ms ?? 800}`], busyMs: action.ms ?? 800 };
			case "swipe": {
				const path = action.path;
				if (path.length === 2) return { commands: [`input swipe ${point(path[0])} ${point(path[1])} ${action.ms ?? 300}`], busyMs: action.ms ?? 300 };
				const last = path[path.length - 1];
				// input motionevent has no duration, so ms goes between the moves as toybox sleeps. Each segment takes its
				// share by length, evenly when the path has none. Each motionevent takes time of its own, so the swipe
				// lasts ms at least.
				const lengths = path.slice(1).map((p, i) => Math.hypot(p[0] - path[i][0], p[1] - path[i][1]));
				const total = lengths.reduce((sum, one) => sum + one, 0);
				const steps = [`input motionevent DOWN ${point(path[0])}`];
				let gone = 0;
				let walked = 0;
				for (const [i, p] of path.slice(1).entries()) {
					walked += total > 0 ? lengths[i] : 1;
					const by = action.ms === undefined ? 0 : Math.round((action.ms * walked) / (total > 0 ? total : lengths.length));
					if (by > gone) steps.push(`sleep ${(by - gone) / 1000}`);
					gone = by;
					steps.push(`input motionevent MOVE ${point(p)}`);
				}
				steps.push(`input motionevent UP ${point(last)}`);
				return { commands: [steps.join(";")], busyMs: gone };
			}
			case "button":
				return { commands: [`input keyevent KEYCODE_${BUTTON_KEYS[action.name]}`] };
			case "type": {
				if (/[^\x20-\x7e\n]/.test(action.text)) return { kind: "unsupported", message: "type: adb's input text takes printable ASCII and line breaks only" };
				const commands: string[] = [];
				for (const [i, line] of action.text.split("\n").entries()) {
					if (i > 0) commands.push("input keyevent KEYCODE_ENTER");
					// input text reads a % followed by s as a space, and nothing else. A space is sent as %s; a literal %s
					// is split across two calls, so its % ends one and its s starts the next and the two never meet.
					const pieces = line.split("%s");
					for (const [j, piece] of pieces.entries()) {
						const part = `${j > 0 ? "s" : ""}${piece}${j < pieces.length - 1 ? "%" : ""}`;
						if (part !== "") commands.push(`input text ${quote(part.replaceAll(" ", "%s"))}`);
					}
				}
				return { commands };
			}
			case "key": {
				if (action.keys.length !== 1) return { kind: "unsupported", message: `key ${show(action.keys)}: a combo of keys is not something adb's input keyevent can press; send one key at a time` };
				const key = action.keys[0];
				const press = KEYCODES[key] ? `input keyevent KEYCODE_${KEYCODES[key]}` : /^[a-z0-9]$/.test(key) ? `input keyevent KEYCODE_${key.toUpperCase()}` : `input text ${quote(key)}`;
				return { commands: Array.from({ length: action.repeat ?? 1 }, () => press) };
			}
			case "wait":
				return { commands: [], waitMs: action.ms };
			case "pinch":
				return { kind: "unsupported", message: "pinch: a cloud Android takes one finger through adb, so a pinch is not offered" };
			case "hold":
				return { kind: "unsupported", message: "hold: adb's input keyevent cannot keep a key down" };
			default:
				return { kind: "unsupported", message: `${(action as { type: string }).type} is not an action this phone takes` };
		}
	}

	/** A wait of ms, which ends early when signal fires. */
	async #pause(ms: number, signal?: AbortSignal): Promise<void> {
		if (signal === undefined) return this.sleep(ms);
		if (signal.aborted) return;
		let stop = () => {};
		// The listener is on before the sleep starts, so a cancel during it is never missed.
		const stopped = new Promise<void>((resolve) => {
			stop = resolve;
			signal.addEventListener("abort", stop, { once: true });
		});
		try {
			await Promise.race([this.sleep(ms), stopped]);
		} finally {
			signal.removeEventListener("abort", stop);
		}
	}

	async #actions(actions: unknown, signal?: AbortSignal): Promise<Call> {
		const refused = checkActions(actions, PHONE_GROUPS);
		if (refused !== undefined) return ok({ done: 0, failed: refused } satisfies InputActionsResult);
		const list = actions as InputAction[];
		const plans: Plan[] = [];
		for (const [index, action] of list.entries()) {
			const plan = this.#commands(action);
			if ("kind" in plan) return ok({ done: 0, failed: { index, kind: plan.kind, message: `action ${index}: ${plan.message}` } } satisfies InputActionsResult);
			for (const at of pointsOf(action)) {
				if (at[0] < 0 || at[1] < 0 || at[0] >= this.#size[0] || at[1] >= this.#size[1]) {
					return ok({ done: 0, failed: { index, kind: "invalid", message: `action ${index}: ${show(at)} is off the ${this.#size[0]}x${this.#size[1]} screen` } } satisfies InputActionsResult);
				}
			}
			plans.push(plan);
		}
		// A cancel stops the batch at the action it is on: before its wait, after it, and before each command.
		const cancelled = (index: number): Call => ok({ done: index, failed: { index, kind: "aborted", message: `action ${index}: the batch was aborted; actions ${index} on did not run` } } satisfies InputActionsResult);
		for (const [index, plan] of plans.entries()) {
			if (signal?.aborted) return cancelled(index);
			if (plan.waitMs !== undefined) {
				await this.#pause(plan.waitMs, signal);
				// A wait the cancel cut short is not done.
				if (signal?.aborted) return cancelled(index);
			}
			for (const command of plan.commands) {
				if (signal?.aborted) return cancelled(index);
				const ran = await this.#shell(command, signal, ADB_TIMEOUT_MS + (plan.busyMs ?? 0));
				if (!ran.ok) {
					const kind: DaemonErrorKind = ran.error.code === "timeout" || ran.error.code === "aborted" || ran.error.code === "not_found" ? ran.error.code : "invalid";
					return ok({ done: index, failed: { index, kind, message: `action ${index}: ${ran.error.message}` } } satisfies InputActionsResult);
				}
			}
		}
		return ok({ done: plans.length } satisfies InputActionsResult);
	}

	// --- apps ----------------------------------------------------------------------------------------------------

	async #foreground(): Promise<Result<string | null>> {
		const out = await this.#shell("dumpsys activity activities");
		if (!out.ok) return out;
		const found = /topResumedActivity=ActivityRecord\{[^}]*?\bu\d+ ([\w.]+)\//.exec(out.value) ?? /mResumedActivity: ActivityRecord\{[^}]*?\bu\d+ ([\w.]+)\//.exec(out.value);
		return ok(found ? found[1] : null);
	}

	async #appsList(): Promise<Call> {
		const out = await this.#shell("pm list packages");
		if (!out.ok) return out;
		const apps = out.value
			.split("\n")
			.filter((line) => line.startsWith("package:"))
			.map((line) => ({ id: line.slice("package:".length).trim() }))
			.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		const foreground = await this.#foreground();
		if (!foreground.ok) return foreground;
		return ok({ apps, foreground: foreground.value });
	}

	async #launch(id: unknown): Promise<Call> {
		if (typeof id !== "string" || !APP_ID.test(id)) return refuse("invalid", `id ${show(id)} is not an Android package id`);
		const resolved = await this.#shell(`cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${id}`);
		if (!resolved.ok) return resolved;
		const component = resolved.value
			.split("\n")
			.map((line) => line.trim())
			.reverse()
			.find((line) => COMPONENT.test(line));
		if (component === undefined) return refuse("not_found", `${id} has no activity to launch: is it installed?`);
		// The app named comes to the front, not whatever its task last held: on Android 15 Settings' task keeps search (another
		// package) on top, and a plain start resumes it there. A cleared task starts the app itself (phone probe 2).
		const started = await this.#shell(`am start -W --activity-clear-task -n ${component}`);
		if (!started.ok) return started;
		if (/Error:|Exception/.test(started.value)) return refuse("phone", `am start of ${component}: ${started.value.trim().split("\n").at(-1)}`);
		return ok({});
	}

	async #terminate(id: unknown): Promise<Call> {
		if (typeof id !== "string" || !APP_ID.test(id)) return refuse("invalid", `id ${show(id)} is not an Android package id`);
		const stopped = await this.#shell(`am force-stop ${id}`);
		return stopped.ok ? ok({}) : stopped;
	}

	async #tree(): Promise<Call> {
		const raw = await this.#execOut("uiautomator dump /dev/tty");
		if (!raw.ok) return raw;
		const text = raw.value.toString("utf8");
		const start = text.indexOf("<?xml");
		if (start < 0) return refuse("unsupported", `uiautomator gave no tree for this screen: ${text.trim().split("\n")[0] || "nothing"}`);
		return parseUiTree(text.slice(start, text.lastIndexOf(">") + 1), this.#size);
	}
}

/** Every point an action touches, to check against the screen. */
function pointsOf(action: InputAction): Array<[number, number]> {
	if (action.type === "tap" || action.type === "long_press") return [action.at];
	if (action.type === "swipe") return action.path;
	return [];
}

/** The frame `adb exec-out screencap` gives: a header (width, height, format, and a color space on newer Androids), then the pixels. */
export function decodeScreencap(raw: Buffer): Result<{ width: number; height: number; rgba: Buffer }> {
	if (raw.length < 12) return fail("phone", `screencap gave ${raw.length} bytes, not a frame`);
	const width = raw.readUInt32LE(0);
	const height = raw.readUInt32LE(4);
	const format = raw.readUInt32LE(8);
	const pixels = width * height * 4;
	const header = raw.length - pixels;
	if (!(width > 0 && height > 0 && (header === 12 || header === 16))) return fail("phone", `screencap gave ${raw.length} bytes for a ${width}x${height} frame`);
	const rgba = Buffer.from(raw.subarray(header));
	// 1 is RGBA_8888, 2 RGBX_8888 (alpha unset), 5 BGRA_8888.
	if (format === 2) for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
	else if (format === 5) for (let i = 0; i < rgba.length; i += 4) [rgba[i], rgba[i + 2]] = [rgba[i + 2], rgba[i]];
	else if (format !== 1) return fail("unsupported", `screencap gave pixel format ${format}, which this provider does not read`);
	return ok({ width, height, rgba });
}

/** An 8-bit RGBA PNG, non-interlaced, of rect of a width-wide RGBA frame. */
export function encodePng(rgba: Buffer, width: number, [x, y, w, h]: Rect): Buffer {
	const rows = Buffer.alloc((w * 4 + 1) * h);
	for (let row = 0; row < h; row++) {
		const from = ((y + row) * width + x) * 4;
		rgba.copy(rows, row * (w * 4 + 1) + 1, from, from + w * 4);
	}
	const chunk = (type: string, data: Buffer) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(typed) >>> 0);
		return Buffer.concat([length, typed, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr.set([8, 6, 0, 0, 0], 8);
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (text: string) =>
	text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, name: string) =>
		name[0] === "#" ? String.fromCodePoint(name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1))) : ENTITIES[name.toLowerCase()],
	);

/** uiautomator's dump as the protocol's tree: one root (the window's, or one over several), at most MAX_UI_NODES nodes. */
export function parseUiTree(xml: string, [width, height]: [number, number]): Result<{ root: UiNode; nodes: number; truncated: boolean }> {
	const top: UiNode[] = [];
	const stack: UiNode[] = [];
	let nodes = 0;
	let truncated = false;
	let dropped = 0;
	for (const tag of xml.matchAll(/<(\/?)node\b([^>]*?)(\/?)>/g)) {
		const [, closing, body, selfClosing] = tag;
		if (closing) {
			if (dropped > 0) dropped--;
			else stack.pop();
			continue;
		}
		if (dropped > 0 || nodes >= MAX_UI_NODES) {
			truncated = true;
			if (!selfClosing) dropped++;
			continue;
		}
		const attrs: Record<string, string> = {};
		for (const [, key, value] of body.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[key] = unescape(value);
		const box = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(attrs.bounds ?? "");
		const [x1, y1, x2, y2] = box ? box.slice(1).map(Number) : [0, 0, 0, 0];
		const bool = (key: string) => attrs[key] === "true";
		const node: UiNode = {
			role: attrs.class || "node",
			...(attrs["resource-id"] ? { id: attrs["resource-id"] } : {}),
			...(attrs.text ? { text: attrs.text } : {}),
			...(attrs["content-desc"] ? { label: attrs["content-desc"] } : {}),
			bounds: [x1, y1, Math.max(0, x2 - x1), Math.max(0, y2 - y1)],
			enabled: bool("enabled"),
			clickable: bool("clickable"),
			focused: bool("focused"),
			selected: bool("selected"),
			checked: bool("checked"),
			scrollable: bool("scrollable"),
			children: [],
		};
		nodes++;
		(stack.at(-1)?.children ?? top).push(node);
		if (!selfClosing) stack.push(node);
	}
	if (top.length === 0) return fail("phone", "uiautomator's dump held no node");
	if (top.length === 1) return ok({ root: top[0], nodes, truncated });
	return ok({ root: { role: "hierarchy", bounds: [0, 0, width, height], enabled: true, children: top }, nodes: nodes + 1, truncated });
}
