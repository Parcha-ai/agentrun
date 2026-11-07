import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import {
	type Box,
	BoxError,
	type BoxExecOptions,
	type BoxFacts,
	type BoxFile,
	type BoxProcess,
	type BoxProvider,
	type BoxRef,
	type BoxSpec,
	type BoxStatus,
	isReservedLabel,
} from "./box.ts";
import { adaptChild } from "./child.ts";
import { downloadByExec, finish, uploadByExec } from "./files.ts";
import { mountPathProblem, type ParsedMount, parseMounts, parseNetwork, refuseNetworkFields } from "./network.ts";

const DEFAULT_IMAGE = "debian:bookworm-slim";
const DEFAULT_WORKSPACE = "/workspace";
/** Every box carries this label, so `attach` and `list` never touch a container this package did not start. */
const BOX_LABEL = "pi-transport.box";
const FACTS_LABEL = "pi-transport.facts";

export type DockerBoxesOptions = {
	/** The docker program. Default `docker`. */
	readonly docker?: string;
	/** Image for a spec that names none. Default `debian:bookworm-slim`. */
	readonly image?: string;
	/**
	 * Every box drops every capability (`--cap-drop ALL`) and gains none (`--security-opt no-new-privileges`), for a host
	 * whose boxes' programs never change user: a box run as root then cannot make a device node in a directory it binds,
	 * and no setuid or file-capability program gives it a privilege. A box `attach` finds that was made without it (by an
	 * older version) is ended, not attached, so the caller makes a new one. Default: Docker's own set, which a launcher
	 * that drops from root to another user (setpriv, runuser) needs.
	 */
	readonly dropCapabilities?: boolean;
	/**
	 * The user every program of a box runs as, `uid:gid` or `uid` (Docker's `--user`). Default: the image's. A host that
	 * binds its own directories in names its own ids, so what the box writes there stays the host's to manage.
	 */
	readonly user?: string;
	/**
	 * The CPUs a box may use, such as `2` or `1.5`, at least `0.01`, for a spec that names no `cpus`. Default: no limit. A
	 * box's CPUs, these or the spec's, are the CFS quota `--cpus` would set (`--cpu-period 100000 --cpu-quota <cpus x
	 * 100000>`), which Docker never checks against the CPUs it has: more than a VM's daemon has is no tighter than the VM,
	 * and a host with no CPU controller (rootless Docker without it delegated) drops it with a warning, where `--cpus` fails.
	 */
	readonly cpus?: number;
	/**
	 * The memory a box may use, for a spec that names no `memoryMb`: a whole number of bytes, or Docker's own size, a
	 * number and `b`, `k`, `m` or `g` (`512m`, `4g`; a `k` is 1024 bytes). Default: no limit. A box's memory, this or the
	 * spec's, is also its memory and swap together (`--memory-swap` the same), so swap never adds to it.
	 */
	readonly memory?: number | string;
	/**
	 * The most processes and threads a box may have at once (`--pids-limit`), where a fork bomb stops: 1 to 4194304, the
	 * kernel's most. Default: no limit.
	 */
	readonly pidsLimit?: number;
	/**
	 * Named Docker volumes every box mounts, after the spec's binds: `--mount type=volume,source=<name>,target=<target>`
	 * (`,readonly` when asked). A volume lives on the daemon's own disk, so it needs no path of this machine, which a
	 * daemon in a VM shares across a file-sharing layer that carries files but not sockets. A name is Docker's (a letter
	 * or digit, then letters, digits, `_`, `.` and `-`), a target an absolute path in normal form; anything else throws
	 * here, before any box. A spec whose mount names a volume's target is refused `invalid`.
	 */
	readonly volumes?: readonly { readonly name: string; readonly target: string; readonly readOnly?: boolean }[];
	/**
	 * Where the daemon has this machine's files, for a caller that runs in a container of that daemon's own (given its
	 * socket): the daemon cannot bind a path of the caller's, only the named volume it mounted into the caller's container
	 * at `at`. A spec's mount whose source is below `at` becomes that volume's subpath (`--mount
	 * type=volume,source=<volume>,target=<target>,volume-subpath=<below at>,volume-nocopy`, which takes Docker Engine 26
	 * or later). A mount source not below `at` is refused `unsupported`, and `at` itself `invalid`: a box never gets the
	 * whole volume. Absent, a mount is a bind of its own source. `at` is an absolute path in normal form and `volume` a
	 * name Docker takes; anything else throws here, before any box.
	 */
	readonly paths?: { readonly at: string; readonly volume: string };
};

