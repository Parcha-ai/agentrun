// The Northflank host: a Linux sandbox on a Northflank service, a Kata microVM on Northflank Cloud, in the customer's own
// project, over Northflank's REST API (https://api.northflank.com/v1, a Bearer token). Sources: D = the docs
// (https://northflank.com/docs/v1/: sandboxes/quickstart, sandboxes/configure-and-manage-sandboxes, api/use-the-api), S =
// @northflank/js-client 0.13.0, Northflank's own client, whose calls this host makes without it. A sandbox is a service
// (D quickstart): its name is the request's and its id (computer-<12 hex>), its image the box image or the spec's, its
// command `sleep infinity`. The labels are packed into the workload's annotations, whose keys must be Kubernetes names.
// The exec is S's command-exec WebSocket (ExecCommandStandard): JSON messages, the token in the first, stdin, stdout
// and stderr as latin1 strings (encoding latin1: one code point a byte), the exit in a completion message. It has no
// kill, so a command runs under the shared pid wrapper (framedExec). The janitor deletes at the deadline label; create
// sets the service's expiryTime at the request's backstop, past which Northflank pauses it (no compute billed) and
// schedules its deletion, so a computer whose server is gone stops costing.
//
// Unverified until the live run: latin1 carries every byte both ways; the exec socket stays open through 75 s of silence
// with no ping of ours; Northflank sends its init answer on the socket; output may trail the completion message, and the
// socket closes after the last of it; exec as user root is root; a create whose name the project holds answers 409
// (read as exists); a service's id is its name; the annotations come back on get as the object given; the quickstart's
// scale call after a create is needed or harmless; a deleted service answers 404; amd64; no vendor agent on TCP in the
// guest (Kata's is on vsock); root makes a network namespace in the guest.
import { BACKSTOP_MARGIN_MS, type HostCall, HostError, type HostFacts, type Machine, type MachineHost, type MachineProcess, type MachineRequest } from "./host.js";
import { boxImageRef } from "./box-image.js";
import { NORTHFLANK } from "./descriptors/northflank.js";
import { DEFAULT_CPUS, DEFAULT_MEMORY_MB, show } from "./drift.js";
import { type FramedEvent, framedExec } from "./hosted/framed-exec.js";
import { orThrow, pause } from "./hosted/process.js";
import { HostedProvider, type HostedOptions, type HostedTimeouts } from "./hosted/provider.js";
import { allPages, httpsBase, jsonOf, type Rest, type RestInit, rest } from "./hosted/rest.js";
import { PACKED_NAME, dateOf } from "./hosted/values.js";
import type { ComputerSpec, Refusal } from "./provider.js";
import { ok, type Result } from "./result.js";

/** The parts of a WebSocket the host uses: Node's global WebSocket, or a stand-in in tests. */
export interface NorthflankSocket {
	/** 0 connecting, 1 open, 2 closing, 3 closed. */
	readonly readyState: number;
	/** Bytes sent and not yet on the wire: a write waits while it is high. */
	readonly bufferedAmount: number;
	send(data: string): void;
	close(code?: number): void;
	addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown; code?: number; message?: string }) => void): void;
}

export type NorthflankSocketFactory = (url: string) => NorthflankSocket;

/** The Northflank provider's options: the token and the project, then the shared adapter's (HostedOptions). */
export interface NorthflankProviderOptions extends Omit<HostedOptions, "kind" | "desktop"> {
	/** A Northflank API token whose role may manage services and run commands in the project. The caller passes it. */
	token: string;
	/** The customer's project the services live in (its id, a slug). Required: there is no default project. */
	projectId: string;
	/** The team, for an organisation token alone (D use-the-api: /v1/teams/{teamId}/projects/...). */
	teamId?: string;
	/** The API's root; default https://api.northflank.com. */
	apiUrl?: string;
	/** The fetch every REST call goes through; default the global one. */
	fetch?: typeof fetch;
	/** For tests: every exec socket opens through it. Default Node's global WebSocket. */
	webSocket?: NorthflankSocketFactory;
}

