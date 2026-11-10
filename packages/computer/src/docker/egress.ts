// A Docker computer's way out to the network when its spec asks for an allowlist ({ allow: [names or CIDRs] }): the
// computer stays `--network none`, and its own egress proxy runs in a second container the provider makes, reads back
// and removes with it. Moved from serve's box-egress.ts and rewritten onto the provider: the proxy no longer lives in the
// process that made the computer, so the computer keeps its network when that process ends, and attach and list read it
// back from Docker anywhere.
//
//  - The volume `<computer>-egress`: a tmpfs of 1 MiB, mode 0700, owned by the computer's uid:gid. The proxy's Unix
//    socket is made in it; the computer mounts it read-only at EGRESS_MOUNT.
//  - The proxy container `<computer>-egress`: this package's own proxy (egress-main.ts, egress-proxy.ts, egress-table.ts,
//    bound read-only from dist/docker with the package's package.json), in a pinned Node image, on Docker's default
//    bridge alone, publishing no port, as the computer's uid:gid, with a read-only root, no capability, no privilege to
//    gain, and bounded memory, pids and log. Its argv holds the list, the computer's deadline (it ends itself then), the
//    Docker host's own public addresses (refused as this host's) and the hint. It holds no key.
//  - The computer: init gets `--egress <socket>` and relays its loopback port 3128 to the socket, and tells every program
//    it starts that port is its HTTP and HTTPS proxy. A program that ignores that reaches nothing: there is no route.
//  - Both carry the label EGRESS_LABEL=<computer>; release finds the proxy and the volume by it, never by name alone.
import { existsSync, readFileSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { DEADLINE_LABEL, type DockerInspect } from "../drift.js";
import type { NetworkPolicy } from "../provider.js";
import { LISTED_PORTS, parseAllow } from "./egress-proxy.js";
import { checkAddress } from "./egress-table.js";

/** The proxy container's image: node:22.23.4-bookworm-slim, pinned to its multi-arch index digest (as serve pins its
 *  own), so every host runs the same Node. The provider's `egress.image` replaces it. */
export const EGRESS_IMAGE = "node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d";
/** The label the proxy container and the volume carry: the computer's name. In the provider's own namespace, which a
 *  spec's labels cannot use. */
export const EGRESS_LABEL = "agentrun.computer.egress";
/** Where the computer mounts the volume, read-only, and the proxy's socket in it: what init's relay connects to. */
export const EGRESS_MOUNT = "/opt/agentrun/egress";
export const EGRESS_SOCKET = `${EGRESS_MOUNT}/egress.sock`;
/** Init's flag for the relay: computerd init --egress <socket>. */
export const RELAY_FLAG = "--egress";
/** The most entries of each kind an allowlist holds: Docker's own bound, so the list fits one argv element. */
export const MAX_ALLOW = 256;
/** How long create waits for the proxy's ready line, by default. */
export const EGRESS_READY_MS = 10_000;
/** In the proxy container: the volume, its socket, and its code. */
const PROXY_VOLUME = "/egress";
const PROXY_SOCKET = `${PROXY_VOLUME}/egress.sock`;
const PROXY_CODE = "/code/docker";
const PROXY_PACKAGE = "/code/package.json";
/** With the provider's volume option, the staged tree (src/docker/stage.ts) mounted whole: docker/ and package.json. */
const PROXY_ROOT = "/code";
const PROXY_MAIN = `${PROXY_CODE}/egress-main.js`;
/** The files the proxy container runs, in dist/docker. */
export const CODE_FILES = ["egress-main.js", "egress-proxy.js", "egress-table.js"];
const EXAMPLE = '["pypi.org", "*.pythonhosted.org", "93.184.215.0/24"]';

/** The proxy container's name, and the volume's, for computer `name`. */
export const egressNameOf = (name: string): string => `${name}-egress`;

/** Where the proxy's code is on this machine: this package's dist/docker, and its package.json, which makes Node read
 *  the files as modules. */
export interface EgressCode {
	dir: string;
	packageJson: string;
	/** With the provider's volume option: the code is staged below the volume's root in one tree (src/docker/stage.ts),
	 *  `root` its subpath (undefined when unknown), which the proxy mounts whole at /code. */
	volume?: { name: string; root?: string };
}

/** This package's own build: the directory this file is in, and the package's package.json. */
export function egressCode(): EgressCode {
	return { dir: fileURLToPath(new URL(".", import.meta.url)).replace(/\/$/, ""), packageJson: fileURLToPath(new URL("../../package.json", import.meta.url)) };
}

/**
 * Why the proxy's code cannot be bound, in words, or undefined when it can: every file built, each readable by `user`
 * (uid:gid) and its directory searchable, by the owner's, group's or others' bits as the kernel picks them, since the
 * proxy runs as the computer's user with no capability.
 */
export function egressCodeProblem({ dir, packageJson }: EgressCode, user: string): string | undefined {
	const files = [...CODE_FILES.map((file) => `${dir}/${file}`), packageJson];
	const missing = files.filter((path) => !existsSync(path) || !statSync(path).isFile());
	if (missing.length > 0) return `the egress proxy's code is not built (${missing.join(", ")}): run npm run build -w @parcha/agentrun-computer`;
	if (/[,"\r\n]/.test(dir + packageJson)) return `the egress proxy's code is at a path a Docker mount cannot hold (a comma, a double quote or a line break): ${dir}`;
	const [uid, gid] = user.split(":").map(Number);
	const bits = (path: string) => {
		const { uid: owner, gid: group, mode } = statSync(path);
		return owner === uid ? (mode >> 6) & 7 : group === gid ? (mode >> 3) & 7 : mode & 7;
	};
	const closed = [...((bits(dir) & 5) === 5 ? [] : [dir]), ...files.filter((path) => (bits(path) & 4) === 0)];
	if (closed.length > 0) {
		return `the egress proxy's code is not readable by the computer's user ${user} (${closed.join(", ")}); the proxy runs as that user with no capabilities: chmod a+rX them`;
	}
	return undefined;
}

/**
 * A spec's allowlist, normalized as the proxy reads it (parseAllow: lowercase, a name's trailing dot dropped, no
 * repeats), or why Docker cannot hold it, in words.
 */
export function allowOf(entries: unknown): { list: string[] } | { problem: string } {
	if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === "string")) return { problem: `an allowlist is a list of names and CIDRs, such as ${EXAMPLE}` };
	if (entries.length === 0) return { problem: 'an allowlist needs at least one name or CIDR; for no network ask for "none"' };
	let list: string[];
	try {
		list = parseAllow(entries);
	} catch (error) {
		return { problem: (error as Error).message };
	}
	if (list.length === 0) return { problem: 'an allowlist needs at least one name or CIDR; for no network ask for "none"' };
	const cidrs = list.filter((entry) => entry.includes("/")).length;
	const names = list.length - cidrs;
	if (names > MAX_ALLOW) return { problem: `a Docker allowlist holds at most ${MAX_ALLOW} names, not ${names}` };
	if (cidrs > MAX_ALLOW) return { problem: `a Docker allowlist holds at most ${MAX_ALLOW} CIDRs, not ${cidrs}` };
	return { list };
}

/** Whether two allowlists hold the same entries, normalized, in any order. */
export function sameAllow(a: readonly string[], b: readonly string[]): boolean {
	const left = allowOf(a);
	const right = allowOf(b);
	if ("problem" in left || "problem" in right) return false;
	return left.list.length === right.list.length && left.list.every((entry) => right.list.includes(entry));
}

/** This machine's own public addresses, as its interfaces hold them: the proxy refuses them as the host's. A private or
 *  local one needs no entry; the address rule refuses it anyway. They are the Docker host's only when this provider runs
 *  on it, not in a container and not against a daemon elsewhere (containerSigns, and the provider's own check). */
export function hostAddresses(): string[] {
	const all = Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((entry) => entry.address));
	return [...new Set(all.filter((address) => checkAddress(address, []).ok))];
}

