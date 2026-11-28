// The InstaBox host: a Linux sandbox on an InstaBox machine, a Firecracker microVM, over its REST API
// (https://api.instabox.sh/v1, the key in X-API-Key). Sources: D = the docs (https://instabox.sh/llms-full.txt), O = the
// OpenAPI (https://api.instabox.sh/v1/openapi.json). A machine is made (an operation, under an Idempotency-Key), read by
// id, listed by metadata and deleted (with X-Confirm-Delete) over REST. Every command (the daemon's upload, its install,
// init's start, the stdio bridge) goes over SSH through the shared SshExec (./hosted/ssh-exec.ts) to InstaBox's gateway,
// logged in with an SSH token the REST API mints per machine (D ssh-tokens: the token is the username, no key needed).
// The token rides in the username, so the gateway's host key is pinned to the sha256 the token's answer names
// (hostKeyFingerprint), and a host posing as the gateway reads no token: the pin is required twice, by the token answer's
// check and by the SshExec (pinned), so a login with no pin opens no connection. The SSH user is the machine's own, `user` (uid
// 1000), with passwordless sudo (D templates), which the adapter's scripts take for root. The REST exec takes its stdin
// once and kills at 10 minutes (D exec), so it is not used; the file API writes as the machine's user, not root (D files),
// so this host has no upload and the daemon goes through exec. The labels are packed into the machine's metadata, whose
// keys can't hold every label name (O CreateMachineRequest). A machine's delete timer (deleteAfterSeconds, at most a day)
// is set at create to the request's backstop, and the janitor ends it at its deadline; its idle pause and its maximum run
// are switched off, which only a paid plan allows.
//
// Unverified until the live run: the gateway takes the token as the username with SSH's none auth; its host key is one
// ssh2 verifies, whose sha256 is hostKeyFingerprint; a create of a name the workspace holds answers 409 (read as exists);
// a deleted machine reads 404 or a record in state deleted (both none); sshd's port 22 is the vendor's one TCP listener
// in the machine; the minimal template is on every paid plan; the metadata's 8 KiB is counted on compact JSON; a silent
// SSH channel stays open through 75 s.
import { createHash, randomUUID } from "node:crypto";
import { isIP, connect as tcp } from "node:net";
import { INSTABOX } from "./descriptors/instabox.js";
import { show } from "./drift.js";
import { proxyFor, tunnelThrough } from "./env-proxy.js";
import { BACKSTOP_MARGIN_MS, type HostCall, HostError, type HostFacts, type Machine, type MachineHost, type MachineProcess, type MachineRequest } from "./host.js";
import { boundOf, orThrow, pause } from "./hosted/process.js";
import { HostedProvider, type HostedOptions } from "./hosted/provider.js";
import { allPages, httpsBase, jsonOf, type Rest, type RestInit, rest } from "./hosted/rest.js";
import { HOST_KEY_PIN, type Ssh2Module, SshExec, SshTunnelError, type SshTunnel } from "./hosted/ssh-exec.js";
import { DOMAIN, dateOf } from "./hosted/values.js";
import type { ComputerSpec, Refusal } from "./provider.js";
import { type ComputerErrorCode, ok } from "./result.js";
import { vendorSdk } from "./vendor-sdk.js";

/** A machine as InstaBox answers it (O Machine), as far as this host reads it. */
interface InstaboxMachine {
	id: string;
	state?: string;
	runtime?: { ready?: boolean } | null;
	metadata?: Record<string, string> | null;
	createdAt?: string;
	lastError?: { code?: string; message?: string } | null;
	spec?: { vcpus?: number; memMiB?: number; persistentDiskGiB?: number } | null;
}

/** An SSH token's login, as POST /v1/machines/{id}/ssh-tokens answers it (O SSHToken). */
interface Login {
	token: string;
	host: string;
	port: number;
	fingerprint: string;
}