export async function create(options: NorthflankProviderOptions): Promise<NorthflankProvider> {
	return new NorthflankProvider(options);
}

export const conformance = () => import("./conformance/northflank.js");

export const DEFAULT_API_URL = "https://api.northflank.com";
/** Every computer's name starts with this (MachineRequest.name), so a listing keeps the project's computers alone. */
const NAME_PREFIX = "computer-";
/** createOptions.expiryTime's range, in seconds (S CreateServiceDeploymentData: 300 to 604800). */
const MIN_EXPIRY_S = 300;
const MAX_EXPIRY_S = 604_800;
/** The longest a computer lives: its backstop, past it by BACKSTOP_MARGIN_MS, is then within the expiry's 7 days. */
const MAX_LIFETIME_MS = MAX_EXPIRY_S * 1000 - BACKSTOP_MARGIN_MS;
const CALL_MS = 30_000;
/** A listing's page, the most S allows. */
const PAGE = 100;
/** The gets a listing makes at once, for the labels its answer lacks. */
const LIST_READS = 8;
/** How long a listing's read of a computer answers the next get of it, once: the adapter reads each one listed again. */
const LISTED_READ_MS = 2_000;
/** A stdin message's bytes, and the socket's backlog a write waits under. */
const STDIN_BYTES = 64 * 1024;
const BACKLOG_BYTES = 1024 * 1024;
/** How long output may trail the completion message with none coming before the exit is read: S's drain, 30 s. */
const DRAIN_MS = 30_000;
/** The output a command may have waiting, unread: at it the exec ends (the socket has no flow control). */
const QUEUE_BYTES = 64 * 1024 * 1024;
/**
 * The plans a size maps to (https://northflank.com/pricing: vCPUs and MB a plan). A spec names cpus, memoryMb or both; one
 * alone takes its plan's other.
 */
const PLANS: ReadonlyArray<{ id: string; cpus: number; memoryMb: number }> = [
	{ id: "nf-compute-100-2", cpus: 1, memoryMb: 2048 },
	{ id: "nf-compute-200", cpus: 2, memoryMb: 4096 },
	{ id: "nf-compute-400", cpus: 4, memoryMb: 8192 },
	{ id: "nf-compute-800-16", cpus: 8, memoryMb: 16_384 },
];
/** An image path: a registry reference, its host optional (Docker Hub then), a tag or a digest. */
const IMAGE = /^[a-z0-9][a-z0-9._:/-]*[a-z0-9](:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}|@sha256:[0-9a-f]{64})?$/;
/** A project, team or service id as it reaches a path: Northflank's slugs. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
/**
 * The image's boot is a pull, and Northflank's delete is not done at its answer; status is read every 2 s, not 1, since
 * a token has 1000 requests an hour (D use-the-api).
 */
const NORTHFLANK_TIMEOUTS: Partial<HostedTimeouts> = { createMs: 600_000, goneMs: 180_000, pollMs: 2_000 };

/** A service as the API answers it (S GetServiceResult, ListServicesResult), as far as this host reads it. */
type Service = {
	id: string;
	name?: string;
	createdAt?: string;
	expiredAt?: string;
	billing?: { deploymentPlan?: string };
	deployment?: { metadata?: { annotations?: unknown } };
	status?: { deployment?: { status?: string } };
};
/** A command as the exec pieces hold it: its socket, its events not yet read and their bytes, and its exit once read. */
type Exec = { socket: NorthflankSocket; queue: FramedEvent[]; queued: number; closed: boolean; exit?: number; failure?: Error; drain?: ReturnType<typeof setTimeout>; wake: () => void };

/** Northflank's deployment statuses (S) as the adapter's; a service that expired is paused, so stopped. */
const STATES: Readonly<Record<string, Machine["state"]>> = { PENDING: "starting", IN_PROGRESS: "starting", COMPLETED: "running", FAILED: "gone" };

