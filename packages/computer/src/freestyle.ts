// The Freestyle host: a Linux sandbox on a Freestyle VM, over Freestyle's REST API (https://api.freestyle.sh/v5, a
// Bearer API key). Sources: O = the OpenAPI (https://api.freestyle.sh/openapi.json), D = the docs
// (https://www.freestyle.sh/docs), S = the freestyle npm package 0.2.24 (its src/). A VM is made, read by id, listed by
// metadata and deleted over REST. Freestyle runs a command in a VM through exec-await, answered once the command has ended
// with its whole output (O ExecRequest, ExecResponse), whose stdin is given whole: no live stream, so no stdio bridge.
// Its SSH gateway takes a token in the username and publishes no host key, so a login there can't be pinned (D vms/ssh,
// S cli/ssh.ts). So this host has no exec: its VMs dial the server (facts.connect "dial"). A VM boots a snapshot of the
// box image in the key's account, which holds agentrun-dial; Freestyle's API names no env and no command a VM runs at its
// start (O CreateVmRequest), so create waits for the VM to run and starts agentrun-dial itself, in one exec-await as root
// that detaches it (setsid), with MachineRequest.boot.env as that command's env: the token is never written in the VM.
// The labels are packed into the VM's metadata (64 entries, keys and values at most 63 characters: O
// CreateVmRequest.metadata). A VM's ttlSeconds, deleted by Freestyle's periodic sweep (D vms/lifecycle), is set at create
// to the request's backstop, and the janitor ends it at its deadline; it is ephemeral (autoDeleteSeconds 0: deleted the
// moment it stops) and never booted again after a crash (automaticRestart false), with no idle pause.
//
// Unverified until the live run: exec-await's env reaches its command, run by the guest's shell as root, and a process it
// detached with setsid lives on after the call; a call that asks no background request (no
// x-freestyle-background-after-secs) is answered inline, never 202; a create of a slug the account holds answers 409, and
// a 409 whose slug get finds no VM under is no capacity; a deleted VM reads 404; the metadata filter matches every pair
// asked; metadata keys take the packed names; the VM is amd64, its own kernel's, where root makes network namespaces; the
// public-egress rule lets the VM resolve names; the box image builds on Freestyle's Ubuntu 24.04 base.
import { createHash } from "node:crypto";
import { boxRecipeHash } from "./box-image.js";
import { FREESTYLE } from "./descriptors/freestyle.js";
import { show } from "./drift.js";
import { type HostCall, HostError, type HostFacts, type Machine, type MachineHost, type MachineRequest } from "./host.js";
import { orThrow, pause, seconds } from "./hosted/process.js";
import { HostedProvider, type HostedOptions, type HostedTimeouts, mayHaveMade, timeoutsOf } from "./hosted/provider.js";
import { allPages, httpsBase, jsonOf, type Rest, type RestInit, rest } from "./hosted/rest.js";
import { dialLaunch } from "./hosted/scripts.js";
import { dateOf, isWhole, sizeRefusals } from "./hosted/values.js";
import type { ComputerResources, ComputerSpec, Refusal } from "./provider.js";
import { type ComputerErrorCode, ok, type Result } from "./result.js";

/** A VM as Freestyle answers one (O Vm), as far as this host reads it. */
interface FreestyleVm {
	id: string;
	state?: string;
	slug?: string | null;
	metadata?: Record<string, string> | null;
	createdAt?: string;
	resources?: { cpu?: number; memory?: number; storage?: number } | null;
}

/** What exec-await answers once its command has ended (O ExecResponse): statusCode is absent where its timeout killed it. */
interface ExecAnswer {
	stdout: string;
	stderr: string;
	exit: number;
}

/** The Freestyle provider's options: the key, then the shared adapter's (HostedOptions). */
export interface FreestyleProviderOptions extends Omit<HostedOptions, "kind" | "desktop"> {
	/** The account's API key. The caller passes it; this provider never reads it from the environment. */
	apiKey: string;
	/** The fetch every call goes through; default the global one. */
	fetch?: typeof fetch;
	/** The API's root; default https://api.freestyle.sh. */
	apiUrl?: string;
	timeouts?: Partial<HostedTimeouts>;
}

