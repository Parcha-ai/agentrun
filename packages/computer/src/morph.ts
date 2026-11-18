// The Morph host: Morph Cloud instances, each a VM started from a snapshot (kind linux). The control plane is Morph's
// REST API over fetch (https://cloud.morph.so/api, a Bearer key; OpenAPI https://cloud.morph.so/api/openapi.json). Every
// command (the daemon's upload, its install, init's start, the stdio bridge) goes over SSH through the shared SshExec
// (./hosted/ssh-exec.ts), to Morph's gateway ssh.cloud.morph.so:22 (morph-typescript-sdk src/api.ts:12-13) as the user
// "<instance id>" with the instance's own key pair, which GET /instance/{id}/ssh/key answers over TLS (OpenAPI
// InstanceSshKey: "an ephemeral SSH key for establishing connections", api.ts sshKey()). Both SDKs log in as
// "<instance id>:<API key>" with any key (morph-python-sdk morphcloud/api.py ssh_connect; api.ts:704-711); that is not
// used, since Morph publishes no host key for its gateway, so a host posing as it would read the account's key out of
// the username. A public-key login hands an impostor nothing to reuse: its signature is bound to the session. That the
// gateway takes the instance's key for the user "<instance id>" is **unverified**. Morph's REST exec (POST
// /instance/{id}/exec) answers once the command ends, with no stdin, so it is not used. The rest of the computer is the
// shared machine-host adapter's (./hosted/provider.ts).
//
// Facts the docs do not settle are marked **unverified**; d7/morph-branch-1 (the lane's live kit) settles most of them.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP, connect as tcp } from "node:net";
import { boxRecipeHash } from "./box-image.js";
import { MORPH } from "./descriptors/morph.js";
import { DEADLINE_LABEL, DEFAULT_CPUS, DEFAULT_MEMORY_MB, show } from "./drift.js";
import { proxyFor, tunnelThrough } from "./env-proxy.js";
import { type HostCall, HostError, type HostFacts, type Machine, type MachineHost, type MachineProcess, type MachineRequest } from "./host.js";
import { orThrow, pause, runToExit, uploadThroughExec } from "./hosted/process.js";
import { HostedProvider, type HostedOptions, type HostedTimeouts, isoOf, MAX_LABEL } from "./hosted/provider.js";
import { jsonOf, type Rest, rest } from "./hosted/rest.js";
import { pemOf, type Ssh2Module, SshExec, SshTunnelError, type SshTunnel } from "./hosted/ssh-exec.js";
import { DOMAIN, dateOf, sizeRefusals } from "./hosted/values.js";
import type { CallContext, ComputerSpec, Refusal } from "./provider.js";
import { type ComputerErrorCode, failFor, ok, type Result } from "./result.js";

/** One instance as Morph answers it (OpenAPI InstanceModel), as far as this provider reads it. */
export interface MorphInstance {
	id: string;
	/** pending, ready, paused, saving or error (OpenAPI InstanceStatus). */
	status: string;
	/** Unix seconds. */
	created?: number;
	metadata?: Record<string, string> | null;
	/** ttl_expire_at in Unix seconds; null fields when the instance has no TTL (OpenAPI InstanceTTL). */
	ttl?: { ttl_seconds?: number | null; ttl_expire_at?: number | null; ttl_action?: string | null } | null;
}

/** One snapshot as Morph answers it (OpenAPI SnapshotModel): pending, ready, failed, deleting or deleted. */
interface MorphSnapshot {
	id: string;
	status: string;
	created?: number;
	digest?: string | null;
	metadata?: Record<string, string> | null;
}

/** The Morph provider's options: the key and ssh2, then the shared adapter's (HostedOptions). */
export interface MorphProviderOptions extends Omit<HostedOptions, "kind" | "desktop" | "maxLifetimeMs"> {
	/** The account's API key. The caller passes it; this provider never reads it from the environment. */
	apiKey: string;
	/** The ssh2 package: the host's own, or anything with the same slice. */
	ssh2: Ssh2Module;
	/** The fetch every REST call goes through; default the global one. */
	fetch?: typeof fetch;
	/** Morph's REST API; default https://cloud.morph.so/api. */
	apiUrl?: string;
	/** Morph's SSH gateway; default ssh.cloud.morph.so, port 22. */
	sshHost?: string;
	sshPort?: number;
	/** The longest lifetime check takes: 24 h by default, an assumed cap (Morph states none: unverified). */
	maxLifetimeMs?: number;
	timeouts?: Partial<HostedTimeouts>;
}

