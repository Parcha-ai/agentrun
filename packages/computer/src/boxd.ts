// The boxd provisioner: boxd machines (KVM microVMs, Ubuntu 24.04), kind linux or kind desktop, every call through the
// host's own boxd TypeScript SDK (the `@boxd-sh/sdk` package), of which this package names only the slice it uses
// (BoxdClientClass) and imports nothing at load. boxd's own agent runs every command in a machine, so computerd is a
// child: its upload goes through the SDK's file upload, init starts as a detached root command, dropped to a user with
// no capabilities, and connect() carries stdio over one streamed exec's stdin and stdout. Every SDK fact used here is
// from @boxd-sh/sdk@0.3.1 (dist/*.d.ts), cited in the README's boxd section.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { childCommands, type DaemonExpected, daemonDrift, shellCommand } from "./hosted/scripts.js";
import { DaemonClient } from "./client.js";
import { CreateRequests, endedWords, labelsDiffer, otherSpecWords } from "./create-requests.js";
import { BOXD, BOXD_DEFAULT_IMAGE } from "./descriptors/boxd.js";
import { DESKTOP_GROUPS, type DesktopOptions, desktopOf, startDisplay } from "./desktop.js";
import { COMPUTER_LABEL, DAEMON_IN_COMPUTER, DEADLINE_LABEL, helloDrift, type ProbeReport, probeNetworkDrift, probeNotes, probeReportOf, WORK } from "./drift.js";
import { OWN_NETWORK_ONLY, TOOL_USER } from "./isolation.js";
import type { KindCapabilities } from "./kinds.js";
import type { MountKind } from "./mount.js";
import type { HelloResult } from "./protocol.js";
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
	computerNameFor,
	type NetworkPolicy,
	type NetworkSpec,
	type Refusal,
	type ReleaseHow,
	runLifetimeMs,
} from "./provider.js";
import { type ComputerErrorCode, failFor, ok, type Result, vendorFail } from "./result.js";
import { daemonWatch, type ScreenWatch, type ScreenWatchHandlers, type WatchOptions } from "./screen-watch.js";
import { countTested } from "./test-connection.js";
import { waitUntil } from "./wait.js";

/** This module's failures: one with code vendor names boxd. */
const fail = failFor("boxd");

/** A machine as the SDK reports it (Machine, models.d.ts), as far as this provider reads it. */
export interface BoxdMachine {
	id: string;
	name: string;
	/** pending, starting, running, suspended, hibernated, stopped, failed, destroyed or migrating. */
	status: string;
	labels: Record<string, string>;
	/** The egress allowlist: [] is unrestricted, ["none"] is nothing reachable. */
	egressAllow: string[];
	/** Seconds of idleness before standby, hibernation and destruction; 0 is never. */
	idle: { suspendAfter: number; hibernateAfter: number; destroyAfter: number };
	resources: { vcpu: number; memoryBytes: number };
	networking: { isolated: boolean };
	org: { id: string; name: string } | null;
	shared?: boolean;
	region?: string;
	/** When boxd deletes the machine by itself; null when no timer is set. */
	deleteAt: Date | null;
	/** Where the machine came from: a snapshot's name for one restored from it; null for a fresh machine. */
	source?: { kind: string; name: string } | null;
}

/** machines.create's options as the provider gives them (MachineCreateFromImageParams, MachineCreateFromSnapshotParams). */
export interface BoxdCreateParams {
	name: string;
	org?: string;
	labels: Record<string, string>;
	isolated: true;
	config: { autoSuspendTimeout: 0; vcpu?: number; memory?: string };
	fromSnapshot?: string;
	/** Seconds from now until boxd deletes the machine, whatever it is doing: with the deleteTimer option only. */
	deleteAfter?: number;
}

/** A finished exec (ExecResult, models.d.ts). A non-zero exit is a result, not a throw. */
export interface BoxdExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** A streamed exec (ExecStream, exec.d.ts): stdout is the stream itself, stderr its own iterable. */
export interface BoxdExecStream extends AsyncIterable<Uint8Array> {
	readonly stderr: AsyncIterable<Uint8Array>;
	write(data: Uint8Array | string): void;
	end(): void;
	wait(): Promise<number>;
	close(): void;
}

/** The part of the SDK's machines namespace called here (Machines, machines.d.ts). */
export interface BoxdMachines {
	create(params: BoxdCreateParams): Promise<BoxdMachine>;
	get(id: string): Promise<BoxdMachine>;
	list(params: { org?: string; labels: Record<string, string> }): Promise<Iterable<BoxdMachine>>;
	delete(id: string): Promise<void>;
	waitUntilReady(id: string, params: { timeout: number }): Promise<BoxdMachine>;
	setEgressAllow(id: string, entries: string[]): Promise<string[]>;
	setAutoHibernateTimeout(id: string, seconds: number): Promise<void>;
	updateLabels(id: string, params: { set: Record<string, string> }): Promise<Record<string, string>>;
	exec(id: string, params: { command: string; timeout: number }): Promise<BoxdExecResult>;
	streamExec(id: string, params: { command: string }): BoxdExecStream;
	readonly files: { upload(id: string, path: string, data: Uint8Array): Promise<number> };
}

/** What the provider gives the SDK's client: the key, the API's address and the region, each explicitly. */
export interface BoxdClientOptions {
	apiKey: string;
	baseURL: string;
	/** "" is the API's home region. Never left out, so the SDK takes no region from the environment. */
	region: string;
	timeout: number;
	/** How many times the SDK sends a call again after a connection error; 0 for create, which is never sent twice. */
	maxRetries?: number;
}

/** The SDK's Boxd class, or anything with the same slice: a client built from its options. */
export type BoxdClientClass = new (options: BoxdClientOptions) => { readonly machines: BoxdMachines };

/** The longest each kind of call may take, and the pauses between polls. */
export interface BoxdTimeouts {
	/** One control-plane call: get, list, delete, a label or egress change, a bridge's start. */
	requestMs: number;
	/** machines.create. */
	createMs: number;
	/** From create to a machine that answers exec (waitUntilReady). */
	readyMs: number;
	/** The daemon's upload. */
	uploadMs: number;
	/** The install and start commands. */
	execMs: number;
	/** From a connect's start to the daemon's hello, and each read-back call after it. */
	helloMs: number;
	/** The probe, run through the daemon: it takes at most 20 s (10 s to connect, 10 s to answer, every target at once). */
	probeMs: number;
	/** One whole list. */
	listMs: number;
	/** From a delete to a machine boxd no longer has and no longer lists. */
	goneMs: number;
	/** The first pause between two reads while release waits; the pauses double up to 5 s. */
	pollMs: number;
	/** After a create whose answer never said what it made: how long create looks for a machine of its name to delete. */
	listedMs: number;
}

/** A machine create gave up on that its cleanup could not delete: what onCleanupFailed is told. */
export interface BoxdCleanupFailure {
	/** The name create gave the machine, which is also its name label. */
	name: string;
	/** The machine's id, when boxd's late answer carried one. */
	id?: string;
	message: string;
}

export interface BoxdProviderOptions {
	/** The boxd API key. The caller passes it; this provider never reads it from the environment or puts it in a computer. */
	apiKey: string;
	/** The SDK's Boxd class: the host's `@boxd-sh/sdk` package's, or a fake. */
	Boxd: BoxdClientClass;
	/** The org (name or id) machines are made in and listed from. Unset: the key's own (an org key's org, else personal). */
	org?: string;
	/** What every machine's name starts with, before 12 hex digits: lowercase letters, digits and hyphens, ending in a hyphen. Default "computer-". */
	namePrefix?: string;
	/** The region machines are made in: "fra", "nyc", ... Unset: the API's home region. */
	region?: string;
	/** The API's address. Default https://boxd.sh:9443. */
	baseUrl?: string;
	/** A machine's vCPUs: 1, 2, 4 or 8, with memory its size class. Unset: the org's default size. */
	vcpu?: number;
	/** A machine's memory: "4G", "8G", "16G" or "32G", the size class with vcpu. */
	memory?: string;
	/** The daemon binary for linux/amd64 on this machine. Default this package's dist/computerd-linux-amd64. */
	daemonPath?: string;
	/** linux (default): no screen; desktop: an X server, started through the daemon. */
	kind?: "desktop" | "linux";
	/** The display and its X server, for kind desktop. Default Xvfb on :0, 1280x800. */
	desktop?: DesktopOptions;
	/** The longest lifetime check takes. Default 24 h, at most 30 days. */
	maxLifetimeMs?: number;
	/**
	 * A backstop: boxd deletes every machine 5 minutes past create's time plus maxLifetimeMs, whatever the host does,
	 * written in the same call that makes the machine. The janitor still ends a computer at its deadline. Default false.
	 */
	deleteTimer?: boolean;
	/**
	 * Called when a machine that landed after create gave up on it (an abort, or createMs passed) could not be deleted, or
	 * could not be looked for: with its name, its id when boxd answered with one, and what failed in words. The janitor
	 * still deletes such a machine by its deadline label. What it throws is dropped. Default: nothing is called.
	 */
	onCleanupFailed?: (left: BoxdCleanupFailure) => void;
	/**
	 * Who the daemon runs as, uid:gid in numbers, never root. Default 2510:2510 (TOOL_USER), a uid no process of the
	 * machine image holds: init refuses to start while another process does.
	 */
	daemonUser?: string;
	timeouts?: Partial<BoxdTimeouts>;
	/**
	 * The addresses the probe tries, to show none of them answers a computer with network none: host:port over TCP, or
	 * host:port/udp, a DNS query over UDP.
	 */
	probeTargets?: string[];
}

/** What create() takes: the provider's options, the SDK's Boxd class optional (default the host's @boxd-sh/sdk's). */
export interface BoxdOptions extends Omit<BoxdProviderOptions, "Boxd"> {
	/** The SDK's Boxd class; imported from the host's @boxd-sh/sdk package by default. */
	Boxd?: BoxdClientClass;
}