export const DEFAULT_API_URL = "https://api.freestyle.sh";
/** No cap of Freestyle's own (ttlSeconds has none, O); a computer's here is a day, as the other janitor hosts'. */
const MAX_LIFETIME_MS = 24 * 60 * 60_000;
const CALL_MS = 30_000;
/** One page of a listing (O list_vms: limit and offset). */
const PAGE = 100;
const MAX_PAGES = 100;
/** The longest exec-await answered inline (O ExecRequest.timeoutMs: at most 300000 without a background request). */
const EXEC_MS = 300_000;
/** How long a failed create's delete of the VM it made may take: create's own bound may be spent by then. */
const DELETE_MS = 30_000;
/** A 429 is sent again after 1, 2 and 4 s. */
const RETRY = { attempts: 4, baseMs: 1_000 };
/** A file read's exit when the file is not there. */
const MISSING = 3;
/** A VM id (O VmId: vm-<uuid>) or slug, as it reaches a URL: one path segment, nothing a URL resolves away. */
const VM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** A snapshot's id (O SnapshotId: sh-<uuid>) or slug (1 to 63 of [a-z0-9-], no hyphen at either end or twice running). */
const SNAPSHOT_NAME = /^(?=.{1,63}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Freestyle's own base snapshots, freestyle/<slug> (D vms/base-snapshots): none holds agentrun-dial. */
const BASE_OWNER = "freestyle";
/** agentrun-dial's launch script (dialLaunch's line), its output and its exit code, root's alone. */
const DIAL_DIR = "/run/agentrun-dial";
const DIAL_SCRIPT = `${DIAL_DIR}/launch`;
const DIAL_LOG = `${DIAL_DIR}/log`;
const DIAL_EXIT = `${DIAL_DIR}/exit`;
/** How much of agentrun-dial's log dialLog reads: its end. */
const LOG_BYTES = 65_536;
/**
 * The firewall every VM is made with (O FirewallSpec; a VM gets no network it is not given): out to every public
 * address. The VM fetches its daemon from the server and dials it; its programs keep to init's network either way.
 */
const FIREWALL = { rules: [{ action: "allow", source: {}, destination: { public: true } }] };

/** Freestyle's codes whose meaning is the adapter's code whatever their status (O PublicErrorBody.code). */
const CODES: Readonly<Record<string, ComputerErrorCode>> = {
	LIMIT_EXCEEDED: "limit",
	NOT_FOUND: "not_found",
	UNAUTHORIZED: "denied",
	FORBIDDEN: "denied",
};

/** A file written whole: base64 through printf, to <path>.new, then moved over <path>. */
const writeFile = (path: string, text: string) => `printf %s '${Buffer.from(text, "utf8").toString("base64")}' | base64 -d > ${path}.new && mv -f ${path}.new ${path}`;
/** A file read: exits MISSING when it is not there. */
const readFile = (path: string, read = "cat") => `[ -f ${path} ] || exit ${MISSING}; ${read} ${path}`;
/**
 * agentrun-dial's start from its launch script, detached: a session of its own (setsid), no hangup, stdin closed, its
 * output to DIAL_LOG and its exit code to DIAL_EXIT once it ends, so exec-await answers at once.
 */
const START = `rm -f ${DIAL_EXIT} && { setsid nohup sh -c 'sh ${DIAL_SCRIPT}; echo $? > ${DIAL_EXIT}' > ${DIAL_LOG} 2>&1 < /dev/null & }`;
/** create's one command: the launch script, then its start. The boot env, the token with it, is the command's env alone. */
const LAUNCH = ["umask 077", `mkdir -p ${DIAL_DIR}`, writeFile(DIAL_SCRIPT, dialLaunch()), START].join(" && ");

/** Freestyle's states (O VmState) as the adapter's: pausing, paused and stopped are stopped, listed, so the janitor ends them. */
const STATES: Readonly<Record<string, Machine["state"]>> = {
	starting: "starting",
	running: "running",
	pausing: "stopped",
	paused: "stopped",
	stopped: "stopped",
};

/** A VM as the adapter reads it: its metadata as its labels, its resources in the adapter's units. */
function machineOf(vm: FreestyleVm): Machine {
	const known = STATES[vm.state ?? ""];
	const created = dateOf(vm.createdAt);
	const { cpu, memory, storage } = vm.resources ?? {};
	const resources: ComputerResources = {
		...(isWhole(cpu) && cpu > 0 ? { cpus: cpu } : {}),
		...(isWhole(memory) && memory > 0 ? { memoryMb: memory } : {}),
		...(isWhole(storage) && storage > 0 ? { diskGb: Math.round(storage / 1024) } : {}),
	};
	return {
		id: vm.id,
		labels: { ...(vm.metadata ?? {}) },
		// One in a state this provider does not know is listed, so the janitor still ends it. Freestyle has no failed state.
		state: known ?? "stopped",
		...(created ? { createdAt: created } : {}),
		...(Object.keys(resources).length > 0 ? { resources } : {}),
		...(known === undefined ? { why: `Freestyle reads its state as ${show(vm.state)}, which this provider does not know` } : {}),
	};
}

/** An id held to Freestyle's form before it reaches a URL: not_found else. */
function vmId(id: string): string {
	if (!VM_ID.test(id)) throw new HostError("not_found", `${JSON.stringify(id)} is not a Freestyle VM id`);
	return id;
}

/** Freestyle's error body (O PublicErrorBody): { code, message }; a code above is the adapter's whatever its status. */
function explain({ status, bytes, what }: { status: number; bytes: Uint8Array; what: string }) {
	const body = jsonOf(bytes) as { code?: unknown; message?: unknown } | null;
	const named = typeof body?.code === "string" ? body.code : undefined;
	const code = named === undefined ? undefined : CODES[named];
	const said = typeof body?.message === "string" && body.message !== "" ? `: ${body.message}` : "";
	const background = status === 202 ? " (a background request, which this provider never asks for)" : "";
	return { ...(code ? { code } : {}), message: `${what} answered ${status}${named ? ` ${named}` : ""}${said}${background}` };
}

/** The last words of a command's output, for a failure: its stderr, else its stdout. */
const lastWords = ({ stdout, stderr }: ExecAnswer) => (stderr.trim() || stdout.trim()).slice(-300);

/** The account a key reaches, in words: the key named by its sha256 prefix alone. */
export function accountOf(apiKey: string, apiUrl: string = DEFAULT_API_URL): string {
	return `the Freestyle account of the key sha256:${createHash("sha256").update(apiKey, "utf8").digest("hex").slice(0, 12)} at ${httpsBase(apiUrl, "the Freestyle API URL")}`;
}

/** Freestyle VMs as a dial MachineHost (../host.ts): no exec, no upload. */
class FreestyleHost implements MachineHost {
	readonly descriptor = FREESTYLE;
	readonly facts: HostFacts = {
		// agentrun-dial starts init as its child; nothing is started through exec.
		daemon: "child",
		// A guest kernel of its own per VM, on Freestyle's own VMM (S vms/types.ts experimentalGpu); unverified until the live run.
		isolation: "vm",
		lifetime: "janitor",
		maxLifetimeMs: MAX_LIFETIME_MS,
		// Unverified until the live run: Freestyle publishes no arch.
		arch: "amd64",
		// Unverified until the live run: exec-await's guest agent listens where O does not say. None declared.
		vendorAgentPorts: [],
		connect: FREESTYLE.connect,
		// O: up to 64 entries, keys and values at most 63 characters each.
		labels: { count: 64, packed: { valueBytes: 63 } },
	};
	readonly #api: Rest;
	readonly #pollMs: number;
	/**
	 * The boot env of each VM this process started agentrun-dial in, by id: redial starts it again with the same env.
	 * Let go of at its delete. The token lives here and in agentrun-dial's process alone, never in a file of the VM's.
	 */
	readonly #dials = new Map<string, Record<string, string>>();

	constructor(options: { apiKey: string; fetch?: typeof fetch; apiUrl: string; pollMs: number }) {
		this.#pollMs = options.pollMs;
		this.#api = rest({
			base: options.apiUrl,
			headers: () => ({ Authorization: `Bearer ${options.apiKey}`, Accept: "application/json" }),
			vendor: FREESTYLE.id,
			...(options.fetch ? { fetch: options.fetch } : {}),
			timeoutMs: CALL_MS,
			retry: RETRY,
			explain,
		});
	}

	/** One API call, bounded by ctx: its status and JSON answer (null for none), or a HostError in Freestyle's words. */
	async #call(method: string, path: string, ctx: HostCall, init: RestInit = {}): Promise<{ status: number; body: unknown }> {
		const answer = orThrow(await this.#api.call(method, this.#api.url(path), { timeoutMs: ctx.timeoutMs, ...init }, ctx.signal));
		return { status: answer.status, body: jsonOf(answer.bytes) };
	}

	errorCode(error: unknown): ComputerErrorCode {
		return error instanceof HostError ? error.code : "vendor";
	}

	/**
	 * One command run in the VM as root through exec-await, its whole output once it has ended. Only a 200 is an answer:
	 * a 202 (a background request, never asked for here) is a failure in words. `once`: a command that got no answer is
	 * never sent again, since it may have run (O: a 409 VM_NON_RESPONSIVE "may already have run"); a read is.
	 */
	async #exec(id: string, command: string, ctx: HostCall, { once = false, env }: { once?: boolean; env?: Record<string, string> } = {}): Promise<ExecAnswer> {
		const body = { command, linuxUser: "root", timeoutMs: Math.min(EXEC_MS, Math.max(1, Math.ceil(ctx.timeoutMs))), ...(env === undefined ? {} : { env }) };
		const { body: answer } = await this.#call("POST", `/v5/vms/${vmId(id)}/exec-await`, ctx, { json: body, accept: (status) => status === 200, retry: once ? (status) => status === 429 : true });
		const { stdout, stderr, statusCode } = (answer ?? {}) as { stdout?: unknown; stderr?: unknown; statusCode?: unknown };
		const out = { stdout: typeof stdout === "string" ? stdout : "", stderr: typeof stderr === "string" ? stderr : "" };
		if (statusCode === undefined || statusCode === null) throw new HostError("timeout", `Freestyle's exec in ${id} answered no exit status: its timeout killed the command (${lastWords({ ...out, exit: -1 }) || "no output"})`);
		if (!isWhole(statusCode)) throw new HostError("vendor", `Freestyle's exec in ${id} answered an exit status that is no number: ${show(statusCode)}`);
		return { ...out, exit: statusCode };
	}

	/**
	 * POST /v5/vms (O CreateVmRequest): the request's name as the VM's slug, the snapshot, the packed labels as metadata,
	 * ttlSeconds at the backstop (Freestyle counts it from the VM's createdAt), ephemeral (autoDeleteSeconds 0), no
	 * automatic restart, no idle pause, and the public-egress firewall. Only a 429, a refusal that made nothing, is sent
	 * again: a create that got no answer may have made a VM, which the adapter finds by its name. A 409 is Freestyle's
	 * word for a slug taken or for no capacity (O create_vm): the slug is read, and a VM under it is exists, none limit.
	 * Then, once the VM reads running within ctx.timeoutMs, one exec-await as root writes the launch script and starts
	 * agentrun-dial, the boot env its env. A VM that stops or goes first, a launch that fails, or a bound passed, throws: a
	 * create that made a machine to the adapter, which deletes it by its name. A refusal after the VM exists (an exec's 429
	 * past every retry, limit; a 401, denied) the adapter reads as a create that made nothing (mayHaveMade), so this
	 * deletes the VM by its id first and throws the refusal in its own code.
	 */
	async create(req: MachineRequest, ctx: HostCall): Promise<{ id: string }> {
		const end = Date.now() + ctx.timeoutMs;
		if (req.boot === undefined) throw new HostError("invalid", "a Freestyle VM dials the server, and the request has no boot env for it");
		const env = { ...req.boot.env };
		const body = {
			slug: req.name,
			snapshotId: req.image,
			metadata: req.labels,
			ttlSeconds: Math.max(60, Math.ceil((Date.parse(req.backstopAt) - Date.now()) / 1000)),
			autoDeleteSeconds: 0,
			automaticRestart: false,
			firewall: FIREWALL,
		};
		const { status, body: made } = await this.#call("POST", "/v5/vms", ctx, { json: body, accept: (code) => code === 409 || (code >= 200 && code < 300), retry: (code) => code === 429 });
		if (status === 409) throw await this.#taken(req.name, made, { ...ctx, timeoutMs: Math.max(1, end - Date.now()) });
		const id = (made as FreestyleVm | null)?.id;
		if (typeof id !== "string" || !VM_ID.test(id)) throw new HostError("vendor", `POST /v5/vms answered no VM id: ${show(id)}`);
		try {
			await this.#untilRunning(made as FreestyleVm, end, ctx);
			const ran = await this.#exec(id, LAUNCH, { ...ctx, timeoutMs: Math.max(1, end - Date.now()) }, { once: true, env });
			if (ran.exit !== 0) throw new HostError("vendor", `starting agentrun-dial in ${id} exited ${ran.exit}: ${lastWords(ran)}`);
			this.#dials.set(id, env);
		} catch (error) {
			if (!(error instanceof HostError) || mayHaveMade(error.code)) throw error;
			throw await this.#unmade(id, error);
		}
		return { id };
	}

	/** A create's 409: exists where the slug reads a VM (the adapter adopts it by its name), else no capacity (limit). */
	async #taken(name: string, said: unknown, ctx: HostCall): Promise<HostError> {
		const words = [(said as { code?: unknown } | null)?.code, (said as { message?: unknown } | null)?.message].filter((part) => typeof part === "string" && part !== "").join(": ");
		const found = await this.get(name, ctx);
		if (found !== undefined) return new HostError("exists", `POST /v5/vms answered 409${words ? ` ${words}` : ""}: the account has a VM of the slug ${name} (${found.id})`);
		return new HostError("limit", `POST /v5/vms answered 409${words ? ` ${words}` : ""}, and no VM has the slug ${name}: Freestyle has no capacity for it`);
	}

	/** The VM a failed create made, deleted by its id: the step's error in its own code, the delete's outcome added. */
	async #unmade(id: string, error: HostError): Promise<HostError> {
		let outcome: string;
		try {
			await this.delete(id, { timeoutMs: DELETE_MS });
			outcome = `the VM ${id} it made was deleted`;
		} catch (failed) {
			outcome = `the VM ${id} it made could not be deleted (${failed instanceof Error ? failed.message : String(failed)}); Freestyle deletes it at its ttlSeconds`;
		}
		return new HostError(error.code, `${error.message}; ${outcome}`);
	}

	/** Reads the VM until it runs, pollMs apart, by `end`: one stopped, paused or gone first throws vendor, the end timeout. */
	async #untilRunning(posted: FreestyleVm, end: number, ctx: HostCall): Promise<void> {
		for (let found: FreestyleVm | undefined = posted; found.state !== "running"; ) {
			if (found.state !== "starting") throw new HostError("vendor", `Freestyle reads the VM ${posted.id} ${show(found.state)} before it ran, so agentrun-dial was not started`);
			if (Date.now() + this.#pollMs >= end) throw new HostError("timeout", `the VM ${posted.id} did not read running within ${seconds(ctx.timeoutMs)} (it reads ${found.state}), so agentrun-dial was not started`);
			await pause(this.#pollMs, ctx.signal);
			if (ctx.signal?.aborted) throw new HostError("aborted", `the wait for the VM ${posted.id} to run was aborted`);
			found = await this.#read(posted.id, { ...ctx, timeoutMs: Math.max(1, end - Date.now()) });
			if (found === undefined) throw new HostError("vendor", `Freestyle no longer has the VM ${posted.id}, which went before it ran, so agentrun-dial was not started`);
		}
	}

	/** GET /v5/vms/{id}: the VM as Freestyle answers it; a 404 is none. */
	async #read(id: string, ctx: HostCall): Promise<FreestyleVm | undefined> {
		const { status, body } = await this.#call("GET", `/v5/vms/${vmId(id)}`, ctx, { retry: true, accept: (code) => code === 404 || (code >= 200 && code < 300) });
		if (status === 404) return undefined;
		const vm = body as FreestyleVm | null;
		if (typeof vm?.id !== "string") throw new HostError("vendor", `GET /v5/vms/${id} answered no VM`);
		return vm;
	}

	/** GET /v5/vms/{id}; a 404 is none. */
	async get(id: string, ctx: HostCall): Promise<Machine | undefined> {
		const vm = await this.#read(id, ctx);
		return vm === undefined ? undefined : machineOf(vm);
	}

	/**
	 * GET /v5/vms with the labels asked as one metadata filter (O list_vms: comma-separated key:value pairs), every page
	 * by offset until totalCount; a label whose name or value holds a comma or a colon, which the filter can't say, is
	 * matched here alone. Every label asked is matched here too, so a listing that answers more is filtered.
	 */
	async list(labels: Record<string, string>, ctx: HostCall): Promise<Machine[]> {
		const asked = Object.entries(labels);
		const filter = asked
			.filter(([name, value]) => !/[,:]/.test(name) && !/[,:]/.test(value))
			.map(([name, value]) => `${name}:${value}`)
			.join(",");
		const page = async (cursor?: string) => {
			const offset = Number(cursor ?? 0);
			const query = new URLSearchParams({ ...(filter === "" ? {} : { metadata: filter }), limit: String(PAGE), offset: String(offset) });
			const { body } = await this.#call("GET", `/v5/vms?${query}`, ctx, { retry: true });
			const read = body as { vms?: unknown; totalCount?: unknown } | null;
			if (!Array.isArray(read?.vms)) throw new HostError("vendor", "GET /v5/vms answered no list of VMs");
			const items = read.vms as FreestyleVm[];
			const next = offset + items.length;
			const more = items.length > 0 && (isWhole(read.totalCount) ? next < read.totalCount : items.length === PAGE);
			return ok({ items, ...(more ? { next: String(next) } : {}) });
		};
		return orThrow(await allPages<FreestyleVm>(page, MAX_PAGES, { vendor: FREESTYLE.id, what: "GET /v5/vms" }))
			.filter((vm) => typeof vm?.id === "string")
			.map(machineOf)
			.filter((machine) => asked.every(([name, value]) => machine.labels[name] === value));
	}

	/** DELETE /v5/vms/{id} (O: 204; it deletes the firewall rules made with the VM); a 404 is done. Its dial's env goes with it. */
	async delete(id: string, ctx: HostCall): Promise<void> {
		try {
			await this.#call("DELETE", `/v5/vms/${vmId(id)}`, ctx, { retry: true, accept: (code) => code === 404 || (code >= 200 && code < 300) });
		} finally {
			this.#dials.delete(id);
		}
	}

	/** The end of what agentrun-dial wrote, through exec-await; undefined where it was never started. */
	async dialLog(id: string, ctx: HostCall): Promise<string | undefined> {
		const read = await this.#exec(id, readFile(DIAL_LOG, `tail -c ${LOG_BYTES}`), ctx);
		if (read.exit === MISSING) return undefined;
		if (read.exit !== 0) throw new HostError("vendor", `reading agentrun-dial's log in ${id} exited ${read.exit}: ${lastWords(read)}`);
		return read.stdout;
	}

	/** agentrun-dial's exit code, which its start writes once it has ended; undefined while it runs, or never started. */
	async dialExit(id: string, ctx: HostCall): Promise<number | undefined> {
		const read = await this.#exec(id, readFile(DIAL_EXIT), ctx);
		if (read.exit === MISSING) return undefined;
		if (read.exit !== 0) throw new HostError("vendor", `reading agentrun-dial's exit in ${id} exited ${read.exit}: ${lastWords(read)}`);
		const code = read.stdout.trim();
		return /^\d{1,3}$/.test(code) ? Number(code) : undefined;
	}

	/** agentrun-dial started once more from create's launch script, with the env create gave it, kept by this process. */
	async redial(id: string, ctx: HostCall): Promise<void> {
		const env = this.#dials.get(id);
		if (env === undefined) throw new HostError("not_found", `agentrun-dial was not started in the VM ${id} from this process, so it is not started again`);
		const ran = await this.#exec(id, `[ -f ${DIAL_SCRIPT} ] || exit ${MISSING}; umask 077 && ${START}`, ctx, { once: true, env });
		if (ran.exit === MISSING) throw new HostError("not_found", `no agentrun-dial was started in the VM ${id}, so it is not started again`);
		if (ran.exit !== 0) throw new HostError("vendor", `starting agentrun-dial again in ${id} exited ${ran.exit}: ${lastWords(ran)}`);
	}

	/**
	 * An image is a snapshot of the key's account by its id (sh-...) or its slug, or a public one as {owner}/{slug}: one
	 * that holds agentrun-dial, which Freestyle's base snapshots (freestyle/...) don't. A VM has its snapshot's size, so
	 * cpus and memoryMb are refused.
	 */
	check(spec: Partial<ComputerSpec>): Refusal[] {
		const refusals: Refusal[] = [];
		const { image } = spec;
		if (typeof image === "string") {
			const [owner, slug, ...more] = image.split("/");
			const own = slug === undefined && SNAPSHOT_NAME.test(owner as string);
			const shared = slug !== undefined && more.length === 0 && owner !== BASE_OWNER && SNAPSHOT_NAME.test(owner as string) && SNAPSHOT_NAME.test(slug);
			if (!own && !shared) refusals.push({ field: "image", message: `an image is a Freestyle snapshot that holds agentrun-dial, by its id (sh-...) or slug, or a public one as {owner}/{slug}: the box image's, which prepareImage() names (${boxFreestyleSnapshot()}), built once in the key's account, or one of your own from it; Freestyle's base snapshots (freestyle/...) have none` });
		}
		refusals.push(...sizeRefusals(spec, "a Freestyle VM", "snapshot"));
		return refusals;
	}
}

