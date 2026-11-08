// The provisioner: one per vendor. It makes, finds and ends computers; the daemon inside does the work.
import type { MountKind, MountReadBack, MountSpec } from "./mount.js";
import type { ComputerClient, ComputerKind, ComputerOs, Group, HelloResult } from "./protocol.js";
import type { Result } from "./result.js";

export type NetworkSpec = "none" | "open" | { allow: string[] };

export interface ComputerSpec {
	image: string;
	/** Required: a computer with no deadline is refused. */
	lifetimeMs: number;
	network: NetworkSpec;
	cpus?: number;
	memoryMb?: number;
	pids?: number;
	labels?: Record<string, string>;
	workdir?: string;
	/** uid or uid:gid, in numbers. Unset, the provider's non-root default; root ("0") only when asked here. */
	user?: string;
	/**
	 * The run's folder, mounted read-write at /workspace (WORKSPACE), of a kind capabilities().mount declares; check()
	 * refuses any other kind before a vendor call. An Archil token is never in a label, a read-back or an error.
	 */
	mount?: MountSpec;
}

/** One kind of allowlist entry a provider takes: how many a list may hold, and the ports an entry opens. */
export interface AllowRule {
	max: number;
	/** The ports an entry opens: these, or "any". */
	ports: number[] | "any";
}

/** What a network allowlist may hold, for a provider that declares network "allow". */
export interface AllowCapability {
	domains?: AllowRule;
	cidrs?: AllowRule;
	/** Whether one allowlist may hold domains and CIDRs together. */
	mixed: boolean;
}

/**
 * Who answers a computer's methods. pid1: computerd init is the computer's main process, so its exit ends the computer.
 * child: the vendor's own agent is the main process and starts init at boot; init's exit does not end the computer.
 * none: no computerd runs; the provider answers the methods itself, from our server (adb, the vendor's API).
 */
export type DaemonMode = "pid1" | "child" | "none";

export interface ComputerCapabilities {
	/** What the computer is: the shape its tools take. With daemon, it sets which groups are Core. */
	kind: ComputerKind;
	/** Who ends a computer at its deadline: the vendor, or our janitor by label. */
	lifetime: "vendor" | "janitor";
	network: Array<"none" | "open" | "allow">;
	/** With network "allow": what an allowlist may hold and which ports it opens. */
	allow?: AllowCapability;
	/**
	 * Whether network() reads the policy back from outside the computer, from the vendor's own report of it. false: the
	 * vendor has no read-back, so only a probe from inside the computer stands for one, and an allowlist counts only
	 * once the live bypass cases pass (ruling 9).
	 */
	networkReadBack?: boolean;
	isolation: "container" | "gvisor" | "microvm" | "vm" | "machine";
	os: ComputerOs;
	/**
	 * With release "stop": true when a stop ends in deletion (Daytona with autoDeleteMinutes 0), so release(ref, "stop")
	 * leaves no computer, listed or attachable. Absent or false: a stopped computer is kept, listed stopped, until deleted.
	 */
	stopDeletes?: boolean;
	daemon: DaemonMode;
	/** What each computer offers, as hello repeats it. */
	groups: Group[];
	/** The longest lifetime this provider instance gives a computer: the vendor's hard cap. check() refuses past it. */
	maxLifetimeMs: number;
	/** What spec.user may ask for instead of the non-root default: root ("0"), another uid. Absent: neither. */
	user?: Array<"root" | "uid">;
	/**
	 * How release may end a computer. "stop" keeps it, listed as stopped, until it is deleted; a provider that does not
	 * declare it refuses release(ref, "stop") in words and leaves the computer as it was.
	 */
	release: Array<"stop" | "delete">;
	/** The kinds of spec.mount this provider takes: bind (a host folder), archil (a folder of an Archil disk). Absent: none. */
	mount?: MountKind[];
}

/** The os and daemon modes each kind may have; no other pair is valid. */
export const KIND_SHAPES: Readonly<Record<ComputerKind, { os: readonly ComputerOs[]; daemon: readonly DaemonMode[] }>> = {
	linux: { os: ["linux"], daemon: ["pid1", "child"] },
	desktop: { os: ["linux", "windows", "macos"], daemon: ["pid1", "child", "none"] },
	android: { os: ["android"], daemon: ["none"] },
	ios: { os: ["ios"], daemon: ["none"] },
};

/** Why kind, os and daemon are not a valid pair, in words; none when they are. */
export function kindRefusals({ kind, os, daemon }: Pick<ComputerCapabilities, "kind" | "os" | "daemon">): Refusal[] {
	const shape = Object.hasOwn(KIND_SHAPES, kind) ? KIND_SHAPES[kind] : undefined;
	if (shape === undefined) return [{ field: "kind", message: `kind ${JSON.stringify(kind)} is not one of ${Object.keys(KIND_SHAPES).join(", ")}` }];
	const refusals: Refusal[] = [];
	if (!shape.os.includes(os)) refusals.push({ field: "kind", message: `a ${kind} computer runs ${shape.os.join(" or ")}, not os ${JSON.stringify(os)}` });
	if (!shape.daemon.includes(daemon)) refusals.push({ field: "kind", message: `a ${kind} computer has daemon ${shape.daemon.join(" or ")}, not ${JSON.stringify(daemon)}` });
	return refusals;
}

const DAY_MS = 24 * 60 * 60_000;
const lifetimeWords = (ms: number) =>
	ms % DAY_MS === 0 ? `${ms / DAY_MS} ${ms === DAY_MS ? "day" : "days"}` : ms % 3_600_000 === 0 ? `${ms / 3_600_000} h` : ms % 60_000 === 0 ? `${ms / 60_000} min` : `${ms / 1000} s`;

