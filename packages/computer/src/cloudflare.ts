// The Cloudflare host: a Linux sandbox in a Cloudflare Container, in the operator's account. Only a Durable Object starts
// a container, so the operator deploys our relay Worker once (relays/cloudflare) and this host calls its routes with the
// relay's token. A container boots the box image the relay was built FROM with MachineRequest.boot.env and runs
// agentrun-dial (facts.connect "dial"); nothing reaches into it. No extend: the janitor and init's deadline end it, and
// the relay's alarm keeps a quiet container up hourly and destroys it at backstopAt. Unverified until the live run: the
// alarm holding a quiet container past an hour, outbound wss://, and the container ending once agentrun-dial exits.
import { CLOUDFLARE, CLOUDFLARE_RELAY_VERSION } from "./descriptors/cloudflare.js";
import { DEFAULT_CPUS, DEFAULT_MEMORY_MB, show } from "./drift.js";
import { type HostCall, HostError, type HostFacts, type Machine, type MachineHost, type MachineRequest } from "./host.js";
import { orThrow } from "./hosted/process.js";
import { HostedProvider, type HostedOptions, type HostedTimeouts } from "./hosted/provider.js";
import { httpsBase, jsonOf, type Rest, type RestInit, rest } from "./hosted/rest.js";
import { dateOf } from "./hosted/values.js";
import type { CallContext, ComputerSpec, Refusal } from "./provider.js";
import { fail, ok, type Result } from "./result.js";
import { connectionError } from "./test-connection.js";

/** A computer as the relay answers one (relays/cloudflare/src/index.ts). */
interface RelayRow {
	name: string;
	labels?: Record<string, string>;
	image?: string;
	createdAt?: string;
	state: string;
	why?: string;
}

/** The Cloudflare provider's options: the relay's address and token, then the shared adapter's (HostedOptions), kind among them. */
export interface CloudflareProviderOptions extends Omit<HostedOptions, "desktop" | "maxLifetimeMs"> {
	/** The relay Worker's https address, as `wrangler deploy` printed it. */
	relayUrl: string;
	/** The relay's RELAY_TOKEN (`wrangler secret put RELAY_TOKEN`). The caller passes it; this provider reads no environment. */
	relayToken: string;
	/** The fetch every call goes through; default the global one. */
	fetch?: typeof fetch;
	/** For tests: the pause before a request is tried again, given its ms and the call's signal. Default a timer. */
	pause?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** The longest lifetime check takes, in ms: at most 24 h, the janitor's cap, which is the default. */
	maxLifetimeMs?: number;
	timeouts?: Partial<HostedTimeouts>;
}

const NAME = /^computer-[0-9a-f]{12}$/;
/** Cloudflare never ends a container on a timer we set (lifetime page): the janitor's cap is ours, a day, as Fly's. */
const MAX_LIFETIME_MS = 24 * 60 * 60_000;
/** The named instance types start() takes, smallest first (developers.cloudflare.com/containers/platform-details/limits/). */
const INSTANCES = [
	{ name: "standard-1", cpus: 0.5, memoryMb: 4096 },
	{ name: "standard-2", cpus: 1, memoryMb: 6144 },
	{ name: "standard-3", cpus: 2, memoryMb: 8192 },
	{ name: "standard-4", cpus: 4, memoryMb: 12288 },
];
const LARGEST = INSTANCES[INSTANCES.length - 1];
/** A create waits for the image's first pull in Cloudflare's registry, then the daemon's fetch and the dial. */
const CLOUDFLARE_TIMEOUTS: Partial<HostedTimeouts> = { createMs: 600_000 };

/** The smallest instance that holds the size: the adapter's default size when the spec gives none. */
const instanceOf = (cpus = DEFAULT_CPUS, memoryMb = DEFAULT_MEMORY_MB) => INSTANCES.find((one) => one.cpus >= cpus && one.memoryMb >= memoryMb);

function machineOf(row: RelayRow): Machine {
	const known = row.state === "starting" || row.state === "running" || row.state === "gone";
	const created = dateOf(row.createdAt);
	const why = known ? row.why : `the relay reads the computer's state ${show(row.state)}, which this provider does not know`;
	return {
		id: row.name,
		labels: { ...(row.labels ?? {}) },
		...(typeof row.image === "string" ? { image: row.image } : {}),
		state: known ? (row.state as Machine["state"]) : "gone",
		...(created ? { createdAt: created } : {}),
		...(why ? { why } : {}),
	};
}

/** A computer's name held to the relay's form before it reaches a path: not_found else. */
function nameOf(id: string): string {
	if (!NAME.test(id)) throw new HostError("not_found", `${JSON.stringify(id)} is not a computer of the Cloudflare relay`);
	return id;
}