/** The InstaBox provider's options: the key and ssh2, then the shared adapter's (HostedOptions). */
export interface InstaboxProviderOptions extends Omit<HostedOptions, "kind" | "desktop"> {
	/** The workspace's API key. The caller passes it; this provider never reads it from the environment. */
	apiKey: string;
	/** The ssh2 package: the host's own, or anything with the same slice. */
	ssh2: Ssh2Module;
	/** The fetch every REST call goes through; default the global one. */
	fetch?: typeof fetch;
	/** The API's root; default https://api.instabox.sh. */
	apiUrl?: string;
}

/** What create() takes: the provider's options, ssh2 optional (default the host's ssh2 package). */
export interface InstaboxOptions extends Omit<InstaboxProviderOptions, "ssh2"> {
	ssh2?: Ssh2Module;
}

export const DEFAULT_API_URL = "https://api.instabox.sh";
const DAY_MS = 24 * 60 * 60_000;
/** The delete timer's range (O CreateMachineRequest.deleteAfterSeconds: 60 to 86400). */
const MAX_DELETE_S = 86_400;
const MIN_DELETE_S = 60;
/** The longest a computer lives: its backstop, past it by BACKSTOP_MARGIN_MS, is then within InstaBox's day. */
const MAX_LIFETIME_MS = DAY_MS - BACKSTOP_MARGIN_MS;
const CALL_MS = 30_000;
const PAGE = 100;
/** How long a token works (O CreateSSHTokenRequest: at most 30 days): a day, the most a machine lives. */
const TOKEN_TTL_S = 86_400;
/** The pause between two deletes InstaBox refuses while another operation runs on the machine (409 operation_conflict). */
const BUSY_MS = 1_000;
/** A machine id (m_ and base32: O Machine.id) as it reaches a URL. */
const MACHINE_ID = /^m_[a-z0-9]{1,64}$/;
/** An SSH token (O SSHToken.token: ibssh_ and base32): the username, nothing a shell or ssh2 reads otherwise. */
const TOKEN = /^ibssh_[a-z0-9]{1,128}$/;
/** A template id, a snapshot's name, or a snapshot's id (sn_...): what a create's image names (D create). */
const IMAGE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
/** The sizes InstaBox offers, each plan a range of them (D sizes): 2 GiB per vCPU. */
const SIZES = [2, 4, 8, 16, 32] as const;
const MIB_PER_CPU = 2048;
/** InstaBox's codes whose meaning is the adapter's code whatever their status (O Error.code). */
const CODES: Readonly<Record<string, ComputerErrorCode>> = {
	rate_limited: "limit",
	quota_exceeded: "limit",
	concurrency_limit: "limit",
	no_capacity: "limit",
	machine_cooldown: "limit",
	template_limit: "limit",
	spec_not_allowed: "refused",
	template_not_allowed: "refused",
	template_job_only: "refused",
	missing_scope: "denied",
	permission_denied: "denied",
};

/** InstaBox's states (O MachineState) as the adapter's; deleted is none (get answers undefined), error is gone. */
const STATES: Readonly<Record<string, Machine["state"]>> = {
	creating: "starting",
	starting: "starting",
	resuming: "starting",
	running: "running",
	stopping: "stopped",
	stopped: "stopped",
	suspending: "stopped",
	suspended: "stopped",
	deleting: "gone",
	error: "gone",
};

/** A machine as the adapter reads it: a running one not ready yet is starting. */
function machineOf(one: InstaboxMachine): Machine {
	const known = STATES[one.state ?? ""];
	const state = known === "running" && one.runtime?.ready !== true ? "starting" : known;
	const created = dateOf(one.createdAt);
	const { vcpus, memMiB, persistentDiskGiB } = one.spec ?? {};
	const resources = { ...(vcpus ? { cpus: vcpus } : {}), ...(memMiB ? { memoryMb: memMiB } : {}), ...(persistentDiskGiB ? { diskGb: persistentDiskGiB } : {}) };
	const why =
		known === undefined
			? `InstaBox reads its state as ${show(one.state)}, which this provider does not know`
			: one.state === "error"
				? `InstaBox reads it in error: ${[one.lastError?.code, one.lastError?.message].filter(Boolean).join(": ") || "no reason given"}`
				: undefined;
	return {
		id: one.id,
		labels: { ...(one.metadata ?? {}) },
		// One in a state this provider does not know is listed, so the janitor still ends it.
		state: state ?? "stopped",
		...(created ? { createdAt: created } : {}),
		...(Object.keys(resources).length > 0 ? { resources } : {}),
		...(why === undefined ? {} : { why }),
	};
}

