// The Daytona host: Daytona sandboxes over Daytona's v0 REST API with fetch (no SDK). Daytona's toolbox daemon is the
// sandbox's first process, so computerd is a child: its upload goes through the toolbox's file API, and every command
// (install, init's start, the stdio bridge, an Archil computer's root steps) is a session command, its output read from
// the command's log stream and its stdin sent as the command's input. With connect dial, create starts agentrun-dial
// itself in a toolbox session (README, Daytona on dial). The rest of the computer is the shared machine-host adapter's
// (./hosted/provider.ts). Every Daytona fact used here is cited in the README's Daytona section.
import { randomBytes } from "node:crypto";
import { connectOf, kindRefusal, mountsOf } from "./descriptor.js";
import { DAYTONA, DAYTONA_DEFAULT_SNAPSHOT, DAYTONA_GPU, DAYTONA_GPU_REGION, DAYTONA_GPU_SNAPSHOT, type DaytonaGpuSnapshot, daytonaGpuSnapshot } from "./descriptors/daytona.js";
import { COMPUTER_LABEL } from "./drift.js";
import { type HostCall, type HostDescriptor, HostError, type HostFacts, type Machine, type MachineHost, type MachineProcess, type MachineRequest } from "./host.js";
import { type ExecPieces, type FramedEvent, framedExec } from "./hosted/framed-exec.js";
import { HostedProvider, type HostedOptions, type HostedTimeouts, timeoutsOf } from "./hosted/provider.js";
import { boundOf, orThrow, seconds, pause as sleep, words } from "./hosted/process.js";
import { allPages, jsonOf, type Rest, rest } from "./hosted/rest.js";
import { dialLaunch, shellLine } from "./hosted/scripts.js";
import { dateOf, isWhole, sizeRefusals } from "./hosted/values.js";
import { MAX_LINE_BYTES } from "./protocol.js";
import { type ComputerResources, type ComputerSpec, checkGpu, type Refusal } from "./provider.js";
import { type ComputerError, type ComputerErrorCode, ok, type Result, vendorFail } from "./result.js";

/** The parts of a WebSocket the host uses: Node's global WebSocket, or a stand-in in tests. */
export interface WebSocketLike {
	binaryType: string;
	addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown; code?: number; message?: string }) => void): void;
	close(code?: number): void;
}

export type WebSocketFactory = (url: string, init: { headers: Record<string, string>; protocols: string[] }) => WebSocketLike;

/** The adapter's bounds, and Daytona's own: the first pause before a retried request (each next one doubles). */
export type DaytonaTimeouts = HostedTimeouts & { retryMs: number };

/**
 * The Daytona provider's options: the key and Daytona's own settings, then the shared adapter's (HostedOptions), kind
 * among them: a desktop on connect dial alone (kindRefusal; the why is PROVIDERS.md's Daytona bullet).
 */
export interface DaytonaProviderOptions extends Omit<HostedOptions, "desktop" | "maxLifetimeMs" | "timeouts"> {
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
	 * The operator's Archil egress relay, `<IPv4 gateway>:<mount lane>:<data lane>` (HostedOptions.archilEgress, checked
	 * as the adapter checks it): for a self-hosted Daytona target whose sandboxes reach Archil only through it. With it,
	 * this provider takes an Archil mount (DAYTONA.mountsWith); without it, check() refuses one in DAYTONA_NO_ARCHIL's
	 * words, since Archil's client hangs on Daytona's hosted cloud. Set it only for such a target.
	 */
	archilEgress?: string;
	/**
	 * The operator's attach relay, `<IPv4 relay>:<port>` (HostedOptions.attachEgress, attachEgressOf): for a self-hosted
	 * Daytona target whose runners drop every sandbox connection outside an allow list that the public address is not on.
	 * A machine that dials (connect dial, and every desktop) fetches the daemon and opens its attach socket through it,
	 * with TLS end to end to the public host. Unset, it dials the public host; a machine on exec never reads it.
	 */
	attachEgress?: string;
	/**
	 * How long create waits for Daytona's label listing to show a new sandbox, in ms (timeouts.listedMs; serve's
	 * DAYTONA_LISTED_MS): a whole number above 0, as a number or its digits. Daytona's `GET /sandbox` is eventually
	 * consistent (an index, not the database), so a sandbox still unlisted then is read by its id and kept when it reads
	 * started. Unset, the adapter's 15 s; timeouts.listedMs, when given, wins.
	 */
	listedMs?: number | string;
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
	/**
	 * exec (default): the daemon goes in through the toolbox's file API and each connection is a session command. dial:
	 * the sandbox gets the boot env as its env but AGENTRUN_ATTACH_URL, and create starts agentrun-dial with the URL in a
	 * session command of its own; the machine dials the server (options.dial), which every connection goes over. No
	 * Archil mount and no GPU on dial.
	 */
	connect?: "exec" | "dial";
	/** For tests: every request goes through it. Default the global fetch. */
	fetch?: typeof fetch;
	/** For tests: every log stream opens through it. Default Node's global WebSocket. */
	webSocket?: WebSocketFactory;
	/** For tests: the pause before a request is tried again, given its ms and the call's signal. Default a timer. */
	pause?: (ms: number, signal?: AbortSignal) => Promise<void>;
	timeouts?: Partial<DaytonaTimeouts>;
}

