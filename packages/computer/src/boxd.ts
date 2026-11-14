// The boxd host: boxd machines (KVM microVMs, Ubuntu 24.04) as a MachineHost, through the host's own @boxd-sh/sdk, of
// which this file names only the slice it calls (every fact from 0.3.1's dist/*.d.ts) and imports nothing at load.
// boxd's agent runs every command in a machine, so computerd is a child. The daemon, the bridge, the probe, idempotent
// create, extend and delete-then-wait-gone are the shared adapter's (./hosted/provider.ts).
import { BOXD, BOXD_DEFAULT_IMAGE } from "./descriptors/boxd.js";
import type { HostCall, HostFacts, Machine, MachineHost, MachineProcess, MachineRequest } from "./host.js";
import { HostedProvider, type HostedOptions, IMAGE_LABEL, MAX_LABEL, NAME_LABEL } from "./hosted/provider.js";
import { shellLine } from "./hosted/scripts.js";
import type { KindCapabilities } from "./kinds.js";
import type { MountKind } from "./mount.js";
import type { ComputerSpec, NetworkPolicy, Refusal } from "./provider.js";
import { type ComputerErrorCode, ok, type Result } from "./result.js";

/** A machine as the SDK reports it (Machine, models.d.ts), as far as this host reads it. */
export interface BoxdMachine {
	id: string;
	name: string;
	status: string;
	labels: Record<string, string>;
	egressAllow: string[];
	/** Seconds of idleness before standby, hibernation and destruction; 0 is never. */
	idle: { suspendAfter: number; hibernateAfter: number; destroyAfter: number };
	resources: { vcpu: number; memoryBytes: number };
	networking: { isolated: boolean };
	org: { id: string; name: string } | null;
	deleteAt: Date | null;
	source?: { kind: string; name: string } | null;
}

/** A streamed exec (ExecStream, exec.d.ts): stdout is the stream itself. */
export interface BoxdExecStream extends AsyncIterable<Uint8Array> {
	readonly stderr: AsyncIterable<Uint8Array>;
	write(data: Uint8Array): void;
	end(): void;
	wait(): Promise<number>;
	close(): void;
}

/** The SDK's machines namespace, as far as this host calls it (Machines, machines.d.ts). */
export interface BoxdMachines {
	/** deleteAfter: seconds from now until boxd deletes the machine, whatever it is doing. */
	create(params: { name: string; org?: string; labels: Record<string, string>; isolated: true; config: { autoSuspendTimeout: 0; vcpu?: number; memory?: string }; fromSnapshot?: string; deleteAfter?: number }): Promise<BoxdMachine>;
	get(id: string): Promise<BoxdMachine>;
	list(params: { org?: string; labels: Record<string, string> }): Promise<Iterable<BoxdMachine>>;
	delete(id: string): Promise<void>;
	streamExec(id: string, params: { command: string }): BoxdExecStream;
	readonly files: { upload(id: string, path: string, data: Uint8Array): Promise<number> };
	waitUntilReady(id: string, params: { timeout: number }): Promise<BoxdMachine>;
	setEgressAllow(id: string, entries: string[]): Promise<string[]>;
	setAutoHibernateTimeout(id: string, seconds: number): Promise<void>;
	updateLabels(id: string, params: { set: Record<string, string> }): Promise<Record<string, string>>;
}

/** The SDK's Boxd class: given the key, the address and the region ("" is home) so it reads none from the environment. */
export type BoxdClientClass = new (options: { apiKey: string; baseURL: string; region: string; timeout: number; maxRetries?: number }) => { readonly machines: BoxdMachines };

export interface BoxdProviderOptions extends Omit<HostedOptions, "label"> {
	/** The boxd API key: the caller passes it; the provider never reads it from the environment or puts it in a computer. */
	apiKey: string;
	Boxd: BoxdClientClass;
	/** The org (name or id) machines are made in and listed from. Unset: the key's own. */
	org?: string;
	/** "fra", "nyc", ... Unset: the API's home region. */
	region?: string;
	/** Default https://boxd.sh:9443, the SDK's own. */
	baseUrl?: string;
	/** A boxd size, both or neither: 1 and 4G, 2 and 8G, 4 and 16G, 8 and 32G. Unset: the org's default. */
	vcpu?: number;
	memory?: string;
	/** A backstop: boxd deletes each machine 5 minutes past the most it may live, whatever the janitor does. */
	deleteTimer?: boolean;
}