/** An id held to InstaBox's form before it reaches a URL: not_found else. */
function machineId(id: string): string {
	if (!MACHINE_ID.test(id)) throw new HostError("not_found", `${JSON.stringify(id)} is not an InstaBox machine id`);
	return id;
}

/** ssh2 names the stage that failed (lib/client.js): the gateway refused the login, or the handshake timed out. */
function codeOf(error: unknown): ComputerErrorCode {
	if (error instanceof HostError) return error.code;
	const { level } = (error ?? {}) as { level?: unknown };
	if (level === "client-authentication") return "denied";
	if (level === "client-timeout") return "timeout";
	return "vendor";
}

/** The workspace a key reaches, in words: the key named by its sha256 prefix alone. */
export function accountOf(apiKey: string, apiUrl: string = DEFAULT_API_URL): string {
	return `the InstaBox workspace of the key sha256:${createHash("sha256").update(apiKey, "utf8").digest("hex").slice(0, 12)} at ${httpsBase(apiUrl, "the InstaBox API URL")}`;
}

class InstaboxHost implements MachineHost {
	readonly descriptor = INSTABOX;
	readonly facts: HostFacts = {
		daemon: "child",
		// Firecracker (D templates).
		isolation: "microvm",
		lifetime: "janitor",
		maxLifetimeMs: MAX_LIFETIME_MS,
		arch: "amd64",
		// The guest's sshd, behind the gateway (D: systemd, sshd, sudo); its port, and the guest agent's, unverified.
		vendorAgentPorts: [22],
		// O: 32 keys of 1-64 [A-Za-z0-9_.-], values up to 512 characters, 8 KiB as JSON. Compact JSON adds 6 bytes a label
		// and 1 for the braces past the names and values packLabels counts: 7999 + 6 × 32 + 1 = 8192.
		labels: { count: 32, bytes: 7_999, packed: { valueBytes: 512 } },
	};
	readonly #apiKey: string;
	readonly #apiUrl: string;
	readonly #fetch: typeof fetch | undefined;
	readonly #api: Rest;
	readonly #ssh: SshExec;
	/** Each machine's token mint, in flight or done, kept until delete or a refused login. */
	readonly #logins = new Map<string, Promise<Login>>();
	/** Each machine's minted login, which SshExec's loginOf reads. */
	readonly #held = new Map<string, Login>();

	constructor(options: { apiKey: string; ssh2: Ssh2Module; fetch?: typeof fetch; apiUrl: string }) {
		this.#apiKey = options.apiKey;
		this.#apiUrl = options.apiUrl;
		this.#fetch = options.fetch;
		this.#api = this.#client();
		// The username is the machine's token alone, the gateway's key pinned: the API key never goes over SSH.
		this.#ssh = new SshExec({
			ssh2: options.ssh2,
			pinned: true,
			loginOf: (id) => {
				const login = this.#held.get(id);
				if (login === undefined) throw new HostError("denied", `no SSH token for ${id}`);
				return { username: login.token, hostKey: login.fingerprint, secrets: [login.token, this.#apiKey] };
			},
			tunnelOf: (id) => this.#tunnel(id),
		});
	}

