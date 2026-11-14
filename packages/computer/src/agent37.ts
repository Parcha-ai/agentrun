// The Agent37 host: Agent37 Cloud instances (kind linux, or kind desktop on our box template, agentrun-box, whose Xvfb
// the adapter starts through the daemon), each a whole VM by default (type "vm"), or a gVisor sandbox
// (type "default"). The control plane is Agent37's REST API over fetch (https://api.agent37.com/v1, a Bearer key);
// every command (the daemon's upload, its install, init's start, the stdio bridge) goes over SSH, as root, through the
// host's own ssh2 package, of which this package names only the slice it uses (Ssh2Module) and imports nothing at load.
// Agent37 has no SSH port on the internet: the SSH stream rides a binary WebSocket to wss://{id}-22022.agent37.app,
// which the edge opens for the workspace key in X-Agent37-Key (npm agent37@0.4.1 src/cli.js, wsHandshake and runTunnel),
// and the instance's sshd then takes the workspace's registered SSH key. Agent37's REST exec is one-shot (no stdin,
// output only at its end), so it is not used. The rest of the computer is the shared machine-host adapter's
// (./hosted/provider.ts). Every vendor fact here is cited in the README's Agent37 section.
import { createHash, randomBytes } from "node:crypto";
import { Duplex, PassThrough } from "node:stream";
import { AGENT37, AGENT37_BASE_TEMPLATE } from "./descriptors/agent37.js";
import { WINDOW_MANAGER } from "./desktop.js";
import type { HostCall, HostFacts, Machine, MachineHost, MachineProcess, MachineRequest } from "./host.js";
import { bounded } from "./hosted/process.js";
import { HostedProvider, type HostedOptions, type HostedTimeouts, IMAGE_LABEL } from "./hosted/provider.js";
import { jsonOf, type Rest, rest } from "./hosted/rest.js";
import { shellLine } from "./hosted/scripts.js";
import type { KindCapabilities } from "./kinds.js";
import type { MountKind } from "./mount.js";
import type { ComputerSpec, NetworkPolicy, Refusal } from "./provider.js";
import { type ComputerErrorCode, ok, type Result } from "./result.js";

/** A readable side of an ssh2 channel, as this provider uses it: piped, or drained. */
export interface Ssh2Readable {
	pipe(destination: NodeJS.WritableStream): unknown;
	resume(): unknown;
}

/**
 * The slice of an ssh2 channel this provider uses (ssh2@1.17.0 lib/Channel.js): the channel is stdout. No signal
 * request: ssh2 sends one only while stdin is open (Channel.js:237-246), so a kill goes by the process group instead.
 */