/** What Daytona reports of a sandbox, as far as this provider reads it (api.json Sandbox and SandboxListItem). */
interface Sandbox {
	id: string;
	state?: string;
	desiredState?: string;
	errorReason?: string;
	labels?: Record<string, string>;
	gpu?: number;
	/** The GPU type Daytona assigned (its GpuType enum), when the sandbox has GPUs. */
	gpuType?: string;
	/** The sandbox's CPUs, memory and disk as Daytona gave them (its Sandbox: memory and disk in GiB), which it bills by. */
	cpu?: number;
	memory?: number;
	disk?: number;
	autoDestroyAt?: string;
	/** When Daytona made the sandbox, by its clock: the adapter keeps the oldest of two machines one request made. */
	createdAt?: string;
	toolboxProxyUrl?: string;
}

/** options.listedMs as a whole number of ms above 0 (a number, or its digits as DAYTONA_LISTED_MS gives them), or undefined when unset. */
function listedMsOf(value: unknown): number | undefined {
	if (value === undefined || value === "") return undefined;
	const ms = typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
	if (!isWhole(ms) || ms <= 0) throw new Error(`listedMs (DAYTONA_LISTED_MS) is a whole number of ms above 0, not ${JSON.stringify(value)}`);
	return ms;
}

/** A positive finite figure of Daytona's answer, else undefined (absent, zero or not a number: never guessed). */
const given = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);

/** What Daytona says a sandbox was given (Machine.resources): its CPUs, its memory (GiB, as MB), its disk (GiB) and its
 *  GPUs (count and type), each where its answer says it; none where it says nothing. */
function resourcesOf(sb: Pick<Sandbox, "cpu" | "memory" | "disk" | "gpu" | "gpuType">): { resources?: ComputerResources } {
	const [cpus, memory, disk, gpus] = [given(sb.cpu), given(sb.memory), given(sb.disk), given(sb.gpu)];
	const resources: ComputerResources = {
		...(cpus === undefined ? {} : { cpus }),
		...(memory === undefined ? {} : { memoryMb: memory * 1024 }),
		...(disk === undefined ? {} : { diskGb: disk }),
		...(gpus !== undefined && typeof sb.gpuType === "string" && sb.gpuType !== "" ? { gpu: { type: sb.gpuType, count: gpus } } : {}),
	};
	return Object.keys(resources).length > 0 ? { resources } : {};
}

/**
 * A DaytonaProvider from its options alone; it reads no environment, so the key, the API URL (default Daytona's own) and
 * the target are the caller's: serve passes its DAYTONA_API_KEY, DAYTONA_API_URL and DAYTONA_TARGET, the conformance
 * module the settings it reads. Throws in words when an option is missing or wrong, never echoing the key.
 */
export function create(options: DaytonaProviderOptions): DaytonaProvider {
	return new DaytonaProvider(options);
}

/** The conformance CLI's module for Daytona: the run's idle stop and auto-delete, its snapshot, notes and drifted twin. */
export const conformance = () => import("./conformance/daytona.js");

