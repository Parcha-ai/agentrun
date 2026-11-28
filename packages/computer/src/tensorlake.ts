// The Tensorlake host: a Linux sandbox on a Tensorlake sandbox, a microVM, over its REST API (https://api.tensorlake.ai,
// a Bearer API key). Sources: O = the OpenAPI (https://docs.tensorlake.ai/api-reference/openapi.yaml), D = the docs
// (https://docs.tensorlake.ai/llms.txt and the pages it lists). A sandbox is made, read by id, listed and deleted over
// REST (O /sandboxes). Every command (the daemon's upload, its install, init's start, the stdio bridge) goes over SSH
// through the shared SshExec (./hosted/ssh-exec.ts), to the sandbox's own sshd, which this host turns on with its own
// ed25519 key through the sandbox's proxy (O /api/v1/ssh/enable: the key, and the user it logs in as) and reaches through
// the proxy's TCP tunnel, a WebSocket that carries the bytes to 127.0.0.1:22 for the project's API key (O
// /api/v1/tunnels/tcp; D sandboxes/tunnels: no exposed port needed). The login is tl-user, uid 1000 with passwordless
// sudo (D sandboxes/tensorlake-images), which the adapter's scripts take for root. The processes API runs a command with
// its output as lines, their line ends dropped (O SandboxProcessOutputEvent), which can't carry the exec contract's
// bytes, so it reads and writes the labels file alone; Tensorlake boots only an image registered in the project (D
// sandboxes/images), never the box image by its OCI name, so its sandboxes can't dial the server either.
//
// Tensorlake's sandboxes carry no labels (O SandboxInfo), only a name, unique in the project (O create: 409). So a
// sandbox's name (computer-<12 hex>-r<run hash>-e<epoch>-d<deadline>) gives the adapter's own two, its epoch and its
// deadline, and says whose run it may be, as Render's names do (./render.ts), the epoch and the deadline in base 36 so the
// name stays a DNS label (the proxy's host is <id or name>.sandbox.tensorlake.ai, O servers). The deadline is in the name
// so the janitor, which ends a computer whose deadline it can't read, never ends one it only can't reach: a sandbox still
// pending for another server's create, or one Tensorlake suspended. create writes every label to a file in the sandbox,
// root's alone, which get and list read back through the processes API where a label asked is not the name's, and keep
// for the whole process: a computer's labels never change (there is no extend). A read that fails, or has no answer
// within the call's own bound, gives get the name's; a listing by a label beyond the name's fails closed on it, naming
// the sandbox, as Render's does.
//
// A sandbox's timeout_secs is an idle threshold, not a lifetime (D sandboxes/lifecycle): a named sandbox no proxied
// traffic reached for that long suspends. create sets it to the backstop's span, and auto_resume off, so a sandbox
// suspended stays so (no read of its labels wakes it, O SandboxAutoResumeDisabled) and the janitor ends it at its
// deadline. A plan's longest session is a day with usage credits (D platform/billing), so a computer lives at most that.
//
// Unverified until the live run: ssh/enable with this host's key lets that key in as tl-user, and an enable with another
// key (another process's) replaces it; sshd listens on 127.0.0.1:22 for the tunnel; host_key_fingerprint is OpenSSH's
// sha256 form and never null (a null is refused: no exec runs unpinned); tunnel traffic counts as proxied traffic against the idle threshold; the processes API runs sudo
// with no password, so the labels file is root's; a name of 63 characters of [a-z0-9-] is taken; a taken name answers
// 409; a sandbox deleted reads 404 or terminated; sandbox_url is in every get's answer; the sandbox is amd64; root makes
// network namespaces in the microVM; a silent SSH channel stays open through 75 s.
import { createHash } from "node:crypto";
import { TENSORLAKE, TENSORLAKE_IMAGE } from "./descriptors/tensorlake.js";
import { COMPUTER_LABEL, DEADLINE_LABEL, show } from "./drift.js";
import { BACKSTOP_MARGIN_MS, type HostCall, HostError, type HostFacts, type Machine, type MachineHost, type MachineProcess, type MachineRequest } from "./host.js";
import { boundOf, eachAtMost, orThrow, pause, seconds } from "./hosted/process.js";
import { HostedProvider, type HostedOptions, mayHaveMade, NAME_LABEL, timeoutsOf } from "./hosted/provider.js";
import { allPages, httpsBase, jsonOf, type Rest, type RestInit, rest, sse } from "./hosted/rest.js";
import { HOST_KEY_PIN, pemOf, type Ssh2Module, SshExec, SshTunnelError, type SshTunnel } from "./hosted/ssh-exec.js";
import { ed25519PublicOf, newEd25519 } from "./hosted/ssh-key.js";
import { DOMAIN, dateOf, isWhole } from "./hosted/values.js";
import { tunnelOf, type WebSocketClass } from "./hosted/ws-tunnel.js";
import { EPOCH_LABEL, RUN_HASH_LABEL, RUN_LABEL, runHash } from "./labels.js";
import type { ComputerResources, ComputerSpec, Refusal } from "./provider.js";
import { type ComputerErrorCode, ok } from "./result.js";
import { vendorSdk } from "./vendor-sdk.js";

/** A sandbox as Tensorlake answers it (O SandboxInfo), as far as this host reads it. */
interface TensorlakeSandbox {
	id: string;
	name?: string | null;
	status: string;
	pending_reason?: string | null;
	termination_reason?: string | null;
	error_details?: string | null;
	created_at?: number;
	resources?: { cpus?: number; memory_mb?: number; disk_mb?: number } | null;
	sandbox_url?: string | null;
}

/** A sandbox's proxy (O servers: its sandbox_url): the REST client of its management API, and its host. */
interface Proxy {
	api: Rest;
	host: string;
}

/** What ssh/enable answered: the sshd's host key, which it must name (O SandboxSshStatus.host_key_fingerprint). */
interface Login {
	hostKey: string;
}

/** What a processes/run call answered once its command ended. */
interface RunAnswer {
	stdout: string;
	stderr: string;
	exit: number;
}

/** The Tensorlake provider's options: the key and ssh2, then the shared adapter's (HostedOptions). */
export interface TensorlakeProviderOptions extends Omit<HostedOptions, "kind" | "desktop"> {
	/** The project's API key. The caller passes it; this provider never reads it from the environment. */
	apiKey: string;
	/** The ssh2 package: the host's own, or anything with the same slice. */
	ssh2: Ssh2Module;
	/** The fetch every REST call goes through; default the global one. */
	fetch?: typeof fetch;
	/** The WebSocket the SSH stream rides; default Node's global one. */
	WebSocket?: WebSocketClass;
	/** The API's root; default https://api.tensorlake.ai. */
	apiUrl?: string;
}

