// The Daytona host: Daytona sandboxes over Daytona's v0 REST API with fetch (no SDK). Daytona's toolbox daemon is the
// sandbox's first process, so computerd is a child: its upload goes through the toolbox's file API, and every command
// (install, init's start, the stdio bridge, an Archil computer's root steps) is a session command, its output read from
// the command's log stream and its stdin sent as the command's input. The rest of the computer is the shared
// machine-host adapter's (./hosted/provider.ts). Every Daytona fact used here is cited in the README's Daytona section.
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DAYTONA, DAYTONA_DEFAULT_SNAPSHOT, DAYTONA_GPU_REGION, DAYTONA_GPU_SNAPSHOT, type DaytonaGpuSnapshot, daytonaGpu, daytonaGpuSnapshot } from "./descriptors/daytona.js";
import { COMPUTER_LABEL, DEADLINE_LABEL } from "./drift.js";
import type { HostCall, HostFacts, Machine, MachineHost, MachineProcess, MachineRequest } from "./host.js";
import { HostedProvider, type HostedOptions, type HostedTimeouts, IMAGE_LABEL, ours } from "./hosted/provider.js";
import { shellLine } from "./hosted/scripts.js";
import type { KindCapabilities } from "./kinds.js";
import type { MountKind } from "./mount.js";
import { ARCHIL_HELPER, type ArchilEgress, archilEgressOf } from "./mount-archil.js";
import { MAX_LINE_BYTES } from "./protocol.js";
import { type ComputerSpec, checkGpu, type NetworkPolicy, type Refusal } from "./provider.js";
import { type ComputerError, type ComputerErrorCode, errorOf, failFor, ok, type Result, vendorFail } from "./result.js";
import { countTested } from "./test-connection.js";
import { waitUntil } from "./wait.js";

/** This module's failures: one with code vendor names Daytona. */
const fail = failFor("daytona");

/** The parts of a WebSocket the host uses: Node's global WebSocket, or a stand-in in tests. */
export interface WebSocketLike {
	binaryType: string;
	addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown; code?: number; message?: string }) => void): void;
	close(code?: number): void;
}

export type WebSocketFactory = (url: string, init: { headers: Record<string, string>; protocols: string[] }) => WebSocketLike;

/** The adapter's bounds, and Daytona's own: the first pause before a retried request (each next one doubles). */
export type DaytonaTimeouts = HostedTimeouts & { retryMs: number };

/** The Daytona provider's options: the key and Daytona's own settings, then the shared adapter's (HostedOptions). */
export interface DaytonaProviderOptions extends Omit<HostedOptions, "label" | "kind" | "desktop" | "maxLifetimeMs" | "timeouts"> {
	/** The Daytona API key. The caller passes it; this provider never reads the environment and never puts it in a computer. */
	apiKey: string;
	/** Default https://app.daytona.io/api. */
	apiUrl?: string;
	/** Go's name for the sandboxes' architecture, which hello must report. Default amd64. */
	arch?: "amd64" | "arm64";
	/** The class the snapshots this provider is given make: container (default) or linux-vm. */
	sandboxClass?: "container" | "linux-vm";
	/** The Daytona target (region); default the organization's. */
	target?: string;
	/**
	 * The egress gateway an Archil computer's archil client reaches Archil through, `<IPv4 gateway>:<mount lane>:<data
	 * lane>` such as 10.60.0.40:18100:42050 (parcha-proxy's archil-egress): for a target whose runners reach Archil only
	 * through it. Unset, the client reaches Archil as the sandbox's network allows.
	 */
	archilEgress?: string;
	/**
	 * The snapshot GPU computers are made from: one of ours, box/Dockerfile built with a GPU (box/build-daytona.py --gpu
	 * H100 prints its name, agentrun-archil-gpu-h100-<hash>), whose user is root; its GPU is the one its name says.
	 * Default Daytona's own daytona-gpu. Either way a GPU computer takes no mount: Daytona's GPU host gives no /dev/fuse.
	 */
	gpuSnapshot?: string;
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
	/** The GPU type Daytona assigned (its GpuType enum), when the sandbox has GPUs. */
	gpuType?: string;
	memory?: number;
	disk?: number;
	autoStopInterval?: number;
	autoDeleteInterval?: number;
	autoDestroyAt?: string;
	/** When Daytona made the sandbox, by its clock: the adapter keeps the oldest of two machines one request made. */
	createdAt?: string;
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
	/** This one status is a value, with its status, not a failure (and not retried). */
	answerStatus?: number;
}

/**
 * The mount kinds a Daytona computer takes: an Archil mount of the run's folder (mount-archil.ts), made as root through
 * the toolbox, from a snapshot of box/Dockerfile, with the daemon user agentrun-tool (daemonUser "2510:2510").
 */
export const MOUNT: readonly MountKind[] = DAYTONA.mounts;

/** The machine kind, groups and GPUs of its one configuration (its descriptor's): a linux computer, with GPUs when asked. */
export const CAPABILITIES: readonly KindCapabilities[] = DAYTONA.capabilities;

/**
 * A DaytonaProvider from its options alone; it reads no environment, so the key, the API URL (default Daytona's own) and
 * the target are the caller's: serve passes its DAYTONA_API_KEY, DAYTONA_API_URL and DAYTONA_TARGET, the conformance
 * module the settings it reads. Throws in words when an option is missing or wrong, never echoing the key.
 */
export function create(options: DaytonaProviderOptions): DaytonaProvider {
	const { apiKey } = options ?? ({} as DaytonaProviderOptions);
	if (typeof apiKey !== "string" || apiKey === "") throw new Error("options.apiKey, the Daytona API key, is required: the provider reads no environment, so the caller passes it");
	return new DaytonaProvider(options);
}

/** The conformance CLI's module for Daytona: the run's idle stop and auto-delete, its snapshot, notes and drifted twin. */
export const conformance = () => import("./conformance/daytona.js");

