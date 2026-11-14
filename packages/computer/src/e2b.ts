// The E2B host: E2B Desktop sandboxes (kind desktop) or E2B's plain template (kind linux), every call through the
// host's own E2B JS SDK (the `e2b` package), of which this package names only the slice it uses (E2BSandboxClass) and
// imports nothing at load. E2B's envd is the sandbox's first process (under systemd), so computerd is a child: its
// upload goes through envd's file API and every command (install, init's start, the stdio bridge) is a background
// command as root. The rest of the computer is the shared machine-host adapter's (./hosted/provider.ts). Every SDK fact
// used here is cited in the README's E2B section, from e2b@2.63.0 (dist/index.mjs) and e2b-dev/infra@ff3922213 (envd).
import { E2B, E2B_BASE_TEMPLATE, E2B_DESKTOP_TEMPLATE } from "./descriptors/e2b.js";
import type { HostCall, HostFacts, Machine, MachineHost, MachineProcess, MachineRequest } from "./host.js";
import { deadlineOf, HostedProvider, type HostedOptions, type HostedTimeouts, IMAGE_LABEL, ours } from "./hosted/provider.js";
import { codeOfError, words } from "./hosted/process.js";
import { shellLine } from "./hosted/scripts.js";
import { dateOf, driftOf, isWhole, show } from "./hosted/values.js";
import { PassThrough } from "node:stream";
import type { KindCapabilities } from "./kinds.js";
import type { MountKind } from "./mount.js";
import type { ComputerSpec, NetworkPolicy, Refusal } from "./provider.js";
import { type ComputerErrorCode, failFor, ok, type Result } from "./result.js";
import { countTested } from "./test-connection.js";

/** This module's failures: one with code vendor names E2B. */
const fail = failFor("e2b");

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

/**
 * One event of envd's process stream (process.proto's ProcessEvent, index.d.mts:4979-5075): the start with the pid, the
 * output as bytes, keepalives, and the end with the exit code.
 */
export interface E2BProcessEvent {
	event:
		| { case: "start"; value: { pid: number } }
		| { case: "data"; value: { output: { case: "stdout" | "stderr" | "pty"; value: Uint8Array } | { case: undefined; value?: undefined } } }
		| { case: "end"; value: { exitCode: number; exited: boolean; status: string; error?: string } }
		| { case: "keepalive"; value: object }
		| { case: undefined; value?: undefined };
}

/** What Process.Start is given (process.proto's StartRequest, index.d.mts:4860-4943). */
export interface E2BStartRequest {
	process: { cmd: string; args: string[]; envs: Record<string, string> };
	stdin: boolean;
}

/**
 * envd's Process service as the SDK's Connect client calls it (Commands.rpc, index.mjs:4972-4985). Its start streams
 * each output chunk as the bytes envd read, where commands.run decodes them as UTF-8 text first (CommandHandle's
 * TextDecoder, index.mjs:2702, 2860), which turns every byte that is not UTF-8 into U+FFFD.
 */
export interface E2BProcessRpc {
	start(request: E2BStartRequest, options: { headers: Record<string, string>; signal: AbortSignal; timeoutMs: number }): AsyncIterable<{ event?: E2BProcessEvent }>;
}