	/** The API's client, with headers of one call's own beside the key (a lifecycle call's Idempotency-Key). */
	#client(headers: Record<string, string> = {}): Rest {
		return rest({
			base: this.#apiUrl,
			headers: () => ({ "X-API-Key": this.#apiKey, Accept: "application/json", ...headers }),
			vendor: INSTABOX.id,
			...(this.#fetch ? { fetch: this.#fetch } : {}),
			timeoutMs: CALL_MS,
			retry: { attempts: 3, baseMs: 500 },
			// Every refusal's body is {error: {code, message, hint}} (O Error): a code above is the adapter's whatever its status.
			explain: ({ status, bytes, what }) => {
				const error = (jsonOf(bytes) as { error?: { code?: unknown; message?: unknown; hint?: unknown } } | null)?.error;
				const named = typeof error?.code === "string" ? error.code : undefined;
				const code = named === undefined ? undefined : CODES[named];
				const words = [error?.message, error?.hint].filter((part) => typeof part === "string" && part !== "").join(" ");
				const plan = named === "spec_not_allowed" && status === 403 ? " (a computer switches off InstaBox's idle pause and maximum run, which only a paid plan allows)" : "";
				return { ...(code ? { code } : {}), message: `${what} answered ${status}${named ? ` ${named}` : ""}${words ? `: ${words}` : ""}${plan}` };
			},
		});
	}

	async #call(method: string, path: string, ctx: HostCall, init: RestInit = {}, api: Rest = this.#api): Promise<{ status: number; body: unknown }> {
		const answer = orThrow(await api.call(method, api.url(path), { timeoutMs: ctx.timeoutMs, ...init }, ctx.signal));
		return { status: answer.status, body: jsonOf(answer.bytes) };
	}

	errorCode(error: unknown): ComputerErrorCode {
		return codeOf(error);
	}

	/**
	 * POST /v1/machines: the request's name, the image as a template or a snapshot (sn_...), the size when the request
	 * names one, the packed labels as metadata, the delete timer at the backstop, no idle pause and no maximum run, no
	 * vault and no secrets. Its Idempotency-Key is this one request's, so a create sent again on no answer makes no second
	 * machine. InstaBox answers an operation at once, with the machine's id; the adapter polls get while it starts.
	 */
	async create(req: MachineRequest, ctx: HostCall): Promise<{ id: string }> {
		const seconds = Math.ceil((Date.parse(req.backstopAt) - Date.now()) / 1000);
		const cpus = req.cpus ?? (req.memoryMb === undefined ? undefined : req.memoryMb / MIB_PER_CPU);
		const body = {
			name: req.name,
			...(req.image.startsWith("sn_") ? { snapshotId: req.image } : { templateId: req.image }),
			...(cpus === undefined ? {} : { vcpus: cpus, memMiB: req.memoryMb ?? cpus * MIB_PER_CPU }),
			metadata: req.labels,
			deleteAfterSeconds: Math.min(MAX_DELETE_S, Math.max(MIN_DELETE_S, seconds)),
			autoSuspendAfterSeconds: 0,
			maxRunMinutes: -1,
			vault: false,
			secrets: [],
		};
		const api = this.#client({ "Idempotency-Key": `agentrun-${req.name}-${req.backstopAt}` });
		const { body: made } = await this.#call("POST", "/v1/machines", ctx, { json: body, retry: true, named: true }, api);
		const id = (made as { machineId?: unknown } | null)?.machineId;
		if (typeof id !== "string" || !MACHINE_ID.test(id)) throw new HostError("vendor", `POST /v1/machines answered no machine id: ${show(id)}`);
		return { id };
	}

	/** GET /v1/machines/{id}; a 404, or a record of a machine deleted, is none. */
	async get(id: string, ctx: HostCall): Promise<Machine | undefined> {
		const read = await this.#call("GET", `/v1/machines/${machineId(id)}`, ctx, { retry: true, accept: (status) => status === 404 || (status >= 200 && status < 300) });
		const one = read.body as InstaboxMachine | null;
		if (read.status === 404 || one?.state === "deleted") return undefined;
		if (typeof one?.id !== "string") throw new HostError("vendor", `GET /v1/machines/${id} answered no machine`);
		return machineOf(one);
	}

	/**
	 * GET /v1/machines with each asked label as a metadata filter (AND), every page; the labels are matched here too, so a
	 * listing that answers more is filtered. A record of a machine deleted is left out.
	 */
	async list(labels: Record<string, string>, ctx: HostCall): Promise<Machine[]> {
		const asked = Object.entries(labels);
		const page = async (cursor?: string) => {
			const query = new URLSearchParams([...asked.map(([name, value]): [string, string] => ["metadata", `${name}:${value}`]), ["limit", String(PAGE)], ...(cursor ? [["cursor", cursor] as [string, string]] : [])]);
			const { body } = await this.#call("GET", `/v1/machines?${query}`, ctx, { retry: true });
			const read = body as { machines?: InstaboxMachine[]; nextCursor?: string | null } | null;
			return ok({ items: read?.machines ?? [], ...(read?.nextCursor ? { next: read.nextCursor } : {}) });
		};
		return orThrow(await allPages<InstaboxMachine>(page, 100, { vendor: INSTABOX.id, what: "GET /v1/machines" }))
			.filter((one) => typeof one?.id === "string" && one.state !== "deleted")
			.map(machineOf)
			.filter((machine) => asked.every(([name, value]) => machine.labels[name] === value));
	}

	/**
	 * DELETE /v1/machines/{id}, confirmed by its id, each attempt its own Idempotency-Key; a 404 is done. A machine with
	 * an operation running (its create's) refuses the delete with 409 operation_conflict, which is sent again, a pause
	 * between, within ctx. Then this host's SSH connections to it end and its login goes: InstaBox ends its tokens with it.
	 */
	async delete(id: string, ctx: HostCall): Promise<void> {
		const end = Date.now() + ctx.timeoutMs;
		try {
			for (;;) {
				const api = this.#client({ "Idempotency-Key": randomUUID(), "X-Confirm-Delete": machineId(id) });
				const accept = (status: number) => status === 404 || status === 409 || (status >= 200 && status < 300);
				const { status, body } = await this.#call("DELETE", `/v1/machines/${id}`, { ...ctx, timeoutMs: Math.max(1, end - Date.now()) }, { retry: true, accept }, api);
				if (status !== 409) return;
				const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
				if (code !== "operation_conflict") throw new HostError("vendor", `DELETE /v1/machines/${id} answered 409 ${show(code)}`);
				if (Date.now() + BUSY_MS >= end) throw new HostError("timeout", `InstaBox kept refusing the delete of ${id} within ${Math.round(ctx.timeoutMs / 1000)} s: another operation runs on it`);
				await pause(BUSY_MS, ctx.signal);
			}
		} finally {
			this.#ssh.closeAll(id);
			this.#forget(id);
		}
	}

	/**
	 * argv over SSH through the gateway (hosted/ssh-exec.ts), as the machine's user with sudo. The machine's token is
	 * minted first when this host has none for it. A held token the gateway refuses (revoked, or run out) is let go and
	 * another minted, once; a fresh one refused is denied. Execs refused on the same token share the one minted in its place.
	 * Each step (the wait on the mint, the SSH start, and again on a refusal) has what is left of ctx's time, and its signal.
	 */
	async exec(id: string, argv: readonly string[], ctx: HostCall): Promise<MachineProcess> {
		machineId(id);
		const end = Date.now() + ctx.timeoutMs;
		const left = (): HostCall => ({ ...ctx, timeoutMs: Math.max(1, end - Date.now()) });
		const held = this.#logins.has(id);
		const login = await this.#login(id, left());
		try {
			return await this.#ssh.exec(id, argv, left());
		} catch (error) {
			if (codeOf(error) !== "denied") throw error;
			this.#forget(id, login);
			if (!held) throw error;
			await this.#login(id, left());
			return this.#ssh.exec(id, argv, left());
		}
	}

	/**
	 * The machine's login, minted once for all the execs that ask at once. The mint is no one exec's: it runs within its
	 * own CALL_MS and no exec's signal, and each exec waits on it within its own time and signal, so one's cancel or bound
	 * ends that exec's wait alone.
	 */
	async #login(id: string, ctx: HostCall): Promise<Login> {
		let minting = this.#logins.get(id);
		if (minting === undefined) {
			const mint = this.#mint(id);
			minting = mint;
			this.#logins.set(id, mint);
			mint.then(
				(login) => this.#logins.get(id) === mint && this.#held.set(id, login),
				() => this.#logins.get(id) === mint && this.#logins.delete(id),
			);
		}
		const bound = boundOf(ctx.timeoutMs, ctx.signal, `the SSH token mint for ${id}`);
		try {
			return await Promise.race([minting, bound.promise]);
		} finally {
			bound.clear();
		}
	}