const DEFAULT_API_URL = "https://app.daytona.io/api";
/** autoDeleteInterval when autoDeleteMinutes is unset: negative is disabled. */
const NO_AUTO_DELETE = -1;
const DEFAULT_REQUEST_MS = 30_000;
const DEFAULT_RETRY_MS = 500;
const DEFAULT_POLL_MS = 1_000;
const RETRY_ATTEMPTS = 3;
const DELETE_ATTEMPTS = 4;
const LISTED_ROUNDS = 2;
/** The longest pause between two reads while a stop waits: the pauses double from pollMs up to it. */
const STOP_POLL_MAX_MS = 5_000;
/** How long a command's log stream may trail its exit code before the host stops reading it. */
const LOG_GRACE_MS = 5_000;
const MAX_PAGES = 1000;
const MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
/** Daytona's TTL is whole minutes, and its clock is not ours: the vendor's end may come this long after the deadline. */
const LIFETIME_SLACK_MS = 60_000 + 120_000;
/** The toolbox's port, on every interface of the sandbox (daytonaio/daytona@b5a5d9e7 apps/daemon/pkg/toolbox/config/config.go:6). */
const TOOLBOX_PORT = 2280;
/**
 * Daytona's own path sockets outside /run: its D-Bus session bus, /tmp/dbus-<10 characters> (the live baseline's
 * isolation.vendor-agent connected to /tmp/dbus-Y8OW6E3FDx as the tool user). Create closes them to the tool user.
 */
export const DAYTONA_SOCKETS: readonly string[] = ["/tmp/dbus-*"];
const QUOTA = /quota|capacity|limit exceeded|too many/i;
const STARTING = new Set(["creating", "restoring", "starting", "pending_build", "building_snapshot", "pulling_snapshot", "resizing", "snapshotting", "forking", "resuming", "unknown"]);
const GONE = new Set(["destroyed", "destroying"]);
const STOPPED = new Set(["stopped", "archived", "paused"]);
/** On the way from started to stopped or paused. */
const LEAVING = new Set(["stopping", "pausing"]);
const FAILED = new Set(["error", "build_failed"]);
const OUT = Buffer.from([1, 1, 1]);
const ERR = Buffer.from([2, 2, 2]);
/** A line the client wrote, echoed back: a request or a notification is never a daemon's reply. */
const ECHO = /^\{"jsonrpc":"2\.0",("id":\d+,)?"method":/;

const isWhole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const decoder = new TextDecoder();
const show = (value: unknown) => (value === undefined ? "nothing" : JSON.stringify(value));
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

/** A sandbox's state as the adapter reads a machine's. A stopping one is on its way to stopped: its daemon is going. */
function stateOf(sb: Sandbox): Machine["state"] {
	const state = sb.state ?? "";
	if (GONE.has(state) || sb.desiredState === "destroyed") return "going";
	if (state === "started") return "running";
	if (STARTING.has(state)) return "starting";
	if (FAILED.has(state)) return "failed";
	return "stopped";
}

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
	return "vendor";
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
	readonly #requestMs: number;
	readonly #retryMs: number;

	constructor(base: string, key: string, fetcher: typeof fetch, requestMs: number, retryMs: number) {
		this.#base = base.replace(/\/+$/, "");
		this.#key = key;
		this.#fetch = fetcher;
		this.#requestMs = requestMs;
		this.#retryMs = retryMs;
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
		const timeoutMs = init.timeoutMs ?? this.#requestMs;
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
				if (response.ok || response.status === init.answerStatus || (init.anyStatus === true && response.status < 500 && response.status !== 429)) return ok({ status: response.status, bytes });
				const text = decoder.decode(bytes).replace(/\s+/g, " ").slice(0, 300);
				retryable = response.status === 429 || response.status >= 500;
				failure = errorOf(codeOf(response.status, text), `${what}: ${response.status} ${text}`, "daytona");
			} catch (cause) {
				if (signal?.aborted) return fail("aborted", `${what} was aborted`);
				if (timeout.aborted) failure = { code: "timeout", message: `${what} did not answer within ${timeoutMs / 1000} s` };
				else if (redirected(cause)) return vendorFail("daytona", `${what}: Daytona answered with a redirect, which is never followed: it would carry the key`);
				else failure = { code: "vendor", vendor: "daytona", message: `${what}: ${(cause as Error).message}` };
			}
			if (!retryable || attempt >= attempts) return { ok: false, error: failure };
			await sleep(this.#retryMs * 2 ** (attempt - 1), signal);
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
		return typeof sb?.id === "string" ? ok(sb) : vendorFail("daytona", `GET /sandbox/${idOrName}: no sandbox in the answer`);
	}
}

/** What create asked Daytona for, held against what it reads back. */
interface SandboxExpected {
	sandboxClass: string;
	autoStopInterval: number;
	autoDeleteInterval: number;
	/** The GPU snapshot a GPU computer is made from, and its GPU; undefined for a computer with none. */
	gpu: DaytonaGpuSnapshot | undefined;
}

/**
 * Every way a sandbox, as Daytona reads it back, differs from the create options this host gave it that the adapter does
 * not read itself (it reads labels, the network and the state). Pure: no call.
 */
