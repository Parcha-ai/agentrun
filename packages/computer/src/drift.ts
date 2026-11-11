// The drift check for a Docker computer: what the computer reports of itself after create, from docker inspect and the
// daemon's hello, against what was declared. Pure: no Docker call. Each mismatch is one sentence; none is an empty list.
import { join } from "node:path";
import { EGRESS_MOUNT, EGRESS_SOCKET, type EgressCode, egressNameOf, egressOf, policyWords, RELAY_FLAG, sameAllow } from "./docker/egress.js";
import { type DockerVolume, engineOf, subpathOf } from "./docker/volume.js";
import { type MountReadBack, WORKSPACE } from "./mount.js";
import { type ComputerKind, type Group, type HelloResult, NETWORK_FENCES } from "./protocol.js";
import type { ComputerSpec, NetworkPolicy, NetworkSpec } from "./provider.js";

/** Where the daemon is mounted in each computer, read-only. */
export const DAEMON_IN_COMPUTER = "/opt/agentrun/computerd";
/** With the Docker provider's volume option, where the daemon's staged directory is mounted read-only: its computerd is
 *  DAEMON_IN_COMPUTER (src/docker/stage.ts). */
export const DAEMON_DIR_IN_COMPUTER = "/opt/agentrun";
export const COMPUTER_LABEL = "agentrun.computer";
export const DEADLINE_LABEL = "agentrun.computer.deadline";
/** Serve's box sizes, when the spec names none. */
export const DEFAULT_CPUS = 2;
export const DEFAULT_MEMORY_MB = 4096;
export const DEFAULT_PIDS = 1024;
/** CPUs are a CFS quota of each 100 ms, as serve gives them: Docker refuses a --cpus above its own CPU count. */
export const CPU_PERIOD_US = 100_000;
/** The computer's home and default workdir: a tmpfs its user owns. The run's folder, when bound, is at WORKSPACE. */
export const WORK = "/work";
/** Where init's socket lives (the daemon's DefaultSocket's directory): a tmpfs the computer's user owns, mode 0700. */
export const SOCKET_DIR = "/run/agentrun";

/**
 * The --tmpfs options of each tmpfs a computer gets, owned by its uid:gid. A tmpfs's pages count against the
 * computer's memory, so /work holds half of it: a full /work is ENOSPC before the memory limit could OOM-kill a
 * process. /run/agentrun holds only init's socket.
 */
export function tmpfsOf(user: string, memoryMb: number): Record<string, string> {
	const [uid, gid] = user.split(":");
	return {
		[WORK]: `rw,nosuid,nodev,exec,uid=${uid},gid=${gid},mode=0700,size=${Math.floor(memoryMb / 2)}m`,
		[SOCKET_DIR]: `rw,noexec,nosuid,nodev,uid=${uid},gid=${gid},mode=0700,size=1m`,
	};
}

/** The parts of `docker inspect` a computer is checked by; HostConfig and Config are checked whole. */
export interface DockerInspect {
	Id?: string;
	Name?: string;
	State?: { Running?: boolean; Status?: string; ExitCode?: number; Error?: string };
	AppArmorProfile?: string;
	ProcessLabel?: string;
	Config?: {
		User?: string;
		Image?: string;
		WorkingDir?: string;
		Env?: string[] | null;
		Entrypoint?: string[] | null;
		Cmd?: string[] | null;
		Labels?: Record<string, string> | null;
		[field: string]: unknown;
	};
	HostConfig?: {
		NetworkMode?: string;
		CapDrop?: string[] | null;
		CapAdd?: string[] | null;
		Privileged?: boolean;
		SecurityOpt?: string[] | null;
		PidsLimit?: number | null;
		Memory?: number;
		MemorySwap?: number;
		CpuPeriod?: number;
		CpuQuota?: number;
		Tmpfs?: Record<string, string> | null;
		Mounts?: Array<Record<string, unknown>> | null;
		MaskedPaths?: string[] | null;
		ReadonlyPaths?: string[] | null;
		[field: string]: unknown;
	};
	Mounts?: Array<{ Type?: string; Name?: string; Source?: string; Destination?: string; RW?: boolean; Propagation?: string }> | null;
	NetworkSettings?: { Networks?: Record<string, unknown> | null };
}