/** What create() takes: the provider's options, ssh2 optional (default the host's ssh2 package). */
export interface TensorlakeOptions extends Omit<TensorlakeProviderOptions, "ssh2"> {
	ssh2?: Ssh2Module;
}

export const DEFAULT_API_URL = "https://api.tensorlake.ai";
const DAY_MS = 24 * 60 * 60_000;
/** The longest a computer lives: its backstop, past it by BACKSTOP_MARGIN_MS, is then within the plan's day. */
const MAX_LIFETIME_MS = DAY_MS - BACKSTOP_MARGIN_MS;
/** The idle threshold's range here: a minute, to a day (O CreateSandboxRequest.timeout_secs: usage credits' most). */
const MIN_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 86_400;
const CALL_MS = 30_000;
/** One page of a listing (O list_sandboxes: limit, default 100), and the most pages a listing reads. */
const PAGE = 100;
const MAX_PAGES = 100;
/** How many labels files a listing reads at once: each is a processes/run call through the sandbox's proxy. */
const LABEL_READS = 4;
/** A 429, or no answer to a call that may run twice, is sent again after 0.5, 1 and 2 s. */
const RETRY = { attempts: 4, baseMs: 500 };
/** The user the proxy's sshd logs in as (O SandboxSshEnableRequest.backend_user; D: tl-user on tensorlake/* images). */
const SSH_USER = "tl-user";
/** The sandbox's sshd, on its loopback (D sandboxes/pty-sessions: "the SSH server on 22"), and its management API (O). */
const SSH_PORT = 22;
const MANAGEMENT_PORT = 9501;
/** A sandbox id as it reaches a URL path and a proxy header. */
const SANDBOX_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** An image: one of Tensorlake's (tensorlake/ubuntu-minimal) or one registered in the project (D sandboxes/images). */
const IMAGE = /^[a-z0-9][a-z0-9._-]{0,127}(?:\/[a-z0-9][a-z0-9._-]{0,127}){0,2}$/;
/** A sandbox's size (D platform/billing): at most 16 vCPUs (Pro), 1 to 8 GB of memory a vCPU. */
const MAX_CPUS = 16;
const MIN_MB_PER_CPU = 1024;
const MAX_MB_PER_CPU = 8192;
/** A file read's exit when the file is not there. */
const MISSING = 3;
/** Where create leaves the computer's labels, root's alone (its directory 0700, umask 077). */
const LABELS_DIR = "/var/lib/agentrun-computer";
const LABELS_FILE = `${LABELS_DIR}/labels.json`;
/** The labels file written whole from $1, to <file>.new, then moved over it. */
const WRITE_LABELS = `umask 077 && mkdir -p ${LABELS_DIR} && printf %s "$1" > ${LABELS_FILE}.new && mv -f ${LABELS_FILE}.new ${LABELS_FILE}`;
/** The labels file read: exits MISSING when it is not there. */
const READ_LABELS = `[ -f ${LABELS_FILE} ] || exit ${MISSING}; cat ${LABELS_FILE}`;

/**
 * A computer's sandbox name: the adapter's name for it (computer-<12 hex>), then -r<its run's hash> and -e<its epoch in
 * base 36> where its labels carry them, then -d<its deadline, ms since the epoch in base 36>: a DNS label (a deadline
 * before 2059 is 8 characters, so 62 at most). Only a sandbox named so is one of its computers.
 */
const SANDBOX_NAME = /^(computer-[0-9a-f]{12})(?:-r([a-z2-7]{16}))?(?:-e([0-9a-z]{1,11}))?-d([0-9a-z]{1,11})$/;
const MAX_NAME = 63;
/** The latest time a Date holds (ECMA-262 21.4.1.1). */
const LAST_MS = 8.64e15;

/** A whole number from its base-36 form; undefined for one not written so (a leading zero, past 2^53). */
function fromBase36(text: string): number | undefined {
	const value = Number.parseInt(text, 36);
	return Number.isSafeInteger(value) && value.toString(36) === text ? value : undefined;
}

/** The run's hash a sandbox of these labels is named with: "" for none. */
function runPart(labels: Record<string, string>): string {
	const run = labels[RUN_LABEL];
	return typeof run === "string" && run !== "" ? runHash(run) : "";
}

/** The epoch a sandbox of these labels is named with, in base 36: "" for none, or one that is not a whole number. */
function epochPart(labels: Record<string, string>): string {
	const epoch = labels[EPOCH_LABEL];
	return typeof epoch === "string" && /^(?:0|[1-9][0-9]{0,15})$/.test(epoch) && Number.isSafeInteger(Number(epoch)) ? Number(epoch).toString(36) : "";
}

/** The deadline a sandbox of these labels is named with, in base 36: undefined for one that is not an ISO time. */
function deadlinePart(labels: Record<string, string>): string | undefined {
	const deadline = labels[DEADLINE_LABEL];
	const at = typeof deadline === "string" ? Date.parse(deadline) : Number.NaN;
	return Number.isSafeInteger(at) && at >= 0 && new Date(at).toISOString() === deadline ? at.toString(36) : undefined;
}

/** A computer's sandbox name for create's request; a request with no deadline label of the adapter's form is invalid. */
function sandboxName({ name, labels }: Pick<MachineRequest, "name" | "labels">): string {
	const deadline = deadlinePart(labels);
	if (deadline === undefined) throw new HostError("invalid", `a Tensorlake sandbox's name carries its computer's deadline, and the label ${DEADLINE_LABEL} reads ${show(labels[DEADLINE_LABEL])}, not the ISO time the adapter writes`);
	const run = runPart(labels);
	const epoch = epochPart(labels);
	const whole = `${name}${run === "" ? "" : `-r${run}`}${epoch === "" ? "" : `-e${epoch}`}-d${deadline}`;
	if (!SANDBOX_NAME.test(whole)) throw new HostError("invalid", `${JSON.stringify(name)} is not a computer's name (computer-<12 hex digits>)`);
	if (whole.length > MAX_NAME) throw new HostError("invalid", `the sandbox name ${whole} is past ${MAX_NAME} characters, a DNS label's most: its epoch ${show(labels[EPOCH_LABEL])} or deadline ${show(labels[DEADLINE_LABEL])} is too large`);
	return whole;
}

/** What a sandbox's name says: the adapter's name, the run's hash, the epoch and the deadline; undefined for one not named as a computer. */
interface NameParts {
	computer: string;
	run?: string;
	/** In decimal, as the epoch label holds it. */
	epoch?: string;
	/** An ISO time, as the deadline label holds it. */
	deadline: string;
}