/** What create() takes: the provider's options, ssh2 optional (default the host's ssh2 package). */
export interface MorphOptions extends Omit<MorphProviderOptions, "ssh2"> {
	ssh2?: Ssh2Module;
}

/** Not a literal, so no type checker or bundler resolves ssh2 from this package. */
const SSH2_PACKAGE: string = "ssh2";
/** The SDKs' base (api.ts:11 MORPH_BASE_URL) and SSH gateway (api.ts:12-13). */
const DEFAULT_API_URL = "https://cloud.morph.so/api";
const DEFAULT_SSH_HOST = "ssh.cloud.morph.so";
const DEFAULT_SSH_PORT = 22;
/** An instance id as it reaches a URL and the SSH username, whose ":" ends it. Morph's form, morphvm_<...>, is unverified. */
const INSTANCE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A snapshot id, "like snapshot_xxxx" (OpenAPI SnapshotModel.id). */
const SNAPSHOT_ID = /^snapshot_[A-Za-z0-9_-]{1,120}$/;
const DAY_MS = 24 * 60 * 60_000;
/** The image every box snapshot starts from: the default of CreateSnapshotRequest.image_id (OpenAPI). */
const BASE_IMAGE = "morphvm-minimal";
/** The box snapshot's size, which is every computer's (a start takes no size): the adapter's default, and 16 GiB of disk. */
const BOX_SIZE = { vcpus: DEFAULT_CPUS, memory: DEFAULT_MEMORY_MB, disk_size: 16_384 };
/** The label of a build's own instance and base snapshot, its value the box image's name. */
const BUILD_LABEL = "agentrun-box-build";
/** A build (boot, install.sh, snapshot), all of it; and the TTL of its instance, so a build left by a crash ends. */
const BUILD_MS = 45 * 60_000;
const BUILD_TTL_S = 2 * 60 * 60;
/**
 * One REST call of the build that answers at once, and the pause between two reads of something Morph is making. A
 * create that answers only once its snapshot is made has the build's remaining time instead (see boxSnapshot).
 */
const BUILD_CALL_MS = 60_000;
const POLL_MS = 1_000;
/** How far /ttl's read-back end may sit from the call's now plus its seconds, Morph's rounding and the call's transit aside. */
const TTL_SLACK_MS = 2_000;
const RECIPE_FILES = ["install.sh", "agentrun-archil"] as const;

/** An id held to the form above before it reaches a URL or the SSH username: not_found else. */
function instanceId(id: string): string {
	if (!INSTANCE_ID.test(id)) throw new HostError("not_found", `${JSON.stringify(id)} is not a Morph instance id`);
	return id;
}

/** Morph's error body, FastAPI's: { detail: "<words>" } or { detail: [{ msg }] }, with error_code on snapshot routes (OpenAPI SnapshotWriterError). */
function detailOf(body: unknown): string {
	const { detail, error_code: code } = (body ?? {}) as { detail?: unknown; error_code?: unknown };
	const said = typeof detail === "string" ? detail : Array.isArray(detail) ? detail.map((one) => (one as { msg?: unknown })?.msg).filter((msg) => typeof msg === "string").join("; ") : "";
	return [typeof code === "string" ? code : "", said].filter(Boolean).join(": ");
}

function codeOf(error: unknown): ComputerErrorCode {
	if (error instanceof HostError) return error.code;
	// ssh2 names the stage that failed (lib/client.js): the gateway refused the login, or the handshake timed out.
	const { level } = (error ?? {}) as { level?: unknown };
	if (level === "client-authentication") return "denied";
	if (level === "client-timeout") return "timeout";
	return "vendor";
}

/** Morph's statuses (OpenAPI InstanceStatus) as the adapter's states: saving is a snapshot in progress, error is gone. */
function stateOf(status: string): Machine["state"] | undefined {
	if (status === "ready") return "running";
	if (status === "pending" || status === "saving") return "starting";
	if (status === "paused") return "stopped";
	if (status === "error") return "gone";
	return undefined;
}

/** An instance as the adapter reads a machine: its state (one this provider does not know is gone, in words), labels, start and TTL's end. */
function machineOf(instance: MorphInstance): Machine {
	const state = stateOf(instance.status);
	const why = state === undefined ? `Morph reads the status ${show(instance.status)}, which this provider does not know` : instance.status === "error" ? "Morph reads the instance in error, with no reason given" : undefined;
	const created = dateOf(instance.created, "s");
	const ends = dateOf(instance.ttl?.ttl_expire_at ?? undefined, "s");
	return {
		id: instance.id,
		labels: { ...(instance.metadata ?? {}) },
		state: state ?? "gone",
		...(created ? { createdAt: created } : {}),
		...(ends ? { endsAt: ends } : {}),
		...(why === undefined ? {} : { why }),
	};
}