export type BoxdOptions = Omit<BoxdProviderOptions, "Boxd"> & { Boxd?: BoxdClientClass };

/** Not a literal, so no type checker or bundler resolves the SDK from this package. */
const BOXD_PACKAGE: string = "@boxd-sh/sdk";

/** A BoxdProvider from its options alone; throws in words when the key is missing, never echoing one. */
export async function create(options: BoxdOptions): Promise<BoxdProvider> {
	const { apiKey, Boxd: given, ...rest } = options ?? ({} as BoxdOptions);
	if (typeof apiKey !== "string" || apiKey === "") throw new Error("options.apiKey, the boxd API key, is required: the provider reads no environment, so the caller passes it");
	const Boxd = given ?? ((await import(BOXD_PACKAGE)) as { Boxd: BoxdClientClass }).Boxd;
	return new BoxdProvider({ ...rest, apiKey, Boxd });
}

/** The conformance CLI's module for boxd. */
export const conformance = () => import("./conformance/boxd.js");

export const MOUNT: readonly MountKind[] = BOXD.mounts;
export const CAPABILITIES: readonly KindCapabilities[] = BOXD.capabilities;

const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_BASE_URL = "https://boxd.sh:9443";
/** The adapter's default requestMs and createMs: the SDK bounds a call by its client's timeout, so each client takes one. */
const REQUEST_MS = 30_000;
const CREATE_MS = 120_000;
const SIZES: Readonly<Record<number, string>> = { 1: "4G", 2: "8G", 4: "16G", 8: "32G" };
/** "default", boxd's own image, or a snapshot's name. */
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** 1 to 63 of a-z0-9._/- (Machines.updateLabels); "boxd/" is boxd's own. */
const LABEL_KEY = /^(?!boxd\/)[a-z0-9._/-]{1,63}$/;
/** boxd's in-machine agent, which carries the SDK's exec and file calls. */
const AGENT_PORT = 57073;
/** The image's own user, which boxd's exec runs as (with passwordless sudo): init refuses to start beside its processes. */
const IMAGE_UID = 1000;
/** Standby (suspended) wakes on the next call, and a migration keeps the machine: both run. */
const STATES: Readonly<Record<string, Machine["state"]>> = {
	...{ pending: "starting", starting: "starting", running: "running", suspended: "running", migrating: "running" },
	...{ hibernated: "stopped", stopped: "stopped", failed: "failed", destroyed: "going" },
};

const show = (value: unknown) => (value === undefined ? "nothing" : JSON.stringify(value));

/** boxd's machines as a MachineHost (../host.ts). */
class BoxdHost implements MachineHost {
	readonly id = "boxd";
	readonly facts: HostFacts = {
		daemon: "child",
		isolation: "microvm",
		// boxd ends no machine on its own (deleteTimer aside), and sets no cap.
		lifetime: "janitor",
		maxLifetimeMs: 30 * DAY_MS,
		arch: "amd64",
		vendorAgentPorts: [AGENT_PORT],
		networkReadBack: true,
		network: [...BOXD.network],
		mounts: [...MOUNT],
		release: ["delete"],
		labelRules: { key: LABEL_KEY },
	};
	/** The labels each create of this process wrote, by machine id: a snapshot's restore merges in its own. */
	readonly #written = new Map<string, Set<string>>();

	constructor(
		readonly machines: BoxdMachines,
		/** For create alone: bounded by createMs, and never sent twice. */
		readonly creator: BoxdMachines,
		readonly options: { org?: string; size?: { vcpu: number; memory: string }; deleteTimer: boolean },
	) {}

	/** An isolated machine (on none of the org's networks), with no standby, which would freeze a quiet computer. */
	async create(req: MachineRequest): Promise<Result<{ id: string }>> {
		const { org, size, deleteTimer } = this.options;
		const made = await this.creator.create({
			name: req.name,
			...(org === undefined ? {} : { org }),
			labels: req.labels,
			isolated: true,
			config: { autoSuspendTimeout: 0, ...size },
			...(req.image === BOXD_DEFAULT_IMAGE ? {} : { fromSnapshot: req.image }),
			...(deleteTimer ? { deleteAfter: Math.ceil((Date.parse(req.labels[MAX_LABEL] ?? "") - Date.now()) / 1000) + 300 } : {}),
		});
		this.#written.set(made.id, new Set(Object.keys(req.labels)));
		return ok({ id: made.id });
	}

