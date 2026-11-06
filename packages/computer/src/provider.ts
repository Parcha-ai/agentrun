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
	isolation: "container" | "gvisor" | "microvm" | "vm" | "machine";
	os: "linux" | "windows" | "macos" | "android" | "ios";
	/** What the daemon in each computer must offer. */
	daemon: DaemonCapability[];
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
	connect(ref: ComputerRef): Promise<Result<ComputerConnection>>;
	/** Idempotent: a computer already gone is ok. */
	release(ref: ComputerRef, how: "stop" | "delete"): Promise<Result<void>>;
}