/** A container's cgroup path, under any manager that names one: Docker, containerd, Kubernetes, Podman, LXC, BuildKit. */
const CONTAINER_CGROUP = /(^|[/.:-])(docker|containerd|cri-containerd|kubepods|libpod|lxc|buildkit)([/.:-]|$)/;

/**
 * What shows this process runs in a container, under `root` (the filesystem's root; a test's seam): /.dockerenv (Docker),
 * /run/.containerenv (Podman), or a line of /proc/self/cgroup naming a container's cgroup. Undefined when none does. A
 * cgroup namespace's bare root (a lone slash after the hierarchy) is no evidence either way. A container with none of these is not seen: the
 * caller then still has its own interfaces, which is why egress.hostAddresses exists.
 */
export function containerSigns(root = "/"): string | undefined {
	const at = (path: string) => `${root.replace(/\/$/, "")}${path}`;
	if (existsSync(at("/.dockerenv"))) return "/.dockerenv exists";
	if (existsSync(at("/run/.containerenv"))) return "/run/.containerenv exists";
	let cgroup = "";
	try {
		cgroup = readFileSync(at("/proc/self/cgroup"), "utf8");
	} catch {
		return undefined;
	}
	const line = cgroup.split("\n").find((entry) => CONTAINER_CGROUP.test(entry.slice(entry.indexOf(":", entry.indexOf(":") + 1) + 1)));
	return line === undefined ? undefined : `/proc/self/cgroup names a container's cgroup (${line.slice(0, 120)})`;
}

