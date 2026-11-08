// The Docker provisioner: every call through the docker CLI with execFile or spawn, never a shell. The hardening flags
// and the inspect reading follow pi-transport's Docker box.
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, type Stats, statSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "./client.js";
import { daemonCopy, defaultDaemonCache } from "./daemon-copy.js";
import { DESKTOP_GROUPS, type DesktopOptions, desktopOf, startDisplay } from "./desktop.js";
import {
	COMPUTER_LABEL,
	CPU_PERIOD_US,
	DAEMON_IN_COMPUTER,
	DEADLINE_LABEL,
	DEFAULT_CPUS,
	DEFAULT_MEMORY_MB,
	DEFAULT_PIDS,
	type DockerHost,
	type DockerInspect,
	type DriftExpected,
	drift,
	egressShaped,
	helloDrift,
	hostOf,
	inspectDrift,
	mountOf,
	networkOf,
	samePolicy,
	tmpfsOf,
	WORK,
} from "./drift.js";
import { DOCKER_RECIPE, type EnsureImageOptions, ensureImage, type ImageSource, imageSourceProblem } from "./docker/image.js";
import {
	ALLOW_PORTS,
	allowOf,
	containerSigns,
	EGRESS_IMAGE,
	EGRESS_LABEL,
	EGRESS_MOUNT,
	EGRESS_READY_MS,
	EGRESS_SOCKET,
	type EgressCode,
	egressCode,
	egressCodeProblem,
	egressNameOf,
	egressRunArgs,
	egressVolumeArgs,
	hostAddresses,
	MAX_ALLOW,
	policyWords,
	RELAY_FLAG,
} from "./docker/egress.js";
import { EGRESS_READY } from "./docker/egress-proxy.js";
import { addressBytes } from "./docker/egress-table.js";
import { checkMount, type MountKind, type MountReadBack, WORKSPACE } from "./mount.js";
import {
	type AttachedComputer,
	type CallContext,
	type ComputerCapabilities,
	checkLifetime,
	type ComputerConnection,
	type ComputerInfo,
	type ComputerProvider,
	type ComputerRef,
	type ComputerSpec,
	type NetworkPolicy,
	type NetworkSpec,
	type Refusal,
} from "./provider.js";
import { fail, ok, type Result } from "./result.js";

/**
 * A Docker desktop: an image with an X server (test/fixtures/desktop/Dockerfile is the smallest, Debian and Xvfb).
 * computerd stays the first process and starts nothing of its own: create gives it DISPLAY, then starts the X server
 * through it with process.start (startDisplay in ./desktop.ts).
 */
export type DockerDesktopOptions = DesktopOptions;

/** A computer's egress proxy, for a spec whose network is an allowlist (src/docker/egress.ts). */
export interface DockerEgressOptions {
	/** The proxy container's image: one with Node 22.19 or later as `node`. Default EGRESS_IMAGE, pinned by digest. */
	image?: string;
	/** What a refusal of a host off the list says to do, after its words: printable ASCII, since it goes into a status line. */
	hint?: string;
	/** How long create waits for the proxy to say it is ready before it gives up, in ms. Default 10 s. */
	readyMs?: number;
	/**
	 * The Docker host's own addresses, each an IP address, which the proxy refuses as the host's (this-host), beside this
	 * machine's public ones. Required for an allowlist when this provider's interfaces are not the Docker host's: it runs
	 * in a container (containerSigns), or its docker CLI talks to a daemon that is not a local unix socket.
	 */
	hostAddresses?: string[];
	/**
	 * The root of the filesystem containerSigns reads to tell whether this provider runs in a container (/.dockerenv,
	 * /run/.containerenv, /proc/self/cgroup under it): an absolute path, default "/". For tests and embedders that know
	 * better; it never makes the refusal weaker than what that root shows.
	 */
	hostRoot?: string;
}

export interface DockerProviderOptions {
	/** The daemon binary on this machine, for the computer's architecture (dist/computerd-linux-<arch>). Any mode this
	 *  process can read: a computer binds the provider's own 0755 copy of it (daemonCache), never this file. */
	daemonPath: string;
	/** The directory the provider copies the daemon into, the copy each computer binds: computerd-<sha256 of its bytes>,
	 *  mode 0755. Made 0700 when missing; refused in words when it is a link, another user's, open to other users, or
	 *  under a directory another user may write. Default agentrun-computer under XDG_CACHE_HOME, else ~/.cache. */
	daemonCache?: string;
	/** The egress proxy of a computer whose network is an allowlist. */
	egress?: DockerEgressOptions;
	/** Makes every computer a desktop (kind desktop): its image must have the X server. */
	desktop?: DockerDesktopOptions;
	/** The docker CLI. */
	docker?: string;
	/** Who a computer runs as when its spec does not say: uid or uid:gid, in numbers. Default: this process's uid:gid, or
	 *  1000:1000 when its uid or gid is 0. Root and root's group are refused here: a computer runs as either only when
	 *  its spec asks. */
	user?: string;
	/** The image its computers start from, which image() makes ready: a recipe, built once, or an image by name, pulled
	 *  when Docker has none. Default the provider's own recipe, DOCKER_RECIPE (src/docker/image.ts). */
	image?: ImageSource;
}

/** The environment fromEnv reads, by name. */
export const ENV = {
	/** The daemon binary for Docker's architecture; default this package's dist/computerd-linux-<arch>. */
	daemon: "COMPUTER_DOCKER_DAEMON",
	/** Who a computer runs as when its spec does not say, uid or uid:gid in numbers; see DockerProviderOptions.user. */
	user: "COMPUTER_DOCKER_USER",
} as const;

/** The mount kinds a Docker computer takes, as capabilities().mount declares them: a bind of a folder on this host. */
export const MOUNT: readonly MountKind[] = ["bind"];

export interface DockerFromEnvOptions extends Partial<DockerProviderOptions> {
	/** The longest `docker version` may take, when fromEnv asks Docker its architecture; default 30 s. */
	timeoutMs?: number;
}

/**
 * Docker's architecture as `docker version` reports it (amd64, arm64), within timeoutMs, or an error in words. The docker
 * CLI runs with this process's environment, as every call of the provider does, so it asks the Docker the provider uses.
 */
export function dockerArch({ docker = "docker", timeoutMs = 30_000 }: Pick<DockerFromEnvOptions, "docker" | "timeoutMs"> = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(docker, ["version", "--format", "{{.Server.Arch}}"], { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
			if (!error) return resolve(stdout.trim());
			const killed = error.killed === true && error.signal === "SIGKILL";
			const why = killed ? `${docker} version did not answer within ${timeoutMs / 1000} s, so it was killed` : (stderr.trim() || error.message).split("\n")[0];
			reject(new Error(`cannot ask Docker its architecture (${docker} version): ${why}`));
		});
	});
}

/**
 * A DockerProvider from COMPUTER_DOCKER_* alone. Without COMPUTER_DOCKER_DAEMON it asks Docker its architecture and takes
 * this package's daemon for it, and says when that daemon is not built. Options win over the environment. The image is
 * an option only (default the provider's own recipe): no image name is read from the environment.
 */
export async function fromEnv(env: Record<string, string | undefined> = process.env, options: DockerFromEnvOptions = {}): Promise<DockerProvider> {
	const { timeoutMs, ...given } = options;
	const user = env[ENV.user] || undefined;
	let daemonPath = given.daemonPath ?? (env[ENV.daemon] || undefined);
	if (daemonPath === undefined) {
		const arch = await dockerArch({ ...(given.docker ? { docker: given.docker } : {}), ...(timeoutMs === undefined ? {} : { timeoutMs }) });
		daemonPath = fileURLToPath(new URL(`./computerd-linux-${arch}`, import.meta.url));
		if (fileMode(daemonPath) === undefined) throw new Error(`no daemon for Docker's ${arch} at ${daemonPath}: run npm run build:daemon -w @parcha/agentrun-computer`);
	}
	return new DockerProvider({ ...(user === undefined ? {} : { user }), ...given, daemonPath });
}

/** The conformance CLI's module for Docker: the drifted twin. */
export const conformance = () => import("./conformance/docker.js");

