// The Daytona provisioner, over Daytona's v0 REST API with fetch (no SDK), as pi-transport's Daytona box does. The daemon
// goes in through the toolbox's file upload and starts as a session command, dropped to a user with no capabilities;
// connect() carries stdio over a session command's input calls and its log stream. Every Daytona fact used here is cited
// in the README's Daytona section.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { childCommands, type DaemonExpected, daemonDrift } from "./child.js";
import { DaemonClient } from "./client.js";
import { COMPUTER_LABEL, DEADLINE_LABEL, helloDrift, WORK } from "./drift.js";
import { MAX_LINE_BYTES } from "./protocol.js";
import {
	type AttachedComputer,
	type CallContext,
	type ComputerCapabilities,
	type ComputerConnection,
	type ComputerInfo,
	type ComputerProvider,
	type ComputerRef,
	type ComputerSpec,
	checkLifetime,
	type NetworkPolicy,
	type NetworkSpec,
	type Refusal,
} from "./provider.js";
import { type ComputerError, type ComputerErrorCode, fail, ok, type Result } from "./result.js";
import { waitUntil } from "./wait.js";

/** The longest each kind of call may take, and the pauses between polls and retries. */
export interface DaytonaTimeouts {
	/** One control-plane or toolbox call. */
	requestMs: number;
	/** POST /sandbox. */
	createMs: number;
	/** From the create's answer to a started sandbox. */
	startMs: number;
	/** One DELETE. */
	deleteMs: number;
	/** From the delete's answer to a sandbox Daytona reads as gone (404) and no longer lists. */
	goneMs: number;
	/** From the stop's answer to a sandbox Daytona reads, and lists, as stopped (or gone, when a stop deletes). */
	stopMs: number;
	/** The daemon's upload. */
	uploadMs: number;
	/** The install script. */
	execMs: number;
	/** From a connect's start to the daemon's hello, and each read-back call after it. */
	helloMs: number;
	pollMs: number;
	/** The first pause before a retry; each next one doubles. */
	retryMs: number;
	/** How long create waits for the listing to show the new computer steadily, and for how long it must. */
	listedMs: number;
	listedStableMs: number;
}

/** The parts of a WebSocket the provider uses: Node's global WebSocket, or a fake in tests. */
export interface WebSocketLike {
	binaryType: string;
	addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown; code?: number; message?: string }) => void): void;
	close(code?: number): void;
}

export type WebSocketFactory = (url: string, init: { headers: Record<string, string>; protocols: string[] }) => WebSocketLike;

export interface DaytonaProviderOptions {
	/** The Daytona API key. The caller passes it; this provider never reads the environment and never puts it in a computer. */
	apiKey: string;
	/** Default https://app.daytona.io/api. */
	apiUrl?: string;
	/** The daemon binary on this machine, for the sandboxes' architecture (dist/computerd-linux-<arch>). */
	daemonPath: string;
	/** Go's name for the sandboxes' architecture, which hello must report. Default amd64. */
	arch?: string;
	/** The class the snapshots this provider is given make: container (default) or linux-vm. */
	sandboxClass?: "container" | "linux-vm";
	/** The Daytona target (region); default the organization's. */
	target?: string;
	/** Who the daemon runs as, uid:gid in numbers, never root. Default 1000:1000. */
	daemonUser?: string;
	/**
	 * Daytona's autoStopInterval: minutes without outside activity after which Daytona stops the sandbox, whatever runs in
	 * it; 0 (default) is never. A whole number, 0 or more.
	 */
	autoStopMinutes?: number;
	/**
	 * Daytona's autoDeleteInterval: minutes a sandbox may stay stopped before Daytona deletes it; 0 deletes it as soon as it
	 * stops, so a stopped computer is never kept. A whole number, 0 or more; unset, Daytona never deletes a stopped one
	 * (-1 is sent) and the TTL ends it.
	 */
	autoDeleteMinutes?: number;
	/** For tests: every request goes through it. Default the global fetch. */
	fetch?: typeof fetch;
	/** For tests: every log stream opens through it. Default Node's global WebSocket. */
	webSocket?: WebSocketFactory;
	timeouts?: Partial<DaytonaTimeouts>;
}

/** What Daytona reports of a sandbox, as far as this provider reads it (api.json Sandbox and SandboxListItem). */
interface Sandbox {
	id: string;
	name?: string;
	snapshot?: string;
	state?: string;
	desiredState?: string;
	errorReason?: string;
	labels?: Record<string, string>;
	public?: boolean;
	networkBlockAll?: boolean;
	networkAllowList?: unknown;
	domainAllowList?: unknown;
	outboundProxyUrl?: string;
	kvm?: boolean;
	cpu?: number;
	gpu?: number;
	memory?: number;
	disk?: number;
	autoStopInterval?: number;
	autoDeleteInterval?: number;
	autoDestroyAt?: string;
	volumes?: unknown[];
	linkedSandboxId?: string;
	sandboxClass?: string;
	toolboxProxyUrl?: string;
}

interface Answer {
	status: number;
	bytes: Uint8Array;
}

interface CallInit {
	json?: unknown;
	form?: FormData;
	timeoutMs?: number;
	/** Retry no answer, 429 and 5xx: only for a call that may run twice. */
	retry?: boolean;
	/** Any answer below 500 but 429 is a value, with its status, not a failure. */
	anyStatus?: boolean;
}

/**
 * The environment fromEnv reads, by name. Every name is COMPUTER_DAYTONA_*: a bare DAYTONA_API_KEY may hold another
 * organization's key on a host that runs other Daytona work, so it is never read, not even as a fallback.
 */
export const ENV = {
	/** Required: the Daytona API key. */
	key: "COMPUTER_DAYTONA_API_KEY",
	/** Default https://app.daytona.io/api. */
	url: "COMPUTER_DAYTONA_API_URL",
	/** Default this package's dist/computerd-linux-<arch>. */
	daemon: "COMPUTER_DAYTONA_DAEMON",
	/** amd64 (default) or arm64: the sandboxes' architecture. */
	arch: "COMPUTER_DAYTONA_ARCH",
	/** The Daytona target (region); default the organization's. */
	target: "COMPUTER_DAYTONA_TARGET",
	/** container (default) or linux-vm: the class the snapshot makes. */
	sandboxClass: "COMPUTER_DAYTONA_CLASS",
	/** uid:gid the daemon runs as; default 1000:1000. */
	user: "COMPUTER_DAYTONA_USER",
} as const;

/** What fromEnv takes besides the environment: any option but the key, which comes from COMPUTER_DAYTONA_API_KEY alone. */
export type DaytonaFromEnvOptions = Partial<Omit<DaytonaProviderOptions, "apiKey">>;

/**
 * The provider's options from COMPUTER_DAYTONA_* alone, options winning over the environment; throws in words when a
 * setting is missing or wrong. The key is read here, and only here.
 */
export function optionsFromEnv(env: Record<string, string | undefined> = process.env, options: DaytonaFromEnvOptions = {}): DaytonaProviderOptions {
	const apiKey = env[ENV.key];
	if (apiKey === undefined || apiKey === "") throw new Error(`set ${ENV.key} to a Daytona API key: the Daytona provider reads it there and nowhere else, never from DAYTONA_API_KEY`);
	const arch = options.arch ?? (env[ENV.arch] || "amd64");
	if (arch !== "amd64" && arch !== "arm64") throw new Error(`${ENV.arch} is amd64 or arm64, not ${arch}`);
	const sandboxClass = options.sandboxClass ?? (env[ENV.sandboxClass] || "container");
	if (sandboxClass !== "container" && sandboxClass !== "linux-vm") throw new Error(`${ENV.sandboxClass} is container or linux-vm, not ${sandboxClass}`);
	return {
		daemonPath: env[ENV.daemon] || fileURLToPath(new URL(`./computerd-linux-${arch}`, import.meta.url)),
		...(env[ENV.url] ? { apiUrl: env[ENV.url] } : {}),
		...(env[ENV.target] ? { target: env[ENV.target] } : {}),
		...(env[ENV.user] ? { daemonUser: env[ENV.user] } : {}),
		...options,
		apiKey,
		arch,
		sandboxClass,
	};
}

/** A DaytonaProvider from COMPUTER_DAYTONA_* alone (see optionsFromEnv). */
export function fromEnv(env: Record<string, string | undefined> = process.env, options: DaytonaFromEnvOptions = {}): DaytonaProvider {
	return new DaytonaProvider(optionsFromEnv(env, options));
}

/** The conformance CLI's module for Daytona: the run's idle stop and auto-delete, its snapshot, notes and drifted twin. */
export const conformance = () => import("./conformance/daytona.js");

const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const DEFAULT_API_URL = "https://app.daytona.io/api";
/** The image that asks for Daytona's default snapshot: the create sends no snapshot field. */
export const DAYTONA_DEFAULT_SNAPSHOT = "default";
/** The label, in the provider's own namespace beside the deadline's, that holds the image create was asked for: Daytona
 *  reports only the snapshot it resolved that image to, a name of its own for "default". */