/** Not a literal, so no type checker or bundler resolves the SDK from this package. */
const BOXD_PACKAGE: string = "@boxd-sh/sdk";
/** The SDK's own default address (client.js DEFAULT_BASE_URL), given explicitly so the SDK takes none from the environment. */
const DEFAULT_BASE_URL = "https://boxd.sh:9443";
const BASE_URL = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/;
const REGION = /^[a-z][a-z0-9-]{0,31}$/;
const ORG = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/**
 * An BoxdProvider from its options alone; it reads no environment. The key is options.apiKey and nowhere else (serve
 * passes its BOXD_API_KEY, the conformance module the key it reads), and the SDK's Boxd class is the host's
 * @boxd-sh/sdk package's unless given. Throws in words when an option is missing or wrong, never echoing the key.
 */
export async function create(options: BoxdOptions): Promise<BoxdProvider> {
	const { apiKey, Boxd: given, ...rest } = options ?? ({} as BoxdOptions);
	if (typeof apiKey !== "string" || apiKey === "") throw new Error("options.apiKey, the boxd API key, is required: the provider reads no environment, so the caller passes it");
	const Boxd = given ?? ((await import(BOXD_PACKAGE)) as { Boxd: BoxdClientClass }).Boxd;
	return new BoxdProvider({ ...rest, apiKey, Boxd });
}

/** The conformance CLI's module for boxd: its live switch, the run's cap, its image and the drifted twin. */
export const conformance = () => import("./conformance/boxd.js");

const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
/** A machine's name: the provider's prefix, then the 12 hex digits of its request's name (computerNameFor). */
const NAME_PREFIX = /^[a-z][a-z0-9-]{0,40}-$/;
const DEFAULT_NAME_PREFIX = "computer-";
/** What computerNameFor puts before a request's 12 hex digits. */
const REQUEST_NAME_PREFIX = "computer-";
const namePattern = (prefix: string) => new RegExp(`^${prefix}[0-9a-f]{12}$`);
const MACHINE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** "default", boxd's own image, or a snapshot's name. */
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NAME_LABEL = `${COMPUTER_LABEL}.name`;
/** The image create was asked for: "default", or the snapshot the machine was restored from. */
const IMAGE_LABEL = `${COMPUTER_LABEL}.image`;
/** The most extend may move the deadline to: create's time plus the cap, by this machine's clock, as init was given. */
const MAX_LABEL = `${COMPUTER_LABEL}.max-deadline`;
const USER = /^(\d+):(\d+)$/;
const MAX_ID = 4_294_967_294;
const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_MS = DAY_MS;
const MOST_MAX_MS = 30 * DAY_MS;
/** boxd's size classes: vCPUs and the memory that goes with them (MachineConfig, models.d.ts). */
const SIZES: Readonly<Record<number, string>> = { 1: "4G", 2: "8G", 4: "16G", 8: "32G" };
const GIB = 1024 ** 3;
/** boxd machines are x86-64. */
const ARCH = "amd64";
const DEFAULT_DAEMON_PATH = fileURLToPath(new URL(`./computerd-linux-${ARCH}`, import.meta.url));
const DEFAULTS: BoxdTimeouts = {
	requestMs: 30_000,
	createMs: 120_000,
	readyMs: 120_000,
	uploadMs: 120_000,
	execMs: 60_000,
	helloMs: 30_000,
	probeMs: 30_000,
	listMs: 60_000,
	goneMs: 120_000,
	pollMs: 1_000,
	listedMs: 60_000,
};

/** The mount kinds a boxd computer takes, as capabilities().mount declares them: none yet. */
export const MOUNT: readonly MountKind[] = BOXD.mounts;
/** The machine kind and groups of each configuration: kind linux (the default), and kind desktop. */
export const CAPABILITIES: readonly KindCapabilities[] = BOXD.capabilities;
const RELEASE_POLL_MAX_MS = 5_000;
const GONE_ROUNDS = 2;
const LISTEN_RETRY_MS = 250;
/** The longest a Node timer or AbortSignal.timeout holds. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** What a call's race adds to its SDK request's own bound, so the SDK's timeout usually reports a slow call first (the
 *  SDK retries a call that lost its connection, so the race may end it first, while the SDK goes on in the background). */
const CALL_SLACK_MS = 5_000;
/** The longest timeout the provider takes: the race of a call bounded by it must still fit a Node timer. */
const MAX_TIMEOUT_MS = MAX_TIMER_MS - CALL_SLACK_MS;
const STAGING = "/tmp/agentrun-computerd-";
/** How far past the most a computer may live the deleteTimer backstop is set, in seconds: never before init's own end. */
const DELETE_TIMER_SLACK_S = 300;
/** The clock skew between this host and boxd that create's read-back of the backstop allows, in seconds. */
const CLOCK_SKEW_S = 120;
/** How many times the cleanup of a machine that landed late tries its delete before it reports the machine left. */
const LATE_DELETE_TRIES = 3;
/** How many times an extend writes the label and asks init again while other extends move the deadline later. */
const EXTEND_ROUNDS = 3;
/** Where init's own words go: root's, in /run, which only root writes. */
const INIT_LOG = "/run/agentrun-computerd.log";
/** Public anycast resolvers, by address: TCP to 443, and DNS over UDP to 53, over IPv4 and IPv6. */
const DEFAULT_PROBE_TARGETS = ["1.1.1.1:443", "8.8.8.8:443", "[2606:4700:4700::1111]:443", "1.1.1.1:53/udp", "[2606:4700:4700::1111]:53/udp"];
/** A probe target: host:port, over TCP, or host:port/udp, a DNS query over UDP. */
const TARGET = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):[0-9]{1,5}(?:\/udp)?$/;
const SPEC_FIELDS = new Set(["image", "lifetimeMs", "network", "labels", "mount", "gpu"]);
const NUL = "a NUL byte cannot be sent to boxd";
/** A boxd label name (Machines.updateLabels): 1 to 63 of these characters; "boxd/" is boxd's own. */
const LABEL_KEY = /^[a-z0-9._/-]{1,63}$/;
/** The port boxd's own agent answers on inside every machine: the way the SDK's exec and file calls come in. */
const AGENT_PORT = 57073;
const STOP = "a boxd computer has no stop that this provider declares: release it with delete";
/** The egress allowlist that lets a machine reach nothing (Machine.egressAllow, models.d.ts). */
const EGRESS_NONE = ["none"];
/** States in which the machine runs or comes back by itself on the next call: standby wakes on any traffic. */
const RUNNING = new Set(["pending", "starting", "running", "suspended", "migrating"]);
/** States of a machine that is going or gone. */
const GOING = new Set(["destroyed"]);

/**
 * Starts init detached, as root: a session of its own (setsid), so the exec that started it returns and init stays,
 * and its words in INIT_LOG, which only root can write. The command is childCommands' init, run by a shell.
 */
const START_SCRIPT = [
	"# agentrun-computer: start",
	'p=; [ "$(id -u)" = 0 ] || p="sudo -n"',
	`exec $p sh -c 'umask 077; setsid -f sh -c "$1" >"$2" 2>&1 </dev/null' sh "$1" "$2"`,
].join("\n");
/** Init's last words, as root. */
const LOG_SCRIPT = ["# agentrun-computer: log", 'p=; [ "$(id -u)" = 0 ] || p="sudo -n"', '$p tail -c 2000 "$1" 2>/dev/null || true'].join("\n");

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

/** gRPC status codes the SDK carries on an APIStatusError (grpcCode). */
const GRPC_INVALID_ARGUMENT = 3;
const GRPC_RESOURCE_EXHAUSTED = 8;
const GRPC_FAILED_PRECONDITION = 9;
const GRPC_DEADLINE_EXCEEDED = 4;
const GRPC_UNAVAILABLE = 14;