/** The part of a connected Sandbox called here: commands and files (index.mjs:5917-5989). */
export interface E2BSandbox {
	readonly sandboxId: string;
	readonly files: { write(path: string, data: ArrayBuffer, options: { user: "root"; requestTimeoutMs: number; signal?: AbortSignal }): Promise<unknown> };
	readonly commands: {
		readonly rpc: E2BProcessRpc;
		sendStdin(pid: number, data: Uint8Array, options: { requestTimeoutMs: number }): Promise<void>;
		/** Ends a command's stdin, so it reads end of file (index.mjs:5071-5082). */
		closeStdin(pid: number, options: { requestTimeoutMs: number }): Promise<void>;
		/** SIGKILLs a command by pid (index.mjs:5092-5095). */
		kill(pid: number, options: { requestTimeoutMs: number }): Promise<boolean>;
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

/** The E2B provider's options: the key and the SDK, then the shared adapter's (HostedOptions). */
export interface E2BProviderOptions extends Omit<HostedOptions, "label" | "maxLifetimeMs"> {
	/** The E2B API key. The caller passes it; this provider never reads it from the environment or puts it in a computer. */
	apiKey: string;
	/** The SDK's Sandbox class: the host's `e2b` package's, or anything with the same slice. */
	Sandbox: E2BSandboxClass;
	/** E2B's domain: the API is https://api.<domain>. Default e2b.app. */
	domain?: string;
	/** desktop (default): a template with an X server, started through the daemon; linux: no screen. */
	kind?: "desktop" | "linux";
	/** The longest lifetime check takes: E2B Hobby's 1 h by default, Pro's 24 h at most. */
	maxLifetimeMs?: number;
	timeouts?: Partial<HostedTimeouts>;
}

/**
 * What create() takes: the provider's options, the SDK's Sandbox class optional (default the host's e2b package's).
 * Not E2BCreateOptions, which is the SDK's own Sandbox.create options.
 */
export interface E2BOptions extends Omit<E2BProviderOptions, "Sandbox"> {
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
 * while it is set in process.env, which the SDK reads. This read is a guard and not a setting, one of the library's two
 * touches of the environment (README, Settings); it only reads, and writes nothing.
 */
function ambientProblem(): string | undefined {
	if (process.env.E2B_SANDBOX_URL) {
		return "the E2B provider refuses to start while E2B_SANDBOX_URL is set: the SDK would send every call into a sandbox there. Unset it";
	}
	return undefined;
}

/**
 * An E2BProvider from its options alone; it reads no environment but the guard ambientProblem keeps. The key is
 * options.apiKey and nowhere else (serve passes its E2B_API_KEY, the conformance module the key it reads), and the
 * SDK's Sandbox class is the host's e2b package's unless given. Throws in words when an option is missing or wrong,
 * never echoing the key.
 */
export async function create(options: E2BOptions): Promise<E2BProvider> {
	const { apiKey, Sandbox: given, ...rest } = options ?? ({} as E2BOptions);
	if (typeof apiKey !== "string" || apiKey === "") throw new Error("options.apiKey, the E2B API key, is required: the provider reads no environment, so the caller passes it");
	const ambient = ambientProblem();
	if (ambient) throw new Error(ambient);
	const Sandbox = given ?? ((await import(E2B_PACKAGE)) as { Sandbox: E2BSandboxClass }).Sandbox;
	return new E2BProvider({ ...rest, apiKey, Sandbox });
}

/** The conformance CLI's module for E2B: its live switch, the run's 30-minute cap, its template and the drifted twin. */
export const conformance = () => import("./conformance/e2b.js");

const TEMPLATE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
/** The timeout create gave E2B, in ms: E2B's own end, startedAt plus this, until extend moves it. */
const TIMEOUT_LABEL = "agentrun.computer.timeout-ms";
/** E2B Hobby's longest sandbox: 1 h (index.d.mts:10169-10172). */
const HOBBY_MAX_MS = 60 * 60_000;
/** E2B Pro's: 24 h. */
const PRO_MAX_MS = 24 * 60 * 60_000;
const MAX_PAGES = 100;
const PAGE = 100;
/** E2B's end, read back, is its start plus the timeout create gave it, to the second it rounds to (index.mjs:502-504). */
const END_SLACK_MS = 2_000;
const DEFAULT_REQUEST_MS = 30_000;
const PUBLIC =
	"publicStream is no longer an option: an E2B computer never takes public traffic, which would open every port in it to anyone with its address, and its screen is streamed through agentrun, never a vendor URL";
/** envd's port in the sandbox (e2b@2.63.0 dist/index.mjs:1213, ConnectionConfig.envdPort). */
const ENVD_PORT = 49983;
/** envd's user for a process: root, as the SDK's authenticationHeader writes it (index.mjs:1896-1900). */
const ROOT = `Basic ${Buffer.from("root:").toString("base64")}`;
/** envd sends a keepalive event this often on a process stream, as the SDK asks (index.mjs:923, 5141). */
const KEEPALIVE_HEADER = "Keepalive-Ping-Interval";
const KEEPALIVE_S = "50";
/** The Connect codes envd's process calls answer (connectrpc Code), as this provider's codes. */
const CONNECT_CODES: Record<number, ComputerErrorCode> = { 1: "aborted", 3: "invalid", 4: "timeout", 5: "not_found", 7: "denied", 8: "limit", 16: "denied" };

/** The mount kinds an E2B computer takes, as capabilities().mount declares them: the run's folder on an Archil disk. */
export const MOUNT: readonly MountKind[] = E2B.mounts;
/** The machine kind and groups of each configuration: kind linux (the plain template), and kind desktop (the default). */
export const CAPABILITIES: readonly KindCapabilities[] = E2B.capabilities;


/** The SDK names its errors (index.mjs:86-360); Connect's carry a code. */
function codeOf(error: unknown): ComputerErrorCode {
	const name = (error as { name?: unknown } | null)?.name;
	if (name === "SandboxNotFoundError" || name === "NotFoundError" || name === "FileNotFoundError") return "not_found";
	if (name === "AuthenticationError") return "denied";
	if (name === "InvalidArgumentError" || name === "TemplateError") return "invalid";
	if (name === "RateLimitError" || name === "NotEnoughSpaceError") return "limit";
	if (name === "TimeoutError" || name === "SandboxUnreachableError") return "timeout";
	// envd's process stream, called through the SDK's Connect client (exec), throws Connect's own errors.
	if (name === "ConnectError") return CONNECT_CODES[(error as { code?: unknown }).code as number] ?? "vendor";
	return "vendor";
}

/** E2B's end as create set it: its start plus the timeout create gave, by E2B's clock; undefined when unread. */
function createdEnd({ metadata, startedAt }: { metadata: Record<string, string>; startedAt: Date }): number | undefined {
	const timeout = Number(metadata[TIMEOUT_LABEL]);
	const start = dateOf(startedAt)?.getTime();
	return isWhole(timeout) && timeout > 0 && start !== undefined ? start + timeout : undefined;
}

/** The earliest end a moved timer gives E2B: a second past create's end and its rounding, so deadlineOf reads it as moved. */
const clearOf = (created: number) => created + END_SLACK_MS + 1_000;

/**
 * A sandbox's network as E2B reports it. None is no internet access (E2B: the same as denyOut 0.0.0.0/0,
 * index.d.mts:10179) with no allow list and no public traffic in; open is internet access with none of those either.
 * Anything else is another network in words, never one it might widen to.
 */
function networkOf(info: E2BSandboxInfo): NetworkPolicy {
	const network = info.network ?? {};
	if (network.egressProxy !== undefined && network.egressProxy !== null) return { other: "an egress proxy is set on it" };
	if (Array.isArray(network.allowOut) && network.allowOut.length > 0) return { other: `an allowOut list (${network.allowOut.length} entries), which this provider never makes` };
	if (network.rules !== undefined && network.rules !== null && Object.keys(network.rules as object).length > 0) return { other: "transform rules, which this provider never makes" };
	const denied = Array.isArray(network.denyOut) ? network.denyOut : [];
	const blocked = info.allowInternetAccess === false || denied.includes("0.0.0.0/0");
	if (!blocked && denied.length > 0) return { other: `a denyOut list short of all traffic (${denied.join(", ")})` };
	if (network.allowPublicTraffic !== false) {
		return { other: network.allowPublicTraffic === true ? "public traffic is let in" : "E2B did not report allowPublicTraffic false: public traffic may be let in" };
	}
	return blocked ? "none" : "open";
}


/** A sandbox as the adapter reads a machine: E2B's states, its network, its template, its timer, and its create's drift. */
function machineOf(info: E2BSandboxInfo): Machine {
	const metadata = { ...(info.metadata ?? {}) };
	const end = info.endAt instanceof Date ? info.endAt.getTime() : Number.NaN;
	const created = createdEnd({ metadata, startedAt: info.startedAt });
	const { found: drift, mismatch } = driftOf();
	const started = dateOf(info.startedAt);
	// E2B reports the template's id, and its alias when it has one (index.mjs:5435-5437): a template asked for by an
	// alias E2B does not report back cannot be held to it, and its label records what was asked.
	const asked = metadata[IMAGE_LABEL];
	const alias = info.name;
	if (asked !== undefined && info.templateId !== asked && alias !== undefined && alias !== asked && !alias.startsWith(`${asked}:`)) {
		drift.push(`template: declared ${show(asked)}, read back ${show(info.templateId)} (${alias})`);
	}
	if (info.lifecycle?.onTimeout !== undefined && info.lifecycle.onTimeout !== "kill") mismatch("lifecycle onTimeout", "kill", info.lifecycle.onTimeout);
	if (info.lifecycle?.autoResume === true) mismatch("lifecycle autoResume", false, true);
	// An end later than create's is a moved timer (timerMoved: an extend's, or one create refuses on a machine it just
	// made); only an end it cannot read, or one earlier than create gave, is drift, at create and at attach alike.
	if (Number.isNaN(end) || created === undefined) drift.push(`endAt: E2B reported ${show(info.endAt)} from a start of ${show(info.startedAt)}, so it might not end the computer`);
	else if (end < created - END_SLACK_MS) drift.push(`endAt: ${info.endAt.toISOString()} is earlier than E2B's start plus the ${metadata[TIMEOUT_LABEL]} ms timeout create gave`);
	return {
		id: info.sandboxId,
		labels: metadata,
		state: info.state === "running" ? "running" : info.state === "paused" ? "stopped" : "going",
		network: networkOf(info),
		image: { resolved: info.templateId },
		...(started ? { createdAt: started } : {}),
		...(Number.isNaN(end) ? {} : { endsAt: new Date(end) }),
		// An end within END_SLACK_MS of create's is create's own, rounded: a moved timer never leaves E2B's end there (clearOf).
		timerMoved: !Number.isNaN(end) && created !== undefined && end > created + END_SLACK_MS,
		...(drift.length > 0 ? { drift } : {}),
	};
}

/** A listed sandbox whose read-back E2B no longer has: still listed, so it is going, not gone. */
const listedOnly = (sb: E2BListedSandbox): Machine => {
	const started = dateOf(sb.startedAt);
	return { id: sb.sandboxId, labels: { ...(sb.metadata ?? {}) }, state: "going", ...(started ? { createdAt: started } : {}) };
};

/** One chunk of the SDK's output into a stream, unless the stream has ended. */
const push = (stream: PassThrough, data: Uint8Array) => void (stream.writableEnded || stream.write(data));

/** E2B's sandboxes as a MachineHost (../host.ts). */
class E2BHost implements MachineHost {
	readonly id = "e2b";
	readonly facts: HostFacts = {
		daemon: "child",
		isolation: "microvm",
		lifetime: "vendor",
		maxLifetimeMs: PRO_MAX_MS,
		arch: "amd64",
		vendorAgentPorts: [ENVD_PORT],
		networkReadBack: true,
		network: [...E2B.network],
		mounts: [...MOUNT],
		release: ["delete"],
	};
	readonly #Sandbox: E2BSandboxClass;
	readonly #connection: E2BConnectionOptions;
	readonly #requestMs: number;
	/** Each sandbox create or connect gave, by id, for envd's commands and files: let go of at its delete. */
	readonly #sandboxes = new Map<string, E2BSandbox>();

	constructor(Sandbox: E2BSandboxClass, connection: E2BConnectionOptions, requestMs: number) {
		this.#Sandbox = Sandbox;
		this.#connection = connection;
		this.#requestMs = requestMs;
	}

	errorCode(error: unknown): ComputerErrorCode {
		return codeOf(error);
	}

	/** The connection options with a bound and, when given, the caller's signal. */
	#api(ms: number, signal?: AbortSignal): E2BConnectionOptions {
		return { ...this.#connection, requestTimeoutMs: ms, ...(signal ? { signal } : {}) };
	}

	/** An E2B template is a name or id: letters, digits and ._:/- (no shell word, no path out). */
	check(spec: ComputerSpec): Refusal[] {
		const image = (spec as { image?: unknown } | null)?.image;
		if (typeof image === "string" && image !== "" && !TEMPLATE.test(image)) {
			return [{ field: "image", message: `an image is the name or id of an E2B template, such as "${E2B_DESKTOP_TEMPLATE}" (E2B Desktop) or "${E2B_BASE_TEMPLATE}"` }];
		}
		return [];
	}

	/**
	 * Sandbox.create with the lifetime as its timeout in the whole seconds E2B takes (index.mjs:502-504), recorded in a
	 * label for its end's arithmetic; no internet access unless the adapter asks open (an Archil computer's root), no
	 * public traffic (a project's default may let it in: E2B docs, network/restrict-public-access), and kill at the
	 * timeout, never a pause that keeps the computer (index.mjs:5674-5699).
	 */
	async create(req: MachineRequest, ctx: HostCall): Promise<Result<{ id: string }>> {
		const timeoutMs = Math.ceil((req.lifetimeMs ?? 0) / 1000) * 1000;
		const options: E2BCreateOptions = {
			...this.#api(ctx.timeoutMs),
			timeoutMs,
			metadata: { ...req.labels, [TIMEOUT_LABEL]: String(timeoutMs) },
			envs: {},
			allowInternetAccess: req.network === "open",
			network: { allowPublicTraffic: false },
			lifecycle: { onTimeout: "kill" },
		};
		const sandbox = await this.#Sandbox.create(req.image, options);
		this.#sandboxes.set(sandbox.sandboxId, sandbox);
		return ok({ id: sandbox.sandboxId });
	}

	/** getInfo; a sandbox E2B does not have (SandboxNotFoundError, index.mjs:5431) is not_found, which the adapter reads as none. */
	async get(id: string, ctx: HostCall): Promise<Result<Machine | undefined>> {
		return ok(machineOf(await this.#Sandbox.getInfo(id, this.#api(ctx.timeoutMs, ctx.signal))));
	}

	/**
	 * Every sandbox E2B lists with these metadata pairs (running and paused, index.d.mts:10289), all pages, each read
	 * back by getInfo, since a listing does not carry the network; one bound, ctx.timeoutMs, for every page and read.
	 */
	async list(labels: Record<string, string>, ctx: HostCall): Promise<Result<Machine[]>> {
		const until = Date.now() + ctx.timeoutMs;
		const left = () => Math.max(1, Math.min(this.#requestMs, until - Date.now()));
		const paginator = this.#Sandbox.list({ ...this.#connection, requestTimeoutMs: this.#requestMs, query: { metadata: labels }, limit: PAGE });
		const found = new Map<string, E2BListedSandbox>();
		for (let page = 0; paginator.hasNext; page++) {
			if (page >= MAX_PAGES) return fail("vendor", `Sandbox.list ran past ${MAX_PAGES} pages`);
			const items = await paginator.nextItems({ requestTimeoutMs: left(), ...(ctx.signal ? { signal: ctx.signal } : {}) });
			if (!Array.isArray(items)) return fail("vendor", "Sandbox.list: a page that is not a list of sandboxes");
			for (const sb of items) if (typeof sb?.sandboxId === "string") found.set(sb.sandboxId, sb);
		}
		const machines: Machine[] = [];
		for (const sb of found.values()) {
			if (Date.now() >= until) return fail("timeout", `${machines.length} sandboxes were read back, ${sb.sandboxId} and any after it were not`);
			const read = await this.get(sb.sandboxId, { timeoutMs: left(), ...(ctx.signal ? { signal: ctx.signal } : {}) }).catch((error: unknown) => {
				if (codeOf(error) !== "not_found") throw error;
				return ok(undefined);
			});
			if (!read.ok) return read;
			machines.push(read.value ?? listedOnly(sb));
		}
		return ok(machines);
	}

	/** Sandbox.kill, never signalled: a kill that cleans up after an abort must outlive it. */
	async delete(id: string, ctx: HostCall): Promise<Result<void>> {
		this.#sandboxes.delete(id);
		await this.#Sandbox.kill(id, this.#api(ctx.timeoutMs));
		return ok(undefined);
	}

	/**
	 * A connected Sandbox for envd's commands and files: the one create gave, or Sandbox.connect, whose timeout is a
	 * little under what is left: E2B moves a running sandbox's timer only to a longer one (index.d.mts:10250-10255), so
	 * connecting never moves the end. The adapter connects only to a sandbox it read running: connect resumes a paused one.
	 */
	async #sandbox(id: string, ctx: HostCall): Promise<E2BSandbox> {
		const known = this.#sandboxes.get(id);
		if (known !== undefined) return known;
		const info = await this.#Sandbox.getInfo(id, this.#api(ctx.timeoutMs, ctx.signal));
		const left = info.endAt instanceof Date ? info.endAt.getTime() - Date.now() : 0;
		const timeoutMs = Math.max(1_000, Math.floor(left / 1000) * 1000 - 2_000);
		const sandbox = await this.#Sandbox.connect(id, { ...this.#api(ctx.timeoutMs, ctx.signal), timeoutMs });
		this.#sandboxes.set(id, sandbox);
		return sandbox;
	}

	/** files.write as root (index.mjs:2332-2435). */
	async upload(id: string, path: string, bytes: Uint8Array, ctx: HostCall): Promise<Result<void>> {
		const sandbox = await this.#sandbox(id, ctx);
		const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
		await sandbox.files.write(path, buffer, { user: "root", requestTimeoutMs: ctx.timeoutMs, ...(ctx.signal ? { signal: ctx.signal } : {}) });
		return ok(undefined);
	}

	/**
	 * A process as root through envd's Process.Start stream, as commands.run starts one (index.mjs:5123-5146): `bash -l -c`
	 * and the argv quoted, root by the Basic header (authenticationHeader, index.mjs:1896-1900), and envd's keepalive
	 * every 50 s. Its stdout and stderr are the bytes each data event carries, passed on as they come: commands.run would
	 * decode them as UTF-8 text first. No deadline on the stream (timeoutMs 0, which the Connect transport reads as none,
	 * connect-web connect-transport.js:145-150), so envd never ends it (start.go:39-44); the start alone is bounded by
	 * ctx. Writes go one sendStdin at a time, in order; end is closeStdin; kill SIGKILLs it and lets go of its stream.
	 */
	async exec(id: string, argv: readonly string[], { stdin }: { stdin: boolean }, ctx: HostCall): Promise<Result<MachineProcess>> {
		const sandbox = await this.#sandbox(id, ctx);
		const out = new PassThrough();
		const err = new PassThrough();
		const requestTimeoutMs = this.#requestMs;
		const stream = new AbortController();
		const events = sandbox.commands.rpc.start(
			{ process: { cmd: "/bin/bash", args: ["-l", "-c", shellLine(argv)], envs: {} }, stdin },
			{ headers: { Authorization: ROOT, [KEEPALIVE_HEADER]: KEEPALIVE_S }, signal: stream.signal, timeoutMs: 0 },
		)[Symbol.asyncIterator]();
		// The start, within ctx: a stream that gives no start event in time, or the caller's abort, is let go of.
		const startAbort = () => stream.abort(ctx.signal?.reason);
		ctx.signal?.addEventListener("abort", startAbort, { once: true });
		const startTimer = setTimeout(() => stream.abort(), ctx.timeoutMs);
		let pid: number;
		try {
			const first = await events.next();
			const event = first.done ? undefined : first.value.event?.event;
			if (event?.case !== "start") throw new Error(`envd's process stream began with ${event?.case ?? "nothing"}, not its start`);
			pid = event.value.pid;
		} catch (error) {
			const why = stream.signal.aborted ? (ctx.signal?.aborted ? "AbortError" : "TimeoutError") : undefined;
			stream.abort();
			if (why === undefined) throw error;
			throw Object.assign(new Error(why === "AbortError" ? "the exec was aborted before envd started it" : `envd did not start the process within ${ctx.timeoutMs / 1000} s`), { name: why });
		} finally {
			clearTimeout(startTimer);
			ctx.signal?.removeEventListener("abort", startAbort);
		}
		const exited = (async () => {
			let code = -1;
			try {
				for (;;) {
					const next = await events.next();
					if (next.done) break;
					const event = next.value.event?.event;
					if (event?.case === "data") {
						const { output } = event.value;
						if (output.case === "stdout") push(out, output.value);
						else if (output.case === "stderr") push(err, output.value);
					} else if (event?.case === "end") {
						code = event.value.exitCode;
						break;
					}
				}
			} catch {
				// A stream that broke, or one kill let go of: no exit code was read.
			}
			out.end();
			err.end();
			stream.abort();
			return code;
		})();
		return ok({
			stdout: out,
			stderr: err,
			write: (bytes) => sandbox.commands.sendStdin(pid, bytes, { requestTimeoutMs }),
			end: () => sandbox.commands.closeStdin(pid, { requestTimeoutMs }),
			wait: () => exited,
			kill: async () => {
				await sandbox.commands.kill(pid, { requestTimeoutMs }).catch(() => false);
				stream.abort();
				out.end();
				err.end();
			},
		});
	}

	/**
	 * Moves E2B's timer (setTimeout, index.mjs:5529-5541) in the whole seconds E2B takes: up to clear create's end, so
	 * the end reads as moved (deadlineOf), and down at the most the computer may live, so E2B's timer never passes it by
	 * this machine's clock. A timer that would end before the deadline held now, or within create's rounding, is refused
	 * as limit, and nothing moves.
	 */
	async setTimer(id: string, { end, most }: { end: Date; most: Date }, ctx: HostCall): Promise<Result<void>> {
		const info = await this.#Sandbox.getInfo(id, this.#api(ctx.timeoutMs, ctx.signal));
		const machine = machineOf(info);
		const now = Date.now();
		const target = end.getTime();
		const created = createdEnd(info);
		const want = created === undefined ? target : Math.max(target, clearOf(created));
		const timerMs = Math.min(Math.ceil((want - now) / 1000) * 1000, Math.floor((most.getTime() - now) / 1000) * 1000);
		const vendorEnd = machine.endsAt?.getTime() ?? Number.NaN;
		const current = (deadlineOf(machine) ?? machine.endsAt)?.getTime() ?? now;
		const held = Number.isNaN(vendorEnd) ? current : Math.max(current, vendorEnd);
		const name = info.metadata?.["agentrun.computer.name"] ?? id;
		if (now + timerMs < held) {
			return fail("limit", `no whole number of seconds E2B takes moves ${name}'s end from ${new Date(held).toISOString()} to ${end.toISOString()} without passing ${most.toISOString()}, the most this computer may live; nothing moved`);
		}
		if (created !== undefined && now + timerMs < clearOf(created)) {
			return fail("limit", `${end.toISOString()} is within E2B's rounding of the end create gave ${name}, and moving E2B's end clear of it would pass ${most.toISOString()}, the most this computer may live`);
		}
		await this.#Sandbox.setTimeout(id, timerMs, this.#api(ctx.timeoutMs, ctx.signal));
		return ok(undefined);
	}

	/**
	 * Settings' test: one page of the account's sandboxes by the adapter's own metadata, which makes nothing. The count is
	 * read from the listing, with no getInfo of each: a busy account answers as fast, and one sandbox's read never fails a
	 * working key. A further page is "or more".
	 */
	async testConnection(ctx: HostCall): Promise<Result<{ detail: string }>> {
		try {
			const paginator = this.#Sandbox.list({ ...this.#connection, requestTimeoutMs: ctx.timeoutMs, query: { metadata: { "agentrun.computer": "1" } }, limit: PAGE });
			const items = await paginator.nextItems({ requestTimeoutMs: ctx.timeoutMs, ...(ctx.signal ? { signal: ctx.signal } : {}) });
			if (!Array.isArray(items)) return countTested("E2B", fail("vendor", "Sandbox.list: a page that is not a list of sandboxes"));
			const count = items.filter((sb) => typeof sb?.sandboxId === "string" && ours(sb.metadata)).length;
			return countTested("E2B", ok({ count, more: paginator.hasNext }));
		} catch (error) {
			return countTested("E2B", fail(codeOfError(this, error), `Sandbox.list failed: ${words(error)}`));
		}
	}
}

/**
 * Computers that are E2B sandboxes, on the shared adapter. A spec's image is an E2B template (its name or id):
 * "desktop" is E2B Desktop's, with Xvfb, x11vnc and noVNC (e2b-dev/desktop template.py:21-65).
 */
export class E2BProvider extends HostedProvider {
	constructor(options: E2BProviderOptions) {
		// A caller who still names the option is told it is gone, whatever its value: it once let public traffic in.
		if (typeof options === "object" && options !== null && Object.hasOwn(options, "publicStream")) throw new Error(PUBLIC);
		const { apiKey, Sandbox, domain = DEFAULT_DOMAIN, kind = "desktop", maxLifetimeMs = HOBBY_MAX_MS, ...rest } = options;
		if (typeof apiKey !== "string" || apiKey === "") throw new Error("an E2B API key is required");
		const lacks = ["create", "connect", "getInfo", "setTimeout", "kill", "list"].filter((name) => typeof (Sandbox as unknown as Record<string, unknown>)?.[name] !== "function");
		if (lacks.length > 0) throw new Error(`options.Sandbox must be the e2b SDK's Sandbox class; it lacks ${lacks.join(", ")}`);
		const ambient = ambientProblem();
		if (ambient) throw new Error(ambient);
		if (typeof domain !== "string" || !DOMAIN.test(domain)) throw new Error(`the E2B domain must be a host name such as ${DEFAULT_DOMAIN}, not ${JSON.stringify(domain)}`);
		if (!isWhole(maxLifetimeMs) || maxLifetimeMs <= 0 || maxLifetimeMs > PRO_MAX_MS) {
			throw new Error(`maxLifetimeMs must be a whole number of ms above 0 and at most 24 h (${PRO_MAX_MS} ms), E2B Pro's longest sandbox; Hobby's is 1 h`);
		}
		const requestMs = rest.timeouts?.requestMs ?? DEFAULT_REQUEST_MS;
		super(new E2BHost(Sandbox, connectionOptions({ apiKey, domain }), requestMs), { ...rest, label: "E2B", kind, maxLifetimeMs });
	}
}