const IMAGE_LABEL = `${COMPUTER_LABEL}.image`;
/** autoDeleteInterval when autoDeleteMinutes is unset: negative is disabled. */
const NO_AUTO_DELETE = -1;
const DEFAULTS: DaytonaTimeouts = {
	requestMs: 30_000,
	createMs: 120_000,
	startMs: 120_000,
	deleteMs: 120_000,
	goneMs: 120_000,
	stopMs: 120_000,
	uploadMs: 120_000,
	execMs: 60_000,
	helloMs: 30_000,
	pollMs: 1_000,
	retryMs: 500,
	listedMs: 15_000,
	listedStableMs: 1_000,
};
const RETRY_ATTEMPTS = 3;
const DELETE_ATTEMPTS = 4;
const LISTED_ROUNDS = 2;
const LISTED_POLL_MS = 150;
/** The longest pause between two reads while release waits: the pauses double from pollMs up to it. */
const RELEASE_POLL_MAX_MS = 5_000;
const MAX_PAGES = 1000;
const NAME = /^computer-[0-9a-f]{12}$/;
const USER = /^(\d+):(\d+)$/;
const MAX_ID = 4_294_967_294;
const MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
/** Daytona's TTL is whole minutes, and its clock is not ours: the vendor's end may come this long after the deadline. */
const LIFETIME_SLACK_MS = 60_000 + 120_000;
const MAX_DOMAINS = 100;
const MAX_CIDRS = 10;
const DOMAIN_PORTS = [80, 443];
const INIT_SESSION = "agentrun-computerd";
const STAGING = "/tmp/agentrun-computerd-";
const SPEC_FIELDS = new Set(["image", "lifetimeMs", "network", "labels"]);
const SIZE_FIELDS = new Set(["cpus", "memoryMb", "pids"]);
const NUL = "a NUL byte cannot be sent to Daytona";
const QUOTA = /quota|capacity|limit exceeded|too many/i;
const STARTING = new Set(["creating", "restoring", "starting", "pending_build", "building_snapshot", "pulling_snapshot", "resizing", "snapshotting", "forking", "resuming", "unknown"]);
const GONE = new Set(["destroyed", "destroying"]);
const STOPPED = new Set(["stopped", "archived", "paused"]);
/** On the way from started to stopped or paused: still running until Daytona reads it stopped. */
const LEAVING = new Set(["stopping", "pausing"]);
const OUT = Buffer.from([1, 1, 1]);
const ERR = Buffer.from([2, 2, 2]);
/** A line the client wrote, echoed back: a request or a notification is never a daemon's reply. */
const ECHO = /^\{"jsonrpc":"2\.0",("id":\d+,)?"method":/;

/**
 * The three commands the provider sends into a sandbox, exactly: install (through /process/execute), init and stdio
 * (each a session command), the child daemon's commands (childCommands). Exported so a test can run them where Daytona
 * would, in a root container.
 */
export function daytonaCommands({ staging = "", deadline = "", user = "1000:1000" }: { staging?: string; deadline?: string; user?: string } = {}) {
	return childCommands({ staging, deadline, user });
}

const isWhole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const decoder = new TextDecoder();
const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((done) => {
		const timer = setTimeout(finish, ms);
		function finish() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			done();
		}
		if (signal?.aborted) finish();
		else signal?.addEventListener("abort", finish, { once: true });
	});