	/** machines.get takes an id alone, so a machine of another org is none of this provider's. */
	async get(id: string): Promise<Result<Machine | undefined>> {
		const { org } = this.options;
		try {
			const machine = await this.machines.get(id);
			return ok(org === undefined || machine.org?.name === org || machine.org?.id === org ? this.#machineOf(machine) : undefined);
		} catch (error) {
			if (codeOf(error) === "not_found") return ok(undefined);
			throw error;
		}
	}

	async list(labels: Record<string, string>): Promise<Result<Machine[]>> {
		const { org } = this.options;
		const listed = await this.machines.list({ ...(org === undefined ? {} : { org }), labels });
		return ok([...listed].map((machine) => this.#machineOf(machine)));
	}

	async delete(id: string): Promise<Result<void>> {
		this.#written.delete(id);
		try {
			await this.machines.delete(id);
		} catch (error) {
			if (codeOf(error) !== "not_found") throw error;
		}
		return ok(undefined);
	}

	/** One streamExec, its line the argv quoted. boxd runs it as the image's user; the adapter's scripts sudo to root. */
	async exec(id: string, argv: readonly string[], { stdin }: { stdin: boolean }): Promise<Result<MachineProcess>> {
		const stream = this.machines.streamExec(id, { command: shellLine(argv) });
		if (!stdin) stream.end();
		return ok({
			stdout: stream,
			stderr: stream.stderr,
			write: async (bytes) => stream.write(bytes),
			end: async () => stream.end(),
			wait: () => stream.wait().catch(() => -1),
			// The server kills the process group (TERM, then KILL); close is safe twice (exec.d.ts).
			kill: async () => stream.close(),
		});
	}

	async upload(id: string, path: string, bytes: Uint8Array): Promise<Result<void>> {
		await this.machines.files.upload(id, path, bytes);
		return ok(undefined);
	}

	readonly errorCode = codeOf;

	/** Ready for exec, nothing out, and no hibernation: boxd's idle timers watch traffic, and a computer may have none. */
	async prepare(id: string, ctx: HostCall): Promise<Result<void>> {
		await this.machines.waitUntilReady(id, { timeout: ctx.timeoutMs });
		await this.machines.setEgressAllow(id, ["none"]);
		await this.machines.setAutoHibernateTimeout(id, 0);
		return ok(undefined);
	}

	/** The janitor's deadline label, at extend. */
	async setLabels(id: string, labels: Record<string, string>): Promise<Result<void>> {
		await this.machines.updateLabels(id, { set: labels });
		return ok(undefined);
	}

	check(spec: ComputerSpec): Refusal[] {
		const image = (spec as { image?: unknown } | null)?.image;
		if (typeof image !== "string" || image === "") return [];
		if (!IMAGE.test(image)) return [{ field: "image", message: `an image is "${BOXD_DEFAULT_IMAGE}" (boxd's own Ubuntu 24.04), or the name of a boxd snapshot` }];
		if (image !== BOXD_DEFAULT_IMAGE && this.options.size) return [{ field: "image", message: `a machine restored from a snapshot has the snapshot's size, and this provider names one: it takes only "${BOXD_DEFAULT_IMAGE}"` }];
		return [];
	}

	/** The machine as the adapter reads one; boxd's own create options read back wrong are its drift. */
	#machineOf(machine: BoxdMachine): Machine {
		const labels = { ...machine.labels };
		const drift: string[] = [];
		const differ = (field: string, declared: unknown, actual: unknown) => drift.push(`${field}: declared ${show(declared)}, read back ${show(actual)}`);
		if (machine.name !== labels[NAME_LABEL]) differ("name", labels[NAME_LABEL], machine.name);
		if (!machine.networking.isolated) differ("isolated", true, machine.networking.isolated);
		const { suspendAfter, hibernateAfter, destroyAfter } = machine.idle;
		for (const [field, after] of Object.entries({ "auto-suspend": suspendAfter, "auto-hibernate": hibernateAfter, "auto-destroy": destroyAfter })) if (after !== 0) differ(field, 0, after);
		if (machine.deleteAt && !(new Date(machine.deleteAt).getTime() >= Date.parse(labels[MAX_LABEL] ?? ""))) drift.push(`delete-after: boxd deletes it at ${show(machine.deleteAt)}, before the most it may live (${show(labels[MAX_LABEL])})`);
		const snapshot = machine.source?.kind === "snapshot" ? machine.source.name : undefined;
		if ((labels[IMAGE_LABEL] ?? BOXD_DEFAULT_IMAGE) !== (snapshot ?? BOXD_DEFAULT_IMAGE)) differ("snapshot", labels[IMAGE_LABEL], snapshot);
		const written = this.#written.get(machine.id);
		for (const key of Object.keys(labels)) if (written && key.startsWith("agentrun.") && !written.has(key)) drift.push(`label ${key}: create wrote none, read back ${show(labels[key])} (from the snapshot)`);
		const { vcpu, memoryBytes } = machine.resources;
		const { size } = this.options;
		if (size && (vcpu !== size.vcpu || memoryBytes !== Number.parseInt(size.memory, 10) * 1024 ** 3)) differ("size", size, { vcpu, memoryBytes });
		const state = STATES[machine.status];
		return {
			id: machine.id,
			labels,
			state: state ?? "failed",
			...(state === undefined ? { why: `boxd reads its status as ${show(machine.status)}` } : {}),
			network: networkOf(machine.egressAllow),
			...(snapshot === undefined ? {} : { image: { resolved: snapshot } }),
			size: { cpus: vcpu, memoryMb: memoryBytes / 1024 ** 2 },
			...(drift.length > 0 ? { drift } : {}),
		};
	}
}

/** none is the allowlist ["none"], open is none at all; a list of hosts is another network, in words. */
function networkOf(allow: string[]): NetworkPolicy {
	if (allow.length === 0) return "open";
	if (allow.length === 1 && allow[0] === "none") return "none";
	return { other: `an egress allowlist of ${allow.length} entries, which this provider never makes` };
}

/** The SDK names its errors (errors.d.ts); an APIStatusError carries its gRPC code (3 invalid argument, 4 deadline
 *  exceeded, 8 resource exhausted, 9 failed precondition, 14 unavailable). */
function codeOf(error: unknown): ComputerErrorCode {
	const { name, grpcCode } = (error ?? {}) as { name?: unknown; grpcCode?: unknown };
	if (name === "AbortError") return "aborted";
	if (name === "NotFoundError" || name === "MachineFileNotFoundError") return "not_found";
	if (name === "AuthenticationError" || name === "PermissionDeniedError" || name === "RegionNotEnabledError") return "denied";
	if (name === "RateLimitError" || grpcCode === 8) return "limit";
	// boxd keeps a name to one machine: a create of a name another create took.
	if (name === "ConflictError") return "exists";
	if (name === "APIConnectionError" || grpcCode === 4 || grpcCode === 14) return "timeout";
	if (grpcCode === 3) return "invalid";
	if (grpcCode === 9) return "refused";
	return "vendor";
}

/** Computers that are boxd machines, on the shared adapter. A spec's image is "default" or a boxd snapshot's name. */
export class BoxdProvider extends HostedProvider {
	constructor(options: BoxdProviderOptions) {
		const { apiKey, Boxd, org, region = "", baseUrl = DEFAULT_BASE_URL, vcpu, memory, deleteTimer = false, maxLifetimeMs = DAY_MS, ...rest } = options;
		if (typeof apiKey !== "string" || apiKey === "") throw new Error("a boxd API key is required");
		if (typeof Boxd !== "function") throw new Error("options.Boxd must be the @boxd-sh/sdk package's Boxd class");
		if ((vcpu !== undefined || memory !== undefined) && SIZES[vcpu as number] !== memory) throw new Error(`vcpu ${String(vcpu)} with memory ${String(memory)} is not one of boxd's sizes: 1 and 4G, 2 and 8G, 4 and 16G or 8 and 32G`);
		if (Number(rest.daemonUser?.split(":")[0]) === IMAGE_UID) throw new Error(`the daemon user ${rest.daemonUser} is the uid of the machine's own user, whose processes init refuses to run beside; choose another, such as 2510:2510`);
		const client = { apiKey, baseURL: baseUrl, region };
		const machines = new Boxd({ ...client, timeout: rest.timeouts?.requestMs ?? REQUEST_MS }).machines;
		const creator = new Boxd({ ...client, timeout: rest.timeouts?.createMs ?? CREATE_MS, maxRetries: 0 }).machines;
		const size = vcpu === undefined ? undefined : { vcpu, memory: memory as string };
		super(new BoxdHost(machines, creator, { org, size, deleteTimer }), { ...rest, label: "boxd", maxLifetimeMs });
	}
}