/** Morph's instances as a MachineHost (../host.ts). */
class MorphHost implements MachineHost {
	readonly descriptor = MORPH;
	readonly facts: HostFacts = {
		daemon: "child",
		// A VM (docs: concepts/mental-model); the hypervisor is not named.
		isolation: "vm",
		// ttl_seconds with ttl_action stop at create, moved by POST /instance/{id}/ttl (docs: documentation/instances/ttl).
		lifetime: "vendor",
		// Morph states no cap: the janitor's, unverified.
		maxLifetimeMs: DAY_MS,
		// Unverified: no arch in the OpenAPI.
		arch: "amd64",
		// The guest's sshd behind the gateway, unverified: the docs name no port inside the VM.
		vendorAgentPorts: [22],
	};
	readonly #client: Rest;
	readonly #ssh: SshExec;
	readonly #sshHost: string;
	readonly #sshPort: number;
	/** Each instance's SSH private key (GET /instance/{id}/ssh/key), read before its first exec and kept until delete or a refused login. */
	readonly #keys = new Map<string, string>();

	constructor(options: { apiKey: string; ssh2: Ssh2Module; fetch: typeof fetch; apiUrl: string; sshHost: string; sshPort: number }) {
		const { apiKey } = options;
		this.#sshHost = options.sshHost;
		this.#sshPort = options.sshPort;
		// The user is the instance id alone and the key is the instance's: the account's key never goes over SSH. An
		// instance whose key was let go logs in with none, which the gateway refuses (denied).
		this.#ssh = new SshExec({ ssh2: options.ssh2, loginOf: (id) => ({ username: id, ...(this.#keys.has(id) ? { privateKey: this.#keys.get(id) } : {}), secrets: [apiKey] }), tunnelOf: () => this.#tunnel() });
		this.#client = rest({
			base: options.apiUrl,
			headers: () => ({ Authorization: `Bearer ${apiKey}`, Accept: "application/json" }),
			vendor: "morph",
			fetch: options.fetch,
			timeoutMs: 30_000, // every call gives its own: ctx.timeoutMs
			explain: ({ status, bytes, what }) => {
				const said = detailOf(jsonOf(bytes));
				// 503 is an admission refusal before dispatch (OpenAPI: "Snapshot admission busy", Retry-After: 1).
				return { ...(status === 503 ? { code: "limit" as const } : {}), message: `${what} answered ${status}${said ? `: ${said}` : ""}` };
			},
		});
	}

	errorCode(error: unknown): ComputerErrorCode {
		return codeOf(error);
	}

	/**
	 * A TCP connection to the gateway, through the proxy's CONNECT tunnel when the proxy variables name one for it
	 * (env-proxy.ts). No host key is pinned: Morph publishes none, and both SDKs take any (paramiko's AutoAddPolicy). The
	 * login is a public key, so a host posing as the gateway learns no credential.
	 */
	#tunnel(): SshTunnel {
		const host = `${this.#sshHost}:${this.#sshPort}`;
		const name = isIP(this.#sshHost) === 6 ? `[${this.#sshHost}]` : this.#sshHost;
		const proxy = proxyFor(new URL(`https://${name}:${this.#sshPort}`));
		const through = proxy && tunnelThrough(proxy, name, this.#sshPort);
		const socket = through ? through.socket : tcp(this.#sshPort, this.#sshHost);
		// ssh2 reads the socket's errors once it has it; this keeps one before then from being thrown.
		socket.on("error", () => {});
		const failed = (error: Error) => new SshTunnelError(`the SSH connection to ${host}${proxy ? ` through the proxy ${proxy.host}` : ""} failed to open: ${error.message}`);
		const opened = through
			? through.opened.catch((error: Error) => Promise.reject(failed(error)))
			: new Promise<void>((resolve, reject) => {
					socket.once("connect", resolve);
					socket.once("error", (error) => reject(failed(error)));
				});
		opened.catch(() => {});
		return { duplex: socket, opened, host };
	}

	/**
	 * argv over SSH through the gateway (hosted/ssh-exec.ts), as the user it lands as: root, unverified. The instance's
	 * key is read first when this host has none for it; a refused login lets it go, so the next exec reads it again (a
	 * key rotated in the account).
	 */
	async exec(id: string, argv: readonly string[], ctx: HostCall): Promise<MachineProcess> {
		instanceId(id);
		if (!this.#keys.has(id)) this.#keys.set(id, await this.#keyOf(id, ctx));
		try {
			return await this.#ssh.exec(id, argv, ctx);
		} catch (error) {
			if (codeOf(error) === "denied") this.#keys.delete(id);
			throw error;
		}
	}

	/**
	 * GET /instance/{id}/ssh/key (OpenAPI InstanceSshKey): its private key, in a form ssh2 reads. Morph answers PKCS#8
	 * (the PEM label "PRIVATE KEY"; d7/morph-live-2's ssh2 refused it), which pemOf converts. The answer's password and
	 * token are not kept.
	 */
	async #keyOf(id: string, ctx: HostCall): Promise<string> {
		const { private_key: given } = (await this.#rest<{ private_key?: unknown }>("GET", `/instance/${id}/ssh/key`, undefined, ctx)) ?? {};
		const key = typeof given === "string" ? pemOf(given) : undefined;
		if (key === undefined) throw new HostError("vendor", `GET /instance/${id}/ssh/key answered no private key ssh2 can read (PEM: OpenSSH, PKCS#1, SEC1, or PKCS#8 RSA, EC or Ed25519)`);
		return key;
	}

	/** One REST call, bounded by ctx: its JSON answer; a failure throws a HostError in Morph's words. */
	async #rest<T>(method: "GET" | "POST" | "DELETE", path: string, body: object | undefined, ctx: HostCall): Promise<T> {
		const answer = orThrow(await this.#client.call(method, this.#client.url(path), { ...(body === undefined ? {} : { json: body }), timeoutMs: ctx.timeoutMs }, ctx.signal));
		const parsed = jsonOf(answer.bytes);
		if (parsed === null && method !== "DELETE") throw new HostError("vendor", `${method} ${path} answered ${answer.status} with no JSON body`);
		return parsed as T;
	}

	/** A Morph image is a snapshot id in the key's account; a size is the snapshot's, so cpus and memoryMb are refused. */
	check(given: Partial<ComputerSpec>): Refusal[] {
		const refusals = sizeRefusals(given, "a Morph computer", "snapshot");
		if (typeof given.image === "string" && given.image !== "" && !SNAPSHOT_ID.test(given.image)) {
			refusals.push({ field: "image", message: "an image is the id of a Morph snapshot in the key's account, such as snapshot_abc123: the box snapshot prepareImage() builds, or one of your own" });
		}
		return refusals;
	}

	/**
	 * POST /instance (OpenAPI StartInstanceRequest): the snapshot, the labels as metadata, which carry the request's name
	 * (Morph has no name field and no idempotency key), and the lifetime as a TTL whose action is stop, which releases
	 * the instance (docs: documentation/instances/ttl). req.egress is left: Morph has no egress control, so the fence and
	 * the egress proxy are ours. The answer comes before the instance is ready; the adapter polls get.
	 */
	async create(req: MachineRequest, ctx: HostCall): Promise<{ id: string }> {
		const made = await this.#rest<MorphInstance>("POST", "/instance", { snapshot_id: req.image, metadata: req.labels, ttl_seconds: Math.ceil(req.lifetimeMs / 1000), ttl_action: "stop" }, ctx);
		if (typeof made?.id !== "string" || !INSTANCE_ID.test(made.id)) throw new HostError("vendor", `POST /instance answered no instance id: ${show(made?.id)}`);
		return { id: made.id };
	}

	/** GET /instance/{id}; a 404 is not_found, which the adapter reads as none. What Morph answers for a deleted one is unverified. */
	async get(id: string, ctx: HostCall): Promise<Machine | undefined> {
		return machineOf(await this.#rest<MorphInstance>("GET", `/instance/${instanceId(id)}`, undefined, ctx));
	}

	/**
	 * GET /instance, the account's every instance in one answer (OpenAPI InstanceModelCollection, no page fields): the
	 * adapter matches the labels. Its metadata[...] filter is not used: whether a dotted key like agentrun.computer
	 * survives its deepObject query is unverified, and a filter misread would hide machines.
	 */
	async list(labels: Record<string, string>, ctx: HostCall): Promise<Machine[]> {
		void labels;
		const listed = await this.#rest<{ data?: unknown }>("GET", "/instance", undefined, ctx);
		if (!Array.isArray(listed?.data)) throw new HostError("vendor", "GET /instance answered no data list");
		return (listed.data as MorphInstance[]).filter((instance) => typeof instance?.id === "string").map(machineOf);
	}

	/** DELETE /instance/{id}, "Stop and delete" (OpenAPI); a 404 is done. Then this host's SSH connections to it end. */
	async delete(id: string, ctx: HostCall): Promise<void> {
		try {
			await this.#rest("DELETE", `/instance/${instanceId(id)}`, undefined, { timeoutMs: ctx.timeoutMs });
		} finally {
			this.#ssh.closeAll(id);
			this.#keys.delete(id);
		}
	}

	/**
	 * The TTL moved to endsAt, rounded up to the second and never past the max-deadline label (POST /instance/{id}/ttl),
	 * then the deadline label to endsAt with the rest of the metadata as it was (POST /instance/{id}/metadata, whose
	 * merge-or-replace is unverified: the whole map is sent). Whether ttl_seconds counts from now is unverified, so the
	 * end /ttl answers is held to now plus the seconds: an end elsewhere throws, and the label is not moved.
	 */
	async extend(id: string, endsAt: Date, ctx: HostCall): Promise<void> {
		const path = `/instance/${instanceId(id)}`;
		const { metadata } = await this.#rest<MorphInstance>("GET", path, undefined, ctx);
		const labels = { ...(metadata ?? {}) };
		const most = isoOf(labels[MAX_LABEL]);
		if (most === undefined) throw new HostError("refused", `${id}'s label ${MAX_LABEL} reads ${show(labels[MAX_LABEL])}, so the most it may live is unknown; nothing moved`);
		const before = Date.now();
		const seconds = Math.min(Math.ceil((endsAt.getTime() - before) / 1000), Math.floor((most.getTime() - before) / 1000));
		if (seconds < 1) throw new HostError("limit", `no whole number of seconds Morph takes moves ${id}'s end to ${endsAt.toISOString()} without passing ${most.toISOString()}; nothing moved`);
		const moved = await this.#rest<MorphInstance>("POST", `${path}/ttl`, { ttl_seconds: seconds, ttl_action: "stop" }, ctx);
		const at = (moved?.ttl?.ttl_expire_at ?? Number.NaN) * 1000;
		if (!(at >= before + seconds * 1000 - TTL_SLACK_MS && at <= Date.now() + seconds * 1000 + TTL_SLACK_MS)) {
			throw new HostError("vendor", `Morph was asked for a TTL of ${seconds} s on ${id} and reads its end back as ${show(moved?.ttl?.ttl_expire_at)}, not about ${Math.round(before / 1000) + seconds} (Unix s): its TTL does not count from the call, as this provider takes it to`);
		}
		await this.#rest("POST", `${path}/metadata`, { ...labels, [DEADLINE_LABEL]: endsAt.toISOString() }, ctx);
	}

	/** Reads until done answers a value, a pause between reads, until end or signal: a timeout or an abort in words. */
	async #until<T>(what: string, end: number, signal: AbortSignal | undefined, done: () => Promise<T | undefined>): Promise<T> {
		for (;;) {
			const value = await done();
			if (value !== undefined) return value;
			if (signal?.aborted) throw new HostError("aborted", `the wait for ${what} was aborted`);
			if (Date.now() > end) throw new HostError("timeout", `${what} was not ready within ${BUILD_MS / 60_000} minutes`);
			await pause(POLL_MS, signal);
		}
	}

	/** Snapshot id once Morph reads it ready; failed or gone throws in words. */
	#snapshotReady(id: string, end: number, signal: AbortSignal | undefined): Promise<string> {
		return this.#until(`the Morph snapshot ${id}`, end, signal, async () => {
			const { status } = await this.#rest<MorphSnapshot>("GET", `/snapshot/${id}`, undefined, { timeoutMs: BUILD_CALL_MS, ...(signal ? { signal } : {}) });
			if (status === "ready") return id;
			if (status !== "pending") throw new HostError("vendor", `the Morph snapshot ${id} is ${show(status)}, not ready`);
			return undefined;
		});
	}

	/**
	 * The box snapshot of this name (its digest), oldest first: a ready one, or one being made, waited for. One that
	 * failed, with none other, throws in words. undefined when the account has none.
	 */
	async #boxOf(name: string, end: number, signal: AbortSignal | undefined): Promise<string | undefined> {
		const listed = await this.#rest<{ data?: unknown }>("GET", `/snapshot?digest=${encodeURIComponent(name)}`, undefined, { timeoutMs: BUILD_CALL_MS, ...(signal ? { signal } : {}) });
		const snapshots = (Array.isArray(listed?.data) ? (listed.data as MorphSnapshot[]) : []).filter((one) => one?.digest === name && SNAPSHOT_ID.test(one.id)).sort((a, b) => (a.created ?? 0) - (b.created ?? 0));
		const usable = snapshots.find((one) => one.status === "ready") ?? snapshots.find((one) => one.status === "pending");
		if (usable !== undefined) return this.#snapshotReady(usable.id, end, signal);
		const failed = snapshots.find((one) => one.status === "failed");
		if (failed !== undefined) throw new HostError("vendor", `the Morph snapshot ${failed.id} of ${name} failed: delete it in the account, then call again`);
		return undefined;
	}

	/**
	 * A base snapshot of this name already in the account, by its label (metadata agentrun-box-build=<name>): the oldest
	 * ready one, else the oldest pending one (the caller waits for it); every failed one is deleted first. undefined when
	 * there is none. The list's metadata[...] filter was proven on GET /instance (d7/morph-branch-3, step 6, hyphenated
	 * and dotted keys); on GET /snapshot it is unverified, so the answer is matched by the label again here.
	 */
	async #baseOf(name: string, call: HostCall): Promise<string | undefined> {
		const listed = await this.#rest<{ data?: unknown }>("GET", `/snapshot?${encodeURIComponent(`metadata[${BUILD_LABEL}]`)}=${encodeURIComponent(name)}`, undefined, call);
		const bases = (Array.isArray(listed?.data) ? (listed.data as MorphSnapshot[]) : []).filter((one) => one?.metadata?.[BUILD_LABEL] === name && SNAPSHOT_ID.test(one.id)).sort((a, b) => (a.created ?? 0) - (b.created ?? 0));
		// Another build may have deleted it first: its 404 is done.
		for (const failed of bases.filter((one) => one.status === "failed")) {
			await this.#rest("DELETE", `/snapshot/${failed.id}`, undefined, call).catch((error) => {
				if (codeOf(error) !== "not_found") throw error;
			});
		}
		return (bases.find((one) => one.status === "ready") ?? bases.find((one) => one.status === "pending"))?.id;
	}

	/**
	 * A new base snapshot (POST /snapshot from morphvm-minimal at BOX_SIZE, labelled), its id. Morph answers only once the
	 * snapshot is made: 78 s from the POST to ready at 1 vCPU / 2 GiB / 8 GiB of disk (d7/morph-branch-3), past the 60 s
	 * of one call (d7/morph-live-1 timed out there while Morph went on and made it), and no size is known to be faster. So
	 * the call has the build's remaining time. An answer that is lost all the same (a timeout, a dropped connection, a 5xx
	 * after the send) may still have made it: the account is looked at again by the label, and one found is the base. That
	 * look takes no cancel signal, like the create, so a cancelled build still holds the id and its finally deletes it.
	 * With none found the create's failure is thrown, and the next build finds the base by its label once Morph lists it.
	 */
	async #newBase(name: string, end: number): Promise<string> {
		let made: MorphSnapshot;
		try {
			made = await this.#rest<MorphSnapshot>("POST", "/snapshot", { image_id: BASE_IMAGE, ...BOX_SIZE, metadata: { [BUILD_LABEL]: name } }, { timeoutMs: Math.max(1, end - Date.now()) });
		} catch (error) {
			const found = await this.#baseOf(name, { timeoutMs: BUILD_CALL_MS });
			if (found === undefined) throw error;
			return found;
		}
		if (typeof made?.id !== "string" || !SNAPSHOT_ID.test(made.id)) throw new HostError("vendor", `POST /snapshot answered no snapshot id: ${show(made?.id)}`);
		return made.id;
	}

	/**
	 * The box image as a Morph snapshot in the key's account, its digest the name (agentrun-box-<recipe hash>): found, or
	 * built once (`building` told first), as PROVIDERS.md's account-built image says. A build makes a base snapshot of
	 * morphvm-minimal at BOX_SIZE (POST /snapshot), starts an instance from it (POST /instance), runs box/install.sh as
	 * root over SSH, and snapshots the instance with the digest (POST /instance/{id}/snapshot, synchronous by default),
	 * with no TTL, so it never expires (OpenAPI SnapshotModel.ttl). The instance is deleted after, and has a TTL of its
	 * own besides. The base snapshot is kept once the box snapshot is asked for, with no TTL: whether a snapshot still needs
	 * the one its instance started from is unverified. A build that fails before then deletes its base, so repeated
	 * failures leave nothing. install.sh needs apt (morphvm-minimal's distro is unverified) and root.
	 *
	 * The base is labelled (BUILD_LABEL), and a build looks for one by the label before it makes one (#baseOf): a base an
	 * earlier build left (a create whose answer was lost) is used, or waited for, and a failed one is deleted. Two servers
	 * building the same recipe at once: when both look before either base is listed, each makes one and builds on it, both
	 * bases are kept once their box snapshots are asked for, and every caller answers the oldest box snapshot (#boxOf).
	 * When the second looks after the first's base is listed, both build on that one base; a build that fails deletes it,
	 * so the other's fails too and is called again.
	 */
	async boxSnapshot(name: string, building: () => void, signal: AbortSignal | undefined): Promise<string> {
		const end = Date.now() + BUILD_MS;
		const call = { timeoutMs: BUILD_CALL_MS, ...(signal ? { signal } : {}) };
		const found = await this.#boxOf(name, end, signal);
		if (found !== undefined) return found;
		building();
		// The two creates are never signalled, only bounded: a cancel mid-call would lose the id of what Morph made, and the
		// base snapshot has no TTL. A cancel is answered once the id is held, so the finally below deletes what was made.
		const notCancelled = (what: string) => {
			if (signal?.aborted) throw new HostError("aborted", `the box build was aborted after ${what}`);
		};
		const base = (await this.#baseOf(name, call)) ?? (await this.#newBase(name, end));
		// Set once the box snapshot is asked for: from then on it may need the base, which is kept.
		let snapshotted = false;
		let vm: string | undefined;
		try {
			notCancelled(`its base snapshot ${base} was made`);
			await this.#snapshotReady(base, end, signal);
			vm = instanceId((await this.#rest<MorphInstance>("POST", "/instance", { snapshot_id: base, metadata: { [BUILD_LABEL]: name }, ttl_seconds: BUILD_TTL_S, ttl_action: "stop" }, { timeoutMs: BUILD_CALL_MS })).id);
			notCancelled(`its instance ${vm} was made`);
			await this.#build(vm, name, end, signal, call, () => (snapshotted = true));
		} finally {
			// Their own bound, not the caller's signal: a cancelled build still deletes its instance (its TTL backs this),
			// and a build that never asked for the box snapshot deletes its base too, so a failing build leaves nothing.
			if (vm !== undefined) await this.delete(vm, { timeoutMs: BUILD_CALL_MS }).catch(() => {});
			if (!snapshotted) await this.#rest("DELETE", `/snapshot/${base}`, undefined, { timeoutMs: BUILD_CALL_MS }).catch(() => {});
		}
		// Another server's build of the same recipe may have finished first: every caller answers the oldest.
		const box = await this.#boxOf(name, end, signal);
		if (box === undefined) throw new HostError("vendor", `the box snapshot ${name} was made, then not listed by its digest`);
		return box;
	}

	/** The build on its running instance vm: install.sh as root over SSH, then the box snapshot by digest (asking() told first). */
	async #build(vm: string, name: string, end: number, signal: AbortSignal | undefined, call: HostCall, asking: () => void): Promise<void> {
		await this.#until(`the build instance ${vm}`, end, signal, async () => {
			const { state, why } = machineOf(await this.#rest<MorphInstance>("GET", `/instance/${vm}`, undefined, call));
			if (state === "gone") throw new HostError("vendor", `the build instance ${vm} is gone: ${why ?? "no reason given"}`);
			return state === "running" ? true : undefined;
		});
		const run = async (argv: string[], what: string) => {
			const ran = orThrow(await runToExit(this, vm, argv, { ms: Math.max(1, end - Date.now()), ...(signal ? { signal } : {}), what }));
			if (ran.exitCode !== 0) throw new HostError("vendor", `${what} exited with ${ran.exitCode}: ${`${ran.stderr} ${ran.stdout}`.trim().slice(-300)}`);
		};
		await run(["mkdir", "-p", "/tmp/agentrun-box"], "the build folder's mkdir");
		for (const file of RECIPE_FILES) orThrow(await uploadThroughExec(this, vm, `/tmp/agentrun-box/${file}`, await readFile(new URL(`../box/${file}`, import.meta.url)), BUILD_CALL_MS, signal));
		await run(["sh", "-c", "sh /tmp/agentrun-box/install.sh && rm -rf /tmp/agentrun-box"], "box/install.sh");
		asking();
		const made = await this.#rest<MorphSnapshot>("POST", `/instance/${vm}/snapshot`, { digest: name, metadata: { "agentrun-box": name } }, { ...call, timeoutMs: Math.max(1, end - Date.now()) });
		await this.#snapshotReady(made.id, end, signal);
	}
}