/** What `docker info` reports of the host's enforcement, as the provider reads it. */
export interface DockerInfo {
	Architecture?: string;
	SecurityOptions?: string[] | null;
	MemoryLimit?: boolean;
	SwapLimit?: boolean;
	PidsLimit?: boolean;
	CPUCfsQuota?: boolean;
	CPUCfsPeriod?: boolean;
	ServerVersion?: string;
}

/** A Docker host as the provider reads it: its architecture in Go's names, its security modules, and what it lacks. */
export interface DockerHost {
	arch: string;
	/** The Docker Engine's major version (docker info's ServerVersion), when it reads as one. */
	engine?: number;
	apparmor: boolean;
	selinux: boolean;
	/** Each enforcement the host lacks, in words; a computer is refused on a host with any. */
	problems: string[];
	/**
	 * Present when the host remaps user ids (docker info's name=userns: userns-remap; name=rootless: rootless Docker): a
	 * computer's uid is then another uid on the host. No problem for a computer, but a bind of the run folder is refused.
	 */
	remap?: "userns" | "rootless";
}

/** docker info names the kernel's architecture; hello names Go's. */
const GO_ARCH: Record<string, string> = { x86_64: "amd64", aarch64: "arm64" };

/**
 * The host's enforcement, from docker info. A computer's sizes are cgroup limits, so a host that does not enforce one
 * makes it configuration only; seccomp is required, since a computer's only syscall filter is Docker's default
 * profile. AppArmor and SELinux are read, not required: a host has the one its distribution ships or neither, and a
 * computer must then carry the profile or label Docker gives every container (the drift check).
 */
export function hostOf(info: DockerInfo | null | undefined): DockerHost {
	const problems: string[] = [];
	const lacks = (flag: unknown, what: string, so: string) => {
		if (flag !== true) problems.push(`this Docker host does not enforce ${what}, so ${so}`);
	};
	lacks(info?.MemoryLimit, "memory limits", "a computer's memory size is only configuration");
	lacks(info?.SwapLimit, "swap limits", "a computer could swap past its memory size");
	lacks(info?.PidsLimit, "pids limits", "a computer's pids limit is only configuration");
	lacks(info?.CPUCfsQuota, "CPU quotas", "a computer's cpus are only configuration");
	lacks(info?.CPUCfsPeriod, "CPU periods", "a computer's cpus are only configuration");
	const options = Array.isArray(info?.SecurityOptions) ? info.SecurityOptions.filter((option) => typeof option === "string") : [];
	const named = (name: string) => options.find((option) => option.split(",").includes(`name=${name}`));
	const seccomp = named("seccomp");
	if (seccomp === undefined) problems.push("this Docker host has no seccomp, so a computer could make any system call");
	else if (seccomp.split(",").includes("profile=unconfined")) {
		problems.push("this Docker host's default seccomp profile is unconfined, so a computer could make any system call");
	}
	const machine = typeof info?.Architecture === "string" ? info.Architecture : "";
	const remap = named("userns") !== undefined ? "userns" : named("rootless") !== undefined ? "rootless" : undefined;
	const engine = engineOf(info?.ServerVersion);
	return { arch: GO_ARCH[machine] ?? machine, apparmor: named("apparmor") !== undefined, selinux: named("selinux") !== undefined, problems, ...(remap ? { remap } : {}), ...(engine === undefined ? {} : { engine }) };
}

/** What the daemon must report: the provider's version, kind and groups, and the host's architecture. */
export interface HelloExpected {
	version: string;
	kind: ComputerKind;
	groups: Group[];
	/** Go's name (amd64, arm64); not checked when absent. */
	arch?: string;
	/** The daemon was started with --own-network: hello must say which fence holds its programs (NETWORK_FENCES). */
	fence?: true;
}

export interface DriftExpected extends HelloExpected {
	/** The daemon file on the host the computer binds, as it was mounted: for DockerProvider, its copy of the daemon. */
	daemonPath: string;
	/** The deadline label's value, as it was set. */
	deadline: string;
	/** The uid:gid the computer was asked to run as. */
	user: string;
	/** Whether the host's Docker gives every container an AppArmor profile, or an SELinux label (hostOf). */
	apparmor: boolean;
	selinux: boolean;
	/** For a computer with an allowlist: its proxy container's inspect (none when it is gone), and where the proxy's code
	 *  is on the host, as it was bound. */
	proxy?: DockerInspect | null;
	egressCode?: EgressCode;
	/** For a computer with an allowlist: the Docker host's own addresses its proxy must refuse (its --local holds each). */
	hostAddresses?: readonly string[];
	/** The provider's volume option: the daemon and the run's folder are then that volume's subpaths, not binds. */
	volume?: DockerVolume;
}

