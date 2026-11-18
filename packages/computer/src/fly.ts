// The Fly Machines host: a Linux sandbox on a Fly Machine in the operator's Fly app, over the Machines REST API
// (https://api.machines.dev, a Bearer token). Fly's exec answers once its command ends (docs.machines.dev/machines/Machines_exec:
// stdout, stderr and exit_code), which can't carry the stdio bridge, so this host has none: its machines dial the server
// (facts.connect "dial"). The machine boots the box image with MachineRequest.boot.env, whose CMD runs agentrun-dial
// while AGENTRUN_ATTACH_URL is set (box/Dockerfile): it fetches the server's computerd, checks its sha256, starts init and
// dials the attach route with the machine's own token. The rest of the computer is the shared machine-host adapter's
// (./hosted/provider.ts).
//
// Every vendor fact below cites the page it is from; one the docs don't settle says unverified, and the live Core run
// (packages/serve/scripts/dial-conformance.mjs) is what settles it. Pages: M = docs.fly.io/machines/api/machines-resource,
// S = docs.fly.io/machines/machine-states, W = docs.fly.io/machines/api/working-with-machines-api, and fly-go, Fly's own
// Go client (github.com/superfly/fly-go: machine_types.go, flaps/flaps.go).
import { boxImageRef } from "./box-image.js";
import { FLY } from "./descriptors/fly.js";
import { DEADLINE_LABEL, DEFAULT_CPUS, DEFAULT_MEMORY_MB, show } from "./drift.js";
import { type HostCall, HostError, type HostFacts, type Machine, type MachineHost, type MachineRequest } from "./host.js";
import { orThrow } from "./hosted/process.js";
import { HostedProvider, type HostedOptions, type HostedTimeouts } from "./hosted/provider.js";
import { jsonOf, type Rest, type RestInit, rest } from "./hosted/rest.js";
import { dateOf, isWhole } from "./hosted/values.js";
import type { ComputerSpec, Refusal } from "./provider.js";
import { ok, type Result } from "./result.js";

/** One machine as the Machines API answers it (M, "Machine properties"; fly-go Machine), as far as this host reads it. */
export interface FlyMachine {
	id: string;
	state: string;
	created_at?: string;
	config?: { metadata?: Record<string, string> | null } | null;
	/** fly-go: the config rebuilt in part while host_status isn't "ok". */
	incomplete_config?: { metadata?: Record<string, string> | null } | null;
}

/** The Fly provider's options: the token and the app, then the shared adapter's (HostedOptions), kind among them. */
export interface FlyProviderOptions extends Omit<HostedOptions, "desktop" | "maxLifetimeMs"> {
	/** A Fly API token that may make machines in the app. The caller passes it; this provider reads no environment. */
	apiToken: string;
	/** The Fly app the machines live in, made by the operator beforehand (fly apps create). */
	app: string;
	/** The fetch every call goes through; default the global one. */
	fetch?: typeof fetch;
	/** The longest lifetime check takes, in ms: at most 24 h, the janitor's cap, which is the default. */
	maxLifetimeMs?: number;
	timeouts?: Partial<HostedTimeouts>;
}