/** `docker volume create` of a computer's volume: tmpfs, so nothing of it outlives the daemon, and its user's alone. It
 *  carries the computer's name, its deadline and the spec's labels, so the janitor finds it when the computer is gone. */
export function egressVolumeArgs(name: string, user: string, deadline: string, labels: Record<string, string> = {}): string[] {
	const [uid, gid] = user.split(":");
	const args = ["volume", "create", "--driver", "local", "--opt", "type=tmpfs", "--opt", "device=tmpfs", "--opt", `o=size=1m,uid=${uid},gid=${gid},mode=0700`];
	args.push("--label", `${EGRESS_LABEL}=${name}`, "--label", `${DEADLINE_LABEL}=${deadline}`);
	for (const [key, value] of Object.entries(labels)) args.push("--label", `${key}=${value}`);
	return [...args, egressNameOf(name)];
}

export interface EgressRun {
	name: string;
	user: string;
	image: string;
	allow: readonly string[];
	local: readonly string[];
	deadline: string;
	code: EgressCode;
	hint?: string;
	/** The spec's labels, which the proxy container carries too. */
	labels?: Record<string, string>;
}

/** The proxy container's bounds, as create sets them and the read-back holds it to: memory (swap the same), processes,
 *  half a CPU (a quota of each 100 ms, as a computer's cpus are; fixed, not the computer's own, since one proxy's work
 *  is its connections, not the computer's size), at most 1024 open files, and a bounded json-file log. */
const PROXY_MEMORY_MB = 256;
const PROXY_PIDS = 64;
const PROXY_CPU_PERIOD_US = 100_000;
const PROXY_CPU_QUOTA_US = 50_000;
const PROXY_NOFILE = 1024;
const PROXY_LOG = { driver: "json-file", options: { "max-size": "1m", "max-file": "2" } } as const;