function sandboxDrift(sb: Sandbox, expected: SandboxExpected): string[] {
	const found: string[] = [];
	const mismatch = (field: string, declared: unknown, actual: unknown) => found.push(`${field}: declared ${show(declared)}, read back ${show(actual)}`);
	const labels = sb.labels ?? {};
	// A GPU computer is made from the provider's GPU snapshot, whatever image named it. Daytona's default snapshot is
	// whichever it names: a computer made from it is not held to a name.
	const image = labels[IMAGE_LABEL];
	if (expected.gpu !== undefined) {
		if (sb.snapshot !== expected.gpu.snapshot) mismatch("snapshot", expected.gpu.snapshot, sb.snapshot);
	} else if (image !== undefined && image !== DAYTONA_DEFAULT_SNAPSHOT && sb.snapshot !== image) mismatch("snapshot", image, sb.snapshot);
	if (sb.autoStopInterval !== expected.autoStopInterval) mismatch("autoStopInterval", expected.autoStopInterval, sb.autoStopInterval);
	if (sb.autoDeleteInterval !== expected.autoDeleteInterval) mismatch("autoDeleteInterval", expected.autoDeleteInterval, sb.autoDeleteInterval);
	const deadline = labels[DEADLINE_LABEL];
	const ends = typeof sb.autoDestroyAt === "string" ? Date.parse(sb.autoDestroyAt) : Number.NaN;
	if (deadline !== undefined) {
		if (Number.isNaN(ends)) found.push(`autoDestroyAt: declared a TTL ending by ${deadline}, read back ${show(sb.autoDestroyAt)}: Daytona would not end the computer`);
		else if (ends > Date.parse(deadline) + LIFETIME_SLACK_MS) found.push(`autoDestroyAt: ${sb.autoDestroyAt} is past the deadline ${deadline} by more than the TTL's minute and ${(LIFETIME_SLACK_MS - 60_000) / 60_000} minutes of clock skew`);
	}
	if (sb.sandboxClass !== expected.sandboxClass) mismatch("sandboxClass", expected.sandboxClass, sb.sandboxClass);
	if (sb.public !== false) mismatch("public", false, sb.public);
	if (sb.kvm === true) mismatch("kvm", false, sb.kvm);
	// The GPUs read back, held to the GPU snapshot's own (a create sends none) for a GPU computer, none else.
	const gpus = expected.gpu === undefined ? 0 : expected.gpu.count;
	if ((sb.gpu ?? 0) !== gpus) mismatch("gpu", gpus, sb.gpu);
	if (expected.gpu !== undefined && sb.gpuType !== expected.gpu.type) mismatch("gpuType", expected.gpu.type, sb.gpuType);
	if (Array.isArray(sb.volumes) ? sb.volumes.length > 0 : sb.volumes !== undefined && sb.volumes !== null) mismatch("volumes", [], sb.volumes);
	if (typeof sb.linkedSandboxId === "string" && sb.linkedSandboxId !== "") mismatch("linkedSandboxId", "none", sb.linkedSandboxId);
	return found;
}

/** A stream fed as the log stream delivers, read as an async iterable until it ends or fails. */
function feed(): { push(bytes: Uint8Array): void; end(error?: Error): void; iterable: AsyncIterable<Uint8Array> } {
	const queue: Uint8Array[] = [];
	let ended = false;
	let failure: Error | undefined;
	let wake: (() => void) | undefined;
	const nudge = () => {
		const waiting = wake;
		wake = undefined;
		waiting?.();
	};
	return {
		push(bytes) {
			if (ended) return;
			queue.push(bytes);
			nudge();
		},
		end(error) {
			if (ended) return;
			ended = true;
			failure = error;
			nudge();
		},
		iterable: {
			async *[Symbol.asyncIterator]() {
				for (;;) {
					const next = queue.shift();
					if (next !== undefined) yield next;
					else if (failure !== undefined) throw failure;
					else if (ended) return;
					else await new Promise<void>((done) => (wake = done));
				}
			},
		},
	};
}

/** Daytona's sandboxes as a MachineHost (../host.ts). */
class DaytonaHost implements MachineHost {
	readonly id = "daytona";
	readonly facts: HostFacts;
	readonly #rest: Rest;
	readonly #webSocket: WebSocketFactory;
	readonly #class: "container" | "linux-vm";
	readonly #target: string | undefined;
	readonly #archilEgress: ArchilEgress | undefined;
	/** The snapshot its GPU computers are made from, and their GPU. */
	readonly #gpu: DaytonaGpuSnapshot;
	readonly #autoStop: number;
	readonly #autoDelete: number;
	readonly #pollMs: number;
	/** Each sandbox's toolbox URL, by id, once read: let go of at its delete. */
	readonly #toolboxes = new Map<string, string>();
	/** Whether each sandbox this host made was asked for a GPU, by id: what its read-back is held to. */
	readonly #made = new Map<string, boolean>();

	constructor(options: { rest: Rest; webSocket: WebSocketFactory; arch: "amd64" | "arm64"; sandboxClass: "container" | "linux-vm"; target?: string; archilEgress?: ArchilEgress; gpu: DaytonaGpuSnapshot; autoStop: number; autoDelete: number; pollMs: number }) {
		this.#rest = options.rest;
		this.#webSocket = options.webSocket;
		this.#class = options.sandboxClass;
		this.#target = options.target;
		this.#archilEgress = options.archilEgress;
		this.#gpu = options.gpu;
		this.#autoStop = options.autoStop;
		this.#autoDelete = options.autoDelete;
		this.#pollMs = options.pollMs;
		// daemon child: Daytona's toolbox daemon is the sandbox's first process, and init a command started through it.
		// maxLifetimeMs is the 30 days check() has always given; Daytona's TTL is in whole minutes and documents no cap of
		// its own. The toolbox listens on 2280 on every interface and runs commands for whoever reaches it, so init starts
		// with --own-network, and network none is all a computer takes. Its D-Bus session bus in /tmp, which no network
		// namespace cuts, is closed to the tool user before init starts (vendorSockets).
		this.facts = {
			daemon: "child",
			isolation: options.sandboxClass === "linux-vm" ? "vm" : "container",
			lifetime: "vendor",
			maxLifetimeMs: MAX_LIFETIME_MS,
			arch: options.arch,
			vendorAgentPorts: [TOOLBOX_PORT],
			vendorSockets: [...DAYTONA_SOCKETS],
			networkReadBack: true,
			network: [...DAYTONA.network],
			mounts: [...MOUNT],
			release: ["stop", "delete"],
			// autoDeleteInterval 0: Daytona deletes a sandbox as soon as it stops, so a stop keeps no computer.
			stopDeletes: options.autoDelete === 0,
			// A GPU sandbox's limits are stated in gpu: its stop deletes it, it runs in region earth, its size is per GPU.
			gpu: daytonaGpu(options.gpu.snapshot === DAYTONA_GPU_SNAPSHOT ? undefined : options.gpu.snapshot),
		};
	}