/**
 * How create mounts a path of this host at `target`: a bind of it, or, with the provider's volume option, the volume's
 * subpath, as HostConfig.Mounts records it (Docker keeps `volume-nocopy` and the subpath under VolumeOptions). Undefined
 * for a path outside the volume, which create never mounts.
 */
export function mountAsked(path: string, target: string, readonly: boolean, volume: DockerVolume | undefined): Record<string, unknown> | undefined {
	if (volume === undefined) return { Type: "bind", Source: path, Target: target, ...(readonly ? { ReadOnly: true } : {}) };
	const subpath = subpathOf(volume, path);
	if (subpath === undefined) return undefined;
	return { Type: "volume", Source: volume.name, Target: target, ...(readonly ? { ReadOnly: true } : {}), VolumeOptions: { NoCopy: true, Subpath: subpath } };
}

const show = (value: unknown) => (value === undefined ? "nothing" : JSON.stringify(value));
const text = (value: unknown) => (typeof value === "string" ? value : show(value));
const sameList = (a: unknown, b: string[]) => Array.isArray(a) && a.length === b.length && a.every((item, i) => item === b[i]);
/** Docker's default for a field it reports: nothing, an empty string, list or map, zero or false. A map with any key,
 *  even to an empty value (a VOLUME's {}), is not. */
const blank = (value: unknown): boolean =>
	value === undefined || value === null || value === "" || value === 0 || value === false || (typeof value === "object" && Object.keys(value).length === 0);
/** Docker's masked and read-only paths in every release since 20.10; a newer one masks more. */
const MASKED_PATHS = ["/proc/acpi", "/proc/asound", "/proc/kcore", "/proc/keys", "/proc/latency_stats", "/proc/sched_debug", "/proc/scsi", "/proc/timer_list", "/proc/timer_stats", "/sys/firmware"];
const READONLY_PATHS = ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"];
const holds = (value: unknown, paths: string[]) => Array.isArray(value) && paths.every((path) => value.includes(path));

/**
 * The closed check of HostConfig. A field named here is checked in drift() for what create asked for, is checked
 * here for a default other than blank, or is irrelevant (its value widens nothing the box bounds). Every other field,
 * one Docker adds later included, must be blank.
 */
const HOST_ASKED = new Set(["NetworkMode", "CapDrop", "CapAdd", "Privileged", "SecurityOpt", "PidsLimit", "Memory", "MemorySwap", "CpuPeriod", "CpuQuota", "Tmpfs", "Mounts", "IpcMode", "CgroupnsMode", "MaskedPaths", "ReadonlyPaths", "Runtime"]);
const HOST_DEFAULTS: Record<string, [(value: unknown) => boolean, string]> = {
	RestartPolicy: [
		(v) => {
			const { Name, MaximumRetryCount, ...rest } = (v ?? {}) as Record<string, unknown>;
			return (blank(Name) || Name === "no") && blank(MaximumRetryCount) && Object.values(rest).every(blank);
		},
		'no restart ("no")',
	],
	Isolation: [(v) => blank(v) || v === "default", "Docker's default"],
	MemorySwappiness: [(v) => blank(v) || v === -1, "the kernel's (null)"],
};
/** Values the host or Docker chooses that a computer cannot widen itself by: logs, the console, /dev/shm (charged to the
 *  computer's memory), rlimits (inside the cgroup's limits) and the file create's cid would go to. */
const HOST_IRRELEVANT = new Set(["ContainerIDFile", "LogConfig", "ConsoleSize", "ShmSize", "Ulimits"]);
/** The closed check of Config, the same way: the image's own settings that run only inside the computer are irrelevant. */
const CONFIG_ASKED = new Set(["User", "Image", "WorkingDir", "Env", "Entrypoint", "Cmd", "Labels"]);
const CONFIG_IRRELEVANT = new Set([
	"Hostname", "Domainname", "AttachStdin", "AttachStdout", "AttachStderr", "Tty", "OpenStdin", "StdinOnce", "ExposedPorts", "Healthcheck",
	"ArgsEscaped", "OnBuild", "StopSignal", "StopTimeout", "Shell", "MacAddress", "NetworkDisabled",
]);

