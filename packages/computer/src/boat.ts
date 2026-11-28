// The boat host: boat sandboxes (https://boat.dev), each a Firecracker microVM with its own kernel in one of boat's EU
// regions (boat picks the region; there is no field for it). The control plane is boat's REST API over fetch
// (https://boat.dev/api/v1, a Bearer key, every answer an { ok, type } envelope; the API reference's OpenAPI). One adapter
// serves boat's general sandbox and its CI-as-compute alike: both are the same sandbox resource here.
//
// Every command (the daemon's upload, its install, init's start, the stdio bridge) goes over SSH through the shared
// SshExec (./hosted/ssh-exec.ts). This provider makes its own ed25519 key, once per host, and hands boat its public half
// (POST /sandboxes/{id}/sshkey); boat answers the login (sshUser "user", passwordless sudo), where to reach the sshd, and
// the sshd's host key, which the handshake pins ("Pin it in known_hosts"). Each command runs under `sudo -n --`, so it
// is root's. boat's REST commands (POST /sandboxes/{id}/commands) take no stdin and end within 600 s, so they cannot
// carry the bridge and are not used. The rest of the computer is the shared machine-host adapter's (./hosted/provider.ts).
//
// Unverified until the live run, each pinned here:
// - unshare -n (init's network none and the egress fence) under the exec user's sudo, in boat's microVM.
// - What GET /sandboxes/{id} answers between a delete's 202 and the end of its deletion operation (cancelled or a 404;
//   the adapter waits for none either way).
// - Whether POST /sandboxes/{id}/sshkey takes a key as soon as the sandbox reads ready.
// - The hostKey answer's form: an OpenSSH "type base64" line, as the docs' known_hosts advice implies.
// - Which of machineIp:22 and sshEndpoint boat means when it answers both: sshEndpoint is used when given.
// - That label values come back byte for byte, an "=" inside a value included, through the label= filter.
// - Ubuntu's sudo with use_pty and no terminal: the command gets the channel's pipes as they are.
// - That an SSH session does not move archiveAfter: the deadline is ttlSeconds alone.
// - The trial's 2 h cap on ttlSeconds (a longer lifetime is boat's 400, invalid).
import { isIP } from "node:net";
import { BOAT, BOAT_IMAGE } from "./descriptors/boat.js";
import { DEADLINE_LABEL, show } from "./drift.js";
import { type HostCall, HostError, type HostFacts, type Machine, type MachineHost, type MachineProcess, type MachineRequest } from "./host.js";
import { networkFormOf } from "./hosted/network.js";
import { orThrow } from "./hosted/process.js";
import { HostedProvider, type HostedOptions, type HostedTimeouts, isoOf, MAX_LABEL } from "./hosted/provider.js";
import { allPages, httpsBase, jsonOf, type Rest, type RestInit, rest } from "./hosted/rest.js";
import { ed25519PublicOf, newEd25519 } from "./hosted/ssh-key.js";
import { pemOf, type Ssh2Module, SshExec, type SshLogin, tcpTunnel } from "./hosted/ssh-exec.js";
import { DOMAIN, dateOf } from "./hosted/values.js";
import type { ComputerSpec, Refusal } from "./provider.js";
import type { ComputerErrorCode } from "./result.js";
import { vendorSdk } from "./vendor-sdk.js";

/** One sandbox as boat answers it (OpenAPI Sandbox), as far as this provider reads it. */
export interface BoatSandbox {
	id: string;
	name?: string;
	state: string;
	labels?: Record<string, string> | null;
	/** Why a sandbox is in error or cancelled, in boat's words. */
	error?: string | null;
	createdAt?: string;
	/** When boat stops the sandbox: now plus ttlSeconds at the create or the last PATCH; null for none. */
	archiveAfter?: string | null;
}

/** The boat provider's options: the key and ssh2, then the shared adapter's (HostedOptions). */
export interface BoatProviderOptions extends Omit<HostedOptions, "kind" | "desktop"> {
	/** The account's API key (boat_...). The caller passes it; this provider never reads it from the environment. */
	apiKey: string;
	/** The ssh2 package: the host's own, or anything with the same slice. */
	ssh2: Ssh2Module;
	/** The fetch every REST call goes through; default the global one. */
	fetch?: typeof fetch;
	/** boat's REST API; default https://boat.dev/api/v1. */
	apiUrl?: string;
	timeouts?: Partial<HostedTimeouts>;
}

