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

const show = (value: unknown) => (value === undefined ? "nothing" : JSON.stringify(value));
const text = (value: unknown) => (typeof value === "string" ? value : show(value));
const sameList = (a: unknown, b: string[]) => Array.isArray(a) && a.length === b.length && a.every((item, i) => item === b[i]);

/**
 * The network a computer is on, read back from inspect: `none` is network mode none on no network but Docker's own
 * `none`, `open` is the default bridge alone. Anything else is reported in words, never as a policy it might widen to.
 */
export function networkOf(inspected: DockerInspect | null | undefined): NetworkPolicy {
	const mode = inspected?.HostConfig?.NetworkMode;
	const networks = Object.keys(inspected?.NetworkSettings?.Networks ?? {}).sort();
	if (mode === "none" && networks.every((name) => name === "none")) return "none";
	if (mode === "bridge" && sameList(networks, ["bridge"])) return "open";
	return { other: `network mode ${mode ?? "unknown"} on networks ${networks.join(", ") || "none"}` };
}

const policyWords = (policy: NetworkPolicy) => (typeof policy === "string" ? policy : "other" in policy ? policy.other : JSON.stringify(policy));

/** Every way hello differs from what the provider expects. */
export function helloDrift(hello: HelloResult | null | undefined, expected: HelloExpected): string[] {
	const found: string[] = [];
	if (hello?.version !== expected.version) found.push(`hello: the daemon reports version ${text(hello?.version)}, expected ${expected.version}`);
	if (hello?.os !== "linux") found.push(`hello: the daemon reports os ${text(hello?.os)}, expected linux`);
	if (expected.arch !== undefined && hello?.arch !== expected.arch) {
		found.push(`hello: the daemon reports arch ${text(hello?.arch)}, expected the host's ${expected.arch}`);
	}
	const offered: unknown = hello?.capabilities;
	const missing = expected.capabilities.filter((capability) => !(Array.isArray(offered) && offered.includes(capability)));
	if (missing.length > 0) found.push(`hello: the daemon's capabilities lack ${missing.join(", ")}, which the provider declares`);
	return found;
}

/** Every way a created computer differs from its spec, from inspect and hello. */
export function drift(spec: ComputerSpec, inspected: DockerInspect | null | undefined, hello: HelloResult | null | undefined, expected: DriftExpected): string[] {
	const found: string[] = [];
	const mismatch = (field: string, declared: unknown, actual: unknown) => found.push(`${field}: declared ${show(declared)}, read back ${show(actual)}`);
	const host = inspected?.HostConfig ?? {};
	const config = inspected?.Config ?? {};

	const network = networkOf(inspected);
	if (network !== spec.network) found.push(`network: declared ${policyWords(spec.network)}, read back ${policyWords(network)}`);
	if (!sameList(host.CapDrop, ["ALL"])) mismatch("CapDrop", ["ALL"], host.CapDrop);
	if ((host.CapAdd ?? []).length > 0) mismatch("CapAdd", [], host.CapAdd);
	if (host.Privileged !== false) mismatch("Privileged", false, host.Privileged);
	const options = host.SecurityOpt ?? [];
	if (!options.some((option) => option === "no-new-privileges" || option === "no-new-privileges:true") || options.includes("no-new-privileges:false")) {
		mismatch("SecurityOpt", "no-new-privileges", host.SecurityOpt);
	}
	const pids = spec.pids ?? DEFAULT_PIDS;
	if (host.PidsLimit !== pids) mismatch("PidsLimit", pids, host.PidsLimit);
	if (spec.memoryMb !== undefined) {
		const bytes = spec.memoryMb * 1024 * 1024;
		if (host.Memory !== bytes) mismatch("Memory", bytes, host.Memory);
		if (host.MemorySwap !== bytes) mismatch("MemorySwap", bytes, host.MemorySwap);
	}
	if (spec.cpus !== undefined && host.NanoCpus !== Math.round(spec.cpus * 1e9)) mismatch("NanoCpus", Math.round(spec.cpus * 1e9), host.NanoCpus);

	const mounts = inspected?.Mounts ?? [];
	const daemon = mounts.filter((mount) => mount.Destination === DAEMON_IN_COMPUTER);
	const [only] = daemon;
	if (daemon.length !== 1 || only?.Type !== "bind" || only.Source !== expected.daemonPath || only.RW !== false) {
		found.push(`daemon mount: declared ${expected.daemonPath} bound read-only at ${DAEMON_IN_COMPUTER}, read back ${show(daemon)}`);
	}
	for (const mount of mounts) {
		if (mount.Type === "bind" && mount.Destination !== DAEMON_IN_COMPUTER) found.push(`bind mount: none declared but the daemon's, read back ${show(mount)}`);
	}
	if (!sameList(config.Entrypoint, [DAEMON_IN_COMPUTER])) mismatch("Entrypoint", [DAEMON_IN_COMPUTER], config.Entrypoint);
	if (!sameList(config.Cmd, ["init"])) mismatch("Cmd", ["init"], config.Cmd);

	const labels = config.Labels ?? {};
	if (labels[COMPUTER_LABEL] !== "1") mismatch(`label ${COMPUTER_LABEL}`, "1", labels[COMPUTER_LABEL]);
	if (labels[DEADLINE_LABEL] !== expected.deadline) mismatch(`label ${DEADLINE_LABEL}`, expected.deadline, labels[DEADLINE_LABEL]);
	for (const [key, value] of Object.entries(spec.labels ?? {})) {
		if (labels[key] !== value) mismatch(`label ${key}`, value, labels[key]);
	}
	return [...found, ...helloDrift(hello, expected)];
}