export interface Ssh2Channel extends Ssh2Readable {
	readonly stderr: Ssh2Readable;
	write(data: Uint8Array, callback?: (error?: Error | null) => void): boolean;
	/** Sends end of file on stdin and keeps the channel open (Channel.js:200-205). */
	eof(): void;
	close(): void;
	/** exit-status, or exit-signal with a null code (client.js:666-678). */
	on(event: "exit", listener: (code: number | null, signal?: string) => void): unknown;
	on(event: "close", listener: () => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
}

/** The options of ssh2's Client.connect this provider gives (ssh2@1.17.0 lib/client.js). */
export interface Ssh2ConnectConfig {
	sock: Duplex;
	username: "root";
	privateKey: string;
	readyTimeout: number;
	keepaliveInterval: number;
}

/** The slice of an ssh2 Client this provider uses. */
export interface Ssh2Client {
	connect(config: Ssh2ConnectConfig): unknown;
	exec(command: string, callback: (error: Error | undefined, channel: Ssh2Channel) => void): unknown;
	end(): unknown;
	destroy(): unknown;
	once(event: "ready", listener: () => void): unknown;
	once(event: "error", listener: (error: Error) => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	on(event: "close" | "end", listener: () => void): unknown;
	removeListener(event: "error", listener: (error: Error) => void): unknown;
}

/** The ssh2 package as this provider uses it: its Client class. The host's own, or anything with the same slice. */
export interface Ssh2Module {
	Client: new () => Ssh2Client;
}

/** A WebSocket as this provider uses one: Node's global WebSocket (undici), which takes headers, or the same slice. */
export interface WebSocketLike {
	binaryType: string;
	readonly readyState: number;
	readonly bufferedAmount: number;
	send(data: Uint8Array): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "open" | "close" | "error", listener: (event: { code?: number; reason?: string; message?: string }) => void): void;
	addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export type WebSocketClass = new (url: string, init: { headers: Record<string, string> }) => WebSocketLike;

/** One Agent37 instance as the REST API answers it (docs: agents-api/instances/object), as far as this provider reads it. */
export interface Agent37Instance {
	id: string;
	status: string;
	status_reason?: { code?: string; message?: string } | null;
	template?: string;
	image_digest?: string | null;
	type?: string;
	region?: string;
	resources?: { cpu?: number; memory?: number; disk?: number };
	public_ports?: unknown[];
	name?: string | null;
	metadata?: Record<string, string> | null;
	auto_sleep?: boolean;
	network?: unknown;
	created?: number;
}

/** What Agent37 runs an instance on: a VM with its own kernel, or a gVisor sandbox (docs: agents-api/vm-instances). */
export type Agent37Type = "vm" | "default";
/** Where an instance runs (docs: agents-api/instances/create, region). */
export type Agent37Region = "us" | "eu" | "ap-south";

/** The Agent37 provider's options: the key, the SSH key and ssh2, then the shared adapter's (HostedOptions). */
export interface Agent37ProviderOptions extends Omit<HostedOptions, "label" | "maxLifetimeMs"> {
	/** The workspace's API key (sk_live_...). The caller passes it; this provider never reads it from the environment. */
	apiKey: string;
	/**
	 * The private half of an SSH key registered on the same workspace (POST /v1/ssh-keys), in OpenSSH or PEM form: its
	 * contents, never a path. Every command reaches an instance over SSH as root with it.
	 */
	sshKey: string;
	/** The ssh2 package: the host's own, or anything with the same slice. */
	ssh2: Ssh2Module;
	/** The fetch every REST call goes through; default the global one. */
	fetch?: typeof fetch;
	/** The WebSocket the SSH stream rides; default Node's global one. */
	WebSocket?: WebSocketClass;
	/** Agent37's REST API; default https://api.agent37.com. */
	apiUrl?: string;
	/** The domain an instance's ports answer under, {id}-{port}.<domain>; default agent37.app. */
	proxyDomain?: string;
	/** vm (default): a whole VM with its own kernel; default: Agent37's gVisor sandbox. */
	type?: Agent37Type;
	/** us (default), eu or ap-south; outside us, type vm alone. */
	region?: Agent37Region;
	/**
	 * linux (default): no screen; desktop: an X server started through the daemon (Xvfb on :0 unless options.desktop says
	 * otherwise), so the spec's image is a template that has one: our box template, agentrun-box (box/build-agent37.mjs).
	 */
	kind?: "desktop" | "linux";
	/** The longest lifetime check takes: 24 h by default, the janitor's cap; Agent37 itself never ends an instance. */
	maxLifetimeMs?: number;
	timeouts?: Partial<HostedTimeouts>;
}

/** What create() takes: the provider's options, ssh2 optional (default the host's ssh2 package). */
export interface Agent37Options extends Omit<Agent37ProviderOptions, "ssh2"> {
	ssh2?: Ssh2Module;
}

/** Not a literal, so no type checker or bundler resolves ssh2 from this package. */
const SSH2_PACKAGE: string = "ssh2";
const DEFAULT_API_URL = "https://api.agent37.com";
const DEFAULT_PROXY_DOMAIN = "agent37.app";
/** The port the platform's sshd answers on inside every instance, reached as {id}-22022.<domain> (cli.js:21, 720). */
export const AGENT37_SSH_PORT = 22022;
/** The platform's web terminal (ttyd), a root shell for whoever reaches it: seen listening on every VM. */
const AGENT37_TTYD_PORT = 7681;
/** An instance id: ten lowercase letters and digits, its DNS label (docs: instances/object; cli.js:19). */
const INSTANCE_ID = /^[a-z0-9]{10}$/;
/** A template name (cli.js:18), with an optional @<version> pin (docs: templates, pin a template version). */
const TEMPLATE = /^[a-z][a-z0-9-]{1,62}(@[A-Za-z0-9._-]{1,64})?$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const DAY_MS = 24 * 60 * 60_000;
/** The instance shapes Agent37 makes, cpu and memory in GB (docs: instance-sizing): 4 vCPU is every type's ceiling. */
const SHAPES: ReadonlyArray<{ cpu: number; memory: number }> = [
	{ cpu: 2, memory: 4 },
	{ cpu: 4, memory: 8 },
	{ cpu: 4, memory: 16 },
	{ cpu: 4, memory: 32 },
];
const MAX_CPUS = 4;
/** metadata's cap, serialized (docs: instances/edit, "up to 4 KB serialized"). */
const METADATA_MAX_BYTES = 4096;
/** A VM boots inside the create's POST, which answers once it runs (docs: instances/create, Defaults). */
const DEFAULT_CREATE_MS = 300_000;
const DEFAULT_REQUEST_MS = 30_000;
/** How much a tunnel may hold unsent before a write waits for it (the WebSocket's bufferedAmount). */
const TUNNEL_HIGH_WATER = 1024 * 1024;
const TUNNEL_POLL_MS = 10;
/** How many times a tunnel that fails before its SSH handshake is opened, and the first pause between (it doubles). */
const TUNNEL_TRIES = 4;
const TUNNEL_RETRY_MS = 500;
/** ssh2's keepalive: the CLI's ServerAliveInterval is 60 s (cli.js:32); the edge never sees an idle tunnel. */
const KEEPALIVE_MS = 30_000;
/**
 * How long a kill waits for its own kill command, then for its channel to close before wait() answers -1 anyway; and
 * how long an ended SSH connection has to close before its tunnel is dropped.
 */
const KILL_GRACE_MS = 2_000;
/**
 * How many channels (execs and kills) one SSH connection carries at once; the next opens a second connection. OpenSSH's
 * sshd takes MaxSessions (default 10) sessions on one connection and refuses the next. Agent37 does not say which sshd
 * it runs, so OpenSSH's default is held to; an sshd that takes fewer refuses a channel, which is opened once more on a
 * fresh connection.
 */
const CHANNELS_PER_CONNECTION = 10;
/**
 * How long a connection with no channel stays open for the next exec. The adapter's steps (the upload, the install,
 * init's start, the bridge, connect after create) come one after another, each an exec, and the live view's watch
 * opens beside the bridge. An open connection keeps the process alive (ssh2's keepalive timer and the WebSocket's
 * socket are both referenced), so the wait is short: a process that is done with its computers exits at most this late.
 */
const IDLE_MS = 2_000;
/**
 * Every command runs under this sh, which writes its pid to $0 first and removes the file when the command ends. The
 * instance's sshd starts each command as a session and group leader (seen live: sh's PID, PGID and SID are one), so
 * the pid names the group a kill ends; ssh2 sends no signal once stdin has ended, and a signal ends one process only.
 */
const WRAPPER = '{ echo $$ > "$0"; } 2>/dev/null; "$@"; c=$?; rm -f "$0"; exit $c';
/**
 * The kill: waits up to a second for the pid file, then kills the group when the pid leads one (the process alone
 * otherwise, so a kill never reaches past what it started) and removes the file.
 */
const KILL_SCRIPT = [
	"i=0",
	'while [ ! -s "$0" ] && [ $i -lt 10 ]; do sleep 0.1; i=$((i+1)); done',
	'p=$(cat "$0" 2>/dev/null); rm -f "$0"',
	'[ -n "$p" ] || exit 0',
	'g=$(cut -d" " -f5 "/proc/$p/stat" 2>/dev/null)',
	// No "--": dash's kill reads it as a pid (seen live: "Illegal number: -").
	'if [ "$g" = "$p" ]; then kill -KILL "-$p"; else kill -KILL "$p"; fi 2>/dev/null',
	"exit 0",
].join("\n");

/** The mount kinds an Agent37 computer takes, as capabilities().mount declares them: the run's folder on an Archil disk. */
export const MOUNT: readonly MountKind[] = AGENT37.mounts;
/** The machine kind and groups of each configuration: kind linux (the default), and kind desktop on the box template. */
export const CAPABILITIES: readonly KindCapabilities[] = AGENT37.capabilities;

const show = (value: unknown) => (value === undefined ? "nothing" : JSON.stringify(value));
const isWhole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

/** An answer of Agent37's REST API that is not a success, as the code its status and the envelope's stable code (docs: errors) make. */
export class Agent37Error extends Error {
	override name = "Agent37Error";
	readonly code: ComputerErrorCode;
	constructor(code: ComputerErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

/** The SSH tunnel's WebSocket closed or failed before it opened, or while it carried the stream. */
export class Agent37TunnelError extends Error {
	override name = "Agent37TunnelError";
}

/** The envelope's code: { error: { code } } on the Sandbox API, a flat { error: "<code>" } on transport errors (docs: errors). */
function envelopeOf(body: unknown): { code?: string; message?: string } {
	const error = (body as { error?: unknown } | null)?.error;
	if (typeof error === "string") return { code: error, ...(typeof (body as { message?: unknown }).message === "string" ? { message: (body as { message: string }).message } : {}) };
	if (typeof error === "object" && error !== null) {
		const { code, message } = error as { code?: unknown; message?: unknown };
		return { ...(typeof code === "string" ? { code } : {}), ...(typeof message === "string" ? { message } : {}) };
	}
	return {};
}

/** Agent37's codes (docs: errors, Sandbox API codes), each as a ComputerErrorCode; any other is the vendor's. */
const CODES: Record<string, ComputerErrorCode> = {
	not_found: "not_found",
	invalid_api_key: "denied",
	ip_not_allowed: "denied",
	forbidden: "denied",
	invalid_request: "invalid",
	image_too_large: "invalid",
	insufficient_balance: "limit",
	instance_limit_reached: "limit",
	tier_limit: "limit",
	no_capacity: "limit",
	capacity_unavailable: "limit",
	rate_limited: "limit",
};

function codeOf(error: unknown): ComputerErrorCode {
	const { name, level } = (error ?? {}) as { name?: unknown; level?: unknown };
	if (name === "AbortError") return "aborted";
	if (name === "TimeoutError") return "timeout";
	if (error instanceof Agent37Error) return error.code;
	// ssh2 names the stage that failed (lib/client.js): the instance's sshd refused the key, or the handshake timed out.
	if (level === "client-authentication") return "denied";
	if (level === "client-timeout") return "timeout";
	return "vendor";
}

/** An instance's network as Agent37 reads it back, with its public ports: "allow-all" open, "deny-all" none. */
function networkOf(instance: Agent37Instance): NetworkPolicy {
	const ports = Array.isArray(instance.public_ports) ? instance.public_ports : [];
	if (ports.length > 0) {
		const numbers = ports.map((port) => (port as { port?: unknown } | null)?.port).filter((port) => typeof port === "number");
		return { other: `public ports (${numbers.join(", ") || ports.length}) let anyone in, which this provider never makes` };
	}
	const { network } = instance;
	if (network === "deny-all") return "none";
	if (network === "allow-all") return "open";
	const allow = (network as { allow?: unknown } | null)?.allow;
	if (Array.isArray(allow)) return { other: `an allow list (${allow.length} entries), which this provider never makes` };
	return { other: `Agent37 read back the network ${show(network)}` };
}

/** Agent37's statuses (docs: instances/object, Statuses) as the adapter's states. */
function stateOf(status: string): Machine["state"] | undefined {
	if (status === "running") return "running";
	if (["provisioning", "starting", "waking", "restarting", "updating"].includes(status)) return "starting";
	if (["stopping", "stopped", "sleeping"].includes(status)) return "stopped";
	if (status === "failed") return "failed";
	if (status === "deleting" || status === "deleted") return "going";
	return undefined;
}

/** What one provider declared of its instances: its type and region, held at create and attach. */
interface Declared {
	type: Agent37Type;
	region: Agent37Region;
}

/** An instance as the adapter reads a machine: its state, labels, network, template, size, and its create's drift. */
function machineOf(instance: Agent37Instance, declared: Declared): Machine {
	const labels = { ...(instance.metadata ?? {}) };
	const drift: string[] = [];
	const mismatch = (field: string, want: unknown, got: unknown) => drift.push(`${field}: declared ${show(want)}, read back ${show(got)}`);
	const asked = labels[IMAGE_LABEL];
	if (asked !== undefined && instance.template !== asked) mismatch("template", asked, instance.template);
	if (instance.type !== declared.type) mismatch("type", declared.type, instance.type);
	if (instance.region !== declared.region) mismatch("region", declared.region, instance.region);
	// A sleeping VM wakes cold, its daemon gone (docs: vm-instances, Auto-sleep): auto-sleep stays off.
	if (instance.auto_sleep !== false) mismatch("auto_sleep", false, instance.auto_sleep);
	const state = stateOf(instance.status);
	const why = instance.status_reason?.message ?? (state === undefined ? `Agent37 reads the status ${show(instance.status)}, which this provider does not know` : undefined);
	const { cpu, memory } = instance.resources ?? {};
	return {
		id: instance.id,
		labels,
		state: state ?? "failed",
		network: networkOf(instance),
		image: { resolved: instance.image_digest ?? instance.template },
		...(isWhole(instance.created) ? { createdAt: new Date(instance.created * 1000) } : {}),
		...(isWhole(cpu) || isWhole(memory) ? { size: { ...(isWhole(cpu) ? { cpus: cpu } : {}), ...(isWhole(memory) ? { memoryMb: memory * 1024 } : {}) } } : {}),
		...(drift.length > 0 ? { drift } : {}),
		...(why === undefined ? {} : { why }),
	};
}

/** The shape a request's cpus and memoryMb ask for, or undefined when they ask for none of Agent37's. */
function shapeOf(cpus: number | undefined, memoryMb: number | undefined): { cpu: number; memory: number } | undefined {
	return SHAPES.find((shape) => (cpus === undefined || shape.cpu === cpus) && (memoryMb === undefined || shape.memory * 1024 === memoryMb));
}

const SHAPE_WORDS = SHAPES.map(({ cpu, memory }) => `${cpu} CPUs with ${memory * 1024} MiB`).join(", ");

/**
 * A WebSocket's binary stream as a Duplex for ssh2: what the socket gives is read, a write is one binary frame, and a
 * write waits while the socket holds more than TUNNEL_HIGH_WATER unsent. Its end closes the socket.
 */
function tunnelOf(ws: WebSocketLike, host: string): { duplex: Duplex; opened: Promise<void> } {
	let open = false;
	const duplex = new Duplex({
		read() {},
		write(chunk: Buffer, _encoding, done) {
			if (ws.readyState !== 1) return done(new Agent37TunnelError(`the SSH tunnel to ${host} is closed`));
			try {
				ws.send(chunk);
			} catch (error) {
				return done(error as Error);
			}
			const wait = () => {
				if (ws.readyState !== 1) done(new Agent37TunnelError(`the SSH tunnel to ${host} closed while it sent`));
				else if (ws.bufferedAmount <= TUNNEL_HIGH_WATER) done();
				else setTimeout(wait, TUNNEL_POLL_MS);
			};
			wait();
		},
		final(done) {
			try {
				ws.close(1000);
			} catch {
				// Closed already.
			}
			done();
		},
		destroy(error, done) {
			try {
				ws.close(1000);
			} catch {
				// Closed already.
			}
			done(error);
		},
	});
	ws.addEventListener("message", ({ data }) => {
		if (data instanceof ArrayBuffer) duplex.push(Buffer.from(data));
		else if (ArrayBuffer.isView(data)) duplex.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
		else if (typeof data === "string") duplex.push(Buffer.from(data, "utf8"));
	});
	const opened = new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => {
			open = true;
			resolve();
		});
		ws.addEventListener("error", (event) => {
			const error = new Agent37TunnelError(`the SSH tunnel to ${host} failed${open ? "" : " to open"}${event.message ? `: ${event.message}` : ""}`);
			if (!open) reject(error);
			else duplex.destroy(error);
		});
		ws.addEventListener("close", ({ code, reason }) => {
			if (!open) reject(new Agent37TunnelError(`the SSH tunnel to ${host} was refused (closed with ${code ?? "no code"}${reason ? `: ${reason}` : ""}); the edge opens it for the workspace's API key alone`));
			else duplex.push(null);
		});
	});
	opened.catch(() => {});
	return { duplex, opened };
}

/** A promise that rejects with the abort's or the bound's error once ms pass or signal aborts. */
function deadline(ms: number, signal: AbortSignal | undefined, what: string): { promise: Promise<never>; clear: () => void } {
	const bound = bounded(ms, signal);
	let onAbort: () => void = () => {};
	const promise = new Promise<never>((_, reject) => {
		onAbort = () => {
			const timedOut = !signal?.aborted;
			const error = new Error(timedOut ? `${what} did not answer within ${ms / 1000} s` : `${what} was aborted`);
			error.name = timedOut ? "TimeoutError" : "AbortError";
			reject(error);
		};
		if (bound.aborted) onAbort();
		else bound.addEventListener("abort", onAbort, { once: true });
	});
	promise.catch(() => {});
	return { promise, clear: () => bound.removeEventListener("abort", onAbort) };
}

/** A bound's own error (deadline's): the call ran out of time or was aborted, so nothing is tried again. */
const isBound = (error: unknown) => {
	const name = (error as { name?: unknown } | null)?.name;
	return name === "TimeoutError" || name === "AbortError";
};

/**
 * One SSH connection to an instance, shared by its execs: each exec, and each kill, is a channel on it. It counts its
 * holders (an exec waiting for the handshake, an open exec channel, a kill's channel), and is done once it closes,
 * fails, ends or takes no more: a done link is never handed to another exec, and it ends once its last holder lets go.
 */
interface Link {
	readonly id: string;
	/** The handshake (TUNNEL_TRIES tries), then the client. */
	readonly ready: Promise<Ssh2Client>;
	/** Gives up the handshake once nobody waits for it. */
	readonly stop: AbortController;
	client?: Ssh2Client;
	holders: number;
	done: boolean;
	/** Its client has been ended. */
	ended: boolean;
	idle?: ReturnType<typeof setTimeout>;
}

/** Agent37's instances as a MachineHost (../host.ts). */
class Agent37Host implements MachineHost {
	readonly id = "agent37";
	readonly facts: HostFacts;
	readonly #apiKey: string;
	readonly #sshKey: string;
	readonly #ssh2: Ssh2Module;
	readonly #client: Rest;
	readonly #WebSocket: WebSocketClass;
	readonly #proxyDomain: string;
	readonly #declared: Declared;
	/**
	 * The SSH connections to each instance, opening, open, or done and still held, until each ends: one, and a second
	 * past CHANNELS_PER_CONNECTION channels. A done one takes no new channel; delete ends them all.
	 */
	readonly #links = new Map<string, Link[]>();