/** A Docker volume's name, as Docker takes one. */
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** A Docker volume's name, as Docker takes one. */
const DOCKER_VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

type Inspected = {
	readonly Id: string;
	readonly State: { readonly Running: boolean; readonly ExitCode: number };
	readonly Config: { readonly Labels: Record<string, string> | null };
	readonly HostConfig?: {
		readonly CapDrop?: readonly string[] | null;
		readonly SecurityOpt?: readonly string[] | null;
	};
};

/** Whether a container was made as dropCapabilities makes one: every capability dropped, no new privilege. */
const hardened = (inspected: Inspected): boolean =>
	(inspected.HostConfig?.CapDrop ?? []).some((cap) => cap.toUpperCase() === "ALL") &&
	(inspected.HostConfig?.SecurityOpt ?? []).some((opt) => /^no-new-privileges([:=]true)?$/.test(opt));

/** A box that is one Docker container. Its first process is a sleep of the box's lifetime, so Docker ends it. */
class DockerBox implements Box {
	readonly id: string;
	readonly #docker: Docker;
	readonly #facts: BoxFacts;

	constructor(docker: Docker, id: string, facts: BoxFacts) {
		this.id = id;
		this.#docker = docker;
		this.#facts = facts;
	}

	facts(): BoxFacts {
		return this.#facts;
	}

	async exec(
		command: readonly string[],
		options: BoxExecOptions | undefined,
		context: Context,
	): Promise<Result<BoxProcess, BoxError>> {
		if (command.length === 0) return err(new BoxError("invalid", "the command is empty"));
		const child = spawn(this.#docker.program, ["exec", "-i", "-w", this.#facts.workspace, this.id, ...command], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		const process = adaptChild(child, () => child.kill("SIGKILL"), options, context);
		return ok({
			stdin: process.stdin,
			stdout: process.stdout,
			stderr: process.stderr,
			// The docker client exits 1 both for a program that exits 1 and for a container that is gone.
			wait: async () => {
				const exit = await process.wait();
				if (!exit.ok || exit.value === 0) return exit;
				const status = await this.status(context);
				if (status.ok && status.value.state === "ended")
					return err(new BoxError("gone", `box ${this.id} has ended`));
				return exit;
			},
		});
	}

	upload(files: readonly BoxFile[], context: Context): Promise<Result<void, BoxError>> {
		return uploadByExec(this, files, context);
	}

	download(paths: readonly string[], context: Context): Promise<Result<readonly BoxFile[], BoxError>> {
		return downloadByExec(this, paths, context);
	}

	async status(context: Context): Promise<Result<BoxStatus, BoxError>> {
		const inspected = await this.#docker.inspect(this.id, context);
		if (!inspected.ok) return inspected;
		if (inspected.value === undefined) return ok({ state: "ended", exitCode: null });
		const { Running, ExitCode } = inspected.value.State;
		return ok(Running ? { state: "running" } : { state: "ended", exitCode: ExitCode });
	}

	async destroy(context: Context): Promise<Result<void, BoxError>> {
		const removed = await this.#docker.run(["rm", "--force", "--volumes", this.id], context);
		if (!removed.ok) return removed;
		if (removed.value.exitCode !== 0 && !/no such container/i.test(removed.value.stderr)) {
			return err(new BoxError("unknown", `could not remove box ${this.id}: ${removed.value.stderr.trim()}`));
		}
		return ok(undefined);
	}
}

/** The docker command line, as the few calls the provider makes. */
class Docker {
	readonly program: string;

