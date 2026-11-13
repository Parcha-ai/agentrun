// The phone kind on the phone harness's cloud phones (phone-harness.com): a cloud Android rented by the minute through
// its HTTPS API, and driven over adb. connect() pushes phoned (daemon-android/, the phone's driver: one dex jar) to the
// phone when it lacks it, starts it as the shell user through app_process, and speaks the protocol to it over adb's
// exec: service: phoned answers the phone groups (exec, screen, input.touch, input.keys, apps, ui) on the phone itself.
// A cloud iPhone (driven by the API's control URL) is a later change: platform "ios" is refused for now.
//
// The library reads no environment: the API key and every setting are options (serve passes PHONE_HARNESS_API_KEY as
// apiKey). The vendor keeps no labels on a session, so the provider keeps its own in a ledger (an option: serve's store,
// in memory by default): list, attach, release and the janitor see only the sessions the ledger names, never another
// session on the same account.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import type { Duplex } from "node:stream";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "./client.js";
import { CreateRequests, endedWords, labelsDiffer, otherSpecWords } from "./create-requests.js";
import { PHONE_GROUPS, PHONE_HARNESS } from "./descriptors/phone-harness.js";
import type { KindCapabilities } from "./kinds.js";
import type { MountKind } from "./mount.js";
import { type ComputerClient, type DaemonMethod, type DaemonMethods, type HelloResult, PROTOCOL_VERSION } from "./protocol.js";
import {
	type AttachedComputer,
	type CallContext,
	type ComputerCapabilities,
	type ComputerConnection,
	type ComputerInfo,
	type ComputerProvider,
	type ComputerRef,
	type ComputerSpec,
	type CreateContext,
	type CreatedComputer,
	checkGpu,
	checkTenure,
	type NetworkPolicy,
	type NetworkSpec,
	type Refusal,
	type ReleaseHow,
	runLifetimeMs,
} from "./provider.js";
import { type ComputerErrorCode, failFor, ok, type Result, vendorFail } from "./result.js";
import { daemonWatch, redactWords, type ScreenWatch, type ScreenWatchHandlers, type WatchOptions } from "./screen-watch.js";
import { listTested } from "./test-connection.js";

/** This module's failures: one with code vendor names the phone harness. */
const fail = failFor("phone-harness");

/** The phone harness's API. */
export const PHONE_HARNESS_URL = "https://api.phone-harness.com";
/** A phone mounts no folder. */
export const MOUNT: readonly MountKind[] = PHONE_HARNESS.mounts;
/** The one configuration it offers, as its capabilities() declare it: its descriptor's. */
export const CAPABILITIES: readonly KindCapabilities[] = PHONE_HARNESS.capabilities;
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
/** phoned's jar in this package, built by npm run build:phoned beside the compiled modules. */
const DEFAULT_PHONED_PATH = fileURLToPath(new URL("./phoned.jar", import.meta.url));
/** Where phoned's jars and logs go on a phone: the shell user's own directory. */
const PHONE_TMP = "/data/local/tmp";
/** How long a jar push may take: about 70 KB, over a link to a cloud phone. */
const PUSH_TIMEOUT_MS = 120_000;
/** How long phoned may take to start and answer hello: app_process starts a runtime first. */
const HELLO_TIMEOUT_MS = 30_000;