/** What create() takes: the provider's options, ssh2 optional (default the host's ssh2 package). */
export interface BoatOptions extends Omit<BoatProviderOptions, "ssh2"> {
	ssh2?: Ssh2Module;
}

export const DEFAULT_API_URL = "https://boat.dev/api/v1";
/** A sandbox id (OpenAPI SandboxId): bx_ and eight of boat's 31 letters and digits. */
const SANDBOX_ID = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
/** Every computer's name starts so (the adapter's names): the listing asks for it, so the account's other sandboxes stay out. */
const NAME_PREFIX = "computer-";
/** ttlSeconds runs 1 to 2592000, 30 days (OpenAPI CreateSandboxRequest). */
const MAX_TTL_S = 2_592_000;
const DAY_MS = 24 * 60 * 60_000;
/** The largest page GET /sandboxes answers, and how many pages a listing reads before it calls the cursor wrong. */
const PAGE = 200;
const MAX_PAGES = 100;
/** boat's sizes (the machine classes of POST /sandboxes `type`): vCPUs and memory in MiB. */
const SIZES = { small: [2, 4_096], default: [4, 8_192], large: [8, 16_384], xlarge: [16, 32_768] } as const;
type Size = keyof typeof SIZES;
/** A saved snapshot's name, and another account's share code: what `from` takes, boat's only images beside its base. */
const SNAPSHOT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SHARE_CODE = /^bsh_[A-Za-z0-9_-]{1,120}$/;
/** A label boat takes: a key of this form, a value of at most 256 bytes, 20 of them (OpenAPI Labels). */
const LABEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,62}$/;
const LABEL_VALUE_BYTES = 256;
/** The login boat answers, a Unix user name. */
const SSH_USER = /^[a-z_][a-z0-9_-]{0,31}$/;
/** The host key types an OpenSSH line names, each with its base64 blob after it. */
const HOST_KEY = /(?:^|\s)(ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) ([A-Za-z0-9+/]+={0,2})(?:\s|$)/;
/** boat's codes that say the account may not have this now: a rate, its plan, its billing, or no machine free. */
const LIMIT_CODES = new Set(["rate_limited", "limit_reached", "IP_RATE_LIMIT_EXCEEDED", "no_ready_machine", "trial_machine_class_not_allowed", "machine_class_plan_required", "billing_required"]);

/** An id held to boat's form before it reaches a URL: not_found else. */
function sandboxId(id: string): string {
	if (!SANDBOX_ID.test(id)) throw new HostError("not_found", `${JSON.stringify(id)} is not a boat sandbox id`);
	return id;
}

/** boat's error envelope: { code, message } at the top, and again under error. */
function errorOf(body: unknown): { code?: string; message?: string } {
	const top = (body ?? {}) as { code?: unknown; message?: unknown; error?: { code?: unknown; message?: unknown } };
	const code = typeof top.code === "string" ? top.code : typeof top.error?.code === "string" ? top.error.code : undefined;
	const message = typeof top.message === "string" ? top.message : typeof top.error?.message === "string" ? top.error.message : undefined;
	return { ...(code ? { code } : {}), ...(message ? { message } : {}) };
}

/** ssh2's refusal of a host key the verifier turned down (lib/protocol/kex.js). */
const hostDenied = (error: unknown): boolean => {
	const { level, message } = (error ?? {}) as { level?: unknown; message?: unknown };
	return level === "handshake" && typeof message === "string" && message.startsWith("Host denied");
};

function codeOf(error: unknown): ComputerErrorCode {
	if (error instanceof HostError) return error.code;
	// ssh2 names the stage that failed (lib/client.js): the sshd refused the login, the handshake timed out, or the
	// sshd's host key is not the one boat answered.
	const { level } = (error ?? {}) as { level?: unknown };
	if (level === "client-authentication" || hostDenied(error)) return "denied";
	if (level === "client-timeout") return "timeout";
	return "vendor";
}

