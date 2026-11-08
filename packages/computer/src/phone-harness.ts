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
import { crc32, deflateSync } from "node:zlib";
import { checkActions } from "./actions.js";
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

/** The phone harness's API. */
export const PHONE_HARNESS_URL = "https://api.phone-harness.com";
/** What a cloud Android offers through this provider, as its capabilities and hello declare them. */
export const PHONE_GROUPS: readonly Group[] = ["screen", "input.touch", "input.keys", "apps", "apps.ui_tree"];
/** A phone mounts no folder. */
export const MOUNT: readonly MountKind[] = [];
/** The longest lifetime by default: a rented phone bills by the minute. */
export const DEFAULT_MAX_LIFETIME_MS = 30 * 60_000;
/** How long create waits for a phone to be ready by default: the service's own CLI waits 240 s. */
export const DEFAULT_READY_MS = 240_000;
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
}

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

/** What one adb call gave: its exit code and output. */
export interface AdbResult {
	exitCode: number;
	stdout: Buffer;
	stderr: string;
}

/**
 * Runs adb with args. A result in words when adb could not run at all (missing, timed out); otherwise its exit code
 * and output, whatever they are. The words never hold the args: an unlock code is one of them.
 */
export type AdbRunner = (args: string[], options: { timeoutMs: number; signal?: AbortSignal }) => Promise<Result<AdbResult>>;

/** The adb CLI (Android platform-tools) at path, by execFile, never a shell. */
export function adbCli(path = "adb"): AdbRunner {
	return (args, { timeoutMs, signal }) =>
		new Promise((resolve) => {
			execFile(path, args, { encoding: "buffer", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024, ...(signal ? { signal } : {}) }, (error, stdout, stderr) => {
				const code = (error as NodeJS.ErrnoException | null)?.code;
				if (code === "ENOENT") {
					return resolve(fail("not_found", `the phone provider needs adb (Android platform-tools) on this machine: ${path} is not there; install platform-tools or give the provider's adb option`));
				}
				if (error && (error as { killed?: boolean }).killed) return resolve(fail("timeout", `adb did not finish within ${timeoutMs / 1000} s, so it was killed`));
				if (error && signal?.aborted) return resolve(fail("aborted", "adb was aborted"));
				if (error && typeof (error as { code?: unknown }).code !== "number") return resolve(fail("phone", `adb could not run: ${error.message.split("\n")[0]}`));
				resolve(ok({ exitCode: typeof code === "number" ? code : error ? 1 : 0, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr).toString("utf8") }));
			});
		});
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
	/** The adb runner, or the adb CLI's path; default adbCli("adb"). */
	adb?: AdbRunner | string;
	/** Where the provider's phones and their labels are kept; default memoryLedger(). */
	ledger?: PhoneLedger;
	/** The longest lifetime; default 30 min. */
	maxLifetimeMs?: number;
	/** How long create waits for a phone to be ready; default 240 s. */
	readyMs?: number;
	/** How often create asks whether the phone is ready; default 2 s. */
	pollMs?: number;
	/** The clock: ms since the epoch, and a wait. Tests give a fake that moves at once. */
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
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
}

export class PhoneHarnessProvider implements ComputerProvider {
	readonly id = "phone-harness";
	readonly version = VERSION;
	readonly #apiKey: string;
	readonly #baseUrl: string;
	readonly #fetch: typeof globalThis.fetch;
	readonly #adb: AdbRunner;
	readonly #ledger: PhoneLedger;
	readonly #maxLifetimeMs: number;
	readonly #readyMs: number;
	readonly #pollMs: number;
	readonly #now: () => number;
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #daemonVersion: string;

