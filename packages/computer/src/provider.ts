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

export interface ComputerCapabilities {
	/** Who ends a computer at its deadline: the vendor, or our janitor by label. */
	lifetime: "vendor" | "janitor";
	network: Array<"none" | "open" | "allow">;
	/**
	 * Whether network() reads the policy back from outside the computer, from the vendor's own report of it. false: the
	 * vendor has no read-back, so only a probe from inside the computer stands for one, and an allowlist counts only
	 * once the live bypass cases pass (ruling 9).
	 */
	networkReadBack?: boolean;
	isolation: "container" | "gvisor" | "microvm" | "vm" | "machine";
	os: "linux" | "windows" | "macos" | "android" | "ios";
	/** What the daemon in each computer must offer. */
	daemon: DaemonCapability[];
	/** What spec.user may ask for instead of the non-root default: root ("0"), another uid. Absent: neither. */
	user?: Array<"root" | "uid">;
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
	image: string;
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
	/** Idempotent: a computer already gone is ok. */
	release(ref: ComputerRef, how: "stop" | "delete"): Promise<Result<void>>;
}