/** boat's states as the adapter's: making is starting, ready and busy are running, an auto-stop is stopped, error and cancelled are gone. */
const STATES: Record<string, Machine["state"]> = {
	init: "starting",
	provisioning: "starting",
	provisioned: "starting",
	cloning: "starting",
	ready: "running",
	idle: "running",
	running: "running",
	archiving: "stopped",
	archived: "stopped",
	error: "gone",
	cancelled: "gone",
};

/** A sandbox as the adapter reads a machine: its state (one this provider does not know is stopped, in words), labels, start and auto-stop. */
function machineOf(sandbox: BoatSandbox): Machine {
	const state = STATES[sandbox.state];
	const why =
		state === undefined
			? `boat reads the state ${show(sandbox.state)}, which this provider does not know`
			: state === "gone"
				? `boat reads the sandbox ${sandbox.state}: ${typeof sandbox.error === "string" && sandbox.error !== "" ? sandbox.error : "no reason given"}`
				: undefined;
	const created = dateOf(sandbox.createdAt);
	const ends = dateOf(sandbox.archiveAfter ?? undefined);
	return {
		id: sandbox.id,
		labels: { ...(sandbox.labels ?? {}) },
		state: state ?? "stopped",
		...(created ? { createdAt: created } : {}),
		...(ends ? { endsAt: ends } : {}),
		...(why === undefined ? {} : { why }),
	};
}

/** The size of a request or spec: by its cpus, else by its memory; undefined when it names neither or one boat lacks. */
function sizeOf(cpus: number | undefined, memoryMb: number | undefined): Size | undefined {
	const sizes = Object.keys(SIZES) as Size[];
	if (cpus !== undefined) return sizes.find((size) => SIZES[size][0] === cpus);
	if (memoryMb !== undefined) return sizes.find((size) => SIZES[size][1] === memoryMb);
	return undefined;
}

const SIZE_WORDS = (Object.entries(SIZES) as [Size, readonly [number, number]][]).map(([size, [cpus, mb]]) => `${size} ${cpus} vCPUs / ${mb / 1024} GiB`).join(", ");

/** Where an sshkey answer says the sshd is: sshEndpoint's host:port when given, else machineIp on port 22. */
function endpointOf(answer: { machineIp?: unknown; sshEndpoint?: unknown }): { host: string; port: number } | undefined {
	const named = typeof answer.sshEndpoint === "string" ? /^(?:\[([^\]]+)\]|([^:[\]]+)):([0-9]{1,5})$/.exec(answer.sshEndpoint) : null;
	const host = named ? (named[1] ?? named[2]) : answer.machineIp;
	const port = named ? Number(named[3]) : 22;
	if (typeof host !== "string" || !(isIP(host) !== 0 || DOMAIN.test(host)) || port < 1 || port > 65_535) return undefined;
	return { host, port };
}

/** The host key of an OpenSSH line: its type and blob, the blob's own type name agreeing; undefined else. */
function hostKeyOf(line: unknown): SshLogin["hostKey"] {
	const found = typeof line === "string" ? HOST_KEY.exec(line) : null;
	if (!found) return undefined;
	const blob = Buffer.from(found[2] as string, "base64");
	const named = blob.length > 4 ? blob.subarray(4, 4 + blob.readUInt32BE(0)).toString("latin1") : "";
	return named === found[1] ? { type: found[1], blob } : undefined;
}

/** A login this host was given for one sandbox: the user, the sshd and its host key. */
interface BoatLogin {
	username: string;
	host: string;
	port: number;
	hostKey: NonNullable<SshLogin["hostKey"]>;
}

