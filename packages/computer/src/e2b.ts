// The E2B provisioner: E2B Desktop sandboxes (kind desktop) or E2B's plain template (kind linux), every call through
// the host's own E2B JS SDK (the `e2b` package), of which this package names only the slice it uses (E2BSandboxClass)
// and imports nothing at load. E2B's envd is the sandbox's first process (under systemd), so computerd is a child: its
// upload goes through envd's file API and init starts as a background command, dropped to a user with no capabilities;
// connect() carries stdio over a background command's stdin and stdout. Every SDK fact used here is cited in the
// README's E2B section, from e2b@2.63.0 (dist/index.mjs) and e2b-dev/infra@ff3922213 (envd).
import { createHash, randomBytes, randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { childCommands, type DaemonExpected, daemonDrift } from "./child.js";
import { netDevInterfaces, OWN_NETWORK_ONLY, ownNetworkDrift, TOOL_USER } from "./isolation.js";
import { DaemonClient } from "./client.js";
import { DESKTOP_GROUPS, type DesktopOptions, desktopOf, startDisplay } from "./desktop.js";
import { COMPUTER_LABEL, DAEMON_IN_COMPUTER, DEADLINE_LABEL, helloDrift, type ProbeReport, probeNetworkDrift, probeNotes, probeReportOf, WORK } from "./drift.js";
import { releaseOlder } from "./janitor.js";
import { RUN_LABEL } from "./labels.js";
import { checkMount, type MountKind, type MountReadBack, readBackOf } from "./mount.js";
import {
	ARCHIL_HELPER,
	ARCHIL_MOUNT_LABEL,
	ARCHIL_TOOL_UID,
	type ArchilMount,
	type ArchilRoot,
	archilLabels,
	archilMount,
	archilRefusals,
	archilRelease,
	claimEpoch,
	mountDrift,
	type ProviderNote,
	type RecordedArchil,
	readArchilMount,
	recordedArchil as recordedArchilOf,
	recordedMount,
	syncingClient,
} from "./mount-archil.js";
import { listProcesses } from "./processes.js";
import type { HelloResult, ProcessExit } from "./protocol.js";
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
import { type ComputerError, type ComputerErrorCode, fail, ok, type Result } from "./result.js";
import { waitUntil } from "./wait.js";

/** What every SDK call is given: the key, the domain and the API URL explicitly, and debug false (index.mjs:1126-1152). */
export interface E2BConnectionOptions {
	apiKey: string;
	domain: string;
	apiUrl: string;
	debug: false;
	requestTimeoutMs?: number;
	signal?: AbortSignal;
}

/** Sandbox.create's options as the provider gives them (SandboxOpts, index.d.mts:10140-10245). */
export interface E2BCreateOptions extends E2BConnectionOptions {
	timeoutMs: number;
	metadata: Record<string, string>;
	envs: Record<string, string>;
	allowInternetAccess: boolean;
	network: { allowPublicTraffic: boolean };
	lifecycle: { onTimeout: "kill" };
}

/** What getInfo reports of a sandbox, as far as this provider reads it (index.mjs:5432-5465). */
export interface E2BSandboxInfo {
	sandboxId: string;
	templateId: string;
	name?: string;
	metadata: Record<string, string>;
	allowInternetAccess?: boolean;
	startedAt: Date;
	endAt: Date;
	state: string;
	network?: { allowOut?: string[]; denyOut?: string[]; allowPublicTraffic?: boolean; egressProxy?: unknown; rules?: unknown; dnsServers?: unknown };
	lifecycle?: { onTimeout?: string; autoResume?: boolean };
}

/** One sandbox in a page of Sandbox.list (index.mjs:5820-5838). */
export interface E2BListedSandbox {
	sandboxId: string;
	metadata: Record<string, string>;
	state: string;
	startedAt: Date;
	endAt: Date;
}

/** The result of a command that has ended (index.mjs:2751-2757); CommandExitError carries the same fields. */
export interface E2BCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** A background command (CommandHandle, index.mjs:2683-2810). */
export interface E2BCommandHandle {
	readonly pid: number;
	readonly stderr: string;
	wait(): Promise<E2BCommandResult>;
	kill(): Promise<boolean>;
	disconnect(): Promise<void>;
}

export interface E2BRunOptions {
	user: "root";
	timeoutMs: number;
	requestTimeoutMs: number;
	signal?: AbortSignal;
}

/** The part of a connected Sandbox called here: commands, files and getHost (index.mjs:5917-5989, 6194-6196). */
export interface E2BSandbox {
	readonly sandboxId: string;
	getHost(port: number): string;
	readonly files: { write(path: string, data: ArrayBuffer, options: { user: "root"; requestTimeoutMs: number; signal?: AbortSignal }): Promise<unknown> };
	readonly commands: {
		run(command: string, options: E2BRunOptions & { background?: false }): Promise<E2BCommandResult>;
		run(
			command: string,
			options: E2BRunOptions & { background: true; stdin?: boolean; retainOutput?: boolean; onStdout?: (data: string) => void; onStderr?: (data: string) => void },
		): Promise<E2BCommandHandle>;
		sendStdin(pid: number, data: Uint8Array, options: { requestTimeoutMs: number }): Promise<void>;
		/** Ends a command's stdin, so it reads end of file (index.mjs:5071-5082). */
		closeStdin(pid: number, options: { requestTimeoutMs: number }): Promise<void>;
	};
}

/** The paginator Sandbox.list returns (SandboxPaginator, index.mjs:5785-5849). */
export interface E2BPaginator {
	readonly hasNext: boolean;
	nextItems(options: { requestTimeoutMs: number; signal?: AbortSignal }): Promise<E2BListedSandbox[]>;
}

/** The statics of the SDK's Sandbox class this provider calls. The host's own, or anything with the same slice. */
export interface E2BSandboxClass {
	create(template: string, options: E2BCreateOptions): Promise<E2BSandbox>;
	connect(sandboxId: string, options: E2BConnectionOptions & { timeoutMs: number }): Promise<E2BSandbox>;
	getInfo(sandboxId: string, options: E2BConnectionOptions): Promise<E2BSandboxInfo>;
	setTimeout(sandboxId: string, timeoutMs: number, options: E2BConnectionOptions): Promise<void>;
	kill(sandboxId: string, options: E2BConnectionOptions): Promise<boolean>;
	list(options: Omit<E2BConnectionOptions, "signal"> & { query: { metadata: Record<string, string> }; limit: number }): E2BPaginator;
}

/** The longest each kind of call may take, and the pauses between polls. */
export interface E2BTimeouts {
	/** One control-plane or envd call: getInfo, kill, setTimeout, connect, a page of list, a bridge's start. */
	requestMs: number;
	/** Sandbox.create. */
	createMs: number;
	/** The daemon's upload. */
	uploadMs: number;
	/** The install command. */
	execMs: number;
	/** From a connect's start to the daemon's hello, and each read-back call after it. */
	helloMs: number;
	/** The probe, run through the daemon: it takes at most 20 s (10 s to connect, 10 s to answer, every target at once). */
	probeMs: number;
	/** One whole list, every page and every sandbox's read-back. */
	listMs: number;
	/** From a kill to a sandbox E2B no longer has and no longer lists. */
	goneMs: number;
	/** The first pause between two reads while release waits; the pauses double up to 5 s. */
	pollMs: number;
	/** How long create waits for the listing to show the new computer. */
	listedMs: number;
	/** Each root step of an Archil mount (the preflight, mount or revoke, serve), and its checkin at release. */
	mountMs: number;
}

export interface E2BProviderOptions {
	/** The E2B API key. The caller passes it; this provider never reads it from the environment or puts it in a computer. */
	apiKey: string;
	/** Told what is no failure of the call it came from: a release that did not let an Archil folder go cleanly. */
	onNote?: ProviderNote;
	/** The SDK's Sandbox class: the host's `e2b` package's, or a fake. */
	Sandbox: E2BSandboxClass;
	/** E2B's domain: the API is https://api.<domain>. Default e2b.app. */
	domain?: string;
	/** The daemon binary for linux/amd64 on this machine. Default this package's dist/computerd-linux-amd64. */
	daemonPath?: string;
	/** desktop (default): a template with an X server, started through the daemon; linux: no screen. */
	kind?: "desktop" | "linux";
	/** The display and its X server, for kind desktop. Default Xvfb on :0, 1280x800. */
	desktop?: DesktopOptions;
	/** The longest lifetime check takes: E2B Hobby's 1 h by default, Pro's 24 h at most. */
	maxLifetimeMs?: number;
	/**
	 * Who the daemon runs as, uid:gid in numbers, never root. Default 2510:2510 (TOOL_USER), a uid no process of E2B's
	 * holds: init refuses to start while another process does.
	 */
	daemonUser?: string;
	/**
	 * Refused for now, in words: computers would take public traffic, so stream() gave a URL a browser opens, but the
	 * daemon's programs run in a network of their own (init --own-network), which E2B's proxy cannot reach, and a public
	 * stream's network is open, which a remote computer does not take yet. Default false.
	 */
	publicStream?: boolean;
	timeouts?: Partial<E2BTimeouts>;
	/**
	 * The addresses the probe tries, to show none of them answers a computer with network none: host:port over TCP, or
	 * host:port/udp, a DNS query over UDP.
	 */
	probeTargets?: string[];
}

/**
 * The environment fromEnv reads, by name. Never E2B_API_KEY: a host may hold another team's key under that name, and the
 * SDK reads it on its own when it is given none (index.mjs:1140, 1189-1191), so the key is always given explicitly.
 */
export const ENV = {
	/** Required: the E2B API key. */
	key: "COMPUTER_E2B_API_KEY",
	/** E2B's domain; default e2b.app. */
	domain: "COMPUTER_E2B_DOMAIN",
	/** The daemon binary; default this package's dist/computerd-linux-amd64. */
	daemon: "COMPUTER_E2B_DAEMON",
	/** desktop (default) or linux. */
	kind: "COMPUTER_E2B_KIND",
	/** The cap, in ms: 3600000 (Hobby, default) up to 86400000 (Pro). */
	maxLifetimeMs: "COMPUTER_E2B_MAX_LIFETIME_MS",
	/** uid:gid the daemon runs as; default 2510:2510. */
	user: "COMPUTER_E2B_USER",
	/** 1: computers take public traffic and stream() gives a URL; refused for now (publicStream). */
	publicStream: "COMPUTER_E2B_PUBLIC_STREAM",
} as const;

export interface E2BFromEnvOptions extends Partial<Omit<E2BProviderOptions, "apiKey" | "Sandbox">> {
	/** The SDK's Sandbox class; imported from the host's e2b package by default. */
	Sandbox?: E2BSandboxClass;
}

/** Not a literal, so no type checker or bundler resolves the SDK from this package. */
const E2B_PACKAGE: string = "e2b";
const DEFAULT_DOMAIN = "e2b.app";
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The connection options every SDK call is given. Exported for the test that hands them to the real SDK. */
export function connectionOptions({ apiKey, domain }: { apiKey: string; domain: string }): E2BConnectionOptions {
	return { apiKey, domain, apiUrl: `https://api.${domain}`, debug: false };
}

/**
 * The SDK takes sandboxUrl from E2B_SANDBOX_URL when it is given none (index.mjs:1152, 1183-1185), and no option can
 * clear it: it would send every envd call (the upload, commands, the bridge) there. So the provider refuses to start
 * while it is set, in process.env, which the SDK reads, or in the environment fromEnv was given.
 */
function ambientProblem(env: Record<string, string | undefined> = {}): string | undefined {
	if (process.env.E2B_SANDBOX_URL || env.E2B_SANDBOX_URL) {
		return "the E2B provider refuses to start while E2B_SANDBOX_URL is set: the SDK would send every call into a sandbox there. Unset it";
	}
	return undefined;
}

/**
 * An E2BProvider from COMPUTER_E2B_* alone: the key from COMPUTER_E2B_API_KEY and nowhere else, and the SDK's Sandbox
 * class from the host's e2b package unless given. Options win over the environment, but never give the key.
 */
export async function fromEnv(env: Record<string, string | undefined> = process.env, options: E2BFromEnvOptions = {}): Promise<E2BProvider> {
	const apiKey = env[ENV.key];
	if (apiKey === undefined || apiKey === "") throw new Error(`set ${ENV.key} to an E2B API key: the E2B provider reads it there and nowhere else, never from E2B_API_KEY`);
	const ambient = ambientProblem(env);
	if (ambient) throw new Error(ambient);
	const domain = options.domain ?? (env[ENV.domain] || DEFAULT_DOMAIN);
	if (!DOMAIN.test(domain)) throw new Error(`${ENV.domain} is E2B's domain, a host name such as ${DEFAULT_DOMAIN}, not ${JSON.stringify(domain)}`);
	const kind = options.kind ?? (env[ENV.kind] || "desktop");
	if (kind !== "desktop" && kind !== "linux") throw new Error(`${ENV.kind} is desktop or linux, not ${kind}`);
	let maxLifetimeMs = options.maxLifetimeMs;
	if (maxLifetimeMs === undefined && env[ENV.maxLifetimeMs]) {
		maxLifetimeMs = Number(env[ENV.maxLifetimeMs]);
		if (!/^\d+$/.test(env[ENV.maxLifetimeMs] as string)) throw new Error(`${ENV.maxLifetimeMs} is a whole number of milliseconds, such as 3600000 (Hobby) or 86400000 (Pro)`);
	}
	const stream = env[ENV.publicStream] ?? "";
	if (stream !== "" && stream !== "0" && stream !== "1") throw new Error(`${ENV.publicStream} is 1 or unset, not ${JSON.stringify(stream)}`);
	const Sandbox = options.Sandbox ?? ((await import(E2B_PACKAGE)) as { Sandbox: E2BSandboxClass }).Sandbox;
	return new E2BProvider({
		...(env[ENV.daemon] ? { daemonPath: env[ENV.daemon] } : {}),
		...(env[ENV.user] ? { daemonUser: env[ENV.user] } : {}),
		...(stream === "1" ? { publicStream: true } : {}),
		...options,
		...(maxLifetimeMs === undefined ? {} : { maxLifetimeMs }),
		apiKey,
		Sandbox,
		domain,
		kind,
	});
}

/** The conformance CLI's module for E2B: its live switch, the run's 30-minute cap, its template and the drifted twin. */
export const conformance = () => import("./conformance/e2b.js");

const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const NAME = /^computer-[0-9a-f]{12}$/;
const SANDBOX_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TEMPLATE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const NAME_LABEL = `${COMPUTER_LABEL}.name`;
/** The template create was asked for: E2B reports its id, and the alias only sometimes. */
const IMAGE_LABEL = `${COMPUTER_LABEL}.image`;
/** The most extend may move the deadline to: create's time plus the cap, by this machine's clock, as init was given. */
const MAX_LABEL = `${COMPUTER_LABEL}.max-deadline`;
/** The timeout create gave E2B, in ms: E2B's own end, startedAt plus this, until extend moves it. */
const TIMEOUT_LABEL = `${COMPUTER_LABEL}.timeout-ms`;
const USER = /^(\d+):(\d+)$/;
const MAX_ID = 4_294_967_294;
/** E2B Hobby's longest sandbox: 1 h (index.d.mts:10169-10172). */
const HOBBY_MAX_MS = 60 * 60_000;
/** E2B Pro's: 24 h. */
const PRO_MAX_MS = 24 * 60 * 60_000;
/** E2B runs x86-64 Firecracker VMs; the desktop template installs amd64 packages (e2b-dev/desktop template.py:67-78). */
const ARCH = "amd64";
const DEFAULT_DAEMON_PATH = fileURLToPath(new URL(`./computerd-linux-${ARCH}`, import.meta.url));
const DEFAULTS: E2BTimeouts = {
	requestMs: 30_000,
	createMs: 120_000,
	uploadMs: 120_000,
	execMs: 60_000,
	helloMs: 30_000,
	probeMs: 30_000,
	listMs: 60_000,
	goneMs: 120_000,
	pollMs: 1_000,
	listedMs: 15_000,
	mountMs: 120_000,
};

/** The mount kinds an E2B computer takes, as capabilities().mount declares them: the run's folder on an Archil disk. */
export const MOUNT: readonly MountKind[] = ["archil"];
/** The user an Archil computer's tools run as: the image's agentrun-tool, with no sudo and no capability. */
const ARCHIL_USER = `${ARCHIL_TOOL_UID}:${ARCHIL_TOOL_UID}`;
const RELEASE_POLL_MAX_MS = 5_000;
const LISTED_POLL_MS = 150;
const LISTED_ROUNDS = 2;
const LISTED_POLL_MAX_MS = 1_000;
const LISTEN_RETRY_MS = 250;
const MAX_PAGES = 100;
const PAGE = 100;
/** E2B's end, read back, is its start plus the timeout create gave it, to the second it rounds to (index.mjs:502-504). */
const END_SLACK_MS = 2_000;
/** The longest a Node timer or AbortSignal.timeout holds. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** What a call's race adds to its SDK request's own bound, so the SDK's timeout, not the race, reports a slow call. */
const CALL_SLACK_MS = 5_000;
/** The longest timeout the provider takes: the race of a call bounded by it must still fit a Node timer. */
const MAX_TIMEOUT_MS = MAX_TIMER_MS - CALL_SLACK_MS;
const STAGING = "/tmp/agentrun-computerd-";
/**
 * Public anycast resolvers, by address, as Modal's: TCP to 443, and DNS over UDP to 53, the classic path out where TCP
 * is dropped, over IPv4 and IPv6. E2B's firewall drops non-TCP to the deny set denyOut fills, in nftables
 * (e2b-dev/infra@ff3922213 pkg/sandbox/network/firewall.go, installRules rule 5): with no internet access a UDP target
 * gets no reply, refused.
 */
const DEFAULT_PROBE_TARGETS = ["1.1.1.1:443", "8.8.8.8:443", "[2606:4700:4700::1111]:443", "1.1.1.1:53/udp", "[2606:4700:4700::1111]:53/udp"];
/** A probe target: host:port, over TCP, or host:port/udp, a DNS query over UDP. */
const TARGET = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):[0-9]{1,5}(?:\/udp)?$/;
/** The desktop template's VNC server and its noVNC page (@e2b/desktop@2.5.0 dist/index.mjs:426-437, 471, 502). */
const VNC_PORT = 5900;
const STREAM_PORT = 6080;
const STREAM_PASSWORD_FILE = `${WORK}/.agentrun-stream-password`;
const STREAM_WAIT_MS = 30_000;
/** How long stream() waits for an old stream server to end after its kill. */
const STREAM_STOP_MS = 10_000;
const NOVNC = "/opt/noVNC/utils/novnc_proxy";
/** The programs a stream runs, which the next stream() stops first. */
const STREAM_PROGRAMS = ["x11vnc", NOVNC];
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const SPEC_FIELDS = new Set(["image", "lifetimeMs", "network", "labels", "mount"]);
const NUL = "a NUL byte cannot be sent to E2B";
const FIXED = "an E2B computer's network is fixed at create: create a new computer";
const PUBLIC =
	"publicStream is refused: the daemon's programs, the stream's servers among them, run in a network of their own (their loopback alone, out of reach of envd, which runs commands as root), which E2B's proxy cannot reach; and a public stream lets anyone with the computer's address reach any port in it, so its network is open, which a remote computer does not take yet";