const ours = (sb: Sandbox | undefined): sb is Sandbox => typeof sb?.id === "string" && sb.labels?.[COMPUTER_LABEL] === "1" && NAME.test(sb.name ?? "");
const show = (value: unknown) => (value === undefined ? "nothing" : JSON.stringify(value));
const policyWords = (policy: NetworkPolicy) => (typeof policy === "string" ? policy : "other" in policy ? policy.other : JSON.stringify(policy));
const IPV4_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
const DOMAIN = /^(\*\.)?([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function isCidr(entry: string): boolean {
	const match = IPV4_CIDR.exec(entry);
	return match !== null && match.slice(1, 5).every((part) => Number(part) <= 255 && String(Number(part)) === part) && Number(match[5]) <= 32;
}

/** A spec's allowlist split into Daytona's two lists, or why Daytona cannot hold it. */
function allowOf(entries: unknown): { cidrs: string[]; domains: string[] } | string {
	if (!Array.isArray(entries) || entries.length === 0) return 'an allowlist needs at least one domain or CIDR; for no network ask for "none"';
	const cidrs: string[] = [];
	const domains: string[] = [];
	for (const entry of entries) {
		if (typeof entry !== "string") return "an allowlist holds strings: domains or IPv4 CIDRs";
		if (entry.includes(":")) return `${JSON.stringify(entry)}: a Daytona CIDR list is IPv4 only, and a domain takes no scheme or port`;
		if (/^[\d.]+(\/\d+)?$/.test(entry)) {
			if (!isCidr(entry)) return `${JSON.stringify(entry)}: an IPv4 CIDR is A.B.C.D/N, N from 0 to 32`;
			cidrs.push(entry);
		} else if (entry.length <= 253 && DOMAIN.test(entry)) domains.push(entry);
		else return `${JSON.stringify(entry)} is neither a domain (example.com, *.example.com: no scheme, path or port) nor an IPv4 CIDR`;
	}
	if (cidrs.length > 0 && domains.length > 0) return "a Daytona allowlist is domains or IPv4 CIDRs, never both: Daytona keeps them apart";
	if (domains.length > MAX_DOMAINS) return `a Daytona domain allowlist holds at most ${MAX_DOMAINS} domains, not ${domains.length}`;
	if (cidrs.length > MAX_CIDRS) return `a Daytona CIDR allowlist holds at most ${MAX_CIDRS} CIDRs, not ${cidrs.length}`;
	return { cidrs, domains };
}

/** The entries of a comma-separated list Daytona keeps, trimmed; none when it is unset; undefined for a shape it never sends. */
function entriesOf(list: unknown): string[] | undefined {
	if (list === undefined || list === null) return [];
	if (typeof list !== "string") return undefined;
	return list
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
}

/**
 * A sandbox's network as Daytona keeps it: none is block-all with no list, open is neither, an allowlist is one list.
 * An outbound proxy, both lists, or a shape not read here is reported in words, never as a policy it might widen to.
 */
function networkOf(sb: Sandbox): NetworkPolicy {
	if (typeof sb.outboundProxyUrl === "string" && sb.outboundProxyUrl !== "") return { other: "an outbound proxy is set on it" };
	const cidrs = entriesOf(sb.networkAllowList);
	const domains = entriesOf(sb.domainAllowList);
	if (cidrs === undefined || domains === undefined) return { other: "an allow list in a shape this provider does not read" };
	if (sb.networkBlockAll === true) return cidrs.length + domains.length === 0 ? "none" : { other: "block-all with an allow list" };
	if (sb.networkBlockAll !== false) return { other: "Daytona did not report networkBlockAll" };
	if (cidrs.length > 0 && domains.length > 0) return { other: "both a CIDR and a domain allow list" };
	if (cidrs.length > 0) return { allow: cidrs };
	if (domains.length > 0) return { allow: domains };
	return "open";
}

function samePolicy(a: NetworkPolicy, b: NetworkSpec): boolean {
	if (typeof a === "string" || typeof b === "string") return a === b;
	if (!("allow" in a)) return false;
	const left = new Set(a.allow.map((entry) => entry.toLowerCase()));
	const right = new Set(b.allow.map((entry) => entry.toLowerCase()));
	return left.size === right.size && [...left].every((entry) => right.has(entry));
}

/** The network fields a create or a change sends for a policy; undefined for one check() refuses. */
function networkBody(policy: NetworkSpec): Record<string, unknown> | undefined {
	if (policy === "none") return { networkBlockAll: true };
	if (policy === "open") return { networkBlockAll: false };
	const lists = allowOf(policy.allow);
	if (typeof lists === "string") return undefined;
	return lists.cidrs.length > 0 ? { networkAllowList: lists.cidrs.join(","), domainAllowList: "" } : { domainAllowList: lists.domains.join(","), networkAllowList: "" };
}

function labelProblem(key: string, value: unknown): string | undefined {
	if (typeof value !== "string") return `the label ${key} must be a string`;
	if (key.includes("\0") || value.includes("\0")) return `the label ${JSON.stringify(key)}: ${NUL}`;
	if (key === "") return "a label name must be non-empty";
	if (key === COMPUTER_LABEL || key.startsWith(`${COMPUTER_LABEL}.`)) return `the label ${key} is in the provider's own namespace (${COMPUTER_LABEL})`;
	return undefined;
}

function filterProblem(labels: unknown): string | undefined {
	if (typeof labels !== "object" || labels === null || Array.isArray(labels)) return "labels must map names to strings";
	for (const [key, value] of Object.entries(labels)) {
		if (typeof value !== "string") return `the label ${key} must be a string`;
		if (key === "") return "a label name must be non-empty";
	}
	return undefined;
}

/** The ISO deadline a sandbox's label holds, or undefined when it is missing or not the ISO time create writes. */
function deadlineOf(sb: Sandbox): Date | undefined {
	const written = sb.labels?.[DEADLINE_LABEL];
	const at = written === undefined ? Number.NaN : Date.parse(written);
	return Number.isNaN(at) || new Date(at).toISOString() !== written ? undefined : new Date(at);
}

function stateOf(sb: Sandbox): "running" | "stopped" {
	const state = sb.state ?? "";
	return state === "started" || STARTING.has(state) || LEAVING.has(state) ? "running" : "stopped";
}

/** Whether a sandbox is going: Daytona is destroying it, or has been asked to. list() leaves such a one out. */
const going = (sb: Sandbox) => GONE.has(sb.state ?? "") || sb.desiredState === "destroyed";

/** A state as Daytona reported it, for words: the state, and the desired state when it differs. */
function stateWords(sb: Sandbox | undefined): string {
	if (sb === undefined) return "gone (404)";
	const state = sb.state ?? "in no state";
	return sb.desiredState !== undefined && sb.desiredState !== sb.state ? `${state} (desired ${sb.desiredState})` : state;
}

function codeOf(status: number, text: string): ComputerErrorCode {
	if ((status === 400 || status === 403 || status === 429 || status === 507) && QUOTA.test(text)) return "limit";
	if (status === 401 || status === 403) return "denied";
	if (status === 404 || status === 410) return "not_found";
	if (status === 408) return "timeout";
	if (status === 429) return "limit";
	if (status === 400 || status === 409 || status === 422) return "invalid";
	return "daytona";
}

/** Whether fetch failed on a redirect it was told not to follow. */
function redirected(cause: unknown): boolean {
	const inner = (cause as { cause?: unknown } | null)?.cause;
	return /redirect/i.test(`${(cause as Error | null)?.message ?? ""} ${(inner as Error | null)?.message ?? ""}`);
}

function parseJson(bytes: Uint8Array): unknown {
	const text = decoder.decode(bytes);
	if (text === "") return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** Daytona's REST API: the control plane, and the toolbox of one sandbox. */
class Rest {
	readonly #base: string;
	readonly #key: string;
	readonly #fetch: typeof fetch;
	readonly #timeouts: DaytonaTimeouts;

	constructor(base: string, key: string, fetcher: typeof fetch, timeouts: DaytonaTimeouts) {
		this.#base = base.replace(/\/+$/, "");
		this.#key = key;
		this.#fetch = fetcher;
		this.#timeouts = timeouts;
	}

	/** The headers of every call and log stream; split output keeps a session's stdout and stderr apart. */
	headers(): Record<string, string> {
		return { Authorization: `Bearer ${this.#key}`, "X-Daytona-Source": "agentrun-computer", "X-Daytona-Split-Output": "true" };
	}

	sandbox(idOrName = "", rest = ""): string {
		return `${this.#base}/sandbox${idOrName === "" ? "" : `/${encodeURIComponent(idOrName)}`}${rest}`;
	}

	/** One call, bounded by its timeout and the caller's signal. A failure names the method, path and status, never a header. */
	async call(method: string, url: string, init: CallInit, signal?: AbortSignal): Promise<Result<Answer>> {
		const what = `${method} ${new URL(url).pathname}`;
		const attempts = init.retry === true ? RETRY_ATTEMPTS : 1;
		const timeoutMs = init.timeoutMs ?? this.#timeouts.requestMs;
		for (let attempt = 1; ; attempt++) {
			if (signal?.aborted) return fail("aborted", `${what} was aborted`);
			const timeout = AbortSignal.timeout(timeoutMs);
			let failure: ComputerError;
			let retryable = true;
			try {
				// Never a redirect: a followed one keeps the key, and could carry a toolbox call to another sandbox.
				const headers = init.json === undefined ? this.headers() : { ...this.headers(), "Content-Type": "application/json" };
				const response = await this.#fetch(url, {
					method,
					headers,
					body: init.json === undefined ? init.form : JSON.stringify(init.json),
					redirect: "error",
					signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
				});
				const bytes = new Uint8Array(await response.arrayBuffer());
				if (response.ok || (init.anyStatus === true && response.status < 500 && response.status !== 429)) return ok({ status: response.status, bytes });
				const text = decoder.decode(bytes).replace(/\s+/g, " ").slice(0, 300);
				retryable = response.status === 429 || response.status >= 500;
				failure = { code: codeOf(response.status, text), message: `${what}: ${response.status} ${text}` };
			} catch (cause) {
				if (signal?.aborted) return fail("aborted", `${what} was aborted`);
				if (timeout.aborted) failure = { code: "timeout", message: `${what} did not answer within ${timeoutMs / 1000} s` };
				else if (redirected(cause)) return fail("daytona", `${what}: Daytona answered with a redirect, which is never followed: it would carry the key`);
				else failure = { code: "daytona", message: `${what}: ${(cause as Error).message}` };
			}
			if (!retryable || attempt >= attempts) return { ok: false, error: failure };
			await sleep(this.#timeouts.retryMs * 2 ** (attempt - 1), signal);
		}
	}

	async json(method: string, url: string, init: CallInit, signal?: AbortSignal): Promise<Result<unknown>> {
		const answer = await this.call(method, url, init, signal);
		return answer.ok ? ok(parseJson(answer.value.bytes)) : answer;
	}

	/** A sandbox by id or name; undefined when Daytona has none. */
	async get(idOrName: string, signal?: AbortSignal): Promise<Result<Sandbox | undefined>> {
		const found = await this.json("GET", this.sandbox(idOrName), { retry: true }, signal);
		if (!found.ok) return found.error.code === "not_found" ? ok(undefined) : found;
		const sb = found.value as Sandbox | null;
		return typeof sb?.id === "string" ? ok(sb) : fail("daytona", `GET /sandbox/${idOrName}: no sandbox in the answer`);
	}
}

interface SandboxExpected {
	deadline: string;
	sandboxClass: string;
	autoStopInterval: number;
	autoDeleteInterval: number;
}

/** Every way a sandbox, as Daytona reads it back, differs from what create asked for. Pure: no call. */
function sandboxDrift(spec: ComputerSpec, sb: Sandbox, expected: SandboxExpected): string[] {
	const found: string[] = [];
	const mismatch = (field: string, declared: unknown, actual: unknown) => found.push(`${field}: declared ${show(declared)}, read back ${show(actual)}`);
	// Daytona's default snapshot is whichever it names: a computer made from it is not held to a name.
	if (spec.image !== DAYTONA_DEFAULT_SNAPSHOT && sb.snapshot !== spec.image) mismatch("snapshot", spec.image, sb.snapshot);
	const network = networkOf(sb);
	if (!samePolicy(network, spec.network)) found.push(`network: declared ${policyWords(spec.network)}, read back ${policyWords(network)}`);
	const labels = sb.labels ?? {};
	if (labels[COMPUTER_LABEL] !== "1") mismatch(`label ${COMPUTER_LABEL}`, "1", labels[COMPUTER_LABEL]);
	if (labels[DEADLINE_LABEL] !== expected.deadline) mismatch(`label ${DEADLINE_LABEL}`, expected.deadline, labels[DEADLINE_LABEL]);
	if (labels[IMAGE_LABEL] !== spec.image) mismatch(`label ${IMAGE_LABEL}`, spec.image, labels[IMAGE_LABEL]);
	for (const [key, value] of Object.entries(spec.labels ?? {})) if (labels[key] !== value) mismatch(`label ${key}`, value, labels[key]);
	if (sb.autoStopInterval !== expected.autoStopInterval) mismatch("autoStopInterval", expected.autoStopInterval, sb.autoStopInterval);
	if (sb.autoDeleteInterval !== expected.autoDeleteInterval) mismatch("autoDeleteInterval", expected.autoDeleteInterval, sb.autoDeleteInterval);
	const ends = typeof sb.autoDestroyAt === "string" ? Date.parse(sb.autoDestroyAt) : Number.NaN;
	if (Number.isNaN(ends)) found.push(`autoDestroyAt: declared a TTL ending by ${expected.deadline}, read back ${show(sb.autoDestroyAt)}: Daytona would not end the computer`);
	else if (ends > Date.parse(expected.deadline) + LIFETIME_SLACK_MS) found.push(`autoDestroyAt: ${sb.autoDestroyAt} is past the deadline ${expected.deadline} by more than the TTL's minute and ${(LIFETIME_SLACK_MS - 60_000) / 60_000} minutes of clock skew`);
	if (sb.sandboxClass !== expected.sandboxClass) mismatch("sandboxClass", expected.sandboxClass, sb.sandboxClass);
	if (sb.public !== false) mismatch("public", false, sb.public);
	if (sb.kvm === true) mismatch("kvm", false, sb.kvm);
	if (sb.gpu !== undefined && sb.gpu !== 0) mismatch("gpu", 0, sb.gpu);
	if (Array.isArray(sb.volumes) ? sb.volumes.length > 0 : sb.volumes !== undefined && sb.volumes !== null) mismatch("volumes", [], sb.volumes);
	if (typeof sb.linkedSandboxId === "string" && sb.linkedSandboxId !== "") mismatch("linkedSandboxId", "none", sb.linkedSandboxId);
	return found;
}

/**
 * The byte stream of one `computerd stdio` session command: writes go to its input, a whole line at a time and one
 * call after another; reads come from its log stream, where Daytona prefixes each stdout line with 01 01 01 and each
 * stderr line with 02 02 02. Stderr is kept for the error words; stdout carries the protocol lines alone.
 */
function sessionStream(socket: WebSocketLike, send: (data: string) => Promise<Result<void>>) {
	const readable = new PassThrough();
	let stderr = "";
	let rest: Buffer = Buffer.alloc(0);
	let queued = "";
	let sending = false;
	let opened: (result: Result<void>) => void = () => {};
	const open = new Promise<Result<void>>((done) => {
		opened = done;
	});
	const lines = (bytes: Buffer, last: boolean) => {
		rest = rest.length === 0 ? bytes : Buffer.concat([rest, bytes]);
		let at: number;
		while ((at = rest.indexOf(0x0a)) >= 0 || (last && rest.length > 0)) {
			const end = at >= 0 ? at + 1 : rest.length;
			const line = rest.subarray(0, end);
			rest = rest.subarray(end);
			if (line.subarray(0, 3).equals(ERR)) stderr = (stderr + line.subarray(3).toString("utf8")).slice(-4096);
			else {
				const out = line.subarray(0, 3).equals(OUT) ? line.subarray(3) : line;
				if (!ECHO.test(out.subarray(0, 64).toString("utf8"))) readable.write(out);
			}
		}
		if (rest.length > MAX_LINE_BYTES + 8) readable.destroy(new Error("the daemon sent a line over the 1 MiB limit"));
	};
	socket.binaryType = "arraybuffer";
	socket.addEventListener("open", () => opened(ok(undefined)));
	socket.addEventListener("message", ({ data }) => {
		if (readable.destroyed) return;
		if (data instanceof ArrayBuffer) lines(Buffer.from(data), false);
		else if (ArrayBuffer.isView(data)) lines(Buffer.from(data.buffer, data.byteOffset, data.byteLength), false);
		else if (typeof data === "string") lines(Buffer.from(data), false);
	});
	socket.addEventListener("error", (event) => {
		opened(fail("daytona", `the log stream failed: ${event.message ?? "no reason given"}`));
		if (!readable.destroyed) readable.destroy(new Error(`the log stream failed${event.message ? `: ${event.message}` : ""}`));
	});
	socket.addEventListener("close", ({ code }) => {
		opened(fail("daytona", `the log stream closed before it opened (code ${code ?? "none"})`));
		if (readable.destroyed) return;
		lines(Buffer.alloc(0), true);
		readable.end();
	});
	const flush = () => {
		const at = queued.lastIndexOf("\n");
		if (sending || at < 0 || readable.destroyed) return;
		const data = queued.slice(0, at + 1);
		queued = queued.slice(at + 1);
		sending = true;
		void send(data).then((sent) => {
			sending = false;
			if (!sent.ok) {
				if (!readable.destroyed) readable.destroy(new Error(`writing to the daemon failed: ${sent.error.message}`));
				return;
			}
			flush();
		});
	};
	const writable = new Writable({
		write(chunk: Buffer | string, _encoding, done) {
			queued += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			flush();
			done();
		},
	});
	return { readable, writable, open, stderr: () => stderr.trim() };
}

/**
 * Computers that are Daytona sandboxes. A spec's image is a Daytona snapshot (its id or name), which gives the class and
 * the size. See the README's Daytona section for every call, and its citation.
 */
export class DaytonaProvider implements ComputerProvider {
	readonly id = "daytona";
	readonly version = VERSION;
	readonly #rest: Rest;
	readonly #daemonPath: string;
	readonly #arch: string;
	readonly #class: "container" | "linux-vm";
	readonly #target: string | undefined;
	readonly #uid: string;
	readonly #gid: string;
	readonly #webSocket: WebSocketFactory;
	readonly #timeouts: DaytonaTimeouts;
	readonly #autoStop: number;
	readonly #autoDelete: number;

	constructor({
		apiKey,
		apiUrl = DEFAULT_API_URL,
		daemonPath,
		arch = "amd64",
		sandboxClass = "container",
		target,
		daemonUser = "1000:1000",
		autoStopMinutes = 0,
		autoDeleteMinutes,
		fetch: fetcher,
		webSocket,
		timeouts,
	}: DaytonaProviderOptions) {
		if (typeof apiKey !== "string" || apiKey === "") throw new Error("a Daytona API key is required");
		const base = new URL(apiUrl);
		if (base.protocol !== "https:") throw new Error(`the Daytona API URL must be https, so the key never crosses in the clear: ${base.protocol}`);
		if (sandboxClass !== "container" && sandboxClass !== "linux-vm") throw new Error(`sandboxClass is container or linux-vm, not ${String(sandboxClass)}`);
		const user = USER.exec(daemonUser);
		if (user === null || Number(user[1]) > MAX_ID || Number(user[2]) > MAX_ID) throw new Error(`the daemon user ${daemonUser} must be uid:gid in numbers, such as 1000:1000`);
		if (user[1] === "0" || user[2] === "0") throw new Error(`the daemon user ${daemonUser} is root or in root's group; a Daytona computer's daemon runs as neither`);
		const minutes = (name: string, value: unknown) => {
			if (!isWhole(value) || value < 0) throw new Error(`${name} is a whole number of minutes, 0 or more, not ${String(value)}`);
		};
		minutes("autoStopMinutes", autoStopMinutes);
		if (autoDeleteMinutes !== undefined) minutes("autoDeleteMinutes", autoDeleteMinutes);
		this.#autoStop = autoStopMinutes;
		this.#autoDelete = autoDeleteMinutes ?? NO_AUTO_DELETE;
		this.#timeouts = { ...DEFAULTS, ...timeouts };
		this.#rest = new Rest(apiUrl, apiKey, fetcher ?? fetch, this.#timeouts);
		this.#daemonPath = resolve(daemonPath);
		this.#arch = arch;
		this.#class = sandboxClass;
		this.#target = target;
		[this.#uid, this.#gid] = [String(Number(user[1])), String(Number(user[2]))];
		this.#webSocket = webSocket ?? ((url, init) => new WebSocket(url, init as never) as unknown as WebSocketLike);
	}

	/**
	 * daemon child: Daytona's toolbox daemon is the sandbox's first process, and init is a command it runs in a session
	 * (#prepare), so deleting that session ends init and leaves the sandbox. maxLifetimeMs is the 30 days check() has
	 * always given; Daytona's TTL is in whole minutes and documents no cap of its own.
	 */
	capabilities(): ComputerCapabilities {
		return {
			kind: "linux",
			lifetime: "vendor",
			network: ["none", "open", "allow"],
			allow: { domains: { max: MAX_DOMAINS, ports: DOMAIN_PORTS }, cidrs: { max: MAX_CIDRS, ports: "any" }, mixed: false },
			isolation: this.#class === "linux-vm" ? "vm" : "container",
			os: "linux",
			daemon: "child",
			groups: ["exec", "files", "processes"],
			maxLifetimeMs: MAX_LIFETIME_MS,
			release: ["stop", "delete"],
			// autoDeleteInterval 0: Daytona deletes a sandbox as soon as it stops, so a stop keeps no computer.
			stopDeletes: this.#autoDelete === 0,
		};
	}

	check(spec: ComputerSpec): Refusal[] {
		const refusals: Refusal[] = [];
		const refuse = (field: string, message: string) => refusals.push({ field, message });
		const given = (typeof spec === "object" && spec !== null ? spec : {}) as unknown as Record<string, unknown>;
		const { image, lifetimeMs, network, labels } = given;
		if (typeof image !== "string" || image.trim() === "") refuse("image", `an image is required: the id or name of a Daytona snapshot, or "${DAYTONA_DEFAULT_SNAPSHOT}" for Daytona's default snapshot`);
		else if (/[\0-\x1f]/.test(image)) refuse("image", "a snapshot name has no control characters");
		refusals.push(...checkLifetime(lifetimeMs, this.capabilities()));
		if (typeof network === "object" && network !== null && "allow" in network) {
			const lists = allowOf((network as { allow: unknown }).allow);
			if (typeof lists === "string") refuse("network", lists);
		} else if (network !== "none" && network !== "open") refuse("network", 'network is required: "none", "open" or { allow: [domains or IPv4 CIDRs] }');
		if (labels !== undefined) {
			const entries = typeof labels === "object" && labels !== null && !Array.isArray(labels) ? Object.entries(labels) : undefined;
			const bad = entries === undefined ? "labels must map names to strings" : entries.map(([key, value]) => labelProblem(key, value)).find(Boolean);
			if (bad) refuse("labels", bad);
		}
		for (const [field, value] of Object.entries(given)) {
			if (SPEC_FIELDS.has(field) || value === undefined) continue;
			if (SIZE_FIELDS.has(field)) refuse(field, `a Daytona computer has the size of its snapshot: name a snapshot of the size you need, not ${field}`);
			else if (field === "user") refuse(field, `a Daytona computer's daemon runs as the provider's daemon user (${this.#uid}:${this.#gid}), never as one a spec names`);
			else if (field === "workdir") refuse(field, `a Daytona computer works in ${WORK}, its home; a spec cannot name another`);
			else refuse(field, `a Daytona computer does not support ${field}`);
		}
		return refusals;
	}

	async create(spec: ComputerSpec, { signal }: { signal?: AbortSignal } = {}): Promise<Result<ComputerRef>> {
		const refusals = this.check(spec);
		if (refusals.length > 0) return fail("refused", refusals.map(({ field, message }) => `${field}: ${message}`).join("; "));
		let daemon: Buffer;
		try {
			daemon = readFileSync(this.#daemonPath);
		} catch {
			return fail("not_found", `no daemon binary at ${this.#daemonPath}: run npm run build:daemon -w @parcha/agentrun-computer`);
		}
		const sha256 = createHash("sha256").update(daemon).digest("hex");
		if (signal?.aborted) return fail("aborted", "create was aborted before Daytona was called");
		const name = `computer-${randomBytes(6).toString("hex")}`;
		const deadline = new Date(Date.now() + spec.lifetimeMs).toISOString();
		const body = {
			name,
			// "default" sends no snapshot, and Daytona makes the sandbox from its default snapshot.
			...(spec.image === DAYTONA_DEFAULT_SNAPSHOT ? {} : { snapshot: spec.image }),
			labels: { ...spec.labels, [COMPUTER_LABEL]: "1", [DEADLINE_LABEL]: deadline, [IMAGE_LABEL]: spec.image },
			env: {},
			public: false,
			...(this.#target === undefined ? {} : { target: this.#target }),
			ttlMinutes: Math.max(1, Math.ceil(spec.lifetimeMs / 60_000)),
			autoStopInterval: this.#autoStop,
			autoDeleteInterval: this.#autoDelete,
			...(networkBody(spec.network) ?? { networkBlockAll: true }),
		};
		const posted = await this.#rest.json("POST", this.#rest.sandbox(), { json: body, timeoutMs: this.#timeouts.createMs }, signal);
		const made = posted.ok ? (posted.value as Sandbox | null) : undefined;
		if (!posted.ok || typeof made?.id !== "string") {
			// A create Daytona refused with a 4xx made nothing. One that failed otherwise, or was aborted, may still have made
			// the sandbox: it goes by its name, which is this provider's.
			const refused = !posted.ok && ["invalid", "denied", "limit", "not_found"].includes(posted.error.code);
			const removed = refused ? ok(undefined) : await this.#delete(name);
			const left = removed.ok ? "" : `; a sandbox named ${name} may be left (${removed.error.message}), which Daytona ends by ${deadline}`;
			if (!posted.ok) return fail(posted.error.code, `${posted.error.code === "aborted" ? "create was aborted" : "Daytona did not create the sandbox"}: ${posted.error.message}${left}`);
			return fail("daytona", `POST /sandbox: no sandbox id in the answer${left}`);
		}
		const ref = { id: made.id, name };
		// From here the sandbox exists: every step takes the caller's signal, and a failure or an abort deletes it.
		const prepared = await this.#prepare(spec, ref, made, deadline, daemon, sha256, signal);
		if (signal?.aborted) return this.#abandon(ref, { code: "aborted", message: "create was aborted" }, signal);
		if (prepared.ok) return ok(ref);
		return this.#abandon(ref, prepared.error, signal);
	}

	async #abandon(ref: ComputerRef, error: ComputerError, signal?: AbortSignal): Promise<Result<never>> {
		// The delete itself is never signalled: it is sent even after an abort. The wait for the sandbox to go takes the
		// caller's signal, as Modal's terminate does, so an aborted create returns once the delete is sent.
		const deleted = await this.#delete(ref.id);
		const removed = deleted.ok ? await this.#settle(ref, "gone", "delete", signal) : deleted;
		const after = removed.ok
			? "was deleted"
			: deleted.ok && removed.error.code === "aborted"
				? "was sent a delete, and the wait for it to go was aborted; Daytona ends it at its TTL if the delete did not take"
				: `could not be deleted (${removed.error.message}); Daytona ends it at its TTL`;
		return fail(error.code, `the computer ${ref.name} ${after}: ${error.message}`);
	}

	/** Everything between the create's answer and a computer that passed the drift check. */
	async #prepare(spec: ComputerSpec, ref: ComputerRef, made: Sandbox, deadline: string, daemon: Buffer, sha256: string, signal?: AbortSignal): Promise<Result<void>> {
		const started = await this.#waitStarted(made, signal);
		if (!started.ok) return started;
		const sb = started.value;
		const vendor = sandboxDrift(spec, sb, this.#sandboxExpected(deadline));
		if (vendor.length > 0) return fail("refused", `it did not match its spec: ${vendor.join("; ")}`);
		const toolbox = await this.#toolbox(sb, signal);
		if (!toolbox.ok) return toolbox;
		const staging = `${STAGING}${randomBytes(8).toString("hex")}`;
		const form = new FormData();
		form.append("file", new Blob([new Uint8Array(daemon)]), "computerd");
		const uploaded = await this.#rest.call("POST", `${toolbox.value}/files/upload-v2?${new URLSearchParams({ path: staging })}`, { form, retry: true, timeoutMs: this.#timeouts.uploadMs }, signal);
		if (!uploaded.ok) return fail(uploaded.error.code, `the daemon's upload was refused: ${uploaded.error.message}`);
		const commands = daytonaCommands({ staging, deadline, user: `${this.#uid}:${this.#gid}` });
		const install = await this.#execute(toolbox.value, commands.install, signal);
		if (!install.ok) return install;
		if (install.value.exitCode !== 0) return fail("refused", `installing the daemon failed (exit ${install.value.exitCode}): ${install.value.result.trim().slice(0, 500)}`);
		const read = /^sha256 ([0-9a-f]{64})$/m.exec(install.value.result)?.[1];
		if (read !== sha256) return fail("refused", `it did not match its spec: daemon: uploaded sha256 ${sha256}, the installed binary reads back ${show(read)}`);
		const session = await this.#rest.call("POST", `${toolbox.value}/process/session`, { json: { sessionId: INIT_SESSION } }, signal);
		if (!session.ok) return fail(session.error.code, `starting the daemon: ${session.error.message}`);
		const init = await this.#rest.json(
			"POST",
			`${toolbox.value}/process/session/${INIT_SESSION}/exec`,
			{ json: { command: commands.init, runAsync: true, suppressInputEcho: true } },
			signal,
		);
		if (!init.ok) return fail(init.error.code, `starting the daemon: ${init.error.message}`);
		const initId = (init.value as { cmdId?: unknown } | null)?.cmdId;
		const opened = await this.#open(sb, toolbox.value, signal);
		if (!opened.ok) {
			if (opened.error.code === "aborted") return opened;
			const why = typeof initId === "string" ? await this.#initLog(toolbox.value, initId) : "";
			return fail(opened.error.code, `the daemon did not answer: ${opened.error.message}${why ? `; init wrote: ${why}` : ""}`);
		}
		const daemonFound = await daemonDrift(opened.value, this.#daemonExpected(), this.#timeouts.helloMs, signal);
		await opened.value.close();
		if (!daemonFound.ok) return daemonFound;
		if (daemonFound.value.length > 0) return fail("refused", `it did not match its spec: ${daemonFound.value.join("; ")}`);
		return this.#waitListed(ref.id, signal);
	}

	#sandboxExpected(deadline: string): SandboxExpected {
		return { deadline, sandboxClass: this.#class, autoStopInterval: this.#autoStop, autoDeleteInterval: this.#autoDelete };
	}

	#daemonExpected(): DaemonExpected {
		const { kind, groups } = this.capabilities();
		return { version: VERSION, uid: this.#uid, gid: this.#gid, arch: this.#arch, kind, groups };
	}

	async #waitStarted(made: Sandbox, signal?: AbortSignal): Promise<Result<Sandbox>> {
		const end = Date.now() + this.#timeouts.startMs;
		let current: Sandbox | undefined = made;
		for (let first = true; ; first = false) {
			// The create's answer may leave fields out, as a listing does: the drift check reads the sandbox's own read.
			if (!first && current?.state === "started") return ok(current);
			if (current === undefined || GONE.has(current.state ?? "") || current.state === "error" || current.state === "build_failed") {
				const reason = current?.errorReason ? `: ${current.errorReason}` : "";
				return fail("daytona", `the sandbox went to ${current?.state ?? "deleted"} while starting${reason}`);
			}
			if (!first && Date.now() >= end) return fail("timeout", `the sandbox did not start within ${this.#timeouts.startMs / 1000} s (state ${current.state})`);
			if (!first) await sleep(this.#timeouts.pollMs, signal);
			if (signal?.aborted) return fail("aborted", "create was aborted while the sandbox started");
			const next = await this.#rest.get(made.id, signal);
			if (!next.ok) return next;
			current = next.value;
		}
	}

	/**
	 * Daytona's label listing trails a create (pi-transport measured 0.7 to 1.6 s, with flaps), and list() must show a
	 * computer once create returns: create waits until the listing has shown it, without a miss, for listedStableMs.
	 */
	async #waitListed(id: string, signal?: AbortSignal): Promise<Result<void>> {
		const end = Date.now() + this.#timeouts.listedMs;
		let streak: number | undefined;
		for (let hits = 0; ; ) {
			const listed = await this.#listOwn(signal);
			if (!listed.ok) return listed;
			if (listed.value.some((sb) => sb.id === id)) {
				streak ??= Date.now();
				hits++;
				if (hits >= LISTED_ROUNDS && Date.now() - streak >= this.#timeouts.listedStableMs) return ok(undefined);
			} else {
				streak = undefined;
				hits = 0;
			}
			if (Date.now() >= end) return fail("timeout", `the computer was not listed steadily within ${this.#timeouts.listedMs / 1000} s of its creation`);
			await sleep(Math.min(LISTED_POLL_MS, this.#timeouts.pollMs), signal);
			if (signal?.aborted) return fail("aborted", "create was aborted while it waited for the listing");
		}
	}

	async #toolbox(sb: Sandbox, signal?: AbortSignal): Promise<Result<string>> {
		let proxy = sb.toolboxProxyUrl;
		if (typeof proxy !== "string" || proxy === "") {
			const found = await this.#rest.json("GET", this.#rest.sandbox(sb.id, "/toolbox-proxy-url"), { retry: true }, signal);
			if (!found.ok) return found;
			proxy = (found.value as { url?: unknown } | null)?.url as string | undefined;
		}
		let url: URL;
		try {
			url = new URL(proxy ?? "");
		} catch {
			return fail("daytona", `Daytona gave no toolbox URL for ${sb.id}`);
		}
		if (url.protocol !== "https:") return fail("daytona", `the toolbox URL Daytona gave is not https (${url.protocol}), so the key is not sent to it`);
		return ok(`${url.href.replace(/\/+$/, "")}/${encodeURIComponent(sb.id)}`);
	}

	async #execute(toolbox: string, command: string, signal?: AbortSignal): Promise<Result<{ exitCode: number; result: string }>> {
		const seconds = Math.ceil(this.#timeouts.execMs / 1000);
		const ran = await this.#rest.json("POST", `${toolbox}/process/execute`, { json: { command, timeout: seconds }, timeoutMs: this.#timeouts.execMs + 15_000 }, signal);
		if (!ran.ok) return ran;
		const value = ran.value as { exitCode?: unknown; result?: unknown } | null;
		return ok({ exitCode: typeof value?.exitCode === "number" ? value.exitCode : -1, result: typeof value?.result === "string" ? value.result : "" });
	}

	/** What init wrote to stderr, for the words of a daemon that did not start. Best effort: empty when it cannot be read. */
	async #initLog(toolbox: string, commandId: string): Promise<string> {
		const logs = await this.#rest.call("GET", `${toolbox}/process/session/${INIT_SESSION}/command/${encodeURIComponent(commandId)}/logs`, {});
		if (!logs.ok) return "";
		const bytes = Buffer.from(logs.value.bytes);
		const parsed = parseJson(bytes) as { stderr?: unknown } | null;
		if (typeof parsed?.stderr === "string") return parsed.stderr.trim().slice(-500);
		return bytes
			.toString("utf8")
			.split("\n")
			.filter((line) => line.startsWith("\x02\x02\x02"))
			.map((line) => line.slice(3))
			.join("\n")
			.trim()
			.slice(-500);
	}

	/** One connection to the daemon, after hello, unchecked: a session of its own running the bridge. */
	async #open(sb: Sandbox, toolbox: string, signal?: AbortSignal): Promise<Result<ComputerConnection>> {
		const sessionId = `agentrun-stdio-${randomBytes(8).toString("hex")}`;
		const session = `${toolbox}/process/session/${sessionId}`;
		const made = await this.#rest.call("POST", `${toolbox}/process/session`, { json: { sessionId } }, signal);
		if (!made.ok) return made;
		const removeSession = async () => {
			await this.#rest.call("DELETE", session, {});
		};
		const ran = await this.#rest.json(
			"POST",
			`${session}/exec`,
			{ json: { command: daytonaCommands({ user: `${this.#uid}:${this.#gid}` }).stdio, runAsync: true, suppressInputEcho: true } },
			signal,
		);
		const commandId = ran.ok ? (ran.value as { cmdId?: unknown } | null)?.cmdId : undefined;
		if (!ran.ok || typeof commandId !== "string") {
			await removeSession();
			return ran.ok ? fail("daytona", "POST exec: no command id in the answer") : ran;
		}
		const command = `${session}/command/${encodeURIComponent(commandId)}`;
		const logs = `${command.replace(/^https:/, "wss:")}/logs?follow=true`;
		let socket: WebSocketLike;
		try {
			socket = this.#webSocket(logs, { headers: this.#rest.headers(), protocols: [] });
		} catch (error) {
			await removeSession();
			return fail("daytona", `opening the log stream: ${(error as Error).message}`);
		}
		const stream = sessionStream(socket, async (data) => {
			const sent = await this.#rest.call("POST", `${command}/input`, { json: { data } });
			return sent.ok ? ok(undefined) : sent;
		});
		const client = new DaemonClient(stream);
		let closed: Promise<void> | undefined;
		const close = () =>
			(closed ??= (async () => {
				client.close();
				socket.close(1000);
				await removeSession();
			})());
		const bound = AbortSignal.timeout(this.#timeouts.helloMs);
		const either = signal ? AbortSignal.any([signal, bound]) : bound;
		const opened = await Promise.race([stream.open, new Promise<Result<void>>((done) => either.addEventListener("abort", () => done(fail("aborted", "")), { once: true }))]);
		const timedOut = () => fail("timeout", `the daemon in ${sb.name ?? sb.id} did not answer hello within ${this.#timeouts.helloMs / 1000} s`);
		if (!opened.ok) {
			await close();
			if (signal?.aborted) return fail("aborted", `connecting to ${sb.name ?? sb.id} was aborted`);
			return opened.error.code === "aborted" ? timedOut() : opened;
		}
		const hello = await client.call("hello", { client: `@parcha/agentrun-computer ${VERSION}` }, { signal: either });
		if (!hello.ok) {
			await close();
			if (signal?.aborted) return fail("aborted", `hello to the daemon in ${sb.name ?? sb.id} was aborted`);
			if (hello.error.code === "aborted") return timedOut();
			if (hello.error.code !== "gone") return hello;
			return fail("daytona", `cannot reach the daemon in ${sb.name ?? sb.id}: ${stream.stderr() || hello.error.message}`);
		}
		return ok({ client, hello: hello.value, close });
	}

	/** A sandbox this provider made, by its ref; not_found for one that is gone or another's. */
	async #own(ref: ComputerRef, signal?: AbortSignal): Promise<Result<Sandbox>> {
		const found = await this.#rest.get(ref.id, signal);
		if (!found.ok) return found;
		const sb = found.value;
		if (!ours(sb) || sb.name !== ref.name || going(sb)) return fail("not_found", `no Daytona computer is ${ref.name} (${ref.id})`);
		return ok(sb);
	}

	async connect(ref: ComputerRef): Promise<Result<ComputerConnection>> {
		if (!NAME.test(ref?.name ?? "") || typeof ref?.id !== "string" || ref.id === "") return fail("invalid", `${ref?.name} is not a Daytona computer's ref ({ id, name: computer-<12 hex digits> })`);
		const found = await this.#own(ref);
		if (!found.ok) return found;
		if (found.value.state !== "started") return fail("refused", `${ref.name} is ${found.value.state ?? "in no state Daytona reports"}, not started: its daemon does not run`);
		const toolbox = await this.#toolbox(found.value);
		if (!toolbox.ok) return toolbox;
		const opened = await this.#open(found.value, toolbox.value);
		if (!opened.ok) return opened;
		const { kind, groups } = this.capabilities();
		const drifted = helloDrift(opened.value.hello, { version: VERSION, kind, groups, arch: this.#arch });
		if (drifted.length === 0) return opened;
		await opened.value.close();
		return fail("refused", `the daemon in ${ref.name} does not match this provider: ${drifted.join("; ")}`);
	}

	async attach(ref: { id: string } | { labels: Record<string, string> }, { signal }: CallContext = {}): Promise<Result<AttachedComputer>> {
		const given = (typeof ref === "object" && ref !== null ? ref : {}) as { id?: unknown; labels?: unknown };
		if ((given.id === undefined) === (given.labels === undefined)) return fail("invalid", "attach takes { id } or { labels }, one of them");
		if (given.id !== undefined) {
			const id = given.id;
			if (typeof id !== "string" || id === "" || id.includes("/")) return fail("invalid", `${String(id)} is not a Daytona sandbox's id or a computer's name`);
			const found = await this.#rest.get(id, signal);
			if (!found.ok) return found;
			const sb = found.value;
			if (!ours(sb) || (sb.id !== id && sb.name !== id) || going(sb)) return fail("not_found", `no Daytona computer has the id ${id}`);
			return this.#attached(sb, signal);
		}
		const problem = filterProblem(given.labels);
		if (problem) return fail("invalid", problem);
		const labels = given.labels as Record<string, string>;
		if (Object.keys(labels).length === 0) return fail("invalid", "attach by labels needs at least one label");
		const listed = await this.list(labels, { signal });
		if (!listed.ok) return listed;
		const words = JSON.stringify(labels);
		if (listed.value.length === 0) return fail("not_found", `no Daytona computer has the labels ${words}`);
		if (listed.value.length > 1) return fail("invalid", `${listed.value.length} computers match the labels ${words}: ${listed.value.map((info) => info.ref.name).join(", ")}`);
		const match = (listed.value[0] as ComputerInfo).ref;
		const found = await this.#own(match, signal);
		if (!found.ok) return found.error.code === "not_found" ? fail("not_found", `no Daytona computer has the labels ${words}`) : found;
		return this.#attached(found.value, signal);
	}

	/**
	 * The drift check of a computer attach did not make: its spec read back from Daytona and held to what check()
	 * allows, the sandbox as at create, and, when it runs, its daemon. One that drifts is refused and left as it is.
	 */
	async #attached(sb: Sandbox, signal?: AbortSignal): Promise<Result<AttachedComputer>> {
		const ref = { id: sb.id, name: sb.name as string };
		const found: string[] = [];
		const deadline = deadlineOf(sb);
		if (deadline === undefined) found.push(`deadline: the label ${DEADLINE_LABEL} reads ${show(sb.labels?.[DEADLINE_LABEL])}, not the ISO time create writes`);
		else if (deadline.getTime() > Date.now() + MAX_LIFETIME_MS + 60_000) found.push(`deadline: ${deadline.toISOString()} is past the 30 days create allows`);
		const network = networkOf(sb);
		if (typeof network === "object" && "other" in network) found.push(`network: ${network.other}, which this provider never makes`);
		const labels = Object.fromEntries(Object.entries(sb.labels ?? {}).filter(([key]) => key !== COMPUTER_LABEL && !key.startsWith(`${COMPUTER_LABEL}.`)));
		// The image create was asked for, from its label; a computer made before the label was written reports its snapshot.
		const asked = sb.labels?.[IMAGE_LABEL];
		const spec = { image: asked ?? sb.snapshot, lifetimeMs: 1, network: typeof network === "object" && "other" in network ? "none" : network, labels } as ComputerSpec;
		found.push(...this.check(spec).map(({ field, message }) => `${field}: ${message}, read back from the computer`));
		const vendor = sandboxDrift(spec, sb, this.#sandboxExpected(sb.labels?.[DEADLINE_LABEL] ?? ""));
		found.push(
			...vendor.filter(
				(line) =>
					!line.startsWith("network:") &&
					!line.startsWith(`label ${DEADLINE_LABEL}`) &&
					!(asked === undefined && line.startsWith(`label ${IMAGE_LABEL}`)) &&
					!(deadline === undefined && line.startsWith("autoDestroyAt")),
			),
		);
		let user = `${this.#uid}:${this.#gid}`;
		let workdir: string | undefined;
		let kind: AttachedComputer["spec"]["kind"];
		if (sb.state === "started") {
			const toolbox = await this.#toolbox(sb, signal);
			if (!toolbox.ok) return toolbox;
			const opened = await this.#open(sb, toolbox.value, signal);
			if (!opened.ok) return opened;
			const daemonFound = await daemonDrift(opened.value, this.#daemonExpected(), this.#timeouts.helloMs, signal);
			await opened.value.close();
			if (!daemonFound.ok) return daemonFound;
			found.push(...daemonFound.value);
			workdir = WORK;
			kind = opened.value.hello.kind;
		}
		if (found.length > 0) return fail("refused", `the computer ${ref.name} does not match this provider, so attach refuses it and it is left as it is: ${found.join("; ")}`);
		return ok({
			...ref,
			spec: {
				image: spec.image,
				...(typeof sb.snapshot === "string" ? { snapshot: sb.snapshot } : {}),
				user,
				network: spec.network,
				...(isWhole(sb.cpu) ? { cpus: sb.cpu } : {}),
				...(isWhole(sb.memory) ? { memoryMb: sb.memory * 1024 } : {}),
				...(workdir === undefined ? {} : { workdir }),
				...(deadline === undefined ? {} : { deadline }),
				...(kind === undefined ? {} : { kind }),
			},
		});
	}

	/** Every sandbox with this provider's label, all pages: one label query, the way pi-transport asks. */
	async #listOwn(signal?: AbortSignal): Promise<Result<Sandbox[]>> {
		const found: Sandbox[] = [];
		const seen = new Set<string>();
		let cursor: string | undefined;
		for (let page = 0; page < MAX_PAGES; page++) {
			const query = new URLSearchParams({ labels: JSON.stringify({ [COMPUTER_LABEL]: "1" }), limit: "100" });
			if (cursor !== undefined) query.set("cursor", cursor);
			const answer = await this.#rest.json("GET", `${this.#rest.sandbox()}?${query}`, { retry: true }, signal);
			if (!answer.ok) return answer;
			const value = answer.value as { items?: unknown; nextCursor?: unknown } | Sandbox[] | null;
			const items = Array.isArray(value) ? value : Array.isArray(value?.items) ? (value.items as Sandbox[]) : undefined;
			if (items === undefined) return fail("daytona", "GET /sandbox: the listing is not a page of sandboxes");
			found.push(...items);
			const next = Array.isArray(value) ? undefined : value?.nextCursor;
			if (typeof next !== "string" || next === "") return ok(found);
			if (seen.has(next)) return fail("daytona", `GET /sandbox: the listing's cursor ${next} came back twice`);
			seen.add(next);
			cursor = next;
		}
		return fail("daytona", `GET /sandbox: the listing ran past ${MAX_PAGES} pages`);
	}

	/**
	 * For the sweep after a live run: every sandbox Daytona lists with agentrun.computer=1, whatever its name or state, as
	 * Daytona reports it. list() keeps only this provider's computers; this keeps everything the label query returns.
	 */
	async listLabelled({ signal }: CallContext = {}): Promise<Result<Array<{ id: string; name?: string; state?: string }>>> {
		const listed = await this.#listOwn(signal);
		if (!listed.ok) return listed;
		return ok(listed.value.filter((sb) => typeof sb?.id === "string").map((sb) => ({ id: sb.id, ...(typeof sb.name === "string" ? { name: sb.name } : {}), ...(typeof sb.state === "string" ? { state: sb.state } : {}) })));
	}

	/** For the sweep: GET /sandbox/{id} once, retried as every read is, and the status Daytona answered (404: none). */
	async probe(id: string, { signal }: CallContext = {}): Promise<Result<{ status: number; state?: string }>> {
		if (typeof id !== "string" || id === "" || id.includes("/")) return fail("invalid", `${String(id)} is not a Daytona sandbox's id`);
		const answer = await this.#rest.call("GET", this.#rest.sandbox(id), { retry: true, anyStatus: true }, signal);
		if (!answer.ok) return answer;
		const state = (parseJson(answer.value.bytes) as { state?: unknown } | null)?.state;
		return ok({ status: answer.value.status, ...(typeof state === "string" ? { state } : {}) });
	}

	async list(labels: Record<string, string>, { signal }: CallContext = {}): Promise<Result<ComputerInfo[]>> {
		const problem = filterProblem(labels);
		if (problem) return fail("invalid", problem);
		const listed = await this.#listOwn(signal);
		if (!listed.ok) return listed;
		const infos: ComputerInfo[] = [];
		for (const item of listed.value) {
			if (!ours(item) || going(item)) continue;
			if (!Object.entries(labels).every(([key, value]) => item.labels?.[key] === value)) continue;
			let sb: Sandbox = item;
			// A listing may leave the network out: the sandbox's own read says.
			if (item.networkBlockAll === undefined) {
				const read = await this.#rest.get(item.id, signal);
				if (!read.ok) return read;
				if (read.value === undefined) continue;
				sb = read.value;
			}
			infos.push({ ref: { id: sb.id, name: sb.name as string }, labels: { ...(sb.labels ?? {}) }, deadline: deadlineOf(sb), state: stateOf(sb), network: networkOf(sb) });
		}
		return ok(infos);
	}

	async network(ref: ComputerRef, policy?: NetworkSpec, { signal }: CallContext = {}): Promise<Result<NetworkPolicy>> {
		if (!NAME.test(ref?.name ?? "") || typeof ref?.id !== "string" || ref.id === "") return fail("invalid", `${ref?.name} is not a Daytona computer's ref ({ id, name: computer-<12 hex digits> })`);
		if (policy !== undefined) {
			const problem = this.check({ image: "-", lifetimeMs: 1, network: policy }).find((refusal) => refusal.field === "network");
			if (problem) return fail("invalid", problem.message);
		}
		const found = await this.#own(ref, signal);
		if (!found.ok) return found;
		const current = networkOf(found.value);
		if (policy === undefined || samePolicy(current, policy)) return ok(current);
		const changed = await this.#setNetwork(ref, policy, signal);
		// Read back whatever the change's answer: one that timed out may still have been applied. Never signalled, so an
		// aborted change is still checked.
		const after = await this.#own(ref);
		if (!after.ok) return changed.ok ? after : this.#refusedChange(policy, changed.error);
		const read = networkOf(after.value);
		if (samePolicy(read, policy)) return ok(read);
		if (!(typeof current === "object" && "other" in current) && samePolicy(read, current)) {
			return changed.ok ? fail("refused", `Daytona did not apply network ${policyWords(policy)}: ${ref.name} still reads back ${policyWords(read)}`) : this.#refusedChange(policy, changed.error);
		}
		// Never wider: a change Daytona applied otherwise is put back, or, failing that, the network is blocked.
		if (typeof current === "string" || "allow" in current) {
			const back = await this.#setNetwork(ref, current);
			const again = back.ok ? await this.#own(ref) : back;
			if (again.ok && samePolicy(networkOf(again.value), current)) {
				return fail("refused", `Daytona did not apply network ${policyWords(policy)} (it read back ${policyWords(read)}), so ${ref.name} is back on ${policyWords(current)}`);
			}
		}
		const blocked = await this.#setNetwork(ref, "none");
		return fail("refused", `Daytona did not apply network ${policyWords(policy)} (it read back ${policyWords(read)}), so ${ref.name}'s network ${blocked.ok ? "was blocked (none)" : `could not be blocked either: ${blocked.error.message}`}`);
	}

	#refusedChange(policy: NetworkSpec, error: ComputerError): Result<never> {
		if (error.code === "aborted" || error.code === "timeout") return fail(error.code, `the change to network ${policyWords(policy)} did not complete: ${error.message}`);
		const code = error.code === "invalid" || error.code === "denied" ? "refused" : error.code;
		return fail(code, `Daytona refused the change to network ${policyWords(policy)}: ${error.message}`);
	}

	async #setNetwork(ref: ComputerRef, policy: NetworkSpec, signal?: AbortSignal): Promise<Result<unknown>> {
		const body = networkBody(policy);
		if (body === undefined) return fail("invalid", `network ${policyWords(policy)} is not one Daytona can hold`);
		return this.#rest.json("POST", this.#rest.sandbox(ref.id, "/network-settings"), { json: body }, signal);
	}

	/**
	 * Daytona answers a delete or a stop before the sandbox is gone or stopped, and its listing trails both: release
	 * returns once Daytona reads the computer as release left it, or fails naming the last state it read.
	 */
	async release(ref: ComputerRef, how: "stop" | "delete", { signal }: CallContext = {}): Promise<Result<void>> {
		if (!NAME.test(ref?.name ?? "") || typeof ref?.id !== "string" || ref.id === "") return fail("invalid", `${ref?.name} is not a Daytona computer's ref ({ id, name: computer-<12 hex digits> })`);
		if (how !== "stop" && how !== "delete") return fail("invalid", `release is "stop" or "delete", not ${String(how)}`);
		const found = await this.#rest.get(ref.id, signal);
		if (!found.ok) return found;
		const sb = found.value;
		if (sb === undefined) return ok(undefined);
		// Already going (a second delete, or Daytona's own end): only the wait is left. Daytona renames a sandbox it
		// destroys, so the name is not held to the ref's here.
		if (going(sb)) return this.#settle(ref, "gone", how, signal);
		if (!ours(sb) || sb.name !== ref.name) return fail("not_found", `no Daytona computer is ${ref.name} (${ref.id}): the sandbox is not this provider's, so it is left as it is`);
		if (how === "stop") return this.#stop(ref, sb, signal);
		const deleted = await this.#delete(ref.id);
		return deleted.ok ? this.#settle(ref, "gone", how, signal) : deleted;
	}

	async #stop(ref: ComputerRef, sb: Sandbox, signal?: AbortSignal): Promise<Result<void>> {
		if (!STOPPED.has(sb.state ?? "")) {
			const stopped = await this.#rest.call("POST", this.#rest.sandbox(sb.id, "/stop"), {}, signal);
			if (!stopped.ok && stopped.error.code !== "invalid" && stopped.error.code !== "not_found") return stopped;
		}
		// With autoDeleteInterval 0, Daytona deletes a sandbox as it stops: such a stop is done once the computer is gone.
		return this.#settle(ref, this.#autoDelete === 0 ? "gone" : "stopped", "stop", signal);
	}

	/**
	 * Waits, through waitUntil, until Daytona reads the sandbox as wanted, twice running, by its own read and by the
	 * listing alike: "gone" is a 404 and no listed computer; "stopped" is stopped (or gone) and listed stopped (or not at
	 * all, when gone). Pauses double from pollMs to 5 s, bounded by goneMs or stopMs and the caller's signal. A stop not
	 * under way (neither stopping nor stopped) is asked for again. A failed read or listing, or a sandbox gone to error,
	 * ends the wait with that error.
	 */
	async #settle(ref: ComputerRef, want: "gone" | "stopped", how: "stop" | "delete", signal?: AbortSignal): Promise<Result<void>> {
		type Read = { failed: Result<never> } | { settled: true } | { last: string };
		let agreed = 0;
		let last = "unread";
		const read = async (readSignal: AbortSignal): Promise<Read> => {
			const got = await this.#rest.get(ref.id, readSignal);
			if (!got.ok) {
				if (got.error.code === "aborted") return { last };
				return { failed: fail(got.error.code, `release ${how} of ${ref.name}: reading it back failed (${got.error.message}); it last read ${last}`) };
			}
			const sb = got.value;
			last = stateWords(sb);
			if (sb !== undefined && (sb.state === "error" || sb.state === "build_failed") && sb.desiredState !== "destroyed") {
				return { failed: fail("daytona", `release ${how} of ${ref.name}: it went to ${sb.state}${sb.errorReason ? `: ${sb.errorReason}` : ""}`) };
			}
			const gone = sb === undefined || sb.state === "destroyed";
			const reached = gone ? "gone" : want === "stopped" && STOPPED.has(sb.state ?? "") ? "stopped" : undefined;
			if (reached === undefined) {
				agreed = 0;
				if (how === "stop" && sb !== undefined && !going(sb) && !LEAVING.has(sb.state ?? "")) {
					const again = await this.#rest.call("POST", this.#rest.sandbox(ref.id, "/stop"), {}, readSignal);
					if (!again.ok && again.error.code !== "invalid" && again.error.code !== "not_found" && again.error.code !== "aborted") return { failed: again };
				}
				return { last };
			}
			const listed = await this.#listOwn(readSignal);
			if (!listed.ok) {
				if (listed.error.code === "aborted") return { last };
				return { failed: fail(listed.error.code, `release ${how} of ${ref.name}: the listing failed (${listed.error.message}); it last read ${last}`) };
			}
			const item = listed.value.find((one) => one.id === ref.id);
			const shown = item === undefined || !ours(item) || going(item) ? undefined : stateOf(item);
			if (reached === "gone" ? shown === undefined : shown === "stopped") return ++agreed >= LISTED_ROUNDS ? { settled: true } : { last };
			agreed = 0;
			last = `${last}, listed ${shown ?? "not at all"}`;
			return { last };
		};
		const { pollMs, stopMs, goneMs } = this.#timeouts;
		const waited = await waitUntil(read, (state) => !("last" in state), {
			boundMs: how === "stop" ? stopMs : goneMs,
			signal,
			minMs: Math.min(pollMs, RELEASE_POLL_MAX_MS),
			maxMs: RELEASE_POLL_MAX_MS,
			what: `${ref.name} to be ${want} after its release ${how}`,
			describe: (state) => ("last" in state ? `Daytona read it ${state.last}` : "done"),
		});
		if (!waited.ok) return waited;
		return "failed" in waited.value ? waited.value.failed : ok(undefined);
	}

	/**
	 * Deletes a sandbox and makes sure it is going, as pi-transport does: a DELETE that fails counts as done only when the
	 * sandbox is gone or being destroyed; a forced stop comes before the last attempt. Never signalled: a delete that
	 * cleans up after an abort must outlive it.
	 */
	async #delete(idOrName: string): Promise<Result<void>> {
		let failure: ComputerError | undefined;
		for (let attempt = 1; attempt <= DELETE_ATTEMPTS; attempt++) {
			const removed = await this.#rest.call("DELETE", this.#rest.sandbox(idOrName), { retry: true, timeoutMs: this.#timeouts.deleteMs });
			if (removed.ok || removed.error.code === "not_found") return ok(undefined);
			failure = removed.error;
			const found = await this.#rest.get(idOrName);
			if (found.ok && (found.value === undefined || GONE.has(found.value.state ?? ""))) return ok(undefined);
			if (attempt === DELETE_ATTEMPTS - 1) await this.#rest.call("POST", this.#rest.sandbox(idOrName, "/stop?force=true"), { timeoutMs: this.#timeouts.deleteMs });
			if (attempt < DELETE_ATTEMPTS) await sleep(this.#timeouts.retryMs);
		}
		return { ok: false, error: failure ?? { code: "daytona", message: `could not delete ${idOrName}` } };
	}
}