const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const NAME = /^computer-[0-9a-f]{12}$/;
/** A container id, whole or its first 12 or more hex digits. */
const ID = /^[0-9a-f]{12,64}$/;
/** A user in numbers, uid or uid:gid; (uid_t)-1 is no user. */
const USER = /^(\d+)(?::(\d+))?$/;
const MAX_ID = 4_294_967_294;
const USER_FORM = "a uid or uid:gid in numbers, such as 1000:1000; a name is refused, since the image may not have it";
/** The kernel's PID_MAX_LIMIT: a larger --pids-limit fails the create. */
const MAX_PIDS = 4_194_304;
/** Docker's least --memory. */
const MIN_MEMORY_MB = 6;
const HELLO_TIMEOUT_MS = 30_000;
/** Ids a list() inspect takes at once, so its argv and output stay bounded however many computers match. */
const INSPECT_BATCH = 50;
/** Only the fields list() reads, in inspect's own shape: a whole inspect is kilobytes a container, and execFile's
 *  output is capped. The user and init's command are an allowlist's read-back: its relay, and its proxy's user. */
const LIST_FORMAT =
	'{"Id":{{json .Id}},"Name":{{json .Name}},"State":{"Running":{{json .State.Running}}},' +
	'"Config":{"Labels":{{json .Config.Labels}},"User":{{json .Config.User}},"Cmd":{{json .Config.Cmd}}},' +
	'"HostConfig":{"NetworkMode":{{json .HostConfig.NetworkMode}}},"NetworkSettings":{"Networks":{{json .NetworkSettings.Networks}}},"Mounts":{{json .Mounts}}}';
/** The longest lifetime: 30 days. A computer meant to live longer is asked for again. No extend(): the deadline is a
 *  container label, and a label cannot change after create. */
const MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const SPEC_FIELDS = new Set(["image", "lifetimeMs", "network", "cpus", "memoryMb", "pids", "labels", "workdir", "user", "mount"]);
const NUL = "a NUL byte cannot be passed to docker run";
/** What --mount's comma-separated fields cannot hold in a source path. */
const MOUNT_UNSAFE = /[,"\r\n]/;
/** Docker cannot move a container with no network onto one, nor take one off a network without a restart; an allowlist
 *  needs its volume mounted at create. */
const FIXED = "a Docker computer's network is fixed at create; create a new computer";
const NETWORKS = 'network is required: "none", "open" or { allow: [names or CIDRs] }';
/** How often create asks whether the egress proxy is ready. */
const EGRESS_POLL_MS = 100;
/** Only the fields hostOf reads, as JSON. */
const INFO_FORMAT =
	'{"Architecture":{{json .Architecture}},"SecurityOptions":{{json .SecurityOptions}},"MemoryLimit":{{json .MemoryLimit}},' +
	'"SwapLimit":{{json .SwapLimit}},"PidsLimit":{{json .PidsLimit}},"CPUCfsQuota":{{json .CPUCfsQuota}},"CPUCfsPeriod":{{json .CPUCfsPeriod}}}';

interface Ran {
	exitCode: number;
	stdout: string;
	stderr: string;
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isWhole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const noSuchContainer = (stderr: string) => /no such container/i.test(stderr);
const nameOf = (report: DockerInspect) => (report.Name ?? "").replace(/^\//, "");
/** Only a container this provider made counts: its label, and a name of its making. */
const ours = (report: DockerInspect) => report.Config?.Labels?.[COMPUTER_LABEL] === "1" && NAME.test(nameOf(report));

export class DockerProvider implements ComputerProvider {
	readonly id = "docker";
	readonly version = VERSION;
	readonly #daemonPath: string;
	readonly #daemonCache: string;
	readonly #docker: string;
	readonly #user: string;
	readonly #desktop: Required<DockerDesktopOptions> | undefined;
	readonly #image: ImageSource;
	readonly #egress: { image: string; hint?: string; readyMs: number; hostAddresses?: string[]; hostRoot: string };
	/** Why this provider's own interfaces are not the Docker host's, in words, or none: read once, for the first allowlist
	 *  with no egress.hostAddresses (#elsewhere). */
	#elsewhere: string | null | undefined;
	/** Where the egress proxy's code is: this package's own build. */
	readonly #code: EgressCode = egressCode();
	/** The host as docker info first read it: a host's enforcement does not change under a running provider. */
	#host: DockerHost | undefined;

	constructor({ daemonPath, daemonCache, docker = "docker", user, desktop, egress, image = { recipe: DOCKER_RECIPE } }: DockerProviderOptions) {
		this.#daemonPath = resolve(daemonPath);
		this.#daemonCache = resolve(daemonCache ?? defaultDaemonCache());
		this.#docker = docker;
		const unusable = imageSourceProblem(image);
		if (unusable !== undefined) throw new Error(`the provider's image: ${unusable}`);
		this.#image = image;
		this.#desktop = desktop === undefined ? undefined : desktopOf(desktop);
		this.#egress = egressOptionsOf(egress ?? {});
		const given = user === undefined ? defaultUser() : userOf(user);
		if (given === undefined) throw new Error(`the provider's user ${JSON.stringify(user)} must be ${USER_FORM}`);
		if (given.startsWith("0:")) throw new Error(`the provider's user ${user} is root; a computer runs as root only when its spec asks for user "0"`);
		if (given.endsWith(":0")) {
			throw new Error(`the provider's user ${user} is in root's group (gid 0); a computer is in group 0 only when its spec asks, such as user "${given}"`);
		}
		this.#user = given;
	}

	/** The uid:gid a computer runs as when its spec names no user: the user a bound run folder must be writable by. */
	get user(): string {
		return this.#user;
	}

	capabilities(): ComputerCapabilities {
		return {
			kind: this.#desktop ? "desktop" : "linux",
			lifetime: "janitor",
			network: ["none", "open", "allow"],
			allow: { domains: { max: MAX_ALLOW, ports: [...ALLOW_PORTS] }, cidrs: { max: MAX_ALLOW, ports: [...ALLOW_PORTS] }, mixed: true },
			networkReadBack: true,
			isolation: "container",
			os: "linux",
			daemon: "pid1",
			groups: ["exec", "files", "processes", ...(this.#desktop ? DESKTOP_GROUPS : [])],
			maxLifetimeMs: MAX_LIFETIME_MS,
			user: ["root", "uid"],
			release: ["stop", "delete"],
			stopDeletes: false,
			mount: [...MOUNT],
		};
	}

	/**
	 * The provider's image ready in Docker, and its tag for create's spec.image: built from its recipe, or pulled, when
	 * Docker has none; one inspect when it has. Concurrent calls in one process share one build (ensureImage).
	 */
	image(options: CallContext & Pick<EnsureImageOptions, "timeoutMs" | "onWait"> = {}): Promise<Result<string>> {
		return ensureImage(this.#image, { ...options, docker: this.#docker });
	}

	/** The spec's refusals, and the host's once create, attach or host() has read it: its problems, a bind or an
	 *  allowlist on a host that remaps user ids, and an allowlist on a Docker host this provider does not run on. */
	check(spec: ComputerSpec): Refusal[] {
		const host = this.#host;
		const remapped = host?.remap !== undefined && spec?.mount?.kind === "bind" ? [{ field: "mount", message: remapWords(host.remap, String(spec.mount.path)) }] : [];
		const allowed: Refusal[] = [];
		if (isAllow(spec?.network)) {
			if (host?.remap !== undefined) allowed.push({ field: "network", message: remapAllowWords(host.remap) });
			if (typeof this.#elsewhere === "string" && this.#egress.hostAddresses === undefined) allowed.push({ field: "network", message: elsewhereWords(this.#elsewhere) });
		}
		return [...this.#checkSpec(spec), ...remapped, ...allowed, ...(host?.problems ?? []).map((message) => ({ field: "host", message }))];
	}

	#checkSpec(spec: ComputerSpec): Refusal[] {
		const refusals: Refusal[] = [];
		const refuse = (field: string, message: string) => refusals.push({ field, message });
		const given = spec as unknown as Record<string, unknown>;
		const { image, lifetimeMs, network, cpus, memoryMb, pids, labels, workdir, user, mount } = given;
		if (typeof image !== "string" || image.trim() === "" || image.startsWith("-")) {
			refuse("image", "an image is required, such as debian:bookworm-slim");
		} else if (image.includes("\0")) refuse("image", NUL);
		refusals.push(...checkLifetime(lifetimeMs, this.capabilities()));
		if (typeof network === "object" && network !== null && "allow" in network) {
			const allow = allowOf((network as { allow: unknown }).allow);
			if ("problem" in allow) refuse("network", allow.problem);
		} else if (network !== "none" && network !== "open") refuse("network", NETWORKS);
		if (cpus !== undefined && !(isNumber(cpus) && cpus >= 0.01)) refuse("cpus", "cpus must be a number of CPUs of at least 0.01");
		if (memoryMb !== undefined && !(isWhole(memoryMb) && memoryMb >= MIN_MEMORY_MB)) {
			refuse("memoryMb", `memoryMb must be a whole number of MiB, at least ${MIN_MEMORY_MB}`);
		}
		if (pids !== undefined && !(isWhole(pids) && pids > 0 && pids <= MAX_PIDS)) {
			refuse("pids", `pids must be a whole number from 1 to ${MAX_PIDS}`);
		}
		if (labels !== undefined) {
			const entries = typeof labels === "object" && labels !== null && !Array.isArray(labels) ? Object.entries(labels) : undefined;
			const bad = entries === undefined ? "labels must map names to strings" : entries.map(([key, value]) => labelProblem(key, value)).find(Boolean);
			if (bad) refuse("labels", bad);
		}
		if (workdir !== undefined && !(typeof workdir === "string" && workdir.startsWith("/"))) {
			refuse("workdir", "workdir must be an absolute path in the computer");
		} else if (workdir?.includes("\0")) refuse("workdir", NUL);
		if (user !== undefined && userOf(user) === undefined) refuse("user", `user must be ${USER_FORM}`);
		const mounts = checkMount(mount, this.capabilities().mount);
		refusals.push(...mounts);
		const path = (mount as { path?: unknown } | undefined)?.path;
		if (mounts.length === 0 && typeof path === "string" && MOUNT_UNSAFE.test(path)) {
			refuse("mount", `mount.path ${JSON.stringify(path)}: a Docker mount cannot hold a comma, a double quote or a line break in its path`);
		}
		for (const [field, value] of Object.entries(given)) {
			if (!SPEC_FIELDS.has(field) && value !== undefined) refuse(field, `a Docker computer does not support ${field}`);
		}
		return refusals;
	}

	async create(spec: ComputerSpec, { signal }: { signal?: AbortSignal } = {}): Promise<Result<ComputerRef>> {
		const refusals = this.check(spec);
		if (refusals.length > 0) return fail("refused", refusals.map(({ field, message }) => `${field}: ${message}`).join("; "));
		const user = userOf(spec.user) ?? this.#user;
		const bound = spec.mount?.kind === "bind" ? spec.mount.path : undefined;
		const daemon = this.#daemon();
		if (!daemon.ok) return daemon;
		// An allowlist: the list as the proxy reads it, and the proxy's code, built.
		const allow = typeof spec.network === "object" ? (allowOf(spec.network.allow) as { list: string[] }).list : undefined;
		if (allow !== undefined) {
			const unbuilt = egressCodeProblem(this.#code, user);
			if (unbuilt !== undefined) return fail("not_found", unbuilt);
		}
		if (signal?.aborted) return fail("aborted", "create was aborted before Docker was called");
		const host = await this.host({ signal });
		if (!host.ok) return host;
		if (host.value.problems.length > 0) return fail("refused", `host: ${host.value.problems.join("; ")}`);
		// Under remapped ids the egress volume and the proxy's code belong to host ids the computer's user is not.
		if (allow !== undefined && host.value.remap !== undefined) return fail("refused", `network: ${remapAllowWords(host.value.remap)}`);
		// The proxy refuses the Docker host's own addresses only when it knows them: this machine's, when it is that host.
		if (allow !== undefined && this.#egress.hostAddresses === undefined) {
			const elsewhere = await this.#elsewhereOf(signal);
			if (!elsewhere.ok) return elsewhere;
			if (elsewhere.value !== null) return fail("refused", `network: ${elsewhereWords(elsewhere.value)}`);
		}
		if (bound !== undefined) {
			// Under remapped ids the folder's owner on the host is not the computer's user: refuse, never guess the mapping.
			if (host.value.remap !== undefined) return fail("refused", `mount: ${remapWords(host.value.remap, bound)}`);
			// The run folder is bound as it is: the computer's user, with no capabilities, must be able to write it.
			const unwritable = folderProblem(bound, user);
			if (unwritable !== undefined) return fail("refused", `mount: ${unwritable}`);
		}
		if (allow !== undefined) {
			// Both images on the host before the volume is made, so nothing from the volume to the computer pulls: the
			// sweep takes a proxy with no computer past its grace for a create that died (#leftoverGraceMs).
			for (const image of new Set([spec.image, this.#egress.image])) {
				const pulled = await this.#pull(image, signal);
				if (!pulled.ok) return pulled;
			}
		}
		if (signal?.aborted) return fail("aborted", "create was aborted before docker run");
		const name = `computer-${randomBytes(6).toString("hex")}`;
		const deadline = new Date(Date.now() + spec.lifetimeMs).toISOString();
		if (allow !== undefined) {
			// The proxy first, ready before the computer exists: a computer never runs with an allowlist it cannot reach.
			const started = await this.#startEgress(name, user, deadline, allow, spec.labels ?? {}, signal);
			if (!started.ok) {
				const removed = await this.release({ id: name, name }, "delete");
				const after = removed.ok ? "its proxy and volume were removed" : `its proxy and volume could not be removed (${removed.error.message})`;
				return fail(started.error.code, `${started.error.message}; the computer ${name} was never run, and ${after}`);
			}
		}
		const args = ["run", "--detach", "--name", name, "--label", `${COMPUTER_LABEL}=1`, "--label", `${DEADLINE_LABEL}=${deadline}`];
		for (const [key, value] of Object.entries(spec.labels ?? {})) args.push("--label", `${key}=${value}`);
		const memoryMb = spec.memoryMb ?? DEFAULT_MEMORY_MB;
		args.push("--user", user, "--env", `HOME=${WORK}`);
		if (this.#desktop) args.push("--env", `DISPLAY=${this.#desktop.display}`);
		for (const [path, options] of Object.entries(tmpfsOf(user, memoryMb))) args.push("--tmpfs", `${path}:${options}`);
		args.push("--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", String(spec.pids ?? DEFAULT_PIDS));
		// Not the daemon's defaults, which a host may set to shareable IPC or, on cgroup v1, the host's cgroup namespace.
		args.push("--ipc", "private", "--cgroupns", "private");
		// An allowlist's computer has no network either: its one way out is the proxy's socket.
		args.push("--network", spec.network === "open" ? "bridge" : "none");
		args.push("--cpu-period", String(CPU_PERIOD_US), "--cpu-quota", String(Math.round((spec.cpus ?? DEFAULT_CPUS) * CPU_PERIOD_US)));
		// Memory and swap together are the memory: swap never adds to it.
		const memory = `${memoryMb}m`;
		args.push("--memory", memory, "--memory-swap", memory);
		args.push("--mount", `type=bind,src=${daemon.value},dst=${DAEMON_IN_COMPUTER},readonly`, "--entrypoint", DAEMON_IN_COMPUTER);
		// The run's folder, read-write at /workspace; HOME and the default workdir stay /work.
		if (bound !== undefined) args.push("--mount", `type=bind,src=${bound},dst=${WORKSPACE}`);
		// The proxy's volume, read-only: the computer reaches its socket and cannot replace it. Its image was pulled before
		// the volume was made, so this run never pulls.
		if (allow !== undefined) args.push("--mount", `type=volume,src=${egressNameOf(name)},dst=${EGRESS_MOUNT},readonly`, "--pull", "never");
		args.push("--workdir", spec.workdir ?? WORK);
		// PID 1 ends the computer at the deadline the label holds, so a computer the janitor misses still stops. With an
		// allowlist it relays its loopback port 3128 to the proxy's socket, and names that port as every program's proxy.
		args.push(spec.image, "init", "--deadline", deadline, ...(allow === undefined ? [] : [RELAY_FLAG, EGRESS_SOCKET]));

		const started = await this.#run(args, signal);
		if (!started.ok || started.value.exitCode !== 0) {
			// A run that failed or was aborted may still have made the container; an allowlist's proxy and volume go with it.
			await this.release({ id: name, name }, "delete");
			return started.ok ? fail("docker", `docker run failed: ${started.value.stderr.trim()}`) : started;
		}
		const ref = { id: started.value.stdout.trim(), name };
		// From here the computer exists: every step takes the caller's signal, and an abort deletes the computer.
		const inspected = await this.#inspect([name], signal);
		if (signal?.aborted) return this.#abandon(ref);
		const report = inspected.ok ? inspected.value[0] : undefined;
		const state = report?.State;
		if (state?.Running !== true) {
			await this.release(ref, "delete");
			const why = state ? `status ${state.Status}, exit code ${state.ExitCode}${state.Error ? `: ${state.Error}` : ""}` : "it could not be inspected";
			return fail("docker", `the computer ${name} was not running after its start (${why}), so it was removed`);
		}
		if (this.#desktop) {
			const shown = await this.#startDisplay(ref, this.#desktop, signal);
			if (signal?.aborted) return this.#abandon(ref);
			if (!shown.ok) {
				const removed = await this.release(ref, "delete");
				const after = removed.ok ? "was deleted" : `could not be deleted (${removed.error.message})`;
				return fail(shown.error.code, `the computer ${name} ${after}: ${shown.error.message}`);
			}
		}
		const checked = await this.#check(spec, ref, report as DockerInspect, host.value, deadline, user, daemon.value, signal);
		// Fail closed: no create returns ok once its signal has aborted.
		if (signal?.aborted) return this.#abandon(ref);
		if (checked.ok) return ok(ref);
		// Fail closed: a computer that is not what was declared, or that cannot show it is, does not outlive create.
		const removed = await this.release(ref, "delete");
		const after = removed.ok ? "was deleted" : `could not be deleted (${removed.error.message})`;
		return fail(checked.error.code, `the computer ${name} ${after}: ${checked.error.message}`);
	}

	/** Makes sure `image` is on the Docker host: docker image inspect, and docker pull when it is not there. */
	async #pull(image: string, signal?: AbortSignal): Promise<Result<void>> {
		const aborted = () => fail("aborted", `create was aborted while it looked for or pulled the image ${image}; nothing was made`);
		const found = await this.#run(["image", "inspect", "--format", "{{.Id}}", image], signal);
		if (!found.ok) return signal?.aborted ? aborted() : found;
		if (found.value.exitCode === 0) return ok(undefined);
		const pulled = await this.#run(["pull", image], signal);
		if (!pulled.ok) return signal?.aborted ? aborted() : pulled;
		if (pulled.value.exitCode !== 0) return fail("docker", `docker pull ${image} failed, so nothing was made: ${pulled.value.stderr.trim()}`);
		return ok(undefined);
	}

	/** Deletes a computer whose create was aborted after docker run; the delete itself is not signalled. */
	async #abandon(ref: ComputerRef): Promise<Result<never>> {
		const removed = await this.release(ref, "delete");
		const after = removed.ok ? "was deleted" : `could not be deleted (${removed.error.message})`;
		return fail("aborted", `create was aborted after docker run; the computer ${ref.name} ${after}`);
	}

	/**
	 * Makes computer `name`'s egress volume and proxy container (src/docker/egress.ts) and waits, within the provider's
	 * bound, until the proxy logs its ready line. A proxy that ends first fails with its own last words. The caller
	 * removes whatever was made when this fails.
	 */
	async #startEgress(name: string, user: string, deadline: string, allow: string[], labels: Record<string, string>, signal?: AbortSignal): Promise<Result<void>> {
		const proxy = egressNameOf(name);
		const volume = await this.#run(egressVolumeArgs(name, user, deadline, labels), signal);
		if (!volume.ok) return volume;
		if (volume.value.exitCode !== 0) return fail("docker", `docker volume create ${proxy} failed: ${volume.value.stderr.trim()}`);
		const { image, hint, readyMs } = this.#egress;
		const args = egressRunArgs({ name, user, image, allow, local: this.#hostLocal(), deadline, code: this.#code, labels, ...(hint === undefined ? {} : { hint }) });
		const ran = await this.#run(args, signal);
		if (!ran.ok) return ran;
		if (ran.value.exitCode !== 0) return fail("docker", `docker run of the egress proxy ${proxy} failed: ${ran.value.stderr.trim()}`);
		// Every call of the poll ends at the readiness bound, so a docker that stops answering cannot hold create past it: a
		// call the bound cut off is the timeout, and the caller's own abort stays aborted.
		const bound = AbortSignal.timeout(readyMs);
		const either = signal ? AbortSignal.any([signal, bound]) : bound;
		const late = () => fail("timeout", `the egress proxy ${proxy} was not ready within ${readyMs / 1000} s`);
		const cut = <T>(result: Result<T>): Result<T> => {
			if (result.ok) return result;
			if (signal?.aborted) return fail("aborted", `create was aborted while the egress proxy ${proxy} started`);
			return bound.aborted ? late() : result;
		};
		for (;;) {
			const logs = cut(await this.#run(["logs", proxy], either));
			if (!logs.ok) return logs;
			const said = `${logs.value.stdout}\n${logs.value.stderr}`;
			if (said.split("\n").some((line) => line.startsWith(EGRESS_READY))) return ok(undefined);
			const found = cut(await this.#inspect([proxy], either));
			if (!found.ok) return found;
			const state = found.value[0]?.State;
			if (state?.Running !== true) {
				const words = said.trim().split("\n").filter(Boolean).slice(-3).join("; ");
				return fail("docker", `the egress proxy ${proxy} ended (exit code ${state?.ExitCode ?? "unknown"}) before it was ready${words ? `: ${words}` : ""}`);
			}
			await sleep(EGRESS_POLL_MS, undefined, { signal: either }).catch(() => undefined);
			if (signal?.aborted) return fail("aborted", `create was aborted while the egress proxy ${proxy} started`);
			if (bound.aborted) return late();
		}
	}

	/** Starts the desktop's X server through the daemon and waits until hello declares the display (startDisplay). */
	async #startDisplay(ref: ComputerRef, desktop: Required<DockerDesktopOptions>, signal?: AbortSignal): Promise<Result<void>> {
		const opened = await this.#open(ref, signal);
		if (!opened.ok) return opened;
		try {
			return await startDisplay(opened.value.client, desktop, { version: VERSION, vendor: "docker", signal });
		} finally {
			await opened.value.close();
		}
	}

	/** The drift check: the computer's own report, from inspect and from its daemon's hello, against the spec. */
	async #check(spec: ComputerSpec, ref: ComputerRef, report: DockerInspect, host: DockerHost, deadline: string, user: string, daemonPath: string, signal?: AbortSignal): Promise<Result<void>> {
		const proxy = await this.#proxyOf(report, signal);
		if (!proxy.ok) return proxy;
		const opened = await this.#open(ref, signal);
		if (!opened.ok) return opened;
		await opened.value.close();
		const found = drift(spec, report, opened.value.hello, this.#expected(host, deadline, user, daemonPath, proxy.value));
		return found.length === 0 ? ok(undefined) : fail("refused", `it did not match its spec: ${found.join("; ")}`);
	}

	/** What the drift check holds a computer to; daemonPath is the file it binds, the provider's copy of the daemon. */
	#expected(host: DockerHost, deadline: string, user: string, daemonPath: string, proxy?: DockerInspect | null): DriftExpected {
		const { arch, apparmor, selinux } = host;
		const { kind, groups } = this.capabilities();
		return { version: VERSION, kind, groups, arch, apparmor, selinux, daemonPath, deadline, user, proxy, egressCode: this.#code, hostAddresses: this.#hostLocal() };
	}

	/**
	 * The Docker host's own addresses the egress proxy refuses (its --local): this machine's public ones and
	 * egress.hostAddresses. Create gives them to the proxy, and every read-back holds the proxy to them as they are now.
	 */
	#hostLocal(): string[] {
		return [...new Set([...hostAddresses(), ...(this.#egress.hostAddresses ?? [])])];
	}

	/**
	 * The daemon file a computer binds: the provider's 0755 copy of daemonPath in daemonCache (daemonCopy), so a daemon
	 * installed under any umask runs as any computer user, and the file that is every computer's init sits where only
	 * this user may change it. Always the copy, even of a 0755 daemon, so create and attach have one path to compare.
	 */
	#daemon(): Result<string> {
		const copied = daemonCopy(this.#daemonPath, this.#daemonCache);
		if (copied.ok && MOUNT_UNSAFE.test(copied.value)) {
			return fail("invalid", `the daemon's copy ${copied.value} has a comma, a double quote or a line break in its path, which a Docker mount cannot hold: give the provider another daemonCache`);
		}
		return copied;
	}

	/** The egress proxy container's inspect for a computer that shows any part of an allowlist, null when it is gone;
	 *  undefined, with no Docker call, for any other computer. */
	async #proxyOf(report: DockerInspect, signal?: AbortSignal): Promise<Result<DockerInspect | null | undefined>> {
		if (!egressShaped(report)) return ok(undefined);
		const found = await this.#inspect([egressNameOf(nameOf(report))], signal);
		return found.ok ? ok(found.value[0] ?? null) : found;
	}

	/**
	 * Why this provider's own interfaces are not the Docker host's, in words, or null when they are: it runs in a
	 * container (containerSigns), or its docker CLI talks to a daemon that is not a local unix socket, as the CLI itself
	 * resolves its context and DOCKER_HOST (`docker context inspect`). A CLI that cannot say is a reason too. Read once.
	 */
	async #elsewhereOf(signal?: AbortSignal): Promise<Result<string | null>> {
		if (this.#elsewhere !== undefined) return ok(this.#elsewhere);
		const sign = containerSigns(this.#egress.hostRoot);
		if (sign !== undefined) return ok((this.#elsewhere = `this provider runs in a container (${sign})`));
		const ran = await this.#run(["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"], signal);
		if (!ran.ok) return ran;
		let endpoint: unknown;
		try {
			endpoint = ran.value.exitCode === 0 ? JSON.parse(ran.value.stdout) : undefined;
		} catch {
			endpoint = undefined;
		}
		if (typeof endpoint !== "string") {
			const why = (ran.value.stderr.trim() || ran.value.stdout.trim()).split("\n")[0]?.slice(0, 200) ?? "";
			return ok((this.#elsewhere = `the docker CLI could not say where its Docker daemon is (docker context inspect: ${why || `exit ${ran.value.exitCode}`})`));
		}
		this.#elsewhere = endpoint.startsWith("unix://") ? null : `the docker CLI talks to a Docker daemon at ${endpoint.slice(0, 200)}, not a local unix socket`;
		return ok(this.#elsewhere);
	}

	/** The Docker host's architecture and enforcement (hostOf), read by docker info once per provider. */
	async host({ signal }: CallContext = {}): Promise<Result<DockerHost>> {
		if (this.#host) return ok(this.#host);
		const ran = await this.#run(["info", "--format", INFO_FORMAT], signal);
		if (!ran.ok) return ran;
		if (ran.value.exitCode !== 0) return fail("docker", `docker info failed: ${ran.value.stderr.trim()}`);
		let info: unknown;
		try {
			info = JSON.parse(ran.value.stdout);
		} catch {
			return fail("docker", `docker info wrote what is not JSON: ${ran.value.stdout.slice(0, 200)}`);
		}
		this.#host = hostOf(info as Parameters<typeof hostOf>[0]);
		return ok(this.#host);
	}

	/**
	 * The drift check of a computer attach did not make: the spec it was made with, read back from its own report and
	 * held to what check() allows, then inspect and, when it runs, hello, as at create. A computer that passes is
	 * returned with that spec.
	 */
	async #attached(report: DockerInspect, signal?: AbortSignal): Promise<Result<AttachedComputer>> {
		const ref = { id: report.Id ?? "", name: nameOf(report) };
		const host = await this.host({ signal });
		if (!host.ok) return host;
		if (host.value.problems.length > 0) return fail("refused", `host: ${host.value.problems.join("; ")}`);
		const config = report.Config ?? {};
		const limits = report.HostConfig ?? {};
		const found: string[] = [];
		const proxy = await this.#proxyOf(report, signal);
		if (!proxy.ok) return proxy;
		const network = networkOf(report, proxy.value, this.#code, this.#hostLocal());
		if (typeof network !== "string" && "other" in network) found.push(`network: ${network.other}, which this provider never makes`);
		const deadline = config.Labels?.[DEADLINE_LABEL] ?? "";
		const at = Date.parse(deadline);
		if (Number.isNaN(at) || new Date(at).toISOString() !== deadline) {
			found.push(`deadline: the label ${DEADLINE_LABEL} reads ${JSON.stringify(deadline)}, not the ISO time create writes`);
		} else if (at > Date.now() + this.capabilities().maxLifetimeMs + 60_000) found.push(`deadline: ${deadline} is past the 30 days create allows`);
		// The run's folder as the computer has it. The folder on the host is not checked again: it is what is bound.
		const mount = mountOf(report);
		if (mount !== undefined && "other" in mount) found.push(`mount: ${mount.other}, which this provider never makes`);
		const bind = mount !== undefined && "kind" in mount && mount.kind === "bind" ? mount : undefined;
		const spec = {
			image: config.Image,
			lifetimeMs: 1,
			network: typeof network === "string" || "allow" in network ? network : "none",
			cpus: typeof limits.CpuQuota === "number" ? limits.CpuQuota / CPU_PERIOD_US : limits.CpuQuota,
			memoryMb: typeof limits.Memory === "number" ? limits.Memory / (1024 * 1024) : limits.Memory,
			pids: limits.PidsLimit,
			workdir: config.WorkingDir,
			user: config.User,
			...(bind === undefined ? {} : { mount: bind }),
		} as ComputerSpec;
		found.push(...this.#checkSpec({ ...spec, mount: undefined }).map(({ field, message }) => `${field}: ${message}, read back from the computer`));
		const user = userOf(config.User) ?? String(config.User);
		// The copy create binds for this provider's daemon: the same bytes, from any process, have the same path.
		const daemon = this.#daemon();
		if (!daemon.ok) return daemon;
		const expected = this.#expected(host.value, deadline, user, daemon.value, proxy.value);
		found.push(...inspectDrift(spec, report, expected).filter((line) => typeof network === "string" || !("other" in network) || !line.startsWith("network:")));
		let kind: AttachedComputer["spec"]["kind"];
		if (report.State?.Running === true) {
			const opened = await this.#open(ref, signal);
			if (!opened.ok) return opened;
			await opened.value.close();
			found.push(...helloDrift(opened.value.hello, expected));
			kind = opened.value.hello.kind;
		}
		if (found.length > 0) {
			return fail("refused", `the computer ${ref.name} does not match this provider, so attach refuses it and it is left as it is: ${found.join("; ")}`);
		}
		const { image, network: read, cpus, memoryMb, pids, workdir } = spec;
		const readBack = { image, user, network: read, cpus, memoryMb, pids, workdir, deadline: new Date(at), ...(kind === undefined ? {} : { kind }), ...(bind === undefined ? {} : { mount: bind }) };
		return ok({ ...ref, spec: readBack });
	}

	async connect(ref: ComputerRef): Promise<Result<ComputerConnection>> {
		if (!NAME.test(ref.name)) return fail("invalid", `${ref.name} is not the name of a Docker computer (computer-<12 hex digits>)`);
		const opened = await this.#open(ref);
		if (!opened.ok) return opened;
		const { kind, groups } = this.capabilities();
		const found = helloDrift(opened.value.hello, { version: VERSION, kind, groups });
		if (found.length === 0) return opened;
		await opened.value.close();
		return fail("refused", `the daemon in ${ref.name} does not match this provider: ${found.join("; ")}`);
	}

	/** One connection to the computer's daemon, after hello, unchecked. */
	async #open(ref: ComputerRef, signal?: AbortSignal): Promise<Result<ComputerConnection>> {
		const child = spawn(this.#docker, ["exec", "-i", ref.name, DAEMON_IN_COMPUTER, "stdio"], { stdio: ["pipe", "pipe", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-4096);
		});
		child.on("error", (error) => {
			stderr ||= error.message;
		});
		const exited = new Promise<void>((done) => child.once("close", () => done()));
		const client = new DaemonClient({ readable: child.stdout, writable: child.stdin });
		const close = async () => {
			client.close();
			const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
			await exited;
			clearTimeout(timer);
		};
		const timeout = AbortSignal.timeout(HELLO_TIMEOUT_MS);
		const either = signal ? AbortSignal.any([signal, timeout]) : timeout;
		const hello = await client.call("hello", { client: `@parcha/agentrun-computer ${VERSION}` }, { signal: either });
		if (!hello.ok) {
			await close();
			if (signal?.aborted) return fail("aborted", `hello to the daemon in ${ref.name} was aborted`);
			if (hello.error.code === "aborted") return fail("timeout", `the daemon in ${ref.name} did not answer hello within ${HELLO_TIMEOUT_MS / 1000} s`);
			if (hello.error.code !== "gone") return hello;
			const words = stderr.trim() || hello.error.message;
			return fail(noSuchContainer(words) ? "not_found" : "docker", `cannot reach the daemon in ${ref.name}: ${words}`);
		}
		return ok({ client, hello: hello.value, close });
	}

	async attach(ref: { id: string } | { labels: Record<string, string> }, { signal }: CallContext = {}): Promise<Result<AttachedComputer>> {
		const given = (typeof ref === "object" && ref !== null ? ref : {}) as { id?: unknown; labels?: unknown };
		if ((given.id === undefined) === (given.labels === undefined)) return fail("invalid", "attach takes { id } or { labels }, one of them");
		if (given.id !== undefined) {
			const id = given.id;
			if (typeof id !== "string" || !(NAME.test(id) || ID.test(id))) {
				return fail("invalid", `${String(id)} is neither a Docker computer's name (computer-<12 hex digits>) nor a container id (12 to 64 hex digits)`);
			}
			const found = await this.#inspect([id], signal);
			if (!found.ok) return found;
			const [report] = found.value;
			// Docker resolves a name before an id prefix, so what it found must be what was asked for.
			const same = report !== undefined && (NAME.test(id) ? nameOf(report) === id : report.Id?.startsWith(id) === true);
			if (!same || !ours(report) || typeof report.Id !== "string") return fail("not_found", `no Docker computer has the id ${id}`);
			return this.#attached(report, signal);
		}
		const problem = filterProblem(given.labels);
		if (problem) return fail("invalid", problem);
		const labels = given.labels as Record<string, string>;
		if (Object.keys(labels).length === 0) return fail("invalid", "attach by labels needs at least one label");
		const listed = await this.list(labels, { signal });
		if (!listed.ok) return listed;
		const matches = listed.value.map((info) => info.ref);
		const words = JSON.stringify(labels);
		if (matches.length === 0) return fail("not_found", `no Docker computer has the labels ${words}`);
		if (matches.length > 1) return fail("invalid", `${matches.length} computers match the labels ${words}: ${matches.map((m) => m.name).join(", ")}`);
		const match = matches[0] as ComputerRef;
		const found = await this.#inspect([match.id], signal);
		if (!found.ok) return found;
		const [report] = found.value;
		if (report === undefined || report.Id !== match.id || !ours(report)) return fail("not_found", `no Docker computer has the labels ${words}`);
		return this.#attached(report, signal);
	}

	async list(labels: Record<string, string>, { signal }: CallContext = {}): Promise<Result<ComputerInfo[]>> {
		const problem = filterProblem(labels);
		if (problem) return fail("invalid", problem);
		const args = ["ps", "-a", "--no-trunc", "--filter", `label=${COMPUTER_LABEL}=1`];
		for (const [key, value] of Object.entries(labels)) args.push("--filter", `label=${key}=${value}`);
		const ran = await this.#run([...args, "--format", "{{.ID}}"], signal);
		if (!ran.ok) return ran;
		if (ran.value.exitCode !== 0) return fail("docker", `docker ps failed: ${ran.value.stderr.trim()}`);
		const ids = ran.value.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
		const infos: ComputerInfo[] = [];
		const local = this.#hostLocal();
		for (let at = 0; at < ids.length; at += INSPECT_BATCH) {
			// A computer removed between ps and inspect is left out.
			const found = await this.#inspect(ids.slice(at, at + INSPECT_BATCH), signal, LIST_FORMAT);
			if (!found.ok) return found;
			const computers = found.value.filter(ours);
			// The allowlist computers' proxies, in one inspect: each read-back holds the list its proxy runs with.
			const shaped = computers.filter(egressShaped).map((report) => egressNameOf(nameOf(report)));
			const proxies = new Map<string, DockerInspect>();
			if (shaped.length > 0) {
				const read = await this.#inspect(shaped, signal);
				if (!read.ok) return read;
				for (const proxy of read.value) proxies.set(nameOf(proxy), proxy);
			}
			infos.push(...computers.map((report) => infoOf(report, egressShaped(report) ? (proxies.get(egressNameOf(nameOf(report))) ?? null) : undefined, this.#code, local)));
		}
		return ok(infos);
	}

	/**
	 * The janitor's second pass (sweep calls it after the computers): every egress proxy container and egress volume
	 * labelled EGRESS_LABEL, and with all of `labels`, whose deadline label has passed (or is missing or unreadable, fail
	 * closed), or whose computer is gone and that is older than a create could take (#leftoverGraceMs: one under way has
	 * made its proxy before its computer, and pulled both images before either, so no pull happens in between). Each is
	 * removed by what its label found, a proxy before its volume, never by a name alone. Returns the names removed, a
	 * volume's as "<name> (volume)".
	 */
	async sweepLeftovers({ labels = {}, now = new Date(), signal }: { labels?: Record<string, string>; now?: Date; signal?: AbortSignal } = {}): Promise<Result<string[]>> {
		const problem = filterProblem(labels);
		if (problem) return fail("invalid", problem);
		const filters = [`label=${EGRESS_LABEL}`, ...Object.entries(labels).map(([key, value]) => `label=${key}=${value}`)].flatMap((filter) => ["--filter", filter]);
		const lines = (stdout: string) => stdout.split("\n").map((line) => line.trim()).filter(Boolean);
		const alive = await this.#run(["ps", "-a", "--no-trunc", "--filter", `label=${COMPUTER_LABEL}=1`, "--format", "{{.Names}}"], signal);
		if (!alive.ok) return alive;
		if (alive.value.exitCode !== 0) return fail("docker", `docker ps failed: ${alive.value.stderr.trim()}`);
		const computers = new Set(lines(alive.value.stdout).filter((name) => NAME.test(name)));
		const at = now.getTime();
		const grace = this.#leftoverGraceMs();
		const leftover = (labelsOf: Record<string, string> | null | undefined, created: unknown) => {
			const owner = labelsOf?.[EGRESS_LABEL];
			const deadline = Date.parse(labelsOf?.[DEADLINE_LABEL] ?? "");
			if (typeof owner !== "string" || !NAME.test(owner)) return false;
			if (Number.isNaN(deadline) || deadline <= at) return true;
			if (computers.has(owner)) return false;
			const made = typeof created === "string" ? Date.parse(created) : Number.NaN;
			return Number.isNaN(made) || at - made > grace;
		};
		const removed: string[] = [];
		const ps = await this.#run(["ps", "-a", "--no-trunc", ...filters, "--format", "{{.ID}}"], signal);
		if (!ps.ok) return ps;
		if (ps.value.exitCode !== 0) return fail("docker", `docker ps for egress proxies failed: ${ps.value.stderr.trim()}`);
		const ids = lines(ps.value.stdout);
		for (let from = 0; from < ids.length; from += INSPECT_BATCH) {
			const found = await this.#inspect(ids.slice(from, from + INSPECT_BATCH), signal);
			if (!found.ok) return found;
			for (const proxy of found.value) {
				if (!leftover(proxy.Config?.Labels, (proxy as { Created?: unknown }).Created) || typeof proxy.Id !== "string") continue;
				const ran = await this.#run(["rm", "--force", proxy.Id], signal);
				if (!ran.ok) return ran;
				if (ran.value.exitCode !== 0 && !noSuchContainer(ran.value.stderr)) return fail("docker", `docker rm of the egress proxy ${nameOf(proxy)} failed: ${ran.value.stderr.trim()}`);
				removed.push(nameOf(proxy));
			}
		}
		const ls = await this.#run(["volume", "ls", ...filters, "--format", "{{.Name}}"], signal);
		if (!ls.ok) return ls;
		if (ls.value.exitCode !== 0) return fail("docker", `docker volume ls for egress volumes failed: ${ls.value.stderr.trim()}`);
		const names = lines(ls.value.stdout);
		for (let from = 0; from < names.length; from += INSPECT_BATCH) {
			const read = await this.#run(["volume", "inspect", "--format", "{{json .}}", ...names.slice(from, from + INSPECT_BATCH)], signal);
			if (!read.ok) return read;
			for (const line of lines(read.value.stdout)) {
				let volume: { Name?: unknown; Labels?: Record<string, string> | null; CreatedAt?: unknown };
				try {
					volume = JSON.parse(line);
				} catch {
					return fail("docker", `docker volume inspect wrote a line that is not JSON: ${line.slice(0, 200)}`);
				}
				if (typeof volume.Name !== "string" || !leftover(volume.Labels, volume.CreatedAt)) continue;
				const ran = await this.#run(["volume", "rm", "--force", volume.Name], signal);
				if (!ran.ok) return ran;
				if (ran.value.exitCode !== 0) return fail("docker", `docker volume rm ${volume.Name} failed: ${ran.value.stderr.trim()}`);
				removed.push(`${volume.Name} (volume)`);
			}
		}
		return ok(removed);
	}

	/**
	 * How long a proxy or volume with no computer may be a create under way: its ready wait, and two minutes more. It
	 * holds because no pull happens inside it: create pulls both images before it makes the volume, and both docker runs
	 * take --pull never, so from the volume to the computer it waits on the proxy's ready line and two local starts.
	 */
	#leftoverGraceMs(): number {
		return Math.max(this.#egress.readyMs, EGRESS_READY_MS) + 120_000;
	}

	async network(ref: ComputerRef, policy?: NetworkSpec, { signal }: CallContext = {}): Promise<Result<NetworkPolicy>> {
		if (!NAME.test(ref?.name)) return fail("invalid", `${ref?.name} is not the name of a Docker computer (computer-<12 hex digits>)`);
		let asked: NetworkSpec | undefined = policy;
		if (typeof policy === "object" && policy !== null && "allow" in policy) {
			const allow = allowOf(policy.allow);
			if ("problem" in allow) return fail("refused", `${allow.problem}; ${FIXED}`);
			asked = { allow: allow.list };
		} else if (policy !== undefined && policy !== "none" && policy !== "open") return fail("refused", `${FIXED}; ${NETWORKS}`);
		const found = await this.#inspect([ref.name], signal);
		if (!found.ok) return found;
		const [report] = found.value;
		if (report === undefined || !ours(report)) return fail("not_found", `no Docker computer is named ${ref.name}`);
		const proxy = await this.#proxyOf(report, signal);
		if (!proxy.ok) return proxy;
		const current = networkOf(report, proxy.value, this.#code, this.#hostLocal());
		if (asked === undefined || samePolicy(asked, current)) return ok(current);
		return fail("refused", `${FIXED}: ${ref.name} has network ${policyWords(current)}, not ${policyWords(asked)}`);
	}

	/**
	 * Stops or deletes the computer, then its egress proxy, found by its label (EGRESS_LABEL=<name>), and on delete its
	 * egress volume, found the same way: a container or volume of the proxy's name without that label is never touched.
	 * Each is ok when already gone.
	 */
	async release(ref: ComputerRef, how: "stop" | "delete"): Promise<Result<void>> {
		if (!NAME.test(ref.name)) return fail("invalid", `${ref.name} is not the name of a Docker computer (computer-<12 hex digits>)`);
		if (how !== "stop" && how !== "delete") return fail("invalid", `release is "stop" or "delete", not ${String(how)}`);
		const args = how === "stop" ? ["stop", ref.name] : ["rm", "--force", "--volumes", ref.name];
		const ran = await this.#run(args);
		if (!ran.ok) return ran;
		if (ran.value.exitCode !== 0 && !noSuchContainer(ran.value.stderr)) return fail("docker", `docker ${args[0]} ${ref.name} failed: ${ran.value.stderr.trim()}`);
		const label = `label=${EGRESS_LABEL}=${ref.name}`;
		const proxies = await this.#run(["ps", "-a", "--no-trunc", "--filter", label, "--format", "{{.ID}}"]);
		if (!proxies.ok) return proxies;
		if (proxies.value.exitCode !== 0) return fail("docker", `docker ps for ${ref.name}'s egress proxy failed: ${proxies.value.stderr.trim()}`);
		for (const id of proxies.value.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
			const ended = await this.#run(how === "stop" ? ["stop", id] : ["rm", "--force", id]);
			if (!ended.ok) return ended;
			if (ended.value.exitCode !== 0 && !noSuchContainer(ended.value.stderr)) return fail("docker", `docker ${how === "stop" ? "stop" : "rm"} of ${ref.name}'s egress proxy failed: ${ended.value.stderr.trim()}`);
		}
		if (how === "stop") return ok(undefined);
		const volumes = await this.#run(["volume", "ls", "--filter", label, "--format", "{{.Name}}"]);
		if (!volumes.ok) return volumes;
		if (volumes.value.exitCode !== 0) return fail("docker", `docker volume ls for ${ref.name}'s egress volume failed: ${volumes.value.stderr.trim()}`);
		for (const volume of volumes.value.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
			const removed = await this.#run(["volume", "rm", "--force", volume]);
			if (!removed.ok) return removed;
			if (removed.value.exitCode !== 0) return fail("docker", `docker volume rm ${volume} failed: ${removed.value.stderr.trim()}`);
		}
		return ok(undefined);
	}

	/** Inspects containers by name or id, whole or only the fields a format names; one that is gone is left out. */
	async #inspect(keys: string[], signal?: AbortSignal, format = "{{json .}}"): Promise<Result<DockerInspect[]>> {
		const ran = await this.#run(["inspect", "--type", "container", "--format", format, ...keys], signal);
		if (!ran.ok) return ran;
		const { exitCode, stdout, stderr } = ran.value;
		const errors = stderr.split("\n").filter((line) => line.trim() !== "" && !noSuchContainer(line));
		if (exitCode !== 0 && errors.length > 0) return fail("docker", `docker inspect failed: ${errors.join("; ")}`);
		const found: DockerInspect[] = [];
		for (const line of stdout.split("\n").filter((line) => line.trim() !== "")) {
			try {
				found.push(JSON.parse(line) as DockerInspect);
			} catch {
				return fail("docker", `docker inspect wrote a line that is not JSON: ${line.slice(0, 200)}`);
			}
		}
		return ok(found);
	}

	#run(args: string[], signal?: AbortSignal): Promise<Result<Ran>> {
		return new Promise((done) => {
			execFile(this.#docker, args, { signal, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
				if (error === null) return done(ok({ exitCode: 0, stdout, stderr }));
				if (error.name === "AbortError") return done(fail("aborted", `docker ${args[0]} was aborted`));
				if (typeof error.code === "number") return done(ok({ exitCode: error.code, stdout, stderr }));
				if (error.code === "ENOENT") return done(fail("docker", `the docker CLI (${this.#docker}) was not found`));
				done(fail("docker", `docker ${args[0]} failed: ${error.message}`));
			});
		});
	}
}

function labelProblem(key: string, value: unknown): string | undefined {
	if (typeof value !== "string") return `the label ${key} must be a string`;
	if (key.includes("\0") || value.includes("\0")) return `the label ${JSON.stringify(key)}: ${NUL}`;
	if (key === "" || key.includes("=")) return `the label name "${key}" must be non-empty and have no "="`;
	if (key === COMPUTER_LABEL || key.startsWith(`${COMPUTER_LABEL}.`)) return `the label ${key} is in the provider's own namespace (${COMPUTER_LABEL})`;
	return undefined;
}

/** Why labels cannot be a docker ps filter, or undefined when they can. */
function filterProblem(labels: unknown): string | undefined {
	if (typeof labels !== "object" || labels === null || Array.isArray(labels)) return "labels must map names to strings";
	for (const [key, value] of Object.entries(labels)) {
		if (typeof value !== "string") return `the label ${key} must be a string`;
		if (key.includes("\0") || value.includes("\0")) return `the label ${JSON.stringify(key)}: a NUL byte cannot be passed to docker`;
		if (key === "" || key.includes("=")) return `the label name "${key}" must be non-empty and have no "="`;
	}
	return undefined;
}

/** A computer as list() reports it. The deadline counts only as the provider writes it, an ISO time; an allowlist's
 *  proxy must refuse each of `local`, the Docker host's own addresses. */
function infoOf(report: DockerInspect, proxy: DockerInspect | null | undefined, code: EgressCode, local: readonly string[]): ComputerInfo {
	const labels = { ...(report.Config?.Labels ?? {}) };
	const written = labels[DEADLINE_LABEL];
	const at = written === undefined ? Number.NaN : Date.parse(written);
	const deadline = Number.isNaN(at) || new Date(at).toISOString() !== written ? undefined : new Date(at);
	const state = report.State?.Running === true ? "running" : "stopped";
	const mount: MountReadBack | undefined = mountOf(report);
	return { ref: { id: report.Id ?? "", name: nameOf(report) }, labels, deadline, state, network: networkOf(report, proxy, code, local), ...(mount === undefined ? {} : { mount }) };
}

/** The longest delay Node's timers, and so AbortSignal.timeout, hold: 2^31 - 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/** The egress options with their defaults, or a throw in words. */
function egressOptionsOf({ image = EGRESS_IMAGE, hint, readyMs = EGRESS_READY_MS, hostAddresses: given, hostRoot = "/" }: DockerEgressOptions): {
	image: string;
	hint?: string;
	readyMs: number;
	hostAddresses?: string[];
	hostRoot: string;
} {
	if (typeof hostRoot !== "string" || !hostRoot.startsWith("/")) throw new Error(`the egress proxy's hostRoot must be an absolute path, not ${JSON.stringify(hostRoot)}`);
	if (typeof image !== "string" || image.trim() === "" || image.startsWith("-") || image.includes("\0")) {
		throw new Error(`the egress proxy's image ${JSON.stringify(image)} must name an image, such as ${EGRESS_IMAGE}`);
	}
	// The hint goes into a status line, which carries printable ASCII only.
	if (hint !== undefined && (typeof hint !== "string" || !/^[\x20-\x7e]*$/.test(hint))) throw new Error("the egress proxy's hint must be printable ASCII: it goes into a status line");
	if (!Number.isSafeInteger(readyMs) || readyMs <= 0 || readyMs > MAX_TIMER_MS) {
		throw new Error(`the egress proxy's readyMs must be a whole number of milliseconds above 0 and at most ${MAX_TIMER_MS}, not ${readyMs}`);
	}
	if (given !== undefined && !(Array.isArray(given) && given.every((address) => typeof address === "string" && addressBytes(address) !== undefined && !address.includes(",")))) {
		throw new Error(`the egress proxy's hostAddresses must be a list of IP addresses, such as ["93.184.215.20"], not ${JSON.stringify(given)}`);
	}
	return { image, readyMs, hostRoot, ...(hint === undefined ? {} : { hint }), ...(given === undefined ? {} : { hostAddresses: [...given] }) };
}

/**
 * Why an allowlist is refused when this provider's own interfaces are not the Docker host's: the proxy refuses the host's
 * own addresses as this-host only when it knows them, and here it does not.
 */
function elsewhereWords(why: string): string {
	return `${why}, so this provider's own interfaces are not the Docker host's, and the egress proxy could not refuse the host's own addresses: pass them as egress.hostAddresses, or ask for network none or open`;
}

/** Whether a spec's network is an allowlist. */
const isAllow = (network: unknown): network is { allow: unknown } => typeof network === "object" && network !== null && "allow" in network;

/**
 * Why an allowlist is refused on a host that remaps user ids: the egress volume's tmpfs owner and the proxy's code are
 * ids of the host, and the computer's user and its proxy run as other ones there, so the proxy could not make its socket
 * or the computer reach it. The provider does not guess the mapping.
 */
function remapAllowWords(remap: "userns" | "rootless"): string {
	return (
		`this Docker host remaps user ids (${remap === "userns" ? "userns-remap" : "rootless Docker"}), so the egress volume and the proxy's code are ` +
		"owned by host ids the computer's user does not map to, and the provider cannot give it an allowlist: ask for network none or open, " +
		"or use a Docker host that does not remap ids"
	);
}

/**
 * Why a bind is refused on a host that remaps user ids. The computer's uid is then another uid on the host (one Docker
 * picks from /etc/subuid), so the folder's owner and mode say nothing about whether the computer can write it; the
 * provider does not guess the mapping, and never changes the folder.
 */
function remapWords(remap: "userns" | "rootless", path: string): string {
	return (
		`this Docker host remaps user ids (${remap === "userns" ? "userns-remap" : "rootless Docker"}), so the run folder's owner on the host is not the ` +
		`computer's user, and the provider cannot tell whether the computer can write ${path}; it never changes the folder: ` +
		"bind the run folder on a Docker host that does not remap ids"
	);
}

/**
 * Why the computer's user cannot write the run folder it would bind, or undefined when it can. The kernel picks one
 * class of the mode, the owner's, the group's or others', by the user's uid and gid; that class must allow write and
 * search. A user with no capabilities, root included, has no other way in. The provider never chowns or chmods it.
 */
function folderProblem(path: string, user: string): string | undefined {
	let stat: Stats;
	try {
		stat = statSync(path);
	} catch (error) {
		return `the run folder ${path} cannot be read: ${(error as Error).message}`;
	}
	const [uid, gid] = user.split(":").map(Number);
	const bits = stat.uid === uid ? (stat.mode >> 6) & 7 : stat.gid === gid ? (stat.mode >> 3) & 7 : stat.mode & 7;
	if ((bits & 3) === 3) return undefined;
	const mode = (stat.mode & 0o7777).toString(8).padStart(4, "0");
	return (
		`the run folder ${path} is not writable by the computer's user ${user}: it is owned by ${stat.uid}:${stat.gid} with mode ${mode}; ` +
		`the provider never changes it: chown it to ${user}, or give that user write and search permission`
	);
}

/** "uid:gid" for a user in numbers (a uid alone is its own gid, never root's group 0), or undefined when it is not one. */
function userOf(value: unknown): string | undefined {
	const match = typeof value === "string" ? USER.exec(value) : null;
	if (match === null) return undefined;
	const [uid, gid] = [Number(match[1]), Number(match[2] ?? match[1])];
	return uid <= MAX_ID && gid <= MAX_ID ? `${uid}:${gid}` : undefined;
}

/** This process's uid:gid, or 1000:1000 when either is 0 (root, or root's group) or unknown. */
function defaultUser(): string {
	const [uid, gid] = [process.getuid?.(), process.getgid?.()];
	return uid === undefined || gid === undefined || uid === 0 || gid === 0 ? "1000:1000" : `${uid}:${gid}`;
}

/** The mode of a regular file, or undefined when there is none. */
function fileMode(path: string): number | undefined {
	try {
		const stat = statSync(path);
		return stat.isFile() ? stat.mode : undefined;
	} catch {
		return undefined;
	}
}