const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** One phone this provider made, as its ledger keeps it. */
export interface PhoneLedgerEntry {
	/** The session's id, the computer's id. */
	id: string;
	/** The computer's name, its request's (computerNameFor): a create of the same request finds the phone by it. */
	name: string;
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
/** The Idempotency-Key of a request: every create of one request id sends the same key, so the service can tell them one. */
const requestKeyOf = (requestId: string) => createHash("sha256").update(requestId, "utf8").digest("hex");
/**
 * How a spec differs from a phone of its request, as the ledger reads it back: its labels and its image, every field of
 * a spec check() lets a phone ask for but its network (always open) and its lifetime (each create counts its own).
 */
function phoneDiffer(spec: ComputerSpec, labels: Record<string, string>, image: string, seen: string): string[] {
	const differ = labelsDiffer(spec.labels ?? {}, labels, seen);
	if (spec.image !== image) differ.push(`image: asked ${spec.image}, ${seen} ${image}`);
	return differ;
}

/** Where the provider keeps its phones' labels: the vendor keeps none. Each call may be sync or async. */
export interface PhoneLedger {
	put(entry: PhoneLedgerEntry): void | Promise<void>;
	/** entry put only while the ledger holds none under its id, in one step (two writers never both put it): whether it was. */
	claim(entry: PhoneLedgerEntry): boolean | Promise<boolean>;
	get(id: string): PhoneLedgerEntry | undefined | Promise<PhoneLedgerEntry | undefined>;
	list(): PhoneLedgerEntry[] | Promise<PhoneLedgerEntry[]>;
	remove(id: string): void | Promise<void>;
}

/** A ledger in this process's memory: the default, and enough for one process that makes and ends its phones. */
export function memoryLedger(): PhoneLedger {
	const entries = new Map<string, PhoneLedgerEntry>();
	return {
		put: (entry) => void entries.set(entry.id, structuredClone(entry)),
		claim: (entry) => !entries.has(entry.id) && (entries.set(entry.id, structuredClone(entry)), true),
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
		claim: guard("written", (entry: PhoneLedgerEntry) => ledger.claim(entry)),
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
		if (error instanceof LedgerFailure) return vendorFail("phone-harness",error.message);
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
	/**
	 * A service of the phone on transport (exec:<command>) as a stream both ways: the adb server's socket, bound to the
	 * phone and then to the service, which carries the command's stdin and stdout raw once both answered OKAY. How phoned
	 * is started and spoken to. The stream comes paused, so nothing is lost before the caller listens: it resumes it. The
	 * words never hold the service.
	 */
	open(service: string, options: { timeoutMs: number; transport: string }): Promise<Result<Duplex>>;
}

/** One adb call on a connected phone: the args after its -t <transport id>, a bound, and stdin. */
type AdbRun = (args: string[], options?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<Result<AdbResult>>;

/** The adb server's port when none is given: adb's own default. */
export const ADB_SERVER_PORT = 5037;

/** The environment variables adb reads to find its server or its device: every one is dropped from a spawned adb's. */
const ADB_ENV = /^(ADB_|ANDROID_ADB_|ANDROID_SERIAL$)/;

/**
 * The adb CLI (Android platform-tools) at path, by execFile, never a shell, and the adb server it starts, on the
 * loopback at port (adb's own default), spoken to by its socket protocol.
 *
 * env is the environment a spawned adb starts from, with every adb variable dropped from it (ADB_SERVER_SOCKET,
 * ANDROID_ADB_SERVER_SOCKET, ANDROID_ADB_SERVER_ADDRESS, ANDROID_SERIAL, ...), so nothing in it points the CLI at
 * another server than its socket requests reach. The library reads no environment of its own: a caller passes it (the
 * conformance module passes process.env). Without env, a spawned adb inherits the process's environment as it is.
 */
export function adbCli(path = "adb", { port = ADB_SERVER_PORT, env }: { port?: number; env?: Readonly<Record<string, string | undefined>> } = {}): AdbTransport {
	// Every spawned adb names the server the socket requests go to: without -P it would take its own default, 5037 or
	// ANDROID_ADB_SERVER_PORT, and start or ask another server.
	const spawnEnv = env === undefined ? undefined : Object.fromEntries(Object.entries(env).filter(([name, value]) => value !== undefined && !ADB_ENV.test(name)));
	const run: AdbTransport["run"] = (args, { timeoutMs, signal, input }) =>
		new Promise((resolve) => {
			const child = execFile(path, ["-P", String(port), ...args], { encoding: "buffer", ...(spawnEnv ? { env: spawnEnv } : {}), timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024, ...(signal ? { signal } : {}) }, (error, stdout, stderr) => {
				const code = (error as NodeJS.ErrnoException | null)?.code;
				if (code === "ENOENT") {
					return resolve(fail("not_found", `the phone provider needs adb (Android platform-tools) on this machine: ${path} is not there; install platform-tools or give the provider's adb option`));
				}
				if (error && (error as { killed?: boolean }).killed) return resolve(fail("timeout", `adb did not finish within ${timeoutMs / 1000} s, so it was killed`));
				if (error && signal?.aborted) return resolve(fail("aborted", "adb was aborted"));
				if (error && typeof (error as { code?: unknown }).code !== "number") return resolve(vendorFail("phone-harness",`adb could not run: ${error.message.split("\n")[0]}`));
				resolve(ok({ exitCode: typeof code === "number" ? code : error ? 1 : 0, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr).toString("utf8") }));
			});
			// stdin always ends, so no adb waits on it; it carries the input when there is one.
			child.stdin?.on("error", () => undefined);
			child.stdin?.end(input ?? "");
		});
	let started: Promise<Result<AdbResult>> | undefined;
	/** The adb server, started once: a failed start is tried again by the next request. */
	const serverUp = async (timeoutMs: number): Promise<Result<void>> => {
		started ??= run(["start-server"], { timeoutMs });
		const start = await started;
		if (!start.ok || start.value.exitCode !== 0) {
			started = undefined;
			return start.ok ? vendorFail("phone-harness",`adb start-server failed: ${start.value.stderr.trim().split("\n")[0] || `exit code ${start.value.exitCode}`}`) : start;
		}
		return ok(undefined);
	};
	const frame = (request: string) => `${Buffer.byteLength(request).toString(16).padStart(4, "0")}${request}`;
	const server: AdbTransport["server"] = async (service, { timeoutMs, transport }) => {
		const what = serviceWords(service);
		const up = await serverUp(timeoutMs);
		if (!up.ok) return up;
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
			socket.on("error", (error) => done(vendorFail("phone-harness",`the adb server on 127.0.0.1:${port} could not be reached for ${what}: ${error.message}`)));
			socket.on("close", () => {
				if (!bound) return done(vendorFail("phone-harness",`the adb server closed host:transport-id:${transport} before it answered`));
				// A phone's service answers OKAY and then its output, with no length: the output is what follows.
				if (transport !== undefined && buffer.subarray(0, 4).toString("latin1") === "OKAY") return done(ok(buffer.subarray(4).toString("utf8")));
				done(adbAnswer(buffer, what));
			});
		});
	};
	const open: AdbTransport["open"] = async (service, { timeoutMs, transport }) => {
		const what = serviceWords(service);
		const up = await serverUp(timeoutMs);
		if (!up.ok) return up;
		return new Promise((resolve) => {
			let buffer = Buffer.alloc(0);
			let settled = false;
			// First host:transport-id, whose OKAY binds the socket to the phone; then the service, whose OKAY hands the
			// socket over to it.
			let asking = `host:transport-id:${transport}`;
			const socket = createConnection({ host: "127.0.0.1", port });
			/** The adb server's refusal: its answer is never OKAY here, so it is always a failure. */
			const refused = (raw: Buffer, of: string): Result<Duplex> => {
				const answer = adbAnswer(raw, of);
				return answer.ok ? vendorFail("phone-harness",`the adb server answered ${of} without OKAY`) : answer;
			};
			const done = (result: Result<Duplex>) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.off("data", onData);
				socket.off("error", onError);
				socket.off("close", onClose);
				if (!result.ok) socket.destroy();
				resolve(result);
			};
			const onData = (chunk: Buffer) => {
				buffer = Buffer.concat([buffer, chunk]);
				while (!settled && buffer.length >= 4) {
					const status = buffer.subarray(0, 4).toString("latin1");
					// FAIL is followed by its hex length and words: wait for them, or for the close that ends them.
					if (status !== "OKAY") {
						const length = buffer.length >= 8 ? Number.parseInt(buffer.subarray(4, 8).toString("latin1"), 16) : Number.NaN;
						if (status === "FAIL" && !(buffer.length >= 8 + length)) return;
						return done(refused(buffer, asking === service ? what : asking));
					}
					buffer = buffer.subarray(4);
					if (asking !== service) {
						asking = service;
						socket.write(frame(service));
						continue;
					}
					// The service's stream from here on: what came after its OKAY is the first of it.
					socket.pause();
					if (buffer.length > 0) socket.unshift(buffer);
					return done(ok(socket));
				}
			};
			const onError = (error: Error) => done(vendorFail("phone-harness",`the adb server on 127.0.0.1:${port} could not be reached for ${what}: ${error.message}`));
			const onClose = () => done(buffer.length >= 4 ? refused(buffer, asking === service ? what : asking) : vendorFail("phone-harness",`the adb server closed ${asking === service ? what : asking} before it answered`));
			const timer = setTimeout(() => done(fail("timeout", `the adb server did not answer ${what} within ${timeoutMs / 1000} s`)), timeoutMs);
			socket.on("connect", () => socket.write(frame(asking)));
			socket.on("data", onData);
			socket.on("error", onError);
			socket.on("close", onClose);
		});
	};
	return { run, server, open };
}