/** A FreestyleProvider from its options alone; it reads no environment (serve passes its FREESTYLE_API_KEY). */
export async function create(options: FreestyleProviderOptions): Promise<FreestyleProvider> {
	return new FreestyleProvider(options);
}

/** The conformance CLI's module for Freestyle: its settings, and its dialKit that refuses off the public server. */
export const conformance = () => import("./conformance/freestyle.js");

/** The box image's snapshot slug in the key's account: agentrun-box-<recipe hash>, so a new recipe is a new snapshot. */
export const boxFreestyleSnapshot = (): string => `agentrun-box-${boxRecipeHash()}`;

const KEY_REQUIRED ="options.apiKey, the Freestyle API key, is required: the provider reads no environment, so the caller passes it";
/** The uid of the VM's own user (D: ubuntu, uid 1000), whose processes init refuses to run beside. */
const VM_UID = 1000;

/**
 * Computers that are Freestyle VMs, on the shared adapter, each dialing the server that made it: a server with no
 * public https address (AGENTRUN_PUBLIC_URL) refuses a create in words before Freestyle is called. Kind linux.
 */
export class FreestyleProvider extends HostedProvider {
	/**
	 * The provider contract's prepareImage (its descriptor declares it): the box image's snapshot in the key's account, by
	 * its slug, agentrun-box-<recipe hash>, built once by the operator (PROVIDERS.md, "Your image"). No call: Freestyle
	 * resolves the slug at each create, and an account without it refuses the create in Freestyle's words.
	 */
	async prepareImage(): Promise<Result<string>> {
		return ok(boxFreestyleSnapshot());
	}

	constructor(options: FreestyleProviderOptions) {
		const { apiKey, fetch: fetcher, apiUrl = DEFAULT_API_URL, timeouts = {}, maxLifetimeMs = MAX_LIFETIME_MS, ...rest } = options ?? ({} as FreestyleProviderOptions);
		if (typeof apiKey !== "string" || apiKey === "") throw new Error(KEY_REQUIRED);
		if (fetcher !== undefined && typeof fetcher !== "function") throw new Error("options.fetch must be a function, as the global fetch is");
		if (Number(rest.daemonUser?.split(":")[0]) === VM_UID) throw new Error(`the daemon user ${rest.daemonUser} is the uid of the VM's own user, whose processes init refuses to run beside; choose another, such as 2510:2510`);
		const host = new FreestyleHost({ apiKey, ...(fetcher ? { fetch: fetcher } : {}), apiUrl: httpsBase(apiUrl, "the Freestyle API URL"), pollMs: timeoutsOf(timeouts).pollMs });
		super(host, { ...rest, timeouts, maxLifetimeMs });
	}
}