/**
 * The one lifetime rule every provider's check() shares, with no vendor call: lifetimeMs is a whole number of
 * milliseconds above 0, and at most capabilities().maxLifetimeMs.
 */
export function checkLifetime(lifetimeMs: unknown, { lifetime, maxLifetimeMs }: Pick<ComputerCapabilities, "lifetime" | "maxLifetimeMs">): Refusal[] {
	if (!Number.isSafeInteger(lifetimeMs) || (lifetimeMs as number) <= 0) {
		const after = lifetime === "janitor" ? "the janitor deletes the computer" : "the vendor ends the computer";
		return [{ field: "lifetimeMs", message: `lifetimeMs is required: a whole number of milliseconds above 0, after which ${after}` }];
	}
	if ((lifetimeMs as number) > maxLifetimeMs) {
		return [{ field: "lifetimeMs", message: `lifetimeMs is at most ${lifetimeWords(maxLifetimeMs)} (${maxLifetimeMs} ms), this provider's cap; ask for a new computer after that` }];
	}
	return [];
}

/** Why a spec is refused, in words, before any vendor call. */
export interface Refusal {
	field: string;
	message: string;
}

export interface ComputerRef {
	id: string;
	name: string;
}

/** A computer's network as read back from the computer itself. `other` is a network the provider never makes, in words. */
export type NetworkPolicy = NetworkSpec | { other: string };

/** The spec a computer runs with, read back from the computer itself, not from what was asked. */
export interface ReadBackSpec {
	/** The image as create was asked for it, read back from the computer (Docker's config, Daytona's label). */
	image: string;
	/** What the vendor resolved the image to, by its own name, when it reports one (a Daytona snapshot). */
	snapshot?: string;
	/** uid:gid in numbers: "0:0" is root. */
	user: string;
	network: NetworkPolicy;
	cpus?: number;
	memoryMb?: number;
	pids?: number;
	workdir?: string;
	/** When the computer ends; absent when the provider cannot read it. */
	deadline?: Date;
	/** What the computer says it is, from its hello; absent when it could not be asked (a stopped computer). */
	kind?: ComputerKind;
	/** What is mounted at /workspace, never a token; absent when nothing is. */
	mount?: MountReadBack;
}

/** A computer attach found: its ref, and the spec read back from it, so a caller sees what it attached to (root, open). */
export interface AttachedComputer extends ComputerRef {
	spec: ReadBackSpec;
}

/** One computer as list() reads it back. */
export interface ComputerInfo {
	ref: ComputerRef;
	labels: Record<string, string>;
	/** undefined when the deadline label is missing or unreadable: the janitor deletes such a computer. */
	deadline: Date | undefined;
	state: "running" | "stopped";
	network: NetworkPolicy;
	/** What is mounted at /workspace, read back, never a token; absent when nothing is. */
	mount?: MountReadBack;
}

export interface CallContext {
	signal?: AbortSignal;
}

/** A live connection to a computer's daemon. */
export interface ComputerConnection {
	client: ComputerClient;
	hello: HelloResult;
	close(): Promise<void>;
}

export interface ComputerProvider {
	readonly id: string;
	readonly version: string;
	capabilities(): ComputerCapabilities;
	check(spec: ComputerSpec): Refusal[];
	create(spec: ComputerSpec, context?: { signal?: AbortSignal }): Promise<Result<ComputerRef>>;
	/**
	 * Finds one computer this provider made, by its id or by labels, with the spec read back from it; none or several is
	 * an error in words.
	 */
	attach(ref: { id: string } | { labels: Record<string, string> }, context?: CallContext): Promise<Result<AttachedComputer>>;
	/** Every computer this provider made that carries all of these labels: the janitor's view. */
	list(labels: Record<string, string>, context?: CallContext): Promise<Result<ComputerInfo[]>>;
	/** Reads the network back; with a policy, sets it, or refuses in words when it cannot. Never wider than asked. */
	network(ref: ComputerRef, policy?: NetworkSpec, context?: CallContext): Promise<Result<NetworkPolicy>>;
	/** Checks hello against this provider's version, kind and groups, and refuses on a mismatch. */
	connect(ref: ComputerRef): Promise<Result<ComputerConnection>>;
	/** Idempotent: a computer already gone is ok. A "stop" capabilities().release does not declare is refused in words. */
	release(ref: ComputerRef, how: "stop" | "delete"): Promise<Result<void>>;
	/**
	 * Sets the deadline to now + ttlMs: never earlier than the current deadline, never past created + maxLifetimeMs. A
	 * ttlMs that would move it earlier, or past that cap, is refused in words with the deadline unchanged: an extend
	 * never shortens a computer's life, and the cap counts from create, not from each call. It moves the vendor's timer,
	 * the deadline label and init's own deadline, in that order; when a step fails the computer ends earlier than asked,
	 * never later, and the error names what moved. The result is the deadline read back.
	 * Optional: a provider without it asks for the whole lifetime at create.
	 */
	extend?(ref: ComputerRef, ttlMs: number, context?: CallContext): Promise<Result<{ deadline: Date }>>;
	/** A URL that shows the screen live, the vendor's own. Optional. */
	stream?(ref: ComputerRef, options?: { viewOnly?: boolean }, context?: CallContext): Promise<Result<{ url: string; expiresAt?: Date }>>;
}