function nameParts(name: unknown): NameParts | undefined {
	const match = typeof name === "string" ? SANDBOX_NAME.exec(name) : null;
	if (match === null) return undefined;
	const epoch = match[3] === undefined ? undefined : fromBase36(match[3]);
	const at = fromBase36(match[4] as string);
	if ((match[3] !== undefined && epoch === undefined) || at === undefined || at > LAST_MS) return undefined;
	return { computer: match[1] as string, ...(match[2] ? { run: match[2] } : {}), ...(epoch === undefined ? {} : { epoch: String(epoch) }), deadline: new Date(at).toISOString() };
}

/**
 * The labels a sandbox's name gives: the adapter's two, the epoch and the deadline; and the run a listing asks for where
 * the name has its hash. A run's own sandboxes always have its hash, so a hash another run shares (16 base32 letters,
 * 80 bits) only names a sandbox the listing then keeps as the run's.
 */
function nameLabels(parts: NameParts, need?: Record<string, string>): Record<string, string> {
	const run = need?.[RUN_LABEL];
	return {
		[COMPUTER_LABEL]: "1",
		[NAME_LABEL]: parts.computer,
		[DEADLINE_LABEL]: parts.deadline,
		...(parts.epoch === undefined ? {} : { [EPOCH_LABEL]: parts.epoch }),
		...(run !== undefined && parts.run !== undefined && parts.run === runHash(run) ? { [RUN_LABEL]: run } : {}),
	};
}

/**
 * Whether a sandbox so named can carry these labels: one of a name, a run, an epoch or a deadline other than those asked
 * can't, so a listing never reads its guest, and a guest that can't answer refuses no listing it could not be in.
 */
function mayCarry(parts: NameParts, labels: Record<string, string>): boolean {
	const name = labels[NAME_LABEL];
	const run = labels[RUN_LABEL];
	const epoch = labels[EPOCH_LABEL];
	const deadline = labels[DEADLINE_LABEL];
	return (name === undefined || parts.computer === name) && (run === undefined || parts.run === runHash(run)) && (epoch === undefined || parts.epoch === epoch) && (deadline === undefined || parts.deadline === deadline);
}

/**
 * Where a labels file says another run, epoch or deadline than its sandbox's name, why, in words; undefined where it
 * agrees. The name is Tensorlake's, set at create; the file is the guest's root's to rewrite, so one that disagrees is
 * not read.
 */
function misnamed(parts: NameParts, file: Record<string, string>): string | undefined {
	const found: string[] = [];
	if ((parts.run ?? "") !== runPart(file)) found.push(`run: the name's run hash ${show(parts.run)} is not the labels file's run ${show(file[RUN_LABEL])}`);
	if ((parts.epoch === undefined ? "" : Number(parts.epoch).toString(36)) !== epochPart(file)) found.push(`epoch: the name says ${show(parts.epoch)}, the labels file ${show(file[EPOCH_LABEL])}`);
	if (parts.deadline !== file[DEADLINE_LABEL]) found.push(`deadline: the name says ${parts.deadline}, the labels file ${show(file[DEADLINE_LABEL])}`);
	return found.length === 0 ? undefined : found.join("; ");
}

/** Tensorlake's statuses (O SandboxStatus) as the adapter's; terminated is none (get answers undefined). */
const STATES: Readonly<Record<string, Machine["state"]>> = {
	pending: "starting",
	running: "running",
	// A snapshot of a running sandbox: it keeps running (D sandboxes/lifecycle).
	snapshotting: "running",
	suspending: "stopped",
	suspended: "stopped",
	resume_failed: "stopped",
};

/** What the sandbox's answer says it has: its CPUs, its memory, its root disk (O ContainerResourcesInfo). */
function resourcesOf(given: TensorlakeSandbox["resources"]): { resources?: ComputerResources } {
	const { cpus, memory_mb: memory, disk_mb: disk } = given ?? {};
	const resources = {
		...(typeof cpus === "number" && cpus > 0 ? { cpus } : {}),
		...(isWhole(memory) && memory > 0 ? { memoryMb: memory } : {}),
		...(isWhole(disk) && disk > 0 ? { diskGb: disk / 1024 } : {}),
	};
	return Object.keys(resources).length > 0 ? { resources } : {};
}

/** A sandbox as the adapter reads it, with the labels this host read for it. */
function machineOf(found: TensorlakeSandbox, labels: Record<string, string>): Machine {
	const state = STATES[found.status];
	const created = dateOf(found.created_at);
	const why =
		state === undefined
			? `Tensorlake reads its status as ${show(found.status)}, which this provider does not know`
			: found.status === "resume_failed"
				? `Tensorlake could not resume it: ${found.error_details || "no reason given"}`
				: undefined;
	return {
		id: found.id,
		labels,
		// One in a status this provider does not know is listed, so the janitor still ends it.
		state: state ?? "stopped",
		...(created ? { createdAt: created } : {}),
		...resourcesOf(found.resources),
		...(why === undefined ? {} : { why }),
	};
}

/** An id held to a sandbox id's form before it reaches a URL or a header: not_found else. */
function sandboxId(id: string): string {
	if (!SANDBOX_ID.test(id)) throw new HostError("not_found", `${JSON.stringify(id)} is not a Tensorlake sandbox id`);
	return id;
}

/** ssh2 names the stage that failed (lib/client.js): the sshd refused the login, or the handshake timed out. */
function codeOf(error: unknown): ComputerErrorCode {
	if (error instanceof HostError) return error.code;
	const { level } = (error ?? {}) as { level?: unknown };
	if (level === "client-authentication") return "denied";
	if (level === "client-timeout") return "timeout";
	return "vendor";
}

/** The API's refusals are text (O: text/plain), the proxy's {error, code} (O SandboxProxyError): either in its own words. */
function explain({ status, bytes, text, what }: { status: number; bytes: Uint8Array; text: string; what: string }) {
	const proxied = jsonOf(bytes) as { error?: unknown; code?: unknown } | null;
	if (typeof proxied?.error === "string") {
		const code = typeof proxied.code === "string" && proxied.code !== "" ? ` ${proxied.code}` : "";
		return { message: `${what} answered ${status}${code}: ${proxied.error}` };
	}
	return { message: `${what} answered ${status}${text.trim() ? `: ${text.trim()}` : ""}` };
}

/** This process's SSH key, made on first use: every sandbox it enables SSH on takes it, and no other process has it. */
let ownKey: { privateKey: string; line: string } | undefined;