	/**
	 * Lets the machine's login go: every one (delete), or the refused one alone, so a replacement another exec already
	 * mints or holds stays.
	 */
	#forget(id: string, refused?: Login): void {
		if (refused !== undefined && this.#held.get(id) !== refused) return;
		this.#logins.delete(id);
		this.#held.delete(id);
	}

	/**
	 * POST /v1/machines/{id}/ssh-tokens (D ssh-tokens): a token for a day, and the gateway and host key it names, each
	 * held to its form before ssh2 or a socket sees it. Not sent again on no answer: another call is another token.
	 */
	async #mint(id: string): Promise<Login> {
		const where = `POST /v1/machines/${id}/ssh-tokens`;
		const { body } = await this.#call("POST", `/v1/machines/${id}/ssh-tokens`, { timeoutMs: CALL_MS }, { json: { name: "agentrun", ttlSeconds: TOKEN_TTL_S }, retry: (status) => status === 429 || status === 503 });
		const { token, host, port, hostKeyFingerprint: fingerprint } = (body ?? {}) as { token?: unknown; host?: unknown; port?: unknown; hostKeyFingerprint?: unknown };
		if (typeof token !== "string" || !TOKEN.test(token)) throw new HostError("vendor", `${where} answered no SSH token of InstaBox's form (ibssh_...)`);
		if (typeof host !== "string" || !(DOMAIN.test(host) || isIP(host) !== 0)) throw new HostError("vendor", `${where} answered a gateway that is no host name: ${show(host)}`);
		if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new HostError("vendor", `${where} answered a gateway port that is no TCP port: ${show(port)}`);
		if (typeof fingerprint !== "string" || !HOST_KEY_PIN.test(fingerprint)) throw new HostError("vendor", `${where} answered no host key fingerprint (SHA256:...) to pin the gateway by: ${show(fingerprint)}`);
		return { token, host, port, fingerprint };
	}

	/** A TCP connection to the gateway the machine's token names, through the proxy's CONNECT tunnel when one applies (env-proxy.ts). */
	#tunnel(id: string): SshTunnel {
		const login = this.#held.get(id);
		if (login === undefined) throw new SshTunnelError(`no SSH token for ${id}, so no gateway to connect to`);
		const { host, port } = login;
		const name = isIP(host) === 6 ? `[${host}]` : host;
		const where = `${host}:${port}`;
		const proxy = proxyFor(new URL(`https://${name}:${port}`));
		const through = proxy && tunnelThrough(proxy, name, port);
		const socket = through ? through.socket : tcp(port, host);
		// ssh2 reads the socket's errors once it has it; this keeps one before then from being thrown.
		socket.on("error", () => {});
		const failed = (error: Error) => new SshTunnelError(`the SSH connection to ${where}${proxy ? ` through the proxy ${proxy.host}` : ""} failed to open: ${error.message}`);
		const opened = through
			? through.opened.catch((error: Error) => Promise.reject(failed(error)))
			: new Promise<void>((resolve, reject) => {
					socket.once("connect", resolve);
					socket.once("error", (error) => reject(failed(error)));
				});
		opened.catch(() => {});
		return { duplex: socket, opened, host: where };
	}

	/**
	 * An image is a template id, a snapshot's name or its id (sn_...), by form; a size is one InstaBox offers, 2 to 32
	 * vCPUs in powers of two with 2 GiB each: one alone takes the other's match, and a pair that is not one is refused.
	 */
	check(spec: Partial<ComputerSpec>): Refusal[] {
		const refusals: Refusal[] = [];
		if (typeof spec.image === "string" && !IMAGE.test(spec.image)) refusals.push({ field: "image", message: "an image is an InstaBox template id (minimal, agent-browser, universal), or a snapshot's name or id (sn_...) in the key's workspace" });
		const { cpus, memoryMb } = spec;
		const sizes = SIZES.map((one) => `${one} vCPUs with ${one * MIB_PER_CPU} MB`).join(", ");
		if (cpus !== undefined && !(SIZES as readonly unknown[]).includes(cpus)) refusals.push({ field: "cpus", message: `an InstaBox machine has one of its sizes: ${sizes}` });
		else if (memoryMb !== undefined && cpus !== undefined && memoryMb !== cpus * MIB_PER_CPU) refusals.push({ field: "memoryMb", message: `an InstaBox machine has 2048 MB a vCPU, one of its sizes: ${sizes}` });
		else if (memoryMb !== undefined && !(SIZES as readonly number[]).includes(memoryMb / MIB_PER_CPU)) refusals.push({ field: "memoryMb", message: `an InstaBox machine has one of its sizes: ${sizes}` });
		return refusals;
	}
}