/** `docker run` of a computer's proxy container (see the head of this file). Pinned by a golden test. */
export function egressRunArgs({ name, user, image, allow, local, deadline, code, hint, labels = {} }: EgressRun): string[] {
	const proxy = egressNameOf(name);
	const args = ["run", "--detach", "--name", proxy, "--label", `${EGRESS_LABEL}=${name}`, "--label", `${DEADLINE_LABEL}=${deadline}`];
	for (const [key, value] of Object.entries(labels)) args.push("--label", `${key}=${value}`);
	args.push("--user", user, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--ipc", "private", "--cgroupns", "private");
	const memory = `${PROXY_MEMORY_MB}m`;
	args.push("--pids-limit", String(PROXY_PIDS), "--memory", memory, "--memory-swap", memory);
	args.push("--cpu-period", String(PROXY_CPU_PERIOD_US), "--cpu-quota", String(PROXY_CPU_QUOTA_US), "--ulimit", `nofile=${PROXY_NOFILE}:${PROXY_NOFILE}`);
	args.push("--log-driver", PROXY_LOG.driver);
	for (const [key, value] of Object.entries(PROXY_LOG.options)) args.push("--log-opt", `${key}=${value}`);
	args.push("--network", "bridge");
	args.push("--mount", `type=volume,src=${proxy},dst=${PROXY_VOLUME}`);
	if (code.volume === undefined) {
		args.push("--mount", `type=bind,src=${code.dir},dst=${PROXY_CODE},readonly`, "--mount", `type=bind,src=${code.packageJson},dst=${PROXY_PACKAGE},readonly`);
	} else {
		// With the provider's volume option, the staged tree, one directory, as the volume's subpath: the Docker daemon has
		// none of this process's paths.
		args.push("--mount", `type=volume,src=${code.volume.name},dst=${PROXY_ROOT},volume-subpath=${code.volume.root ?? ""},volume-nocopy,readonly`);
	}
	// Create pulled the image before it made the volume, so this run never pulls: the sweep's grace holds.
	args.push("--pull", "never");
	args.push("--entrypoint", "node", image, PROXY_MAIN, "--socket", PROXY_SOCKET, "--deadline", deadline, "--allow", allow.join(","));
	if (local.length > 0) args.push("--local", local.join(","));
	if (hint !== undefined) args.push("--hint", hint);
	return args;
}

const show = (value: unknown) => (value === undefined ? "nothing" : JSON.stringify(value));
const blank = (value: unknown): boolean =>
	value === undefined || value === null || value === "" || value === 0 || value === false || (typeof value === "object" && Object.keys(value).length === 0);

/** What a computer's read-back needs of the computer itself. */
export interface EgressOwner {
	name: string;
	/** The computer's Config.User. */
	user: unknown;
	/** The computer's deadline label. */
	deadline: unknown;
	running: boolean;
}

/**
 * A computer's allowlist, read back from its proxy container's inspect: the list its argv holds, when the container is
 * the computer's own (its label and deadline), running while the computer runs, and as create makes one (Docker's
 * default bridge alone, no port, the computer's user, a read-only root, no capability or privilege, exactly its volume
 * and its code, `code`'s when given), refusing every one of `local`, the Docker host's own addresses the provider
 * requires now (more is fine). Anything less is `{ other }` in words, never an allowlist. A host whose addresses
 * changed since the proxy was made reads as other: fail closed.
 */
export function egressOf(proxy: DockerInspect | null | undefined, owner: EgressOwner, code?: EgressCode, local: readonly string[] = []): { allow: string[] } | { other: string } {
	const named = egressNameOf(owner.name);
	const other = (what: string) => ({ other: `network allow, but its egress proxy ${named} ${what}` });
	if (proxy === undefined || proxy === null) return other("is gone: the computer reaches nothing");
	const config = proxy.Config ?? {};
	const host = proxy.HostConfig ?? {};
	const labels = config.Labels ?? {};
	if ((proxy.Name ?? "").replace(/^\//, "") !== named) return other(`is named ${show(proxy.Name)}`);
	if (labels[EGRESS_LABEL] !== owner.name) return other(`does not carry the label ${EGRESS_LABEL}=${owner.name} (it reads ${show(labels[EGRESS_LABEL])})`);
	if (labels[DEADLINE_LABEL] !== owner.deadline) return other(`has the deadline label ${show(labels[DEADLINE_LABEL])}, not the computer's ${show(owner.deadline)}`);
	if (owner.running && proxy.State?.Running !== true) return other(`is not running (exit code ${show(proxy.State?.ExitCode)}): the computer reaches nothing`);
	const networks = Object.keys(proxy.NetworkSettings?.Networks ?? {});
	if (host.NetworkMode !== "bridge" || networks.length !== 1 || networks[0] !== "bridge") return other(`is on network mode ${String(host.NetworkMode)} and networks ${networks.join(", ") || "none"}, not Docker's default bridge alone`);
	if (host.Privileged !== false) return other("is privileged");
	const capDrop = host.CapDrop;
	if (!Array.isArray(capDrop) || capDrop.length !== 1 || capDrop[0] !== "ALL" || !blank(host.CapAdd)) return other(`keeps capabilities (CapDrop ${show(capDrop)}, CapAdd ${show(host.CapAdd)})`);
	const securityOpt = host.SecurityOpt;
	if (!Array.isArray(securityOpt) || securityOpt.length !== 1 || securityOpt[0] !== "no-new-privileges") return other(`lacks no-new-privileges alone (SecurityOpt ${show(securityOpt)})`);
	if (host.ReadonlyRootfs !== true) return other("has no read-only root");
	const bytes = PROXY_MEMORY_MB * 1024 * 1024;
	if (host.Memory !== bytes) return other(`has memory ${show(host.Memory)}, not ${bytes}`);
	if (host.MemorySwap !== bytes) return other(`has memory swap ${show(host.MemorySwap)}, not ${bytes}`);
	if (host.PidsLimit !== PROXY_PIDS) return other(`has pids limit ${show(host.PidsLimit)}, not ${PROXY_PIDS}`);
	if (host.IpcMode !== "private") return other(`has IPC mode ${show(host.IpcMode)}, not "private"`);
	if (host.CgroupnsMode !== "private") return other(`has cgroup namespace ${show(host.CgroupnsMode)}, not "private"`);
	if (host.CpuPeriod !== PROXY_CPU_PERIOD_US || host.CpuQuota !== PROXY_CPU_QUOTA_US) {
		return other(`has CPU quota ${show(host.CpuQuota)} of ${show(host.CpuPeriod)}, not ${PROXY_CPU_QUOTA_US} of ${PROXY_CPU_PERIOD_US}`);
	}
	const ulimits = host.Ulimits;
	const [nofile] = Array.isArray(ulimits) ? (ulimits as Array<Record<string, unknown>>) : [];
	if (!Array.isArray(ulimits) || ulimits.length !== 1 || nofile?.Name !== "nofile" || nofile.Soft !== PROXY_NOFILE || nofile.Hard !== PROXY_NOFILE) {
		return other(`has the open-file limit ${show(ulimits)}, not nofile ${PROXY_NOFILE}:${PROXY_NOFILE}`);
	}
	const log = (host.LogConfig ?? {}) as { Type?: unknown; Config?: Record<string, unknown> | null };
	const logOptions = log.Config ?? {};
	const wanted = Object.entries(PROXY_LOG.options);
	if (log.Type !== PROXY_LOG.driver || Object.keys(logOptions).length !== wanted.length || !wanted.every(([key, value]) => logOptions[key] === value)) {
		return other(`has the log ${show(log)}, not ${PROXY_LOG.driver} with ${wanted.map(([key, value]) => `${key} ${value}`).join(" and ")}`);
	}
	if (!blank(host.PortBindings) || host.PublishAllPorts === true) return other("publishes ports");
	for (const field of ["Binds", "VolumesFrom", "Devices", "PidMode", "UsernsMode"]) if (!blank(host[field])) return other(`has ${field} ${show(host[field])}`);
	if (config.User !== owner.user) return other(`runs as ${show(config.User).replaceAll('"', "")}, not the computer's ${show(owner.user).replaceAll('"', "")}`);
	const mounts = proxy.Mounts ?? [];
	// The code: binds of `code`'s paths, or, with the provider's volume option, the staged tree at /code, the volume's
	// subpath (checked below in HostConfig.Mounts, which records it; Mounts shows the volume by name).
	const shared = code?.volume;
	const codeMounts =
		shared === undefined
			? [
					{ Type: "bind", Destination: PROXY_CODE, RW: false, ...(code ? { Source: code.dir } : {}) },
					{ Type: "bind", Destination: PROXY_PACKAGE, RW: false, ...(code ? { Source: code.packageJson } : {}) },
				]
			: [{ Type: "volume", Name: shared.name, Destination: PROXY_ROOT, RW: false }];
	const want = [{ Type: "volume", Name: named, Destination: PROXY_VOLUME, RW: true }, ...codeMounts];
	const fits = mounts.length === want.length && want.every((wanted) => mounts.some((mount) => Object.entries(wanted).every(([key, value]) => (mount as Record<string, unknown>)[key] === value)));
	if (!fits) return other(`has mounts ${show(mounts.map((m) => `${m.Type} ${m.Name ?? m.Source} at ${m.Destination}${m.RW ? "" : " read-only"}`))}, not its volume read-write at ${PROXY_VOLUME} and its code read-only`);
	if (shared !== undefined) {
		const asked = (host.Mounts ?? []).filter((mount) => mount.Target === PROXY_ROOT);
		const subpath = (asked[0]?.VolumeOptions as { Subpath?: unknown } | undefined)?.Subpath;
		const right = asked.length === 1 && asked[0]?.Type === "volume" && asked[0].Source === shared.name && asked[0].ReadOnly === true && (shared.root === undefined ? typeof subpath === "string" && subpath !== "" : subpath === shared.root);
		if (!right) return other(`mounts ${show(asked)} at ${PROXY_ROOT}, not the staged code's subpath ${show(shared.root)} of the volume ${shared.name}, read-only`);
	}
	const entrypoint = config.Entrypoint;
	if (!Array.isArray(entrypoint) || entrypoint.length !== 1 || entrypoint[0] !== "node") return other(`has the entrypoint ${show(entrypoint)}, not node`);
	const cmd = Array.isArray(config.Cmd) ? config.Cmd : [];
	const flags = new Map<string, string>();
	for (let at = 1; at + 1 < cmd.length; at += 2) flags.set(String(cmd[at]), String(cmd[at + 1]));
	if (cmd[0] !== PROXY_MAIN || cmd.length % 2 !== 1 || flags.size !== (cmd.length - 1) / 2) return other(`runs ${show(cmd)}, not ${PROXY_MAIN} and its flags`);
	if (!flags.has("--allow")) return other("has no host list in its command");
	if (flags.get("--socket") !== PROXY_SOCKET) return other(`listens on ${show(flags.get("--socket"))}, not ${PROXY_SOCKET}`);
	if (flags.get("--deadline") !== owner.deadline) return other(`ends at ${show(flags.get("--deadline"))}, not the computer's deadline ${show(owner.deadline)}`);
	const unknown = [...flags.keys()].filter((flag) => !["--socket", "--deadline", "--allow", "--local", "--hint"].includes(flag));
	if (unknown.length > 0) return other(`runs with flags ${unknown.join(", ")}, which create never gives`);
	const read = allowOf((flags.get("--allow") ?? "").split(","));
	if ("problem" in read) return other(`holds a list this provider never makes: ${read.problem}`);
	// The host block: a --local removed or shortened lets the computer reach the Docker host's own addresses.
	const refused = new Set((flags.get("--local") ?? "").split(",").filter(Boolean));
	const missing = local.filter((address) => !refused.has(address));
	if (missing.length > 0) {
		return other(`does not refuse the Docker host's ${missing.length === 1 ? "address" : "addresses"} ${missing.join(", ")} (its --local reads ${show(flags.get("--local"))})`);
	}
	return { allow: read.list };
}

/** The ports each entry of a Docker allowlist opens. */
export const ALLOW_PORTS: number[] = [...LISTED_PORTS];

/** A policy as a refusal or a read-back names it. */
export const policyWords = (policy: NetworkPolicy): string => (typeof policy === "string" ? policy : "other" in policy ? policy.other : JSON.stringify(policy));
