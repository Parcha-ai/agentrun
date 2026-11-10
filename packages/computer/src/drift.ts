// The drift checks every provider shares: the daemon's hello against what the provider declares, and the report of
// computerd probe from inside a computer. Pure: no vendor call. Each mismatch is one sentence; none is an empty list.
// Docker's own read-back (docker info, docker inspect) is docker/inspect.ts's.
import type { ComputerKind, Group, HelloResult } from "./protocol.js";
import type { NetworkPolicy, NetworkSpec } from "./provider.js";

/** Where the daemon is mounted in each computer, read-only. */
export const DAEMON_IN_COMPUTER = "/opt/agentrun/computerd";
export const COMPUTER_LABEL = "agentrun.computer";
export const DEADLINE_LABEL = "agentrun.computer.deadline";
/** Serve's box sizes, when the spec names none. */
export const DEFAULT_CPUS = 2;
export const DEFAULT_MEMORY_MB = 4096;
export const DEFAULT_PIDS = 1024;
/** The computer's home and default workdir: a tmpfs its user owns. The run's folder, when bound, is at WORKSPACE. */
export const WORK = "/work";
/** Where init's socket lives (the daemon's DefaultSocket's directory): a tmpfs the computer's user owns, mode 0700. */
export const SOCKET_DIR = "/run/agentrun";

/** A value as a drift sentence shows it: JSON, or "nothing". */
export const show = (value: unknown) => (value === undefined ? "nothing" : JSON.stringify(value));
const text = (value: unknown) => (typeof value === "string" ? value : show(value));

/** What the daemon must report: the provider's version, kind and groups, and the host's architecture. */
export interface HelloExpected {
	version: string;
	kind: ComputerKind;
	groups: Group[];
	/** Go's name (amd64, arm64); not checked when absent. */
	arch?: string;
}

/**
 * What `computerd probe` reports from inside a computer: the uid:gid its programs run as, the kernel, reached (the
 * targets that answered: bytes came back) and accepted (those that accepted a connection and sent nothing back). One
 * rule for every provider that probes (README, "Network none, read from inside"): only an answer refuses network none.
 */
export interface ProbeReport {
	uid: number;
	gid: number;
	kernel: string;
	/** The live interfaces (up or addressed) of the probe's network namespace; absent from a daemon too old to report them. */
	interfaces?: string[];
	/** The quiet ones (down, no address), and those of them the probe could bring up as its user. */
	quiet?: string[];
	raised?: string[];
	reached: string[];
	accepted: string[];
}

const isAddresses = (value: unknown): value is string[] => Array.isArray(value) && value.every((one) => typeof one === "string");
const isId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

/**
 * The probe's JSON line from exec.run's stdout (base64), or what is wrong with it in words. The accepted list is
 * required: a report without it cannot tell a target that only accepted from one refused, so it is no read-back of
 * network none.
 */
export function probeReportOf(stdout: string): ProbeReport | { not: string } {
	const text = Buffer.from(stdout, "base64").toString("utf8");
	const notReport = { not: `wrote what is not its report: ${text.slice(0, 200)}` };
	let value: Partial<ProbeReport> | null;
	try {
		value = JSON.parse(text) as Partial<ProbeReport> | null;
	} catch {
		return notReport;
	}
	if (!(isId(value?.uid) && isId(value?.gid) && typeof value?.kernel === "string" && isAddresses(value?.reached))) return notReport;
	if (!isAddresses(value.accepted)) {
		return { not: `wrote a report with no accepted list, so a target that only accepted cannot be told from one refused: ${text.slice(0, 200)}` };
	}
	return {
		uid: value.uid,
		gid: value.gid,
		kernel: value.kernel,
		...(isAddresses(value.interfaces) ? { interfaces: value.interfaces } : {}),
		...(isAddresses(value.quiet) ? { quiet: value.quiet } : {}),
		...(isAddresses(value.raised) ? { raised: value.raised } : {}),
		reached: value.reached,
		accepted: value.accepted,
	};
}

/** Network none's drift by the probe: a target that answered, in words; none when nothing answered. */
export function probeNetworkDrift(probe: ProbeReport): string[] {
	return probe.reached.length > 0 ? [`network: declared none, read back an answer from ${probe.reached.join(", ")}`] : [];
}

/**
 * What the probe recorded that does not refuse the computer: under network none, the targets that accepted a connection
 * and sent nothing back. A firewall that accepts first and decides after looks so from inside; only an answer is drift.
 */
export function probeNotes(probe: ProbeReport, network: NetworkSpec | NetworkPolicy): string[] {
	return network === "none" && probe.accepted.length > 0 ? [`network: none; accepted with no answer (no bytes came back): ${probe.accepted.join(", ")}`] : [];
}

/** Every way hello differs from what the provider expects. */
export function helloDrift(hello: HelloResult | null | undefined, expected: HelloExpected): string[] {
	const found: string[] = [];
	if (hello?.version !== expected.version) found.push(`hello: the daemon reports version ${text(hello?.version)}, expected ${expected.version}`);
	if (hello?.os !== "linux") found.push(`hello: the daemon reports os ${text(hello?.os)}, expected linux`);
	if (expected.arch !== undefined && hello?.arch !== expected.arch) {
		found.push(`hello: the daemon reports arch ${text(hello?.arch)}, expected the host's ${expected.arch}`);
	}
	if (hello?.kind !== expected.kind) found.push(`hello: the daemon reports kind ${text(hello?.kind)}, expected ${expected.kind}`);
	const offered: unknown = hello?.groups;
	if (!Array.isArray(offered)) {
		found.push(`hello: the daemon reports groups ${show(offered)}, not a list; expected ${expected.groups.join(", ")}`);
		return found;
	}
	const missing = expected.groups.filter((group) => !offered.includes(group));
	if (missing.length > 0) found.push(`hello: the daemon's groups lack ${missing.join(", ")}, which the provider declares`);
	const extra = offered.filter((group) => !(expected.groups as unknown[]).includes(group));
	if (extra.length > 0) found.push(`hello: the daemon offers groups ${extra.map(text).join(", ")}, which the provider does not declare`);
	return found;
}
