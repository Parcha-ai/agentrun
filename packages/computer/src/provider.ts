// The provisioner: one per vendor. It makes, finds and ends computers; the daemon inside does the work.
import type { MountKind, MountReadBack, MountSpec } from "./mount.js";
import type { ComputerClient, ComputerKind, ComputerOs, Group, HelloResult } from "./protocol.js";
import type { Result } from "./result.js";
import type { ScreenWatch, ScreenWatchHandlers, WatchOptions } from "./screen-watch.js";

export type NetworkSpec = "none" | "open" | { allow: string[] };

/** The agent a persistent computer belongs to (spec.owner): it outlives the agent's runs, which take it one at a time. */
export interface ComputerOwner {
	/** The agent's id: a non-empty string with no NUL byte (ownerProblem). */
	agent: string;
	/** How long the computer may stay detached before the janitor deletes it. Absent: it stays until it is deleted. */
	idleTtlMs?: number;
}

/** The claim a run holds a computer under: the run, and the claim's epoch (labels.ts). */
export interface ComputerClaim {
	run: string;
	epoch: number;
}

export interface ComputerSpec {
	image: string;
	/**
	 * Required for a run's computer: one with no deadline is refused. An agent's computer (owner) has no run deadline and
	 * leaves it out (checkTenure).
	 */
	lifetimeMs?: number;
	/**
	 * Makes the computer the agent's, persistent across its runs, on a provider that declares persistence; refused in
	 * words by any other. It carries the owner's labels (ownerLabels).
	 */
	owner?: ComputerOwner;
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
	/**
	 * Present when the provider keeps computers for agents (spec.owner): release(ref, "detach") stops one with its state
	 * kept, and attach with a claim brings it back. keepsState: its files survive a detach. resume: true when it comes
	 * back as it was, its processes running; false when it boots again from its kept disk. Absent: spec.owner and detach
	 * are refused in words.
	 */
	persistence?: { keepsState: true; resume: boolean };
	/**
	 * The TCP ports the vendor's own agent listens on inside the computer (Daytona's toolbox 2280, E2B's envd 49983), each
	 * the provider's own fact: an agent that runs commands as root or with sudo for whoever reaches it. The computer's
	 * programs must reach none of them on any address (computerd init --own-network), which isolation.vendor-agent checks
	 * on both loopbacks. An empty list: a vendor with no known listener inside (Modal), checked on the interfaces alone.
	 * Absent: no vendor's agent runs beside the programs (Docker). A child daemon must declare it.
	 */
	vendorAgentPorts?: number[];
}