/** A mount's options as a set, so their order is no drift. */
const optionSet = (options: unknown) => (typeof options === "string" ? options.split(",").sort().join(",") : undefined);

/** Whether a computer's inspect shows any part of an allowlist: the egress volume at its path, or init's relay. */
export function egressShaped(inspected: DockerInspect | null | undefined): boolean {
	const cmd = inspected?.Config?.Cmd;
	return (inspected?.Mounts ?? []).some((mount) => mount.Destination === EGRESS_MOUNT) || (Array.isArray(cmd) && cmd.includes(RELAY_FLAG));
}

/**
 * The network a computer is on, read back from inspect: `none` is network mode none on no network but Docker's own
 * `none`, `open` is the default bridge alone. An allowlist is network mode none with the computer's egress volume
 * mounted read-only at EGRESS_MOUNT and init relaying to its socket, and the list read back from `proxy`, the
 * computer's proxy container's inspect (egressOf: none when it is gone), which must refuse each of `local`, the Docker
 * host's own addresses. Anything else is reported in words, never as a policy it might widen to.
 */
export function networkOf(inspected: DockerInspect | null | undefined, proxy?: DockerInspect | null, code?: EgressCode, local?: readonly string[]): NetworkPolicy {
	const mode = inspected?.HostConfig?.NetworkMode;
	const networks = Object.keys(inspected?.NetworkSettings?.Networks ?? {}).sort();
	const none = mode === "none" && networks.every((name) => name === "none");
	const where = `network mode ${mode ?? "unknown"} on networks ${networks.join(", ") || "none"}`;
	if (!egressShaped(inspected)) {
		if (none) return "none";
		if (mode === "bridge" && sameList(networks, ["bridge"])) return "open";
		return { other: where };
	}
	if (!none) return { other: `${where}, with an egress volume or relay, which this provider never makes` };
	const name = (inspected?.Name ?? "").replace(/^\//, "");
	const at = (inspected?.Mounts ?? []).filter((mount) => mount.Destination === EGRESS_MOUNT);
	const cmd = inspected?.Config?.Cmd;
	const relay = Array.isArray(cmd) ? cmd.indexOf(RELAY_FLAG) : -1;
	if (at.length === 0) return { other: `init's relay points at ${show(Array.isArray(cmd) ? cmd[relay + 1] : undefined)} but no egress volume is mounted at ${EGRESS_MOUNT}` };
	if (relay < 0) return { other: `an egress volume at ${EGRESS_MOUNT} but no relay in init's command` };
	if (cmd?.[relay + 1] !== EGRESS_SOCKET) return { other: `init relays to ${show(cmd?.[relay + 1])}, not ${EGRESS_SOCKET}` };
	const [only] = at;
	if (at.length !== 1 || only?.Type !== "volume" || only.Name !== egressNameOf(name) || only.RW !== false) {
		return { other: `the egress volume at ${EGRESS_MOUNT} is ${at.map(mountWords).join(", ")}, not ${egressNameOf(name)} read-only` };
	}
	return egressOf(proxy, { name, user: inspected?.Config?.User, deadline: inspected?.Config?.Labels?.[DEADLINE_LABEL], running: inspected?.State?.Running === true }, code, local);
}

/** Whether a policy read back is the one declared: the same string, or an allowlist with the same entries, normalized. */
export function samePolicy(declared: NetworkSpec, read: NetworkPolicy): boolean {
	if (typeof declared === "string" || typeof read === "string") return declared === read;
	return "allow" in declared && "allow" in read && sameAllow(declared.allow, read.allow);
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

type InspectMount = NonNullable<DockerInspect["Mounts"]>[number];
/** One mount as a person reads it: "a read-write bind of /runs/r1". */
const mountWords = (mount: InspectMount) => `a ${mount.RW === true ? "read-write" : "read-only"} ${mount.Type ?? "mount"} of ${mount.Source ?? mount.Name ?? "nothing"}`;

/**
 * What is mounted at /workspace, read back from inspect: a read-write bind is the run's folder; nothing is undefined;
 * anything else (read-only, a volume, two mounts) is reported in words, never as a bind it might be.
 */
export function mountOf(inspected: DockerInspect | null | undefined, volume?: DockerVolume): MountReadBack | undefined {
	const at = (inspected?.Mounts ?? []).filter((mount) => mount.Destination === WORKSPACE);
	const [only] = at;
	if (only === undefined) return undefined;
	if (volume === undefined && at.length === 1 && only.Type === "bind" && only.RW === true && typeof only.Source === "string") return { kind: "bind", path: only.Source };
	// With the provider's volume option, the folder is the volume's subpath, read read-write from HostConfig.Mounts, and
	// reported as the path below the root create was given.
	if (volume !== undefined && at.length === 1 && only.Type === "volume" && only.Name === volume.name && only.RW === true) {
		const asked = (inspected?.HostConfig?.Mounts ?? []).filter((mount) => mount.Target === WORKSPACE);
		const subpath = (asked[0]?.VolumeOptions as { Subpath?: unknown } | undefined)?.Subpath;
		if (asked.length === 1 && asked[0]?.Type === "volume" && asked[0].Source === volume.name && typeof subpath === "string" && subpath !== "" && !subpath.split("/").includes("..")) {
			return { kind: "bind", path: join(volume.root, subpath) };
		}
	}
	return { other: `${at.map(mountWords).join(", ")} at ${WORKSPACE}` };
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
	if (expected.fence && !(NETWORK_FENCES as readonly unknown[]).includes(hello?.fence)) {
		found.push(`hello: the daemon reports fence ${text(hello?.fence)}: init was started with --own-network, so its programs must be held behind one, ${NETWORK_FENCES.join(" or ")}`);
	}
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

/** Every way a created computer differs from its spec, from inspect and hello. */
export function drift(spec: ComputerSpec, inspected: DockerInspect | null | undefined, hello: HelloResult | null | undefined, expected: DriftExpected): string[] {
	return [...inspectDrift(spec, inspected, expected), ...helloDrift(hello, expected)];
}

/** Every way a computer's docker inspect differs from its spec: the fields create asks for, and the closed check. */
export function inspectDrift(spec: ComputerSpec, inspected: DockerInspect | null | undefined, expected: DriftExpected): string[] {
	const found: string[] = [];
	const mismatch = (field: string, declared: unknown, actual: unknown) => found.push(`${field}: declared ${show(declared)}, read back ${show(actual)}`);
	const host = inspected?.HostConfig ?? {};
	const config = inspected?.Config ?? {};

	const network = networkOf(inspected, expected.proxy, expected.egressCode, expected.hostAddresses);
	if (!samePolicy(spec.network, network)) found.push(`network: declared ${policyWords(spec.network)}, read back ${policyWords(network)}`);
	const allowed = typeof spec.network === "object" && spec.network !== null && "allow" in spec.network;
	const volume = egressNameOf((inspected?.Name ?? "").replace(/^\//, ""));
	if (!sameList(host.CapDrop, ["ALL"])) mismatch("CapDrop", ["ALL"], host.CapDrop);
	if ((host.CapAdd ?? []).length > 0) mismatch("CapAdd", [], host.CapAdd);
	if (host.Privileged !== false) mismatch("Privileged", false, host.Privileged);
	if (!sameList(host.SecurityOpt, ["no-new-privileges"])) mismatch("SecurityOpt", ["no-new-privileges"], host.SecurityOpt);
	if (host.IpcMode !== "private") mismatch("IpcMode", "private", host.IpcMode);
	if (host.CgroupnsMode !== "private") mismatch("CgroupnsMode", "private", host.CgroupnsMode);
	if (host.Runtime !== "runc") mismatch("Runtime", "runc", host.Runtime);
	if (!holds(host.MaskedPaths, MASKED_PATHS)) found.push(`MaskedPaths: must hold Docker's ${show(MASKED_PATHS)}, read back ${show(host.MaskedPaths)}`);
	if (!holds(host.ReadonlyPaths, READONLY_PATHS)) found.push(`ReadonlyPaths: must hold Docker's ${show(READONLY_PATHS)}, read back ${show(host.ReadonlyPaths)}`);
	const pids = spec.pids ?? DEFAULT_PIDS;
	if (host.PidsLimit !== pids) mismatch("PidsLimit", pids, host.PidsLimit);
	const memoryMb = spec.memoryMb ?? DEFAULT_MEMORY_MB;
	const bytes = memoryMb * 1024 * 1024;
	if (host.Memory !== bytes) mismatch("Memory", bytes, host.Memory);
	if (host.MemorySwap !== bytes) mismatch("MemorySwap", bytes, host.MemorySwap);
	if (host.CpuPeriod !== CPU_PERIOD_US) mismatch("CpuPeriod", CPU_PERIOD_US, host.CpuPeriod);
	const quota = Math.round((spec.cpus ?? DEFAULT_CPUS) * CPU_PERIOD_US);
	if (host.CpuQuota !== quota) mismatch("CpuQuota", quota, host.CpuQuota);
	const tmpfs = host.Tmpfs ?? {};
	const tmpfsAsked = tmpfsOf(expected.user, memoryMb);
	for (const [path, options] of Object.entries(tmpfsAsked)) {
		if (optionSet(tmpfs[path]) !== optionSet(options)) mismatch(`tmpfs ${path}`, options, tmpfs[path]);
	}
	for (const [path, options] of Object.entries(tmpfs)) {
		if (!(path in tmpfsAsked)) found.push(`tmpfs ${path}: none declared but /work and /run/agentrun, read back ${show(options)}`);
	}
	// A Docker computer takes a bind alone; check() refuses any other kind, so one here is drift, named by its kind only.
	if (spec.mount !== undefined && spec.mount.kind !== "bind") found.push(`mount: declared a mount of kind ${String(spec.mount.kind)}, which a Docker computer never makes`);
	const bound = spec.mount?.kind === "bind" ? spec.mount.path : undefined;
	// In create's order: the daemon read-only, then the run's folder read-write at /workspace when one was asked for, then
	// the egress volume read-only for an allowlist.
	// With the provider's volume option the daemon and the folder are the volume's subpaths (mountAsked).
	const shared = expected.volume;
	// The daemon's file is bound at DAEMON_IN_COMPUTER; with the volume option its staged directory is at /opt/agentrun.
	const daemonAt = shared === undefined ? DAEMON_IN_COMPUTER : DAEMON_DIR_IN_COMPUTER;
	const daemonAsked = mountAsked(expected.daemonPath, daemonAt, true, shared);
	const folderAsked = bound === undefined ? undefined : mountAsked(bound, WORKSPACE, false, shared);
	if (daemonAsked === undefined) found.push(`daemon mount: ${expected.daemonPath} is not below the volume root ${shared?.root}, so create never mounts it`);
	if (bound !== undefined && folderAsked === undefined) found.push(`workspace mount: ${bound} is not below the volume root ${shared?.root}, so create never mounts it`);
	const asked: Array<Record<string, unknown>> = [
		...(daemonAsked === undefined ? [] : [daemonAsked]),
		...(folderAsked === undefined ? [] : [folderAsked]),
		...(allowed ? [{ Type: "volume", Source: volume, Target: EGRESS_MOUNT, ReadOnly: true }] : []),
	];
	const hostMounts = host.Mounts ?? [];
	// An object (VolumeOptions) is the same when it holds the same fields; any other value, exactly.
	const same = (value: unknown, want: unknown): boolean =>
		typeof want === "object" && want !== null
			? typeof value === "object" && value !== null && Object.entries(value).every(([key, item]) => (key in want ? same(item, (want as Record<string, unknown>)[key]) : blank(item))) && Object.keys(want).every((key) => key in value)
			: value === want;
	const sameMount = (made: Record<string, unknown> | undefined, want: Record<string, unknown>) =>
		made !== undefined &&
		Object.entries(made).every(([key, value]) => (key in want ? same(value, want[key]) : blank(value))) &&
		Object.keys(want).every((key) => made[key] !== undefined);
	if (hostMounts.length !== asked.length || !asked.every((want, i) => sameMount(hostMounts[i], want))) mismatch("HostConfig.Mounts", asked, host.Mounts);
	for (const [field, value] of Object.entries(host)) {
		if (HOST_ASKED.has(field) || HOST_IRRELEVANT.has(field)) continue;
		const rule = HOST_DEFAULTS[field];
		if (rule ? !rule[0](value) : !blank(value)) found.push(`${field}: must be ${rule ? rule[1] : "Docker's default (empty)"}, read back ${show(value)}`);
	}

	if (config.User !== expected.user) mismatch("User", expected.user, config.User);
	if (config.Image !== spec.image) mismatch("Image", spec.image, config.Image);
	const workdir = spec.workdir ?? WORK;
	if (config.WorkingDir !== workdir) mismatch("WorkingDir", workdir, config.WorkingDir);
	const homes = (Array.isArray(config.Env) ? config.Env : []).filter((entry) => typeof entry === "string" && entry.startsWith("HOME="));
	if (!sameList(homes, [`HOME=${WORK}`])) mismatch("Env HOME", [`HOME=${WORK}`], homes);
	for (const [field, value] of Object.entries(config)) {
		if (!CONFIG_ASKED.has(field) && !CONFIG_IRRELEVANT.has(field) && !blank(value)) found.push(`${field}: must be Docker's default (empty), read back ${show(value)}`);
	}
	const apparmor = expected.apparmor ? "docker-default" : "";
	if ((inspected?.AppArmorProfile ?? "") !== apparmor) mismatch("AppArmorProfile", apparmor, inspected?.AppArmorProfile);
	const label = inspected?.ProcessLabel ?? "";
	if (expected.selinux ? !/^[^:]*:[^:]*:container_t:/.test(label) : label !== "") {
		mismatch("ProcessLabel", expected.selinux ? "the container_t type" : "", inspected?.ProcessLabel);
	}

	const mounts = inspected?.Mounts ?? [];
	const daemon = mounts.filter((mount) => mount.Destination === daemonAt);
	const [only] = daemon;
	// A bind shows its source; the volume's subpath shows as the volume (its subpath is HostConfig.Mounts', checked above).
	const fits = (mount: InspectMount | undefined, path: string, rw: boolean) =>
		mount !== undefined &&
		mount.RW === rw &&
		(shared === undefined ? mount.Type === "bind" && mount.Source === path && ["", "rprivate", undefined].includes(mount.Propagation) : mount.Type === "volume" && mount.Name === shared.name);
	const how = (path: string, rw: boolean, at: string) => `declared ${path} ${shared === undefined ? "bound" : `mounted from the volume ${shared.name}`} ${rw ? "read-write" : "read-only"} at ${at}`;
	if (daemon.length !== 1 || !fits(only, expected.daemonPath, false)) {
		found.push(`daemon mount: ${how(expected.daemonPath, false, daemonAt)}, read back ${show(daemon)}`);
	}
	if (bound !== undefined) {
		const workspace = mounts.filter((mount) => mount.Destination === WORKSPACE);
		const [one] = workspace;
		if (workspace.length !== 1 || !fits(one, bound, true)) {
			found.push(`workspace mount: ${how(bound, true, WORKSPACE)}, read back ${show(workspace)}`);
		}
	}
	// The egress volume itself, its name, type and mode, is the network's read-back above.
	const declared = ["the daemon's", ...(bound === undefined ? [] : ["the run folder's"]), ...(allowed ? ["the egress volume's"] : [])].join(" and ");
	for (const mount of mounts) {
		if (mount.Destination === daemonAt || (bound !== undefined && mount.Destination === WORKSPACE) || (allowed && mount.Destination === EGRESS_MOUNT)) continue;
		found.push(`${mount.Type ?? "unknown"} mount: none declared but ${declared}, read back ${show(mount)}`);
	}
	if (!sameList(config.Entrypoint, [DAEMON_IN_COMPUTER])) mismatch("Entrypoint", [DAEMON_IN_COMPUTER], config.Entrypoint);
	const cmd = ["init", "--deadline", expected.deadline, ...(allowed ? [RELAY_FLAG, EGRESS_SOCKET] : [])];
	if (!sameList(config.Cmd, cmd)) mismatch("Cmd", cmd, config.Cmd);

	const labels = config.Labels ?? {};
	if (labels[COMPUTER_LABEL] !== "1") mismatch(`label ${COMPUTER_LABEL}`, "1", labels[COMPUTER_LABEL]);
	if (labels[DEADLINE_LABEL] !== expected.deadline) mismatch(`label ${DEADLINE_LABEL}`, expected.deadline, labels[DEADLINE_LABEL]);
	for (const [key, value] of Object.entries(spec.labels ?? {})) {
		if (labels[key] !== value) mismatch(`label ${key}`, value, labels[key]);
	}
	return found;
}