/** A service as error words name it: its kind and first word, never the rest (a shell command's code, an endpoint). */
export function serviceWords(service: string): string {
	const [kind, rest = ""] = service.split(/:(.*)/s);
	return `${kind}:${rest.split(/[\s:]/)[0]}`;
}

/**
 * The adb server's answer: OKAY, or FAIL and its words, each optionally followed by a length-prefixed message. FAIL's
 * words may name the phone's endpoint: they are redacted.
 */
export function adbAnswer(raw: Buffer, what: string): Result<string> {
	const status = raw.subarray(0, 4).toString("latin1");
	const rest = raw.subarray(4);
	const length = rest.length >= 4 ? Number.parseInt(rest.subarray(0, 4).toString("latin1"), 16) : Number.NaN;
	const message = Number.isSafeInteger(length) && length >= 0 && rest.length >= 4 + length ? rest.subarray(4, 4 + length).toString("utf8") : rest.toString("utf8");
	if (status === "OKAY") return ok(message);
	if (status === "FAIL") return vendorFail("phone-harness",`the adb server refused ${what}: ${redactWords(message.trim())}`);
	return vendorFail("phone-harness",`the adb server answered ${what} with ${JSON.stringify(raw.subarray(0, 40).toString("latin1"))}, not OKAY or FAIL`);
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
	/** The version phoned's hello must report; default the provider's own. Only the conformance drift case sets another. */
	daemonVersion?: string;
	/** phoned, the phone's driver, as its jar (npm run build:phoned); default this package's dist/phoned.jar. */
	phoned?: string;
	/**
	 * APK files installed on each phone before phoned starts there (`pm install -r`), as the conformance run installs the
	 * ui fixture (npm run build:ui-fixture). Default none. A connect that cannot install one fails in words.
	 */
	apks?: string[];
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
	/** Each create in flight, and the names of the phones this provider ended (create-requests.ts). Past this process, the
	 *  ledger's released entry is what holds, until the service has ended the phone. */
	readonly #requests = new CreateRequests();
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
	/** Each endpoint's host:disconnect still on its way: a connect to that endpoint waits for it before its own. */
	readonly #leaving = new Map<string, Promise<unknown>>();
	/**
	 * Each endpoint's phoned, started by its first connection and shared by all of them, as its adb transport is: a phone
	 * has one accessibility connection to give. The last holder's release ends it before the disconnect.
	 */
	readonly #daemons = new Map<string, Promise<Result<Phoned>>>();
	readonly #phonedPath: string;
	readonly #apks: readonly string[];
	/** Each file the provider puts on its phones (phoned's jar, the APKs), read once: its bytes' sha256 names it there. */
	readonly #files = new Map<string, Promise<Result<PhoneFile>>>();

	constructor(options: PhoneProviderOptions) {
		const { apiKey, platform = "android" } = options ?? ({} as PhoneProviderOptions);
		if (typeof apiKey !== "string" || apiKey === "") throw new Error("the phone-harness provider needs options.apiKey: serve passes PHONE_HARNESS_API_KEY");
		if (platform === "ios") throw new Error('platform "ios" is not offered yet: the phone-harness provider rents a cloud Android; an iPhone is a later change');
		if (platform !== "android") throw new Error(`platform ${show(platform)} is not one of android, ios`);
		this.#apiKey = apiKey;
		this.#baseUrl = (options.baseUrl ?? PHONE_HARNESS_URL).replace(/\/+$/, "");
		this.#fetch = options.fetch ?? globalThis.fetch;
		const adb = options.adb;
		if (adb !== undefined && typeof adb !== "string" && !(typeof adb?.run === "function" && typeof adb?.server === "function" && typeof adb?.open === "function")) {
			throw new Error("options.adb is the adb CLI's path, or a transport with run(), server() and open()");
		}
		this.#phonedPath = options.phoned ?? DEFAULT_PHONED_PATH;
		const apks = options.apks ?? [];
		if (!Array.isArray(apks) || !apks.every((path) => typeof path === "string" && path !== "")) throw new Error(`options.apks ${show(options.apks)} is not a list of APK paths`);
		this.#apks = [...apks];
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
			network: [...PHONE_HARNESS.network],
			isolation: "vm",
			groups: [...PHONE_GROUPS],
			maxLifetimeMs: this.#maxLifetimeMs,
			release: ["delete"],
		};
	}

	check(spec: ComputerSpec): Refusal[] {
		const refusals = checkTenure({ lifetimeMs: spec?.lifetimeMs, owner: spec?.owner }, this.capabilities(), "phone harness");
		if (typeof spec?.image !== "string" || spec.image === "") refusals.push({ field: "image", message: "image is required: a name the phone is read back by (a cloud Android has no image to choose)" });
		if (spec?.network !== "open") refusals.push({ field: "network", message: `network ${show(spec?.network)}: a cloud phone's network is open, and it cannot be closed or narrowed` });
		if (spec?.user !== undefined) refusals.push({ field: "user", message: "user: a cloud phone has no user to choose; every command runs as the phone's shell user" });
		for (const field of ["cpus", "memoryMb", "pids", "workdir"] as const) {
			if (spec?.[field] !== undefined) refusals.push({ field, message: `${field}: a cloud phone's size and folders are the vendor's, and cannot be asked for` });
		}
		if (spec?.mount !== undefined) refusals.push({ field: "mount", message: "mount: a cloud phone mounts no folder" });
		refusals.push(...checkGpu(spec?.gpu, this.capabilities()));
		return refusals;
	}

	// --- the API ---------------------------------------------------------------------------------------------------

	/** Words without the key, whatever the vendor echoed. */
	#clean(text: string): string {
		return text.replaceAll(this.#apiKey, "[the key]");
	}

	/**
	 * One request, bounded by ms (default requestMs) and by the caller's signal. A failure is `uncertain` when the
	 * service may have acted on the request all the same: no answer (lost, or cut off by its bound), or a 5xx other than
	 * phones_busy, the service's own word that nothing was made.
	 */
	async #api(
		method: string,
		path: string,
		{ body, headers = {}, signal, ms = this.#requestMs }: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal; ms?: number } = {},
	): Promise<Result<{ status: number; json: unknown }> & { uncertain?: boolean }> {
		const bound = this.#timeout(Math.max(1, Math.ceil(ms)));
		const either = signal ? AbortSignal.any([signal, bound]) : bound;
		const cut = (error: unknown): Result<never> & { uncertain?: boolean } => {
			if (signal?.aborted) return fail("aborted", `${method} ${path} was aborted`);
			if (bound.aborted) return { ...fail("timeout", `${method} ${path}: the phone harness did not answer within ${Math.round(ms / 100) / 10} s`), uncertain: true };
			return { ...fail("unreachable", `${method} ${path}: the phone harness could not be reached: ${this.#clean((error as Error)?.message ?? String(error))}`), uncertain: true };
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
		const failed = vendorFail("phone-harness",`${where}: ${said} (${response.status}${answer.code ? `, ${answer.code}` : ""})`);
		// A 5xx is no refusal: a gateway may answer it for a request the service went on to act on.
		return response.status >= 500 ? { ...failed, uncertain: true } : failed;
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

	/**
	 * Forgets a phone the service ended: its request is spent first, so a retry of it is refused exists (endedWords),
	 * never a second POST /sessions, and then its entry goes.
	 */
	async #forget(entry: PhoneLedgerEntry): Promise<void> {
		this.#requests.end(entry.name);
		await this.#ledger.remove(entry.id);
	}

	#deadlineOf(session: Session, fallback: number): string {
		return new Date(typeof session.expires_at === "number" && Number.isFinite(session.expires_at) ? session.expires_at * 1000 : fallback).toISOString();
	}

	// --- the provider ----------------------------------------------------------------------------------------------

	/**
	 * Makes a phone, once per request (provider.md, Idempotent create): context.requestId names it (computerNameFor) and
	 * gives the POST's Idempotency-Key. A request whose phone the ledger holds answers that phone once it is ready; one
	 * released is refused exists; a create of a request in flight here waits for the first (CreateRequests).
	 */
	create(spec: ComputerSpec, context: CreateContext): Promise<Result<CreatedComputer>> {
		const refusals = this.check(spec);
		return ledgerSafe(() =>
			this.#requests.create(spec, context, {
				refuse: fail,
				...(refusals.length > 0 ? { refused: refusals.map(({ field, message }) => `${field}: ${message}`).join("; ") } : {}),
				make: (name) => this.#create(spec, name, requestKeyOf(context.requestId), context.signal),
			}),
		);
	}

	/**
	 * The phone the ledger holds for a request, or undefined when it holds none: one whose create's answer was lost is
	 * asked for by its key first, and recorded when the service made it. One released, or ended, is refused exists; one
	 * of another spec is refused exists; one still starting is waited for, within readyMs.
	 */
	async #held(spec: ComputerSpec, name: string, requestKey: string, signal?: AbortSignal): Promise<Result<CreatedComputer> | undefined> {
		const entries = await this.#ledger.list();
		let entry = entries.find((one) => one.name === name && one.request === undefined);
		const pending = entries.find((one) => one.id === pendingId(requestKey));
		if (entry === undefined && pending !== undefined) {
			const recovered = await this.#api("GET", `/sessions/requests/${requestKey}`);
			if (!recovered.ok) return recovered.error.code === "not_found" ? undefined : recovered;
			const session = sessionOf(recovered.value.json, `GET /sessions/requests/${requestKey}`);
			if (!session.ok) return session;
			entry = { id: session.value.id, name, labels: { ...pending.labels }, image: pending.image, deadline: this.#deadlineOf(session.value, Date.parse(pending.deadline)) };
			await this.#ledger.put(entry);
			await this.#ledger.remove(pending.id);
		}
		if (entry === undefined) return undefined;
		if (entry.released !== undefined || this.#now() >= Date.parse(entry.deadline)) return fail("exists", endedWords(name));
		const differ = phoneDiffer(spec, entry.labels, entry.image, "read back");
		if (differ.length > 0) return fail("exists", otherSpecWords(name, "was made", differ));
		// The same wait a fresh create makes, within readyMs; a phone that ended, or reached its deadline as it started, is
		// spent. One not ready in time is left to the create that made it, which ends it.
		const ready = await this.#ready(entry.id, this.#now(), signal);
		if (!ready.ok) return ready.error.code === "gone" ? fail("exists", endedWords(name)) : ready;
		if (this.#now() >= Date.parse(this.#deadlineOf(ready.value, Date.parse(entry.deadline)))) return fail("exists", endedWords(name));
		return ok({ id: entry.id, name });
	}

	/**
	 * Waits until the phone id is ready, within readyMs counted from `from`, each read bounded by what readyMs has left so
	 * a stalled one cannot hold the wait past it: the ready session, or why not. gone: the service ended the phone, or it
	 * did not start; timeout: readyMs passed; aborted: the signal fired.
	 */
	async #ready(id: string, from: number, signal?: AbortSignal): Promise<Result<Session>> {
		for (;;) {
			if (signal?.aborted) return fail("aborted", `create was aborted while the phone ${id} started`);
			const left = this.#readyMs - (this.#now() - from);
			const bound = Math.max(1, Math.min(this.#requestMs, left));
			const read = await this.#session(id, signal, bound);
			if (!read.ok && read.error.code === "timeout") {
				// A read cut off by its own bound (requestMs) while readyMs has time left is one slow answer, not the deadline:
				// ask again. Only a read bounded by what readyMs had left, or the check below, ends the wait.
				if (bound < left && this.#now() - from < this.#readyMs) {
					await this.#sleep(this.#pollMs);
					continue;
				}
				return fail("timeout", `the phone ${id} was not ready within ${this.#readyMs / 1000} s: ${read.error.message}`);
			}
			if (!read.ok) return fail(read.error.code, `the phone ${id} did not start: ${read.error.message}`);
			if (read.value.state === "ready") return read;
			if (read.value.state !== "provisioning") return fail("gone", `the phone ${id} did not start: ${this.#clean(read.value.error ?? read.value.state)}`);
			if (this.#now() - from >= this.#readyMs) return fail("timeout", `the phone ${id} was not ready within ${this.#readyMs / 1000} s`);
			await this.#sleep(this.#pollMs);
		}
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

	release(ref: ComputerRef, how: ReleaseHow): Promise<Result<void>> {
		return ledgerSafe(() => this.#release(ref, how));
	}

	connect(ref: ComputerRef): Promise<Result<ComputerConnection>> {
		return ledgerSafe(() => this.#connect(ref));
	}

	/**
	 * The live view: the phone client's screen.watch on a connection of the watch's own (daemonWatch), PNG frames from
	 * screencap. Upright with no rotation of ours: screencap gives the display in its current orientation, and input tap
	 * and swipe take that same space, so each frame's width and height come from its own screencap, never from wm size.
	 */
	watch(ref: ComputerRef, handlers: ScreenWatchHandlers, options?: WatchOptions): Promise<Result<ScreenWatch>> {
		return daemonWatch(this, ref, handlers, options);
	}

	async #create(spec: ComputerSpec, name: string, requestKey: string, signal?: AbortSignal): Promise<Result<CreatedComputer>> {
		if (signal?.aborted) return fail("aborted", "create was aborted before the phone harness was asked");
		const from = this.#now();
		const body = { platform: "android", kind: "emulator", timeout_seconds: Math.ceil(runLifetimeMs(spec) / 1000) };
		// The key goes into the ledger before the POST: whatever answers are lost, list() can find the phone by it. It is
		// claimed, never put over another's: a create of the request in another provider on the same ledger (another
		// process) holds the request's spec there, and one of another spec is refused before it can POST the same key.
		const pending = pendingId(requestKey);
		for (;;) {
			const held = await this.#held(spec, name, requestKey, signal);
			if (held !== undefined) return held;
			if (await this.#ledger.claim({ id: pending, name, labels: { ...(spec.labels ?? {}) }, image: spec.image, deadline: new Date(from + runLifetimeMs(spec)).toISOString(), request: requestKey })) break;
			const other = await this.#ledger.get(pending);
			// Gone since: that create has ended, with a phone or none; look again.
			if (other === undefined) continue;
			const differ = phoneDiffer(spec, other.labels, other.image, "in flight");
			if (differ.length > 0) return fail("exists", otherSpecWords(name, "is being made", differ));
			// The same spec: its POST is under the same key, so the service answers both with one phone.
			break;
		}
		const posted = await this.#api("POST", "/sessions", { body, headers: { "Idempotency-Key": requestKey }, ...(signal ? { signal } : {}) });
		const cancelled = !posted.ok && posted.error.code === "aborted";
		let first = posted.ok ? sessionOf(posted.value.json, "POST /sessions") : undefined;
		// Only a refusal (a 4xx, or phones_busy) says nothing was made. No answer, a cancel, a 5xx, or a 2xx with no
		// session in it leaves the request uncertain: the service may have made the phone.
		const uncertain = posted.ok ? !first?.ok : posted.uncertain === true || cancelled;
		if (uncertain) {
			// Ask by its key, never POST again, before the key is forgotten. The ask is create's own, not under the
			// caller's signal, which may have fired; a phone it finds is recorded, and ended below if create was cancelled.
			const why = !posted.ok ? posted.error.message : `POST /sessions answered ${posted.value.status} with no session (${first?.ok === false ? first.error.message : "no words"})`;
			const kept = "the ledger keeps the request's key, so list() finds the phone if it was made";
			const recovered = await this.#api("GET", `/sessions/requests/${requestKey}`);
			if (!recovered.ok) return fail(cancelled ? "aborted" : "vendor",`${why}; and the service has no session for the request: ${recovered.error.message}; ${kept}`);
			first = sessionOf(recovered.value.json, `GET /sessions/requests/${requestKey}`);
			if (!first.ok) return fail(cancelled ? "aborted" : "vendor",`${why}; and its recovery answered no session: ${first.error.message}; ${kept}`);
		} else if (!posted.ok) {
			// The phone harness refused the request: nothing was made, and the key is forgotten.
			await this.#ledger.remove(pending);
			return posted;
		}
		if (first === undefined || !first.ok) return vendorFail("phone-harness","POST /sessions answered no session");
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
				return vendorFail("phone-harness",`${error instanceof Error ? error.message : String(error)}; ${after}`);
			}
		};
		const named = await record(async () => {
			await this.#ledger.put({ id, name, labels: { ...(spec.labels ?? {}) }, image: spec.image, deadline: this.#deadlineOf(first.value, from + runLifetimeMs(spec)) });
			await this.#ledger.remove(pending);
		});
		if (!named.ok) return named;
		const ended = async (code: ComputerErrorCode, words: string) => {
			// A phone create gave up on: its request is spent, as one released.
			this.#requests.end(name);
			const gone = await this.#end(id);
			return fail(code, `${words}; ${gone.ok ? "it was ended" : `it could not be ended (${gone.error.message})`}`);
		};
		if (cancelled) return ended("aborted", `create was aborted during POST /sessions, after the service made the phone ${id}`);
		const ready = await this.#ready(id, from, signal);
		if (!ready.ok) return ended(ready.error.code === "gone" ? "vendor" : ready.error.code, ready.error.message);
		const session = ready.value;
		const deadline = this.#deadlineOf(session, from + runLifetimeMs(spec));
		const kept = await record(() => this.#ledger.put({ id, name, labels: { ...(spec.labels ?? {}) }, image: spec.image, deadline }));
		if (!kept.ok) return kept;
		const took = this.#now() - from;
		if (this.#now() >= Date.parse(deadline)) {
			return ended("timeout", `the phone ${id}'s lifetime of ${runLifetimeMs(spec) / 1000} s ended before it was ready (it took ${Math.round(took / 100) / 10} s)`);
		}
		return ok({ id, name });
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
			if (session.error.code === "gone") await this.#forget(entry as PhoneLedgerEntry);
			return session;
		}
		if (session.value.state !== "ready" && session.value.state !== "provisioning") return fail("gone", `${id} is ${session.value.state}`);
		const deadline = new Date(this.#deadlineOf(session.value, Date.parse((entry as PhoneLedgerEntry).deadline)));
		return ok({ id, name: (entry as PhoneLedgerEntry).name, spec: { image: (entry as PhoneLedgerEntry).image, user: SHELL_USER, network: "open", deadline, kind: "android" } });
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
		if (!Array.isArray(got.value.json)) return vendorFail("phone-harness",`GET /sessions answered ${show(got.value.json).slice(0, 200)}, not a list`);
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
				if (entries.some((one) => one.id === made.id)) {
					// create has put the session's own entry and not yet removed its key: that entry is the phone, listed
					// in its turn (and kept as it is, released or not), and the key is only dropped.
					await this.#ledger.remove(listed.id);
					continue;
				}
				entry = { id: made.id, name: entry.name, labels: { ...entry.labels }, image: entry.image, deadline: this.#deadlineOf(made, Date.parse(entry.deadline)) };
				await this.#ledger.put(entry);
				await this.#ledger.remove(listed.id);
			}
			if (entry.released !== undefined) {
				// Released, and being ended: never listed. Forgotten once the listing leaves it out and its own GET is a 404,
				// or once its deadline has passed.
				if (this.#now() > Date.parse(entry.deadline)) await this.#forget(entry);
				else if (!live.has(entry.id)) {
					const read = await this.#session(entry.id, signal);
					if (!read.ok && read.error.code === "gone") await this.#forget(entry);
				}
				continue;
			}
			let session = live.get(entry.id);
			if (session === undefined) {
				// Not in the listing: its own GET says whether the service ended it (404), and only then is it forgotten.
				const read = await this.#session(entry.id, signal);
				if (!read.ok && read.error.code === "gone") {
					await this.#forget(entry);
					continue;
				}
				if (!read.ok) return read;
				session = read.value;
			}
			if (!carries(entry.labels, labels) || out.some((info) => info.ref.id === entry.id)) continue;
			out.push({
				ref: { id: entry.id, name: entry.name },
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

	async #release(ref: ComputerRef, how: ReleaseHow): Promise<Result<void>> {
		if (how === "stop") return fail("unsupported", "a cloud phone has no stop: release it with delete, which ends the session");
		if (how !== "delete") return fail("unsupported", `a cloud phone is kept for no agent (the phone harness declares no persistence), so release ${JSON.stringify(how)} is refused and the phone is left as it is: release it with delete`);
		const entry = await this.#ledger.get(ref.id);
		// A released phone's request is spent: the same request id again is refused, never made a second time.
		if (entry !== undefined) this.#requests.end(entry.name);
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
		return vendorFail("phone-harness",`adb connected to the phone, and the adb server still lists it as ${last}, not a device`);
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
			return vendorFail("phone-harness",`the phone harness gave ${ref.id} no adb link this provider can use (a host, a port and an unlock code)`);
		}
		// The endpoint and the code never reach an argv: the endpoint goes to the adb server over its socket, the unlock as
		// a shell service on a socket the server bound to the phone, and every spawned adb names the phone by its transport id.
		const endpoint = `${host}:${port}`;
		const server = (service: string) => this.#adb.server(service, { timeoutMs: ADB_TIMEOUT_MS });
		const onPhone = (service: string, id: string) => this.#adb.server(service, { timeoutMs: ADB_TIMEOUT_MS, transport: id });
		// The adb server keeps one transport per endpoint, and a second connect reuses it ("already connected"): every
		// connection to the phone holds it, and only the last to let go disconnects it (live run 4). The count and the
		// disconnect are one critical section:
		// - a disconnect still on its way is waited for first, so this connect never reuses a transport it is dropping;
		// - the hold is taken before host:connect, with no await in between, so a last release meanwhile sees this holder
		//   and keeps the transport.
		while (this.#leaving.has(endpoint)) await this.#leaving.get(endpoint);
		this.#holders.set(endpoint, (this.#holders.get(endpoint) ?? 0) + 1);
		let held = true;
		const release = async () => {
			if (!held) return;
			held = false;
			const left = (this.#holders.get(endpoint) ?? 1) - 1;
			if (left > 0) return void this.#holders.set(endpoint, left);
			this.#holders.delete(endpoint);
			// The phone's phoned goes with its last holder, in the same critical section: a connect after this starts its own.
			const daemon = this.#daemons.get(endpoint);
			this.#daemons.delete(endpoint);
			const leaving: Promise<unknown> = (async () => {
				const started = await daemon;
				if (started?.ok) await started.value.end();
			})()
				.then(() => server(`host:disconnect:${endpoint}`))
				.catch(() => undefined)
				.finally(() => {
					if (this.#leaving.get(endpoint) === leaving) this.#leaving.delete(endpoint);
				});
			this.#leaving.set(endpoint, leaving);
			await leaving;
		};
		const letGo = async <T>(failed: Result<T>): Promise<Result<T>> => {
			await release();
			return failed;
		};
		// A failed connect lets its hold go: it drops the transport only when no other connection holds it.
		const connected = await server(`host:connect:${endpoint}`);
		if (!connected.ok) return letGo(connected);
		const said = connected.value.trim();
		// adb's answer names the endpoint, so none of it is passed on: the error is the provider's own words.
		if (!said.includes("connected") || /cannot|failed|unable/i.test(said)) {
			return letGo(vendorFail("phone-harness",`adb could not reach the phone of ${ref.id}: the adb server could not connect to its adb endpoint`));
		}
		const transport = await this.#transportOf(endpoint);
		if (!transport.ok) return letGo(transport);
		const id = transport.value;
		const adb: AdbRun = (args, { timeoutMs = ADB_TIMEOUT_MS, signal } = {}) => this.#adb.run(["-t", id, ...args], { timeoutMs, ...(signal ? { signal } : {}) });
		// Ask first: the vendor's lock is per TCP connection, so a transport another connection unlocked answers at once,
		// and an `unlock` on it would reach the phone's own sh ("unlock: inaccessible or not found", live run 4).
		const asked = await onPhone("shell:echo ph-ok", id);
		if (!asked.ok) return letGo(asked);
		if (!asked.value.includes("ph-ok")) {
			if (!/^locked\b/.test(asked.value.trim())) return letGo(vendorFail("phone-harness",`the phone of ${ref.id} answered neither ph-ok nor locked`));
			// The vendor's unlock is the shell command `unlock <code>`, once per connection (docs, guides/connect-adb): the
			// shell service's own string, sent over the adb server's socket bound to the phone, so no argv holds the code.
			// Probe 1 (2026-11-08) showed it live: "unlocked", and getprop answered after it.
			const unlocked = await onPhone(`shell:unlock ${code}`, id);
			if (!unlocked.ok) return letGo(unlocked);
			// Another connect may have unlocked the transport meanwhile: the probe below is the judge, the answer only words.
			const probe = await adb(["shell", "echo ph-ok"]);
			if (!probe.ok) return letGo(probe);
			if (!probe.value.stdout.toString("utf8").includes("ph-ok")) {
				// The vendor's answer ("wrong code") may echo the code, more than once, or an endpoint: all are taken out.
				const words = redactWords(unlocked.value.trim().split("\n")[0].replaceAll(code, "[code]"));
				return letGo(vendorFail("phone-harness",/\bunlocked\b/.test(unlocked.value) ? `the phone of ${ref.id} stayed locked after its unlock code` : `the phone of ${ref.id} refused its unlock code: ${words}`));
			}
		}
		let started = this.#daemons.get(endpoint);
		if (started === undefined) {
			const starting: Promise<Result<Phoned>> = this.#startPhoned(id, adb, onPhone, () => {
				// phoned ended on its own (the phone killed it, or it failed): the next connect starts another.
				if (this.#daemons.get(endpoint) === starting) this.#daemons.delete(endpoint);
			});
			started = starting;
			this.#daemons.set(endpoint, starting);
		}
		const daemon = await started;
		if (!daemon.ok) {
			if (this.#daemons.get(endpoint) === started) this.#daemons.delete(endpoint);
			return letGo(daemon);
		}
		const { hello } = daemon.value;
		if (hello.version !== this.#daemonVersion) return letGo(fail("refused", `hello: the daemon reports version ${hello.version}, expected ${this.#daemonVersion}`));
		if (hello.protocol !== PROTOCOL_VERSION) return letGo(fail("refused", `hello: phoned speaks protocol ${hello.protocol}, and this provider ${PROTOCOL_VERSION}`));
		const client = new PhoneClient(daemon.value.client, release);
		return ok({ client, hello, close: () => client.closed() });
	}

	/** A file the provider puts on its phones, and its sha256, read once; not_found in the words missing gives. */
	#fileAt(path: string, missing: (why: string) => string): Promise<Result<PhoneFile>> {
		let read = this.#files.get(path);
		if (read === undefined) {
			read = readFile(path).then(
				(bytes) => ok({ path, sha256: createHash("sha256").update(bytes).digest("hex") }),
				(error: NodeJS.ErrnoException) => {
					this.#files.delete(path);
					return fail("not_found", missing(error.code ?? error.message));
				},
			);
			this.#files.set(path, read);
		}
		return read;
	}

	/**
	 * Puts file on the phone at remote, a name that holds its sha256, only when the phone lacks it there: pushed beside
	 * that name and then moved to it, so a file of that name is always whole. what names it in the errors.
	 */
	async #place(transport: string, adb: AdbRun, onPhone: OnPhone, file: PhoneFile, remote: string, what: string): Promise<Result<void>> {
		const have = await onPhone(`shell:sha256sum ${remote} 2>/dev/null`, transport);
		if (!have.ok) return have;
		if (have.value.startsWith(file.sha256)) return ok(undefined);
		const pushed = await adb(["push", file.path, `${remote}.part`], { timeoutMs: PUSH_TIMEOUT_MS });
		if (!pushed.ok) return pushed;
		if (pushed.value.exitCode !== 0) return vendorFail("phone-harness", `adb push of ${what} to the phone failed: ${redactWords(pushed.value.stderr.trim().split("\n")[0] || `exit code ${pushed.value.exitCode}`)}`);
		// Checked before it takes its name: a file under that name is always whole.
		const landed = await onPhone(`shell:sha256sum ${remote}.part`, transport);
		if (!landed.ok) return landed;
		if (!landed.value.startsWith(file.sha256)) return vendorFail("phone-harness", `${what} reached the phone changed: its sha256 there is not the file's (${redactWords(landed.value.trim().split("\n")[0] ?? "")})`);
		const moved = await onPhone(`shell:mv ${remote}.part ${remote} && echo moved`, transport);
		if (!moved.ok) return moved;
		if (moved.value.trim() !== "moved") return vendorFail("phone-harness", `${what} could not be put in place on the phone: ${redactWords(moved.value.trim().split("\n")[0] ?? "")}`);
		return ok(undefined);
	}

	/**
	 * The apks option's APKs, each put on the phone like phoned's jar and installed there with `pm install -r`, once per
	 * phone: a marker beside it on the phone (<apk>.installed) says that phone installed those bytes, so a later connect,
	 * which starts phoned afresh, installs nothing again.
	 */
	async #install(transport: string, adb: AdbRun, onPhone: OnPhone): Promise<Result<void>> {
		for (const path of this.#apks) {
			const what = `the APK ${basename(path)}`;
			const apk = await this.#fileAt(path, (why) => `${what}, which the provider's apks option names, is not at ${path} (${why})`);
			if (!apk.ok) return apk;
			const remote = `${PHONE_TMP}/apk-${apk.value.sha256.slice(0, 16)}.apk`;
			const done = await onPhone(`shell:test -e ${remote}.installed && echo installed`, transport);
			if (!done.ok) return done;
			if (done.value.trim() === "installed") continue;
			const placed = await this.#place(transport, adb, onPhone, apk.value, remote, what);
			if (!placed.ok) return placed;
			const installed = await onPhone(`shell:pm install -r ${remote} 2>&1`, transport);
			if (!installed.ok) return installed;
			// pm says Success on a line of its own, else Failure [INSTALL_FAILED_…: why].
			if (!/^Success$/m.test(installed.value)) {
				const said = installed.value.split("\n").find((line) => /Failure|Error|Exception/.test(line)) ?? installed.value.trim().split("\n")[0] ?? "";
				return vendorFail("phone-harness", `${what} did not install on the phone: ${redactWords(said.trim()) || "pm install answered nothing"}`);
			}
			const marked = await onPhone(`shell:touch ${remote}.installed && echo marked`, transport);
			if (!marked.ok) return marked;
			if (marked.value.trim() !== "marked") return vendorFail("phone-harness", `${what} installed, and its marker could not be written on the phone: ${redactWords(marked.value.trim().split("\n")[0] ?? "")}`);
		}
		return ok(undefined);
	}

	/**
	 * Starts phoned on the phone and says hello, after installing the apks option's APKs. The jar goes to the phone under
	 * its sha256 (#place). phoned runs as the shell user through app_process (scrcpy's way in), on adb's exec: service,
	 * whose socket carries its stdin and stdout raw; its stderr goes to a log beside the jar.
	 */
	async #startPhoned(transport: string, adb: AdbRun, onPhone: OnPhone, ended: () => void): Promise<Result<Phoned>> {
		const installed = await this.#install(transport, adb, onPhone);
		if (!installed.ok) return installed;
		const jar = await this.#fileAt(this.#phonedPath, (why) => `phoned, the phone's driver, is not at ${this.#phonedPath} (${why}): build it with npm run build:phoned, or give the provider's phoned option`);
		if (!jar.ok) return jar;
		const remote = `${PHONE_TMP}/phoned-${jar.value.sha256.slice(0, 16)}.jar`;
		const placed = await this.#place(transport, adb, onPhone, jar.value, remote, "phoned");
		if (!placed.ok) return placed;
		const stream = await this.#adb.open(`exec:CLASSPATH=${remote} app_process / ai.agentrun.phoned.android.Main 2>${remote.slice(0, -".jar".length)}.log`, { timeoutMs: ADB_TIMEOUT_MS, transport });
		if (!stream.ok) return stream;
		const socket = stream.value;
		socket.once("close", ended);
		const client = new DaemonClient({ readable: socket, writable: socket });
		socket.resume();
		const end = async () => {
			if (socket.destroyed) return;
			const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
			client.close();
			await closed;
		};
		const hello = await client.call("hello", { client: `@parcha/agentrun-computer ${VERSION}` }, { signal: this.#timeout(HELLO_TIMEOUT_MS) });
		if (!hello.ok) {
			await end();
			const log = `${remote.slice(0, -".jar".length)}.log`;
			return vendorFail("phone-harness",`phoned did not say hello on the phone (${hello.error.code}: ${redactWords(hello.error.message)}); its log on the phone is ${log}`);
		}
		return ok({ client, hello: hello.value, end });
	}
}

/** A file the provider puts on its phones: where it is here, and its sha256. */
interface PhoneFile {
	path: string;
	sha256: string;
}

/** A shell service on the phone by its transport id, as the adb server's socket runs it: its output, whole. */
type OnPhone = (service: string, id: string) => Promise<Result<string>>;

/** phoned on one phone: its connection, its hello, and how to end it (closing its stdin, which ends it). */
interface Phoned {
	client: DaemonClient;
	hello: HelloResult;
	end(): Promise<void>;
}

/**
 * One connection's client of the phone's shared phoned: calls go to phoned, and close lets this connection's hold of
 * the phone go. A call still running when its connection closes is cancelled (phoned gets $/cancelRequest); a later
 * one fails with gone.
 */
class PhoneClient implements ComputerClient {
	readonly #closing = new AbortController();
	#gone: Promise<unknown> = Promise.resolve();

	constructor(
		readonly daemon: DaemonClient,
		/** Lets this connection's hold of the phone go: the last one ends phoned and drops the adb transport. */
		readonly release: () => Promise<unknown>,
	) {}

	call<M extends DaemonMethod>(method: M, params: DaemonMethods[M]["params"], options: { signal?: AbortSignal } = {}): Promise<Result<DaemonMethods[M]["result"]>> {
		if (this.#closing.signal.aborted) return Promise.resolve(fail("gone", "the connection to the phone is closed"));
		const signal = options.signal ? AbortSignal.any([options.signal, this.#closing.signal]) : this.#closing.signal;
		return this.daemon.call(method, params, { signal });
	}

	close(): void {
		if (this.#closing.signal.aborted) return;
		this.#closing.abort();
		this.#gone = this.release().catch(() => undefined);
	}

	/** Closes, and waits until the phone's hold is let go (phoned ended and the transport dropped, when it was the last). */
	async closed(): Promise<void> {
		this.close();
		await this.#gone;
	}
}

/** Whether labels carries every one of wanted. */
const carries = (labels: Record<string, string>, wanted: Record<string, string>) => Object.entries(wanted ?? {}).every(([key, value]) => labels[key] === value);

function sessionOf(json: unknown, where: string): Result<Session> {
	const s = json as Session | undefined;
	if (typeof s !== "object" || s === null || typeof s.id !== "string" || typeof s.state !== "string") return vendorFail("phone-harness",`${where} answered ${show(json).slice(0, 200)}, not a session`);
	return ok(s);
}