/**
 * A MorphProvider from its options alone; it reads no environment. The key is options.apiKey, nowhere else (serve passes
 * its MORPH_API_KEY, the conformance module what it reads), and ssh2 is the host's package unless given. Throws in words
 * when an option is missing or wrong, never echoing a key.
 */
export async function create(options: MorphOptions): Promise<MorphProvider> {
	const { ssh2: given, ...rest } = options ?? ({} as MorphOptions);
	// ssh2 is CommonJS: its Client is a named export of the module, and of its default.
	const loaded = given ?? ((await import(SSH2_PACKAGE)) as Partial<Ssh2Module> & { default?: Ssh2Module });
	const ssh2 = typeof loaded.Client === "function" ? (loaded as Ssh2Module) : (loaded as { default?: Ssh2Module }).default;
	return new MorphProvider({ ...rest, ssh2: ssh2 as Ssh2Module });
}

/** The conformance CLI's module for Morph: its live switch, the run's cap, its snapshot and the drifted twin. */
export const conformance = () => import("./conformance/morph.js");

const fail = failFor(MORPH.id);

/**
 * Computers that are Morph instances, on the shared adapter. A spec's image is a Morph snapshot id. A server starts
 * every one from the snapshot prepareImage() answers: our box image, built once in the key's own account.
 */