/** envd's port in the sandbox (e2b@2.63.0 dist/index.mjs:1213, ConnectionConfig.envdPort). */
const ENVD_PORT = 49983;
const STOP = "an E2B computer has no stop that this provider declares: release it with delete";

const isWhole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const show = (value: unknown) => (value === undefined ? "nothing" : JSON.stringify(value));
const seconds = (ms: number) => `${ms / 1000} s`;
const pause = (ms: number, signal?: AbortSignal) =>
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
const words = (error: unknown) => {
	const name = (error as { name?: unknown } | null)?.name;
	const message = error instanceof Error ? error.message : String(error);
	return `${typeof name === "string" && name !== "Error" ? `${name}: ` : ""}${message}`.replace(/\s+/g, " ").slice(0, 300);
};

/** The SDK names its errors (index.mjs:86-360). */
function codeOf(error: unknown): ComputerErrorCode {
	const name = (error as { name?: unknown } | null)?.name;
	if (name === "AbortError") return "aborted";
	if (name === "SandboxNotFoundError" || name === "NotFoundError" || name === "FileNotFoundError") return "not_found";
	if (name === "AuthenticationError") return "denied";
	if (name === "InvalidArgumentError" || name === "TemplateError") return "invalid";
	if (name === "RateLimitError" || name === "NotEnoughSpaceError") return "limit";
	if (name === "TimeoutError" || name === "SandboxUnreachableError") return "timeout";
	return "e2b";
}

/** Settles with the promise's result, or a timeout or abort in words once ms pass or signal aborts. */
function race<T>(promise: Promise<T>, what: string, ms: number, signal?: AbortSignal): Promise<Result<T>> {
	if (signal?.aborted) {
		promise.catch(() => {});
		return Promise.resolve(fail("aborted", `${what} was aborted`));
	}
	return new Promise((settle) => {
		const timer = setTimeout(() => done(fail("timeout", `${what} did not answer within ${seconds(ms)}`)), ms);
		const onAbort = () => done(fail("aborted", `${what} was aborted`));
		signal?.addEventListener("abort", onAbort, { once: true });
		let settled = false;
		function done(result: Result<T>) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			settle(result);
		}
		promise.then(
			(value) => done(ok(value)),
			(error: unknown) => done(signal?.aborted ? fail("aborted", `${what} was aborted`) : fail(codeOf(error), `${what} failed: ${words(error)}`)),
		);
	});
}

/** Calls run and races it; a run that throws at once is an error like one that rejects. */
function call<T>(what: string, run: () => Promise<T>, ms: number, signal?: AbortSignal): Promise<Result<T>> {
	if (signal?.aborted) return Promise.resolve(fail("aborted", `${what} was aborted before it was called`));
	let promise: Promise<T>;
	try {
		promise = Promise.resolve(run());
	} catch (error) {
		return Promise.resolve(fail(codeOf(error), `${what} failed: ${words(error)}`));
	}
	return race(promise, what, ms, signal);
}

/** A timeout of a call within list(): listBound when what bounded it was what was left of the listing's deadline. */
type ListBound = { listBound?: true };

/**
 * Marks result's timeout listBound when left, what was left of a listing's deadline as the call began, was its bound,
 * not its own requestMs: then the listing's deadline ended it, whatever Date.now() reads a moment after.
 */
function boundBy<T>(result: Result<T>, left: number | undefined, requestMs: number): Result<T> & ListBound {
	return !result.ok && result.error.code === "timeout" && left !== undefined && left <= requestMs ? { ...result, listBound: true } : result;
}

function labelProblem(key: string, value: unknown): string | undefined {
	if (typeof value !== "string") return `the label ${key} must be a string`;
	if (key.includes("\0") || value.includes("\0")) return `the label ${JSON.stringify(key)}: ${NUL}`;
	if (key === "") return "a label name must be non-empty";
	if (key === COMPUTER_LABEL || key.startsWith(`${COMPUTER_LABEL}.`)) return `the label ${key} is in the provider's own namespace (${COMPUTER_LABEL})`;
	if (key === ARCHIL_MOUNT_LABEL) return `the label ${key} is the provider's own: it records an Archil computer's mount`;
	return undefined;
}

function filterProblem(labels: unknown): string | undefined {
	if (typeof labels !== "object" || labels === null || Array.isArray(labels)) return "labels must map names to strings";
	for (const [key, value] of Object.entries(labels)) {
		if (typeof value !== "string") return `the label ${key} must be a string`;
		if (key === "" || key.includes("\0") || value.includes("\0")) return `the label ${JSON.stringify(key)} must be a non-empty name with no NUL byte`;
	}
	return undefined;
}

/** Only a sandbox this provider made counts: its label, a name of its making, and the name asked for when one is. */
const ours = (metadata: Record<string, string> | undefined, name?: string) =>
	metadata?.[COMPUTER_LABEL] === "1" && NAME.test(metadata[NAME_LABEL] ?? "") && (name === undefined || metadata[NAME_LABEL] === name);

/** An ISO time a label holds, or undefined when it is missing or not the ISO time create writes. */
function isoOf(written: string | undefined): Date | undefined {
	const at = written === undefined ? Number.NaN : Date.parse(written);
	return Number.isNaN(at) || new Date(at).toISOString() !== written ? undefined : new Date(at);
}

/** E2B's end as create set it: its start plus the timeout create gave, by E2B's clock; undefined when unread. */
function createdEnd({ metadata, startedAt }: { metadata: Record<string, string>; startedAt: Date }): number | undefined {
	const timeout = Number(metadata[TIMEOUT_LABEL]);
	const start = startedAt instanceof Date ? startedAt.getTime() : Number.NaN;
	return isWhole(timeout) && timeout > 0 && !Number.isNaN(start) ? start + timeout : undefined;
}

/**
 * When a computer ends: the deadline create wrote, or, once extend has moved E2B's end past where create set it, that
 * end up to the most the computer may live, which is what extend gave init. E2B keeps no metadata change (it has no call
 * for one), so the vendor's end, read back, stands for a moved deadline. An end within END_SLACK_MS of create's is
 * create's own, rounded: extend never leaves E2B's end there (clearOf).
 */
function deadlineOf(sb: { metadata: Record<string, string>; startedAt: Date; endAt: Date }): Date | undefined {
	const written = isoOf(sb.metadata[DEADLINE_LABEL]);
	if (written === undefined) return undefined;
	const end = sb.endAt instanceof Date ? sb.endAt.getTime() : Number.NaN;
	const created = createdEnd(sb);
	if (Number.isNaN(end) || created === undefined || end <= created + END_SLACK_MS) return written;
	const most = isoOf(sb.metadata[MAX_LABEL]);
	return new Date(most === undefined ? end : Math.min(end, most.getTime()));
}

