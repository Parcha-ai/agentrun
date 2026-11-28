// The Maritime host: a Linux sandbox on a Maritime virtual machine, a micro-VM with its own kernel, over Maritime's REST
// API: the control plane (https://api.maritime.sh/v1, a Bearer API key) makes, reads, lists and ends VMs, and each VM's
// own data plane (its dataPlaneUrl, its secret in X-Maritime-Token) runs commands in it. Sources: O = Maritime's
// openapi.json, S = maritime-sdk (Maritime's own client: SandboxData, Command, its error body), D = maritime.sh/docs.
// A command's stdin is one string given at its start (S RunParams.stdin), which can't carry the stdio bridge, so this
// host has no exec: its VMs dial the server (facts.connect "dial"). A VM boots the box image by its public tag (D
// images), named as the request's name with the labels as its metadata, as they are; once it reads running, create
// starts agentrun-dial in it as a background command with the whole boot env as that command's env, and keeps the
// command's id here for dialLog, dialExit and redial. The VM's own env has no boot env: an image CMD that runs (the box
// image's runs agentrun-dial only with AGENTRUN_ATTACH_URL set) reaches `sleep infinity`, so one machine dials once. A
// VM keeps awake (keepAwake: Maritime counts no background command and no outbound call as activity, D) and ends at the
// request's backstop (timeLimitSeconds); the janitor ends it at its deadline first. The rest of the computer is the
// shared machine-host adapter's (./hosted/provider.ts).
//
// Unverified until the live run: the arch (amd64); no vendor agent on a TCP port inside the VM; commands run as root
// in a VM made from the box image, and root makes a network namespace there; a background command's env reaches its
// process; metadata takes the adapter's keys (dots) and values as they are, with room for all of them; a VM made from an
// OCI image runs or skips its CMD (create relies on neither); a name reused once its VM ended makes a new VM; DELETE
// takes the VM's id alone; the box image's first pull and the time to running fit createMs (10 min).
import { boxImageRef } from "./box-image.js";
import { MARITIME } from "./descriptors/maritime.js";
import { show } from "./drift.js";
import { BACKSTOP_MARGIN_MS, type HostCall, HostError, type HostFacts, type Machine, type MachineHost, type MachineRequest } from "./host.js";
import { orThrow, pause, seconds } from "./hosted/process.js";
import { HostedProvider, type HostedOptions, type HostedTimeouts, mayHaveMade, timeoutsOf } from "./hosted/provider.js";
import { allPages, httpsBase, jsonOf, type Rest, type RestInit, rest } from "./hosted/rest.js";
import { dialLaunch } from "./hosted/scripts.js";
import { dateOf, isWhole } from "./hosted/values.js";
import type { ComputerSpec, Refusal } from "./provider.js";
import { ok, type Result } from "./result.js";

/** The Maritime provider's options: the API key, then the shared adapter's (HostedOptions). */
export interface MaritimeProviderOptions extends Omit<HostedOptions, "kind" | "desktop"> {
	/** A Maritime API key with the sandboxes scope. The caller passes it; this provider never reads it from the environment. */
	apiKey: string;
	/** The API's root; default https://api.maritime.sh (S: MARITIME_API_URL's default). */
	apiUrl?: string;
	/** The fetch every call goes through, the data planes' too; default the global one. */
	fetch?: typeof fetch;
}

export async function create(options: MaritimeProviderOptions): Promise<MaritimeProvider> {
	return new MaritimeProvider(options);
}

export const conformance = () => import("./conformance/maritime.js");

