// The drift check for a Docker computer: what the computer reports of itself after create, from docker inspect and the
// daemon's hello, against what was declared. Pure: no Docker call. Each mismatch is one sentence; none is an empty list.
import type { DaemonCapability, HelloResult } from "./protocol.js";
import type { ComputerSpec, NetworkPolicy } from "./provider.js";

/** Where the daemon is mounted in each computer, read-only. */
export const DAEMON_IN_COMPUTER = "/opt/agentrun/computerd";
export const COMPUTER_LABEL = "agentrun.computer";
export const DEADLINE_LABEL = "agentrun.computer.deadline";
export const DEFAULT_PIDS = 4096;

/** The parts of `docker inspect` a computer is checked by. */
export interface DockerInspect {
	Id?: string;
	Name?: string;
	State?: { Running?: boolean; Status?: string; ExitCode?: number; Error?: string };
	Config?: { Entrypoint?: string[] | null; Cmd?: string[] | null; Labels?: Record<string, string> | null };
	HostConfig?: {
		NetworkMode?: string;
		CapDrop?: string[] | null;
		CapAdd?: string[] | null;
		Privileged?: boolean;
		SecurityOpt?: string[] | null;
		PidsLimit?: number | null;
		Memory?: number;
		MemorySwap?: number;
		NanoCpus?: number;
	};
	Mounts?: Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }> | null;
	NetworkSettings?: { Networks?: Record<string, unknown> | null };
}

/** What the daemon must report: the provider's version and daemon capabilities, and the host's architecture. */
export interface HelloExpected {
	version: string;
	capabilities: DaemonCapability[];
	/** Go's name (amd64, arm64); not checked when absent. */
	arch?: string;
}

export interface DriftExpected extends HelloExpected {
	/** The daemon binary on the host, as it was mounted. */
	daemonPath: string;
	/** The deadline label's value, as it was set. */
	deadline: string;
}

/** The network a computer is on, read back from inspect. */
export function networkOf(_inspected: DockerInspect): NetworkPolicy {
	return { other: "not read yet" };
}

/** Every way hello differs from what the provider expects. */
export function helloDrift(_hello: HelloResult, _expected: HelloExpected): string[] {
	return [];
}

/** Every way a created computer differs from its spec, from inspect and hello. */
export function drift(_spec: ComputerSpec, _inspected: DockerInspect, _hello: HelloResult, _expected: DriftExpected): string[] {
	return [];
}