/** The earliest end extend gives E2B: a second past create's end and its rounding, so deadlineOf reads it as moved. */
const clearOf = (created: number) => created + END_SLACK_MS + 1_000;

/**
 * A sandbox's network as E2B reports it. None is no internet access (E2B: the same as denyOut 0.0.0.0/0,
 * index.d.mts:10179) with no allow list and no public traffic in; open is internet access with none of those either,
 * or, with publicStream, public traffic in. Anything else is another network in words, never one it might widen to.
 */
function networkOf(info: E2BSandboxInfo, publicStream: boolean): NetworkPolicy {
	const network = info.network ?? {};
	if (network.egressProxy !== undefined && network.egressProxy !== null) return { other: "an egress proxy is set on it" };
	if (Array.isArray(network.allowOut) && network.allowOut.length > 0) return { other: `an allowOut list (${network.allowOut.length} entries), which this provider never makes` };
	if (network.rules !== undefined && network.rules !== null && Object.keys(network.rules as object).length > 0) return { other: "transform rules, which this provider never makes" };
	const denied = Array.isArray(network.denyOut) ? network.denyOut : [];
	const blocked = info.allowInternetAccess === false || denied.includes("0.0.0.0/0");
	if (!blocked && denied.length > 0) return { other: `a denyOut list short of all traffic (${denied.join(", ")})` };
	if (network.allowPublicTraffic !== false && !(publicStream && network.allowPublicTraffic === true && !blocked)) {
		return { other: network.allowPublicTraffic === true ? "public traffic is let in" : "E2B did not report allowPublicTraffic false: public traffic may be let in" };
	}
	return blocked ? "none" : "open";
}

const policyWords = (policy: NetworkPolicy) => (typeof policy === "string" ? policy : "other" in policy ? policy.other : JSON.stringify(policy));

/** The Archil mount a computer's agentrun.mount label records (recordedArchilOf, shared), or undefined when it has none. */
function recordedArchil(metadata: Record<string, string> | undefined): RecordedArchil | undefined {
	if (metadata?.[ARCHIL_MOUNT_LABEL] === undefined) return undefined;
	const mount = recordedMount(metadata);
	return recordedArchilOf(metadata, mount === undefined ? { other: `the label ${ARCHIL_MOUNT_LABEL} records a mount this provider never makes` } : { mount });
}

/** One word for a shell: single-quoted. */
const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;

/** What create made before the sandbox: its deadlines, its metadata, and the daemon with its sha256. */
interface Made {
	deadline: string;
	maxDeadline: string;
	metadata: Record<string, string>;
	daemon: Buffer;
	sha256: string;
}

/** The E2B timeout of the diagnostic's sandbox: E2B ends it at 10 minutes whatever happens to the run. */
export const DIAGNOSE_LIFETIME_MS = 10 * 60_000;

/**
 * What diagnoseNetworkNone learned, one JSON object: the sandbox it made (none when create made nothing), E2B's
 * read-back of its network, the provider's own network-none check from inside (`passed`, or its refusal in words, which
 * stands: the diagnostic never relaxes it), what `computerd probe --diagnose` printed, why it stopped short of that, and
 * whether the sandbox was killed and read back gone.
 */
export interface E2BNetworkDiagnosis {
	template: string;
	computer?: ComputerRef;
	readBack?: { allowInternetAccess?: boolean; allowPublicTraffic?: boolean; allowOut?: string[]; denyOut?: string[] };
	check?: string;
	/** What the provider's check recorded that does not refuse the sandbox: its silent accepts, in words. */
	notes?: string[];
	diagnosis?: unknown;
	error?: { code: ComputerErrorCode; message: string };
	released: { gone: boolean; words: string };
}

/** How the diagnostic reaches the provider's private steps: set by E2BProvider's static block. */
let diagnoseWith: (provider: E2BProvider, image: string, signal?: AbortSignal) => Promise<E2BNetworkDiagnosis>;

/**
 * The network diagnostic: one sandbox made exactly as create makes one for network none (the same options, read-back,
 * upload and sha256 check, daemon and display start, and the provider's own check from inside, recorded), then
 * `computerd probe --diagnose` in it, and the sandbox killed and read back gone whatever happened, an abort included.
 * Its E2B timeout is 10 minutes. It never relaxes create: create still refuses what the check refuses.
 */
export function diagnoseNetworkNone(provider: E2BProvider, { image, signal }: { image: string; signal?: AbortSignal }): Promise<E2BNetworkDiagnosis> {
	return diagnoseWith(provider, image, signal);
}

/** Why ref is not an E2B computer's ref, or undefined. */
function refProblem(ref: ComputerRef): string | undefined {
	if (typeof ref?.name !== "string" || !NAME.test(ref.name)) return `${String(ref?.name)} is not the name of an E2B computer (computer-<12 hex digits>)`;
	if (typeof ref.id !== "string" || !SANDBOX_ID.test(ref.id)) return `${String(ref.id)} is not an E2B sandbox id`;
	return undefined;
}

/**
 * Computers that are E2B sandboxes. A spec's image is an E2B template (its name or id): "desktop" is E2B Desktop's, with
 * Xvfb, x11vnc and noVNC (e2b-dev/desktop template.py:21-65). See the README's E2B section for every call and its
 * citation.
 */
export class E2BProvider implements ComputerProvider {
	readonly id = "e2b";
	readonly version = VERSION;
	/** Only with publicStream: a URL that shows the screen live, through the template's noVNC. */
	readonly stream?: (ref: ComputerRef, options?: { viewOnly?: boolean }, context?: CallContext) => Promise<Result<{ url: string }>>;
	readonly #Sandbox: E2BSandboxClass;
	readonly #connection: E2BConnectionOptions;
	readonly #daemonPath: string;
	readonly #kind: "desktop" | "linux";
	readonly #desktop: Required<DesktopOptions> | undefined;
	readonly #maxLifetimeMs: number;
	readonly #uid: string;
	readonly #gid: string;
	readonly #publicStream: boolean;
	readonly #timeouts: E2BTimeouts;
	readonly #probeTargets: string[];
	readonly #onNote: ProviderNote | undefined;
	/** Each computer's last extend, by sandbox id, while one runs: the next waits for it. */
	readonly #extending = new Map<string, Promise<void>>();