	errorCode(error: unknown): ComputerErrorCode {
		const name = (error as { name?: unknown } | null)?.name;
		if (name === "AbortError") return "aborted";
		if (name === "TimeoutError") return "timeout";
		return "vendor";
	}

	/**
	 * A snapshot name has no control characters; a GPU computer is made from the provider's GPU snapshot, which a spec
	 * names, or Daytona's default, never another. No call.
	 */
	check(spec: ComputerSpec): Refusal[] {
		const given = (typeof spec === "object" && spec !== null ? spec : {}) as unknown as Record<string, unknown>;
		const { image } = given;
		const refusals: Refusal[] = [];
		if (typeof image === "string" && image !== "" && image.trim() === "") refusals.push({ field: "image", message: `an image is the id or name of a Daytona snapshot, or "${DAYTONA_DEFAULT_SNAPSHOT}" for Daytona's default snapshot` });
		else if (typeof image === "string" && /[\x01-\x1f]/.test(image)) refusals.push({ field: "image", message: "a snapshot name has no control characters" });
		const gpuSnapshot = this.#gpu.snapshot;
		if (given.gpu !== undefined && checkGpu(given.gpu, this.facts, given.mount).length === 0 && typeof image === "string" && image !== DAYTONA_DEFAULT_SNAPSHOT && image !== gpuSnapshot) {
			refusals.push({
				field: "image",
				message: `a Daytona GPU computer here is made from the GPU snapshot ${gpuSnapshot} alone, not ${JSON.stringify(image)}: give "${gpuSnapshot}" or "${DAYTONA_DEFAULT_SNAPSHOT}"; no other snapshot is proven to give a GPU computer`,
			});
		}
		return refusals;
	}

