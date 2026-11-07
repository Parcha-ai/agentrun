// The drift check for a Docker computer: what the computer reports of itself after create, from docker inspect and the
// daemon's hello, against what was declared. Pure: no Docker call. Each mismatch is one sentence; none is an empty list.
import type { ComputerKind, Group, HelloResult } from "./protocol.js";
import type { ComputerSpec, NetworkPolicy } from "./provider.js";

/** Where the daemon is mounted in each computer, read-only. */
export const DAEMON_IN_COMPUTER = "/opt/agentrun/computerd";
export const COMPUTER_LABEL = "agentrun.computer";
export const DEADLINE_LABEL = "agentrun.computer.deadline";
/** Serve's box sizes, when the spec names none. */
export const DEFAULT_CPUS = 2;
export const DEFAULT_MEMORY_MB = 4096;
export const DEFAULT_PIDS = 1024;
/** CPUs are a CFS quota of each 100 ms, as serve gives them: Docker refuses a --cpus above its own CPU count. */
export const CPU_PERIOD_US = 100_000;
/** The computer's home and default workdir: a tmpfs its user owns, since a non-root user can write nowhere else. */
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
}

/** A Docker host as the provider reads it: its architecture in Go's names, its security modules, and what it lacks. */
export interface DockerHost {
	arch: string;
	apparmor: boolean;
	selinux: boolean;
	/** Each enforcement the host lacks, in words; a computer is refused on a host with any. */
	problems: string[];
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
	return { arch: GO_ARCH[machine] ?? machine, apparmor: named("apparmor") !== undefined, selinux: named("selinux") !== undefined, problems };
}

/** What the daemon must report: the provider's version, kind and groups, and the host's architecture. */
export interface HelloExpected {
	version: string;
	kind: ComputerKind;
	groups: Group[];
	/** Go's name (amd64, arm64); not checked when absent. */
	arch?: string;
}

export interface DriftExpected extends HelloExpected {
	/** The daemon binary on the host, as it was mounted. */
	daemonPath: string;
	/** The deadline label's value, as it was set. */
	deadline: string;
	/** The uid:gid the computer was asked to run as. */
	user: string;
	/** Whether the host's Docker gives every container an AppArmor profile, or an SELinux label (hostOf). */
	apparmor: boolean;
	selinux: boolean;
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

	const network = networkOf(inspected);
	if (network !== spec.network) found.push(`network: declared ${policyWords(spec.network)}, read back ${policyWords(network)}`);
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
	const asked = { Type: "bind", Source: expected.daemonPath, Target: DAEMON_IN_COMPUTER, ReadOnly: true };
	const [daemonMount, ...moreMounts] = host.Mounts ?? [];
	const sameMount = daemonMount !== undefined && Object.entries(daemonMount).every(([key, value]) => (key in asked ? asked[key as keyof typeof asked] === value : blank(value)));
	if (!sameMount || moreMounts.length > 0 || !Object.keys(asked).every((key) => daemonMount?.[key] !== undefined)) mismatch("HostConfig.Mounts", [asked], host.Mounts);
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
	const daemon = mounts.filter((mount) => mount.Destination === DAEMON_IN_COMPUTER);
	const [only] = daemon;
	if (daemon.length !== 1 || only?.Type !== "bind" || only.Source !== expected.daemonPath || only.RW !== false || !["", "rprivate", undefined].includes(only.Propagation)) {
		found.push(`daemon mount: declared ${expected.daemonPath} bound read-only at ${DAEMON_IN_COMPUTER}, read back ${show(daemon)}`);
	}
	for (const mount of mounts) {
		if (mount.Destination !== DAEMON_IN_COMPUTER) found.push(`${mount.Type ?? "unknown"} mount: none declared but the daemon's, read back ${show(mount)}`);
	}
	if (!sameList(config.Entrypoint, [DAEMON_IN_COMPUTER])) mismatch("Entrypoint", [DAEMON_IN_COMPUTER], config.Entrypoint);
	const cmd = ["init", "--deadline", expected.deadline];
	if (!sameList(config.Cmd, cmd)) mismatch("Cmd", cmd, config.Cmd);

	const labels = config.Labels ?? {};
	if (labels[COMPUTER_LABEL] !== "1") mismatch(`label ${COMPUTER_LABEL}`, "1", labels[COMPUTER_LABEL]);
	if (labels[DEADLINE_LABEL] !== expected.deadline) mismatch(`label ${DEADLINE_LABEL}`, expected.deadline, labels[DEADLINE_LABEL]);
	for (const [key, value] of Object.entries(spec.labels ?? {})) {
		if (labels[key] !== value) mismatch(`label ${key}`, value, labels[key]);
	}
	return found;
}