/** The os and daemon modes each kind may have; no other pair is valid. */
export const KIND_SHAPES: Readonly<Record<ComputerKind, { os: readonly ComputerOs[]; daemon: readonly DaemonMode[] }>> = {
	linux: { os: ["linux"], daemon: ["pid1", "child"] },
	desktop: { os: ["linux", "windows", "macos"], daemon: ["pid1", "child", "none"] },
	android: { os: ["android"], daemon: ["none"] },
	ios: { os: ["ios"], daemon: ["none"] },
	// A browser: the provider answers it, its CDP target the connection's cdp.
	browser: { os: ["linux"], daemon: ["none"] },
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

/**
 * A run's computer's lifetime, in a provider's create once check() passed the spec: its lifetimeMs, which
 * checkLifetime requires of every spec with no owner. A spec without one is a caller's mistake past check(): a throw.
 */
export function runLifetimeMs(spec: Pick<ComputerSpec, "lifetimeMs">): number {
	if (spec.lifetimeMs === undefined) throw new TypeError("a run's computer needs lifetimeMs: check() refuses a spec with neither lifetimeMs nor owner");
	return spec.lifetimeMs;
}

/** Why owner is not an agent's ownership, in words, or undefined when it is one. */
export function ownerProblem(owner: unknown): string | undefined {
	if (typeof owner !== "object" || owner === null || Array.isArray(owner)) return "owner is { agent, idleTtlMs? }";
	const { agent, idleTtlMs } = owner as Partial<ComputerOwner>;
	if (typeof agent !== "string" || agent === "") return "owner.agent must be the agent's id, a non-empty string";
	if (agent.includes("\0")) return "owner.agent cannot hold a NUL byte: no provider takes one in a label";
	if (idleTtlMs !== undefined && !(Number.isSafeInteger(idleTtlMs) && idleTtlMs > 0)) return `owner.idleTtlMs is a whole number of milliseconds above 0, not ${JSON.stringify(idleTtlMs)}`;
	return undefined;
}

/**
 * The lifetime rule every provider's check() shares, with no vendor call. A run's computer (no owner) takes
 * checkLifetime. An agent's computer (owner) needs a provider that declares persistence, an owner that is one
 * (ownerProblem), and no lifetimeMs: it has no run deadline.
 */
export function checkTenure(
	{ lifetimeMs, owner }: { lifetimeMs?: unknown; owner?: unknown },
	capabilities: Pick<ComputerCapabilities, "lifetime" | "maxLifetimeMs" | "persistence">,
	provider = "this",
): Refusal[] {
	if (owner === undefined) return checkLifetime(lifetimeMs, capabilities);
	if (capabilities.persistence === undefined) {
		return [{ field: "owner", message: `the ${provider} provider keeps no computer for an agent (it declares no persistence), so spec.owner is refused: leave it out for a run's computer` }];
	}
	const refusals: Refusal[] = [];
	const problem = ownerProblem(owner);
	if (problem !== undefined) refusals.push({ field: "owner", message: problem });
	if (lifetimeMs !== undefined) {
		refusals.push({ field: "lifetimeMs", message: "an agent's computer has no run deadline: leave lifetimeMs out (owner.idleTtlMs bounds how long it stays detached)" });
	}
	return refusals;
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
	/** An agent's computer: its owner, read back; absent for a run's computer. */
	owner?: ComputerOwner;
}

/**
 * What a read-back recorded that does not refuse the computer, in words, one line each: under network none, the probe
 * targets that accepted a connection and sent nothing back ("network: none; accepted with no answer (no bytes came
 * back): 1.1.1.1:443, ..."). Recorded, never refused and never hidden. Absent when there is nothing to record.
 */
export type ReadBackNotes = string[];

/** What create returns: the computer's ref, and what its read-back recorded that does not refuse it. */
export interface CreatedComputer extends ComputerRef {
	notes?: ReadBackNotes;
}

/** A computer attach found: its ref, and the spec read back from it, so a caller sees what it attached to (root, open). */
export interface AttachedComputer extends ComputerRef {
	spec: ReadBackSpec;
	/** What attach's read-back recorded that does not refuse the computer (see ReadBackNotes). */
	notes?: ReadBackNotes;
}

/** One computer as list() reads it back. */
export interface ComputerInfo {
	ref: ComputerRef;
	labels: Record<string, string>;
	/** undefined when the deadline label is missing or unreadable: the janitor deletes such a run's computer. An agent's has none. */
	deadline: Date | undefined;
	state: "running" | "stopped";
	network: NetworkPolicy;
	/** What is mounted at /workspace, read back, never a token; absent when nothing is. */
	mount?: MountReadBack;
	/**
	 * An agent's computer (spec.owner), as the provider knows it, owner label or not: true. The janitor never deletes one
	 * by a deadline. A provider whose listing carries the owner label need not set it.
	 */
	owned?: boolean;
	/** An owned computer's owner, when the listing knows it (its labels, or the provider's own record). */
	owner?: ComputerOwner;
	/** An agent's computer that is detached now: when it was detached, the janitor's idle clock. Absent otherwise. */
	detachedAt?: Date;
}

export interface CallContext {
	signal?: AbortSignal;
}

/** attach's context: with a claim, an agent's computer is brought back and taken by that run, under that epoch. */
export interface AttachContext extends CallContext {
	claim?: ComputerClaim;
}

/**
 * How release ends or lets go of a computer. stop: stopped and kept, until deleted. delete: gone. detach: an agent's
 * computer stops with its state kept, still the agent's (a provider that declares persistence; refused otherwise).
 */
export type ReleaseHow = "stop" | "delete" | "detach";

/** A live connection to a computer's daemon. */
export interface ComputerConnection {
	client: ComputerClient;
	hello: HelloResult;
	close(): Promise<void>;
	/**
	 * A browser computer's CDP target (group cdp). The URL is a secret, a bearer of the session: never logged, never in a
	 * result, a report or an error.
	 */
	cdp?: { url: string };
}

export interface ComputerProvider {
	readonly id: string;
	readonly version: string;
	capabilities(): ComputerCapabilities;
	check(spec: ComputerSpec): Refusal[];
	create(spec: ComputerSpec, context?: { signal?: AbortSignal }): Promise<Result<CreatedComputer>>;
	/**
	 * Finds one computer this provider made, by its id or by labels, with the spec read back from it; none or several is
	 * an error in words. With context.claim (a provider that declares persistence): the agent's computer is brought back
	 * (started, when detached) and taken under the claim, so it carries the claim's run and epoch labels. A claim of the
	 * same run below the epoch the computer carries is refused as fenced, and a claim on a run's computer (no owner) is
	 * refused; neither changes anything.
	 */
	attach(ref: { id: string } | { labels: Record<string, string> }, context?: AttachContext): Promise<Result<AttachedComputer>>;
	/** Every computer this provider made that carries all of these labels: the janitor's view. */
	list(labels: Record<string, string>, context?: CallContext): Promise<Result<ComputerInfo[]>>;
	/** Reads the network back; with a policy, sets it, or refuses in words when it cannot. Never wider than asked. */
	network(ref: ComputerRef, policy?: NetworkSpec, context?: CallContext): Promise<Result<NetworkPolicy>>;
	/** Checks hello against this provider's version, kind and groups, and refuses on a mismatch. */
	connect(ref: ComputerRef): Promise<Result<ComputerConnection>>;
	/**
	 * Idempotent: a computer already gone is ok. A "stop" capabilities().release does not declare is refused in words. A
	 * "detach" is refused in words, the computer as it was, on a provider with no persistence and on a run's computer.
	 */
	release(ref: ComputerRef, how: ReleaseHow): Promise<Result<void>>;
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
	/**
	 * The computer's live view, for the runner's viewer (src/screen-watch.ts): frames to handlers.frame, each acked
	 * before the next; input() and close() on what it answers. Every computerd provider and the phone answer it through
	 * daemonWatch, on a connection of the watch's own. Optional; a computer with no screen refuses it as unsupported.
	 */
	watch?(ref: ComputerRef, handlers: ScreenWatchHandlers, options?: WatchOptions): Promise<Result<ScreenWatch>>;
	/**
	 * Removes what this provider's computers left behind outside the computers themselves (Docker: an egress proxy and its
	 * volume whose computer is gone or whose deadline has passed), with all of these labels, and returns what it removed,
	 * by name. Optional; the janitor's sweep calls it after the computers, which release their own parts.
	 */
	sweepLeftovers?(context: { labels: Record<string, string>; now: Date; signal?: AbortSignal }): Promise<Result<string[]>>;
	/**
	 * One account-level read with the provider's keys (a list by label, the vendor's whoami) that never creates a
	 * computer, so it never spends: Settings' "test connection". ok with words on what it read, or the error: unauthorized
	 * for a key the vendor refused, unreachable for a vendor not reached, or another code, its message never carrying a
	 * key. Optional.
	 */
	testConnection?(context?: CallContext): Promise<Result<{ detail: string }>>;
	/**
	 * The image its computers start from, made ready on its engine before the first create: built from its recipe, or
	 * pulled by name, when the engine lacks it; ok with the tag to put in spec.image. `onWait` is told once, before a build
	 * or a pull it waits on, never when the image is there. A provider whose descriptor declares prepareImage has it;
	 * optional for every other.
	 */
	prepareImage?(context?: CallContext & { onWait?: (making: "build" | "pull", tag: string) => void }): Promise<Result<string>>;
}