	/** The autoDeleteInterval a sandbox is made and read back with: 0 for a GPU sandbox, which a stop deletes; else the option's. */
	#autoDeleteFor(gpu: boolean): number {
		return gpu ? 0 : this.#autoDelete;
	}

	/** A sandbox as the adapter reads a machine, its create options held to what this host asked for. */
	#machineOf(sb: Sandbox): Machine {
		// A sandbox this host made is held to what it asked; another (attach) to the GPU it reports.
		const gpu = this.#made.get(sb.id) ?? (isWhole(sb.gpu) && sb.gpu > 0);
		const drift = sandboxDrift(sb, { sandboxClass: this.#class, autoStopInterval: this.#autoStop, autoDeleteInterval: this.#autoDeleteFor(gpu), gpu: gpu ? this.#gpu : undefined });
		const ends = typeof sb.autoDestroyAt === "string" ? Date.parse(sb.autoDestroyAt) : Number.NaN;
		const made = typeof sb.createdAt === "string" ? Date.parse(sb.createdAt) : Number.NaN;
		return {
			id: sb.id,
			labels: { ...(sb.labels ?? {}) },
			state: stateOf(sb),
			network: networkOf(sb),
			...(typeof sb.snapshot === "string" ? { image: { resolved: sb.snapshot } } : {}),
			...(Number.isNaN(made) ? {} : { createdAt: new Date(made) }),
			...(Number.isNaN(ends) ? {} : { endsAt: new Date(ends) }),
			...(drift.length > 0 ? { drift } : {}),
			...(isWhole(sb.cpu) || isWhole(sb.memory) ? { size: { ...(isWhole(sb.cpu) ? { cpus: sb.cpu } : {}), ...(isWhole(sb.memory) ? { memoryMb: sb.memory * 1024 } : {}) } } : {}),
			...(isWhole(sb.gpu) && sb.gpu > 0 ? { gpu: { type: String(sb.gpuType), count: sb.gpu } } : {}),
			...(typeof sb.errorReason === "string" && sb.errorReason !== "" ? { why: sb.errorReason } : {}),
		};
	}

	/**
	 * POST /sandbox: its native name and labels, the lifetime as a TTL in whole minutes, the idle stop and auto-delete,
	 * no public port, and network none (block-all) unless the adapter asks open (an Archil computer's root). A GPU
	 * computer is made from the GPU snapshot in region earth, ephemeral (its stop deletes it). Never cancelled: the adapter
	 * races it, and deletes by name one whose answer never comes. A name Daytona already holds (409) made nothing: exists.
	 */
	async create(req: MachineRequest, ctx: HostCall): Promise<Result<{ id: string }>> {
		const gpu = req.gpu !== undefined;
		const body = {
			name: req.name,
			// "default" sends no snapshot, and Daytona makes the sandbox from its default snapshot.
			...(gpu ? { snapshot: this.#gpu.snapshot } : req.image === DAYTONA_DEFAULT_SNAPSHOT ? {} : { snapshot: req.image }),
			labels: { ...req.labels },
			env: {},
			public: false,
			// A GPU sandbox runs in region earth alone, whatever the provider's target.
			...(gpu ? { target: DAYTONA_GPU_REGION } : this.#target === undefined ? {} : { target: this.#target }),
			ttlMinutes: Math.max(1, Math.ceil((req.lifetimeMs ?? 0) / 60_000)),
			autoStopInterval: this.#autoStop,
			// A GPU sandbox's stop deletes it (no pause, no snapshot), so it is asked for and read back as deleted at stop:
			// autoDeleteInterval 0 is Daytona's ephemeral (its SDK's ephemeral sets it; CreateSandbox has no ephemeral field).
			autoDeleteInterval: this.#autoDeleteFor(gpu),
			networkBlockAll: req.network === "none",
			// No resource field (cpu, gpu, gpuType, memory, disk): a snapshot carries its own, and Daytona refuses a create that
			// names a snapshot and sends any (400 "Cannot specify Sandbox resources when using a snapshot"). A GPU computer's
			// GPU is the snapshot's, held in the read-back.
		};
		const posted = await this.#rest.json("POST", this.#rest.sandbox(), { json: body, timeoutMs: ctx.timeoutMs });
		if (!posted.ok) {
			if (/: 409 /.test(posted.error.message)) return fail("exists", `Daytona already has a sandbox named ${req.name}: ${posted.error.message}`);
			return posted;
		}
		const id = (posted.value as Sandbox | null)?.id;
		if (typeof id !== "string" || id === "") return vendorFail("daytona", "POST /sandbox: no sandbox id in the answer");
		this.#made.set(id, gpu);
		return ok({ id });
	}

	/** GET /sandbox/{id}; one Daytona answers 404 for, or reads destroyed, is none. */
	async get(id: string, ctx: HostCall): Promise<Result<Machine | undefined>> {
		const found = await this.#rest.get(id, ctx.signal);
		if (!found.ok) return found;
		return ok(found.value === undefined || found.value.state === "destroyed" ? undefined : this.#machineOf(found.value));
	}

	/** Every sandbox with the adapter's label, all pages: one label query, filtered here by the rest of the labels. */
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
			if (items === undefined) return vendorFail("daytona", "GET /sandbox: the listing is not a page of sandboxes");
			found.push(...items.filter((sb) => typeof sb?.id === "string"));
			const next = Array.isArray(value) ? undefined : value?.nextCursor;
			if (typeof next !== "string" || next === "") return ok(found);
			if (seen.has(next)) return vendorFail("daytona", `GET /sandbox: the listing's cursor ${next} came back twice`);
			seen.add(next);
			cursor = next;
		}
		return vendorFail("daytona", `GET /sandbox: the listing ran past ${MAX_PAGES} pages`);
	}

	/**
	 * Every sandbox the listing shows with these labels (destroyed ones are gone), each read back where the listing leaves
	 * its network out. Daytona's listing is asked for the adapter's label alone, as it always was, and filtered here.
	 */
	async list(labels: Record<string, string>, ctx: HostCall): Promise<Result<Machine[]>> {
		const listed = await this.#listOwn(ctx.signal);
		if (!listed.ok) return listed;
		const machines: Machine[] = [];
		for (const item of listed.value) {
			if (item.state === "destroyed" || !Object.entries(labels).every(([key, value]) => item.labels?.[key] === value)) continue;
			let sb: Sandbox = item;
			if (item.networkBlockAll === undefined) {
				const read = await this.#rest.get(item.id, ctx.signal);
				if (!read.ok) return read;
				if (read.value === undefined || read.value.state === "destroyed") continue;
				sb = read.value;
			}
			machines.push(this.#machineOf(sb));
		}
		return ok(machines);
	}

	/**
	 * Deletes a sandbox and makes sure it is going: a DELETE that fails counts as done only when the sandbox is gone or
	 * being destroyed; a forced stop comes before the last attempt. Never signalled: a delete that cleans up after an abort
	 * must outlive it.
	 */
	async delete(id: string, ctx: HostCall): Promise<Result<void>> {
		this.#toolboxes.delete(id);
		this.#made.delete(id);
		let failure: ComputerError | undefined;
		for (let attempt = 1; attempt <= DELETE_ATTEMPTS; attempt++) {
			const removed = await this.#rest.call("DELETE", this.#rest.sandbox(id), { retry: true, timeoutMs: ctx.timeoutMs });
			if (removed.ok || removed.error.code === "not_found") return ok(undefined);
			failure = removed.error;
			const found = await this.#rest.get(id);
			if (found.ok && (found.value === undefined || GONE.has(found.value.state ?? ""))) return ok(undefined);
			if (attempt === DELETE_ATTEMPTS - 1) await this.#rest.call("POST", this.#rest.sandbox(id, "/stop?force=true"), { timeoutMs: ctx.timeoutMs });
			if (attempt < DELETE_ATTEMPTS) await sleep(DEFAULT_RETRY_MS);
		}
		return { ok: false, error: failure ?? { code: "vendor", vendor: "daytona", message: `could not delete ${id}` } };
	}

	/** The sandbox's toolbox, as an https URL: never another scheme, so the key is never sent in the clear. */
	async #toolbox(id: string, signal?: AbortSignal): Promise<Result<string>> {
		const known = this.#toolboxes.get(id);
		if (known !== undefined) return ok(known);
		const found = await this.#rest.get(id, signal);
		if (!found.ok) return found;
		if (found.value === undefined) return fail("not_found", `Daytona has no sandbox ${id}`);
		let proxy = found.value.toolboxProxyUrl;
		if (typeof proxy !== "string" || proxy === "") {
			const asked = await this.#rest.json("GET", this.#rest.sandbox(id, "/toolbox-proxy-url"), { retry: true }, signal);
			if (!asked.ok) return asked;
			proxy = (asked.value as { url?: unknown } | null)?.url as string | undefined;
		}
		let url: URL;
		try {
			url = new URL(proxy ?? "");
		} catch {
			return vendorFail("daytona", `Daytona gave no toolbox URL for ${id}`);
		}
		if (url.protocol !== "https:") return vendorFail("daytona", `the toolbox URL Daytona gave is not https (${url.protocol}), so the key is not sent to it`);
		const toolbox = `${url.href.replace(/\/+$/, "")}/${encodeURIComponent(id)}`;
		this.#toolboxes.set(id, toolbox);
		return ok(toolbox);
	}

	/**
	 * A file's bytes to `path` in the sandbox: files/upload-v2, else files/upload. An older toolbox, as a self-hosted
	 * Daytona's runners may run (the open daemon's routes, daytonaio/daytona@b5a5d9e7 apps/daemon/pkg/toolbox/server.go),
	 * has no files/upload-v2 and answers it 404; its files/upload takes the same form (a path query, the bytes as
	 * "file"). A 404 alone moves to the older route, so a refusal of any other kind is never sent twice.
	 */
	async upload(id: string, path: string, bytes: Uint8Array, ctx: HostCall): Promise<Result<void>> {
		const toolbox = await this.#toolbox(id, ctx.signal);
		if (!toolbox.ok) return toolbox;
		const query = new URLSearchParams({ path });
		const send = (route: string, answerStatus?: number) => {
			const form = new FormData();
			form.append("file", new Blob([new Uint8Array(bytes)]), "computerd");
			return this.#rest.call("POST", `${toolbox.value}/${route}?${query}`, { form, retry: true, timeoutMs: ctx.timeoutMs, ...(answerStatus === undefined ? {} : { answerStatus }) }, ctx.signal);
		};
		const current = await send("files/upload-v2", 404);
		if (!current.ok) return current;
		if (current.value.status !== 404) return ok(undefined);
		const missing = `POST ${new URL(`${toolbox.value}/files/upload-v2`).pathname}: 404 ${decoder.decode(current.value.bytes).replace(/\s+/g, " ").trim().slice(0, 300)}`;
		const older = await send("files/upload");
		return older.ok ? ok(undefined) : fail(older.error.code, `${missing}, then ${older.error.message}`);
	}

	/**
	 * argv as the toolbox runs it. With an egress gateway, the helper's mount and revoke of an Archil computer are given
	 * it as their last word (egress=<gateway>:<mount lane>:<data lane>), as the helper reads it: the shared adapter's
	 * mount steps name no gateway.
	 */
	#argv(argv: readonly string[]): readonly string[] {
		const egress = this.#archilEgress;
		if (egress === undefined || argv.length !== 5 || argv[0] !== ARCHIL_HELPER || (argv[1] !== "mount" && argv[1] !== "revoke")) return argv;
		return [...argv, `egress=${egress.gateway}:${egress.mountLane}:${egress.dataLane}`];
	}

	/**
	 * A session command of its own: argv as one shell line, run async with no input echo, as the toolbox's user (root, or
	 * one with passwordless sudo, which the adapter's scripts use). Its output comes from the command's log stream, where
	 * Daytona prefixes each stdout line with 01 01 01 and each stderr line with 02 02 02; an echo of a request the client
	 * wrote is dropped. Writes go to the command's input, whole lines, one call after another. Its exit code is read from
	 * the session; once it has one, the log stream is read to its end (it closes as the command ends) and the session
	 * removed. kill closes the stream and removes the session, which ends the command.
	 */
	async exec(id: string, argv: readonly string[], { stdin }: { stdin: boolean }, ctx: HostCall): Promise<Result<MachineProcess>> {
		const toolbox = await this.#toolbox(id, ctx.signal);
		if (!toolbox.ok) return toolbox;
		const sessionId = `agentrun-${randomBytes(8).toString("hex")}`;
		const session = `${toolbox.value}/process/session/${sessionId}`;
		const made = await this.#rest.call("POST", `${toolbox.value}/process/session`, { json: { sessionId }, timeoutMs: ctx.timeoutMs }, ctx.signal);
		if (!made.ok) return made;
		let removed: Promise<void> | undefined;
		const removeSession = () => (removed ??= this.#rest.call("DELETE", session, {}).then(() => {}));
		const ran = await this.#rest.json("POST", `${session}/exec`, { json: { command: shellLine(this.#argv(argv)), runAsync: true, suppressInputEcho: true }, timeoutMs: ctx.timeoutMs }, ctx.signal);
		const commandId = ran.ok ? (ran.value as { cmdId?: unknown } | null)?.cmdId : undefined;
		if (!ran.ok || typeof commandId !== "string") {
			await removeSession();
			return ran.ok ? vendorFail("daytona", "POST exec: no command id in the answer") : ran;
		}
		const command = `${session}/command/${encodeURIComponent(commandId)}`;
		let socket: WebSocketLike;
		try {
			socket = this.#webSocket(`${command.replace(/^https:/, "wss:")}/logs?follow=true`, { headers: this.#rest.headers(), protocols: [] });
		} catch (error) {
			await removeSession();
			return vendorFail("daytona", `opening the log stream: ${(error as Error).message}`);
		}
		const out = feed();
		const err = feed();
		let rest: Buffer = Buffer.alloc(0);
		const lines = (bytes: Buffer, last: boolean) => {
			rest = rest.length === 0 ? bytes : Buffer.concat([rest, bytes]);
			let at: number;
			while ((at = rest.indexOf(0x0a)) >= 0 || (last && rest.length > 0)) {
				const end = at >= 0 ? at + 1 : rest.length;
				const line = rest.subarray(0, end);
				rest = rest.subarray(end);
				if (line.subarray(0, 3).equals(ERR)) err.push(new Uint8Array(line.subarray(3)));
				else {
					const text = line.subarray(0, 3).equals(OUT) ? line.subarray(3) : line;
					if (!ECHO.test(text.subarray(0, 64).toString("utf8"))) out.push(new Uint8Array(text));
				}
			}
			if (rest.length > MAX_LINE_BYTES + 8) {
				const over = new Error("the process sent a line over the 1 MiB limit");
				out.end(over);
				err.end(over);
				socket.close(1000);
			}
		};
		let closed!: () => void;
		const streamEnded = new Promise<void>((done) => (closed = done));
		let opened!: (result: Result<void>) => void;
		const open = new Promise<Result<void>>((done) => (opened = done));
		socket.binaryType = "arraybuffer";
		socket.addEventListener("open", () => opened(ok(undefined)));
		socket.addEventListener("message", ({ data }) => {
			if (data instanceof ArrayBuffer) lines(Buffer.from(data), false);
			else if (ArrayBuffer.isView(data)) lines(Buffer.from(data.buffer, data.byteOffset, data.byteLength), false);
			else if (typeof data === "string") lines(Buffer.from(data), false);
		});
		socket.addEventListener("error", (event) => {
			opened(vendorFail("daytona", `the log stream failed: ${event.message ?? "no reason given"}`));
			const failed = new Error(`the log stream failed${event.message ? `: ${event.message}` : ""}`);
			out.end(failed);
			err.end(failed);
			closed();
		});
		socket.addEventListener("close", ({ code }) => {
			opened(vendorFail("daytona", `the log stream closed before it opened (code ${code ?? "none"})`));
			lines(Buffer.alloc(0), true);
			out.end();
			err.end();
			closed();
		});
		// The stream opens within the call's bound, or the command is let go of: its output would be lost.
		const bound = AbortSignal.timeout(ctx.timeoutMs);
		const either = ctx.signal ? AbortSignal.any([ctx.signal, bound]) : bound;
		let onAbort: () => void = () => {};
		const aborted = new Promise<Result<void>>((done) => {
			onAbort = () => done(ctx.signal?.aborted ? fail("aborted", "opening the log stream was aborted") : fail("timeout", `the log stream did not open within ${ctx.timeoutMs / 1000} s`));
			if (either.aborted) onAbort();
			else either.addEventListener("abort", onAbort, { once: true });
		});
		const started = await Promise.race([open, aborted]);
		either.removeEventListener("abort", onAbort);
		const kill = async () => {
			socket.close(1000);
			out.end();
			err.end();
			await removeSession();
		};
		if (!started.ok) {
			await kill();
			return started;
		}
		// Input: whole lines, one call after another; the rest of a line waits for its end (or end()).
		const utf8 = new TextDecoder();
		let queued = "";
		let sending: Promise<void> = Promise.resolve();
		const send = (data: string) => {
			sending = sending.then(async () => {
				const sent = await this.#rest.call("POST", `${command}/input`, { json: { data } });
				// Its words never hold what was written: it may be a disk's token.
				if (!sent.ok) throw new Error(`writing to the command failed (${sent.error.code}): ${sent.error.message}`);
			});
			return sending;
		};
		let exited: Promise<number> | undefined;
		const exitCode = async (): Promise<number> => {
			for (;;) {
				const read = await this.#rest.json("GET", session, { retry: true });
				if (!read.ok) return -1;
				const found = ((read.value as { commands?: Array<{ id?: unknown; exitCode?: unknown }> } | null)?.commands ?? []).find((one) => one.id === commandId);
				if (typeof found?.exitCode === "number") {
					// The stream closes as the command ends; one that trails is let go of after a grace.
					await Promise.race([streamEnded, sleep(LOG_GRACE_MS)]);
					await kill();
					return found.exitCode;
				}
				await sleep(this.#pollMs);
			}
		};
		return ok({
			stdout: out.iterable,
			stderr: err.iterable,
			write: (bytes) => {
				queued += utf8.decode(bytes, { stream: true });
				const at = queued.lastIndexOf("\n");
				if (at < 0) return sending;
				const data = queued.slice(0, at + 1);
				queued = queued.slice(at + 1);
				return send(data);
			},
			end: () => {
				queued += utf8.decode();
				const data = queued;
				queued = "";
				return data === "" ? sending : send(data);
			},
			wait: () => (exited ??= exitCode()),
			kill,
		});
	}

	/**
	 * Stops a sandbox (POST stop, unless Daytona reads it stopped already), then waits, through waitUntil, until Daytona
	 * reads it as wanted, twice running, by its own read and by the listing alike: stopped, listed stopped; or gone, not
	 * listed, when its stop deletes it (autoDeleteInterval 0, or a GPU sandbox). A stop not under way is asked for again.
	 * Bounded by ctx.timeoutMs and ctx.signal; a failed read or listing, or a sandbox gone to error, ends the wait.
	 */
	async stop(id: string, ctx: HostCall): Promise<Result<void>> {
		const found = await this.#rest.get(id, ctx.signal);
		if (!found.ok) return found;
		const sb = found.value;
		if (sb === undefined || sb.state === "destroyed") return ok(undefined);
		const ask = async (signal?: AbortSignal) => {
			const stopped = await this.#rest.call("POST", this.#rest.sandbox(id, "/stop"), {}, signal);
			return stopped.ok || stopped.error.code === "invalid" || stopped.error.code === "not_found" ? ok(undefined) : stopped;
		};
		if (!STOPPED.has(sb.state ?? "")) {
			const asked = await ask(ctx.signal);
			if (!asked.ok) return asked;
		}
		const want = this.#autoDeleteFor(this.#made.get(id) ?? (isWhole(sb.gpu) && sb.gpu > 0)) === 0 ? "gone" : "stopped";
		type Read = { failed: Result<never> } | { settled: true } | { last: string };
		let agreed = 0;
		let last = "unread";
		const read = async (signal: AbortSignal): Promise<Read> => {
			const got = await this.#rest.get(id, signal);
			if (!got.ok) return got.error.code === "aborted" ? { last } : { failed: fail(got.error.code, `the stop of ${id}: reading it back failed (${got.error.message}); it last read ${last}`) };
			const now = got.value;
			last = stateWords(now);
			if (now !== undefined && FAILED.has(now.state ?? "") && now.desiredState !== "destroyed") {
				return { failed: vendorFail("daytona", `the stop of ${id}: it went to ${now.state}${now.errorReason ? `: ${now.errorReason}` : ""}`) };
			}
			const gone = now === undefined || now.state === "destroyed";
			const reached = gone ? "gone" : want === "stopped" && STOPPED.has(now.state ?? "") ? "stopped" : undefined;
			if (reached === undefined) {
				agreed = 0;
				if (now !== undefined && stateOf(now) !== "going" && !LEAVING.has(now.state ?? "")) {
					const again = await ask(signal);
					if (!again.ok && again.error.code !== "aborted") return { failed: again };
				}
				return { last };
			}
			const listed = await this.#listOwn(signal);
			if (!listed.ok) return listed.error.code === "aborted" ? { last } : { failed: fail(listed.error.code, `the stop of ${id}: the listing failed (${listed.error.message}); it last read ${last}`) };
			const item = listed.value.find((one) => one.id === id);
			const shown = item === undefined || !ours(item.labels) || stateOf(item) === "going" ? undefined : STOPPED.has(item.state ?? "") ? "stopped" : (item.state ?? "in no state");
			if (reached === "gone" ? shown === undefined : shown === "stopped") return ++agreed >= LISTED_ROUNDS ? { settled: true } : { last };
			agreed = 0;
			last = `${last}, listed ${shown ?? "not at all"}`;
			return { last };
		};
		const waited = await waitUntil(read, (state) => !("last" in state), {
			boundMs: ctx.timeoutMs,
			...(ctx.signal ? { signal: ctx.signal } : {}),
			minMs: Math.min(this.#pollMs, STOP_POLL_MAX_MS),
			maxMs: STOP_POLL_MAX_MS,
			what: `${id} to be ${want} after its stop`,
			describe: (state) => ("last" in state ? `Daytona read it ${state.last}` : "done"),
		});
		if (!waited.ok) return waited;
		return "failed" in waited.value ? waited.value.failed : ok(undefined);
	}

	/**
	 * Settings' test: one page of the account's sandboxes by the adapter's own label, which makes nothing. The count is
	 * read from the listing, with no read of each sandbox: a busy account answers as fast, and one sandbox's read never
	 * fails a working key. A further page is "or more".
	 */
	async testConnection(ctx: HostCall): Promise<Result<{ detail: string }>> {
		const query = new URLSearchParams({ labels: JSON.stringify({ [COMPUTER_LABEL]: "1" }), limit: "100" });
		const answer = await this.#rest.json("GET", `${this.#rest.sandbox()}?${query}`, { retry: true }, ctx.signal);
		if (!answer.ok) return countTested("Daytona", answer);
		const value = answer.value as { items?: unknown; nextCursor?: unknown } | Sandbox[] | null;
		const items = Array.isArray(value) ? value : Array.isArray(value?.items) ? (value.items as Sandbox[]) : undefined;
		if (items === undefined) return countTested("Daytona", vendorFail("daytona", "GET /sandbox: the listing is not a page of sandboxes"));
		const next = Array.isArray(value) ? undefined : value?.nextCursor;
		const count = items.filter((item) => typeof item?.id === "string" && ours(item.labels) && stateOf(item) !== "going").length;
		return countTested("Daytona", ok({ count, more: typeof next === "string" && next !== "" }));
	}
}

/**
 * Computers that are Daytona sandboxes, on the shared adapter. A spec's image is a Daytona snapshot (its id or name),
 * which gives the class and the size; "default" is Daytona's default snapshot. See the README's Daytona section for
 * every call, and its citation.
 */
export class DaytonaProvider extends HostedProvider {
	constructor(options: DaytonaProviderOptions) {
		const {
			apiKey,
			apiUrl = DEFAULT_API_URL,
			arch = "amd64",
			sandboxClass = "container",
			target,
			archilEgress,
			gpuSnapshot,
			autoStopMinutes = 0,
			autoDeleteMinutes,
			fetch: fetcher,
			webSocket,
			timeouts = {},
			daemonPath,
			...rest
		} = options ?? ({} as DaytonaProviderOptions);
		if (typeof apiKey !== "string" || apiKey === "") throw new Error("a Daytona API key is required");
		const base = new URL(apiUrl);
		if (base.protocol !== "https:") throw new Error(`the Daytona API URL must be https, so the key never crosses in the clear: ${base.protocol}`);
		if (arch !== "amd64" && arch !== "arm64") throw new Error(`options.arch is amd64 or arm64, not ${String(arch)}`);
		if (sandboxClass !== "container" && sandboxClass !== "linux-vm") throw new Error(`options.sandboxClass is container or linux-vm, not ${String(sandboxClass)}`);
		const minutes = (name: string, value: unknown) => {
			if (!isWhole(value) || value < 0) throw new Error(`${name} is a whole number of minutes, 0 or more, not ${String(value)}`);
		};
		minutes("autoStopMinutes", autoStopMinutes);
		if (autoDeleteMinutes !== undefined) minutes("autoDeleteMinutes", autoDeleteMinutes);
		const { retryMs = DEFAULT_RETRY_MS, ...hostedTimeouts } = timeouts;
		if (!isWhole(retryMs) || retryMs <= 0) throw new Error(`timeouts.retryMs must be a whole number of ms above 0, not ${retryMs}`);
		const requestMs = hostedTimeouts.requestMs ?? DEFAULT_REQUEST_MS;
		const host = new DaytonaHost({
			rest: new Rest(apiUrl, apiKey, fetcher ?? fetch, requestMs, retryMs),
			webSocket: webSocket ?? ((url, init) => new WebSocket(url, init as never) as unknown as WebSocketLike),
			arch,
			sandboxClass,
			...(target === undefined ? {} : { target }),
			...(archilEgress === undefined || archilEgress === "" ? {} : { archilEgress: archilEgressOf(archilEgress) }),
			gpu: daytonaGpuSnapshot(gpuSnapshot),
			autoStop: autoStopMinutes,
			autoDelete: autoDeleteMinutes ?? NO_AUTO_DELETE,
			pollMs: hostedTimeouts.pollMs ?? DEFAULT_POLL_MS,
		});
		super(host, { ...rest, label: "Daytona", kind: "linux", timeouts: hostedTimeouts, daemonPath: daemonPath || fileURLToPath(new URL(`./computerd-linux-${arch}`, import.meta.url)) });
	}
}