/**
 * An InstaboxProvider from its options alone; it reads no environment. The key is options.apiKey, nowhere else (serve
 * passes its INSTABOX_API_KEY, the conformance module what it reads), and ssh2 is the host's package unless given.
 */
export async function create(options: InstaboxOptions): Promise<InstaboxProvider> {
	const { ssh2: given, ...rest } = options ?? ({} as InstaboxOptions);
	if (typeof rest.apiKey !== "string" || rest.apiKey === "") throw new Error(KEY_REQUIRED);
	// ssh2 is CommonJS: its Client is a named export of the module, and of its default.
	const loaded = given ?? (await vendorSdk<Partial<Ssh2Module> & { default?: Ssh2Module }>(INSTABOX.label, "ssh2"));
	const ssh2 = typeof loaded.Client === "function" ? (loaded as Ssh2Module) : (loaded as { default?: Ssh2Module }).default;
	return new InstaboxProvider({ ...rest, ssh2: ssh2 as Ssh2Module });
}

export const conformance = () => import("./conformance/instabox.js");

const KEY_REQUIRED = "options.apiKey, the InstaBox API key, is required: the provider reads no environment, so the caller passes it";
/** The uid of the machine's own user (D templates: uid 1000), whose processes init refuses to run beside. */
const MACHINE_UID = 1000;