	constructor(options: { apiKey: string; sshKey: string; ssh2: Ssh2Module; fetch: typeof fetch; WebSocket: WebSocketClass; apiUrl: string; proxyDomain: string; type: Agent37Type; region: Agent37Region }) {
		this.#apiKey = options.apiKey;
		this.#sshKey = options.sshKey;
		this.#ssh2 = options.ssh2;
		this.#client = rest({
			base: options.apiUrl,
			headers: () => ({ Authorization: `Bearer ${options.apiKey}`, Accept: "application/json" }),
			vendor: "agent37",
			fetch: options.fetch,
			timeoutMs: 30_000, // every call gives its own: ctx.timeoutMs
			explain: ({ status, bytes, what }) => {
				const { code, message } = envelopeOf(jsonOf(bytes));
				const known = code === undefined ? undefined : CODES[code];
				return { ...(known === undefined ? {} : { code: known }), message: `${what} answered ${status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}` };
			},
		});
		this.#WebSocket = options.WebSocket;
		this.#proxyDomain = options.proxyDomain;
		this.#declared = { type: options.type, region: options.region };
		const runtime = options.type === "vm" ? "vm" : "gvisor";
		this.facts = {
			daemon: "child",
			isolation: runtime,
			lifetime: "janitor",
			maxLifetimeMs: DAY_MS,
			arch: "amd64",
			vendorAgentPorts: [AGENT37_SSH_PORT, AGENT37_TTYD_PORT],
			networkReadBack: true,
			network: [...AGENT37.network],
			mounts: [...MOUNT],
			release: ["delete"],
			specFields: ["cpus", "memoryMb"],
			labelRules: { maxBytes: METADATA_MAX_BYTES, measure: "json" },
			runtime: () => runtime,
		};
	}

	errorCode(error: unknown): ComputerErrorCode {
		return codeOf(error);
	}

	/** One REST call, bounded by ctx; a failure throws Agent37Error in Agent37's words. */
	async #rest<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body: object | undefined, ctx: HostCall): Promise<T> {
		const answer = await this.#client.call(method, this.#client.url(path), { ...(body === undefined ? {} : { json: body }), timeoutMs: ctx.timeoutMs }, ctx.signal);
		if (!answer.ok) throw new Agent37Error(answer.error.code, answer.error.message);
		const parsed = jsonOf(answer.value.bytes);
		if (parsed === null) throw new Agent37Error("vendor", `${method} ${path} answered ${answer.value.status} with no JSON body`);
		return parsed as T;
	}

	/** An instance's REST path, its id held to Agent37's form first: an id is also a DNS label here. */
	#path(id: string): string {
		if (!INSTANCE_ID.test(id)) throw new Agent37Error("not_found", `${JSON.stringify(id)} is not an Agent37 instance id (ten lowercase letters and digits)`);
		return `/v1/instances/${id}`;
	}

	/** An Agent37 template is a name, with an optional @<version>; a size is one of Agent37's four shapes. The adapter holds metadata to 4 KB (labelRules). */
	check(spec: ComputerSpec): Refusal[] {
		const refusals: Refusal[] = [];
		const given = (typeof spec === "object" && spec !== null ? spec : {}) as Partial<ComputerSpec>;
		const { image, cpus, memoryMb } = given;
		if (typeof image === "string" && image !== "" && !TEMPLATE.test(image)) {
			refusals.push({ field: "image", message: `an image is the name of an Agent37 template, optionally pinned as name@version, such as "${AGENT37_BASE_TEMPLATE}"` });
		}
		if (cpus !== undefined && (!isWhole(cpus) || cpus > MAX_CPUS)) {
			refusals.push({ field: "cpus", message: `an Agent37 instance has at most ${MAX_CPUS} CPUs, and Agent37 gives 4 for a larger ask without saying so: ask for 2 or 4` });
		} else if ((cpus !== undefined || memoryMb !== undefined) && shapeOf(cpus, memoryMb) === undefined) {
			refusals.push({ field: cpus !== undefined && !SHAPES.some((shape) => shape.cpu === cpus) ? "cpus" : "memoryMb", message: `an Agent37 instance is one of its shapes: ${SHAPE_WORDS}` });
		}
		return refusals;
	}

	/**
	 * POST /v1/instances: the template, the type and region, the size when the spec asks one, the request's name as the
	 * instance's name, the labels as metadata, deny-all (or allow-all for an Archil computer's root), auto-sleep off and
	 * no public port. It answers once the instance runs (docs: instances/create, Defaults).
	 */
	async create(req: MachineRequest, ctx: HostCall): Promise<Result<{ id: string }>> {
		const shape = req.cpus !== undefined || req.memoryMb !== undefined ? shapeOf(req.cpus, req.memoryMb) : undefined;
		const made = await this.#rest<Agent37Instance>(
			"POST",
			"/v1/instances",
			{
				template: req.image,
				type: this.#declared.type,
				region: this.#declared.region,
				...(shape === undefined ? {} : { resources: { cpu: shape.cpu, memory: shape.memory } }),
				name: req.name,
				metadata: req.labels,
				network: req.network === "open" ? "allow-all" : "deny-all",
				auto_sleep: false,
				public_ports: [],
			},
			ctx,
		);
		if (typeof made?.id !== "string" || !INSTANCE_ID.test(made.id)) throw new Agent37Error("vendor", `POST /v1/instances answered no instance id: ${show(made?.id)}`);
		return ok({ id: made.id });
	}

	/** GET /v1/instances/{id}; 404 is none (docs: instances/get). */
	async get(id: string, ctx: HostCall): Promise<Result<Machine | undefined>> {
		try {
			return ok(machineOf(await this.#rest<Agent37Instance>("GET", this.#path(id), undefined, ctx), this.#declared));
		} catch (error) {
			if (codeOf(error) === "not_found") return ok(undefined);
			throw error;
		}
	}

	/**
	 * GET /v1/instances: the whole workspace in one answer, newest first, each the full instance object (docs:
	 * instances/list). Agent37 filters nothing, so the labels are matched here; an answer that says it has more is refused.
	 */
	async list(labels: Record<string, string>, ctx: HostCall): Promise<Result<Machine[]>> {
		const listed = await this.#rest<{ data?: unknown; has_more?: unknown; next_cursor?: unknown }>("GET", "/v1/instances", undefined, ctx);
		if (!Array.isArray(listed.data)) throw new Agent37Error("vendor", "GET /v1/instances answered no data list");
		if (listed.has_more === true || (listed.next_cursor !== undefined && listed.next_cursor !== null)) {
			throw new Agent37Error("vendor", "GET /v1/instances answered a page with more after it, which Agent37 documents none of: this provider would miss machines");
		}
		const wanted = Object.entries(labels);
		const machines: Machine[] = [];
		for (const instance of listed.data as Agent37Instance[]) {
			if (typeof instance?.id !== "string") continue;
			const metadata = instance.metadata ?? {};
			if (wanted.every(([key, value]) => metadata[key] === value)) machines.push(machineOf(instance, this.#declared));
		}
		return ok(machines);
	}

	/**
	 * DELETE /v1/instances/{id}, never signalled; a repeat answers 404, read as done (docs: instances/delete). Once taken,
	 * this host's SSH connections to the instance are ended, channels and all.
	 */
	async delete(id: string, ctx: HostCall): Promise<Result<void>> {
		try {
			await this.#rest("DELETE", this.#path(id), undefined, { timeoutMs: ctx.timeoutMs });
		} catch (error) {
			if (codeOf(error) !== "not_found") throw error;
		}
		for (const link of [...(this.#links.get(id) ?? [])]) this.#end(link);
		return ok(undefined);
	}

	/** The janitor's deadline label: GET, then PATCH of the whole metadata, which replaces the stored object (docs: instances/edit). */
	async setLabels(id: string, labels: Record<string, string>, ctx: HostCall): Promise<Result<void>> {
		const path = this.#path(id);
		const instance = await this.#rest<Agent37Instance>("GET", path, undefined, ctx);
		await this.#rest("PATCH", path, { metadata: { ...(instance.metadata ?? {}), ...labels } }, ctx);
		return ok(undefined);
	}

	/**
	 * An SSH session as root over the instance's tunnel, its handshake within ctx. A tunnel that fails to open, or closes
	 * before the SSH handshake, is opened again after a pause, TUNNEL_TRIES times in all within ctx: an instance fresh
	 * from its create can refuse the first (seen live once in eight creates, the daemon's upload refused). Nothing has
	 * run before a handshake, so a retry repeats nothing. A refused key or a handshake past its bound is not retried.
	 */
	async #ssh(id: string, ctx: HostCall): Promise<Ssh2Client> {
		if (!INSTANCE_ID.test(id)) throw new Agent37Error("not_found", `${JSON.stringify(id)} is not an Agent37 instance id (ten lowercase letters and digits)`);
		const host = `${id}-${AGENT37_SSH_PORT}.${this.#proxyDomain}`;
		const bound = deadline(ctx.timeoutMs, ctx.signal, `the SSH connection to ${id}`);
		// Ends the handshake in flight when this call gives up on it (its bound passed, or the caller aborted).
		const givenUp = new AbortController();
		try {
			for (let attempt = 1; ; attempt++) {
				try {
					return await Promise.race([this.#handshake(host, ctx.timeoutMs, givenUp.signal), bound.promise]);
				} catch (error) {
					const early = error instanceof Agent37TunnelError || (error as { level?: unknown }).level === "client-socket";
					if (!early || attempt >= TUNNEL_TRIES) throw error;
				}
				await Promise.race([new Promise((resolve) => setTimeout(resolve, TUNNEL_RETRY_MS * 2 ** (attempt - 1))), bound.promise]);
			}
		} catch (error) {
			givenUp.abort();
			throw error;
		} finally {
			bound.clear();
		}
	}

	/**
	 * One tunnel and one SSH handshake over it. On a failure, or once stop aborts before the handshake is done, the
	 * WebSocket (opening or open), the stream and the client are dropped.
	 */
	async #handshake(host: string, timeoutMs: number, stop: AbortSignal): Promise<Ssh2Client> {
		const ws = new this.#WebSocket(`wss://${host}/`, { headers: { "X-Agent37-Key": this.#apiKey } });
		ws.binaryType = "arraybuffer";
		const { duplex, opened } = tunnelOf(ws, host);
		const client = new this.#ssh2.Client();
		const givenUp = () => new Agent37TunnelError(`the SSH tunnel to ${host} was given up on`);
		let quit: (error: Error) => void = () => {};
		const quitted = new Promise<never>((_resolve, reject) => {
			quit = reject;
		});
		quitted.catch(() => {});
		const drop = () => {
			client.destroy();
			duplex.destroy();
			quit(givenUp());
		};
		stop.addEventListener("abort", drop, { once: true });
		try {
			await Promise.race([opened, quitted]);
			await Promise.race([
				new Promise<void>((resolve, reject) => {
					client.once("ready", resolve);
					client.once("error", reject);
					client.connect({ sock: duplex, username: "root", privateKey: this.#sshKey, readyTimeout: timeoutMs, keepaliveInterval: KEEPALIVE_MS });
				}),
				quitted,
			]);
		} catch (error) {
			drop();
			throw error;
		} finally {
			stop.removeEventListener("abort", drop);
		}
		if (stop.aborted) {
			drop();
			throw givenUp();
		}
		// A later error ends the session; its channel's close reports it.
		client.on("error", () => {});
		return client;
	}

	/**
	 * A connection to id with one more holder, its handshake within ctx: a link of the instance's that is not done and
	 * has room, or a new one. Execs that come together share one handshake, each waiting within its own bound; the
	 * handshake is given up once none waits. A link that closed as its handshake ended is let go, and another taken.
	 */
	async #lease(id: string, ctx: HostCall): Promise<{ link: Link; client: Ssh2Client }> {
		const bound = deadline(ctx.timeoutMs, ctx.signal, `the SSH connection to ${id}`);
		const end = Date.now() + ctx.timeoutMs;
		try {
			for (;;) {
				const link = this.#links.get(id)?.find((one) => !one.done && one.holders < CHANNELS_PER_CONNECTION) ?? this.#open(id, end - Date.now());
				this.#hold(link);
				let got: { client: Ssh2Client } | { error: unknown };
				try {
					got = await Promise.race([link.ready.then((client) => ({ client }), (error: unknown) => ({ error })), bound.promise]);
				} catch (error) {
					this.#letGo(link);
					throw error;
				}
				if (!("error" in got) && !link.done) return { link, client: got.client };
				this.#letGo(link);
				if ("error" in got) {
					// A shared handshake is bound by the call that opened it: a call with time of its own left opens another.
					if ((got.error as { name?: unknown } | null)?.name === "TimeoutError" && end - Date.now() > TUNNEL_RETRY_MS) continue;
					throw got.error;
				}
			}
		} finally {
			bound.clear();
		}
	}

	/** A new link to id, its handshake started within timeoutMs, listed for the instance's next execs until it is done. */
	#open(id: string, timeoutMs: number): Link {
		const stop = new AbortController();
		const link: Link = {
			id,
			stop,
			holders: 0,
			done: false,
			ended: false,
			ready: this.#ssh(id, { timeoutMs, signal: stop.signal }).then(
				(client) => {
					link.client = client;
					const gone = () => this.#retire(link);
					client.on("close", gone);
					client.on("end", gone);
					client.on("error", gone);
					// Deleted as it opened.
					if (link.done) this.#end(link);
					return client;
				},
				(error: unknown) => {
					this.#retire(link);
					throw error;
				},
			),
		};
		link.ready.catch(() => {});
		this.#links.set(id, [...(this.#links.get(id) ?? []), link]);
		return link;
	}

	#hold(link: Link): void {
		link.holders++;
		clearTimeout(link.idle);
		link.idle = undefined;
	}

	/**
	 * One holder lets go of link. Once none holds it, a done link ends, a handshake no one waits for is given up, and an
	 * open connection waits IDLE_MS for the next exec, then ends.
	 */
	#letGo(link: Link): void {
		link.holders--;
		if (link.holders > 0) return;
		if (link.done || link.client === undefined) return this.#retire(link);
		link.idle = setTimeout(() => this.#retire(link), IDLE_MS);
		link.idle.unref();
	}

	/** link takes no new channel; it ends at once if none holds it, else when the last lets go (or delete ends it). */
	#retire(link: Link): void {
		link.done = true;
		clearTimeout(link.idle);
		if (link.holders <= 0) this.#end(link);
	}

	/**
	 * Ends link, whoever holds it, and drops it from the instance's list: its handshake given up, its client ended (ssh2
	 * closes every channel on it), and the tunnel dropped if the connection has not closed within KILL_GRACE_MS. Neither
	 * timer keeps the process alive.
	 */
	#end(link: Link): void {
		link.done = true;
		clearTimeout(link.idle);
		const left = (this.#links.get(link.id) ?? []).filter((one) => one !== link);
		if (left.length > 0) this.#links.set(link.id, left);
		else this.#links.delete(link.id);
		link.stop.abort();
		const { client } = link;
		if (client === undefined || link.ended) return;
		link.ended = true;
		client.end();
		const dropped = setTimeout(() => client.destroy(), KILL_GRACE_MS);
		dropped.unref();
		client.on("close", () => clearTimeout(dropped));
	}

	/**
	 * One exec channel on client, opened within ms and signal, and its close: the exit-status, or -1 for an exit by
	 * signal or none. Its listeners go on inside ssh2's callback, as it opens: one read off the tunnel can hold the open,
	 * the exit and the close together (seen live), and they are emitted before an await after it would resume. A channel
	 * that opens after its bound passed is closed: the connection is shared, so nothing else would close it.
	 */
	async #channel(client: Ssh2Client, command: string, ms: number, signal: AbortSignal | undefined, what: string): Promise<{ channel: Ssh2Channel; closed: Promise<number> }> {
		const bound = deadline(ms, signal, what);
		let late = false;
		try {
			return await Promise.race([
				new Promise<{ channel: Ssh2Channel; closed: Promise<number> }>((resolve, reject) => {
					client.exec(command, (error, channel) => {
						if (error) return reject(error);
						if (late) {
							channel.on("error", () => {});
							return channel.close();
						}
						let code = -1;
						channel.on("exit", (status) => {
							code = typeof status === "number" ? status : -1;
						});
						channel.on("error", () => {});
						resolve({ channel, closed: new Promise<number>((done) => channel.on("close", () => done(code))) });
					});
				}),
				bound.promise,
			]);
		} catch (error) {
			late = true;
			throw error;
		} finally {
			bound.clear();
		}
	}

	/**
	 * command as one channel on a connection to id with room (#lease), within ctx; the channel holds its connection until
	 * the caller lets go. A channel that fails to open (the connection died under it, or its sshd took no more sessions)
	 * retires that connection and is opened once more on a fresh one.
	 */
	async #start(id: string, command: string, ctx: HostCall, what: string): Promise<{ link: Link; channel: Ssh2Channel; closed: Promise<number> }> {
		for (let attempt = 1; ; attempt++) {
			const { link, client } = await this.#lease(id, ctx);
			try {
				return { link, ...(await this.#channel(client, command, ctx.timeoutMs, ctx.signal, what)) };
			} catch (error) {
				// A channel open that timed out leaves a connection that may be stuck: the next channel takes another.
				if ((error as { name?: unknown } | null)?.name !== "AbortError") this.#retire(link);
				this.#letGo(link);
				if (isBound(error) || attempt >= 2) throw error;
			}
		}
	}

	/**
	 * argv as root over SSH, under WRAPPER, as one channel on the instance's shared connection (#start). stdout and
	 * stderr are the channel's, piped; with no stdin, end of file is sent at once, and end sends it later. wait answers
	 * once the channel closes, with the exit-status, or -1 for an exit by signal or none. kill ends the process group
	 * over a channel of its own (on a connection with room), then closes the exec's channel, never a connection; if the
	 * close does not come, wait answers -1 and the connection takes no new channel.
	 */
	async exec(id: string, argv: readonly string[], { stdin }: { stdin: boolean }, ctx: HostCall): Promise<Result<MachineProcess>> {
		const pidFile = `/tmp/.agentrun-exec-${randomBytes(8).toString("hex")}`;
		const opened = await this.#start(id, shellLine(["sh", "-c", WRAPPER, pidFile, ...argv]), ctx, `the exec in ${id}`);
		const { link: held, channel } = opened;
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		channel.pipe(stdout);
		channel.stderr.pipe(stderr);
		let ended = !stdin;
		if (!stdin) channel.eof();
		let closed = false;
		let done: (code: number) => void = () => {};
		// ssh2 closes every channel when the connection goes (utils.js, ChannelManager.cleanup), so the close is enough.
		const exited = new Promise<number>((resolve) => {
			done = (code) => {
				if (closed) return;
				closed = true;
				this.#letGo(held);
				resolve(code);
			};
		});
		void opened.closed.then(done);
		return ok({
			stdout,
			stderr,
			write: (bytes) =>
				new Promise<void>((resolve, reject) => {
					if (ended || closed) return reject(new Error(ended ? "stdin was ended" : "the process has ended"));
					channel.write(bytes, (error) => (error ? reject(error) : resolve()));
				}),
			end: async () => {
				if (ended || closed) return;
				ended = true;
				channel.eof();
			},
			wait: () => exited,
			kill: async () => {
				if (closed) return;
				// The pid file is the instance's, so the kill's channel goes on any connection with room, counted like an exec's.
				try {
					const killer = await this.#start(id, shellLine(["sh", "-c", KILL_SCRIPT, pidFile]), { timeoutMs: KILL_GRACE_MS }, `the kill in ${id}`);
					killer.channel.resume();
					killer.channel.stderr.resume();
					killer.channel.eof();
					const grace = deadline(KILL_GRACE_MS, undefined, `the kill in ${id}`);
					try {
						await Promise.race([killer.closed, grace.promise]);
					} catch {
						try {
							killer.channel.close();
						} catch {
							// Closed already.
						}
					} finally {
						grace.clear();
						this.#letGo(killer.link);
					}
				} catch {
					// No connection took the kill in time: closing the channel below is what is left.
				}
				try {
					channel.close();
				} catch {
					// Closed already.
				}
				// A close that never comes is a connection that is stuck: it takes no more execs, and wait answers.
				const dropped = setTimeout(() => {
					if (closed) return;
					this.#retire(held);
					done(-1);
				}, KILL_GRACE_MS);
				dropped.unref();
				void exited.then(() => clearTimeout(dropped));
			},
		});
	}
}

/**
 * A private key in the PEM armor ssh2 reads (its parser wants the BEGIN and END lines on lines of their own), or
 * undefined when text is not one. A key pasted into Settings → Computers comes back on one line, since a password
 * field drops line breaks: its body is wrapped again at 70 characters, as ssh-keygen writes it.
 */
function pemOf(text: string): string | undefined {
	const armor = /^-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----([\s\S]*?)-----END \1-----$/.exec(text.replace(/\r/g, "").trim());
	if (!armor) return undefined;
	const [, label, inside] = armor;
	const lines = inside.split("\n").map((line) => line.trim()).filter(Boolean);
	// PEM headers (Proc-Type, DEK-Info) keep their own lines; a key with them was never pasted onto one line.
	if (lines.some((line) => line.includes(":"))) return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
	const body = lines.join("").replace(/\s+/g, "");
	if (body === "" || !/^[A-Za-z0-9+/=]+$/.test(body)) return undefined;
	return `-----BEGIN ${label}-----\n${body.match(/.{1,70}/g)?.join("\n")}\n-----END ${label}-----\n`;
}

/** The ssh2 module's slice, or why it is not one. */
function ssh2Problem(ssh2: unknown): string | undefined {
	return typeof (ssh2 as { Client?: unknown } | null)?.Client === "function" ? undefined : "options.ssh2 must be the ssh2 package (its Client class): the host installs it, as it does e2b";
}

/**
 * An Agent37Provider from its options alone; it reads no environment. The key is options.apiKey and the SSH key
 * options.sshKey, nowhere else (serve passes its AGENT37_API_KEY and AGENT37_SSH_KEY, the conformance module what it
 * reads), and ssh2 is the host's package unless given. Throws in words when an option is missing or wrong, never echoing a key.
 */
export async function create(options: Agent37Options): Promise<Agent37Provider> {
	const { apiKey, sshKey, ssh2: given, ...rest } = options ?? ({} as Agent37Options);
	if (typeof apiKey !== "string" || apiKey === "") throw new Error("options.apiKey, the Agent37 API key, is required: the provider reads no environment, so the caller passes it");
	if (typeof sshKey !== "string" || sshKey === "") throw new Error("options.sshKey, the private half of an SSH key registered on the Agent37 workspace, is required: its contents, never a path");
	// ssh2 is CommonJS: its Client is a named export of the module, and of its default.
	const loaded = given ?? ((await import(SSH2_PACKAGE)) as Partial<Ssh2Module> & { default?: Ssh2Module });
	const ssh2 = typeof loaded.Client === "function" ? (loaded as Ssh2Module) : (loaded as { default?: Ssh2Module }).default;
	return new Agent37Provider({ ...rest, apiKey, sshKey, ssh2: ssh2 as Ssh2Module });
}

/** The conformance CLI's module for Agent37: its live switch, the run's cap, its template and the drifted twin. */
export const conformance = () => import("./conformance/agent37.js");

/**
 * Computers that are Agent37 instances, on the shared adapter. A spec's image is an Agent37 template's name:
 * "agent37-base", Agent37's plain Linux, for a sandbox; "agentrun-box", our box template with Xvfb, for a desktop.
 */
export class Agent37Provider extends HostedProvider {
	constructor(options: Agent37ProviderOptions) {
		const {
			apiKey,
			sshKey,
			ssh2,
			fetch: fetcher = globalThis.fetch,
			WebSocket = globalThis.WebSocket as unknown as WebSocketClass,
			apiUrl = DEFAULT_API_URL,
			proxyDomain = DEFAULT_PROXY_DOMAIN,
			type = "vm",
			region = "us",
			maxLifetimeMs = DAY_MS,
			timeouts = {},
			...rest
		} = options ?? ({} as Agent37ProviderOptions);
		if (typeof apiKey !== "string" || apiKey === "") throw new Error("an Agent37 API key is required");
		const privateKey = typeof sshKey === "string" ? pemOf(sshKey) : undefined;
		if (privateKey === undefined) throw new Error("options.sshKey must be the contents of an SSH private key (-----BEGIN ... PRIVATE KEY-----), never a path");
		const problem = ssh2Problem(ssh2);
		if (problem) throw new Error(problem);
		if (typeof fetcher !== "function") throw new Error("options.fetch must be a function, as the global fetch is");
		if (typeof WebSocket !== "function") throw new Error("options.WebSocket must be a WebSocket class that takes headers, as Node's global one does");
		let api: URL;
		try {
			api = new URL(apiUrl);
		} catch {
			throw new Error(`apiUrl must be an https URL such as ${DEFAULT_API_URL}, not ${JSON.stringify(apiUrl)}`);
		}
		if (api.protocol !== "https:" || api.search !== "" || api.hash !== "") throw new Error(`apiUrl must be an https URL such as ${DEFAULT_API_URL}, not ${JSON.stringify(apiUrl)}`);
		if (typeof proxyDomain !== "string" || !DOMAIN.test(proxyDomain)) throw new Error(`proxyDomain must be a host name such as ${DEFAULT_PROXY_DOMAIN}, not ${JSON.stringify(proxyDomain)}`);
		if (type !== "vm" && type !== "default") throw new Error(`type is vm or default, not ${JSON.stringify(type)}`);
		if (region !== "us" && region !== "eu" && region !== "ap-south") throw new Error(`region is us, eu or ap-south, not ${JSON.stringify(region)}`);
		if (region !== "us" && type !== "vm") throw new Error(`Agent37 runs type default in us alone: ${region} takes type vm`);
		const host = new Agent37Host({ apiKey, sshKey: privateKey, ssh2, fetch: fetcher, WebSocket, apiUrl: api.href.replace(/\/+$/, ""), proxyDomain, type, region });
		// The box template has xfwm4 (box/build-agent37.mjs): the apps an agent opens are framed and focused.
		const desktop = { windowManager: WINDOW_MANAGER, ...rest.desktop };
		super(host, { ...rest, desktop, label: "Agent37", maxLifetimeMs, timeouts: { createMs: DEFAULT_CREATE_MS, requestMs: DEFAULT_REQUEST_MS, ...timeouts } });
	}
}

/** The workspace a key reaches, in words, for the sweep's scope: the key's sha256 prefix, never the key. */
export function workspaceOf(apiKey: string, apiUrl: string = DEFAULT_API_URL): string {
	return `the Agent37 workspace of the key sha256:${createHash("sha256").update(apiKey, "utf8").digest("hex").slice(0, 12)} at ${apiUrl.replace(/\/+$/, "")}`;
}