function keyOfProcess(): { privateKey: string; line: string } {
	if (ownKey === undefined) {
		const pem = newEd25519();
		const privateKey = pemOf(pem);
		const line = ed25519PublicOf(pem)?.line;
		if (privateKey === undefined || line === undefined) throw new HostError("vendor", "the SSH key this process made could not be read back");
		ownKey = { privateKey, line };
	}
	return ownKey;
}

/** What this process keeps of a project's sandboxes, whichever provider made or read them (serve makes one per claim). */
interface Kept {
	/** Each computer's labels once known, by sandbox id: written by create, or read from the labels file once. */
	labels: Map<string, Record<string, string>>;
	/** The sandboxes deleted from this process, until Tensorlake reads them gone: their guest is never read for labels. */
	ending: Set<string>;
}

/** Kept, by project: the API URL and the key's sha256 (accountOf), never the key. */
const KEPT = new Map<string, Kept>();

function keptOf(account: string): Kept {
	let kept = KEPT.get(account);
	if (kept === undefined) KEPT.set(account, (kept = { labels: new Map(), ending: new Set() }));
	return kept;
}

/** The project a key reaches, in words: the key named by its sha256 prefix alone. */
export function accountOf(apiKey: string, apiUrl: string = DEFAULT_API_URL): string {
	return `the Tensorlake project of the key sha256:${createHash("sha256").update(apiKey, "utf8").digest("hex").slice(0, 12)} at ${httpsBase(apiUrl, "the Tensorlake API URL")}`;
}

class TensorlakeHost implements MachineHost {
	readonly descriptor = TENSORLAKE;
	readonly facts: HostFacts = {
		daemon: "child",
		// Each sandbox is a MicroVM (D llms.txt: "MicroVM Linux sandboxes").
		isolation: "microvm",
		lifetime: "janitor",
		maxLifetimeMs: MAX_LIFETIME_MS,
		arch: "amd64",
		// The sshd this host enables, and the sandbox daemon the proxy reaches (O: the management port 9501).
		vendorAgentPorts: [SSH_PORT, MANAGEMENT_PORT],
		// A sandbox's name carries its run's hash and its epoch (sandboxName), so a listing by run reads only its own.
		labels: { named: true },
	};
	readonly #apiKey: string;
	readonly #api: Rest;
	readonly #fetch: typeof fetch | undefined;
	readonly #WebSocket: WebSocketClass;
	readonly #pollMs: number;
	readonly #ssh: SshExec;
	readonly #labels: Kept["labels"];
	readonly #ending: Kept["ending"];
	/** Each running sandbox's proxy, once a read answered its sandbox_url. */
	readonly #proxies = new Map<string, Proxy>();
	/** Each sandbox's SSH enable, in flight or done, kept until delete or a refused login. */
	readonly #enables = new Map<string, Promise<Login>>();
	/** Each sandbox's enabled login, which SshExec's loginOf reads. */
	readonly #held = new Map<string, Login>();

	constructor(options: { apiKey: string; ssh2: Ssh2Module; fetch?: typeof fetch; WebSocket: WebSocketClass; apiUrl: string; pollMs: number }) {
		this.#apiKey = options.apiKey;
		this.#fetch = options.fetch;
		this.#WebSocket = options.WebSocket;
		this.#pollMs = options.pollMs;
		this.#api = this.#client(options.apiUrl, {});
		({ labels: this.#labels, ending: this.#ending } = keptOf(accountOf(options.apiKey, options.apiUrl)));
		this.#ssh = new SshExec({
			ssh2: options.ssh2,
			loginOf: (id) => {
				const login = this.#held.get(id);
				if (login === undefined) throw new HostError("denied", `SSH is not enabled on ${id} for this process's key`);
				return { username: SSH_USER, privateKey: keyOfProcess().privateKey, hostKey: login.hostKey };
			},
			tunnelOf: (id) => this.#tunnel(id),
			// Every login carries the enable's host key: one without is refused before its tunnel opens.
			pinned: true,
		});
	}

	/** A REST client on `base` with the key, and headers of its own (a proxy's sandbox id). */
	#client(base: string, headers: Record<string, string>): Rest {
		return rest({
			base,
			headers: () => ({ Authorization: `Bearer ${this.#apiKey}`, Accept: "application/json", ...headers }),
			vendor: TENSORLAKE.id,
			...(this.#fetch ? { fetch: this.#fetch } : {}),
			timeoutMs: CALL_MS,
			retry: RETRY,
			explain,
		});
	}

	/** One API call, bounded by ctx: its JSON answer (null for none) with its status, or a HostError in Tensorlake's words. */
	async #call(method: string, path: string, ctx: HostCall, init: RestInit = {}): Promise<{ status: number; body: unknown }> {
		const answer = orThrow(await this.#api.call(method, this.#api.url(path), { timeoutMs: ctx.timeoutMs, ...init }, ctx.signal));
		return { status: answer.status, body: jsonOf(answer.bytes) };
	}

	errorCode(error: unknown): ComputerErrorCode {
		return codeOf(error);
	}

