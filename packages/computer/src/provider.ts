// The provisioner: one per vendor. It makes, finds and ends computers; the daemon inside does the work.
import type { DaemonClient } from "./client.js";
import type { DaemonCapability, HelloResult } from "./protocol.js";
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

export interface ComputerCapabilities {
	/** Who ends a computer at its deadline: the vendor, or our janitor by label. */
	lifetime: "vendor" | "janitor";
	network: Array<"none" | "open" | "allow">;
	/** With network "allow": what an allowlist may hold and which ports it opens. */
	allow?: AllowCapability;
	isolation: "container" | "gvisor" | "microvm" | "vm" | "machine";
	os: "linux" | "windows" | "macos" | "android" | "ios";
	/**
	 * With release "stop": true when a stop ends in deletion (Daytona with autoDeleteMinutes 0), so release(ref, "stop")
	 * leaves no computer, listed or attachable. Absent or false: a stopped computer is kept, listed stopped, until deleted.
	 */
	stopDeletes?: boolean;
	/** What the daemon in each computer must offer. */
	daemon: DaemonCapability[];
	/** What spec.user may ask for instead of the non-root default: root ("0"), another uid. Absent: neither. */
	user?: Array<"root" | "uid">;
	/**
	 * How release may end a computer. "stop" keeps it, listed as stopped, until it is deleted; a provider that does not
	 * declare it refuses release(ref, "stop") in words and leaves the computer as it was.
	 */
	release: Array<"stop" | "delete">;
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
}

export interface CallContext {
	signal?: AbortSignal;
}

/** A live connection to a computer's daemon. */
export interface ComputerConnection {
	client: DaemonClient;
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
	/** Checks hello against this provider's version and daemon capabilities, and refuses on a mismatch. */
	connect(ref: ComputerRef): Promise<Result<ComputerConnection>>;
	/** Idempotent: a computer already gone is ok. A "stop" capabilities().release does not declare is refused in words. */
	release(ref: ComputerRef, how: "stop" | "delete"): Promise<Result<void>>;
}