export const DEFAULT_API_URL = "https://api.maritime.sh";
/** Every computer's name starts with this (MachineRequest.name), so a listing asks for computers alone. */
const NAME_PREFIX = "computer-";
/** A VM's time limit is 60 s to 24 h (S CreateSandboxParams.timeLimitSeconds), which create sets to the backstop. */
const LEAST_LIMIT_S = 60;
const MOST_LIMIT_S = 24 * 60 * 60;
/** So the janitor's cap is a day less the backstop's margin: backstopAt is never past what the time limit holds. */
const MAX_LIFETIME_MS = MOST_LIMIT_S * 1000 - BACKSTOP_MARGIN_MS;
/** A listing's page, the most S allows, and the pages one listing reads at most. */
const PAGE = 100;
const MAX_PAGES = 100;
/** D limits: a VM's vCPUs and its memory, in whole GiB. */
const MOST_CPUS = 16;
const MOST_MEMORY_MB = 65_536;
/** An OCI reference with a repository path: Maritime's templates (base, python, ...) and snapshots are bare names. */
const OCI = /^[A-Za-z0-9][^\s/]*(?:\/[^\s/]+)+$/;
/** A create waits for the box image's first pull, then the daemon's fetch and the dial (unverified until the live run). */
const MARITIME_TIMEOUTS: Partial<HostedTimeouts> = { createMs: 600_000 };
/** The signals a killed command names (S Command.signal), as a shell's exit code reads them: 128 and the number. */
const SIGNALS: Readonly<Record<string, number>> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

/** A VM as Maritime answers one (S SandboxData), as far as this host reads it. */
interface Sandbox {
	id: string;
	name?: string | null;
	state: string;
	from?: string;
	resources?: { vcpu?: number; memoryMib?: number; diskGib?: number };
	dataPlaneUrl?: string;
	secret?: string | null;
	metadata?: Record<string, unknown>;
	createdAt?: string;
	endedReason?: string | null;
	pausedReason?: string | null;
}

/** A command as a data plane answers one (S Command). */
interface Command {
	id: string;
	state?: string;
	exitCode?: number | null;
	signal?: string | null;
	stdout?: string;
	stderr?: string;
}

/** agentrun-dial's command in a VM this process made: its data plane, the command's id, and the env it was started with. */
interface Dial {
	plane: Rest;
	command: string;
	env: Record<string, string>;
}

/** S SANDBOX_STATES: resuming is on its way back to running; pausing and paused are there and not running. */
const STATES: Readonly<Record<string, Machine["state"]>> = { starting: "starting", resuming: "starting", running: "running", pausing: "stopped", paused: "stopped" };

/** The error body (S sandboxErrorFromBody): { code, message, hint, ... }, Maritime's words; its status gives the code. */
const explain = ({ status, bytes, what }: { status: number; bytes: Uint8Array; what: string }) => {
	const body = jsonOf(bytes) as { code?: unknown; message?: unknown } | null;
	const words = [body?.code, body?.message].filter((part) => typeof part === "string" && part !== "").join(": ");
	return { message: `${what} answered ${status}${words ? `: ${words}` : ""}` };
};