	/** GET /sandboxes/{id}: the sandbox, or undefined for a 404. Its proxy is kept while it runs. */
	async #read(id: string, ctx: HostCall): Promise<TensorlakeSandbox | undefined> {
		const read = await this.#call("GET", `/sandboxes/${sandboxId(id)}`, ctx, { retry: true, accept: (status) => status === 404 || (status >= 200 && status < 300) });
		if (read.status === 404) return undefined;
		const found = read.body as TensorlakeSandbox | null;
		if (typeof found?.id !== "string" || typeof found.status !== "string") throw new HostError("vendor", `GET /sandboxes/${id} answered no sandbox`);
		this.#remember(found);
		return found;
	}

	/** A running sandbox's proxy, from its sandbox_url (https, a host name): the SDK's own route to it, never one derived. */
	#remember(found: TensorlakeSandbox): void {
		if (found.status !== "running" || this.#proxies.has(found.id) || typeof found.sandbox_url !== "string" || !SANDBOX_ID.test(found.id)) return;
		let url: URL;
		try {
			url = new URL(found.sandbox_url);
		} catch {
			return;
		}
		if (url.protocol !== "https:" || !DOMAIN.test(url.hostname) || url.username !== "" || url.password !== "") return;
		this.#proxies.set(found.id, { api: this.#client(url.origin, { "X-Tensorlake-Sandbox-Id": found.id }), host: url.host });
	}

	/** The sandbox's proxy: kept, or read; a sandbox not running, or one whose answer has no sandbox_url, has none. */
	async #proxyOf(id: string, ctx: HostCall): Promise<Proxy> {
		const kept = this.#proxies.get(id);
		if (kept !== undefined) return kept;
		const found = await this.#read(id, ctx);
		if (found === undefined || found.status === "terminated") throw new HostError("not_found", `Tensorlake has no sandbox ${id}`);
		if (found.status !== "running") throw new HostError("vendor", `Tensorlake reads the sandbox ${id} ${found.status}, so nothing runs in it`);
		const proxy = this.#proxies.get(id);
		if (proxy === undefined) throw new HostError("vendor", `GET /sandboxes/${id} answered no https sandbox_url to reach it by: ${show(found.sandbox_url)}`);
		return proxy;
	}

	/**
	 * One command run in the sandbox as root (sudo, which tl-user takes with no password: D sandboxes/tensorlake-images),
	 * through POST /api/v1/processes/run (O: its events as server-sent events, its output a line each, then its exit),
	 * within ctx: its stdout and stderr lines joined by "\n", and its exit code (-1 for a signal). Sent again only on a 429.
	 */
	async #run(id: string, script: string, args: readonly string[], ctx: HostCall): Promise<RunAnswer> {
		const end = Date.now() + ctx.timeoutMs;
		const proxy = await this.#proxyOf(id, ctx);
		const left = Math.max(1, end - Date.now());
		const bound = AbortSignal.timeout(left);
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, bound]) : bound;
		const what = `the run in ${id}`;
		const stopped = (): HostError => (ctx.signal?.aborted ? new HostError("aborted", `${what} was aborted`) : new HostError("timeout", `${what} did not end within ${seconds(ctx.timeoutMs)}`));
		const body = { command: "sudo", args: ["-n", "sh", "-c", script, "sh", ...args], timeout: Math.ceil(left / 1000) };
		const started = await proxy.api.stream("POST", proxy.api.url("/api/v1/processes/run"), { json: body, timeoutMs: left, retry: (status) => status === 429 }, signal);
		if (!started.ok && signal.aborted) throw stopped();
		const { body: events } = orThrow(started);
		const out: string[] = [];
		const err: string[] = [];
		try {
			for await (const event of sse(events)) {
				const data = jsonOf(new TextEncoder().encode(event.data)) as { line?: unknown; stream?: unknown; exit_code?: unknown; signal?: unknown } | null;
				if (typeof data?.line === "string") (data.stream === "stderr" ? err : out).push(data.line);
				else if (data !== null && ("exit_code" in data || "signal" in data)) return { stdout: out.join("\n"), stderr: err.join("\n"), exit: isWhole(data.exit_code) ? data.exit_code : -1 };
			}
		} catch (error) {
			if (signal.aborted) throw stopped();
			throw new HostError("vendor", `${what} broke off: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (signal.aborted) throw stopped();
		throw new HostError("vendor", `${what} ended with no exit event`);
	}

	/** The labels file read through processes/run: undefined when it is not there yet; a read that fails throws in words. */
	async #labelsFile(id: string, ctx: HostCall): Promise<Record<string, string> | undefined> {
		const read = await this.#run(id, READ_LABELS, [], ctx);
		if (read.exit === MISSING) return undefined;
		if (read.exit !== 0) throw new HostError("vendor", `reading the labels file of ${id} exited ${read.exit}: ${(read.stderr.trim() || read.stdout.trim()).slice(-300)}`);
		const parsed = jsonOf(new TextEncoder().encode(read.stdout));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || !Object.values(parsed).every((value) => typeof value === "string")) {
			throw new HostError("vendor", `the labels file of ${id} is not a JSON map of strings`);
		}
		return parsed as Record<string, string>;
	}

	/**
	 * A sandbox's labels: the ones this process knows, else its name's (nameLabels), else its labels file's, read once and
	 * kept. `need`: a listing's labels; when the name's hold every one asked, no file is read. A sandbox not named as a
	 * computer carries none; one deleted from this process its name's (its run as RUN_HASH_LABEL, the name's hash, unless
	 * `need` names the run, so the janitor can still tell whose it is). A file whose run, epoch or deadline is not the
	 * name's (misnamed) is not read: the guest's root rewrote it. The read is held to `end` (epoch ms, the call's own
	 * bound). One not running (no read wakes it), one with no file yet, or a read that fails, disagrees with the name, or
	 * has no answer by then gives the name's, kept for nothing, so the next read tries again, with `unread`, why: get
	 * answers the name's (release and the janitor need no more), and a listing fails closed on it. Only the caller's own
	 * abort throws.
	 */
	async #labelsOf(found: TensorlakeSandbox, ctx: HostCall, end: number, need?: Record<string, string>): Promise<{ labels: Record<string, string>; unread?: string }> {
		const parts = nameParts(found.name);
		if (parts === undefined) return { labels: {} };
		const known = this.#labels.get(found.id);
		if (known !== undefined) return { labels: known };
		// The name's run is a hash: with no `need` that names the run, the hash is all there is to tell whose run it is.
		const named = nameLabels(parts, need);
		const own = named[RUN_LABEL] === undefined && parts.run !== undefined ? { ...named, [RUN_HASH_LABEL]: parts.run } : named;
		if ((need !== undefined && Object.keys(need).every((key) => key in own)) || this.#ending.has(found.id)) return { labels: own };
		// No read wakes a sandbox: one not running is left unread, and a listing that needs more than its name fails closed.
		if (found.status !== "running") return { labels: own, unread: `it is ${found.status}, and its labels file is read only while it runs` };
		const late = { labels: own, unread: `no answer within ${seconds(ctx.timeoutMs)}` };
		const left = end - Date.now();
		if (left <= 0) return late;
		let file: Record<string, string> | undefined;
		try {
			file = await this.#labelsFile(found.id, { timeoutMs: left, ...(ctx.signal ? { signal: ctx.signal } : {}) });
		} catch (error) {
			if (ctx.signal?.aborted) throw error;
			return error instanceof HostError && error.code === "timeout" ? late : { labels: own, unread: error instanceof Error ? error.message : String(error) };
		}
		if (file === undefined) return { labels: own, unread: "it has no labels file yet (its create has not written it)" };
		const differs = misnamed(parts, file);
		if (differs !== undefined) return { labels: own, unread: `the labels file of ${found.id} does not match its name ${found.name}: ${differs}` };
		const labels = { ...file, ...nameLabels(parts) };
		this.#labels.set(found.id, labels);
		return { labels };
	}

	/** A sandbox Tensorlake reads gone: its labels, its delete, its proxy and its login are let go. */
	#forget(id: string): void {
		this.#labels.delete(id);
		this.#ending.delete(id);
		this.#proxies.delete(id);
		this.#enables.delete(id);
		this.#held.delete(id);
	}

	/**
	 * POST /sandboxes (O CreateSandboxRequest): the request's name with its run's hash, epoch and deadline (sandboxName),
	 * the image, the size when the request names one, the backstop's span as the idle threshold (60 s to a day), no wake on
	 * proxied traffic once suspended (auto_resume false), the internet when the request reaches out (else none, DNS
	 * included), no wait for it to run (wait false: 202, pending), and no longer a wait for capacity than create's own.
	 * Only a 429, a refusal that made nothing, is sent again: a create that got no answer may have made a sandbox, which
	 * the adapter finds by its name; a 409 is a sandbox of the name, exists. Then, once the sandbox reads running within
	 * ctx.timeoutMs, one processes/run call writes the labels file. A sandbox that ends first, a write that fails, or a
	 * bound passed, throws: a create that made a machine to the adapter, which deletes it by its name. A refusal after the
	 * sandbox exists (a 429 past every retry, limit; a 401, denied) the adapter reads as a create that made nothing
	 * (mayHaveMade), so this deletes the sandbox by its id first and throws the refusal in its own code.
	 */
	async create(req: MachineRequest, ctx: HostCall): Promise<{ id: string }> {
		const end = Date.now() + ctx.timeoutMs;
		const name = sandboxName(req);
		const span = Math.ceil((Date.parse(req.backstopAt) - Date.now()) / 1000);
		const resources = { ...(req.cpus === undefined ? {} : { cpus: req.cpus }), ...(req.memoryMb === undefined ? {} : { memory_mb: req.memoryMb }) };
		const body = {
			name,
			image: req.image,
			...(Object.keys(resources).length > 0 ? { resources } : {}),
			timeout_secs: Math.min(MAX_TIMEOUT_S, Math.max(MIN_TIMEOUT_S, Number.isFinite(span) ? span : MAX_TIMEOUT_S)),
			network: { allow_internet_access: req.egress },
			auto_resume: false,
			wait: false,
			max_pending_secs: Math.max(1, Math.ceil(ctx.timeoutMs / 1000)),
		};
		const { body: made } = await this.#call("POST", "/sandboxes", ctx, { json: body, named: true, retry: (status) => status === 429 });
		const id = (made as { sandbox_id?: unknown } | null)?.sandbox_id;
		if (typeof id !== "string" || !SANDBOX_ID.test(id)) throw new HostError("vendor", `POST /sandboxes answered no sandbox id: ${show(id)}`);
		this.#labels.set(id, { ...req.labels });
		try {
			await this.#untilRunning(id, end, ctx);
			const wrote = await this.#run(id, WRITE_LABELS, [JSON.stringify(req.labels)], { ...ctx, timeoutMs: Math.max(1, end - Date.now()) });
			if (wrote.exit !== 0) throw new HostError("vendor", `writing the labels file of ${id} exited ${wrote.exit}: ${(wrote.stderr.trim() || wrote.stdout.trim()).slice(-300)}`);
		} catch (error) {
			if (!(error instanceof HostError) || mayHaveMade(error.code)) throw error;
			throw await this.#unmade(id, error);
		}
		return { id };
	}

	/** The sandbox a failed create made, deleted by its id: the step's error in its own code, the delete's outcome added. */
	async #unmade(id: string, error: HostError): Promise<HostError> {
		let outcome: string;
		try {
			await this.delete(id, { timeoutMs: CALL_MS });
			outcome = `the sandbox ${id} it made was deleted`;
		} catch (failed) {
			outcome = `the sandbox ${id} it made could not be deleted (${failed instanceof Error ? failed.message : String(failed)}); the janitor ends it at its deadline`;
		}
		return new HostError(error.code, `${error.message}; ${outcome}`);
	}

	/**
	 * Reads the sandbox until it runs, pollMs apart, by `end`. Terminated first (no capacity within max_pending_secs, an
	 * image it could not boot) throws in Tensorlake's words, no capacity a limit; suspended or gone, vendor; the end, timeout.
	 */
	async #untilRunning(id: string, end: number, ctx: HostCall): Promise<void> {
		for (;;) {
			const found = await this.#read(id, { ...ctx, timeoutMs: Math.max(1, end - Date.now()) });
			if (found?.status === "running") return;
			if (found === undefined || found.status === "terminated") {
				const reason = [found?.termination_reason, found?.error_details].filter(Boolean).join(": ") || "no reason given";
				throw new HostError(found?.termination_reason === "no_capacity" ? "limit" : "vendor", `Tensorlake ended the sandbox ${id} before it ran: ${reason}`);
			}
			if (found.status !== "pending") throw new HostError("vendor", `Tensorlake reads the sandbox ${id} ${found.status} before it ran`);
			if (Date.now() + this.#pollMs >= end) throw new HostError("timeout", `the sandbox ${id} did not read running within ${seconds(ctx.timeoutMs)} (it reads pending${found.pending_reason ? `: ${found.pending_reason}` : ""})`);
			await pause(this.#pollMs, ctx.signal);
			if (ctx.signal?.aborted) throw new HostError("aborted", `the wait for the sandbox ${id} to run was aborted`);
		}
	}

	/**
	 * GET /sandboxes/{id}; a 404, or a sandbox terminated, is none, and lets go of what this process kept of it. Its labels
	 * are read within this call's own bound (#labelsOf), and a read that fails gives the name's: enough for the adapter to
	 * know its computer, release it, and for the janitor to end it at its deadline.
	 */
	async get(id: string, ctx: HostCall): Promise<Machine | undefined> {
		const end = Date.now() + ctx.timeoutMs;
		const found = await this.#read(id, ctx);
		if (found === undefined || found.status === "terminated") {
			this.#forget(id);
			return undefined;
		}
		return machineOf(found, (await this.#labelsOf(found, ctx, end)).labels);
	}

	/**
	 * GET /sandboxes (O list_sandboxes: those not terminated), every page by next_cursor. Tensorlake filters by status
	 * alone, so every label is matched here: only sandboxes named as computers whose name may carry the labels asked
	 * (mayCarry), and a label asked that is not the name's is read from each one's labels file (#labelsOf), LABEL_READS
	 * at once, all within this call's own bound; only those that carry every label asked are answered. A file that can't
	 * be read by then (the sandbox not running, no file yet, a read that fails) fails the listing closed, once every read
	 * has ended, naming each such sandbox and why:
	 * the listing can't tell whether it carries the labels asked, and leaving it out would let a run's listing miss a
	 * newer epoch's fence or call a partial cleanup whole (janitor.ts releaseOlder). A listing by run reads only the
	 * sandboxes whose name has the run's hash, so another run's never fails it. What this process kept of a sandbox the
	 * listing no longer shows is let go.
	 */
	async list(labels: Record<string, string>, ctx: HostCall): Promise<Machine[]> {
		const end = Date.now() + ctx.timeoutMs;
		// Only what was kept before the listing began is let go: a sandbox made while it ran may not be on its pages.
		const kept = [...new Set([...this.#labels.keys(), ...this.#ending])];
		const listed = orThrow(
			await allPages<TensorlakeSandbox>(
				async (cursor) => {
					const query = new URLSearchParams({ limit: String(PAGE), ...(cursor === undefined ? {} : { cursor }) });
					const { body } = await this.#call("GET", `/sandboxes?${query}`, ctx, { retry: true });
					const page = body as { sandboxes?: unknown; next_cursor?: unknown } | null;
					if (!Array.isArray(page?.sandboxes)) throw new HostError("vendor", "GET /sandboxes answered no list");
					const items = (page.sandboxes as Array<TensorlakeSandbox | null>).filter((one): one is TensorlakeSandbox => typeof one?.id === "string" && typeof one.status === "string");
					return ok({ items, ...(typeof page.next_cursor === "string" && page.next_cursor !== "" ? { next: page.next_cursor } : {}) });
				},
				MAX_PAGES,
				{ vendor: TENSORLAKE.id, what: "Tensorlake's sandbox listing" },
			),
		);
		const live = listed.filter((found) => found.status !== "terminated");
		const shown = new Set(live.map(({ id }) => id));
		for (const id of kept) if (!shown.has(id)) this.#forget(id);
		for (const found of live) this.#remember(found);
		const ours = live.filter((found) => {
			const parts = nameParts(found.name);
			return parts !== undefined && mayCarry(parts, labels);
		});
		const read = await eachAtMost(ours, LABEL_READS, async (found) => ({ found, ...(await this.#labelsOf(found, ctx, end, labels)) }));
		const unread = read.flatMap(({ found, unread: why }) => (why === undefined ? [] : [`${found.id}: ${why}`]));
		if (unread.length > 0) {
			const asked = Object.entries(labels).filter(([key]) => key !== COMPUTER_LABEL && key !== NAME_LABEL);
			const carry = unread.length === 1 ? "it carries" : "they carry";
			throw new HostError("vendor", `could not read the labels of ${unread.join("; ")}; the listing can't tell whether ${carry} ${asked.map(([key, value]) => `${key}=${value}`).join(", ")}`);
		}
		return read.flatMap(({ found, labels: carried }) => (Object.entries(labels).every(([key, value]) => carried[key] === value) ? [machineOf(found, carried)] : []));
	}

	/**
	 * DELETE /sandboxes/{id} (O: idempotent, success for one already terminated); a 404 is done. Then this host's SSH
	 * connections to it end, and its proxy and login go. What this process kept of its labels stays until a read finds it
	 * gone, and it is marked ending, so no read of its guest is made meanwhile.
	 */
	async delete(id: string, ctx: HostCall): Promise<void> {
		try {
			const { status } = await this.#call("DELETE", `/sandboxes/${sandboxId(id)}`, ctx, { retry: true, accept: (code) => code === 404 || (code >= 200 && code < 300) });
			if (status === 404) this.#forget(id);
			else this.#ending.add(id);
		} finally {
			this.#ssh.closeAll(id);
			this.#proxies.delete(id);
			this.#enables.delete(id);
			this.#held.delete(id);
		}
	}

	/**
	 * argv over SSH through the sandbox proxy's TCP tunnel (hosted/ssh-exec.ts), as tl-user with sudo, logged in with this
	 * process's key. SSH is enabled for that key first when this host has not yet; a login the sshd refuses (another
	 * process's key enabled since) lets the enable go and enables again, once; a fresh enable refused is denied. Execs
	 * refused at once share the one enable in its place. Each step (the wait on the enable, the SSH start, and again on a
	 * refusal) has what is left of ctx's time, and its signal.
	 */
	async exec(id: string, argv: readonly string[], ctx: HostCall): Promise<MachineProcess> {
		sandboxId(id);
		const end = Date.now() + ctx.timeoutMs;
		const left = (): HostCall => ({ ...ctx, timeoutMs: Math.max(1, end - Date.now()) });
		const held = this.#enables.has(id);
		const login = await this.#login(id, left());
		try {
			return await this.#ssh.exec(id, argv, left());
		} catch (error) {
			if (codeOf(error) !== "denied") throw error;
			this.#let(id, login);
			if (!held) throw error;
			await this.#login(id, left());
			return this.#ssh.exec(id, argv, left());
		}
	}

	/**
	 * The sandbox's SSH enable, made once for all the execs that ask at once. It is no one exec's: it runs within its own
	 * CALL_MS and no exec's signal, and each exec waits on it within its own time and signal.
	 */
	async #login(id: string, ctx: HostCall): Promise<Login> {
		let enabling = this.#enables.get(id);
		if (enabling === undefined) {
			const enable = this.#enable(id);
			enabling = enable;
			this.#enables.set(id, enable);
			enable.then(
				(login) => this.#enables.get(id) === enable && this.#held.set(id, login),
				() => this.#enables.get(id) === enable && this.#enables.delete(id),
			);
		}
		const bound = boundOf(ctx.timeoutMs, ctx.signal, `the SSH enable on ${id}`);
		try {
			return await Promise.race([enabling, bound.promise]);
		} finally {
			bound.clear();
		}
	}

	/** Lets the refused login go, so an enable another exec already made in its place stays. */
	#let(id: string, refused: Login): void {
		if (this.#held.get(id) !== refused) return;
		this.#enables.delete(id);
		this.#held.delete(id);
	}

	/**
	 * POST /api/v1/ssh/enable through the sandbox's proxy (O SandboxSshEnableRequest): this process's public key as the
	 * one the sshd takes, for tl-user. Its answer must say enabled and name the sshd's host key fingerprint in OpenSSH's
	 * sha256 form, which the login pins the sshd to: an answer with none (null) is refused, so no exec runs through an
	 * sshd it can't verify.
	 */
	async #enable(id: string): Promise<Login> {
		const where = `POST /api/v1/ssh/enable on ${id}`;
		const proxy = await this.#proxyOf(id, { timeoutMs: CALL_MS });
		const body = orThrow(await proxy.api.json("POST", proxy.api.url("/api/v1/ssh/enable"), { json: { proxy_pubkey: keyOfProcess().line, backend_user: SSH_USER }, timeoutMs: CALL_MS, retry: true }));
		const { enabled, host_key_fingerprint: fingerprint } = (body ?? {}) as { enabled?: unknown; host_key_fingerprint?: unknown };
		if (enabled !== true) throw new HostError("vendor", `${where} answered that SSH is not enabled: ${show(enabled)}`);
		if (fingerprint === undefined || fingerprint === null) throw new HostError("vendor", `${where} answered no host key fingerprint, so there is no host key to pin its sshd by, and this host never runs a command through an sshd it can't verify: no connection was made`);
		if (typeof fingerprint !== "string" || !HOST_KEY_PIN.test(fingerprint)) throw new HostError("vendor", `${where} answered a host key fingerprint that is not OpenSSH's sha256 form (SHA256:...): ${show(fingerprint)}`);
		return { hostKey: fingerprint };
	}

	/** The SSH stream to the sandbox's sshd: the proxy's TCP tunnel to its port 22, a binary WebSocket, as a Duplex. */
	#tunnel(id: string): SshTunnel {
		const proxy = this.#proxies.get(id);
		if (proxy === undefined) throw new SshTunnelError(`no proxy is known for ${id}, so no tunnel to its sshd`);
		const ws = new this.#WebSocket(`wss://${proxy.host}/api/v1/tunnels/tcp?port=${SSH_PORT}`, { headers: { Authorization: `Bearer ${this.#apiKey}`, "X-Tensorlake-Sandbox-Id": id } });
		ws.binaryType = "arraybuffer";
		return { ...tunnelOf(ws, proxy.host, "the sandbox proxy opens it for the API key of the sandbox's project alone"), host: proxy.host };
	}

	/**
	 * An image is one of Tensorlake's or a name registered in the project, by form; a size is at most 16 vCPUs, with 1 to
	 * 8 GB of memory a vCPU (D platform/billing: a plan's own bound is lower, and Tensorlake's refusal says so).
	 */
	check(spec: Partial<ComputerSpec>): Refusal[] {
		const refusals: Refusal[] = [];
		const { image, cpus, memoryMb } = spec;
		if (typeof image === "string" && !IMAGE.test(image)) refusals.push({ field: "image", message: `an image is one of Tensorlake's (${TENSORLAKE_IMAGE}) or a sandbox image registered in the key's project, by its name` });
		if (cpus !== undefined && !(typeof cpus === "number" && cpus > 0 && cpus <= MAX_CPUS)) refusals.push({ field: "cpus", message: `a Tensorlake sandbox has more than 0 and at most ${MAX_CPUS} vCPUs` });
		else if (memoryMb !== undefined) {
			// With no size named, the memory alone is held to the range of some size: 1 vCPU's least to 16 vCPUs' most.
			const least = Math.max(MIN_MB_PER_CPU, Math.ceil(MIN_MB_PER_CPU * (cpus ?? 1)));
			const most = Math.floor(MAX_MB_PER_CPU * (cpus ?? MAX_CPUS));
			if (!(isWhole(memoryMb) && memoryMb >= least && memoryMb <= most)) {
				refusals.push({ field: "memoryMb", message: `a Tensorlake sandbox has 1024 to 8192 MB of memory a vCPU, in whole MB: ${least} to ${most} MB${cpus === undefined ? "" : ` for ${cpus} vCPUs`}` });
			}
		}
		return refusals;
	}
}