	constructor(program: string) {
		this.program = program;
	}

	async run(
		args: readonly string[],
		context: Context,
	): Promise<Result<{ exitCode: number; stdout: string; stderr: string }, BoxError>> {
		const child = spawn(this.program, args, { stdio: ["pipe", "pipe", "pipe"] });
		const finished = await finish(adaptChild(child, () => child.kill("SIGKILL"), undefined, context));
		if (!finished.ok) return finished;
		const { exitCode, stdout, stderr } = finished.value;
		return ok({ exitCode, stdout: new TextDecoder().decode(stdout), stderr });
	}

	/** The container with this id when this package started it, else `undefined`. */
	async inspect(id: string, context: Context): Promise<Result<Inspected | undefined, BoxError>> {
		const result = await this.run(["inspect", "--type", "container", "--format", "{{json .}}", id], context);
		if (!result.ok) return result;
		if (result.value.exitCode !== 0) {
			if (/no such (container|object)/i.test(result.value.stderr)) return ok(undefined);
			return err(new BoxError("unknown", `docker inspect failed: ${result.value.stderr.trim()}`));
		}
		const inspected = JSON.parse(result.value.stdout) as Inspected;
		return ok(inspected.Config.Labels?.[BOX_LABEL] === undefined ? undefined : inspected);
	}
}

/** The facts a box's label holds, or `undefined` when the label is missing or is not what this provider wrote. */
function parseFacts(label: string | undefined): BoxFacts | undefined {
	try {
		const facts = JSON.parse(label ?? "null") as Partial<BoxFacts> | null;
		return facts?.provider === "docker" && typeof facts.workspace === "string" ? (facts as BoxFacts) : undefined;
	} catch {
		return undefined;
	}
}

/** A daemon address on this machine: a unix socket (or a Windows named pipe). */
const LOCAL_HOST = /^(unix|npipe):\/\//;

/**
 * Where the docker CLI's daemon is: DOCKER_HOST, the context DOCKER_CONTEXT names, else the config's `currentContext`
 * (`$DOCKER_CONFIG/config.json`, default `~/.docker`). No setting, a unix socket and the `default` context are this
 * machine; any other address (tcp://, ssh://) is another one, and so is a context whose record
 * (`contexts/meta/<sha256 of its name>/meta.json`) does not name a unix socket or cannot be read. With both DOCKER_HOST
 * and DOCKER_CONTEXT set, both must be this machine. `named` is the setting that points away, and `fix` what brings it
 * back.
 */
export function dockerDaemon(env: NodeJS.ProcessEnv): { local: true } | { local: false; named: string; fix: string } {
	const host = env.DOCKER_HOST ?? "";
	if (host !== "" && !LOCAL_HOST.test(host))
		return { local: false, named: `DOCKER_HOST=${host}`, fix: "unset DOCKER_HOST" };
	// DOCKER_HOST wins over the config's current context; with DOCKER_CONTEXT set too, CLI versions differ on which wins,
	// so that context must be this machine as well.
	if (host !== "" && !env.DOCKER_CONTEXT) return { local: true };
	const config = env.DOCKER_CONFIG || join(homedir(), ".docker");
	const read = (path: string): unknown => {
		try {
			return JSON.parse(readFileSync(path, "utf8"));
		} catch {
			return undefined;
		}
	};
	const current = (read(join(config, "config.json")) as { currentContext?: unknown } | undefined)?.currentContext;
	const name = env.DOCKER_CONTEXT || (typeof current === "string" ? current : "");
	if (name === "" || name === "default") return { local: true };
	const meta = read(join(config, "contexts", "meta", createHash("sha256").update(name).digest("hex"), "meta.json"));
	const endpoint = (meta as { Endpoints?: { docker?: { Host?: unknown } } } | undefined)?.Endpoints?.docker?.Host;
	if (typeof endpoint === "string" && LOCAL_HOST.test(endpoint)) return { local: true };
	return { local: false, named: `docker context ${name}`, fix: "use the default docker context" };
}

type Paths = NonNullable<DockerBoxesOptions["paths"]>;

/** The paths option, checked: throws for one that is not one. */
function checkPaths(paths: Paths): Paths {
	if (mountPathProblem(paths?.at) !== undefined || paths.at === "/") {
		throw new Error(`the docker paths' at ${shown(paths?.at)} is not an absolute path in normal form below /`);
	}
	if (typeof paths.volume !== "string" || !DOCKER_VOLUME_NAME.test(paths.volume)) {
		throw new Error(
			`the docker paths' volume ${shown(paths.volume)} is not a letter or digit, then letters, digits, _, . or -`,
		);
	}
	return { at: paths.at, volume: paths.volume };
}

/** A mount source's path below `at`, or undefined when it is not below it. */
const below = (at: string, source: string): string | undefined =>
	source.startsWith(`${at}/`) ? source.slice(at.length + 1) : undefined;

/** The refusal of the first mount the daemon cannot have through `paths`: one outside `at`, or `at` itself. */
function outsidePaths(paths: Paths, mounts: readonly ParsedMount[]): BoxError | undefined {
	for (const { source } of mounts) {
		if (source === paths.at) {
			return new BoxError(
				"invalid",
				`the mount source ${source} is the whole of what this server's Docker can mount, never a box's`,
			);
		}
		if (below(paths.at, source) === undefined) {
			return new BoxError(
				"unsupported",
				`the mount source ${source} is not under ${paths.at}, the only files of this server's that its Docker can mount`,
			);
		}
	}
	return undefined;
}

/** A mount's type, source and target as the daemon has it (`paths`), for a source outsidePaths took. */
const mapped = (paths: Paths, source: string, target: string): string =>
	`type=volume,source=${paths.volume},target=${target},volume-subpath=${below(paths.at, source)!},volume-nocopy`;

/** `not_found` for a mount whose source this machine does not have, before Docker is asked: `-v` would make it an empty directory. */
async function checkSources(mounts: readonly ParsedMount[]): Promise<BoxError | undefined> {
	for (const { source } of mounts) {
		try {
			await stat(source);
		} catch (cause) {
			const code = (cause as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") {
				return new BoxError("not_found", `the mount source ${source} does not exist on this machine`, cause);
			}
			return new BoxError(
				"invalid",
				`the mount source ${source} cannot be checked on this machine (${code ?? String(cause)})`,
				cause,
			);
		}
	}
	return undefined;
}

/** The CFS period of a box's CPU quota, in µs: `--cpus`'s own. */
const CPU_PERIOD_US = 100_000;
/** The fewest CPUs a quota can give: the kernel's least quota is 1 ms of each period. */
const MIN_CPUS = 0.01;
/** CPUs a quota can give: at least 0.01, and few enough that the quota is a whole number of µs Docker reads. */
const quotaCpus = (cpus: unknown): cpus is number =>
	typeof cpus === "number" && cpus >= MIN_CPUS && Number.isSafeInteger(Math.round(cpus * CPU_PERIOD_US));
/** The most processes a cgroup may be given (the kernel's PID_MAX_LIMIT): a larger `--pids-limit` fails the create. */
const MAX_PIDS = 4_194_304;
const MIB = 1024 * 1024;
const SIZE_UNITS: Readonly<Record<string, number>> = { "": 1, b: 1, k: 1024, m: MIB, g: 1024 * MIB };

/** `memory` in bytes, when it is a positive whole number of bytes or a size Docker reads (`512m`, `4g`), else `undefined`. */
function memoryBytes(memory: number | string): number | undefined {
	if (typeof memory === "number") return Number.isSafeInteger(memory) && memory > 0 ? memory : undefined;
	if (typeof memory !== "string") return undefined;
	const size = /^(\d+(?:\.\d+)?)([bkmg]?)$/i.exec(memory);
	// Docker's own reading: the number times the unit, its fraction of a byte dropped.
	const bytes = size ? Math.floor(Number(size[1]) * (SIZE_UNITS[(size[2] ?? "").toLowerCase()] ?? 1)) : 0;
	return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
}

/** A value as an error names it: a string as JSON, so an empty one shows; a number as JavaScript writes it. */
const shown = (value: unknown): string => (typeof value === "string" ? JSON.stringify(value) : String(value));

/** The memory option as Docker's flag and as the facts' MiB; throws for a value that is not one. */
function memoryOption(memory: number | string | undefined): { flag: string; mb: number } | undefined {
	if (memory === undefined) return undefined;
	const bytes = memoryBytes(memory);
	if (bytes === undefined) {
		throw new Error(
			`the docker memory ${shown(memory)} is not a positive whole number of bytes, nor a size such as 512m or 4g`,
		);
	}
	return { flag: String(memory), mb: Math.floor(bytes / MIB) };
}

function createError(stderr: string): BoxError {
	const message = `docker could not start a box: ${stderr.trim()}`;
	if (/pull access denied|unauthorized|denied:/i.test(stderr)) return new BoxError("unauthorized", message);
	if (/manifest unknown|not found|no such image/i.test(stderr)) return new BoxError("not_found", message);
	return new BoxError("unknown", message);
}

/**
 * Boxes that are Docker containers on this machine, through the `docker` program.
 *
 * A spec that names a `snapshot`, a `region` or an `isolation` other than `container` is refused with `unsupported`.
 * Docker cannot choose a GPU model: any `gpu` gives the container every GPU of the host, and `facts().gpu` repeats
 * the name the spec gave (not measured: nothing reads the host's cards in the box). The container's first process is a `sleep` of the lifetime in place of the image's own
 * entrypoint, so Docker ends the box when the lifetime has passed.
 *
 * A spec's `mounts` become `--mount type=bind,source=<source>,target=<target>` (`,readonly` when asked), never `-v`, which
 * makes a missing source an empty directory: a source this machine does not have is refused with `not_found` before Docker is
 * asked. The paths go to Docker as given, never resolved here, so the caller passes canonical ones. The daemon must run on this
 * machine, where the sources are checked.
 *
 * The options' `cpus`, `memory` and `pidsLimit` bound every box (a CFS quota, `--memory` with `--memory-swap` the same,
 * and `--pids-limit`); a spec's own `cpus` or `memoryMb` takes the place of the option's, and `facts()` says what a box got.
 * A value out of its bounds (under 0.01 CPUs, a memory that is not a positive size, a `pidsLimit` outside 1 to 4194304)
 * throws here, before any box.
 */
export function dockerBoxes(options: DockerBoxesOptions = {}): BoxProvider {
	// Read once, as the docker CLI this provider runs reads them: a daemon on another machine binds none of this one's paths.
	const daemon = dockerDaemon(process.env);
	if (options.user !== undefined && !/^\d+(:\d+)?$/.test(options.user)) {
		throw new Error(`the docker user ${options.user} is not uid or uid:gid`);
	}
	if (options.cpus !== undefined && !quotaCpus(options.cpus)) {
		throw new Error(`the docker cpus ${shown(options.cpus)} is not a number of CPUs of at least ${MIN_CPUS}`);
	}
	const memory = memoryOption(options.memory);
	if (
		options.pidsLimit !== undefined &&
		!(Number.isSafeInteger(options.pidsLimit) && options.pidsLimit > 0 && options.pidsLimit <= MAX_PIDS)
	) {
		throw new Error(`the docker pidsLimit ${shown(options.pidsLimit)} is not a whole number from 1 to ${MAX_PIDS}`);
	}
	const volumes = (options.volumes ?? []).map((volume) => {
		if (typeof volume?.name !== "string" || !VOLUME_NAME.test(volume.name)) {
			throw new Error(
				`the docker volume name ${shown(volume?.name)} is not a letter or digit, then letters, digits, _, . or -`,
			);
		}
		const target = parseMounts([{ source: "/", target: volume.target }]);
		if (target instanceof BoxError || volume.target === "/") {
			throw new Error(
				`the docker volume ${volume.name}'s target ${shown(volume.target)} is not an absolute path in normal form below /`,
			);
		}
		return { name: volume.name, target: volume.target, readOnly: volume.readOnly === true };
	});
	const paths = options.paths === undefined ? undefined : checkPaths(options.paths);
	const docker = new Docker(options.docker ?? "docker");

	return {
		name: "docker",
		mounts: daemon.local,

		async create(spec: BoxSpec, context: Context): Promise<Result<Box, BoxError>> {
			if (!(spec.maxLifetimeMs > 0)) return err(new BoxError("invalid", "maxLifetimeMs must be positive"));
			if (spec.snapshot !== undefined) return err(new BoxError("unsupported", "docker boxes start from an image"));
			if (spec.region !== undefined) return err(new BoxError("unsupported", "a docker box runs on this machine"));
			const reserved = Object.keys(spec.labels ?? {}).find(isReservedLabel);
			if (reserved !== undefined) {
				return err(new BoxError("invalid", `the label ${reserved} is in the providers' own namespace`));
			}
			if (spec.isolation !== undefined && spec.isolation !== "container") {
				return err(new BoxError("unsupported", `a docker box is a container, the spec asks for ${spec.isolation}`));
			}
			const refused = refuseNetworkFields(spec, "docker", true);
			if (refused !== undefined) return err(refused);
			const network = parseNetwork(spec.network) as { kind: "open" | "none" };
			const mounts = parseMounts(spec.mounts);
			if (mounts instanceof BoxError) return err(mounts);
			const covered = mounts.find((mount) => volumes.some((volume) => volume.target === mount.target));
			if (covered !== undefined)
				return err(new BoxError("invalid", `the mount target ${covered.target} is a volume's`));
			// Checked again at each create: a `docker context use` since the provider was made moves every later call.
			const now = dockerDaemon(process.env);
			const away = !daemon.local ? daemon : !now.local ? now : undefined;
			if (away !== undefined && mounts.length > 0) {
				const { named, fix } = away;
				const message = `the Docker daemon is not on this machine (${named}), so it cannot bind this machine's ${mounts[0]!.source}: ${fix} to run boxes on this machine's Docker`;
				return err(new BoxError("unsupported", message));
			}
			const outside = paths ? outsidePaths(paths, mounts) : undefined;
			if (outside !== undefined) return err(outside);
			const missing = await checkSources(mounts);
			if (missing !== undefined) return err(missing);
			const cpus = spec.cpus ?? options.cpus;
			// A quota rounded to 0 is no limit at all: a spec's cpus too small to give one is refused, never dropped.
			if (cpus !== undefined && !quotaCpus(cpus)) {
				return err(new BoxError("invalid", `cpus ${shown(cpus)} is not a number of CPUs of at least ${MIN_CPUS}`));
			}
			const boxMemory = spec.memoryMb !== undefined ? { flag: `${spec.memoryMb}m`, mb: spec.memoryMb } : memory;
			const facts: BoxFacts = {
				provider: "docker",
				isolation: "container",
				cpus: cpus ?? null,
				memoryMb: boxMemory?.mb ?? null,
				gpu: spec.gpu ?? null,
				workspace: spec.workspace ?? DEFAULT_WORKSPACE,
				maxLifetimeMs: spec.maxLifetimeMs,
				snapshot: null,
				bulk: "stream",
				secretsVia: "fd",
				network: network.kind === "none" ? "none" : "open",
				// No port is published: the box is made without one.
				ports: [],
				startedAt: new Date().toISOString(),
			};
			const args = ["run", "--detach", "--init", "--rm", "--workdir", facts.workspace];
			args.push("--label", `${BOX_LABEL}=1`, "--label", `${FACTS_LABEL}=${JSON.stringify(facts)}`);
			for (const [key, value] of Object.entries(spec.labels ?? {})) args.push("--label", `${key}=${value}`);
			for (const [key, value] of Object.entries(spec.env ?? {})) args.push("--env", `${key}=${value}`);
			if (network.kind === "none") args.push("--network", "none");
			if (options.dropCapabilities === true) args.push("--cap-drop", "ALL", "--security-opt", "no-new-privileges");
			if (options.user !== undefined) args.push("--user", options.user);
			// The CFS quota `--cpus` sets, with no check against Docker's own CPU count (see DockerBoxesOptions.cpus).
			if (cpus !== undefined)
				args.push("--cpu-period", String(CPU_PERIOD_US), "--cpu-quota", String(Math.round(cpus * CPU_PERIOD_US)));
			// Memory and swap together are the memory: swap never adds to it.
			if (boxMemory !== undefined) args.push("--memory", boxMemory.flag, "--memory-swap", boxMemory.flag);
			if (options.pidsLimit !== undefined) args.push("--pids-limit", String(options.pidsLimit));
			if (spec.gpu !== undefined) args.push("--gpus", "all");
			for (const { source, target, readOnly } of mounts) {
				const mount = paths ? mapped(paths, source, target) : `type=bind,source=${source},target=${target}`;
				args.push("--mount", `${mount}${readOnly ? ",readonly" : ""}`);
			}
			for (const { name, target, readOnly } of volumes) {
				args.push("--mount", `type=volume,source=${name},target=${target}${readOnly ? ",readonly" : ""}`);
			}
			// The sleep replaces the image's own entrypoint, so the lifetime holds whatever the image would run.
			args.push("--entrypoint", "sleep", spec.image ?? options.image ?? DEFAULT_IMAGE);
			args.push(String(Math.ceil(spec.maxLifetimeMs / 1000)));
			const started = await docker.run(args, context);
			if (!started.ok) return started;
			if (started.value.exitCode !== 0) return err(createError(started.value.stderr));
			return ok(new DockerBox(docker, started.value.stdout.trim(), facts));
		},

		async attach(id: string, context: Context): Promise<Result<Box | undefined, BoxError>> {
			const inspected = await docker.inspect(id, context);
			if (!inspected.ok) return inspected;
			const labels = inspected.value?.Config.Labels;
			if (inspected.value === undefined || !inspected.value.State.Running || labels == null) return ok(undefined);
			const facts = parseFacts(labels[FACTS_LABEL]);
			if (facts === undefined) return ok(undefined);
			// A box made before dropCapabilities (an older version, its run resumed) is ended, not taken: what it still runs
			// ends with it, and the caller makes a box that has none.
			if (options.dropCapabilities === true && !hardened(inspected.value)) {
				const removed = await docker.run(["rm", "--force", "--volumes", inspected.value.Id], context);
				if (!removed.ok) return removed;
				if (removed.value.exitCode !== 0 && !/no such container/i.test(removed.value.stderr)) {
					return err(
						new BoxError(
							"unknown",
							`could not remove the unhardened box ${inspected.value.Id}: ${removed.value.stderr.trim()}`,
						),
					);
				}
				return ok(undefined);
			}
			return ok(new DockerBox(docker, inspected.value.Id, facts));
		},

		async list(labels, context: Context): Promise<Result<readonly BoxRef[], BoxError>> {
			const args = ["ps", "--no-trunc", "--quiet", "--filter", `label=${BOX_LABEL}`];
			for (const [key, value] of Object.entries(labels)) args.push("--filter", `label=${key}=${value}`);
			const listed = await docker.run(args, context);
			if (!listed.ok) return listed;
			if (listed.value.exitCode !== 0) {
				return err(new BoxError("unknown", `docker ps failed: ${listed.value.stderr.trim()}`));
			}
			const refs: BoxRef[] = [];
			for (const id of listed.value.stdout.split("\n").filter((line) => line !== "")) {
				const inspected = await docker.inspect(id, context);
				if (!inspected.ok) return inspected;
				if (inspected.value === undefined) continue;
				const { [BOX_LABEL]: _box, [FACTS_LABEL]: _facts, ...own } = inspected.value.Config.Labels ?? {};
				refs.push({ id, labels: own });
			}
			return ok(refs);
		},
	};
}