/** The Machines API (W: "https://api.machines.dev"). */
const API_URL = "https://api.machines.dev";
/** An app name: Fly's are lowercase letters, digits and hyphens (unverified: W names no rule, only a taken name's 422). */
const APP = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A machine id, held to letters and digits before it reaches a path (M's examples are 14 hex digits). */
const MACHINE_ID = /^[A-Za-z0-9]{1,64}$/;
/** Fly never ends a machine on a timer of its own (M names none), so the janitor's cap is ours: a day, as Agent37's. */
const MAX_LIFETIME_MS = 24 * 60 * 60_000;
/** Shared CPUs a machine takes (fly-go MachineGuest: "1, 2, 4, 6, 8 ... up to 8 for shared"). */
const SHARED_CPUS = [1, 2, 4, 6, 8];
/** fly-go MachineGuest: memory "a multiple of 256 for shared ... between 256 and 2048 (shared) ... per CPU". */
const MEMORY_STEP_MB = 256;
const MEMORY_PER_CPU_MB = { least: 256, most: 2048 };
/**
 * A create pulls the box image before the machine runs, and the machine then fetches its daemon and dials: the wait for
 * its socket is createMs too. Fly's delete stops the machine first (force).
 */
const FLY_TIMEOUTS: Partial<HostedTimeouts> = { createMs: 600_000, goneMs: 120_000 };
/** W: "1 request, per second, per action", bursts to 3: a 429 is sent again after 1, 2 and 4 s. */
const RETRY = { attempts: 4, baseMs: 1_000 };

/**
 * Fly's states (S) as the adapter's. created and the transient ones on the way to started are starting; stopped,
 * suspended and archived machines and those on their way there are stopped (listed, so the janitor ends them);
 * destroying, failed and launch_failed are gone. destroyed, replaced and migrated are records of machines that are no
 * more: undefined, as get and list answer none for them.
 */
function stateOf(state: string): Machine["state"] | undefined | null {
	if (state === "started") return "running";
	if (["created", "creating", "starting", "restarting", "updating", "replacing"].includes(state)) return "starting";
	if (["stopping", "stopped", "suspending", "suspended", "archived"].includes(state)) return "stopped";
	if (["destroying", "failed", "launch_failed"].includes(state)) return "gone";
	if (["destroyed", "replaced", "migrated"].includes(state)) return null;
	return undefined;
}

/** A machine as the adapter reads one; undefined for a record of one destroyed. */
function machineOf(found: FlyMachine): Machine | undefined {
	const state = stateOf(found.state);
	if (state === null) return undefined;
	const config = found.config ?? found.incomplete_config ?? {};
	const created = dateOf(found.created_at);
	const why =
		state === undefined
			? `Fly reads the machine's state ${show(found.state)}, which this provider does not know`
			: found.state === "failed" || found.state === "launch_failed"
				? `Fly reads the machine ${found.state}: it could not start (see fly machine status ${found.id})`
				: undefined;
	return {
		id: found.id,
		labels: { ...(config.metadata ?? {}) },
		state: state ?? "gone",
		...(created ? { createdAt: created } : {}),
		...(why ? { why } : {}),
	};
}

/** An id held to Fly's form before it reaches a path: not_found else. */
function machineId(id: string): string {
	if (!MACHINE_ID.test(id)) throw new HostError("not_found", `${JSON.stringify(id)} is not a Fly machine id`);
	return id;
}

/** Fly Machines as a dial MachineHost (../host.ts): no exec, no upload. */
class FlyHost implements MachineHost {
	readonly descriptor = FLY;
	readonly facts: HostFacts = {
		// agentrun-dial starts init as a child of the machine's main process; nothing is started through exec.
		daemon: "child",
		// docs.fly.io/machines/overview: "Fly Machines are fast-launching VMs"; Firecracker microVMs (unverified: the
		// Machines pages don't name the hypervisor).
		isolation: "microvm",
		lifetime: "janitor",
		maxLifetimeMs: MAX_LIFETIME_MS,
		// The box image is built for amd64 alone (release.yml's box job); Fly runs it on x86-64 hosts (unverified: no page
		// names an arch; docs.fly.io/machines/overview's own `uname -a` shows x86_64).
		arch: "amd64",
		// Unverified: Fly's init runs hallpass, the SSH server `fly ssh console` reaches, on port 22 of the machine's private
		// address. Declared, so isolation.vendor-agent checks the computer's programs reach none of it.
		vendorAgentPorts: [22],
		// The box image has xfwm4 (box/install.sh's desktop step): a desktop's apps are framed and focused.
		windowManager: true,
		// The machine dials the server: Fly's exec answers once the command ends (docs.machines.dev, Machines_exec), so
		// there is no exec and no upload here.
		connect: "dial",
	};
	readonly #client: Rest;
	readonly #app: string;

	constructor(options: { apiToken: string; app: string; fetch: typeof fetch }) {
		this.#app = options.app;
		this.#client = rest({
			base: API_URL,
			// M, W: "Authorization: Bearer <fly_api_token>".
			headers: () => ({ Authorization: `Bearer ${options.apiToken}`, Accept: "application/json" }),
			vendor: FLY.id,
			fetch: options.fetch,
			timeoutMs: 30_000, // every call gives its own: ctx.timeoutMs
			retry: RETRY,
			// fly-go flaps.go handleAPIError: an error's body is { error, message? }; M and W show none.
			explain: ({ status, bytes, what }) => {
				const body = jsonOf(bytes) as { error?: unknown; message?: unknown } | null;
				const said = [body?.error, body?.message].filter((part): part is string => typeof part === "string" && part !== "");
				return { message: `${what} answered ${status}${said.length > 0 ? `: ${said.join(": ")}` : ""}` };
			},
		});
	}

	/** One call under /v1/apps/{app}/machines, bounded by ctx: its JSON answer (null for none), or a HostError in Fly's words. */
	async #call(method: "GET" | "POST" | "DELETE", path: string, init: RestInit, ctx: HostCall): Promise<unknown> {
		const answer = orThrow(await this.#client.call(method, this.#client.url(`/v1/apps/${this.#app}/machines${path}`), { ...init, timeoutMs: ctx.timeoutMs }, ctx.signal));
		return jsonOf(answer.bytes);
	}

	/**
	 * Any image name a registry path can be (M: config.image, "registry-1.docker.io/library/ubuntu:latest"), and a size
	 * of shared CPUs (fly-go MachineGuest).
	 */
	check(spec: Partial<ComputerSpec>): Refusal[] {
		const refusals: Refusal[] = [];
		const { image, cpus, memoryMb } = spec;
		if (typeof image === "string" && (image.startsWith("-") || /\s/.test(image))) refusals.push({ field: "image", message: "an image is a registry path Fly can pull, such as ghcr.io/parcha-ai/agentrun-box:<tag>" });
		if (cpus !== undefined && !SHARED_CPUS.includes(cpus as number)) refusals.push({ field: "cpus", message: `a Fly machine has ${SHARED_CPUS.join(", ")} shared CPUs` });
		const each = typeof cpus === "number" && SHARED_CPUS.includes(cpus) ? cpus : DEFAULT_CPUS;
		const least = MEMORY_PER_CPU_MB.least * each;
		const most = MEMORY_PER_CPU_MB.most * each;
		if (memoryMb !== undefined && !(isWhole(memoryMb) && memoryMb % MEMORY_STEP_MB === 0 && memoryMb >= least && memoryMb <= most)) {
			refusals.push({ field: "memoryMb", message: `a Fly machine of ${each} shared CPUs has a multiple of ${MEMORY_STEP_MB} MiB from ${least} to ${most}` });
		}
		return refusals;
	}

	/**
	 * POST /v1/apps/{app}/machines (M, "Create a Machine"): the request's name, the image, the boot env as config.env,
	 * the labels as config.metadata, a shared-CPU guest of the spec's size, restart policy "no" and auto_destroy, so the
	 * machine is destroyed once its main process ends: agentrun-dial's computerd attach, which exits once init has ended
	 * at its deadline (daemon internal/attach). Unverified: that a public ghcr.io image pulls with no registry login (M's
	 * example is Docker Hub's), and that Fly's init runs the image's CMD when config.init sets none. No service: Fly's proxy
	 * routes nothing to the machine. No region: Fly picks one (M: "near your WireGuard peer"; unverified from outside one).
	 * Unverified: whether Fly refuses a taken name, and with what status; a 409 reads exists. Unverified: any bound on
	 * metadata keys or values (M names none).
	 */
	async create(req: MachineRequest, ctx: HostCall): Promise<{ id: string }> {
		if (req.boot === undefined) throw new HostError("invalid", "a Fly machine dials the server, and the request has no boot env for it");
		// With no memory asked for, the default, or the most the CPUs take when that is less (one shared CPU: 2048 MiB).
		const cpus = req.cpus ?? DEFAULT_CPUS;
		const memoryMb = req.memoryMb ?? Math.min(DEFAULT_MEMORY_MB, MEMORY_PER_CPU_MB.most * cpus);
		const made = (await this.#call(
			"POST",
			"",
			{
				json: {
					name: req.name,
					config: {
						image: req.image,
						env: req.boot.env,
						metadata: req.labels,
						guest: { cpu_kind: "shared", cpus, memory_mb: memoryMb },
						restart: { policy: "no" },
						auto_destroy: true,
					},
				},
				named: true,
				// Only a 429, a refusal that made nothing, is sent again: a create that got no answer may have made a machine.
				retry: (status) => status === 429,
			},
			ctx,
		)) as FlyMachine | null;
		if (typeof made?.id !== "string" || !MACHINE_ID.test(made.id)) throw new HostError("vendor", `POST /v1/apps/${this.#app}/machines answered no machine id: ${show(made?.id)}`);
		return { id: made.id };
	}

	/** GET /v1/apps/{app}/machines/{id} (M, "Get a Machine"); 404 is not_found, which the adapter reads as none. */
	async get(id: string, ctx: HostCall): Promise<Machine | undefined> {
		return machineOf((await this.#call("GET", `/${machineId(id)}`, { retry: true }, ctx)) as FlyMachine);
	}

	/**
	 * GET /v1/apps/{app}/machines?metadata.{key}={value} for each label (M, "List Machines": "filters by metadata pair"),
	 * one answer, a list with no page; destroyed machines are left out unless include_deleted is asked. Unverified: that a
	 * key holding dots (agentrun.computer.run) filters as itself; the adapter keeps those whose get carries every label.
	 */
	async list(labels: Record<string, string>, ctx: HostCall): Promise<Machine[]> {
		const query = new URLSearchParams(Object.entries(labels).map(([key, value]) => [`metadata.${key}`, value])).toString();
		const listed = await this.#call("GET", query === "" ? "" : `?${query}`, { retry: true }, ctx);
		if (!Array.isArray(listed)) throw new HostError("vendor", `GET /v1/apps/${this.#app}/machines answered no list`);
		return (listed as FlyMachine[]).filter((one) => typeof one?.id === "string").flatMap((one) => machineOf(one) ?? []);
	}

	/** DELETE /v1/apps/{app}/machines/{id}?force=true (M: "Force stop the Machine if running"); a 404 is done to the adapter. */
	async delete(id: string, ctx: HostCall): Promise<void> {
		await this.#call("DELETE", `/${machineId(id)}?force=true`, { retry: true }, ctx);
	}

	/**
	 * The janitor's deadline label moved: POST /v1/apps/{app}/machines/{id}/metadata/{key} { value } (M, "Add or update a
	 * metadata key-value pair", 204), that one key alone, so no other label is written. Unverified: that it does not
	 * restart a running machine, as M says a config update does.
	 */
	async extend(id: string, endsAt: Date, ctx: HostCall): Promise<void> {
		await this.#call("POST", `/${machineId(id)}/metadata/${encodeURIComponent(DEADLINE_LABEL)}`, { json: { value: endsAt.toISOString() }, retry: true }, ctx);
	}
}

/** A FlyProvider from its options alone; it reads no environment (serve passes the saved FLY_API_TOKEN and FLY_APP). */
export function create(options: FlyProviderOptions): FlyProvider {
	return new FlyProvider(options);
}

/** The conformance CLI's module for Fly Machines: its settings, and its dialKit that refuses off the public server. */
export const conformance = () => import("./conformance/fly.js");

/**
 * Computers that are Fly Machines, on the shared adapter, each dialing the server that made it: a server with no public
 * https address (AGENTRUN_PUBLIC_URL) refuses a create in words before Fly is called. Kind linux (default) or desktop,
 * whose X server and window manager start through computerd over the socket the machine dialed.
 */
export class FlyProvider extends HostedProvider {
	/**
	 * The provider contract's prepareImage (its descriptor declares it): the box image the release publishes, by its
	 * public registry tag (box-image.ts). No call: Fly pulls config.image at each create.
	 */
	async prepareImage(): Promise<Result<string>> {
		return ok(boxImageRef());
	}

	constructor(options: FlyProviderOptions) {
		const { apiToken, app, fetch: fetcher = globalThis.fetch, timeouts = {}, ...rest } = options ?? ({} as FlyProviderOptions);
		if (typeof apiToken !== "string" || apiToken === "") throw new Error("options.apiToken, a Fly API token, is required: the provider reads no environment, so the caller passes it");
		if (typeof app !== "string" || !APP.test(app)) throw new Error(`options.app is the name of the Fly app its machines live in (lowercase letters, digits and hyphens), not ${JSON.stringify(app)}`);
		if (typeof fetcher !== "function") throw new Error("options.fetch must be a function, as the global fetch is");
		super(new FlyHost({ apiToken, app, fetch: fetcher }), { ...rest, timeouts: { ...FLY_TIMEOUTS, ...timeouts } });
	}
}