/**
 * A TensorlakeProvider from its options alone; it reads no environment. The key is options.apiKey, nowhere else (serve
 * passes its TENSORLAKE_API_KEY, the conformance module what it reads), and ssh2 is the host's package unless given.
 */
export async function create(options: TensorlakeOptions): Promise<TensorlakeProvider> {
	const { ssh2: given, ...rest } = options ?? ({} as TensorlakeOptions);
	if (typeof rest.apiKey !== "string" || rest.apiKey === "") throw new Error(KEY_REQUIRED);
	// ssh2 is CommonJS: its Client is a named export of the module, and of its default.
	const loaded = given ?? (await vendorSdk<Partial<Ssh2Module> & { default?: Ssh2Module }>(TENSORLAKE.label, "ssh2"));
	const ssh2 = typeof loaded.Client === "function" ? (loaded as Ssh2Module) : (loaded as { default?: Ssh2Module }).default;
	return new TensorlakeProvider({ ...rest, ssh2: ssh2 as Ssh2Module });
}

export const conformance = () => import("./conformance/tensorlake.js");

const KEY_REQUIRED = "options.apiKey, the Tensorlake API key, is required: the provider reads no environment, so the caller passes it";
/** tl-user's uid (D sandboxes/tensorlake-images: UID 1000), whose processes init refuses to run beside. */
const SANDBOX_UID = 1000;