/** An ended VM is none (Maritime keeps its record 7 days, S list); any other a machine, a state this host doesn't know stopped. */
function machineOf(sandbox: Sandbox): Machine | undefined {
	if (sandbox.state === "ended") return undefined;
	const state = STATES[sandbox.state];
	const created = dateOf(sandbox.createdAt);
	const { vcpu, memoryMib, diskGib } = sandbox.resources ?? {};
	const resources = { ...(isWhole(vcpu) ? { cpus: vcpu } : {}), ...(isWhole(memoryMib) ? { memoryMb: memoryMib } : {}), ...(isWhole(diskGib) ? { diskGb: diskGib } : {}) };
	const reason = sandbox.endedReason ?? sandbox.pausedReason;
	return {
		id: sandbox.id,
		labels: Object.fromEntries(Object.entries(sandbox.metadata ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
		...(typeof sandbox.from === "string" ? { image: sandbox.from } : {}),
		// One Maritime reads errored, or in a state this host doesn't know, is listed, so the janitor still ends it.
		state: state ?? "stopped",
		...(state === undefined ? { why: `Maritime reads it ${sandbox.state}${reason ? `: ${reason}` : ""}` } : {}),
		...(created ? { createdAt: created } : {}),
		...(Object.keys(resources).length > 0 ? { resources } : {}),
	};
}

/** Maritime's VMs as a dial MachineHost (../host.ts): no exec, no upload, no extend. */
class MaritimeHost implements MachineHost {
	readonly descriptor = MARITIME;
	readonly facts: HostFacts = {
		// agentrun-dial, a background command, starts init as its child; nothing is started through exec.
		daemon: "child",
		// D: "an isolated Linux micro-VM ... with its own kernel".
		isolation: "microvm",
		lifetime: "janitor",
		maxLifetimeMs: MAX_LIFETIME_MS,
		arch: "amd64",
		vendorAgentPorts: [],
		connect: MARITIME.connect,
	};
	readonly #api: Rest;
	readonly #fetch: typeof fetch;
	readonly #pollMs: number;
	/** agentrun-dial's command in each VM this process made, by the VM's id. */
	readonly #dials = new Map<string, Dial>();

	constructor(options: { apiKey: string; apiUrl: string; fetch: typeof fetch; pollMs: number }) {
		this.#fetch = options.fetch;
		this.#pollMs = options.pollMs;
		this.#api = this.#client(options.apiUrl, { Authorization: `Bearer ${options.apiKey}` });
	}

	/** A REST client of one plane: the control plane with the key, or a VM's data plane with its secret. */
	#client(base: string, auth: Record<string, string>): Rest {
		return rest({ base, headers: () => ({ ...auth, Accept: "application/json" }), vendor: MARITIME.id, fetch: this.#fetch, timeoutMs: 30_000, retry: { attempts: 3, baseMs: 500 }, explain });
	}

	/** One call, bounded by ctx: its status and JSON answer, or a HostError in Maritime's words. */
	async #call(client: Rest, method: string, path: string, ctx: HostCall, init: RestInit = {}): Promise<{ status: number; body: unknown }> {
		const answer = orThrow(await client.call(method, client.url(path), { timeoutMs: ctx.timeoutMs, ...init }, ctx.signal));
		return { status: answer.status, body: jsonOf(answer.bytes) };
	}

	/**
	 * A size Maritime makes (1 to 16 vCPUs, whole GiB from 1 to 64, D limits) and an image that is an OCI reference: the
	 * box image prepareImage() answers, or one FROM it. Maritime's templates and snapshots hold no agentrun-dial.
	 */
	check(spec: Partial<ComputerSpec>): Refusal[] {
		const refusals: Refusal[] = [];
		const { image, cpus, memoryMb } = spec;
		if (image !== undefined && !(typeof image === "string" && OCI.test(image))) {
			refusals.push({ field: "image", message: "an image is a public OCI reference that holds agentrun-dial: the box image prepareImage() answers, or one of your own FROM it; Maritime's templates and snapshots (base, python, ...) have none" });
		}
		if (cpus !== undefined && !(isWhole(cpus) && cpus >= 1 && cpus <= MOST_CPUS)) refusals.push({ field: "cpus", message: `a Maritime VM has 1 to ${MOST_CPUS} vCPUs, a whole number` });
		if (memoryMb !== undefined && !(isWhole(memoryMb) && memoryMb >= 1024 && memoryMb <= MOST_MEMORY_MB && memoryMb % 1024 === 0)) {
			refusals.push({ field: "memoryMb", message: `a Maritime VM has 1 to ${MOST_MEMORY_MB / 1024} GiB of memory, in whole GiB` });
		}
		return refusals;
	}

	/**
	 * POST /v1/sandboxes: the request's name, the image as `from`, the labels as metadata, a size when the request has one,
	 * egress to all (the VM fetches its daemon and dials), keepAwake, and the backstop as its time limit. 201 is a new VM;
	 * 200 is the live one of that name (O), which is exists. Only a 429 is sent again: a create with no answer may have
	 * made a VM, which the adapter finds by its name. Then, once the VM reads running within ctx.timeoutMs, agentrun-dial
	 * starts as a background command (#startDial). A VM that errors, a bound passed or a start that fails throws: a create
	 * that may have made a machine to the adapter, which ends it by its name; a refusal after the VM exists (a 401 or 402
	 * at the data plane) the adapter reads as a create that made nothing (mayHaveMade), so it is ended here first.
	 */
	async create(req: MachineRequest, ctx: HostCall): Promise<{ id: string }> {
		const end = Date.now() + ctx.timeoutMs;
		if (req.boot === undefined) throw new HostError("invalid", "a Maritime VM dials the server, and the request has no boot env for it");
		const limit = Math.min(MOST_LIMIT_S, Math.max(LEAST_LIMIT_S, Math.ceil((Date.parse(req.backstopAt) - Date.now()) / 1000)));
		const json = {
			name: req.name,
			from: req.image,
			...(req.cpus === undefined ? {} : { vcpu: req.cpus }),
			...(req.memoryMb === undefined ? {} : { memoryMib: req.memoryMb }),
			metadata: req.labels,
			network: { egress: "all" },
			keepAwake: true,
			timeLimitSeconds: limit,
		};
		const made = await this.#call(this.#api, "POST", "/v1/sandboxes", ctx, { json, named: true, retry: (status) => status === 429 });
		const sandbox = made.body as Sandbox | null;
		if (typeof sandbox?.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(sandbox.id)) throw new HostError("vendor", `POST /v1/sandboxes answered no VM id: ${show(sandbox?.id)}`);
		if (made.status !== 201) throw new HostError("exists", `Maritime holds a live VM named ${req.name} already (${sandbox.id})`);
		try {
			const running = await this.#untilRunning(sandbox, end, ctx);
			await this.#startDial(running, req.boot.env, { ...ctx, timeoutMs: Math.max(1, end - Date.now()) });
		} catch (error) {
			if (!(error instanceof HostError) || mayHaveMade(error.code)) throw error;
			throw await this.#unmade(sandbox.id, error);
		}
		return { id: sandbox.id };
	}

	/** Reads the VM until it runs, pollMs apart, by `end`: starting and resuming wait; any other state throws vendor. */
	async #untilRunning(posted: Sandbox, end: number, ctx: HostCall): Promise<Sandbox> {
		for (let found = posted; ; ) {
			if (found.state === "running") return found;
			if (found.state !== "starting" && found.state !== "resuming") {
				const reason = found.endedReason ?? found.pausedReason;
				throw new HostError("vendor", `Maritime reads the VM ${posted.id} ${found.state}${reason ? `: ${reason}` : ""}, so agentrun-dial was not started`);
			}
			if (Date.now() + this.#pollMs >= end) throw new HostError("timeout", `the VM ${posted.id} did not read running within ${seconds(ctx.timeoutMs)} (it reads ${found.state}), so agentrun-dial was not started`);
			await pause(this.#pollMs, ctx.signal);
			if (ctx.signal?.aborted) throw new HostError("aborted", `the wait for the VM ${posted.id} to run was aborted`);
			found = (await this.#call(this.#api, "GET", `/v1/sandboxes/${posted.id}`, { ...ctx, timeoutMs: Math.max(1, end - Date.now()) }, { retry: true })).body as Sandbox;
		}
	}

	/**
	 * POST {dataPlaneUrl}/commands: `sh -c` agentrun-dial's launch line (dialLaunch), the boot env as the command's env,
	 * in the background (S RunParams: no timeout). Sent once: a start with no answer may have run.
	 */
	async #startDial(sandbox: Sandbox, env: Record<string, string>, ctx: HostCall): Promise<void> {
		if (typeof sandbox.dataPlaneUrl !== "string" || typeof sandbox.secret !== "string" || sandbox.secret === "") {
			throw new HostError("vendor", `Maritime answered no data plane for the VM ${sandbox.id}, so agentrun-dial was not started`);
		}
		let base: string;
		try {
			base = httpsBase(sandbox.dataPlaneUrl, "the VM's data plane URL");
		} catch (error) {
			throw new HostError("vendor", error instanceof Error ? error.message : String(error));
		}
		const plane = this.#client(base, { "X-Maritime-Token": sandbox.secret });
		const command = await this.#run(plane, sandbox.id, env, ctx);
		this.#dials.set(sandbox.id, { plane, command, env });
	}

	/** The background command that runs agentrun-dial: its id. */
	async #run(plane: Rest, id: string, env: Record<string, string>, ctx: HostCall): Promise<string> {
		const started = (await this.#call(plane, "POST", "/commands", ctx, { json: { cmd: ["sh", "-c", dialLaunch()], env, background: true }, retry: (status) => status === 429 })).body as Command | null;
		if (typeof started?.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(started.id)) throw new HostError("vendor", `the data plane of ${id} answered no command id: ${show(started?.id)}`);
		return started.id;
	}

	/** The VM a failed create made, ended by its id: the step's error in its own code, the end's outcome added. */
	async #unmade(id: string, error: HostError): Promise<HostError> {
		let outcome: string;
		try {
			await this.delete(id, { timeoutMs: 30_000 });
			outcome = `the VM ${id} it made was ended`;
		} catch (failed) {
			outcome = `the VM ${id} it made could not be ended (${failed instanceof Error ? failed.message : String(failed)}); Maritime ends it at its time limit`;
		}
		return new HostError(error.code, `${error.message}; ${outcome}`);
	}

	/**
	 * GET /v1/sandboxes/{id}; a 404 is none, and an ended VM is none. A VM read none drops what this process kept of its
	 * agentrun-dial, as delete() does: the adapter's release() skips delete() for a machine get() reads none.
	 */
	async get(id: string, ctx: HostCall): Promise<Machine | undefined> {
		const read = await this.#call(this.#api, "GET", `/v1/sandboxes/${encodeURIComponent(id)}`, ctx, { retry: true, accept: (status) => status === 404 || status === 410 || (status >= 200 && status < 300) });
		if (read.status === 404 || read.status === 410) {
			this.#dials.delete(id);
			return undefined;
		}
		const sandbox = read.body as Sandbox | null;
		if (typeof sandbox?.state !== "string") throw new HostError("vendor", `GET /v1/sandboxes/${id} answered no state`);
		const machine = machineOf({ ...sandbox, id: typeof sandbox.id === "string" ? sandbox.id : id });
		if (machine === undefined) this.#dials.delete(id);
		return machine;
	}

	/**
	 * GET /v1/sandboxes by the computers' name prefix, every page by cursor; ended VMs left out, and the asked labels
	 * matched here: whether Maritime's metadata filter matches exactly is unverified, and a listing that over-returns is
	 * safe where one that under-returns would let a sweep miss a machine.
	 */
	async list(labels: Record<string, string>, ctx: HostCall): Promise<Machine[]> {
		const page = async (cursor?: string) => {
			const query = new URLSearchParams({ namePrefix: NAME_PREFIX, limit: String(PAGE), ...(cursor ? { cursor } : {}) });
			const { body } = await this.#call(this.#api, "GET", `/v1/sandboxes?${query}`, ctx, { retry: true });
			const read = body as { data?: unknown; nextCursor?: unknown } | null;
			if (!Array.isArray(read?.data)) throw new HostError("vendor", "GET /v1/sandboxes answered no list");
			const items = (read.data as Sandbox[]).filter((one) => typeof one?.id === "string" && typeof one.state === "string");
			return ok({ items, ...(typeof read.nextCursor === "string" && read.nextCursor !== "" ? { next: read.nextCursor } : {}) });
		};
		const asked = Object.entries(labels);
		return orThrow(await allPages<Sandbox>(page, MAX_PAGES, { vendor: MARITIME.id, what: "GET /v1/sandboxes" }))
			.filter((sandbox) => (sandbox.name ?? "").startsWith(NAME_PREFIX))
			.flatMap((sandbox) => machineOf(sandbox) ?? [])
			.filter((machine) => asked.every(([name, value]) => machine.labels[name] === value));
	}

	/** DELETE /v1/sandboxes/{id}: the VM ends (S: "Safe to repeat"); one Maritime no longer has is done. */
	async delete(id: string, ctx: HostCall): Promise<void> {
		this.#dials.delete(id);
		await this.#call(this.#api, "DELETE", `/v1/sandboxes/${encodeURIComponent(id)}`, ctx, { retry: true, accept: (status) => status === 404 || status === 410 || (status >= 200 && status < 300) });
	}

	/** agentrun-dial's command as its VM's data plane reads it now; undefined for a VM no command was started in here. */
	async #command(id: string, ctx: HostCall): Promise<Command | undefined> {
		const dial = this.#dials.get(id);
		if (dial === undefined) return undefined;
		const read = (await this.#call(dial.plane, "GET", `/commands/${dial.command}`, ctx, { retry: true })).body as Command | null;
		if (typeof read?.state !== "string") throw new HostError("vendor", `the data plane of ${id} answered no state for agentrun-dial's command`);
		return read;
	}

	/** What agentrun-dial wrote (the command's stdout, then its stderr: Maritime keeps the first MiB of each). */
	async dialLog(id: string, ctx: HostCall): Promise<string | undefined> {
		const command = await this.#command(id, ctx);
		return command === undefined ? undefined : `${command.stdout ?? ""}${command.stderr ?? ""}`;
	}

	/** agentrun-dial's exit code once its command exited; a kill is 128 and its signal's number. undefined while it runs. */
	async dialExit(id: string, ctx: HostCall): Promise<number | undefined> {
		const command = await this.#command(id, ctx);
		if (command === undefined || command.state === "running") return undefined;
		if (isWhole(command.exitCode)) return command.exitCode;
		return command.state === "killed" ? 128 + (SIGNALS[command.signal ?? ""] ?? SIGNALS.SIGKILL) : undefined;
	}

	/** agentrun-dial started once more: the same command with the same env, so the same machine dials. */
	async redial(id: string, ctx: HostCall): Promise<void> {
		const dial = this.#dials.get(id);
		if (dial === undefined) throw new HostError("not_found", `no agentrun-dial was started in the VM ${id} from this process, so it is not started again`);
		dial.command = await this.#run(dial.plane, id, dial.env, ctx);
	}
}

/**
 * Computers that are Maritime VMs, on the shared adapter, each dialing the server that made it: a server with no public
 * https address (AGENTRUN_PUBLIC_URL) refuses a create in words before Maritime is called. Kind linux.
 */
export class MaritimeProvider extends HostedProvider {
	/**
	 * The provider contract's prepareImage (its descriptor declares it): the box image by its public registry tag
	 * (box-image.ts). No call: Maritime pulls an OCI reference at the first create from it (D images).
	 */
	async prepareImage(): Promise<Result<string>> {
		return ok(boxImageRef());
	}

	constructor(options: MaritimeProviderOptions) {
		const { apiKey, apiUrl = DEFAULT_API_URL, fetch: fetcher = globalThis.fetch, timeouts = {}, ...rest } = options ?? ({} as MaritimeProviderOptions);
		if (typeof apiKey !== "string" || apiKey === "") throw new Error("options.apiKey, a Maritime API key, is required: the provider reads no environment, so the caller passes it");
		if (typeof fetcher !== "function") throw new Error("options.fetch must be a function, as the global fetch is");
		const all = { ...MARITIME_TIMEOUTS, ...timeouts };
		super(new MaritimeHost({ apiKey, apiUrl: httpsBase(apiUrl, "the Maritime API URL"), fetch: fetcher, pollMs: timeoutsOf(all).pollMs }), { ...rest, timeouts: all });
	}
}