/** The SDK names its errors (errors.d.ts). */
function codeOf(error: unknown): ComputerErrorCode {
	const { name, grpcCode } = (error ?? {}) as { name?: unknown; grpcCode?: unknown };
	if (name === "AbortError") return "aborted";
	if (name === "NotFoundError" || name === "MachineFileNotFoundError") return "not_found";
	if (name === "AuthenticationError" || name === "PermissionDeniedError" || name === "RegionNotEnabledError") return "denied";
	if (name === "RateLimitError") return "limit";
	if (name === "ConflictError") return "refused";
	if (name === "APIConnectionError") return "timeout";
	if (grpcCode === GRPC_DEADLINE_EXCEEDED || grpcCode === GRPC_UNAVAILABLE) return "timeout";
	if (grpcCode === GRPC_INVALID_ARGUMENT) return "invalid";
	if (grpcCode === GRPC_RESOURCE_EXHAUSTED) return "limit";
	if (grpcCode === GRPC_FAILED_PRECONDITION) return "refused";
	return "vendor";
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

function labelProblem(key: string, value: unknown): string | undefined {
	if (typeof value !== "string") return `the label ${key} must be a string`;
	if (key.includes("\0") || value.includes("\0")) return `the label ${JSON.stringify(key)}: ${NUL}`;
	if (key === "") return "a label name must be non-empty";
	if (key === COMPUTER_LABEL || key.startsWith(`${COMPUTER_LABEL}.`)) return `the label ${key} is in the provider's own namespace (${COMPUTER_LABEL})`;
	if (!LABEL_KEY.test(key) || key.startsWith("boxd/")) return `the label ${JSON.stringify(key)} is not a boxd label name: 1 to 63 of a-z, 0-9, ".", "_", "/" and "-", not starting with "boxd/"`;
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

/** Only a machine this provider made counts: its label, a name of its making, the machine's name the same, and the name asked for when one is. */
const ours = (pattern: RegExp, machine: Pick<BoxdMachine, "name" | "labels"> | undefined, name?: string) =>
	machine?.labels?.[COMPUTER_LABEL] === "1" &&
	pattern.test(machine.labels[NAME_LABEL] ?? "") &&
	machine.name === machine.labels[NAME_LABEL] &&
	(name === undefined || machine.labels[NAME_LABEL] === name);

/** An ISO time a label holds, or undefined when it is missing or not the ISO time create writes. */
function isoOf(written: string | undefined): Date | undefined {
	const at = written === undefined ? Number.NaN : Date.parse(written);
	return Number.isNaN(at) || new Date(at).toISOString() !== written ? undefined : new Date(at);
}

/** The deadline init holds, from its refusal of an earlier one ("... is earlier than the deadline <ISO time>: ..."). */
function laterDeadline(refusal: string): Date | undefined {
	return isoOf(/ is earlier than the deadline (\S+): /.exec(refusal)?.[1]);
}

/**
 * A machine's network as boxd reports it: none is the egress allowlist ["none"]; open is no allowlist. Anything else
 * (a list of hosts) is another network in words, never one it might widen to.
 */
function networkOf(machine: BoxdMachine): NetworkPolicy {
	const allow = Array.isArray(machine.egressAllow) ? machine.egressAllow : undefined;
	if (allow === undefined) return { other: "boxd did not report the machine's egress allowlist" };
	if (allow.length === 0) return "open";
	if (allow.length === 1 && allow[0] === "none") return "none";
	return { other: `an egress allowlist of ${allow.length} entries, which this provider never makes` };
}

/** Every idle timer of a machine that is not off, as create leaves them: one that is on would freeze or end a computer before its deadline. */
function idleDrift(machine: BoxdMachine): string[] {
	const found: string[] = [];
	const timers = { "auto-suspend": machine.idle?.suspendAfter, "auto-hibernate": machine.idle?.hibernateAfter, "auto-destroy": machine.idle?.destroyAfter };
	for (const [field, actual] of Object.entries(timers)) if (actual !== 0) found.push(`${field}: declared ${show(0)}, read back ${show(actual)}`);
	return found;
}

const policyWords = (policy: NetworkPolicy) => (typeof policy === "string" ? policy : "other" in policy ? policy.other : JSON.stringify(policy));

/** What create made before the machine: its deadlines, its labels, and the daemon with its sha256. */
interface Made {
	deadline: string;
	maxDeadline: string;
	labels: Record<string, string>;
	daemon: Buffer;
	sha256: string;
}

/** Why ref is not a boxd computer's ref, or undefined. */
function refProblem(pattern: RegExp, prefix: string, ref: ComputerRef): string | undefined {
	if (typeof ref?.name !== "string" || !pattern.test(ref.name)) return `${String(ref?.name)} is not the name of a boxd computer of this provider (${prefix}<12 hex digits>)`;
	if (typeof ref.id !== "string" || !MACHINE_ID.test(ref.id)) return `${String(ref.id)} is not a boxd machine id`;
	return undefined;
}

/**
 * Computers that are boxd machines. A spec's image is "default", boxd's own Ubuntu 24.04 image, or the name of a boxd
 * snapshot the machine is restored from. See the README's boxd section for every call.
 */
export class BoxdProvider implements ComputerProvider {
	readonly id = "boxd";
	readonly version = VERSION;
	readonly #machines: BoxdMachines;
	/** The same API, for create alone: bounded by createMs, and never sent twice. */
	readonly #creator: BoxdMachines;
	readonly #deleteTimer: boolean;
	readonly #onCleanupFailed: ((left: BoxdCleanupFailure) => void) | undefined;
	readonly #org: string | undefined;
	readonly #prefix: string;
	readonly #name: RegExp;
	readonly #size: { vcpu: number; memory: string } | undefined;
	readonly #daemonPath: string;
	readonly #kind: "desktop" | "linux";
	readonly #desktop: Required<DesktopOptions> | undefined;
	readonly #maxLifetimeMs: number;
	readonly #uid: string;
	readonly #gid: string;
	readonly #timeouts: BoxdTimeouts;
	readonly #probeTargets: string[];
	/** Idempotent create's in-process half: the creates in flight and the requests whose computers this provider ended. */
	readonly #requests = new CreateRequests();
	/** Each computer's last extend, by machine id, while one runs: the next waits for it. */
	readonly #extending = new Map<string, Promise<void>>();

	constructor(options: BoxdProviderOptions) {
		const {
			apiKey,
			Boxd,
			org,
			namePrefix = DEFAULT_NAME_PREFIX,
			region = "",
			baseUrl = DEFAULT_BASE_URL,
			vcpu,
			memory,
			daemonPath = DEFAULT_DAEMON_PATH,
			kind = "linux",
			desktop = {},
			maxLifetimeMs = DEFAULT_MAX_MS,
			deleteTimer = false,
			onCleanupFailed,
			daemonUser = TOOL_USER,
			timeouts = {},
			probeTargets = DEFAULT_PROBE_TARGETS,
		} = options;
		if (typeof apiKey !== "string" || apiKey === "") throw new Error("a boxd API key is required");
		if (typeof Boxd !== "function") throw new Error("options.Boxd must be the @boxd-sh/sdk package's Boxd class");
		if (org !== undefined && (typeof org !== "string" || !ORG.test(org))) throw new Error(`org must be a boxd org's name or id, not ${JSON.stringify(org)}`);
		if (typeof namePrefix !== "string" || !NAME_PREFIX.test(namePrefix)) throw new Error(`namePrefix must be lowercase letters, digits and hyphens ending in a hyphen, such as ${DEFAULT_NAME_PREFIX}, not ${JSON.stringify(namePrefix)}`);
		if (typeof region !== "string" || (region !== "" && !REGION.test(region))) throw new Error(`region must be a boxd region such as "fra" or "nyc", not ${JSON.stringify(region)}`);
		if (typeof baseUrl !== "string" || !BASE_URL.test(baseUrl)) throw new Error(`baseUrl must be an https address such as ${DEFAULT_BASE_URL}, not ${JSON.stringify(baseUrl)}`);
		if ((vcpu === undefined) !== (memory === undefined)) throw new Error("vcpu and memory go together: one of boxd's sizes, 1 and 4G, 2 and 8G, 4 and 16G or 8 and 32G");
		if (vcpu !== undefined && SIZES[vcpu as number] !== memory) throw new Error(`vcpu ${String(vcpu)} with memory ${String(memory)} is not one of boxd's sizes: 1 and 4G, 2 and 8G, 4 and 16G or 8 and 32G`);
		if (kind !== "desktop" && kind !== "linux") throw new Error(`kind is desktop or linux, not ${String(kind)}`);
		if (!isWhole(maxLifetimeMs) || maxLifetimeMs <= 0 || maxLifetimeMs > MOST_MAX_MS) throw new Error(`maxLifetimeMs must be a whole number of ms above 0 and at most 30 days (${MOST_MAX_MS} ms)`);
		const user = USER.exec(daemonUser);
		if (user === null || Number(user[1]) > MAX_ID || Number(user[2]) > MAX_ID) throw new Error(`the daemon user ${daemonUser} must be uid:gid in numbers, such as 2510:2510`);
		// The numbers, not the text: "00" is root as much as "0" is.
		if (Number(user[1]) === 0 || Number(user[2]) === 0) throw new Error(`the daemon user ${daemonUser} is root or in root's group; a boxd computer's daemon runs as neither`);
		// The image's own user (boxd, 1000) runs the provider's exec, and init refuses to start beside another process of
		// its programs' uid: a daemon user of 1000 never starts.
		if (Number(user[1]) === 1000) throw new Error(`the daemon user ${daemonUser} is the uid of the machine's own user, whose processes init refuses to run beside; choose another, such as ${TOOL_USER}`);
		const merged = { ...DEFAULTS, ...timeouts };
		for (const [key, value] of Object.entries(merged)) {
			if (!isWhole(value) || value <= 0 || value > MAX_TIMEOUT_MS) throw new Error(`timeouts.${key} must be a whole number of ms above 0 and at most ${MAX_TIMEOUT_MS}, not ${value}`);
		}
		if (!Array.isArray(probeTargets) || probeTargets.length === 0 || probeTargets.some((target) => typeof target !== "string" || !TARGET.test(target))) {
			throw new Error("probeTargets must name at least one address for the probe, each host:port or host:port/udp");
		}
		// Every setting the SDK would otherwise read from the environment is given: the key, the address and the region.
		if (typeof deleteTimer !== "boolean") throw new Error("deleteTimer is true or false");
		if (onCleanupFailed !== undefined && typeof onCleanupFailed !== "function") throw new Error("onCleanupFailed is a function");
		const client = new Boxd({ apiKey, baseURL: baseUrl, region, timeout: merged.requestMs });
		// create's own client: the SDK bounds every call by its client's timeout, so create gets createMs, and no retry.
		const creator = new Boxd({ apiKey, baseURL: baseUrl, region, timeout: merged.createMs, maxRetries: 0 })?.machines;
		const machines = client?.machines;
		const lacks = ["create", "get", "list", "delete", "waitUntilReady", "setEgressAllow", "setAutoHibernateTimeout", "updateLabels", "exec", "streamExec"].filter(
			(name) => typeof (machines as unknown as Record<string, unknown>)?.[name] !== "function",
		);
		if (lacks.length > 0 || typeof machines?.files?.upload !== "function") throw new Error(`options.Boxd must be the @boxd-sh/sdk package's Boxd class; its machines lack ${[...lacks, ...(typeof machines?.files?.upload === "function" ? [] : ["files.upload"])].join(", ")}`);
		if (typeof creator?.create !== "function") throw new Error("options.Boxd must be the @boxd-sh/sdk package's Boxd class; its machines lack create");
		this.#machines = machines;
		this.#creator = creator;
		this.#deleteTimer = deleteTimer;
		this.#onCleanupFailed = onCleanupFailed;
		this.#org = org;
		this.#prefix = namePrefix;
		this.#name = namePattern(namePrefix);
		this.#size = vcpu === undefined ? undefined : { vcpu: vcpu as number, memory: memory as string };
		this.#daemonPath = resolve(daemonPath);
		this.#kind = kind;
		this.#desktop = kind === "desktop" ? desktopOf(desktop) : undefined;
		this.#maxLifetimeMs = maxLifetimeMs;
		[this.#uid, this.#gid] = [String(Number(user[1])), String(Number(user[2]))];
		this.#timeouts = merged;
		this.#probeTargets = [...probeTargets];
	}

	/**
	 * daemon child: boxd's own agent runs every command in the machine, and init is a detached command it starts (#start),
	 * so init's exit leaves the machine. The janitor ends a machine by its deadline label, and init ends every process at
	 * the deadline. Without deleteTimer boxd has no timer for the machine; with it, boxd also deletes the machine 5 minutes
	 * past the most it may live. The agent answers on 57073, so init starts with --own-network, and network none is all a
	 * computer takes until a proxy carries open out of the daemon's own network.
	 */
	capabilities(): ComputerCapabilities {
		return {
			kind: this.#kind,
			lifetime: "janitor",
			network: [...BOXD.network],
			networkReadBack: true,
			isolation: "microvm",
			os: "linux",
			daemon: "child",
			groups: ["exec", "files", "processes", ...(this.#desktop ? DESKTOP_GROUPS : [])],
			maxLifetimeMs: this.#maxLifetimeMs,
			release: ["delete"],
			mount: [...MOUNT],
			vendorAgentPorts: [AGENT_PORT],
		};
	}

	check(spec: ComputerSpec): Refusal[] {
		const refusals: Refusal[] = [];
		const refuse = (field: string, message: string) => refusals.push({ field, message });
		const given = (typeof spec === "object" && spec !== null ? spec : {}) as unknown as Record<string, unknown>;
		const { image, network, labels, mount } = given;
		if (mount !== undefined) refuse("mount", "a boxd computer takes no mount yet");
		if (typeof image === "string" && image !== BOXD_DEFAULT_IMAGE && this.#size !== undefined) {
			refuse("image", `a computer restored from the snapshot ${JSON.stringify(image)} has the snapshot's size: this provider's vcpu and memory options name one, so it takes only "${BOXD_DEFAULT_IMAGE}"`);
		}
		if (typeof image !== "string" || !IMAGE.test(image)) refuse("image", `an image is required: "${BOXD_DEFAULT_IMAGE}" (boxd's own Ubuntu 24.04), or the name of a boxd snapshot`);
		refusals.push(...checkTenure(given, this.capabilities(), "boxd"));
		if (network === "open" || (typeof network === "object" && network !== null && "allow" in network)) refuse("network", OWN_NETWORK_ONLY);
		else if (network !== "none") refuse("network", 'network is required: "none"');
		if (labels !== undefined) {
			const entries = typeof labels === "object" && labels !== null && !Array.isArray(labels) ? Object.entries(labels) : undefined;
			const bad = entries === undefined ? "labels must map names to strings" : entries.map(([key, value]) => labelProblem(key, value)).find(Boolean);
			if (bad) refuse("labels", bad);
		}
		refusals.push(...checkGpu(given.gpu, this.capabilities()));
		for (const [field, value] of Object.entries(given)) {
			if (SPEC_FIELDS.has(field) || value === undefined) continue;
			if (field === "cpus" || field === "memoryMb" || field === "pids") refuse(field, `a boxd computer has the provider's size (its vcpu and memory options, else the org's default), not ${field}`);
			else if (field === "user") refuse(field, `a boxd computer's daemon runs as the provider's daemon user (${this.#uid}:${this.#gid}), never as one a spec names`);
			else if (field === "workdir") refuse(field, `a boxd computer works in ${WORK}, its home; a spec cannot name another`);
			else refuse(field, `a boxd computer does not support ${field}`);
		}
		return refusals;
	}

	/**
	 * Makes a computer, once per request: context.requestId names the machine (the provider's prefix, then the 12 hex
	 * digits of computerNameFor), and boxd keeps a name to one machine. A create of a request whose machine boxd already
	 * holds answers that computer instead of making another (#again): one still starting is waited for, one up is
	 * returned once its labels and daemon read back as attach reads them, and one that ended, or that this provider gave
	 * up on or deleted, is refused as exists, in words. A second create of a request still in flight here waits for the
	 * first and answers what it does (CreateRequests).
	 */
	async create(spec: ComputerSpec, context: CreateContext): Promise<Result<CreatedComputer>> {
		const refusals = this.check(spec);
		// CreateRequests speaks of the request's name under the default prefix: its words name the machine as it is.
		const requested = typeof context?.requestId === "string" ? computerNameFor(context.requestId) : undefined;
		const named = (message: string) => (requested === undefined ? message : message.replaceAll(requested, this.#machineName(requested)));
		return this.#requests.create(spec, context, {
			refuse: (code, message) => fail(code, named(message)),
			...(refusals.length > 0 ? { refused: refusals.map(({ field, message }) => `${field}: ${message}`).join("; ") } : {}),
			make: (name) => this.#createOnce(spec, this.#machineName(name), context.signal),
		});
	}

	/** The machine's name for a request's name: the provider's prefix in place of computerNameFor's. */
	#machineName(requested: string): string {
		return `${this.#prefix}${requested.slice(REQUEST_NAME_PREFIX.length)}`;
	}

	/** A request's computer given up on or deleted, by its machine's name: its request is refused from now on. */
	#end(name: string): void {
		this.#requests.end(`${REQUEST_NAME_PREFIX}${name.slice(this.#prefix.length)}`);
	}

	/** The create of one request, alone in this provider: the machine boxd holds under its name answered, or one made. */
	async #createOnce(spec: ComputerSpec, name: string, signal?: AbortSignal): Promise<Result<CreatedComputer>> {
		const held = await this.#named(name, signal);
		if (!held.ok) return held;
		if (held.value !== undefined) return this.#again(spec, name, held.value, signal);
		const launched = await this.#launch(spec, name, signal);
		if (!launched.ok) {
			if (!launched.taken) return launched;
			// boxd holds the name: another create of this request made the machine since the listing. Answer that one.
			const taken = await this.#named(name, signal, this.#timeouts.listedMs);
			if (!taken.ok) return taken;
			if (taken.value === undefined) return fail("exists", `boxd holds the name ${name} for a machine this provider does not list as this request's computer (${launched.error.message}): create with a new request id`);
			return this.#again(spec, name, taken.value, signal);
		}
		const { ref, made } = launched.value;
		// From here the machine exists: every step takes the caller's signal, and a failure or an abort deletes it.
		const prepared = await this.#prepare(spec, ref, made, signal);
		if (signal?.aborted) return this.#abandon(ref, { code: "aborted", message: "create was aborted" }, signal);
		if (prepared.ok) return ok(prepared.value.length > 0 ? { ...ref, notes: prepared.value } : ref);
		return this.#abandon(ref, prepared.error, signal);
	}

	/**
	 * The one machine of this provider that boxd lists under a request's name, or undefined when none is. With waitMs
	 * the listing is read again until one shows or waitMs passes. More than one is refused as exists.
	 */
	async #named(name: string, signal?: AbortSignal, waitMs = 0): Promise<Result<BoxdMachine | undefined>> {
		const until = Date.now() + waitMs;
		for (;;) {
			const listed = await this.#list({ [COMPUTER_LABEL]: "1", [NAME_LABEL]: name }, signal);
			if (!listed.ok) return listed;
			const found = listed.value.filter((machine) => ours(this.#name, machine, name) && !GOING.has(machine.status));
			if (found.length > 1) return fail("exists", `${found.length} machines carry the name ${name} (${found.map((machine) => machine.id).join(", ")}): create with a new request id`);
			if (found.length === 1 || Date.now() >= until) return ok(found[0]);
			await pause(Math.min(this.#timeouts.pollMs * 2, RELEASE_POLL_MAX_MS), signal);
			if (signal?.aborted) return fail("aborted", "create was aborted");
		}
	}

	/**
	 * A create of a request whose machine boxd already holds: the same create, the computer as it is. One that is not
	 * running, or past its deadline, has ended: exists. One whose labels are not the spec's is another spec's: exists.
	 * One running is attached, and answered once its daemon reads back as attach holds it; until then the create that
	 * made it may still be making it, so it is read again within createMs. A refusal that holds past that is exists.
	 */
	async #again(spec: ComputerSpec, name: string, first: BoxdMachine, signal?: AbortSignal): Promise<Result<CreatedComputer>> {
		const { createMs, pollMs } = this.#timeouts;
		const until = Date.now() + createMs;
		const poll = Math.min(pollMs * 2, RELEASE_POLL_MAX_MS);
		let machine = first;
		let last: { code: ComputerErrorCode; message: string } | undefined;
		for (;;) {
			if (!RUNNING.has(machine.status)) return fail("exists", endedWords(name));
			const deadline = isoOf(machine.labels[DEADLINE_LABEL]);
			if (deadline !== undefined && deadline.getTime() <= Date.now()) return fail("exists", endedWords(name));
			const own = Object.entries(machine.labels).filter(([key]) => key === IMAGE_LABEL || (key !== COMPUTER_LABEL && !key.startsWith(`${COMPUTER_LABEL}.`)));
			const differ = labelsDiffer({ ...spec.labels, [IMAGE_LABEL]: spec.image }, Object.fromEntries(own), "read back");
			if (differ.length > 0) return fail("exists", otherSpecWords(name, "was made", differ));
			if (machine.status !== "pending" && machine.status !== "starting") {
				const attached = await this.#attached(machine, signal);
				if (attached.ok) {
					if (attached.value.spec.network !== spec.network) {
						return fail("exists", otherSpecWords(name, "was made", [`network: asked ${show(spec.network)}, read back ${show(attached.value.spec.network)}`]));
					}
					return ok({ id: attached.value.id, name: attached.value.name, ...(attached.value.notes ? { notes: attached.value.notes } : {}) });
				}
				if (attached.error.code === "aborted") return attached;
				last = attached.error;
			}
			if (Date.now() + poll >= until) {
				if (last?.code === "refused") return fail("exists", `${name} was made for this request, and after ${seconds(createMs)} still ${last.message}`);
				return fail("timeout", `${name}, made for this request, was not up within ${seconds(createMs)}${last ? `: ${last.message}` : ""}`);
			}
			await pause(poll, signal);
			if (signal?.aborted) return fail("aborted", `create was aborted while ${name}, made for this request, came up`);
			const read = await this.#get(first.id, signal);
			if (!read.ok && read.error.code !== "not_found") return read;
			if (!read.ok || !ours(this.#name, read.value, name) || !this.#inOrg(read.value)) return fail("exists", endedWords(name));
			machine = read.value;
		}
	}

	/**
	 * Everything create does up to boxd's answer: the daemon read, the machine made, by its request's name and the
	 * provider's options. taken marks a create boxd refused because a machine holds the name.
	 */
	async #launch(spec: ComputerSpec, name: string, signal?: AbortSignal): Promise<Result<{ ref: ComputerRef; made: Made }> & { taken?: true }> {
		let daemon: Buffer;
		try {
			daemon = readFileSync(this.#daemonPath);
		} catch {
			return fail("not_found", `no daemon binary at ${this.#daemonPath}: run npm run build:daemon -w @parcha/agentrun-computer`);
		}
		const sha256 = createHash("sha256").update(daemon).digest("hex");
		if (signal?.aborted) return fail("aborted", "create was aborted before boxd was called");
		const now = Date.now();
		const deadline = new Date(now + runLifetimeMs(spec)).toISOString();
		const maxDeadline = new Date(now + this.#maxLifetimeMs).toISOString();
		const labels = {
			...spec.labels,
			[COMPUTER_LABEL]: "1",
			[NAME_LABEL]: name,
			[DEADLINE_LABEL]: deadline,
			[IMAGE_LABEL]: spec.image,
			[MAX_LABEL]: maxDeadline,
		};
		const params: BoxdCreateParams = {
			name,
			...(this.#org === undefined ? {} : { org: this.#org }),
			labels,
			// Isolated: on no network of the org's, reached by no other machine, with no in-machine credential.
			isolated: true,
			// No standby: a computer's programs may run long with no traffic, and standby would freeze them.
			config: { autoSuspendTimeout: 0, ...(this.#size ?? {}) },
			...(spec.image === BOXD_DEFAULT_IMAGE ? {} : { fromSnapshot: spec.image }),
			// The backstop, written with the machine: past the most this computer may live, so extend never needs to move it.
			...(this.#deleteTimer ? { deleteAfter: Math.ceil(this.#maxLifetimeMs / 1000) + DELETE_TIMER_SLACK_S } : {}),
		};
		const { createMs } = this.#timeouts;
		// Never cancelled, only raced: a create given up on may still land.
		let creating: Promise<BoxdMachine>;
		try {
			creating = Promise.resolve(this.#creator.create(params));
		} catch (error) {
			return fail(codeOf(error), `machines.create failed: ${words(error)}`);
		}
		let answered = false;
		let taken = false;
		creating.then(
			() => (answered = true),
			(error: unknown) => {
				answered = true;
				taken = (error as { name?: unknown } | null)?.name === "ConflictError";
			},
		);
		const created = await race(creating, "machines.create", createMs + CALL_SLACK_MS, signal);
		// Let a rejection that settled the race mark itself answered first.
		await Promise.resolve();
		if (!created.ok) {
			if (!answered && (created.error.code === "aborted" || created.error.code === "timeout")) {
				this.#end(name);
				void this.#cleanLate(creating, name);
				return fail(created.error.code, `${created.error.message}; a machine it makes after this is deleted as it lands, and one that cannot be is the janitor's by its deadline label`);
			}
			// A create boxd refused made nothing, and one refused for its name leaves the machine that holds the name as it
			// is. One that failed otherwise (a deadline the SDK gave up at, a connection lost) may have made one, or may
			// still: create looks for its name until one shows or listedMs passes, and deletes it.
			if (taken) return { ...fail("refused", `boxd did not create the machine: ${created.error.message}`), taken: true };
			if (["invalid", "denied", "limit", "not_found", "refused"].includes(created.error.code)) return created;
			this.#end(name);
			const swept = await this.#deleteNamed(name, this.#timeouts.listedMs);
			return fail(created.error.code, `boxd did not create the machine: ${created.error.message}${swept}`);
		}
		this.#requests.made(`${REQUEST_NAME_PREFIX}${name.slice(this.#prefix.length)}`);
		return ok({ ref: { id: created.value.id, name }, made: { deadline, maxDeadline, labels, daemon, sha256 } });
	}

	/**
	 * After create's caller has its answer: a machine that lands is deleted by its id, and one whose answer never comes by
	 * its name label. A delete that fails is tried LATE_DELETE_TRIES times; a machine still there, or a listing that
	 * could not say, is told to onCleanupFailed. Never throws.
	 */
	async #cleanLate(creating: Promise<BoxdMachine>, name: string): Promise<void> {
		let left: BoxdCleanupFailure | undefined;
		try {
			let machine: BoxdMachine | undefined;
			try {
				machine = await creating;
			} catch {
				machine = undefined;
			}
			if (machine === undefined) {
				const swept = await this.#deleteNamed(name, this.#timeouts.listedMs);
				if (swept.includes("may be left")) left = { name, message: swept.replace(/^; /, "") };
			} else {
				let deleted = await this.#delete(machine.id);
				for (let tries = 1; !deleted.ok && tries < LATE_DELETE_TRIES; tries++) {
					await pause(Math.min(this.#timeouts.pollMs * 2, RELEASE_POLL_MAX_MS));
					deleted = await this.#delete(machine.id);
				}
				if (!deleted.ok) left = { name, id: machine.id, message: `the machine ${machine.id} landed after create gave up on it and could not be deleted (${deleted.error.message}); the janitor deletes it by its deadline label` };
			}
		} catch (error) {
			left = { name, message: `the cleanup after create gave up failed: ${words(error)}` };
		}
		if (left === undefined) return;
		try {
			this.#onCleanupFailed?.(left);
		} catch {
			// The caller's own handler: nothing here depends on it.
		}
	}

	/** Deletes a machine create gives up on, then waits, under the caller's signal, until boxd reads it gone. */
	async #abandon(ref: ComputerRef, error: { code: ComputerErrorCode; message: string }, signal?: AbortSignal): Promise<Result<never>> {
		this.#end(ref.name);
		const deleted = await this.#delete(ref.id);
		const gone = deleted.ok ? await this.#settle(ref, signal) : deleted;
		const after = gone.ok
			? "was deleted"
			: deleted.ok && gone.error.code === "aborted"
				? "was deleted, and the wait for it to go was aborted"
				: `could not be deleted (${gone.error.message}); the janitor deletes it by its deadline label`;
		return fail(error.code, `the computer ${ref.name} ${after}: ${error.message}`);
	}

	/**
	 * Every machine of this provider carrying a name create gave, deleted and read back gone: for a create whose answer
	 * never said what it made. With waitMs, the listing is read again until one shows or waitMs passes, since a machine
	 * may land after the call gave up on it. Best effort, in words.
	 */
	async #deleteNamed(name: string, waitMs = 0): Promise<string> {
		const until = Date.now() + waitMs;
		let found: BoxdMachine[];
		for (;;) {
			const listed = await this.#list({ [COMPUTER_LABEL]: "1", [NAME_LABEL]: name });
			if (!listed.ok) return `; a machine named ${name} may be left (${listed.error.message}), which the janitor deletes by its deadline label`;
			found = listed.value.filter((machine) => ours(this.#name, machine, name) && !GOING.has(machine.status));
			if (found.length > 0 || Date.now() >= until) break;
			await pause(Math.min(this.#timeouts.pollMs * 2, RELEASE_POLL_MAX_MS));
		}
		if (found.length === 0) return waitMs > 0 ? `; no machine named ${name} was listed within ${seconds(waitMs)}` : "";
		const said: string[] = [];
		for (const machine of found) {
			const deleted = await this.#delete(machine.id);
			const gone = deleted.ok ? await this.#settle({ id: machine.id, name }) : deleted;
			said.push(gone.ok ? `${machine.id} was deleted and read back gone` : `${machine.id} may be left (${gone.error.message})`);
		}
		return `; the machine named ${name} it made: ${said.join("; ")}`;
	}

	/** machines.delete, never signalled: a delete that cleans up after an abort must outlive it. Not found is done. */
	async #delete(id: string): Promise<Result<void>> {
		const { requestMs } = this.#timeouts;
		const deleted = await call(`machines.delete of ${id}`, () => this.#machines.delete(id), requestMs + CALL_SLACK_MS);
		return deleted.ok || deleted.error.code === "not_found" ? ok(undefined) : deleted;
	}

	/**
	 * Everything between the create's answer and a computer that passed the drift check, whose value is what the check
	 * recorded that does not refuse it (notes): the machine ready, its egress closed and hibernation off, read back, the
	 * daemon uploaded, installed and started, and its first connection checked.
	 */
	async #prepare(spec: ComputerSpec, ref: ComputerRef, { deadline, maxDeadline, labels, daemon, sha256 }: Made, signal?: AbortSignal): Promise<Result<string[]>> {
		const { readyMs, requestMs, uploadMs, execMs } = this.#timeouts;
		const ready = await call(`machines.waitUntilReady of ${ref.name}`, () => this.#machines.waitUntilReady(ref.id, { timeout: readyMs }), readyMs + CALL_SLACK_MS, signal);
		if (!ready.ok) return ready;
		// Nothing out: the egress allowlist ["none"] (Machine.egressAllow). And no hibernation: a computer's programs may
		// run long with no traffic, and hibernation would freeze them.
		const egress = await call(`machines.setEgressAllow of ${ref.name}`, () => this.#machines.setEgressAllow(ref.id, EGRESS_NONE), requestMs + CALL_SLACK_MS, signal);
		if (!egress.ok) return egress;
		const asleep = await call(`machines.setAutoHibernateTimeout of ${ref.name}`, () => this.#machines.setAutoHibernateTimeout(ref.id, 0), requestMs + CALL_SLACK_MS, signal);
		if (!asleep.ok) return asleep;
		const info = await this.#get(ref.id, signal);
		if (!info.ok) return info;
		const vendor = this.#machineDrift(spec, info.value, labels);
		if (vendor.length > 0) return fail("refused", `it did not match its spec: ${vendor.join("; ")}`);
		const staging = `${STAGING}${randomBytes(8).toString("hex")}`;
		const bytes = new Uint8Array(daemon.buffer, daemon.byteOffset, daemon.byteLength);
		const uploaded = await call(`the daemon's upload into ${ref.name}`, () => this.#machines.files.upload(ref.id, staging, bytes), uploadMs + CALL_SLACK_MS, signal);
		if (!uploaded.ok) return fail(uploaded.error.code, `the daemon's upload was refused: ${uploaded.error.message}`);
		const commands = childCommands({ staging, deadline, user: `${this.#uid}:${this.#gid}`, display: this.#desktop?.display ?? "", maxDeadline });
		const install = await this.#exec(ref.id, commands.install, execMs, signal);
		if (!install.ok) return install;
		if (install.value.exitCode !== 0) return fail("refused", `installing the daemon failed (exit ${install.value.exitCode}): ${`${install.value.stdout} ${install.value.stderr}`.trim().slice(0, 500)}`);
		const read = /^sha256 ([0-9a-f]{64})$/m.exec(install.value.stdout)?.[1];
		if (read !== sha256) return fail("refused", `it did not match its spec: daemon: uploaded sha256 ${sha256}, the installed binary reads back ${show(read)}`);
		return this.#start(spec, ref, commands, signal);
	}

	/** The rest of #prepare from the daemon's install on: init started, its first connection checked. */
	async #start(spec: ComputerSpec, ref: ComputerRef, commands: ReturnType<typeof childCommands>, signal?: AbortSignal): Promise<Result<string[]>> {
		const started = await this.#exec(ref.id, shellCommand(START_SCRIPT, [commands.init, INIT_LOG]), this.#timeouts.execMs, signal);
		if (!started.ok) return started;
		if (started.value.exitCode !== 0) return fail("refused", `starting the daemon failed (exit ${started.value.exitCode}): ${`${started.value.stdout} ${started.value.stderr}`.trim().slice(0, 500)}`);
		const opened = await this.#openWhenListening(ref, signal);
		if (!opened.ok) {
			if (opened.error.code === "aborted") return opened;
			const log = await this.#exec(ref.id, shellCommand(LOG_SCRIPT, [INIT_LOG]), this.#timeouts.execMs, signal);
			const why = log.ok ? log.value.stdout.trim().slice(-500) : "";
			return fail(opened.error.code, `the daemon did not answer: ${opened.error.message}${why ? `; init wrote: ${why}` : ""}`);
		}
		try {
			return await this.#checkInside(opened.value, ref.name, spec.network as "none", true, signal);
		} finally {
			await opened.value.close();
		}
	}

	/**
	 * Inside the computer: for a desktop just made, the X server started through the daemon and hello declaring the
	 * display; then the daemon's own report (hello, credentials, home, binary, its own network) and, for network none, the
	 * probe, which refuses on an answer and records a silent accept in the notes it returns (README, "Network none, read
	 * from inside").
	 */
	async #checkInside(connection: ComputerConnection, name: string, network: NetworkPolicy, starting: boolean, signal?: AbortSignal): Promise<Result<string[]>> {
		let current = connection;
		if (starting && this.#desktop) {
			const shown = await startDisplay(connection.client, this.#desktop, { version: VERSION, vendor: "boxd", signal });
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
		return drift.length === 0 ? ok(notes) : fail("refused", `it did not match its spec: ${drift.join("; ")}`);
	}

	#daemonExpected(): DaemonExpected {
		const { kind, groups } = this.capabilities();
		return { version: VERSION, uid: this.#uid, gid: this.#gid, arch: ARCH, kind, groups };
	}

	#bounded(ms: number, signal?: AbortSignal): AbortSignal {
		return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
	}

	/** One command through boxd's exec, as the machine's user; a non-zero exit is a result with its code, not an error. */
	#exec(id: string, command: string, ms: number, signal?: AbortSignal): Promise<Result<BoxdExecResult>> {
		return call("a command in the machine", () => this.#machines.exec(id, { command, timeout: ms }), ms + CALL_SLACK_MS, signal);
	}

	/** Every way a machine, as boxd reads it back, differs from what create asked for. Pure: no call. */
	#machineDrift(spec: ComputerSpec, machine: BoxdMachine, labels: Record<string, string>): string[] {
		const found: string[] = [];
		const mismatch = (field: string, declared: unknown, actual: unknown) => found.push(`${field}: declared ${show(declared)}, read back ${show(actual)}`);
		for (const [key, value] of Object.entries(labels)) if (machine.labels?.[key] !== value) mismatch(`label ${key}`, value, machine.labels?.[key]);
		if (machine.name !== labels[NAME_LABEL]) mismatch("name", labels[NAME_LABEL], machine.name);
		if (spec.image !== BOXD_DEFAULT_IMAGE && (machine.source?.kind !== "snapshot" || machine.source.name !== spec.image)) {
			found.push(`image: declared the snapshot ${show(spec.image)}, read back ${machine.source ? `${machine.source.kind} ${show(machine.source.name)}` : "no snapshot"}`);
		}
		const network = networkOf(machine);
		if (network !== spec.network) found.push(`network: declared ${policyWords(spec.network as NetworkPolicy)}, read back ${policyWords(network)}`);
		if (machine.networking?.isolated !== true) mismatch("isolated", true, machine.networking?.isolated);
		found.push(...idleDrift(machine));
		const deleteAt = machine.deleteAt instanceof Date ? machine.deleteAt.getTime() : machine.deleteAt;
		if (!this.#deleteTimer && deleteAt !== null && deleteAt !== undefined) mismatch("delete-after", null, machine.deleteAt);
		if (this.#deleteTimer) {
			// The backstop is set DELETE_TIMER_SLACK_S past the most this computer may live. The read-back takes it from that
			// most up to CLOCK_SKEW_S beyond the slack.
			const most = Date.parse(labels[MAX_LABEL] as string);
			const latest = most + (DELETE_TIMER_SLACK_S + CLOCK_SKEW_S) * 1000;
			if (typeof deleteAt !== "number" || Number.isNaN(deleteAt) || deleteAt < most || deleteAt > latest) found.push(`delete-after: declared between ${labels[MAX_LABEL]} and ${new Date(latest).toISOString()}, read back ${show(machine.deleteAt)}`);
		}
		// A restore merges the snapshot's labels: one of agentrun's (a run, an owner, an epoch) that create did not write
		// would make list and attach match what this computer is not.
		for (const key of Object.keys(machine.labels ?? {})) {
			if (key.startsWith("agentrun.") && !(key in labels)) found.push(`label ${key}: create wrote none, read back ${show(machine.labels[key])} (from the snapshot)`);
		}
		if (!this.#inOrg(machine)) mismatch("org", this.#org, machine.org?.name);
		if (this.#size !== undefined) {
			if (machine.resources?.vcpu !== this.#size.vcpu) mismatch("vcpu", this.#size.vcpu, machine.resources?.vcpu);
			const memory = machine.resources?.memoryBytes;
			if (memory !== Number.parseInt(this.#size.memory, 10) * GIB) mismatch("memory", this.#size.memory, typeof memory === "number" ? `${memory / GIB}G` : memory);
		}
		if (!RUNNING.has(machine.status)) mismatch("status", "running", machine.status);
		return found;
	}

	/**
	 * Whether the machine is in the provider's org, by the org's name or id as boxd reads it back. machines.get takes an
	 * id alone, so every call that reads a machine by its id asks this before it uses or deletes it. A provider with no
	 * org set has none to hold a machine to.
	 */
	#inOrg(machine: BoxdMachine): boolean {
		return this.#org === undefined || machine.org?.name === this.#org || machine.org?.id === this.#org;
	}

	/** machines.get, bounded by requestMs; not_found for a machine boxd does not have. */
	#get(id: string, signal?: AbortSignal): Promise<Result<BoxdMachine>> {
		const { requestMs } = this.#timeouts;
		return call(`machines.get of ${id}`, () => this.#machines.get(id), requestMs + CALL_SLACK_MS, signal);
	}

	/** This provider's machine for ref, as boxd reads it, or why not. */
	async #own(ref: ComputerRef, signal?: AbortSignal): Promise<Result<BoxdMachine>> {
		const found = await this.#get(ref.id, signal);
		if (!found.ok) return found.error.code === "not_found" ? fail("not_found", `no boxd computer is ${ref.name} (${ref.id})`) : found;
		if (!ours(this.#name, found.value, ref.name) || !this.#inOrg(found.value) || GOING.has(found.value.status)) return fail("not_found", `no boxd computer named ${ref.name} has the id ${ref.id}`);
		return found;
	}

	/** Every machine boxd lists with these labels in the provider's org, within listMs. */
	async #list(labels: Record<string, string>, signal?: AbortSignal): Promise<Result<BoxdMachine[]>> {
		const { listMs } = this.#timeouts;
		const listed = await call("machines.list", () => this.#machines.list({ ...(this.#org === undefined ? {} : { org: this.#org }), labels }), listMs, signal);
		if (!listed.ok) return listed.error.code === "timeout" ? fail("timeout", `list did not finish within ${seconds(listMs)}: ${listed.error.message}`) : listed;
		const value = listed.value as unknown;
		if (value === null || typeof value !== "object" || typeof (value as Iterable<unknown>)[Symbol.iterator] !== "function") return vendorFail("boxd", "machines.list: an answer that is not a list of machines");
		return ok([...(value as Iterable<BoxdMachine>)].filter((machine) => typeof machine?.id === "string"));
	}

	/** #open, tried again while the bridge finds no daemon listening, until hello or helloMs in all. */
	async #openWhenListening(ref: ComputerRef, signal?: AbortSignal): Promise<Result<ComputerConnection>> {
		const until = Date.now() + this.#timeouts.helloMs;
		for (;;) {
			const opened = await this.#open(ref, signal, Math.max(1, until - Date.now()));
			if (opened.ok || !opened.notListening || signal?.aborted || Date.now() + LISTEN_RETRY_MS >= until) return opened;
			await pause(LISTEN_RETRY_MS, signal);
		}
	}

	/**
	 * One connection to the daemon, after hello, unchecked: `computerd stdio` as root, over one streamed exec, whose stdin
	 * takes the requests and whose stdout gives the replies (ExecStream, exec.d.ts). close() cancels the stream, which
	 * ends the bridge and nothing else: init runs in a session of its own.
	 */
	async #open(ref: ComputerRef, signal?: AbortSignal, helloMs = this.#timeouts.helloMs): Promise<Result<ComputerConnection> & { notListening?: true }> {
		const what = `starting the daemon's stdio bridge in ${ref.name}`;
		if (signal?.aborted) return fail("aborted", `${what} was aborted before it was called`);
		let stream: BoxdExecStream;
		try {
			stream = this.#machines.streamExec(ref.id, { command: childCommands().stdio });
		} catch (error) {
			return fail(codeOf(error), `${what} failed: ${words(error)}`);
		}
		const readable = new PassThrough();
		let stderr = "";
		let ended: unknown;
		// The bridge's end, for any reason, ends what the client reads.
		void (async () => {
			try {
				for await (const chunk of stream) if (!readable.destroyed) readable.write(Buffer.from(chunk));
			} catch (error) {
				ended = error;
			}
			readable.end();
		})();
		void (async () => {
			try {
				for await (const chunk of stream.stderr) stderr = (stderr + Buffer.from(chunk).toString("utf8")).slice(-4096);
			} catch {
				// The stream's end is read above.
			}
		})();
		const writable = new Writable({
			write(chunk: Buffer, _encoding, done) {
				try {
					stream.write(new Uint8Array(chunk));
					done();
				} catch (error) {
					done(error instanceof Error ? error : new Error(String(error)));
				}
			},
		});
		const client = new DaemonClient({ readable, writable });
		let closed: Promise<void> | undefined;
		const close = () =>
			(closed ??= (async () => {
				client.close();
				try {
					stream.close();
				} catch {
					// Closed already.
				}
			})());
		const hello = await client.call("hello", { client: `@parcha/agentrun-computer ${VERSION}` }, { signal: this.#bounded(helloMs, signal) });
		if (!hello.ok) {
			await close();
			if (signal?.aborted) return fail("aborted", `hello to the daemon in ${ref.name} was aborted`);
			if (hello.error.code === "aborted") return fail("timeout", `the daemon in ${ref.name} did not answer hello within ${seconds(helloMs)}`);
			if (hello.error.code !== "gone") return hello;
			if (ended !== undefined) return fail(codeOf(ended), `cannot reach the daemon in ${ref.name}: ${words(ended)}`);
			return { ...vendorFail("boxd", `cannot reach the daemon in ${ref.name}: ${stderr.trim() || hello.error.message}`), notListening: true };
		}
		return ok({ client, hello: hello.value as HelloResult, close });
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

	/** The live view: screen.watch on a connection of the watch's own (daemonWatch); a linux computer has no screen. */
	watch(ref: ComputerRef, handlers: ScreenWatchHandlers, options?: WatchOptions): Promise<Result<ScreenWatch>> {
		return daemonWatch(this, ref, handlers, options);
	}

	async connect(ref: ComputerRef): Promise<Result<ComputerConnection>> {
		const problem = refProblem(this.#name, this.#prefix, ref);
		if (problem) return fail("invalid", problem);
		const found = await this.#own(ref);
		if (!found.ok) return found;
		if (!RUNNING.has(found.value.status)) return fail("refused", `${ref.name} is ${found.value.status}, not running: its daemon does not run`);
		const opened = await this.#open(ref);
		if (!opened.ok) return opened;
		const { kind, groups } = this.capabilities();
		const drifted = helloDrift(opened.value.hello, { version: VERSION, kind, groups, arch: ARCH, fence: true });
		if (drifted.length === 0) return opened;
		await opened.value.close();
		return fail("refused", `the daemon in ${ref.name} does not match this provider: ${drifted.join("; ")}`);
	}

	async attach(ref: { id: string } | { labels: Record<string, string> }, { signal }: CallContext = {}): Promise<Result<AttachedComputer>> {
		const given = (typeof ref === "object" && ref !== null ? ref : {}) as { id?: unknown; labels?: unknown };
		if ((given.id === undefined) === (given.labels === undefined)) return fail("invalid", "attach takes { id } or { labels }, one of them");
		if (given.id !== undefined) {
			const id = given.id;
			if (typeof id !== "string" || !MACHINE_ID.test(id)) return fail("invalid", `${String(id)} is not a boxd machine id`);
			const found = await this.#get(id, signal);
			if (!found.ok) return found.error.code === "not_found" ? fail("not_found", `no boxd computer has the id ${id}`) : found;
			if (!ours(this.#name, found.value) || !this.#inOrg(found.value) || GOING.has(found.value.status)) return fail("not_found", `no boxd computer has the id ${id}`);
			return this.#attached(found.value, signal);
		}
		const problem = filterProblem(given.labels);
		if (problem) return fail("invalid", problem);
		const labels = given.labels as Record<string, string>;
		if (Object.keys(labels).length === 0) return fail("invalid", "attach by labels needs at least one label");
		const listed = await this.list(labels, { signal });
		if (!listed.ok) return listed;
		const said = JSON.stringify(labels);
		if (listed.value.length === 0) return fail("not_found", `no boxd computer has the labels ${said}`);
		if (listed.value.length > 1) return fail("invalid", `${listed.value.length} computers match the labels ${said}: ${listed.value.map((info) => info.ref.name).join(", ")}`);
		const found = await this.#own((listed.value[0] as ComputerInfo).ref, signal);
		if (!found.ok) return found;
		return this.#attached(found.value, signal);
	}

	/**
	 * The drift check of a computer attach did not make: its spec read back from boxd and held to what check() allows,
	 * its idle timers off and no delete timer before the most it may live, and, when it runs, its daemon, as at create.
	 * One that drifts is refused and left as it is.
	 */
	async #attached(machine: BoxdMachine, signal?: AbortSignal): Promise<Result<AttachedComputer>> {
		const name = machine.labels[NAME_LABEL] as string;
		const ref = { id: machine.id, name };
		const found: string[] = [];
		const deadline = isoOf(machine.labels[DEADLINE_LABEL]);
		if (deadline === undefined) found.push(`deadline: the label ${DEADLINE_LABEL} reads ${show(machine.labels[DEADLINE_LABEL])}, not the ISO time create writes`);
		const network = networkOf(machine);
		if (typeof network === "object") found.push(`network: ${policyWords(network)}, which this provider never makes`);
		const labels = Object.fromEntries(Object.entries(machine.labels).filter(([key]) => key !== COMPUTER_LABEL && !key.startsWith(`${COMPUTER_LABEL}.`)));
		const image = machine.labels[IMAGE_LABEL] ?? (machine.source?.kind === "snapshot" ? machine.source.name : BOXD_DEFAULT_IMAGE);
		const spec = { image, lifetimeMs: 1, network: typeof network === "object" ? "open" : network, labels } as ComputerSpec;
		found.push(...this.check(spec).map(({ field, message }) => `${field}: ${message}, read back from the computer`));
		if (machine.networking?.isolated !== true) found.push("isolated: declared true, read back false");
		// The timers, as they read now: none that would freeze the computer, and no delete before the most it may live. A
		// delete timer at or past that is the deleteTimer backstop, whichever provider's options made the computer.
		found.push(...idleDrift(machine));
		const deleteAt = machine.deleteAt instanceof Date ? machine.deleteAt.getTime() : machine.deleteAt;
		if (deleteAt !== null && deleteAt !== undefined) {
			const most = isoOf(machine.labels[MAX_LABEL]);
			if (most === undefined || !(deleteAt >= most.getTime())) {
				found.push(`delete-after: boxd deletes it at ${show(machine.deleteAt)}, before the most it may live (${MAX_LABEL} reads ${show(machine.labels[MAX_LABEL])})`);
			}
		}
		let kind: AttachedComputer["spec"]["kind"];
		let notes: string[] = [];
		if (RUNNING.has(machine.status)) {
			const opened = await this.#open(ref, signal);
			if (!opened.ok) return opened;
			try {
				const inside = await this.#checkInside(opened.value, name, network, false, signal);
				if (!inside.ok && inside.error.code !== "refused") return inside;
				if (!inside.ok) found.push(inside.error.message.replace(/^it did not match its spec: /, ""));
				else notes = inside.value;
			} finally {
				await opened.value.close();
			}
			kind = opened.value.hello.kind;
		}
		if (found.length > 0) return fail("refused", `the computer ${name} does not match this provider, so attach refuses it and it is left as it is: ${found.join("; ")}`);
		return ok({
			...ref,
			spec: {
				image,
				...(machine.source?.kind === "snapshot" && machine.source.name !== image ? { snapshot: machine.source.name } : {}),
				user: `${this.#uid}:${this.#gid}`,
				network: spec.network,
				...(typeof machine.resources?.vcpu === "number" ? { cpus: machine.resources.vcpu } : {}),
				...(typeof machine.resources?.memoryBytes === "number" ? { memoryMb: machine.resources.memoryBytes / 1024 ** 2 } : {}),
				workdir: WORK,
				...(deadline === undefined ? {} : { deadline }),
				...(kind === undefined ? {} : { kind }),
			},
			...(notes.length > 0 ? { notes } : {}),
		});
	}

	/** Settings' test: one listing of the org's machines by the provider's own label, which makes nothing. */
	async testConnection({ signal }: CallContext = {}): Promise<Result<{ detail: string }>> {
		const listed = await this.#list({ [COMPUTER_LABEL]: "1" }, signal);
		if (!listed.ok) return countTested("boxd", fail(listed.error.code, listed.error.message));
		return countTested("boxd", ok({ count: listed.value.filter((machine) => ours(this.#name, machine) && !GOING.has(machine.status)).length }));
	}

	/**
	 * Every computer this provider made that carries all of these labels: running (standby included, which wakes on the
	 * next call) or stopped (hibernated, stopped or failed), each one's network read from boxd's own report of it.
	 */
	async list(labels: Record<string, string>, { signal }: CallContext = {}): Promise<Result<ComputerInfo[]>> {
		const problem = filterProblem(labels);
		if (problem) return fail("invalid", problem);
		const listed = await this.#list({ ...labels, [COMPUTER_LABEL]: "1" }, signal);
		if (!listed.ok) return listed;
		const infos: ComputerInfo[] = [];
		for (const machine of listed.value) {
			if (!ours(this.#name, machine) || GOING.has(machine.status) || !Object.entries(labels).every(([key, value]) => machine.labels[key] === value)) continue;
			infos.push({
				ref: { id: machine.id, name: machine.labels[NAME_LABEL] as string },
				labels: { ...machine.labels },
				deadline: isoOf(machine.labels[DEADLINE_LABEL]),
				state: RUNNING.has(machine.status) ? "running" : "stopped",
				network: networkOf(machine),
			});
		}
		return ok(infos);
	}

	/** boxd reads the egress allowlist back (machines.get). A change is refused: the provider fixes the network at create. */
	async network(ref: ComputerRef, policy?: NetworkSpec, { signal }: CallContext = {}): Promise<Result<NetworkPolicy>> {
		const problem = refProblem(this.#name, this.#prefix, ref);
		if (problem) return fail("invalid", problem);
		const fixed = "a boxd computer's network is fixed at create: create a new computer";
		if (policy !== undefined && policy !== "none") {
			const wider = policy === "open" || (typeof policy === "object" && policy !== null && "allow" in policy);
			return fail("refused", wider ? `${OWN_NETWORK_ONLY}; ${fixed}` : `${fixed}; a network is "none"`);
		}
		const found = await this.#own(ref, signal);
		if (!found.ok) return found;
		const read = networkOf(found.value);
		if (policy === undefined || policy === read) return ok(read);
		return fail("refused", `${fixed}: ${ref.name} reads back network ${policyWords(read)}, not ${policy}`);
	}

	/**
	 * Moves init's own deadline to now + ttlMs, then the deadline label to the time init took, and returns the deadline
	 * the computer holds; never earlier than the current deadline, never past create's time plus the cap, which init was
	 * given as its maximum. A provider runs one extend of a computer at a time, each reading the deadline the one before
	 * it left. Another provider may extend the same computer meanwhile, so the label never moves back, and after writing
	 * it extend asks init once more: a deadline another extend moved later is the one the label takes.
	 */
	async extend(ref: ComputerRef, ttlMs: number, { signal }: CallContext = {}): Promise<Result<{ deadline: Date }>> {
		const problem = refProblem(this.#name, this.#prefix, ref);
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
		const machine = found.value;
		if (!RUNNING.has(machine.status)) return fail("refused", `${ref.name} is ${machine.status}, not running`);
		const most = isoOf(machine.labels[MAX_LABEL]);
		if (most === undefined) return fail("refused", `${ref.name}'s label ${MAX_LABEL} reads ${show(machine.labels[MAX_LABEL])}, so the most it may live is unknown`);
		const current = isoOf(machine.labels[DEADLINE_LABEL]);
		if (current === undefined) return fail("refused", `${ref.name}'s label ${DEADLINE_LABEL} reads ${show(machine.labels[DEADLINE_LABEL])}, so its deadline is unknown`);
		const target = Date.now() + ttlMs;
		if (target > most.getTime()) {
			return fail("limit", `${new Date(target).toISOString()} is past ${most.toISOString()}, the most this computer may live: create's time plus this provider's ${seconds(this.#maxLifetimeMs)} cap`);
		}
		if (target <= current.getTime()) return fail("refused", `${new Date(target).toISOString()} is before ${ref.name}'s deadline, ${current.toISOString()}: extend never moves a deadline earlier`);
		const at = new Date(target).toISOString();
		const opened = await this.#open(ref, signal);
		if (!opened.ok) return fail(opened.error.code, `nothing moved: ${opened.error.message}`);
		try {
			const { client } = opened.value;
			const extended = await client.call("deadline.extend", { at }, { signal: this.#bounded(this.#timeouts.helloMs, signal) });
			if (!extended.ok) return fail(extended.error.code, `init's deadline did not move, so nothing did: ${extended.error.message}`);
			const answered = Date.parse(extended.value.at);
			let took = new Date(Number.isNaN(answered) ? at : answered);
			// The label after init: the janitor reads it, and a label behind init's deadline only ends the computer earlier.
			// Then init again, with the time just written. Init holding it still means every later extend writes its label
			// after this one. Init refusing it as earlier means another extend moved init later, and this label may have
			// landed on that one's: the label takes init's deadline, and the check runs again.
			for (let round = 0; round < EXTEND_ROUNDS; round++) {
				const moved = await this.#labelDeadline(ref, took, signal);
				if (!moved.ok) return fail(moved.error.code, `init's deadline moved to ${took.toISOString()}, and the label ${DEADLINE_LABEL} did not: ${moved.error.message}; the janitor ends the computer at the deadline the label holds`);
				const held = await client.call("deadline.extend", { at: took.toISOString() }, { signal: this.#bounded(this.#timeouts.helloMs, signal) });
				const later = held.ok ? isoOf(held.value.at) : held.error.code === "invalid" ? laterDeadline(held.error.message) : undefined;
				if (later === undefined) {
					const why = held.ok ? `init answered ${show(held.value.at)}, not an ISO time` : held.error.message;
					return fail(held.ok ? "refused" : held.error.code, `init's deadline and the label ${DEADLINE_LABEL} moved to ${took.toISOString()}, and init could not be asked whether another extend moved its deadline later: ${why}`);
				}
				if (later.getTime() <= took.getTime()) return ok({ deadline: took });
				took = later;
			}
			return fail("refused", `other extends kept moving ${ref.name}'s deadline: init holds ${took.toISOString()}, and the label ${DEADLINE_LABEL} may be behind it, where the janitor ends the computer`);
		} finally {
			await opened.value.close();
		}
	}

	/** Writes the deadline label unless it already holds this time or a later one: the label never moves back. */
	async #labelDeadline(ref: ComputerRef, at: Date, signal?: AbortSignal): Promise<Result<void>> {
		const found = await this.#own(ref, signal);
		if (!found.ok) return found;
		const holds = isoOf(found.value.labels[DEADLINE_LABEL]);
		if (holds !== undefined && holds.getTime() >= at.getTime()) return ok(undefined);
		const { requestMs } = this.#timeouts;
		const moved = await call(`machines.updateLabels of ${ref.name}`, () => this.#machines.updateLabels(ref.id, { set: { [DEADLINE_LABEL]: at.toISOString() } }), requestMs + CALL_SLACK_MS, signal);
		return moved.ok ? ok(undefined) : moved;
	}

	/**
	 * delete reads the machine back to check it is this provider's and in its org, then deletes it, both never signalled,
	 * so a release after an abort still sends the delete; it is idempotent: one boxd no longer has is ok. A delete is not
	 * read back at once by every call, so release then waits (#settle) until get answers not found and the listing no
	 * longer shows it, within goneMs and the caller's signal, the one step the signal ends.
	 */
	async release(ref: ComputerRef, how: ReleaseHow, { signal }: CallContext = {}): Promise<Result<void>> {
		const problem = refProblem(this.#name, this.#prefix, ref);
		if (problem) return fail("invalid", problem);
		if (how !== "stop" && how !== "delete") return fail("invalid", `release is "stop" or "delete", not ${String(how)}`);
		if (how === "stop") return fail("unsupported", STOP);
		const found = await this.#get(ref.id);
		if (!found.ok) return found.error.code === "not_found" ? ok(undefined) : found;
		if (!ours(this.#name, found.value, ref.name) || !this.#inOrg(found.value)) return fail("not_found", `no boxd computer is ${ref.name} (${ref.id}): the machine is not this provider's, so it is left as it is`);
		this.#end(ref.name);
		const deleted = await this.#delete(ref.id);
		return deleted.ok ? this.#settle(ref, signal) : deleted;
	}

	/**
	 * Waits, through waitUntil, until boxd reads the machine gone (get answers not found, or destroyed) and its label
	 * listing no longer shows it, twice running. Pauses double from pollMs to 5 s, bounded by goneMs and the caller's
	 * signal; a failed read ends the wait with that error.
	 */
	async #settle(ref: ComputerRef, signal?: AbortSignal): Promise<Result<void>> {
		type Read = { failed: Result<never> } | { settled: true } | { last: string };
		let agreed = 0;
		let last = "unread";
		const read = async (readSignal: AbortSignal): Promise<Read> => {
			const got = await this.#get(ref.id, readSignal);
			if (!got.ok && got.error.code !== "not_found") {
				if (got.error.code === "aborted") return { last };
				return { failed: fail(got.error.code, `release of ${ref.name}: reading it back failed (${got.error.message}); it last read ${last}`) };
			}
			const status = got.ok ? got.value.status : undefined;
			last = status ?? "gone (not found)";
			if (status !== undefined && !GOING.has(status)) {
				agreed = 0;
				return { last };
			}
			const listed = await this.#list({ [COMPUTER_LABEL]: "1", [NAME_LABEL]: ref.name }, readSignal);
			if (!listed.ok) {
				if (listed.error.code === "aborted") return { last };
				return { failed: fail(listed.error.code, `release of ${ref.name}: the listing failed (${listed.error.message}); it last read ${last}`) };
			}
			if (listed.value.some((machine) => machine.id === ref.id && !GOING.has(machine.status))) {
				agreed = 0;
				last = `${last}, still listed`;
				return { last };
			}
			return ++agreed >= GONE_ROUNDS ? { settled: true } : { last };
		};
		const { pollMs, goneMs } = this.#timeouts;
		const waited = await waitUntil(read, (state) => !("last" in state), {
			boundMs: goneMs,
			...(signal ? { signal } : {}),
			minMs: Math.min(pollMs, RELEASE_POLL_MAX_MS),
			maxMs: RELEASE_POLL_MAX_MS,
			what: `${ref.name} to be gone after its delete`,
			describe: (state) => ("last" in state ? `boxd read it ${state.last}` : "done"),
		});
		if (!waited.ok) return waited;
		return "failed" in waited.value ? waited.value.failed : ok(undefined);
	}
}