/** The annotations as a map of strings: S types them "string or object". */
function annotationsOf(value: unknown): Record<string, string> {
	const map = typeof value === "string" ? jsonOf(Buffer.from(value)) : value;
	if (typeof map !== "object" || map === null || Array.isArray(map)) return {};
	return Object.fromEntries(Object.entries(map).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function machineOf(service: Service): Machine {
	const status = service.status?.deployment?.status;
	const known = status === undefined ? "starting" : STATES[status];
	const created = dateOf(service.createdAt);
	const plan = PLANS.find((one) => one.id === service.billing?.deploymentPlan);
	const why = service.expiredAt ? `Northflank paused it at its expiry, ${service.expiredAt}` : status === "FAILED" ? "Northflank reads its deployment FAILED" : known === undefined ? `Northflank reads its deployment ${show(status)}, which this provider does not know` : undefined;
	return {
		id: service.id,
		labels: annotationsOf(service.deployment?.metadata?.annotations),
		// One expired (paused), or in a status this provider does not know, is listed, so the janitor still ends it.
		state: service.expiredAt ? "stopped" : (known ?? "stopped"),
		...(created ? { createdAt: created } : {}),
		...(plan ? { resources: { cpus: plan.cpus, memoryMb: plan.memoryMb } } : {}),
		...(why === undefined ? {} : { why }),
	};
}

/** The plan of a size, the adapter's default where the request names none; undefined for one no plan has. */
function planOf(cpus: number | undefined, memoryMb: number | undefined): string | undefined {
	const want = cpus === undefined && memoryMb === undefined ? { cpus: DEFAULT_CPUS, memoryMb: DEFAULT_MEMORY_MB } : { cpus, memoryMb };
	return PLANS.find((one) => (want.cpus === undefined || one.cpus === want.cpus) && (want.memoryMb === undefined || one.memoryMb === want.memoryMb))?.id;
}

/** An id held to Northflank's form before it reaches a path: not_found else. */
function serviceId(id: string): string {
	if (!SLUG.test(id)) throw new HostError("not_found", `${JSON.stringify(id)} is not a Northflank service id`);
	return id;
}

class NorthflankHost implements MachineHost {
	readonly descriptor = NORTHFLANK;
	readonly facts: HostFacts = {
		daemon: "child",
		// A CPU sandbox on Northflank Cloud is a Kata microVM (D sandboxes-on-northflank-cloud).
		isolation: "microvm",
		lifetime: "janitor",
		maxLifetimeMs: MAX_LIFETIME_MS,
		arch: "amd64",
		// Kata's agent talks over vsock, not TCP (unverified until the live run).
		vendorAgentPorts: [],
		// Kubernetes annotations: keys are qualified names, so the labels are packed; 256 KiB of keys and values in all.
		labels: { bytes: 262_144, packed: {} },
	};
	readonly #api: Rest;
	readonly #token: string;
	/** /projects/{projectId}, after /teams/{teamId} for an organisation token. */
	readonly #scope: string;
	readonly #wsUrl: string;
	readonly #webSocket: NorthflankSocketFactory;
	/**
	 * The last listings' reads, by id, each answering the next get of its computer once within LISTED_READ_MS: the
	 * adapter's list reads every computer the host's listing names (foundBy), which here would read each a second time,
	 * against a token's 1000 requests an hour. A create or a delete during a listing leaves its reads out.
	 */
	readonly #read = new Map<string, { machine: Machine; at: number }>();
	#writes = 0;

	constructor(options: { token: string; projectId: string; teamId?: string; apiUrl: string; fetch?: typeof fetch; webSocket: NorthflankSocketFactory }) {
		this.#token = options.token;
		this.#scope = `${options.teamId === undefined ? "" : `/teams/${options.teamId}`}/projects/${options.projectId}`;
		this.#wsUrl = options.apiUrl.replace(/^https/, "wss");
		this.#webSocket = options.webSocket;
		this.#api = rest({
			base: `${options.apiUrl}/v1`,
			headers: () => ({ Authorization: `Bearer ${this.#token}`, Accept: "application/json" }),
			vendor: NORTHFLANK.id,
			...(options.fetch ? { fetch: options.fetch } : {}),
			timeoutMs: CALL_MS,
			retry: { attempts: 3, baseMs: 1_000 },
			// A refusal's body is {error: {status, message, id, details}} (S ApiCallError); the status is the code.
			explain: ({ status, bytes, what }) => {
				const error = (jsonOf(bytes) as { error?: { message?: unknown; id?: unknown } } | null)?.error;
				const words = typeof error?.message === "string" && error.message !== "" ? `: ${error.message}` : "";
				return { message: `${what} answered ${status}${words}${typeof error?.id === "string" ? ` (Northflank error ${error.id})` : ""}` };
			},
		});
	}

	async #call(method: string, path: string, ctx: HostCall, init: RestInit = {}): Promise<{ status: number; body: unknown }> {
		const answer = orThrow(await this.#api.call(method, this.#api.url(`${this.#scope}${path}`), { timeoutMs: ctx.timeoutMs, ...init }, ctx.signal));
		return { status: answer.status, body: jsonOf(answer.bytes) };
	}

	/**
	 * POST .../services/deployment (D quickstart): the request's name, the plan of its size, the image with `sleep
	 * infinity` as its entrypoint and command, one instance, the packed labels as the workload's annotations, and the
	 * expiry at the backstop; then the quickstart's scale to one instance. The name is the id.
	 */
	async create(req: MachineRequest, ctx: HostCall): Promise<{ id: string }> {
		const plan = planOf(req.cpus, req.memoryMb);
		if (plan === undefined) throw new HostError("invalid", `no Northflank plan has ${req.cpus ?? "any"} vCPUs and ${req.memoryMb ?? "any"} MB`);
		const seconds = Math.ceil((Date.parse(req.backstopAt) - Date.now()) / 1000);
		const body = {
			name: req.name,
			billing: { deploymentPlan: plan },
			deployment: {
				instances: 1,
				external: { imagePath: req.image },
				docker: { configType: "customEntrypointCustomCommand", customEntrypoint: "/bin/sh", customCommand: "-c 'exec sleep infinity'" },
				metadata: { annotations: req.labels },
			},
			createOptions: { expiryTime: Math.min(MAX_EXPIRY_S, Math.max(MIN_EXPIRY_S, seconds)) },
		};
		this.#wrote();
		const { body: made } = await this.#call("POST", "/services/deployment", ctx, { json: body, named: true, retry: (status) => status === 429 });
		const id = (made as { data?: { id?: unknown } } | null)?.data?.id;
		const service = typeof id === "string" && SLUG.test(id) ? id : req.name;
		try {
			await this.#call("POST", `/services/${service}/scale`, ctx, { json: { instances: 1 }, retry: true });
		} catch (error) {
			// The service is made and billed: deleted here, its own bound and no caller's signal, before create answers.
			// Where that fails too it may be there, so the code is the vendor's, which the adapter sweeps the name on.
			try {
				await this.delete(service, { timeoutMs: CALL_MS });
			} catch (left) {
				throw new HostError("vendor", `${(error as Error).message}; the service ${service} it made may be left, its delete failed (${(left as Error).message})`);
			}
			throw error;
		}
		return { id: service };
	}

	/** A create or a delete: the listings' reads answer no get after it. */
	#wrote(): void {
		this.#writes += 1;
		this.#read.clear();
	}

	/** GET .../services/{id}; a 404 is none. A listing's read of it within LISTED_READ_MS answers once instead. */
	async get(id: string, ctx: HostCall): Promise<Machine | undefined> {
		const listed = this.#read.get(id);
		this.#read.delete(id);
		if (listed !== undefined && Date.now() - listed.at < LISTED_READ_MS) return listed.machine;
		return this.#get(id, ctx);
	}

	async #get(id: string, ctx: HostCall): Promise<Machine | undefined> {
		const read = await this.#call("GET", `/services/${serviceId(id)}`, ctx, { retry: true, accept: (status) => status === 404 || (status >= 200 && status < 300) });
		if (read.status === 404) return undefined;
		const service = (read.body as { data?: Service } | null)?.data;
		if (typeof service?.id !== "string") throw new HostError("vendor", `GET .../services/${id} answered no service`);
		return machineOf(service);
	}

	/**
	 * GET .../services, every page: the project's computers by name prefix, and the one whose id is the packed name when
	 * one is asked. A listing carries no annotations, so each computer it names is read by get for its labels, LIST_READS
	 * at a time; one gone between the two is left out, and the reads answer the adapter's own read of each that follows
	 * (#read). The adapter filters by the labels it asked.
	 */
	async list(labels: Record<string, string>, ctx: HostCall): Promise<Machine[]> {
		const name = labels[PACKED_NAME];
		const page = async (cursor?: string) => {
			const query = new URLSearchParams({ per_page: String(PAGE), ...(cursor ? { cursor } : {}) });
			const { body } = await this.#call("GET", `/services?${query}`, ctx, { retry: true });
			const read = body as { data?: { services?: Service[] }; pagination?: { hasNextPage?: boolean; cursor?: string } } | null;
			return ok({ items: read?.data?.services ?? [], ...(read?.pagination?.hasNextPage && read.pagination.cursor ? { next: read.pagination.cursor } : {}) });
		};
		const ids = orThrow(await allPages<Service>(page, 100, { vendor: NORTHFLANK.id, what: "GET .../services" }))
			.filter((service) => typeof service?.id === "string" && SLUG.test(service.id) && service.id.startsWith(NAME_PREFIX) && (name === undefined || service.id === name || service.name === name))
			.map((service) => service.id);
		const writes = this.#writes;
		const machines: Machine[] = [];
		for (let at = 0; at < ids.length; at += LIST_READS) {
			const reads = await Promise.all(ids.slice(at, at + LIST_READS).map((id) => this.#get(id, ctx)));
			for (const machine of reads) if (machine !== undefined) machines.push(machine);
		}
		if (this.#writes === writes) for (const machine of machines) this.#read.set(machine.id, { machine, at: Date.now() });
		return machines;
	}

	/** DELETE .../services/{id}, which ends its billing (D configure-and-manage-sandboxes); one Northflank no longer has is done. */
	async delete(id: string, ctx: HostCall): Promise<void> {
		this.#wrote();
		try {
			await this.#call("DELETE", `/services/${serviceId(id)}`, ctx, { retry: true, accept: (status) => status === 404 || (status >= 200 && status < 300) });
		} finally {
			this.#wrote();
		}
	}

	exec(id: string, argv: readonly string[], ctx: HostCall): Promise<MachineProcess> {
		return framedExec<Exec>(
			{
				start: (words, ctx) => this.#open(serviceId(id), words, ctx),
				events: (exec) => this.#events(exec),
				write: async (exec, text) => {
					const bytes = Buffer.from(text, "utf8");
					for (let at = 0; at < bytes.length; at += STDIN_BYTES) {
						if (exec.socket.readyState !== 1) throw new Error("the exec socket is closed");
						exec.socket.send(JSON.stringify({ type: "payload", data: bytes.subarray(at, at + STDIN_BYTES).toString("latin1") }));
						while (exec.socket.bufferedAmount > BACKLOG_BYTES && exec.socket.readyState === 1) await pause(5);
					}
				},
				end: async (exec) => {
					if (exec.socket.readyState === 1) exec.socket.send(JSON.stringify({ type: "stdInEnd" }));
				},
				// No kill: Northflank has none (S closes the socket alone), so framedExec runs argv under the pid wrapper.
			},
			argv,
			ctx,
		);
	}

	/**
	 * Opens the command-exec socket and sends its init: the token, argv as the command with no shell, as root, latin1, no
	 * tty. Answers once it is open. One that never opens says whether the service is there: a refused upgrade's status
	 * never reaches a WebSocket client.
	 */
	async #open(id: string, argv: readonly string[], ctx: HostCall): Promise<Exec> {
		const socket = this.#webSocket(`${this.#wsUrl}/v1/command-exec${this.#scope}/services/${id}`);
		const exec: Exec = { socket, queue: [], queued: 0, closed: false, wake: () => {} };
		const close = () => {
			if (socket.readyState < 2) socket.close(1000);
		};
		const push = (event: FramedEvent, bytes: number) => {
			if (exec.closed) return;
			exec.queue.push(event);
			exec.queued += bytes;
			if (exec.queued >= QUEUE_BYTES) {
				exec.failure ??= new Error(`the command's output not read passed ${QUEUE_BYTES / 1024 / 1024} MiB, so the exec ended: its reader stopped reading`);
				exec.queue.length = 0;
				exec.closed = true;
				close();
			}
			exec.wake();
		};
		// After the completion, output may still come: the exit is read once the socket closes, or DRAIN_MS after the last.
		const draining = () => {
			if (exec.exit === undefined) return;
			clearTimeout(exec.drain);
			exec.drain = setTimeout(close, DRAIN_MS);
		};
		let opened!: (failure?: Error) => void;
		const open = new Promise<Error | undefined>((done) => (opened = done));
		socket.addEventListener("open", () => {
			const context = { command: [...argv], shell: "none", user: "root", group: "root", encoding: "latin1", tty: false };
			socket.send(JSON.stringify({ type: "init", data: { auth: { type: "apiToken", apiToken: this.#token }, context } }));
			opened();
		});
		socket.addEventListener("message", ({ data }) => {
			const message = typeof data === "string" ? (jsonOf(Buffer.from(data)) as { type?: unknown; data?: unknown } | null) : null;
			const body = message?.data as { auth?: unknown; message?: unknown; exitCode?: unknown } | string | undefined;
			if ((message?.type === "stdOut" || message?.type === "stdErr") && typeof body === "string") {
				const bytes = Buffer.from(body, "latin1");
				push({ stream: message.type === "stdOut" ? "stdout" : "stderr", base64: bytes.toString("base64") }, bytes.length);
				draining();
			} else if (message?.type === "completion" && typeof body === "object" && typeof body?.exitCode === "number") {
				exec.exit = body.exitCode;
				draining();
			} else if (message?.type === "init" && typeof body === "object" && body?.auth !== "successful") {
				exec.failure ??= new HostError("denied", `Northflank refused the command on ${id}: ${typeof body?.message === "string" ? body.message : "no reason given"}`);
				close();
			} else if (message?.type === "error") {
				exec.failure ??= new HostError("vendor", `Northflank ended the command on ${id}: ${typeof body === "object" && typeof body?.message === "string" ? body.message : "no reason given"}`);
				close();
			}
		});
		socket.addEventListener("error", (event) => {
			exec.failure ??= new Error(`the exec socket failed${event.message ? `: ${event.message}` : ""}`);
			opened(exec.failure);
		});
		socket.addEventListener("close", ({ code }) => {
			exec.closed = true;
			clearTimeout(exec.drain);
			opened(new Error(`the exec socket closed before it opened (code ${code ?? "none"})`));
			exec.wake();
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		const bound = new Promise<Error>((done) => {
			timer = setTimeout(() => done(new HostError("timeout", `the exec socket of ${id} did not open within ${Math.round(ctx.timeoutMs / 1000)} s`)), ctx.timeoutMs);
			onAbort = () => done(new HostError("aborted", `the exec socket of ${id} was aborted`));
			if (ctx.signal?.aborted) onAbort();
			else ctx.signal?.addEventListener("abort", onAbort, { once: true });
		});
		const failed = await Promise.race([open, bound]).finally(() => {
			clearTimeout(timer);
			if (onAbort) ctx.signal?.removeEventListener("abort", onAbort);
		});
		if (failed === undefined) return exec;
		close();
		if (failed instanceof HostError) throw failed;
		if ((await this.get(id, { timeoutMs: CALL_MS })) === undefined) throw new HostError("not_found", `no Northflank service ${id}`);
		throw new HostError("vendor", `${failed.message} (service ${id})`);
	}

	/** The command's events as the socket gives them, then its exit once the socket closed; the socket closes after. */
	async *#events(exec: Exec): AsyncGenerator<FramedEvent> {
		try {
			for (;;) {
				const event = exec.queue.shift();
				if (event !== undefined) {
					if ("base64" in event) exec.queued -= Buffer.byteLength(event.base64, "base64");
					yield event;
					continue;
				}
				if (exec.closed) {
					if (exec.failure) throw exec.failure;
					if (exec.exit !== undefined) yield { exit: exec.exit };
					return;
				}
				await new Promise<void>((done) => (exec.wake = done));
			}
		} finally {
			clearTimeout(exec.drain);
			if (exec.socket.readyState < 2) exec.socket.close(1000);
		}
	}

	/** An image is a registry reference; a size is one of the plans', one field taking the other's match. */
	check(spec: Partial<ComputerSpec>): Refusal[] {
		const refusals: Refusal[] = [];
		const { image, cpus, memoryMb } = spec;
		if (typeof image === "string" && !IMAGE.test(image)) refusals.push({ field: "image", message: `a Northflank image is a registry reference, such as ${boxImageRef()}` });
		if ((cpus !== undefined || memoryMb !== undefined) && planOf(cpus as number | undefined, memoryMb as number | undefined) === undefined) {
			const sizes = PLANS.map((one) => `${one.cpus} vCPUs with ${one.memoryMb} MB`).join(", ");
			refusals.push({ field: cpus === undefined ? "memoryMb" : "cpus", message: `a Northflank computer has one of its plans' sizes: ${sizes}` });
		}
		return refusals;
	}
}

/**
 * Computers that are Northflank services in the customer's project, on the shared adapter: a sandbox from the box image
 * (or the spec's), no desktop.
 */
export class NorthflankProvider extends HostedProvider {
	/** The provider contract's prepareImage (its descriptor declares it): the box image's public tag. No call: Northflank pulls it at each create. */
	async prepareImage(): Promise<Result<string>> {
		return ok(boxImageRef());
	}

	constructor(options: NorthflankProviderOptions) {
		const { token, projectId, teamId, apiUrl = DEFAULT_API_URL, fetch, webSocket, maxLifetimeMs = MAX_LIFETIME_MS, timeouts = {}, ...rest } = options ?? ({} as NorthflankProviderOptions);
		if (typeof token !== "string" || token === "") throw new Error("options.token, a Northflank API token, is required: the provider reads no environment, so the caller passes it");
		if (typeof projectId !== "string" || !SLUG.test(projectId)) throw new Error(`options.projectId is required: the id of your Northflank project the computers live in (lowercase letters, digits and hyphens), not ${show(projectId)}`);
		if (teamId !== undefined && (typeof teamId !== "string" || !SLUG.test(teamId))) throw new Error(`options.teamId, for an organisation token, is the team's id (lowercase letters, digits and hyphens), not ${show(teamId)}`);
		super(
			new NorthflankHost({
				token,
				projectId,
				...(teamId === undefined ? {} : { teamId }),
				apiUrl: httpsBase(apiUrl, "the Northflank API URL"),
				...(fetch ? { fetch } : {}),
				webSocket: webSocket ?? ((url) => new WebSocket(url) as unknown as NorthflankSocket),
			}),
			{ ...rest, maxLifetimeMs, timeouts: { ...NORTHFLANK_TIMEOUTS, ...timeouts } },
		);
	}
}