	constructor(options: PhoneProviderOptions) {
		const { apiKey, platform = "android" } = options ?? ({} as PhoneProviderOptions);
		if (typeof apiKey !== "string" || apiKey === "") throw new Error("the phone-harness provider needs options.apiKey: serve passes PHONE_HARNESS_API_KEY");
		if (platform === "ios") throw new Error('platform "ios" is not offered yet: the phone-harness provider rents a cloud Android; an iPhone is a later change');
		if (platform !== "android") throw new Error(`platform ${show(platform)} is not one of android, ios`);
		this.#apiKey = apiKey;
		this.#baseUrl = (options.baseUrl ?? PHONE_HARNESS_URL).replace(/\/+$/, "");
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#adb = typeof options.adb === "function" ? options.adb : adbCli(options.adb ?? "adb");
		this.#ledger = options.ledger ?? memoryLedger();
		this.#maxLifetimeMs = options.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS;
		if (!(Number.isSafeInteger(this.#maxLifetimeMs) && this.#maxLifetimeMs > 0)) throw new Error(`maxLifetimeMs ${show(options.maxLifetimeMs)} is not a whole number of milliseconds above 0`);
		this.#readyMs = options.readyMs ?? DEFAULT_READY_MS;
		this.#pollMs = options.pollMs ?? 2000;
		this.#now = options.now ?? (() => Date.now());
		this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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

	async #api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Result<{ status: number; json: unknown }> & { thrown?: boolean }> {
		let response: Response;
		try {
			response = await this.#fetch(`${this.#baseUrl}${path}`, {
				method,
				headers: { Authorization: `Bearer ${this.#apiKey}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				...(signal ? { signal } : {}),
			});
		} catch (error) {
			if (signal?.aborted) return fail("aborted", `${method} ${path} was aborted`);
			return { ...fail("phone", `${method} ${path}: the phone harness could not be reached: ${this.#clean((error as Error).message)}`), thrown: true };
		}
		const text = await response.text().catch(() => "");
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

	async #session(id: string, signal?: AbortSignal): Promise<Result<Session>> {
		const got = await this.#api("GET", `/sessions/${encodeURIComponent(id)}`, undefined, {}, signal);
		if (!got.ok) return got.error.code === "not_found" ? fail("gone", `${id} has ended`) : got;
		return sessionOf(got.value.json, `GET /sessions/${id}`);
	}

	async #end(id: string): Promise<Result<void>> {
		const ended = await this.#api("DELETE", `/sessions/${encodeURIComponent(id)}`);
		if (!ended.ok && ended.error.code !== "not_found") return ended;
		await this.#ledger.remove(id);
		return ok(undefined);
	}

	#deadlineOf(session: Session, fallback: number): string {
		return new Date(typeof session.expires_at === "number" && Number.isFinite(session.expires_at) ? session.expires_at * 1000 : fallback).toISOString();
	}

	// --- the provider ----------------------------------------------------------------------------------------------

	async create(spec: ComputerSpec, { signal }: { signal?: AbortSignal } = {}): Promise<Result<CreatedComputer>> {
		const refusals = this.check(spec);
		if (refusals.length > 0) return fail("refused", refusals.map(({ field, message }) => `${field}: ${message}`).join("; "));
		if (signal?.aborted) return fail("aborted", "create was aborted before the phone harness was asked");
		const from = this.#now();
		const requestKey = randomBytes(16).toString("hex");
		const body = { platform: "android", kind: "emulator", timeout_seconds: Math.ceil(spec.lifetimeMs / 1000) };
		let posted = await this.#api("POST", "/sessions", body, { "Idempotency-Key": requestKey }, signal);
		if (!posted.ok && posted.thrown) {
			// The request may have been admitted though its answer was lost: ask by its key, never POST again.
			const recovered = await this.#api("GET", `/sessions/requests/${requestKey}`);
			if (!recovered.ok) return fail("phone", `${posted.error.message}; and the service has no session for the request: ${recovered.error.message}`);
			posted = recovered;
		}
		if (!posted.ok) return posted;
		const first = sessionOf(posted.value.json, "POST /sessions");
		if (!first.ok) return first;
		const id = first.value.id;
		await this.#ledger.put({ id, labels: { ...(spec.labels ?? {}) }, image: spec.image, deadline: this.#deadlineOf(first.value, from + spec.lifetimeMs) });
		const ended = async (code: ComputerErrorCode, words: string) => {
			const gone = await this.#end(id);
			return fail(code, `${words}; ${gone.ok ? "it was ended" : `it could not be ended (${gone.error.message})`}`);
		};
		let session = first.value;
		for (;;) {
			if (signal?.aborted) return ended("aborted", `create was aborted while the phone ${id} started`);
			const read = await this.#session(id, signal);
			if (!read.ok) return ended(read.error.code === "gone" ? "phone" : read.error.code, `the phone ${id} did not start: ${read.error.message}`);
			session = read.value;
			if (session.state === "ready") break;
			if (session.state !== "provisioning") return ended("phone", `the phone ${id} did not start: ${this.#clean(session.error ?? session.state)}`);
			if (this.#now() - from >= this.#readyMs) return ended("timeout", `the phone ${id} was not ready within ${this.#readyMs / 1000} s`);
			await this.#sleep(this.#pollMs);
		}
		const deadline = this.#deadlineOf(session, from + spec.lifetimeMs);
		await this.#ledger.put({ id, labels: { ...(spec.labels ?? {}) }, image: spec.image, deadline });
		const took = this.#now() - from;
		if (this.#now() >= Date.parse(deadline)) {
			return ended("timeout", `the phone ${id}'s lifetime of ${spec.lifetimeMs / 1000} s ended before it was ready (it took ${Math.round(took / 100) / 10} s)`);
		}
		return ok({ id, name: id });
	}

	async attach(ref: { id: string } | { labels: Record<string, string> }, { signal }: CallContext = {}): Promise<Result<AttachedComputer>> {
		let entry: PhoneLedgerEntry | undefined;
		if ("id" in ref) {
			entry = await this.#ledger.get(ref.id);
			if (entry === undefined) return fail("not_found", `${ref.id} is not a phone this provider made`);
		} else {
			const found = (await this.#ledger.list()).filter((one) => carries(one.labels, ref.labels));
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

	async list(labels: Record<string, string>, { signal }: CallContext = {}): Promise<Result<ComputerInfo[]>> {
		const got = await this.#api("GET", "/sessions", undefined, {}, signal);
		if (!got.ok) return got;
		if (!Array.isArray(got.value.json)) return fail("phone", `GET /sessions answered ${show(got.value.json).slice(0, 200)}, not a list`);
		const live = new Map<string, Session>();
		for (const one of got.value.json) {
			const session = sessionOf(one, "GET /sessions");
			if (session.ok) live.set(session.value.id, session.value);
		}
		const out: ComputerInfo[] = [];
		for (const entry of await this.#ledger.list()) {
			const session = live.get(entry.id);
			if (session === undefined) {
				// The service ended it: the ledger forgets it.
				await this.#ledger.remove(entry.id);
				continue;
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

	async network(ref: ComputerRef, policy?: NetworkSpec): Promise<Result<NetworkPolicy>> {
		if ((await this.#ledger.get(ref.id)) === undefined) return fail("not_found", `${ref.id} is not a phone this provider made`);
		if (policy === undefined || policy === "open") return ok("open");
		return fail("refused", `network ${show(policy)}: a cloud phone's network is open, and it cannot be closed or narrowed`);
	}

	async release(ref: ComputerRef, how: "stop" | "delete"): Promise<Result<void>> {
		if (how === "stop") return fail("unsupported", "a cloud phone has no stop: release it with delete, which ends the session");
		return this.#end(ref.id);
	}

	async connect(ref: ComputerRef): Promise<Result<ComputerConnection>> {
		if ((await this.#ledger.get(ref.id)) === undefined) return fail("not_found", `${ref.id} is not a phone this provider made`);
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
		if (typeof host !== "string" || !/^[A-Za-z0-9.:-]+$/.test(host) || !Number.isSafeInteger(port) || typeof code !== "string" || !/^[A-Za-z0-9]+$/.test(code)) {
			return fail("phone", `the phone harness gave ${ref.id} no adb link this provider can use (a host, a port and an unlock code)`);
		}
		const serial = `${host}:${port}`;
		const adb = (args: string[], timeoutMs = ADB_TIMEOUT_MS) => this.#adb(args, { timeoutMs });
		const connected = await adb(["connect", serial]);
		if (!connected.ok) return connected;
		const said = connected.value.stdout.toString("utf8").trim();
		if (!said.includes("connected") || /cannot|failed|unable/i.test(said)) return fail("phone", `adb could not reach the phone at ${serial}: ${said.split("\n")[0] || connected.value.stderr.trim()}`);
		const unlocked = await adb(["-s", serial, "shell", `unlock ${code}`]);
		if (!unlocked.ok) return unlocked;
		const probe = await adb(["-s", serial, "shell", "echo ph-ok"]);
		if (!probe.ok) return probe;
		if (!probe.value.stdout.toString("utf8").includes("ph-ok")) return fail("phone", `the phone at ${serial} stayed locked after its unlock code`);
		const client = new AdbClient(serial, adb, this.#sleep);
		const opened = await client.open(this.#daemonVersion);
		if (!opened.ok) return opened;
		const hello = opened.value;
		if (hello.version !== this.version) {
			client.close();
			return fail("refused", `hello: the daemon reports version ${hello.version}, expected ${this.version}`);
		}
		return ok({ client, hello, close: async () => client.close() });
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
const refuse = (code: ComputerErrorCode, message: string): Call => fail(code, message);

/** The in-process client of one cloud Android: each protocol method is one or more adb commands. */
class AdbClient implements ComputerClient {
	#closed = false;
	#hello: HelloResult | undefined;
	#size: [number, number] = [0, 0];
	#scale = 1;
	#held: { id: string; bytes: Buffer } | undefined;

	constructor(
		readonly serial: string,
		readonly adb: (args: string[], timeoutMs?: number) => Promise<Result<AdbResult>>,
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
		if (!last) return fail("phone", `the phone at ${this.serial} did not say its screen's size: ${size.value.trim().slice(0, 100)}`);
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
		void this.adb(["disconnect", this.serial]).catch(() => undefined);
	}

	/** One shell command on the phone: its stdout, or the failure in words. */
	async #shell(command: string): Promise<Result<string>> {
		const ran = await this.adb(["-s", this.serial, "shell", command]);
		if (!ran.ok) return ran;
		if (ran.value.exitCode !== 0) {
			const why = (ran.value.stderr.trim() || ran.value.stdout.toString("utf8").trim()).split("\n")[0] || `exit code ${ran.value.exitCode}`;
			return fail("phone", `${command.split(" ").slice(0, 2).join(" ")} on the phone failed: ${why}`);
		}
		return ok(ran.value.stdout.toString("utf8"));
	}

	async #execOut(command: string): Promise<Result<Buffer>> {
		const ran = await this.adb(["-s", this.serial, "exec-out", command], 60_000);
		if (!ran.ok) return ran;
		if (ran.value.exitCode !== 0) return fail("phone", `${command.split(" ")[0]} on the phone failed: ${ran.value.stderr.trim().split("\n")[0] || `exit code ${ran.value.exitCode}`}`);
		return ok(ran.value.stdout);
	}

	async call<M extends DaemonMethod>(method: M, params: DaemonMethods[M]["params"], options: { signal?: AbortSignal } = {}): Promise<Result<DaemonMethods[M]["result"]>> {
		if (this.#closed) return fail("gone", "the connection to the phone is closed");
		if (options.signal?.aborted) return fail("aborted", `${method} was aborted`);
		return (await this.#answer(method as string, (params ?? {}) as Record<string, unknown>)) as Result<DaemonMethods[M]["result"]>;
	}

	async #answer(method: string, params: Record<string, unknown>): Promise<Call> {
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
				return this.#actions(params.actions);
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

	/** The shell commands of one action, or why the phone cannot do it. */
	#commands(action: InputAction): { commands: string[]; waitMs?: number } | { kind: DaemonErrorKind; message: string } {
		const point = ([x, y]: [number, number]) => `${Math.round(x)} ${Math.round(y)}`;
		switch (action.type) {
			case "tap":
				return { commands: Array.from({ length: action.count ?? 1 }, () => `input tap ${point(action.at)}`) };
			case "long_press":
				return { commands: [`input swipe ${point(action.at)} ${point(action.at)} ${action.ms ?? 800}`] };
			case "swipe": {
				const path = action.path;
				if (path.length === 2) return { commands: [`input swipe ${point(path[0])} ${point(path[1])} ${action.ms ?? 300}`] };
				const last = path[path.length - 1];
				return { commands: [[`input motionevent DOWN ${point(path[0])}`, ...path.slice(1).map((p) => `input motionevent MOVE ${point(p)}`), `input motionevent UP ${point(last)}`].join(";")] };
			}
			case "button":
				return { commands: [`input keyevent KEYCODE_${BUTTON_KEYS[action.name]}`] };
			case "type": {
				if (/[^\x20-\x7e\n]/.test(action.text)) return { kind: "unsupported", message: "type: adb's input text takes printable ASCII and line breaks only" };
				const commands: string[] = [];
				for (const [i, line] of action.text.split("\n").entries()) {
					if (i > 0) commands.push("input keyevent KEYCODE_ENTER");
					if (line !== "") commands.push(`input text ${quote(line.replaceAll(" ", "%s"))}`);
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

	async #actions(actions: unknown): Promise<Call> {
		const refused = checkActions(actions, PHONE_GROUPS);
		if (refused !== undefined) return ok({ done: 0, failed: refused } satisfies InputActionsResult);
		const list = actions as InputAction[];
		const plans: Array<{ commands: string[]; waitMs?: number }> = [];
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
		for (const [index, plan] of plans.entries()) {
			if (plan.waitMs !== undefined) await this.sleep(plan.waitMs);
			for (const command of plan.commands) {
				const ran = await this.#shell(command);
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
		const started = await this.#shell(`am start -W -n ${component}`);
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