/** boat's sandboxes as a MachineHost (../host.ts). */
class BoatHost implements MachineHost {
	readonly descriptor = BOAT;
	readonly facts: HostFacts = {
		daemon: "child",
		// A Firecracker microVM with its own kernel (docs: "How boat works").
		isolation: "vm",
		// ttlSeconds at create, moved by PATCH; boat stops the sandbox at archiveAfter.
		lifetime: "vendor",
		// ttlSeconds' most, 30 days (OpenAPI); the trial's is 2 h (unverified until the live run).
		maxLifetimeMs: 30 * DAY_MS,
		arch: "amd64",
		// The sshd, and boat's agent (commands, snapshots, health) on 8911, which runs as `user` (docs: firewall, "What boat needs").
		vendorAgentPorts: [22, 8911],
		labels: { count: 20 },
	};
	readonly #client: Rest;
	readonly #ssh: SshExec;
	/** This host's own SSH key, a PKCS#8 ed25519 pem made once: its public line goes to boat, never the private half. */
	readonly #privateKey: string;
	readonly #publicLine: string;
	/** Each sandbox's login (POST /sandboxes/{id}/sshkey), asked before its first exec and kept until delete or a refusal. */
	readonly #logins = new Map<string, BoatLogin>();

	constructor(options: { apiKey: string; ssh2: Ssh2Module; fetch: typeof fetch; apiUrl: string }) {
		const { apiKey } = options;
		const pem = newEd25519();
		this.#privateKey = pemOf(pem) as string;
		this.#publicLine = (ed25519PublicOf(pem) as { line: string }).line;
		// A sandbox with no login held logs in with none, which the sshd refuses (denied); exec asks for one first.
		this.#ssh = new SshExec({
			ssh2: options.ssh2,
			sudo: true,
			loginOf: (id) => {
				const login = this.#logins.get(id);
				return { username: login?.username ?? "user", privateKey: this.#privateKey, ...(login ? { hostKey: login.hostKey } : {}), secrets: [apiKey] };
			},
			tunnelOf: (id) => {
				const login = this.#logins.get(id);
				if (login === undefined) throw new HostError("not_found", `no SSH login is held for ${id}`);
				return tcpTunnel(login.host, login.port);
			},
		});
		this.#client = rest({
			base: options.apiUrl,
			headers: () => ({ Authorization: `Bearer ${apiKey}`, Accept: "application/json" }),
			vendor: BOAT.id,
			fetch: options.fetch,
			timeoutMs: 30_000, // every call gives its own: ctx.timeoutMs
			retry: { attempts: 3, baseMs: 500 },
			explain: ({ status, bytes, what }) => {
				const { code, message } = errorOf(jsonOf(bytes));
				return { ...(code !== undefined && LIMIT_CODES.has(code) ? { code: "limit" as const } : {}), message: `${what} answered ${status}${code ? `: ${code}` : ""}${message ? `: ${message}` : ""}` };
			},
		});
	}

	errorCode(error: unknown): ComputerErrorCode {
		return codeOf(error);
	}

	/** One REST call, bounded by ctx: its JSON answer; a failure throws a HostError in boat's words. */
	async #rest<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, init: RestInit, ctx: HostCall): Promise<T> {
		const answer = orThrow(await this.#client.call(method, this.#client.url(path), { timeoutMs: ctx.timeoutMs, ...init }, ctx.signal));
		const parsed = jsonOf(answer.bytes);
		if (parsed === null && method !== "DELETE") throw new HostError("vendor", `${method} ${path} answered ${answer.status} with no JSON body`);
		return parsed as T;
	}

	/**
	 * argv over SSH to the sandbox's sshd (hosted/ssh-exec.ts), as boat's user through sudo -n, so as root. The login is
	 * asked for first when this host has none for the sandbox; a refused login, or an sshd whose host key is not the one
	 * boat answered, lets it go, so the next exec asks again.
	 */
	async exec(id: string, argv: readonly string[], ctx: HostCall): Promise<MachineProcess> {
		sandboxId(id);
		if (!this.#logins.has(id)) this.#logins.set(id, await this.#loginFor(id, ctx));
		try {
			return await this.#ssh.exec(id, argv, ctx);
		} catch (error) {
			if (codeOf(error) === "denied") this.#logins.delete(id);
			if (hostDenied(error)) throw new HostError("denied", `the sshd of ${id} showed a host key other than the one boat answered for it, so nothing ran there`);
			throw error;
		}
	}

	/** POST /sandboxes/{id}/sshkey with this host's public key: the login boat answers, held to its form. */
	async #loginFor(id: string, ctx: HostCall): Promise<BoatLogin> {
		const path = `/sandboxes/${id}/sshkey`;
		const answer = (await this.#rest<{ sshUser?: unknown; machineIp?: unknown; sshEndpoint?: unknown; hostKey?: unknown }>("POST", path, { json: { key: this.#publicLine }, retry: true }, ctx)) ?? {};
		const username = answer.sshUser;
		if (typeof username !== "string" || !SSH_USER.test(username)) throw new HostError("vendor", `POST ${path} answered no SSH user: ${show(username)}`);
		const endpoint = endpointOf(answer);
		if (endpoint === undefined) throw new HostError("vendor", `POST ${path} answered no sshd to reach: machineIp ${show(answer.machineIp)}, sshEndpoint ${show(answer.sshEndpoint)}`);
		const hostKey = hostKeyOf(answer.hostKey);
		if (hostKey === undefined) throw new HostError("vendor", `POST ${path} answered no host key this provider reads (an OpenSSH line, such as ssh-ed25519 AAAA...): ${show(answer.hostKey)}`);
		return { username, ...endpoint, hostKey };
	}

	/**
	 * An image is boat's base (ubuntu-24.04), a snapshot the account saved, by name, or another account's share code
	 * (bsh_...). A size is one of boat's four, by cpus, memoryMb or both. Labels are boat's: keys of its form and values of
	 * at most 256 bytes, the network list's label among them.
	 */
	check(given: Partial<ComputerSpec>): Refusal[] {
		const refusals: Refusal[] = [];
		const { image, cpus, memoryMb, labels, network } = given;
		if (typeof image === "string" && image !== "" && !(image === BOAT_IMAGE || SNAPSHOT_NAME.test(image) || SHARE_CODE.test(image))) {
			refusals.push({ field: "image", message: `an image is boat's base (${BOAT_IMAGE}), the name of a snapshot the key's account saved, such as my-box, or a share code, bsh_...; boat takes no container image` });
		}
		const size = sizeOf(cpus, memoryMb);
		if (cpus !== undefined && size === undefined) refusals.push({ field: "cpus", message: `boat's sizes are ${SIZE_WORDS}: ask for one of their vCPU counts, not ${cpus}` });
		else if (memoryMb !== undefined && (size === undefined || SIZES[size][1] !== memoryMb)) {
			refusals.push({ field: "memoryMb", message: `boat's sizes are ${SIZE_WORDS}: memoryMb must be ${size === undefined ? "one of theirs" : `${SIZES[size][1]} with ${cpus} vCPUs`}, not ${memoryMb}` });
		}
		const entries = typeof labels === "object" && labels !== null ? Object.entries(labels) : [];
		const badKeys = entries.filter(([key]) => !LABEL_KEY.test(key)).map(([key]) => JSON.stringify(key));
		if (badKeys.length > 0) refusals.push({ field: "labels", message: `boat takes a label name of a letter or digit, then up to 62 letters, digits, '.', '_', '/' or '-': not ${badKeys.join(", ")}` });
		const long = entries.filter(([, value]) => typeof value === "string" && Buffer.byteLength(value) > LABEL_VALUE_BYTES).map(([key]) => key);
		if (long.length > 0) refusals.push({ field: "labels", message: `boat takes label values of at most ${LABEL_VALUE_BYTES} bytes: ${long.join(", ")}` });
		let form = "";
		try {
			form = network === undefined ? "" : networkFormOf(network);
		} catch {
			// A network the adapter refuses itself, in its own words.
		}
		if (Buffer.byteLength(form) > LABEL_VALUE_BYTES) refusals.push({ field: "network", message: `boat keeps the network list in a label of at most ${LABEL_VALUE_BYTES} bytes, and this one comes to ${Buffer.byteLength(form)}: name fewer hosts` });
		return refusals;
	}

	/**
	 * POST /sandboxes: the name, the labels as boat's map, the lifetime as ttlSeconds (boat stops the sandbox then), no
	 * account env and no snapshots, with the request's name as the Idempotency-Key, so a create sent again answers the
	 * sandbox it made, and another body under that name is a 409, exists. The size is boat's type: the one the request
	 * names, else small for the base image, else none, so a snapshot starts at its own. req.egress is left: boat's
	 * firewall is not used, so the fence and the egress proxy are ours. The answer comes before the sandbox is ready; the
	 * adapter polls get.
	 */
	async create(req: MachineRequest, ctx: HostCall): Promise<{ id: string }> {
		const size = sizeOf(req.cpus, req.memoryMb) ?? (req.image === BOAT_IMAGE ? "small" : undefined);
		const body = {
			name: req.name,
			labels: req.labels,
			ttlSeconds: Math.min(Math.ceil(req.lifetimeMs / 1000), MAX_TTL_S),
			...(size === undefined ? {} : { type: size }),
			noEnv: true,
			snapshots: false,
			...(req.image === BOAT_IMAGE ? {} : { from: req.image }),
		};
		// Sent again on a 5xx or while boat still runs the first under this key: the key makes the second the first.
		const again = (status: number, bytes: Uint8Array) => status >= 500 || (status === 409 && errorOf(jsonOf(bytes)).code === "idempotency_in_progress");
		const made = await this.#rest<{ sandbox?: { id?: unknown } }>("POST", "/sandboxes", { json: body, headers: { "Idempotency-Key": req.name }, named: true, retry: again }, ctx);
		const id = made?.sandbox?.id;
		if (typeof id !== "string" || !SANDBOX_ID.test(id)) throw new HostError("vendor", `POST /sandboxes answered no sandbox id: ${show(id)}`);
		return { id };
	}

	/** GET /sandboxes/{id}; a 404 (gone, or another account's) is none, and so is an id not of boat's form, with no call. */
	async get(id: string, ctx: HostCall): Promise<Machine | undefined> {
		if (!SANDBOX_ID.test(id)) return undefined;
		try {
			const { sandbox } = await this.#rest<{ sandbox?: BoatSandbox }>("GET", `/sandboxes/${id}`, { retry: true }, ctx);
			if (typeof sandbox?.id !== "string") throw new HostError("vendor", `GET /sandboxes/${id} answered no sandbox`);
			return machineOf(sandbox);
		} catch (error) {
			if (codeOf(error) === "not_found") return undefined;
			throw error;
		}
	}

	/**
	 * GET /sandboxes, every page: the computers' name prefix and each asked label as boat's label=key=value filter. What
	 * comes back is held to the prefix and the labels again here, so a listing that answers more hides nothing and adds
	 * nothing.
	 */
	async list(labels: Record<string, string>, ctx: HostCall): Promise<Machine[]> {
		const asked = Object.entries(labels);
		const found = orThrow(
			await allPages<BoatSandbox>(
				async (cursor) => {
					const query = new URLSearchParams({ namePrefix: NAME_PREFIX, limit: String(PAGE) });
					for (const [key, value] of asked) query.append("label", `${key}=${value}`);
					if (cursor !== undefined) query.set("cursor", cursor);
					const page = await this.#rest<{ sandboxes?: unknown; pageInfo?: { nextCursor?: unknown } }>("GET", `/sandboxes?${query}`, { retry: true }, ctx);
					if (!Array.isArray(page?.sandboxes)) throw new HostError("vendor", "GET /sandboxes answered no sandboxes list");
					const next = page.pageInfo?.nextCursor;
					return { ok: true, value: { items: page.sandboxes as BoatSandbox[], ...(typeof next === "string" && next !== "" ? { next } : {}) } };
				},
				MAX_PAGES,
				{ vendor: BOAT.id, what: "GET /sandboxes" },
			),
		);
		return found
			.filter((sandbox) => typeof sandbox?.id === "string" && SANDBOX_ID.test(sandbox.id) && typeof sandbox.name === "string" && sandbox.name.startsWith(NAME_PREFIX))
			.filter((sandbox) => asked.every(([key, value]) => sandbox.labels?.[key] === value))
			.map(machineOf);
	}

	/**
	 * DELETE /sandboxes/{id} with boat's confirmation header, X-Ascii-Confirm-Delete: the id; its 202 starts a deletion
	 * operation, which the adapter's read-back waits out. A 404 is done, and so is an id not of boat's form. Then this
	 * host's SSH connections to it end.
	 */
	async delete(id: string, ctx: HostCall): Promise<void> {
		if (!SANDBOX_ID.test(id)) return;
		try {
			await this.#rest("DELETE", `/sandboxes/${id}`, { headers: { "X-Ascii-Confirm-Delete": id }, accept: (status) => (status >= 200 && status < 300) || status === 404, retry: true }, { timeoutMs: ctx.timeoutMs });
		} finally {
			this.#ssh.closeAll(id);
			this.#logins.delete(id);
		}
	}

	/**
	 * ttlSeconds moved to endsAt, rounded up to the second and never past the max-deadline label, with the deadline label
	 * to endsAt in the same PATCH. boat's PATCH labels replace them all, so the whole map goes, the rest as it was. The new
	 * deadline is the call's now plus the seconds (OpenAPI UpdateSandboxRequest).
	 */
	async extend(id: string, endsAt: Date, ctx: HostCall): Promise<void> {
		const path = `/sandboxes/${sandboxId(id)}`;
		const { sandbox } = await this.#rest<{ sandbox?: BoatSandbox }>("GET", path, { retry: true }, ctx);
		const labels = { ...(sandbox?.labels ?? {}) };
		const most = isoOf(labels[MAX_LABEL]);
		if (most === undefined) throw new HostError("refused", `${id}'s label ${MAX_LABEL} reads ${show(labels[MAX_LABEL])}, so the most it may live is unknown; nothing moved`);
		const before = Date.now();
		const seconds = Math.min(Math.ceil((endsAt.getTime() - before) / 1000), Math.floor((most.getTime() - before) / 1000), MAX_TTL_S);
		if (seconds < 1) throw new HostError("limit", `no whole number of seconds boat takes moves ${id}'s end to ${endsAt.toISOString()} without passing ${most.toISOString()}; nothing moved`);
		await this.#rest("PATCH", path, { json: { ttlSeconds: seconds, labels: { ...labels, [DEADLINE_LABEL]: endsAt.toISOString() } }, retry: true }, ctx);
	}
}