/** Cloudflare's containers, through the relay, as a dial MachineHost (../host.ts): no exec, no upload, no extend. */
class CloudflareHost implements MachineHost {
	readonly descriptor = CLOUDFLARE;
	readonly facts: HostFacts = {
		// agentrun-dial starts init as a child of the container's main process; nothing is started through exec.
		daemon: "child",
		// containers/platform-details/architecture: "Each container instance runs in a Firecracker microVM with its own
		// kernel and network".
		isolation: "microvm",
		lifetime: "janitor",
		maxLifetimeMs: MAX_LIFETIME_MS,
		// The same page: images "should be built for the linux/amd64 architecture", as the box image is.
		arch: "amd64",
		// No page names an agent of Cloudflare's inside the container (unverified).
		vendorAgentPorts: [],
		// The relay's image is FROM the box image (relays/cloudflare/Dockerfile), which has xfwm4 (box/install.sh's desktop step).
		windowManager: true,
		// Its descriptor's (connectOf): the container dials the server.
		connect: CLOUDFLARE.connect,
	};
	readonly relayUrl: string;
	readonly #client: Rest;

	constructor(options: { relayUrl: string; relayToken: string; fetch: typeof fetch; pause?: (ms: number, signal?: AbortSignal) => Promise<void> }) {
		this.relayUrl = options.relayUrl;
		this.#client = rest({
			base: options.relayUrl,
			headers: () => ({ Authorization: `Bearer ${options.relayToken}`, Accept: "application/json" }),
			vendor: CLOUDFLARE.id,
			fetch: options.fetch,
			timeoutMs: 30_000,
			retry: { attempts: 4, baseMs: 1_000, ...(options.pause ? { pause: options.pause } : {}) },
			// The relay's refusals are { error } in words.
			explain: ({ status, bytes, what }) => {
				const said = (jsonOf(bytes) as { error?: unknown } | null)?.error;
				return { message: `${what} answered ${status}${typeof said === "string" && said !== "" ? `: ${said}` : ""}` };
			},
		});
	}

	/** One call to the relay, bounded by ctx: its JSON answer (null for none), or a HostError in the relay's words. */
	async #call(method: "GET" | "POST" | "DELETE", path: string, init: RestInit, ctx: HostCall): Promise<unknown> {
		return jsonOf(orThrow(await this.#client.call(method, this.#client.url(path), { ...init, timeoutMs: ctx.timeoutMs }, ctx.signal)).bytes);
	}

	/** GET /v1/health: the relay's version and the box image it starts; another version is refused, with how to redeploy. */
	async health(signal?: AbortSignal): Promise<Result<{ image: string }>> {
		const read = await this.#client.json("GET", this.#client.url("/v1/health"), { retry: true }, signal);
		if (!read.ok) return { ok: false, error: connectionError(read.error) };
		const { version, image } = (read.value ?? {}) as { version?: unknown; image?: unknown };
		if (version !== CLOUDFLARE_RELAY_VERSION) {
			return fail("refused", `the relay at ${this.relayUrl} speaks version ${show(version)}, and this server speaks ${CLOUDFLARE_RELAY_VERSION}: redeploy it from this release's packages/computer/relays/cloudflare (npx wrangler deploy)`);
		}
		if (typeof image !== "string" || image === "") return fail("vendor", `the relay at ${this.relayUrl} names no image it starts`);
		return ok({ image });
	}

	/** A size start() has an instance for: standard-4 is Cloudflare's largest. */
	check(spec: Partial<ComputerSpec>): Refusal[] {
		const { cpus, memoryMb } = spec;
		const message = `a Cloudflare container has at most ${LARGEST.cpus} vCPUs and ${LARGEST.memoryMb} MiB (${LARGEST.name}, its largest): ask for less`;
		const positive = (value: unknown) => typeof value === "number" && value > 0;
		return [
			...(cpus !== undefined && !(positive(cpus) && cpus <= LARGEST.cpus) ? [{ field: "cpus", message }] : []),
			...(memoryMb !== undefined && !(positive(memoryMb) && memoryMb <= LARGEST.memoryMb) ? [{ field: "memoryMb", message }] : []),
		];
	}

	/**
	 * POST /v1/computers: the relay starts the container of the request's name with the boot env, the instance the size
	 * picks, and backstopAt, its alarm's end. The name is the relay's id, so a create of a name it has answers that one.
	 */
	async create(req: MachineRequest, ctx: HostCall): Promise<{ id: string }> {
		if (req.boot === undefined) throw new HostError("invalid", "a Cloudflare container dials the server, and the request has no boot env for it");
		// check() refused a size past the largest, so one instance holds it.
		const instance = instanceOf(req.cpus, req.memoryMb) ?? LARGEST;
		const body = { name: nameOf(req.name), image: req.image, env: req.boot.env, labels: req.labels, instance: instance.name, backstopAt: req.backstopAt };
		// A 429 made nothing. A 500, 502 or 503 may have made the container, and sending it again is still safe: the relay's
		// Computer object of this name answers a second create with the first's row and starts nothing twice. A create that
		// got no answer is not sent again: the adapter deletes the name it asked for.
		const made = (await this.#call("POST", "/v1/computers", { json: body, named: true, retry: (status) => [429, 500, 502, 503].includes(status) }, ctx)) as RelayRow | null;
		if (made?.name !== req.name) throw new HostError("vendor", `POST /v1/computers answered another computer: ${show(made?.name)}`);
		return { id: made.name };
	}

	/** GET /v1/computers/{name}; 404 is not_found, which the adapter reads as none. */
	async get(id: string, ctx: HostCall): Promise<Machine | undefined> {
		return machineOf((await this.#call("GET", `/v1/computers/${nameOf(id)}`, { retry: true }, ctx)) as RelayRow);
	}

	/** GET /v1/computers?{label}={value}: the relay's index, every row with all the labels, in one answer. */
	async list(labels: Record<string, string>, ctx: HostCall): Promise<Machine[]> {
		const query = new URLSearchParams(Object.entries(labels)).toString();
		const listed = (await this.#call("GET", `/v1/computers${query === "" ? "" : `?${query}`}`, { retry: true }, ctx)) as { computers?: unknown } | null;
		if (!Array.isArray(listed?.computers)) throw new HostError("vendor", "GET /v1/computers answered no computers");
		return (listed.computers as RelayRow[]).filter((one) => typeof one?.name === "string").map(machineOf);
	}

	/** DELETE /v1/computers/{name}: the relay destroys the container and drops its row; one already gone is done too. */
	async delete(id: string, ctx: HostCall): Promise<void> {
		await this.#call("DELETE", `/v1/computers/${nameOf(id)}`, { retry: true }, ctx);
	}
}

/** A CloudflareProvider from its options alone; it reads no environment (serve passes its CLOUDFLARE_RELAY_* keys). */
export function create(options: CloudflareProviderOptions): CloudflareProvider {
	return new CloudflareProvider(options);
}

/** The conformance CLI's module for Cloudflare: its settings, and its dialKit that refuses off the public server. */
export const conformance = () => import("./conformance/cloudflare.js");

/**
 * Computers that are Cloudflare Containers, through the operator's relay, each dialing the server that made it: a server
 * with no public https address (AGENTRUN_PUBLIC_URL) refuses a create in words before the relay is called. Kind linux
 * (default) or desktop, whose X server and window manager start through computerd over the socket the container dialed.
 */
export class CloudflareProvider extends HostedProvider {
	readonly #relay: CloudflareHost;

	constructor(options: CloudflareProviderOptions) {
		const { relayUrl, relayToken, fetch: fetcher = globalThis.fetch, pause, timeouts = {}, ...rest } = options ?? ({} as CloudflareProviderOptions);
		if (typeof relayToken !== "string" || relayToken === "") throw new Error("options.relayToken, the relay's RELAY_TOKEN, is required: the provider reads no environment, so the caller passes it");
		if (typeof relayUrl !== "string" || relayUrl === "") throw new Error("options.relayUrl, the relay Worker's https address as wrangler deploy printed it, is required");
		const base = httpsBase(relayUrl, "the Cloudflare relay URL");
		if (typeof fetcher !== "function") throw new Error("options.fetch must be a function, as the global fetch is");
		if (pause !== undefined && typeof pause !== "function") throw new Error("options.pause must be a function");
		const host = new CloudflareHost({ relayUrl: base, relayToken, fetch: fetcher, ...(pause ? { pause } : {}) });
		super(host, { ...rest, timeouts: { ...CLOUDFLARE_TIMEOUTS, ...timeouts } });
		this.#relay = host;
	}

	/** The provider contract's prepareImage (its descriptor declares it): the box image the relay was deployed FROM. */
	async prepareImage({ signal }: CallContext = {}): Promise<Result<string>> {
		const health = await this.#relay.health(signal);
		return health.ok ? ok(health.value.image) : health;
	}

	/** Settings' test: the relay's health and version, then one list by the adapter's label, which makes nothing. */
	async testConnection(context: CallContext = {}): Promise<Result<{ detail: string }>> {
		const health = await this.#relay.health(context.signal);
		return health.ok ? super.testConnection(context) : health;
	}
}