/** Computers that are InstaBox machines, on the shared adapter: a sandbox from an InstaBox template, no desktop. */
export class InstaboxProvider extends HostedProvider {
	constructor(options: InstaboxProviderOptions) {
		const { apiKey, ssh2, fetch: fetcher, apiUrl = DEFAULT_API_URL, maxLifetimeMs = MAX_LIFETIME_MS, ...rest } = options ?? ({} as InstaboxProviderOptions);
		if (typeof apiKey !== "string" || apiKey === "") throw new Error(KEY_REQUIRED);
		if (typeof (ssh2 as { Client?: unknown } | null)?.Client !== "function") throw new Error("options.ssh2 must be the ssh2 package (its Client class): the host installs it, as it does for Agent37 and Morph");
		if (fetcher !== undefined && typeof fetcher !== "function") throw new Error("options.fetch must be a function, as the global fetch is");
		if (Number(rest.daemonUser?.split(":")[0]) === MACHINE_UID) throw new Error(`the daemon user ${rest.daemonUser} is the uid of the machine's own user, whose processes init refuses to run beside; choose another, such as 2510:2510`);
		super(new InstaboxHost({ apiKey, ssh2, ...(fetcher ? { fetch: fetcher } : {}), apiUrl: httpsBase(apiUrl, "the InstaBox API URL") }), { ...rest, maxLifetimeMs });
	}
}