/** Computers that are Tensorlake sandboxes, on the shared adapter: a sandbox from a Tensorlake image, no desktop. */
export class TensorlakeProvider extends HostedProvider {
	constructor(options: TensorlakeProviderOptions) {
		const { apiKey, ssh2, fetch: fetcher, WebSocket = globalThis.WebSocket as unknown as WebSocketClass, apiUrl = DEFAULT_API_URL, maxLifetimeMs = MAX_LIFETIME_MS, timeouts = {}, ...rest } = options ?? ({} as TensorlakeProviderOptions);
		if (typeof apiKey !== "string" || apiKey === "") throw new Error(KEY_REQUIRED);
		if (typeof (ssh2 as { Client?: unknown } | null)?.Client !== "function") throw new Error("options.ssh2 must be the ssh2 package (its Client class): the host installs it, as it does for Agent37 and InstaBox");
		if (fetcher !== undefined && typeof fetcher !== "function") throw new Error("options.fetch must be a function, as the global fetch is");
		if (typeof WebSocket !== "function") throw new Error("options.WebSocket must be a WebSocket class that takes headers, as Node's global one does");
		if (Number(rest.daemonUser?.split(":")[0]) === SANDBOX_UID) throw new Error(`the daemon user ${rest.daemonUser} is tl-user's uid, whose processes init refuses to run beside; choose another, such as 2510:2510`);
		const host = new TensorlakeHost({ apiKey, ssh2, ...(fetcher ? { fetch: fetcher } : {}), WebSocket, apiUrl: httpsBase(apiUrl, "the Tensorlake API URL"), pollMs: timeoutsOf(timeouts).pollMs });
		super(host, { ...rest, maxLifetimeMs, timeouts });
	}
}