export class MorphProvider extends HostedProvider {
	/**
	 * The provider contract's prepareImage (its descriptor declares it): the box image as a snapshot of the key's
	 * account, its digest agentrun-box-<recipe hash>, found or built (MorphHost.boxSnapshot), so a new recipe is a new
	 * snapshot. ok with the snapshot's id; onWait is told "build" once, before a build, never when the account has one.
	 */
	async prepareImage(context: CallContext & { onWait?: (making: "build" | "pull", tag: string) => void } = {}): Promise<Result<string>> {
		const name = `agentrun-box-${boxRecipeHash()}`;
		try {
			return ok(await (this.host as MorphHost).boxSnapshot(name, () => context.onWait?.("build", name), context.signal));
		} catch (error) {
			return fail(codeOf(error), `the box image ${name} as a Morph snapshot: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	constructor(options: MorphProviderOptions) {
		const { apiKey, ssh2, fetch: fetcher = globalThis.fetch, apiUrl = DEFAULT_API_URL, sshHost = DEFAULT_SSH_HOST, sshPort = DEFAULT_SSH_PORT, timeouts = {}, ...rest } = options ?? ({} as MorphProviderOptions);
		if (typeof apiKey !== "string" || apiKey === "") throw new Error("options.apiKey, the Morph API key, is required: the provider reads no environment, so the caller passes it");
		if (typeof (ssh2 as { Client?: unknown } | null)?.Client !== "function") throw new Error("options.ssh2 must be the ssh2 package (its Client class): the host installs it, as it does for Agent37");
		if (typeof fetcher !== "function") throw new Error("options.fetch must be a function, as the global fetch is");
		let api: URL;
		try {
			api = new URL(apiUrl);
		} catch {
			throw new Error(`apiUrl must be an https URL such as ${DEFAULT_API_URL}, not ${JSON.stringify(apiUrl)}`);
		}
		if (api.protocol !== "https:" || api.search !== "" || api.hash !== "") throw new Error(`apiUrl must be an https URL such as ${DEFAULT_API_URL}, not ${JSON.stringify(apiUrl)}`);
		if (typeof sshHost !== "string" || !(DOMAIN.test(sshHost) || isIP(sshHost) !== 0)) throw new Error(`sshHost must be a host name such as ${DEFAULT_SSH_HOST}, not ${JSON.stringify(sshHost)}`);
		if (!Number.isSafeInteger(sshPort) || sshPort < 1 || sshPort > 65_535) throw new Error(`sshPort must be a TCP port, not ${JSON.stringify(sshPort)}`);
		super(new MorphHost({ apiKey, ssh2, fetch: fetcher, apiUrl: api.href.replace(/\/+$/, ""), sshHost, sshPort }), { ...rest, timeouts });
	}
}

/** The account a key reaches, in words, for the sweep's scope: the key's sha256 prefix, never the key. */
export function accountOf(apiKey: string, apiUrl: string = DEFAULT_API_URL): string {
	return `the Morph account of the key sha256:${createHash("sha256").update(apiKey, "utf8").digest("hex").slice(0, 12)} at ${apiUrl.replace(/\/+$/, "")}`;
}