	constructor({
		apiKey,
		onNote,
		Sandbox,
		domain = DEFAULT_DOMAIN,
		daemonPath = DEFAULT_DAEMON_PATH,
		kind = "desktop",
		desktop = {},
		maxLifetimeMs = HOBBY_MAX_MS,
		daemonUser = TOOL_USER,
		publicStream = false,
		timeouts = {},
		probeTargets = DEFAULT_PROBE_TARGETS,
	}: E2BProviderOptions) {
		this.#onNote = onNote;
		if (typeof apiKey !== "string" || apiKey === "") throw new Error("an E2B API key is required");
		if (publicStream === true) throw new Error(PUBLIC);
		const lacks = ["create", "connect", "getInfo", "setTimeout", "kill", "list"].filter((name) => typeof (Sandbox as unknown as Record<string, unknown>)?.[name] !== "function");
		if (lacks.length > 0) throw new Error(`options.Sandbox must be the e2b SDK's Sandbox class; it lacks ${lacks.join(", ")}`);
		const ambient = ambientProblem();
		if (ambient) throw new Error(ambient);
		if (typeof domain !== "string" || !DOMAIN.test(domain)) throw new Error(`the E2B domain must be a host name such as ${DEFAULT_DOMAIN}, not ${JSON.stringify(domain)}`);
		if (kind !== "desktop" && kind !== "linux") throw new Error(`kind is desktop or linux, not ${String(kind)}`);
		if (!isWhole(maxLifetimeMs) || maxLifetimeMs <= 0 || maxLifetimeMs > PRO_MAX_MS) {
			throw new Error(`maxLifetimeMs must be a whole number of ms above 0 and at most 24 h (${PRO_MAX_MS} ms), E2B Pro's longest sandbox; Hobby's is 1 h`);
		}
		const user = USER.exec(daemonUser);
		if (user === null || Number(user[1]) > MAX_ID || Number(user[2]) > MAX_ID) throw new Error(`the daemon user ${daemonUser} must be uid:gid in numbers, such as 1000:1000`);
		// The numbers, not the text: "00" is root as much as "0" is.
		if (Number(user[1]) === 0 || Number(user[2]) === 0) throw new Error(`the daemon user ${daemonUser} is root or in root's group; an E2B computer's daemon runs as neither`);
		const merged = { ...DEFAULTS, ...timeouts };
		// AbortSignal.timeout and Node's timers take whole ms up to 2^31 - 1 (a fraction throws, a longer one fires at
		// once), and a call's race adds CALL_SLACK_MS to its bound: refused here, before any sandbox exists, not in create.
		for (const [key, value] of Object.entries(merged)) {
			if (!isWhole(value) || value <= 0 || value > MAX_TIMEOUT_MS) throw new Error(`timeouts.${key} must be a whole number of ms above 0 and at most ${MAX_TIMEOUT_MS}, not ${value}`);
		}
		if (!Array.isArray(probeTargets) || probeTargets.length === 0 || probeTargets.some((target) => typeof target !== "string" || !TARGET.test(target))) {
			throw new Error("probeTargets must name at least one address for the probe, each host:port or host:port/udp");
		}
		this.#Sandbox = Sandbox;
		this.#connection = connectionOptions({ apiKey, domain });
		this.#daemonPath = resolve(daemonPath);
		this.#kind = kind;
		this.#desktop = kind === "desktop" ? desktopOf(desktop) : undefined;
		this.#maxLifetimeMs = maxLifetimeMs;
		[this.#uid, this.#gid] = [String(Number(user[1])), String(Number(user[2]))];
		// Refused above while the daemon's programs have a network of their own; the stream's code stays for the inbound
		// forward that lifts the refusal (loop/PR-NOTES.md, known gaps).
		this.#publicStream = false;
		this.#timeouts = merged;
		this.#probeTargets = [...probeTargets];
		if (this.#publicStream && this.#desktop) this.stream = (ref, options, context) => this.#stream(ref, options, context);
	}

	/**
	 * daemon child: E2B's envd is the sandbox's first process, under systemd with Restart=always (e2b-dev/infra
	 * envd.service.tpl:26-30), and init is a background command it runs (#prepare), so init's exit leaves the sandbox. Its
	 * cap is E2B's: Hobby's 1 h unless the provider was made with more, up to Pro's 24 h. envd runs as root and answers on
	 * 49983, so init starts with --own-network, and network none is all a computer takes until a proxy carries open out
	 * of the daemon's own network.
	 */
	capabilities(): ComputerCapabilities {
		return {
			kind: this.#kind,
			lifetime: "vendor",
			network: ["none"],
			networkReadBack: true,
			isolation: "microvm",
			os: "linux",
			daemon: "child",
			groups: ["exec", "files", "processes", ...(this.#desktop ? DESKTOP_GROUPS : [])],
			maxLifetimeMs: this.#maxLifetimeMs,
			release: ["delete"],
			mount: [...MOUNT],
			vendorAgentPorts: [ENVD_PORT],
		};
	}

	check(spec: ComputerSpec): Refusal[] {
		const refusals: Refusal[] = [];
		const refuse = (field: string, message: string) => refusals.push({ field, message });
		const given = (typeof spec === "object" && spec !== null ? spec : {}) as unknown as Record<string, unknown>;
		const { image, lifetimeMs, network, labels, mount } = given;
		refusals.push(...checkMount(mount, MOUNT), ...archilRefusals(given as unknown as ComputerSpec));
		const daemonUser = `${this.#uid}:${this.#gid}`;
		if ((mount as { kind?: unknown } | undefined)?.kind === "archil" && daemonUser !== ARCHIL_USER) {
			refuse(
				"mount",
				`a computer with an Archil mount runs its tools as agentrun-tool, ${ARCHIL_USER}, the user its image makes with no way to root; this provider's daemon user is ${daemonUser}: make it with daemonUser ${ARCHIL_USER}`,
			);
		}
		if (typeof image !== "string" || !TEMPLATE.test(image)) refuse("image", 'an image is required: the name or id of an E2B template, such as "desktop" (E2B Desktop) or "base"');
		refusals.push(...checkLifetime(lifetimeMs, this.capabilities()));
		if (network === "open" || (typeof network === "object" && network !== null && "allow" in network)) refuse("network", OWN_NETWORK_ONLY);
		else if (network !== "none") refuse("network", 'network is required: "none"');
		if (labels !== undefined) {
			const entries = typeof labels === "object" && labels !== null && !Array.isArray(labels) ? Object.entries(labels) : undefined;
			const bad = entries === undefined ? "labels must map names to strings" : entries.map(([key, value]) => labelProblem(key, value)).find(Boolean);
			if (bad) refuse("labels", bad);
		}
		for (const [field, value] of Object.entries(given)) {
			if (SPEC_FIELDS.has(field) || value === undefined) continue;
			if (field === "cpus" || field === "memoryMb" || field === "pids") refuse(field, `an E2B computer has the size of its template: name a template of the size you need, not ${field}`);
			else if (field === "user") refuse(field, `an E2B computer's daemon runs as the provider's daemon user (${this.#uid}:${this.#gid}), never as one a spec names`);
			else if (field === "workdir") refuse(field, `an E2B computer works in ${WORK}, its home; a spec cannot name another`);
			else refuse(field, `an E2B computer does not support ${field}`);
		}
		return refusals;
	}

	/** The connection options with a bound and, when given, the caller's signal. */
	#api(ms: number, signal?: AbortSignal): E2BConnectionOptions {
		return { ...this.#connection, requestTimeoutMs: ms, ...(signal ? { signal } : {}) };
	}

	async create(spec: ComputerSpec, { signal }: CallContext = {}): Promise<Result<CreatedComputer>> {
		const launched = await this.#launch(spec, signal);
		if (!launched.ok) return launched;
		const { sandbox, ref, made } = launched.value;
		// From here the sandbox exists: every step takes the caller's signal, and a failure or an abort kills it.
		const prepared = await this.#prepare(spec, ref, sandbox, made, signal);
		if (signal?.aborted) return this.#abandon(ref, { code: "aborted", message: "create was aborted" }, signal);
		if (prepared.ok) return ok(prepared.value.length > 0 ? { ...ref, notes: prepared.value } : ref);
		return this.#abandon(ref, prepared.error, signal);
	}

	/** Everything create does up to E2B's answer: the spec checked, the daemon read, the sandbox made, by its options. */
	async #launch(spec: ComputerSpec, signal?: AbortSignal): Promise<Result<{ sandbox: E2BSandbox; ref: ComputerRef; made: Made }>> {
		const refusals = this.check(spec);
		if (refusals.length > 0) return fail("refused", refusals.map(({ field, message }) => `${field}: ${message}`).join("; "));
		let daemon: Buffer;
		try {
			daemon = readFileSync(this.#daemonPath);
		} catch {
			return fail("not_found", `no daemon binary at ${this.#daemonPath}: run npm run build:daemon -w @parcha/agentrun-computer`);
		}
		const sha256 = createHash("sha256").update(daemon).digest("hex");
		if (signal?.aborted) return fail("aborted", "create was aborted before E2B was called");
		const name = `computer-${randomBytes(6).toString("hex")}`;
		const now = Date.now();
		const deadline = new Date(now + spec.lifetimeMs).toISOString();
		const maxDeadline = new Date(now + this.#maxLifetimeMs).toISOString();
		// E2B kills the sandbox at its timeout, the lifetime in the whole seconds it takes (index.mjs:502-504).
		const timeoutMs = Math.ceil(spec.lifetimeMs / 1000) * 1000;
		const metadata = {
			...spec.labels,
			[COMPUTER_LABEL]: "1",
			[NAME_LABEL]: name,
			[DEADLINE_LABEL]: deadline,
			[IMAGE_LABEL]: spec.image,
			[MAX_LABEL]: maxDeadline,
			[TIMEOUT_LABEL]: String(timeoutMs),
			// An Archil computer's mount, kind and source, never the token: what list() reports and attach reads back against.
			...(spec.mount?.kind === "archil" ? archilLabels(spec.mount) : {}),
		};
		const options: E2BCreateOptions = {
			...this.#api(this.#timeouts.createMs),
			timeoutMs,
			metadata,
			envs: {},
			// An Archil computer's root reaches Archil, so its internet access stays on: its tools' network none is init's
			// own, read back by the probe from inside, as the tool user, like every network none here.
			allowInternetAccess: spec.network === "open" || spec.mount?.kind === "archil",
			// Explicit: a project's default may let public traffic in (E2B docs, network/restrict-public-access).
			network: { allowPublicTraffic: this.#publicStream },
			// Explicit kill at the timeout, never a pause that keeps the computer (index.mjs:5674-5699).
			lifecycle: { onTimeout: "kill" },
		};
		// Never cancelled, only raced: an aborted fetch could leave a sandbox made whose id never came back.
		let creating: Promise<E2BSandbox>;
		try {
			creating = Promise.resolve(this.#Sandbox.create(spec.image, options));
		} catch (error) {
			return fail(codeOf(error), `Sandbox.create failed: ${words(error)}`);
		}
		const created = await race(creating, "Sandbox.create", this.#timeouts.createMs + CALL_SLACK_MS, signal);
		if (!created.ok) {
			if (created.error.code === "aborted" || created.error.code === "timeout") {
				// One that lands is killed by its id; one whose answer never comes, by its name label.
				creating.then(
					(sandbox) => this.#kill(sandbox.sandboxId),
					() => this.#killNamed(name),
				);
				return fail(created.error.code, `${created.error.message}; a sandbox it makes after this is killed as it lands, and E2B ends it by ${deadline} either way`);
			}
			// A create E2B refused (4xx) made nothing. One that failed otherwise may have: it goes by its name label.
			if (["invalid", "denied", "limit", "not_found"].includes(created.error.code)) return created;
			const swept = await this.#killNamed(name);
			return fail(created.error.code, `E2B did not create the sandbox: ${created.error.message}${swept}`);
		}
		const sandbox = created.value;
		return ok({ sandbox, ref: { id: sandbox.sandboxId, name }, made: { deadline, maxDeadline, metadata, daemon, sha256 } });
	}

	/** Kills a sandbox create gives up on, then waits, under the caller's signal, until E2B reads it gone. */
	async #abandon(ref: ComputerRef, error: { code: ComputerErrorCode; message: string }, signal?: AbortSignal): Promise<Result<never>> {
		const killed = await this.#kill(ref.id);
		const gone = killed.ok ? await this.#settle(ref, signal) : killed;
		const after = gone.ok
			? "was deleted"
			: killed.ok && gone.error.code === "aborted"
				? "was killed, and the wait for it to go was aborted; E2B ends it at its timeout if the kill did not take"
				: `could not be deleted (${gone.error.message}); E2B ends it at its timeout`;
		return fail(error.code, `the computer ${ref.name} ${after}: ${error.message}`);
	}

	/**
	 * Every sandbox carrying a name create gave, killed and read back gone: for a create whose answer never came. The
	 * listing shows a new sandbox a moment after E2B makes it, so it is read for the name until one shows or listedMs
	 * passes. Best effort, in words.
	 */
	async #killNamed(name: string): Promise<string> {
		const { listedMs, pollMs } = this.#timeouts;
		const until = Date.now() + listedMs;
		let found: E2BListedSandbox[];
		for (;;) {
			const listed = await this.#listPages({ [COMPUTER_LABEL]: "1", [NAME_LABEL]: name });
			if (!listed.ok) return `; a sandbox named ${name} may be left (${listed.error.message}), which E2B ends at its timeout`;
			found = listed.value;
			if (found.length > 0 || Date.now() >= until) break;
			await pause(Math.min(LISTED_POLL_MS, pollMs));
		}
		if (found.length === 0) return `; no sandbox named ${name} was listed within ${seconds(listedMs)}, and E2B ends any it made at its timeout`;
		const said: string[] = [];
		for (const sb of found) {
			const killed = await this.#kill(sb.sandboxId);
			const gone = killed.ok ? await this.#settle({ id: sb.sandboxId, name }) : killed;
			said.push(gone.ok ? `${sb.sandboxId} was killed and read back gone` : `${sb.sandboxId} may be left (${gone.error.message}), which E2B ends at its timeout`);
		}
		return `; the sandbox named ${name} it made: ${said.join("; ")}`;
	}

	/** Sandbox.kill, never signalled: a kill that cleans up after an abort must outlive it. Not found is done. */
	async #kill(id: string): Promise<Result<void>> {
		const killed = await call(`Sandbox.kill of ${id}`, () => this.#Sandbox.kill(id, this.#api(this.#timeouts.requestMs)), this.#timeouts.requestMs + CALL_SLACK_MS);
		return killed.ok || killed.error.code === "not_found" ? ok(undefined) : killed;
	}

	/**
	 * Everything between the create's answer and a computer that passed the drift check, whose value is what the check
	 * recorded that does not refuse it (notes). The diagnostic (#diagnose) is given every step alike up to the daemon's
	 * first connection, then runs its own inside step in place of the check and the listing's wait, and sees the
	 * read-back.
	 */
	async #prepare(
		spec: ComputerSpec,
		ref: ComputerRef,
		sandbox: E2BSandbox,
		{ deadline, maxDeadline, metadata, daemon, sha256 }: Made,
		signal?: AbortSignal,
		diagnostic?: { readBack(info: E2BSandboxInfo): void; inside(connection: ComputerConnection): Promise<Result<void>> },
	): Promise<Result<string[]>> {
		const { uploadMs, execMs } = this.#timeouts;
		const info = await this.#info(ref.id, signal);
		if (!info.ok) return info;
		diagnostic?.readBack(info.value);
		const vendor = this.#sandboxDrift(spec, info.value, metadata);
		if (vendor.length > 0) return fail("refused", `it did not match its spec: ${vendor.join("; ")}`);
		const staging = `${STAGING}${randomBytes(8).toString("hex")}`;
		const bytes = daemon.buffer.slice(daemon.byteOffset, daemon.byteOffset + daemon.byteLength) as ArrayBuffer;
		const uploaded = await call(`the daemon's upload into ${ref.name}`, () => sandbox.files.write(staging, bytes, { user: "root", requestTimeoutMs: uploadMs, ...(signal ? { signal } : {}) }), uploadMs + CALL_SLACK_MS, signal);
		if (!uploaded.ok) return fail(uploaded.error.code, `the daemon's upload was refused: ${uploaded.error.message}`);
		const commands = childCommands({ staging, deadline, user: `${this.#uid}:${this.#gid}`, display: this.#desktop?.display ?? "", maxDeadline });
		const install = await this.#run(sandbox, commands.install, execMs, signal);
		if (!install.ok) return install;
		if (install.value.exitCode !== 0) return fail("refused", `installing the daemon failed (exit ${install.value.exitCode}): ${`${install.value.stdout} ${install.value.stderr}`.trim().slice(0, 500)}`);
		const read = /^sha256 ([0-9a-f]{64})$/m.exec(install.value.stdout)?.[1];
		if (read !== sha256) return fail("refused", `it did not match its spec: daemon: uploaded sha256 ${sha256}, the installed binary reads back ${show(read)}`);
		// The run's folder, after the daemon is in place (serve runs it) and before init starts: no tool program runs before
		// it is mounted. A folder mounted for a computer create then gives up on is let go before the kill, never signalled.
		if (spec.mount?.kind !== "archil") return this.#start(spec, ref, sandbox, commands, signal, diagnostic);
		const root = this.#root(sandbox, ref.name);
		const mounted = await this.#mountArchil(root, { mount: spec.mount, run: spec.labels?.[RUN_LABEL] as string, epoch: claimEpoch(spec.labels) }, signal);
		if (!mounted.ok) return mounted;
		const started = await this.#start(spec, ref, sandbox, commands, signal, diagnostic);
		if (!started.ok || signal?.aborted) await archilRelease({ root, client: undefined, timeoutMs: this.#timeouts.mountMs });
		return started;
	}

	/** The rest of #prepare from the daemon's install on: init started, its first connection checked, the listing waited for. */
	async #start(
		spec: ComputerSpec,
		ref: ComputerRef,
		sandbox: E2BSandbox,
		commands: ReturnType<typeof childCommands>,
		signal?: AbortSignal,
		diagnostic?: { readBack(info: E2BSandboxInfo): void; inside(connection: ComputerConnection): Promise<Result<void>> },
	): Promise<Result<string[]>> {
		const { requestMs } = this.#timeouts;
		// No command timeout: envd kills a command when its timeout passes (e2b-dev/infra envd process/start.go:39-44).
		// Never cancelled: envd keeps a command running when its stream ends (start.go:39-40); create disconnects after.
		const init = await call(
			`starting the daemon in ${ref.name}`,
			() => sandbox.commands.run(commands.init, { background: true, user: "root", timeoutMs: 0, requestTimeoutMs: requestMs }),
			requestMs + CALL_SLACK_MS,
			signal,
		);
		if (!init.ok) return init;
		try {
			const opened = await this.#openWhenListening(sandbox, ref.name, signal);
			if (!opened.ok) {
				const why = init.value.stderr.trim().slice(-500);
				return opened.error.code === "aborted" ? opened : fail(opened.error.code, `the daemon did not answer: ${opened.error.message}${why ? `; init wrote: ${why}` : ""}`);
			}
			let notes: string[] = [];
			try {
				if (diagnostic) {
					const inside = await diagnostic.inside(opened.value);
					if (!inside.ok) return inside;
				} else {
					const archil = spec.mount?.kind === "archil" ? { mount: { kind: "archil" as const, disk: spec.mount.disk, region: spec.mount.region, folder: spec.mount.folder }, epoch: claimEpoch(spec.labels) } : undefined;
					const expected = archil === undefined ? undefined : { ...archil, expected: readBackOf({ ...archil.mount, token: "" }, archil.epoch) };
					const inside = await this.#checkInside(opened.value, ref.name, spec.network as "none" | "open", true, signal, expected);
					if (!inside.ok) return inside;
					notes = inside.value;
				}
			} finally {
				await opened.value.close();
			}
			if (diagnostic) return ok([]);
			const listed = await this.#waitListed(ref, signal);
			return listed.ok ? ok(notes) : listed;
		} finally {
			await init.value.disconnect().catch(() => {});
		}
	}

	/**
	 * Inside the computer: for a desktop just made, the X server started through the daemon and hello declaring the
	 * display; then the daemon's own report (hello, credentials, home, binary) and, for network none, the probe, which
	 * refuses on an answer and records a silent accept in the notes it returns (README, "Network none, read from inside");
	 * and, for an Archil computer, the mount read back from inside, held to the one expected. Its value says what was
	 * read back of the mount (mount), apart from the notes.
	 */
	async #checkInside(
		connection: ComputerConnection,
		name: string,
		network: NetworkPolicy,
		starting: boolean,
		signal?: AbortSignal,
		archil?: RecordedArchil,
	): Promise<Result<string[]> & { mount?: MountReadBack }> {
		let current = connection;
		if (starting && this.#desktop) {
			const shown = await startDisplay(connection.client, this.#desktop, { version: VERSION, vendor: "e2b", signal });
			if (!shown.ok) return shown;
			const hello = await connection.client.call("hello", { client: `@parcha/agentrun-computer ${VERSION}` }, { signal: this.#bounded(this.#timeouts.helloMs, signal) });
			if (!hello.ok) return hello.error.code === "aborted" && !signal?.aborted ? fail("timeout", `the daemon in ${name} did not answer hello within ${seconds(this.#timeouts.helloMs)}`) : hello;
			current = { ...connection, hello: hello.value };
		}
		const found = await daemonDrift(current, this.#daemonExpected(), this.#timeouts.helloMs, signal);
		if (!found.ok) return found;
		const drift = [...found.value];
		const notes: string[] = [];
		if (network === "none") {
			const probe = await this.#probe(current, name, signal);
			if (!probe.ok) return probe;
			drift.push(...probeNetworkDrift(probe.value));
			notes.push(...probeNotes(probe.value, network));
		}
		if (archil === undefined) return drift.length === 0 ? ok(notes) : fail("refused", `it did not match its spec: ${drift.join("; ")}`);
		const mount = await this.#readMount(current, name, archil, signal);
		if (!mount.ok) return mount;
		drift.push(...mountDrift(archil.expected, mount.value));
		const read = mount.value === undefined ? {} : { mount: mount.value };
		return drift.length === 0 ? { ...ok(notes), ...read } : fail("refused", `it did not match its spec: ${drift.join("; ")}`);
	}

	/**
	 * What is mounted at /workspace, read from inside through computerd (its /proc/self/mounts), exclusive when the
	 * resident serve answers a sync; undefined when nothing is mounted there.
	 */
	#readMount(connection: ComputerConnection, name: string, archil: Pick<RecordedArchil, "mount" | "epoch">, signal?: AbortSignal): Promise<Result<MountReadBack | undefined>> {
		return readArchilMount(connection.client, archil, { name, timeoutMs: this.#timeouts.helloMs, ...(signal ? { signal } : {}) });
	}

	/**
	 * The root channel into a sandbox: a background command as root with stdin (index.mjs:5123-5146), its command line
	 * the argv quoted, bounded by timeoutMs (envd kills it then). stdin, when given, goes in with sendStdin; then
	 * closeStdin, so it reads end of file. What it printed is both streams, stdout first; a non-zero exit is a result.
	 * An error is the SDK's, in words that never hold what stdin was given.
	 */
	#root(sandbox: E2BSandbox, name: string): ArchilRoot {
		const { requestMs } = this.#timeouts;
		return {
			run: (argv, { stdin, timeoutMs, signal }) =>
				call(
					`root's ${argv[0] === ARCHIL_HELPER ? `agentrun-archil ${argv[1]}` : argv[0]} in ${name}`,
					async () => {
						const handle = await sandbox.commands.run(argv.map(quote).join(" "), { background: true, stdin: true, user: "root", timeoutMs, requestTimeoutMs: requestMs });
						try {
							if (stdin !== undefined) await sandbox.commands.sendStdin(handle.pid, new Uint8Array(Buffer.from(stdin, "utf8")), { requestTimeoutMs: requestMs });
							await sandbox.commands.closeStdin(handle.pid, { requestTimeoutMs: requestMs });
						} catch (error) {
							await handle.kill().catch(() => false);
							throw error;
						}
						try {
							const done = await handle.wait();
							return { exitCode: done.exitCode, output: `${done.stdout}${done.stderr}` };
						} catch (error) {
							const exited = error as Partial<E2BCommandResult> & { name?: string };
							if (exited?.name === "CommandExitError" && typeof exited.exitCode === "number") return { exitCode: exited.exitCode, output: `${exited.stdout ?? ""}${exited.stderr ?? ""}` };
							throw error;
						} finally {
							await handle.disconnect().catch(() => {});
						}
					},
					timeoutMs + CALL_SLACK_MS,
					signal,
				),
		};
	}

	/** The shared Archil steps (archilMount) through root, with the takeover of this provider's lower epochs. */
	#mountArchil(root: ArchilRoot, { mount, run, epoch }: { mount: ArchilMount; run: string; epoch: number }, signal?: AbortSignal): Promise<Result<void>> {
		return archilMount({ root, mount, releaseOlder: () => releaseOlder(this, run, epoch, signal ? { signal } : {}), timeoutMs: this.#timeouts.mountMs, ...(signal ? { signal } : {}) });
	}

	#daemonExpected(): DaemonExpected {
		const { kind, groups } = this.capabilities();
		return { version: VERSION, uid: this.#uid, gid: this.#gid, arch: ARCH, kind, groups };
	}

	#bounded(ms: number, signal?: AbortSignal): AbortSignal {
		return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
	}

	/** A foreground command as root; a non-zero exit is a result with its code, not an error (index.mjs:2642-2660). */
	async #run(sandbox: E2BSandbox, command: string, ms: number, signal?: AbortSignal): Promise<Result<E2BCommandResult>> {
		const ran = await call(
			"a command in the sandbox",
			async () => {
				try {
					return await sandbox.commands.run(command, { user: "root", timeoutMs: ms, requestTimeoutMs: ms, ...(signal ? { signal } : {}) });
				} catch (error) {
					const exited = error as Partial<E2BCommandResult> & { name?: string };
					if (exited?.name === "CommandExitError" && typeof exited.exitCode === "number") return { exitCode: exited.exitCode, stdout: exited.stdout ?? "", stderr: exited.stderr ?? "" };
					throw error;
				}
			},
			ms + CALL_SLACK_MS,
			signal,
		);
		return ran;
	}

	/** Every way a sandbox, as E2B reads it back, differs from what create asked for. Pure: no call. */
	#sandboxDrift(spec: ComputerSpec, info: E2BSandboxInfo, metadata: Record<string, string>): string[] {
		const found: string[] = [];
		const mismatch = (field: string, declared: unknown, actual: unknown) => found.push(`${field}: declared ${show(declared)}, read back ${show(actual)}`);
		// E2B reports the template's id, and its alias when it has one (index.mjs:5435-5437): a template asked for by an
		// alias E2B does not report back cannot be held to it, and its label (below) records what was asked.
		const alias = info.name;
		if (info.templateId !== spec.image && alias !== undefined && alias !== spec.image && !alias.startsWith(`${spec.image}:`)) {
			found.push(`template: declared ${show(spec.image)}, read back ${show(info.templateId)} (${alias})`);
		}
		for (const [key, value] of Object.entries(metadata)) if (info.metadata?.[key] !== value) mismatch(`label ${key}`, value, info.metadata?.[key]);
		const network = networkOf(info, this.#publicStream);
		// An Archil computer's vendor network is open, for root to reach Archil; its tools' none is read from inside.
		const vendor = spec.mount?.kind === "archil" ? "open" : (spec.network as NetworkPolicy);
		if (network !== vendor) found.push(`network: declared ${policyWords(vendor)}${spec.mount?.kind === "archil" ? " (E2B's, for root to reach Archil)" : ""}, read back ${policyWords(network)}`);
		if (info.lifecycle?.onTimeout !== undefined && info.lifecycle.onTimeout !== "kill") mismatch("lifecycle onTimeout", "kill", info.lifecycle.onTimeout);
		if (info.lifecycle?.autoResume === true) mismatch("lifecycle autoResume", false, true);
		if (info.state !== "running") mismatch("state", "running", info.state);
		const end = info.endAt instanceof Date ? info.endAt.getTime() : Number.NaN;
		const created = createdEnd(info);
		if (Number.isNaN(end) || created === undefined) found.push(`endAt: E2B reported ${show(info.endAt)} from a start of ${show(info.startedAt)}, so it might not end the computer`);
		else if (Math.abs(end - created) > END_SLACK_MS) found.push(`endAt: ${info.endAt.toISOString()} is not E2B's start plus the ${metadata[TIMEOUT_LABEL]} ms timeout create gave`);
		return found;
	}

	/**
	 * getInfo, bounded by requestMs; not_found for a sandbox E2B does not have. With until, a time a whole listing must
	 * end by, the read is bounded by what is left of it as well, its race included, and a timeout of a read whose bound
	 * was that remainder is marked listBound: the listing's deadline ended it, whatever Date.now() reads after.
	 */
	async #info(id: string, signal?: AbortSignal, until?: number): Promise<Result<E2BSandboxInfo> & ListBound> {
		const { requestMs } = this.#timeouts;
		const left = until === undefined ? undefined : Math.max(1, until - Date.now());
		const ms = left === undefined ? requestMs : Math.min(requestMs, left);
		const read = await call(`Sandbox.getInfo of ${id}`, () => this.#Sandbox.getInfo(id, this.#api(ms, signal)), left === undefined ? requestMs + CALL_SLACK_MS : left, signal);
		return boundBy(read, left, requestMs);
	}

	/** This provider's sandbox for ref, as E2B reads it, or why not. */
	async #own(ref: ComputerRef, signal?: AbortSignal): Promise<Result<E2BSandboxInfo>> {
		const found = await this.#info(ref.id, signal);
		if (!found.ok) return found.error.code === "not_found" ? fail("not_found", `no E2B computer is ${ref.name} (${ref.id})`) : found;
		if (!ours(found.value.metadata, ref.name)) return fail("not_found", `no E2B computer named ${ref.name} has the id ${ref.id}`);
		return found;
	}

	/**
	 * A connected Sandbox for envd's commands and files. connect would resume a paused sandbox, so the caller checks it
	 * runs first; its timeout is a little under what is left, and E2B moves a running sandbox's timer only to a longer
	 * one (index.d.mts:10250-10255), so connecting never moves the end.
	 */
	async #connected(info: E2BSandboxInfo, signal?: AbortSignal): Promise<Result<E2BSandbox>> {
		const { requestMs } = this.#timeouts;
		const left = info.endAt instanceof Date ? info.endAt.getTime() - Date.now() : 0;
		const timeoutMs = Math.max(1_000, Math.floor(left / 1000) * 1000 - 2_000);
		return call(`Sandbox.connect of ${info.sandboxId}`, () => this.#Sandbox.connect(info.sandboxId, { ...this.#api(requestMs, signal), timeoutMs }), requestMs + CALL_SLACK_MS, signal);
	}

	/** #open, tried again while the bridge finds no daemon listening, until hello or helloMs in all. */
	async #openWhenListening(sandbox: E2BSandbox, name: string, signal?: AbortSignal): Promise<Result<ComputerConnection>> {
		const until = Date.now() + this.#timeouts.helloMs;
		for (;;) {
			const opened = await this.#open(sandbox, name, signal, Math.max(1, until - Date.now()));
			if (opened.ok || !opened.notListening || signal?.aborted || Date.now() + LISTEN_RETRY_MS >= until) return opened;
			await pause(LISTEN_RETRY_MS, signal);
		}
	}

	/**
	 * One connection to the daemon, after hello, unchecked: `computerd stdio` as a background command as root, with stdin
	 * (index.mjs:5123-5146). No command timeout, so envd never kills it mid-connection (start.go:39-44); no retained
	 * output, so a long connection keeps no copy of its stdout (index.mjs:2708-2711, 5150-5153). Writes go one sendStdin at a time,
	 * in order; close kills the bridge.
	 */
	async #open(sandbox: E2BSandbox, name: string, signal?: AbortSignal, helloMs = this.#timeouts.helloMs): Promise<Result<ComputerConnection> & { notListening?: true }> {
		const { requestMs } = this.#timeouts;
		const what = `starting the daemon's stdio bridge in ${name}`;
		if (signal?.aborted) return fail("aborted", `${what} was aborted before it was called`);
		const readable = new PassThrough();
		let stderr = "";
		let starting: Promise<E2BCommandHandle>;
		try {
			starting = Promise.resolve(
				sandbox.commands.run(childCommands().stdio, {
					background: true,
					stdin: true,
					user: "root",
					timeoutMs: 0,
					requestTimeoutMs: requestMs,
					retainOutput: false,
					onStdout: (data) => {
						if (!readable.destroyed) readable.write(Buffer.from(data, "utf8"));
					},
					onStderr: (data) => {
						stderr = (stderr + data).slice(-4096);
					},
				}),
			);
		} catch (error) {
			return fail(codeOf(error), `${what} failed: ${words(error)}`);
		}
		const started = await race(starting, what, requestMs + CALL_SLACK_MS, signal);
		if (!started.ok) {
			// The bridge has no command timeout: one envd starts after this was given up on is killed as it lands.
			if (started.error.code === "timeout" || started.error.code === "aborted") {
				starting.then(
					(late) => void this.#endBridge(late),
					() => {},
				);
				return fail(started.error.code, `${started.error.message}; a bridge that starts after this is killed`);
			}
			return started;
		}
		const handle = started.value;
		// The bridge's end, for any reason, ends what the client reads.
		handle.wait().then(
			() => readable.end(),
			() => readable.end(),
		);
		const writable = new Writable({
			write(chunk: Buffer, _encoding, done) {
				sandbox.commands.sendStdin(handle.pid, new Uint8Array(chunk), { requestTimeoutMs: requestMs }).then(
					() => done(),
					(error: unknown) => done(error instanceof Error ? error : new Error(String(error))),
				);
			},
		});
		const client = new DaemonClient({ readable, writable });
		let closed: Promise<void> | undefined;
		const close = () =>
			(closed ??= (async () => {
				client.close();
				await this.#endBridge(handle);
			})());
		const hello = await client.call("hello", { client: `@parcha/agentrun-computer ${VERSION}` }, { signal: this.#bounded(helloMs, signal) });
		if (!hello.ok) {
			await close();
			if (signal?.aborted) return fail("aborted", `hello to the daemon in ${name} was aborted`);
			if (hello.error.code === "aborted") return fail("timeout", `the daemon in ${name} did not answer hello within ${seconds(helloMs)}`);
			if (hello.error.code !== "gone") return hello;
			return { ...fail("e2b", `cannot reach the daemon in ${name}: ${stderr.trim() || hello.error.message}`), notListening: true };
		}
		return ok({ client, hello: hello.value as HelloResult, close });
	}

	/** Kills a stdio bridge and lets go of its stream, each bounded and never thrown: a connection's close, or a late start. */
	async #endBridge(handle: E2BCommandHandle): Promise<void> {
		await call("the stdio bridge's kill", () => handle.kill(), this.#timeouts.requestMs).catch(() => {});
		await call("the stdio bridge's disconnect", () => handle.disconnect(), this.#timeouts.requestMs).catch(() => {});
	}

	/** `computerd probe` through the daemon, so it runs as the computer's own user. */
	async #probe(connection: ComputerConnection, name: string, signal?: AbortSignal): Promise<Result<ProbeReport>> {
		const { probeMs } = this.#timeouts;
		const argv = [DAEMON_IN_COMPUTER, "probe", ...this.#probeTargets.flatMap((target) => ["--connect", target])];
		const ran = await connection.client.call("exec.run", { argv, timeoutMs: probeMs }, { signal: this.#bounded(probeMs + CALL_SLACK_MS, signal) });
		if (!ran.ok) {
			if (signal?.aborted) return fail("aborted", `the probe in ${name} was aborted`);
			if (ran.error.code === "aborted") return fail("timeout", `the probe in ${name} did not answer within ${seconds(probeMs)}`);
			return fail(ran.error.code, `the probe in ${name} failed: ${ran.error.message}`);
		}
		const { exitCode, stdout, stderr, timedOut } = ran.value;
		if (timedOut) return fail("timeout", `the probe in ${name} did not end within ${seconds(probeMs)}`);
		if (exitCode !== 0) return fail("refused", `the probe in ${name} exited with ${exitCode}: ${Buffer.from(stderr, "base64").toString("utf8").trim().slice(0, 300)}`);
		const report = probeReportOf(stdout);
		return "not" in report ? fail("refused", `the probe in ${name} ${report.not}`) : ok(report);
	}

	static {
		diagnoseWith = (provider, image, signal) => provider.#diagnose(image, signal);
	}

	/**
	 * See diagnoseNetworkNone. Create is awaited, never raced by the signal (bounded by createMs), so a sandbox it makes is
	 * known by id; every step after it takes the signal; the kill and the wait for gone take none, bounded by goneMs.
	 */
	async #diagnose(image: string, signal?: AbortSignal): Promise<E2BNetworkDiagnosis> {
		const report: E2BNetworkDiagnosis = { template: image, released: { gone: true, words: "nothing was made" } };
		const spec: ComputerSpec = { image, lifetimeMs: DIAGNOSE_LIFETIME_MS, network: "none" };
		if (signal?.aborted) return { ...report, error: { code: "aborted", message: "the diagnostic was aborted before E2B was called" } };
		const launched = await this.#launch(spec);
		if (!launched.ok) {
			const madeNothing = ["refused", "invalid", "denied", "limit", "not_found"].includes(launched.error.code);
			return { ...report, error: launched.error, released: madeNothing ? report.released : { gone: false, words: launched.error.message } };
		}
		const { sandbox, ref, made } = launched.value;
		report.computer = ref;
		const prepared = signal?.aborted
			? fail("aborted", "the diagnostic was aborted")
			: await this.#prepare(spec, ref, sandbox, made, signal, {
					readBack: ({ allowInternetAccess, network }) => {
						report.readBack = { allowInternetAccess, allowPublicTraffic: network?.allowPublicTraffic, allowOut: network?.allowOut, denyOut: network?.denyOut };
					},
					inside: async (connection) => {
						const checked = await this.#checkInside(connection, ref.name, "none", true, signal);
						if (signal?.aborted) return fail("aborted", "the diagnostic was aborted");
						report.check = checked.ok ? "passed" : checked.error.message;
						if (checked.ok && checked.value.length > 0) report.notes = checked.value;
						const diagnosed = await this.#probeDiagnose(connection, ref.name, signal);
						if (!diagnosed.ok) return diagnosed;
						report.diagnosis = diagnosed.value;
						return ok(undefined);
					},
				});
		if (!prepared.ok) report.error = signal?.aborted ? { code: "aborted", message: `the diagnostic was aborted: ${prepared.error.message}` } : prepared.error;
		const killed = await this.#kill(ref.id);
		const gone = killed.ok ? await this.#settle(ref) : killed;
		report.released = gone.ok ? { gone: true, words: `${ref.name} was killed, and E2B reads it gone` } : { gone: false, words: `${ref.name}: ${gone.error.message}; E2B ends it at its 10-minute timeout` };
		return report;
	}

	/** `computerd probe --diagnose` through the daemon, as the computer's own user: its JSON line, or why not. */
	async #probeDiagnose(connection: ComputerConnection, name: string, signal?: AbortSignal): Promise<Result<unknown>> {
		const { probeMs } = this.#timeouts;
		const what = `probe --diagnose in ${name}`;
		const ran = await connection.client.call("exec.run", { argv: [DAEMON_IN_COMPUTER, "probe", "--diagnose"], timeoutMs: probeMs }, { signal: this.#bounded(probeMs + CALL_SLACK_MS, signal) });
		if (!ran.ok) {
			if (signal?.aborted) return fail("aborted", `${what} was aborted`);
			return fail(ran.error.code === "aborted" ? "timeout" : ran.error.code, `${what} failed: ${ran.error.message}`);
		}
		const { exitCode, stdout, stderr, timedOut } = ran.value;
		if (timedOut) return fail("timeout", `${what} did not end within ${seconds(probeMs)}`);
		if (exitCode !== 0) return fail("refused", `${what} exited with ${exitCode}: ${Buffer.from(stderr, "base64").toString("utf8").trim().slice(0, 300)}`);
		try {
			const value = JSON.parse(Buffer.from(stdout, "base64").toString("utf8")) as { verdict?: unknown; results?: unknown } | null;
			if (typeof value?.verdict === "string" && Array.isArray(value.results)) return ok(value);
		} catch {
			// Not the diagnosis: below.
		}
		return fail("refused", `${what} wrote what is not its report`);
	}

	async connect(ref: ComputerRef): Promise<Result<ComputerConnection>> {
		const problem = refProblem(ref);
		if (problem) return fail("invalid", problem);
		const found = await this.#own(ref);
		if (!found.ok) return found;
		if (found.value.state !== "running") return fail("refused", `${ref.name} is ${found.value.state}, not running: its daemon does not run, and a connect would resume it`);
		const sandbox = await this.#connected(found.value);
		if (!sandbox.ok) return sandbox;
		const opened = await this.#open(sandbox.value, ref.name);
		if (!opened.ok) return opened;
		const { kind, groups } = this.capabilities();
		const drifted = helloDrift(opened.value.hello, { version: VERSION, kind, groups, arch: ARCH });
		// An Archil computer's client syncs the run's folder after every call that may change it, before it answers.
		if (drifted.length === 0) return recordedArchil(found.value.metadata) === undefined ? opened : ok({ ...opened.value, client: syncingClient(opened.value.client) });
		await opened.value.close();
		return fail("refused", `the daemon in ${ref.name} does not match this provider: ${drifted.join("; ")}`);
	}

	async attach(ref: { id: string } | { labels: Record<string, string> }, { signal }: CallContext = {}): Promise<Result<AttachedComputer>> {
		const given = (typeof ref === "object" && ref !== null ? ref : {}) as { id?: unknown; labels?: unknown };
		if ((given.id === undefined) === (given.labels === undefined)) return fail("invalid", "attach takes { id } or { labels }, one of them");
		if (given.id !== undefined) {
			const id = given.id;
			if (typeof id !== "string" || !SANDBOX_ID.test(id)) return fail("invalid", `${String(id)} is not an E2B sandbox id`);
			const found = await this.#info(id, signal);
			if (!found.ok) return found.error.code === "not_found" ? fail("not_found", `no E2B computer has the id ${id}`) : found;
			if (!ours(found.value.metadata)) return fail("not_found", `no E2B computer has the id ${id}`);
			return this.#attached(found.value, signal);
		}
		const problem = filterProblem(given.labels);
		if (problem) return fail("invalid", problem);
		const labels = given.labels as Record<string, string>;
		if (Object.keys(labels).length === 0) return fail("invalid", "attach by labels needs at least one label");
		const listed = await this.list(labels, { signal });
		if (!listed.ok) return listed;
		const words = JSON.stringify(labels);
		if (listed.value.length === 0) return fail("not_found", `no E2B computer has the labels ${words}`);
		if (listed.value.length > 1) return fail("invalid", `${listed.value.length} computers match the labels ${words}: ${listed.value.map((info) => info.ref.name).join(", ")}`);
		const found = await this.#own((listed.value[0] as ComputerInfo).ref, signal);
		if (!found.ok) return found;
		return this.#attached(found.value, signal);
	}

	/**
	 * The drift check of a computer attach did not make: its spec read back from E2B and held to what check() allows,
	 * and, when it runs, its daemon, as at create. One that drifts is refused and left as it is.
	 */
	async #attached(info: E2BSandboxInfo, signal?: AbortSignal): Promise<Result<AttachedComputer>> {
		const name = info.metadata[NAME_LABEL] as string;
		const ref = { id: info.sandboxId, name };
		const found: string[] = [];
		const deadline = deadlineOf(info);
		if (deadline === undefined) found.push(`deadline: the label ${DEADLINE_LABEL} reads ${show(info.metadata[DEADLINE_LABEL])}, not the ISO time create writes`);
		const archil = recordedArchil(info.metadata);
		const network = this.#toolsNetwork(info);
		if (typeof network === "object") found.push(`network: ${policyWords(network)}, which this provider never makes`);
		const labels = Object.fromEntries(Object.entries(info.metadata).filter(([key]) => key !== COMPUTER_LABEL && !key.startsWith(`${COMPUTER_LABEL}.`) && key !== ARCHIL_MOUNT_LABEL));
		const image = info.metadata[IMAGE_LABEL] ?? info.templateId;
		const spec = { image, lifetimeMs: 1, network: typeof network === "object" ? "open" : network, labels } as ComputerSpec;
		found.push(...this.check(spec).map(({ field, message }) => `${field}: ${message}, read back from the computer`));
		let kind: AttachedComputer["spec"]["kind"];
		let notes: string[] = [];
		let mount: MountReadBack | undefined;
		if (info.state === "running") {
			const sandbox = await this.#connected(info, signal);
			if (!sandbox.ok) return sandbox;
			const opened = await this.#open(sandbox.value, name, signal);
			if (!opened.ok) return opened;
			try {
				const inside = await this.#checkInside(opened.value, name, network, false, signal, archil);
				if (!inside.ok && inside.error.code !== "refused") return inside;
				if (!inside.ok) found.push(inside.error.message.replace(/^it did not match its spec: /, ""));
				else {
					notes = inside.value;
					mount = inside.mount;
				}
			} finally {
				await opened.value.close();
			}
			kind = opened.value.hello.kind;
		} else if (archil !== undefined) found.push(`mount: ${name} is ${info.state}, so its mount cannot be read back from inside`);
		if (found.length > 0) return fail("refused", `the computer ${name} does not match this provider, so attach refuses it and it is left as it is: ${found.join("; ")}`);
		return ok({
			...ref,
			spec: {
				image,
				...(info.templateId !== image ? { snapshot: info.templateId } : {}),
				user: `${this.#uid}:${this.#gid}`,
				network: spec.network,
				workdir: WORK,
				...(deadline === undefined ? {} : { deadline }),
				...(kind === undefined ? {} : { kind }),
				...(mount === undefined ? {} : { mount }),
			},
			...(notes.length > 0 ? { notes } : {}),
		});
	}

	/**
	 * Every sandbox E2B lists with these metadata pairs (running and paused, index.d.mts:10289), all pages, within listMs,
	 * or by until when the caller's own bound is given; then a page's timeout whose bound was what was left of it is
	 * marked listBound.
	 */
	async #listPages(metadata: Record<string, string>, signal?: AbortSignal, given?: number): Promise<Result<E2BListedSandbox[]> & ListBound> {
		const { requestMs } = this.#timeouts;
		const until = given ?? Date.now() + this.#timeouts.listMs;
		let paginator: E2BPaginator;
		try {
			paginator = this.#Sandbox.list({ ...this.#connection, requestTimeoutMs: requestMs, query: { metadata }, limit: PAGE });
		} catch (error) {
			return fail(codeOf(error), `Sandbox.list failed: ${words(error)}`);
		}
		const found = new Map<string, E2BListedSandbox>();
		for (let page = 0; paginator.hasNext; page++) {
			if (page >= MAX_PAGES) return fail("e2b", `Sandbox.list ran past ${MAX_PAGES} pages`);
			const left = Math.max(1, until - Date.now());
			const items = await call("Sandbox.list", () => paginator.nextItems({ requestTimeoutMs: Math.min(requestMs, left), ...(signal ? { signal } : {}) }), left, signal);
			if (!items.ok) return boundBy(items, given === undefined ? undefined : left, requestMs);
			if (!Array.isArray(items.value)) return fail("e2b", "Sandbox.list: a page that is not a list of sandboxes");
			for (const sb of items.value) if (typeof sb?.sandboxId === "string") found.set(sb.sandboxId, sb);
		}
		return ok([...found.values()]);
	}

	/**
	 * Every computer this provider made that carries all of these labels, running or paused (stopped), each one's
	 * network read back by getInfo, since a listing does not carry it. One deadline, listMs from the call, bounds every
	 * page and every read-back.
	 */
	async list(labels: Record<string, string>, { signal }: CallContext = {}): Promise<Result<ComputerInfo[]>> {
		const problem = filterProblem(labels);
		if (problem) return fail("invalid", problem);
		const { listMs } = this.#timeouts;
		const until = Date.now() + listMs;
		const late = (why: string) => fail("timeout", `list did not finish within ${seconds(listMs)}: ${why}`);
		// A call the listing's deadline bounded (listBound) failed because that deadline passed, whichever of its timer and
		// Date.now() reads first; one bounded by its own requestMs, with time left, keeps its own words.
		const failed = ({ error, listBound }: { error: ComputerError } & ListBound) =>
			error.code === "timeout" && (listBound === true || Date.now() >= until) ? late(error.message) : fail(error.code, error.message);
		const listed = await this.#listPages({ ...labels, [COMPUTER_LABEL]: "1" }, signal, until);
		if (!listed.ok) return failed(listed);
		const infos: ComputerInfo[] = [];
		for (const item of listed.value) {
			if (!ours(item.metadata) || !Object.entries(labels).every(([key, value]) => item.metadata[key] === value)) continue;
			if (Date.now() >= until) return late(`${infos.length} computers were read back, ${item.sandboxId} and any after it were not`);
			const read = await this.#info(item.sandboxId, signal, until);
			if (!read.ok) {
				if (read.error.code === "not_found") continue;
				return failed(read);
			}
			const info = read.value;
			if (info.state !== "running" && info.state !== "paused") continue;
			// list runs nothing in a computer: an Archil computer's mount is the one its label records, under its epoch label.
			const archil = recordedArchil(info.metadata);
			infos.push({
				ref: { id: info.sandboxId, name: info.metadata[NAME_LABEL] as string },
				labels: { ...info.metadata },
				deadline: deadlineOf(info),
				state: info.state === "running" ? "running" : "stopped",
				network: this.#toolsNetwork(info),
				...(archil === undefined ? {} : { mount: archil.expected }),
			});
		}
		return ok(infos);
	}

	/** For the sweep: every sandbox E2B lists with agentrun.computer=1, whatever its name, as E2B reports it. */
	async listLabelled({ signal }: CallContext = {}): Promise<Result<Array<{ id: string; state: string }>>> {
		const listed = await this.#listPages({ [COMPUTER_LABEL]: "1" }, signal);
		return listed.ok ? ok(listed.value.map((sb) => ({ id: sb.sandboxId, state: sb.state }))) : listed;
	}

	/** For the sweep: whether E2B still has a sandbox, read once by getInfo; not_found is gone. */
	async probeGone(id: string, { signal }: CallContext = {}): Promise<Result<{ gone: boolean; state?: string }>> {
		if (typeof id !== "string" || !SANDBOX_ID.test(id)) return fail("invalid", `${String(id)} is not an E2B sandbox id`);
		const read = await this.#info(id, signal);
		if (!read.ok) return read.error.code === "not_found" ? ok({ gone: true }) : read;
		return ok({ gone: read.value.state !== "running" && read.value.state !== "paused", state: read.value.state });
	}

	/** For the sweep: Sandbox.kill of any sandbox the label query listed. Not found is done. */
	killById(id: string): Promise<Result<void>> {
		if (typeof id !== "string" || !SANDBOX_ID.test(id)) return Promise.resolve(fail("invalid", `${String(id)} is not an E2B sandbox id`));
		return this.#kill(id);
	}

	/** E2B reads the policy back (getInfo). A change is refused: the provider fixes the network at create. */
	async network(ref: ComputerRef, policy?: NetworkSpec, { signal }: CallContext = {}): Promise<Result<NetworkPolicy>> {
		const problem = refProblem(ref);
		if (problem) return fail("invalid", problem);
		if (policy !== undefined && policy !== "none") {
			const wider = policy === "open" || (typeof policy === "object" && policy !== null && "allow" in policy);
			return fail("refused", wider ? `${OWN_NETWORK_ONLY}; ${FIXED}` : `${FIXED}; a network is "none"`);
		}
		const found = await this.#own(ref, signal);
		if (!found.ok) return found;
		let read = this.#toolsNetwork(found.value);
		// An Archil computer's E2B network is root's: its tools' none is read from inside, as the tool user: the daemon's own
		// network namespace holds lo alone (its /proc/self/net/dev), and no probe target answers.
		if (read === "none" && recordedArchil(found.value.metadata) !== undefined && found.value.state === "running") {
			const sandbox = await this.#connected(found.value, signal);
			const opened = sandbox.ok ? await this.#open(sandbox.value, ref.name, signal) : sandbox;
			if (!opened.ok) return opened;
			try {
				const net = await opened.value.client.call("files.read", { path: "/proc/self/net/dev" }, { signal: this.#bounded(this.#timeouts.helloMs, signal) });
				if (!net.ok) return fail(net.error.code, `reading the daemon's /proc/self/net/dev in ${ref.name}: ${net.error.message}`);
				const drift = ownNetworkDrift(netDevInterfaces(Buffer.from(net.value.data, "base64").toString("utf8")));
				if (drift.length > 0) read = { other: drift.join("; ") };
				const probe = await this.#probe(opened.value, ref.name, signal);
				if (!probe.ok) return probe;
				if (probe.value.reached.length > 0) read = { other: `its tools' network was created none, yet from inside an answer came back from ${probe.value.reached.join(", ")}` };
			} finally {
				await opened.value.close();
			}
		}
		if (policy === undefined || policy === read) return ok(read);
		return fail("refused", `${FIXED}: ${ref.name} reads back network ${policyWords(read)}, not ${policy}`);
	}

	/**
	 * The tools' network as E2B's policy shows it: E2B's own, except for an Archil computer, whose open E2B network is
	 * root's, to reach Archil: its tools' network is init's own, none, which network() and attach read from inside.
	 */
	#toolsNetwork(info: E2BSandboxInfo): NetworkPolicy {
		const vendor = networkOf(info, this.#publicStream);
		if (recordedArchil(info.metadata) === undefined) return vendor;
		if (vendor === "open") return "none";
		return { other: `an Archil computer whose E2B network reads ${policyWords(vendor)}, not the open one create makes for root to reach Archil` };
	}

	/**
	 * Moves E2B's timer to now + ttlMs (setTimeout, index.mjs:5529-5541), then init's own deadline to the end E2B reads
	 * back, and returns the deadline init took; never earlier than the current end, never past create's time plus the
	 * cap, which init was given as its maximum. There is no label to move: E2B has no call that changes metadata, and
	 * list() reads the vendor's end. A provider runs one extend of a computer at a time, each reading the deadline the one
	 * before it left, so a slow, shorter extend never pulls E2B's timer under a longer one's.
	 */
	async extend(ref: ComputerRef, ttlMs: number, { signal }: CallContext = {}): Promise<Result<{ deadline: Date }>> {
		const problem = refProblem(ref);
		if (problem) return fail("invalid", problem);
		if (!isWhole(ttlMs) || ttlMs <= 0) return fail("invalid", "extend takes ttlMs, a whole number of milliseconds above 0");
		const before = this.#extending.get(ref.id) ?? Promise.resolve();
		const mine = before.then(() => this.#extend(ref, ttlMs, signal));
		const done = mine.then(
			() => {},
			() => {},
		);
		this.#extending.set(ref.id, done);
		try {
			return await mine;
		} finally {
			if (this.#extending.get(ref.id) === done) this.#extending.delete(ref.id);
		}
	}

	/** One extend, run when the one before it on the same computer has ended: see extend. */
	async #extend(ref: ComputerRef, ttlMs: number, signal?: AbortSignal): Promise<Result<{ deadline: Date }>> {
		const found = await this.#own(ref, signal);
		if (!found.ok) return found;
		const info = found.value;
		if (info.state !== "running") return fail("refused", `${ref.name} is ${info.state}, not running`);
		const most = isoOf(info.metadata[MAX_LABEL]);
		if (most === undefined) return fail("refused", `${ref.name}'s label ${MAX_LABEL} reads ${show(info.metadata[MAX_LABEL])}, so the most it may live is unknown`);
		const current = deadlineOf(info) ?? info.endAt;
		const now = Date.now();
		const target = now + ttlMs;
		if (target > most.getTime()) {
			return fail("limit", `${new Date(target).toISOString()} is past ${most.toISOString()}, the most this computer may live: create's time plus this provider's ${seconds(this.#maxLifetimeMs)} cap`);
		}
		if (target <= current.getTime()) return ok({ deadline: current });
		// E2B takes whole seconds (index.mjs:502-504): up to clear create's end, so list() reads the move (deadlineOf), and
		// down at the most this computer may live, so E2B's timer never passes it by this machine's clock.
		const created = createdEnd(info);
		const want = created === undefined ? target : Math.max(target, clearOf(created));
		const timerMs = Math.min(Math.ceil((want - now) / 1000) * 1000, Math.floor((most.getTime() - now) / 1000) * 1000);
		// Rounded down at the cap, the timer may end before the deadline now held, init's or E2B's own end: setTimeout
		// would then shorten the computer's life, and init refuses to move back. Nothing moves.
		const vendorEnd = info.endAt instanceof Date ? info.endAt.getTime() : Number.NaN;
		const held = Number.isNaN(vendorEnd) ? current.getTime() : Math.max(current.getTime(), vendorEnd);
		if (now + timerMs < held) {
			return fail(
				"limit",
				`no whole number of seconds E2B takes moves ${ref.name}'s end from ${new Date(held).toISOString()} to ${new Date(target).toISOString()} without passing ${most.toISOString()}, the most this computer may live; nothing moved`,
			);
		}
		if (created !== undefined && now + timerMs < clearOf(created)) {
			return fail(
				"limit",
				`${new Date(target).toISOString()} is within E2B's rounding of the end create gave ${ref.name}, and moving E2B's end clear of it would pass ${most.toISOString()}, the most this computer may live`,
			);
		}
		const { requestMs } = this.#timeouts;
		const moved = await call(`Sandbox.setTimeout of ${ref.name}`, () => this.#Sandbox.setTimeout(ref.id, timerMs, this.#api(requestMs, signal)), requestMs + CALL_SLACK_MS, signal);
		if (!moved.ok) return fail(moved.error.code, `E2B's timer did not move, so nothing did: ${moved.error.message}`);
		const after = await this.#info(ref.id, signal);
		if (!after.ok) return fail(after.error.code, `E2B's timer was asked to move, and reading it back failed: ${after.error.message}; init's deadline did not move`);
		const end = after.value.endAt;
		const sandbox = await this.#connected(after.value, signal);
		const opened = sandbox.ok ? await this.#open(sandbox.value, ref.name, signal) : sandbox;
		if (!opened.ok) return fail(opened.error.code, `E2B's timer moved to ${end.toISOString()}, and init's deadline did not: ${opened.error.message}`);
		let took: Date;
		try {
			// E2B's end is its clock, and the setTimeout's own transit adds to it: init's never goes past the maximum it was given.
			const at = new Date(Math.min(end.getTime(), most.getTime())).toISOString();
			const extended = await opened.value.client.call("deadline.extend", { at }, { signal: this.#bounded(this.#timeouts.helloMs, signal) });
			if (!extended.ok) return fail(extended.error.code, `E2B's timer moved to ${end.toISOString()}, and init's deadline did not: ${extended.error.message}`);
			const answered = Date.parse(extended.value.at);
			took = new Date(Number.isNaN(answered) ? at : answered);
		} finally {
			await opened.value.close();
		}
		return ok({ deadline: took });
	}

	/**
	 * delete reads the sandbox back to check it is this provider's, then kills it, both never signalled, so a release
	 * after an abort, or one aborted during the read, still sends the kill; it is idempotent: one E2B no longer has is ok.
	 * E2B answers a kill before the sandbox is gone, so release then waits (#settle) until E2B reads it gone and no longer
	 * lists it, within goneMs and the caller's signal, the one step the signal ends. A running Archil computer lets go of
	 * the run's folder first (archilRelease: the final sync through computerd, then checkin as root); the kill runs
	 * whatever that answers. A folder not let go cleanly loses nothing (every call that changed it synced, and the next
	 * claim revokes the hold), so it is said through onNote, and the release succeeds once the sandbox is gone.
	 */
	async release(ref: ComputerRef, how: "stop" | "delete", { signal }: CallContext = {}): Promise<Result<void>> {
		const problem = refProblem(ref);
		if (problem) return fail("invalid", problem);
		if (how !== "stop" && how !== "delete") return fail("invalid", `release is "stop" or "delete", not ${String(how)}`);
		if (how === "stop") return fail("unsupported", STOP);
		const found = await this.#info(ref.id);
		if (!found.ok) return found.error.code === "not_found" ? ok(undefined) : found;
		if (!ours(found.value.metadata, ref.name)) return fail("not_found", `no E2B computer is ${ref.name} (${ref.id}): the sandbox is not this provider's, so it is left as it is`);
		const letGo = recordedArchil(found.value.metadata) !== undefined && found.value.state === "running" ? await this.#letGo(found.value, ref.name, signal) : ok(undefined);
		const killed = await this.#kill(ref.id);
		const gone = killed.ok ? await this.#settle(ref, signal) : killed;
		if (letGo.ok) return gone;
		if (!gone.ok) return fail(gone.error.code, `${gone.error.message}; and ${letGo.error.message}`);
		this.#onNote?.({ computer: ref.name, note: `${ref.name} was killed, and ${letGo.error.message}` });
		return gone;
	}

	/** A running Archil computer's folder let go: the final sync through a connection when it answers, then checkin as root. */
	async #letGo(info: E2BSandboxInfo, name: string, signal?: AbortSignal): Promise<Result<void>> {
		const sandbox = await this.#connected(info, signal);
		if (!sandbox.ok) return fail(sandbox.error.code, `the run's folder was not let go: ${sandbox.error.message}`);
		const opened = await this.#open(sandbox.value, name, signal);
		try {
			return await archilRelease({ root: this.#root(sandbox.value, name), client: opened.ok ? opened.value.client : undefined, timeoutMs: this.#timeouts.mountMs, ...(signal ? { signal } : {}) });
		} finally {
			if (opened.ok) await opened.value.close();
		}
	}

	/**
	 * Waits, through waitUntil, until E2B reads the sandbox gone (getInfo answers not found, or a state that is neither
	 * running nor paused) and its label listing no longer shows it, twice running. Pauses double from pollMs to 5 s,
	 * bounded by goneMs and the caller's signal; a failed read ends the wait with that error.
	 */
	async #settle(ref: ComputerRef, signal?: AbortSignal): Promise<Result<void>> {
		type Read = { failed: Result<never> } | { settled: true } | { last: string };
		let agreed = 0;
		let last = "unread";
		const read = async (readSignal: AbortSignal): Promise<Read> => {
			const got = await this.#info(ref.id, readSignal);
			if (!got.ok && got.error.code !== "not_found") {
				if (got.error.code === "aborted") return { last };
				return { failed: fail(got.error.code, `release of ${ref.name}: reading it back failed (${got.error.message}); it last read ${last}`) };
			}
			const state = got.ok ? got.value.state : undefined;
			last = state ?? "gone (not found)";
			if (state === "running" || state === "paused") {
				agreed = 0;
				return { last };
			}
			const listed = await this.#listPages({ [COMPUTER_LABEL]: "1", [NAME_LABEL]: ref.name }, readSignal);
			if (!listed.ok) {
				if (listed.error.code === "aborted") return { last };
				return { failed: fail(listed.error.code, `release of ${ref.name}: the listing failed (${listed.error.message}); it last read ${last}`) };
			}
			if (listed.value.some((sb) => sb.sandboxId === ref.id)) {
				agreed = 0;
				last = `${last}, still listed`;
				return { last };
			}
			return ++agreed >= LISTED_ROUNDS ? { settled: true } : { last };
		};
		const { pollMs, goneMs } = this.#timeouts;
		const waited = await waitUntil(read, (state) => !("last" in state), {
			boundMs: goneMs,
			...(signal ? { signal } : {}),
			minMs: Math.min(pollMs, RELEASE_POLL_MAX_MS),
			maxMs: RELEASE_POLL_MAX_MS,
			what: `${ref.name} to be gone after its kill`,
			describe: (state) => ("last" in state ? `E2B read it ${state.last}` : "done"),
		});
		if (!waited.ok) return waited;
		return "failed" in waited.value ? waited.value.failed : ok(undefined);
	}

	/** Create waits until the listing shows the new computer, twice running, so list() shows it once create returns. */
	async #waitListed(ref: ComputerRef, signal?: AbortSignal): Promise<Result<void>> {
		const until = Date.now() + this.#timeouts.listedMs;
		for (let hits = 0; ; ) {
			const listed = await this.#listPages({ [COMPUTER_LABEL]: "1", [NAME_LABEL]: ref.name }, signal);
			if (!listed.ok) return listed;
			hits = listed.value.some((sb) => sb.sandboxId === ref.id) ? hits + 1 : 0;
			if (hits >= LISTED_ROUNDS) return ok(undefined);
			if (Date.now() >= until) return fail("timeout", `the computer was not listed within ${seconds(this.#timeouts.listedMs)} of its creation`);
			await pause(Math.min(LISTED_POLL_MS, LISTED_POLL_MAX_MS, this.#timeouts.pollMs), signal);
			if (signal?.aborted) return fail("aborted", "create was aborted while it waited for the listing");
		}
	}

	/**
	 * The template's VNC stream: x11vnc on the display, on loopback only, with a fresh password from a file the
	 * computer's user alone reads, and noVNC in front of it (as @e2b/desktop@2.5.0 starts them, dist/index.mjs:463-506),
	 * both started through the daemon, so they run as the computer's user and end with it. Each call starts them anew, so
	 * a URL given before stops working. The URL carries the password (noVNC's `password` parameter): it is a bearer
	 * secret, never logged and never in an error.
	 */
	async #stream(ref: ComputerRef, { viewOnly = false }: { viewOnly?: boolean } = {}, { signal }: CallContext = {}): Promise<Result<{ url: string }>> {
		const problem = refProblem(ref);
		if (problem) return fail("invalid", problem);
		const desktop = this.#desktop as Required<DesktopOptions>;
		const found = await this.#own(ref, signal);
		if (!found.ok) return found;
		if (found.value.state !== "running") return fail("refused", `${ref.name} is ${found.value.state}, not running`);
		const sandbox = await this.#connected(found.value, signal);
		if (!sandbox.ok) return sandbox;
		const opened = await this.#open(sandbox.value, ref.name, signal);
		if (!opened.ok) return opened;
		const { client } = opened.value;
		const bound = () => this.#bounded(this.#timeouts.helloMs, signal);
		// RFB's password check uses its first 8 characters only (VNC authentication is DES keyed by them).
		const password = Array.from({ length: 8 }, () => ALNUM[randomInt(ALNUM.length)]).join("");
		try {
			// Every page of the process table: the old servers may be past the first.
			const listed = await listProcesses(client, { signal: bound() });
			if (!listed.ok) return fail(listed.error.code, `listing the computer's processes: ${listed.error.message}`);
			const old = listed.value.filter((one) => one.running && STREAM_PROGRAMS.includes(one.argv[0] as string));
			for (const one of old) {
				const killed = await client.call("process.signal", { id: one.id, signal: "KILL" }, { signal: bound() });
				if (!killed.ok) return fail(killed.error.code, `stopping the old stream's ${one.argv[0]} (${one.id}): ${killed.error.message}`);
			}
			// A signal is only sent: an old server holds its port until it has ended, and a new one could not bind it.
			for (const one of old) {
				const ended = await client.call("process.wait", { id: one.id, timeoutMs: STREAM_STOP_MS }, { signal: this.#bounded(STREAM_STOP_MS + CALL_SLACK_MS, signal) });
				if (!ended.ok) return fail(ended.error.code, `waiting for the old stream's ${one.argv[0]} (${one.id}) to end: ${ended.error.message}`);
				if (ended.value.running) return fail("timeout", `the old stream's ${one.argv[0]} (${one.id}) did not end within ${seconds(STREAM_STOP_MS)} of its kill`);
			}
			const written = await client.call("files.write", { path: STREAM_PASSWORD_FILE, data: Buffer.from(`${password}\n`).toString("base64"), mode: 0o600 }, { signal: bound() });
			if (!written.ok) return fail(written.error.code, `writing the stream's password file: ${written.error.message}`);
			// x11vnc listens on the computer's own loopback, IPv4 alone, and noVNC reaches it there.
			const listen = "localhost"; // key-gate: loopback-rule the VNC server listens inside the computer only
			const vnc = ["x11vnc", "-display", desktop.display, "-forever", "-shared", "-listen", listen, "-noipv6", "-rfbport", String(VNC_PORT), "-passwdfile", STREAM_PASSWORD_FILE, ...(viewOnly ? ["-viewonly"] : [])];
			const novnc = [NOVNC, "--vnc", `${listen}:${VNC_PORT}`, "--listen", String(STREAM_PORT), "--web", "/opt/noVNC"];
			const servers: Array<{ id: string; program: string }> = [];
			for (const argv of [vnc, novnc]) {
				const started = await client.call("process.start", { argv, cwd: "/opt/noVNC/utils" }, { signal: bound() });
				if (!started.ok) return fail(started.error.code, `starting ${argv[0]}: ${started.error.message}`);
				servers.push({ id: started.value.id, program: argv[0] as string });
			}
			// Ready is both new servers running and both ports listening: with the old servers ended, the listeners are theirs.
			const until = Date.now() + STREAM_WAIT_MS;
			const ports = `netstat -tln 2>/dev/null | grep -q ':${VNC_PORT} ' && netstat -tln 2>/dev/null | grep -q ':${STREAM_PORT} '`;
			for (;;) {
				const up = await client.call("exec.run", { argv: ["sh", "-c", ports], timeoutMs: 5_000 }, { signal: bound() });
				for (const server of servers) {
					const state = await client.call("process.wait", { id: server.id, timeoutMs: 0 }, { signal: bound() });
					if (!state.ok) return fail(state.error.code, `reading the new ${server.program} (${server.id}): ${state.error.message}`);
					// Awaited here, inside the try: the finally closes the connection its read goes over.
					if (!state.value.running) return await this.#serverEnded(client, server, state.value, bound());
				}
				if (up.ok && up.value.exitCode === 0) break;
				if (Date.now() >= until) return fail("timeout", `the stream did not listen on ports ${VNC_PORT} and ${STREAM_PORT} within ${seconds(STREAM_WAIT_MS)}`);
				await pause(250, signal);
				if (signal?.aborted) return fail("aborted", "stream was aborted");
			}
		} finally {
			await opened.value.close();
		}
		const url = new URL(`https://${sandbox.value.getHost(STREAM_PORT)}/vnc.html`);
		url.searchParams.set("autoconnect", "true");
		url.searchParams.set("resize", "scale");
		if (viewOnly) url.searchParams.set("view_only", "true");
		url.searchParams.set("password", password);
		return ok({ url: url.href });
	}

	/** A new stream server that ended before the stream was up, in words, with its last lines of stderr. */
	async #serverEnded(client: ComputerConnection["client"], server: { id: string; program: string }, exit: ProcessExit, signal: AbortSignal): Promise<Result<never>> {
		const read = await client.call("process.read", { id: server.id, stream: "stderr", offset: 0 }, { signal });
		const said = read.ok ? Buffer.from(read.value.data, "base64").toString("utf8").trim().split("\n").slice(-3).join("; ") : "";
		const how = exit.signal ? `signal ${exit.signal}` : `exit code ${exit.exitCode}`;
		return fail("e2b", `the stream's new ${server.program} ended with ${how} before the stream was up${said ? `: ${said}` : ""}`);
	}
}