/**
 * A BoatProvider from its options alone; it reads no environment. The key is options.apiKey, nowhere else (serve passes
 * its BOAT_API_KEY, the conformance module what it reads), and ssh2 is the host's package unless given. Throws in words
 * when an option is missing or wrong, never echoing a key.
 */
export async function create(options: BoatOptions): Promise<BoatProvider> {
	const { ssh2: given, ...rest } = options ?? ({} as BoatOptions);
	// ssh2 is CommonJS: its Client is a named export of the module, and of its default.
	const loaded = given ?? (await vendorSdk<Partial<Ssh2Module> & { default?: Ssh2Module }>(BOAT.label, "ssh2"));
	const ssh2 = typeof loaded.Client === "function" ? (loaded as Ssh2Module) : (loaded as { default?: Ssh2Module }).default;
	return new BoatProvider({ ...rest, ssh2: ssh2 as Ssh2Module });
}

/** The conformance CLI's module for boat: its live switch and the run's cap. */
export const conformance = () => import("./conformance/boat.js");

/** Computers that are boat sandboxes, on the shared adapter. A spec's image is boat's base, a saved snapshot or a share code. */
export class BoatProvider extends HostedProvider {
	constructor(options: BoatProviderOptions) {
		const { apiKey, ssh2, fetch: fetcher = globalThis.fetch, apiUrl = DEFAULT_API_URL, timeouts = {}, ...rest } = options ?? ({} as BoatProviderOptions);
		if (typeof apiKey !== "string" || apiKey === "") throw new Error("options.apiKey, the boat API key, is required: the provider reads no environment, so the caller passes it");
		if (typeof (ssh2 as { Client?: unknown } | null)?.Client !== "function") throw new Error("options.ssh2 must be the ssh2 package (its Client class): the host installs it, as it does for Agent37");
		if (typeof fetcher !== "function") throw new Error("options.fetch must be a function, as the global fetch is");
		super(new BoatHost({ apiKey, ssh2, fetch: fetcher, apiUrl: httpsBase(apiUrl, "the boat API URL") }), { ...rest, timeouts });
	}
}