const DEFAULT_API_URL = "https://app.daytona.io/api";
/** autoDeleteInterval when autoDeleteMinutes is unset: negative is disabled. */
const NO_AUTO_DELETE = -1;
const DEFAULT_RETRY_MS = 500;
const RETRY_ATTEMPTS = 3;
const DELETE_ATTEMPTS = 4;
/** How long a command's log stream may trail its exit code before the host stops reading it. */
const LOG_GRACE_MS = 5_000;
const MAX_PAGES = 1000;
const MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
/** The toolbox's port, on every interface of the sandbox (daytonaio/daytona@b5a5d9e7 apps/daemon/pkg/toolbox/config/config.go:6). */
const TOOLBOX_PORT = 2280;
const QUOTA = /quota|capacity|limit exceeded|too many/i;
const STARTING = new Set(["creating", "restoring", "starting", "pending_build", "building_snapshot", "pulling_snapshot", "resizing", "snapshotting", "forking", "resuming", "unknown"]);
const GONE = new Set(["destroyed", "destroying"]);
const FAILED = new Set(["error", "build_failed"]);
const OUT = Buffer.from([1, 1, 1]);
const ERR = Buffer.from([2, 2, 2]);
/** A line the client wrote, echoed back: a request or a notification is never a daemon's reply. */
const ECHO = /^\{"jsonrpc":"2\.0",("id":\d+,)?"method":/;
/** The toolbox session a dial sandbox's agentrun-dial runs in, its one command: dialLog reads its log by this id. */
const DIAL_SESSION = "agentrun-dial";

const decoder = new TextDecoder();

/**
 * Why a dial computer takes no GPU: check() refuses one in these words, and capabilities() declares none on dial.
 * daytona-gpu is Daytona's own image, with no agentrun-dial; our GPU snapshot holds it, but Daytona runs a GPU sandbox
 * unprivileged (apps/runner/pkg/docker/container_configs.go:205), and no dial has run there.
 */
const DIAL_NO_GPU = `a Daytona computer that dials this server takes no GPU: ${DAYTONA_GPU_SNAPSHOT} holds no agentrun-dial, and a box/Dockerfile GPU snapshot's dial on Daytona's GPU host, which runs it unprivileged, is not proven; a server whose Daytona connect is exec makes GPU computers`;

/** Why a dial computer is never made from Daytona's default snapshot: it holds no agentrun-dial, so it would never dial. */
const DIAL_NO_DEFAULT = `a Daytona computer that dials this server starts from a snapshot of box/Dockerfile, which holds agentrun-dial (box/build-daytona.py prints its name, agentrun-box-<recipe hash>); Daytona's default snapshot has none, so it would never dial`;

/**
 * A sandbox's state as the adapter reads a machine's: failed, destroying and asked to destroy are gone (none of them
 * starts again); stopping and pausing are stopped. A destroyed one get and list leave out, and the wait after a delete
 * waits for that.
 */
function stateOf(sb: Sandbox): Machine["state"] {
	const state = sb.state ?? "";
	if (GONE.has(state) || sb.desiredState === "destroyed" || FAILED.has(state)) return "gone";
	if (state === "started") return "running";
	return STARTING.has(state) ? "starting" : "stopped";
}

/** Daytona's own words for a refusal about quota or capacity; every other status is the shared table's. */
const explain = ({ status, text }: { status: number; text: string }): { code?: ComputerErrorCode } => ((status === 400 || status === 403 || status === 429 || status === 507) && QUOTA.test(text) ? { code: "limit" } : {});

/**
 * Whether an answer is Daytona's own 500: its error body ({"statusCode":500,...}), which its proxy, its runner and the
 * toolbox each answer for an error set before the request is passed on, or one the toolbox's route returned. The
 * toolbox's input route (daytonaio/daytona@b5a5d9e7 apps/daemon/pkg/session/input.go) answers 500 when it could not
 * open the command's input pipe (nothing written) or the write failed (the pipe's reader is gone: the command reads no
 * more); a request passed on that then fails is 502 with no body (libs/common-go/pkg/proxy/proxy.go, ErrorHandler).
 */
function internalRefusal(status: number, bytes: Uint8Array): boolean {
	return status === 500 && (jsonOf(bytes) as { statusCode?: unknown } | null)?.statusCode === 500;
}

/** The headers of every call to Daytona's REST API and of every log stream; split output keeps a session's stdout and stderr apart. */
const headersOf = (key: string): Record<string, string> => ({ Authorization: `Bearer ${key}`, "X-Daytona-Source": "agentrun-computer", "X-Daytona-Split-Output": "true" });

/** A sandbox's URL on the control plane, by id or name, and the sandboxes' own with neither. */
const sandboxUrl = (api: Rest, idOrName = "", tail = ""): string => api.url(`/sandbox${idOrName === "" ? "" : `/${encodeURIComponent(idOrName)}`}${tail}`);

/** A sandbox by id or name; undefined when Daytona has none. */
async function sandboxOf(api: Rest, idOrName: string, signal?: AbortSignal): Promise<Result<Sandbox | undefined>> {
	const found = await api.json("GET", sandboxUrl(api, idOrName), { retry: true }, signal);
	if (!found.ok) return found.error.code === "not_found" ? ok(undefined) : found;
	const sb = found.value as Sandbox | null;
	return typeof sb?.id === "string" ? ok(sb) : vendorFail("daytona", `GET /sandbox/${idOrName}: no sandbox in the answer`);
}

/** Daytona's sandboxes as a MachineHost (../host.ts). */
class DaytonaHost implements MachineHost {
	/**
	 * Daytona's descriptor, the registry's, as the constructor gives it with the mounts of the keys this provider was made
	 * with (mountsOf): an Archil mount with an Archil egress, none without.
	 */
	readonly descriptor: HostDescriptor = DAYTONA;
	readonly facts: HostFacts;
	/** connect exec alone: a dial host has neither (HostFacts.connect). */
	readonly exec?: MachineHost["exec"];
	readonly upload?: MachineHost["upload"];
	/** connect dial alone: agentrun-dial's session command's log. */
	readonly dialLog?: MachineHost["dialLog"];
	/** The command that runs agentrun-dial, by sandbox id, from its create: what dialLog reads. Let go of at its delete. */
	readonly #dials = new Map<string, string>();
	/** Daytona's REST API: the control plane, and the toolbox of each sandbox. */
	readonly #rest: Rest;
	readonly #headers: Record<string, string>;
	readonly #webSocket: WebSocketFactory;
	readonly #target: string | undefined;
	/** The snapshot its GPU computers are made from, and their GPU. */
	readonly #gpu: DaytonaGpuSnapshot;
	readonly #autoStop: number;
	readonly #autoDelete: number;
	readonly #pollMs: number;
	/** Each sandbox's toolbox URL, by id, once read: let go of at its delete. */
	readonly #toolboxes = new Map<string, string>();

	constructor(options: { descriptor: HostDescriptor; rest: Rest; headers: Record<string, string>; webSocket: WebSocketFactory; arch: "amd64" | "arm64"; sandboxClass: "container" | "linux-vm"; target?: string; gpu: DaytonaGpuSnapshot; autoStop: number; autoDelete: number; pollMs: number; connect: "exec" | "dial" }) {
		this.descriptor = options.descriptor;
		this.#rest = options.rest;
		this.#headers = options.headers;
		this.#webSocket = options.webSocket;
		this.#target = options.target;
		this.#gpu = options.gpu;
		this.#autoStop = options.autoStop;
		this.#autoDelete = options.autoDelete;
		this.#pollMs = options.pollMs;
		// daemon child: Daytona's toolbox daemon is the sandbox's first process, and init a command started through it.
		// maxLifetimeMs is the 30 days check() has always given; Daytona's TTL is in whole minutes and documents no cap of
		// its own. The toolbox listens on 2280 on every interface and runs commands for whoever reaches it, so init starts
		// with --own-network, and network none is all a computer takes. Its D-Bus session bus in /tmp (/tmp/dbus-*), which
		// no network namespace cuts, is closed to the tool user before init starts, as on every child host. On dial init is
		// agentrun-dial's child, and agentrun-dial a session command create starts through the toolbox: still a child.
		this.facts = {
			daemon: "child",
			isolation: options.sandboxClass === "linux-vm" ? "vm" : "container",
			lifetime: "vendor",
			maxLifetimeMs: MAX_LIFETIME_MS,
			arch: options.arch,
			vendorAgentPorts: [TOOLBOX_PORT],
			// A snapshot of box/Dockerfile has xfwm4 (box/install.sh's desktop step), for a desktop (connect dial alone).
			// computerd starts it as root makes its network namespace: the tool user can make none here (Sysbox, with
			// kernel.apparmor_restrict_unprivileged_userns=1, measured 11-19).
			windowManager: true,
			...(options.connect === "dial" ? { connect: options.connect } : {}),
		};
		if (options.connect === "exec") {
			this.exec = (id, argv, ctx) => this.#exec(id, argv, ctx);
			this.upload = (id, path, bytes, ctx) => this.#upload(id, path, bytes, ctx);
		} else this.dialLog = (id, ctx) => this.#dialLog(id, ctx);
	}

	/**
	 * A snapshot name has no control characters, and its size is the snapshot's; a GPU computer is made from the
	 * provider's GPU snapshot, which a spec names, or Daytona's default, never another. No call.
	 */
	check(given: Partial<ComputerSpec>): Refusal[] {
		const { image } = given;
		const refusals = sizeRefusals(given, "a Daytona computer", "snapshot");
		if (typeof image === "string" && image !== "" && image.trim() === "") refusals.push({ field: "image", message: `an image is the id or name of a Daytona snapshot, or "${DAYTONA_DEFAULT_SNAPSHOT}" for Daytona's default snapshot` });
		else if (typeof image === "string" && /[\x01-\x1f]/.test(image)) refusals.push({ field: "image", message: "a snapshot name has no control characters" });
		if (given.gpu !== undefined && this.facts.connect === "dial") return [...refusals, { field: "gpu", message: DIAL_NO_GPU }];
		if (image === DAYTONA_DEFAULT_SNAPSHOT && this.facts.connect === "dial") refusals.push({ field: "image", message: DIAL_NO_DEFAULT });
		const gpuSnapshot = this.#gpu.snapshot;
		const offered = { gpu: { ...DAYTONA_GPU, types: [this.#gpu.type], max: this.#gpu.count } };
		if (given.gpu !== undefined && checkGpu(given.gpu, offered, given.mount).length === 0 && typeof image === "string" && image !== DAYTONA_DEFAULT_SNAPSHOT && image !== gpuSnapshot) {
			refusals.push({
				field: "image",
				message: `a Daytona GPU computer here is made from the GPU snapshot ${gpuSnapshot} alone, not ${JSON.stringify(image)}: give "${gpuSnapshot}" or "${DAYTONA_DEFAULT_SNAPSHOT}"; no other snapshot is proven to give a GPU computer`,
			});
		}
		return refusals;
	}

	/** A sandbox as the adapter reads a machine: its state, labels, start, end, and Daytona's words for a failure. */
	#machineOf(sb: Sandbox): Machine {
		const endsAt = dateOf(sb.autoDestroyAt);
		const made = dateOf(sb.createdAt);
		return {
			id: sb.id,
			labels: { ...(sb.labels ?? {}) },
			state: stateOf(sb),
			...(made ? { createdAt: made } : {}),
			...(endsAt ? { endsAt } : {}),
			...resourcesOf(sb),
			// A failed sandbox always carries a why, Daytona's or ours, so create stops on it as vendor, never as gone.
			...(typeof sb.errorReason === "string" && sb.errorReason !== "" ? { why: sb.errorReason } : FAILED.has(sb.state ?? "") ? { why: `Daytona reads the sandbox ${sb.state}, with no reason given` } : {}),
		};
	}

	/**
	 * POST /sandbox: its native name and labels, the lifetime as a TTL in whole minutes, the idle stop and auto-delete,
	 * no public port, and network none (block-all) unless the adapter asks egress (a network open or a list, or an Archil
	 * computer's root, which reaches Archil through the operator's relay). A GPU computer is made from the GPU snapshot in region earth, ephemeral (its stop deletes it). Never cancelled: the adapter
	 * races it, and deletes by name one whose answer never comes. A name Daytona already holds (409) made nothing: exists,
	 * and the adapter adopts the sandbox the name lists, as a retry does. req.backstopAt is left: the TTL is Daytona's own
	 * timer at the deadline (lifetime "vendor"), and autoDeleteInterval counts from a stop, not from create. A dial
	 * machine's boot env but AGENTRUN_ATTACH_URL is the sandbox's env, which every session command inherits, and create
	 * then starts agentrun-dial within ctx.timeoutMs (#startDial; README, Daytona on dial).
	 */
	async create(req: MachineRequest, ctx: HostCall): Promise<{ id: string }> {
		const until = Date.now() + ctx.timeoutMs;
		const gpu = req.gpu !== undefined;
		const { AGENTRUN_ATTACH_URL: attach, ...env } = req.boot?.env ?? {};
		const body = {
			name: req.name,
			// "default" sends no snapshot, and Daytona makes the sandbox from its default snapshot.
			...(gpu ? { snapshot: this.#gpu.snapshot } : req.image === DAYTONA_DEFAULT_SNAPSHOT ? {} : { snapshot: req.image }),
			labels: { ...req.labels },
			env,
			public: false,
			// A GPU sandbox runs in region earth alone, whatever the provider's target.
			...(gpu ? { target: DAYTONA_GPU_REGION } : this.#target === undefined ? {} : { target: this.#target }),
			ttlMinutes: Math.max(1, Math.ceil(req.lifetimeMs / 60_000)),
			autoStopInterval: this.#autoStop,
			// A GPU sandbox's stop deletes it (no pause, no snapshot): autoDeleteInterval 0 is Daytona's ephemeral (its SDK's
			// ephemeral sets it; CreateSandbox has no ephemeral field).
			autoDeleteInterval: gpu ? 0 : this.#autoDelete,
			networkBlockAll: !req.egress,
			// No resource field (cpu, gpu, gpuType, memory, disk): a snapshot carries its own, and Daytona refuses a create that
			// names a snapshot and sends any (400 "Cannot specify Sandbox resources when using a snapshot"). A GPU computer's
			// GPU is the snapshot's, held by the adapter's GPU label.
		};
		const posted = await this.#rest.json("POST", sandboxUrl(this.#rest), { json: body, timeoutMs: ctx.timeoutMs, named: true });
		const sb = orThrow(posted) as Sandbox | null;
		const id = sb?.id;
		if (typeof id !== "string" || id === "") throw new Error("POST /sandbox: no sandbox id in the answer");
		if (req.boot !== undefined) await this.#startDial(sb as Sandbox, attach ?? "", until, ctx.timeoutMs);
		return { id };
	}

	/**
	 * A dial sandbox's agentrun-dial, started once the sandbox reads started (by `until`, ms after create began): one
	 * toolbox session of its own (DIAL_SESSION), its one command async: dialLaunch's line, as root (the toolbox runs
	 * session commands as root), AGENTRUN_ATTACH_URL a quoted assignment on it. The token is never on it: it stays in the
	 * sandbox's env, which the command inherits. The session and the command's id are kept, so its log is the dial's last
	 * words (dialLog). A sandbox gone as a machine reads (stateOf: failed, destroying or asked to destroy), or a session or
	 * command Daytona refuses, throws vendor in Daytona's words, and one not started by `until` throws timeout: either is
	 * a create that made a machine to the adapter, which deletes it by its name.
	 */
	async #startDial(posted: Sandbox, attach: string, until: number, timeoutMs: number): Promise<void> {
		const { id } = posted;
		let sb: Sandbox = posted;
		for (let state = stateOf(sb); state !== "running"; state = stateOf(sb)) {
			if (state === "gone") throw new HostError("vendor", `Daytona reads the sandbox ${id} ${sb.state}${sb.desiredState === "destroyed" ? ", to be destroyed" : ""}, so agentrun-dial was not started: ${sb.errorReason || "no reason given"}`);
			if (Date.now() + this.#pollMs >= until) throw new HostError("timeout", `the sandbox ${id} did not read started within ${seconds(timeoutMs)} (it reads ${sb.state ?? "no state"}), so agentrun-dial was not started`);
			await sleep(this.#pollMs);
			const read = await sandboxOf(this.#rest, id);
			if (!read.ok) throw new HostError("vendor", `reading the sandbox ${id} while it starts failed: ${read.error.message}`);
			if (read.value === undefined) throw new HostError("vendor", `Daytona no longer has the sandbox ${id}, so agentrun-dial was not started`);
			sb = read.value;
		}
		try {
			const toolbox = await this.#toolbox(id);
			const { commandId } = await this.#runAsync(toolbox, DIAL_SESSION, dialLaunch({ rootOnly: this.facts.rootOnly, attach }), Math.max(1, until - Date.now()));
			this.#dials.set(id, commandId);
		} catch (error) {
			throw new HostError("vendor", `starting agentrun-dial in ${id} failed: ${words(error)}`);
		}
	}

	/**
	 * What agentrun-dial wrote: one read of the log of the command create started. The toolbox answers a client that names
	 * no SDK version with the log as written, each write behind its stream's prefix (README, Daytona on dial), and the
	 * prefixes are dropped. undefined when this host started no agentrun-dial there.
	 */
	async #dialLog(id: string, ctx: HostCall): Promise<string | undefined> {
		const commandId = this.#dials.get(id);
		if (commandId === undefined) return undefined;
		const session = `${await this.#toolbox(id, ctx.signal)}/process/session/${DIAL_SESSION}`;
		const logs = orThrow(await this.#rest.call("GET", `${session}/command/${encodeURIComponent(commandId)}/logs`, { retry: true, timeoutMs: ctx.timeoutMs }, ctx.signal));
		return decoder.decode(logs.bytes).replaceAll(OUT.toString("latin1"), "").replaceAll(ERR.toString("latin1"), "");
	}

	/** GET /sandbox/{id}; one Daytona answers 404 for, or reads destroyed, is none. */
	async get(id: string, ctx: HostCall): Promise<Machine | undefined> {
		const found = orThrow(await sandboxOf(this.#rest, id, ctx.signal));
		return found === undefined || found.state === "destroyed" ? undefined : this.#machineOf(found);
	}

	/** Every sandbox with the adapter's label, all pages: one label query, filtered here by the rest of the labels. */
	async #listOwn(signal?: AbortSignal): Promise<Result<Sandbox[]>> {
		const found = await allPages<Sandbox>(
			async (cursor) => {
				const query = new URLSearchParams({ labels: JSON.stringify({ [COMPUTER_LABEL]: "1" }), limit: "100" });
				if (cursor !== undefined) query.set("cursor", cursor);
				const answer = await this.#rest.json("GET", `${sandboxUrl(this.#rest)}?${query}`, { retry: true }, signal);
				if (!answer.ok) return answer;
				const value = answer.value as { items?: unknown; nextCursor?: unknown } | Sandbox[] | null;
				const items = Array.isArray(value) ? value : Array.isArray(value?.items) ? (value.items as Sandbox[]) : undefined;
				if (items === undefined) return vendorFail("daytona", "GET /sandbox: the listing is not a page of sandboxes");
				const next = Array.isArray(value) ? undefined : value?.nextCursor;
				return ok({ items, ...(typeof next === "string" ? { next } : {}) });
			},
			MAX_PAGES,
			{ vendor: "daytona", what: "GET /sandbox: the listing" },
		);
		return found.ok ? ok(found.value.filter((sb) => typeof sb?.id === "string")) : found;
	}

	/**
	 * Every sandbox the listing shows with the adapter's label (destroyed ones are gone): Daytona's listing is asked for
	 * that label alone, as it always was, and the adapter keeps those with the rest.
	 */
	async list(labels: Record<string, string>, ctx: HostCall): Promise<Machine[]> {
		void labels;
		const listed = orThrow(await this.#listOwn(ctx.signal));
		return listed.filter((sb) => sb.state !== "destroyed").map((sb) => this.#machineOf(sb));
	}

	/**
	 * Deletes a sandbox and makes sure it is going: a DELETE that fails counts as done only when the sandbox is gone or
	 * being destroyed; a forced stop comes before the last attempt. Never signalled: a delete that cleans up after an abort
	 * must outlive it.
	 */
	async delete(id: string, ctx: HostCall): Promise<void> {
		this.#toolboxes.delete(id);
		this.#dials.delete(id);
		let failure: ComputerError | undefined;
		for (let attempt = 1; attempt <= DELETE_ATTEMPTS; attempt++) {
			const removed = await this.#rest.call("DELETE", sandboxUrl(this.#rest, id), { retry: true, timeoutMs: ctx.timeoutMs });
			if (removed.ok || removed.error.code === "not_found") return;
			failure = removed.error;
			const found = await sandboxOf(this.#rest, id);
			if (found.ok && (found.value === undefined || GONE.has(found.value.state ?? ""))) return;
			if (attempt === DELETE_ATTEMPTS - 1) await this.#rest.call("POST", sandboxUrl(this.#rest, id, "/stop?force=true"), { timeoutMs: ctx.timeoutMs });
			if (attempt < DELETE_ATTEMPTS) await sleep(DEFAULT_RETRY_MS);
		}
		throw new HostError(failure?.code ?? "vendor", failure?.message ?? `could not delete ${id}`);
	}

	/** The sandbox's toolbox, as an https URL: never another scheme, so the key is never sent in the clear. */
	async #toolbox(id: string, signal?: AbortSignal): Promise<string> {
		const known = this.#toolboxes.get(id);
		if (known !== undefined) return known;
		const found = orThrow(await sandboxOf(this.#rest, id, signal));
		if (found === undefined) throw new HostError("not_found", `Daytona has no sandbox ${id}`);
		let proxy = found.toolboxProxyUrl;
		if (typeof proxy !== "string" || proxy === "") {
			const asked = orThrow(await this.#rest.json("GET", sandboxUrl(this.#rest, id, "/toolbox-proxy-url"), { retry: true }, signal));
			proxy = (asked as { url?: unknown } | null)?.url as string | undefined;
		}
		let url: URL;
		try {
			url = new URL(proxy ?? "");
		} catch {
			throw new Error(`Daytona gave no toolbox URL for ${id}`);
		}
		if (url.protocol !== "https:") throw new Error(`the toolbox URL Daytona gave is not https (${url.protocol}), so the key is not sent to it`);
		const toolbox = `${url.href.replace(/\/+$/, "")}/${encodeURIComponent(id)}`;
		this.#toolboxes.set(id, toolbox);
		return toolbox;
	}

	/**
	 * A file's bytes to `path` in the sandbox: files/upload-v2, else files/upload. An older toolbox, as a self-hosted
	 * Daytona's runners may run (the open daemon's routes, daytonaio/daytona@b5a5d9e7 apps/daemon/pkg/toolbox/server.go),
	 * has no files/upload-v2 and answers it 404; its files/upload takes the same form (a path query, the bytes as
	 * "file"). A 404 alone moves to the older route, so a refusal of any other kind is never sent twice. Connect exec alone.
	 */
	async #upload(id: string, path: string, bytes: Uint8Array, ctx: HostCall): Promise<void> {
		const toolbox = await this.#toolbox(id, ctx.signal);
		const query = new URLSearchParams({ path });
		const send = (route: string, answerStatus?: number) => {
			const form = new FormData();
			form.append("file", new Blob([new Uint8Array(bytes)]), "computerd");
			return this.#rest.call("POST", `${toolbox}/${route}?${query}`, { form, retry: true, timeoutMs: ctx.timeoutMs, ...(answerStatus === undefined ? {} : { accept: (status: number) => status === answerStatus || (status >= 200 && status < 300) }) }, ctx.signal);
		};
		const current = orThrow(await send("files/upload-v2", 404));
		if (current.status !== 404) return;
		const missing = `POST ${new URL(`${toolbox}/files/upload-v2`).pathname}: 404 ${decoder.decode(current.bytes).replace(/\s+/g, " ").trim().slice(0, 300)}`;
		const older = await send("files/upload");
		if (!older.ok) throw new HostError(older.error.code, `${missing}, then ${older.error.message}`);
	}

	/**
	 * A session command of its own (#commands), on framedExec: argv as one shell line, run async with no input echo, as
	 * the toolbox's user (root, or one with passwordless sudo, which the adapter's scripts use). Connect exec alone.
	 */
	async #exec(id: string, argv: readonly string[], ctx: HostCall): Promise<MachineProcess> {
		return framedExec(this.#commands(await this.#toolbox(id, ctx.signal)), argv, ctx);
	}

	/**
	 * Daytona's session commands in the toolbox as exec's pieces (./hosted/framed-exec.ts). start makes a session, runs
	 * the command in it and opens its log stream, where Daytona prefixes each stdout line with 01 01 01 and each stderr
	 * line with 02 02 02; an echo of a request the client wrote is dropped. The stream ends once the command's exit code
	 * is written (the toolbox reads the log until its exit code file holds one, daytonaio/daytona@b5a5d9e7
	 * apps/daemon/internal/util/log_reader.go), so the events read the exit code from the session then, never while it
	 * runs, within a grace for a read that lags; then the session is removed. write sends whole lines, since Daytona's
	 * input call ends what it is given with a newline (apps/daemon/pkg/session/input.go): the rest of a line waits for its
	 * end, or end(). kill closes the stream and removes the session, which ends the command.
	 */
	#commands(toolbox: string): ExecPieces<Command> {
		return {
			start: (argv, ctx) => this.#startCommand(toolbox, argv, ctx),
			events: (command) => this.#events(command),
			write: async (command, text) => {
				command.held += text;
				const at = command.held.lastIndexOf("\n");
				if (at < 0) return;
				const data = command.held.slice(0, at + 1);
				command.held = command.held.slice(at + 1);
				await this.#input(command, data);
			},
			end: async (command) => {
				const data = command.held;
				command.held = "";
				if (data !== "") await this.#input(command, data);
			},
			kill: async (command) => {
				command.killed = true;
				await this.#letGo(command);
			},
		};
	}

	/**
	 * A session of its own (sessionId) in the toolbox, with one command run in it async, no input echo: its session's URL
	 * and the command's id. A command Daytona does not take removes the session again.
	 */
	async #runAsync(toolbox: string, sessionId: string, command: string, timeoutMs: number, signal?: AbortSignal): Promise<{ session: string; commandId: string }> {
		const session = `${toolbox}/process/session/${sessionId}`;
		orThrow(await this.#rest.call("POST", `${toolbox}/process/session`, { json: { sessionId }, timeoutMs }, signal));
		const ran = await this.#rest.json("POST", `${session}/exec`, { json: { command, runAsync: true, suppressInputEcho: true }, timeoutMs }, signal);
		const commandId = ran.ok ? (ran.value as { cmdId?: unknown } | null)?.cmdId : undefined;
		if (!ran.ok || typeof commandId !== "string") {
			await this.#rest.call("DELETE", session, {});
			throw ran.ok ? new Error("POST exec: no command id in the answer") : new HostError(ran.error.code, ran.error.message);
		}
		return { session, commandId };
	}

	async #startCommand(toolbox: string, argv: readonly string[], ctx: HostCall): Promise<Command> {
		const { session, commandId } = await this.#runAsync(toolbox, `agentrun-${randomBytes(8).toString("hex")}`, shellLine(argv), ctx.timeoutMs, ctx.signal);
		let socket: WebSocketLike;
		try {
			socket = this.#webSocket(`${session.replace(/^https:/, "wss:")}/command/${encodeURIComponent(commandId)}/logs?follow=true`, { headers: this.#headers, protocols: [] });
		} catch (error) {
			await this.#rest.call("DELETE", session, {});
			throw new Error(`opening the log stream: ${(error as Error).message}`);
		}
		const command: Command = { session, commandId, socket, output: [], ended: false, wake: () => {}, held: "", killed: false };
		const ended = (failure?: Error) => {
			command.failure ??= failure;
			command.ended = true;
			command.wake();
		};
		let rest: Buffer = Buffer.alloc(0);
		const lines = (bytes: Buffer, last: boolean) => {
			rest = rest.length === 0 ? bytes : Buffer.concat([rest, bytes]);
			let at: number;
			while ((at = rest.indexOf(0x0a)) >= 0 || (last && rest.length > 0)) {
				const end = at >= 0 ? at + 1 : rest.length;
				const line = rest.subarray(0, end);
				rest = rest.subarray(end);
				if (line.subarray(0, 3).equals(ERR)) command.output.push({ stream: "stderr", text: line.subarray(3).toString("utf8") });
				else {
					const text = (line.subarray(0, 3).equals(OUT) ? line.subarray(3) : line).toString("utf8");
					if (!ECHO.test(text.slice(0, 64))) command.output.push({ stream: "stdout", text });
				}
			}
			command.wake();
			if (rest.length > MAX_LINE_BYTES + 8) {
				ended(new Error("the process sent a line over the 1 MiB limit"));
				socket.close(1000);
			}
		};
		let opened!: (failure?: string) => void;
		const open = new Promise<string | undefined>((done) => (opened = done));
		socket.binaryType = "arraybuffer";
		socket.addEventListener("open", () => opened());
		socket.addEventListener("message", ({ data }) => {
			if (data instanceof ArrayBuffer) lines(Buffer.from(data), false);
			else if (ArrayBuffer.isView(data)) lines(Buffer.from(data.buffer, data.byteOffset, data.byteLength), false);
			else if (typeof data === "string") lines(Buffer.from(data), false);
		});
		socket.addEventListener("error", (event) => {
			opened(`the log stream failed: ${event.message ?? "no reason given"}`);
			ended(new Error(`the log stream failed${event.message ? `: ${event.message}` : ""}`));
		});
		socket.addEventListener("close", ({ code }) => {
			opened(`the log stream closed before it opened (code ${code ?? "none"})`);
			lines(Buffer.alloc(0), true);
			ended();
		});
		// The stream opens within the call's bound, or the command is let go of: its output would be lost.
		const bound = boundOf(ctx.timeoutMs, ctx.signal, "opening the log stream");
		try {
			const failed = await Promise.race([open, bound.promise]);
			if (failed !== undefined) throw new Error(failed);
		} catch (error) {
			await this.#letGo(command);
			throw error;
		} finally {
			bound.clear();
		}
		return command;
	}

	/** The command's output as its log stream gives it, then its exit code; the session is removed once they end. */
	async *#events(command: Command): AsyncGenerator<FramedEvent> {
		try {
			for (;;) {
				const next = command.output.shift();
				if (next !== undefined) yield next;
				else if (command.ended) break;
				else await new Promise<void>((done) => (command.wake = done));
			}
			if (command.failure) throw command.failure;
			if (command.killed) return;
			const until = Date.now() + LOG_GRACE_MS;
			for (;;) {
				const read = await this.#rest.json("GET", command.session, { retry: true });
				if (!read.ok) throw new Error(`reading the command's exit code failed (${read.error.code}): ${read.error.message}`);
				const found = ((read.value as { commands?: Array<{ id?: unknown; exitCode?: unknown }> } | null)?.commands ?? []).find((one) => one.id === command.commandId);
				if (typeof found?.exitCode === "number") {
					yield { exit: found.exitCode };
					return;
				}
				// A stream that closed with the command still running (none written within the grace) is an exit never read.
				if (Date.now() >= until) return;
				await sleep(this.#pollMs);
			}
		} finally {
			await this.#letGo(command);
		}
	}

	/**
	 * Text to the command's input, one call. Daytona's own 500 alone is sent again: the line reached no reader
	 * (internalRefusal), so it is never read twice; a line read twice would be a JSON-RPC request run twice.
	 */
	async #input(command: Command, data: string): Promise<void> {
		const sent = await this.#rest.call("POST", `${command.session}/command/${encodeURIComponent(command.commandId)}/input`, { json: { data }, retry: internalRefusal });
		// Its words never hold what was written: it may be a disk's token.
		if (!sent.ok) throw new Error(`writing to the command failed (${sent.error.code}): ${sent.error.message}`);
	}

	/** Closes the command's log stream and removes its session, once. */
	#letGo(command: Command): Promise<void> {
		command.socket.close(1000);
		return (command.removed ??= this.#rest.call("DELETE", command.session, {}).then(() => {}));
	}
}

/** One session command (DaytonaHost.#commands): its session, its log stream, and what the stream has given. */
interface Command {
	session: string;
	commandId: string;
	socket: WebSocketLike;
	/** The stream's output not read yet. */
	output: FramedEvent[];
	/** The stream closed, or failed (failure). */
	ended: boolean;
	failure?: Error;
	/** Wakes the events waiting for more. */
	wake: () => void;
	/** Input not sent yet: the start of a line. */
	held: string;
	killed: boolean;
	removed?: Promise<void>;
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
			gpuSnapshot,
			autoStopMinutes = 0,
			autoDeleteMinutes,
			connect,
			fetch: fetcher,
			webSocket,
			pause,
			timeouts = {},
			listedMs,
			...hosted
		} = options ?? ({} as DaytonaProviderOptions);
		const via = connectOf(DAYTONA, { connect });
		const refused = kindRefusal(DAYTONA, { kind: hosted.kind, connect: via });
		if (refused !== undefined) throw new Error(refused);
		if (typeof apiKey !== "string" || apiKey === "") throw new Error("options.apiKey, the Daytona API key, is required: the provider reads no environment, so the caller passes it");
		const base = new URL(apiUrl);
		if (base.protocol !== "https:") throw new Error(`the Daytona API URL must be https, so the key never crosses in the clear: ${base.protocol}`);
		if (arch !== "amd64" && arch !== "arm64") throw new Error(`options.arch is amd64 or arm64, not ${String(arch)}`);
		if (sandboxClass !== "container" && sandboxClass !== "linux-vm") throw new Error(`options.sandboxClass is container or linux-vm, not ${String(sandboxClass)}`);
		const minutes = (name: string, value: unknown) => {
			if (!isWhole(value) || value < 0) throw new Error(`${name} is a whole number of minutes, 0 or more, not ${String(value)}`);
		};
		minutes("autoStopMinutes", autoStopMinutes);
		if (autoDeleteMinutes !== undefined) minutes("autoDeleteMinutes", autoDeleteMinutes);
		const listed = listedMsOf(listedMs);
		const { retryMs = DEFAULT_RETRY_MS, ...asked } = timeouts;
		const hostedTimeouts = { ...(listed === undefined ? {} : { listedMs: listed }), ...asked };
		if (!isWhole(retryMs) || retryMs <= 0) throw new Error(`timeouts.retryMs must be a whole number of ms above 0, not ${retryMs}`);
		const { requestMs, pollMs } = timeoutsOf(hostedTimeouts);
		const headers = headersOf(apiKey);
		// The keys it was made with, by the options they fill: DAYTONA_ARCHIL_EGRESS's archilEgress turns its Archil mount on.
		const given = options as unknown as Record<string, unknown>;
		const set = (name: string) => {
			const value = given[DAYTONA.keys.find((key) => key.name === name)?.option ?? ""];
			return typeof value === "string" && value !== "";
		};
		const host = new DaytonaHost({
			// On dial its capabilities declare no GPU (DIAL_NO_GPU).
			descriptor: { ...DAYTONA, ...mountsOf(DAYTONA, set), ...(via === "dial" ? { capabilities: DAYTONA.capabilities.map(({ gpu: _gpu, ...rest }) => rest) } : {}) },
			rest: rest({ base: apiUrl, headers: () => headers, vendor: "daytona", fetch: fetcher ?? fetch, timeoutMs: requestMs, retry: { attempts: RETRY_ATTEMPTS, baseMs: retryMs, ...(pause ? { pause } : {}) }, explain }),
			headers,
			webSocket: webSocket ?? ((url, init) => new WebSocket(url, init as never) as unknown as WebSocketLike),
			arch,
			sandboxClass,
			...(target === undefined ? {} : { target }),
			gpu: daytonaGpuSnapshot(gpuSnapshot),
			autoStop: autoStopMinutes,
			autoDelete: autoDeleteMinutes ?? NO_AUTO_DELETE,
			pollMs,
			connect: via,
		});
		super(host, { ...hosted, timeouts: hostedTimeouts });
	}
}
