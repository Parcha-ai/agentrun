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
import { type ParsedMount, parseMounts, parseNetwork, refuseNetworkFields } from "./network.ts";

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
	 * and no setuid or file-capability program gives it a privilege. Default: Docker's own set, which a launcher that
	 * drops from root to another user (setpriv, runuser) needs.
	 */
	readonly dropCapabilities?: boolean;
	/**
	 * The user every program of a box runs as, `uid:gid` or `uid` (Docker's `--user`). Default: the image's. A host that
	 * binds its own directories in names its own ids, so what the box writes there stays the host's to manage.
	 */
	readonly user?: string;
};

type Inspected = {
	readonly Id: string;
	readonly State: { readonly Running: boolean; readonly ExitCode: number };
	readonly Config: { readonly Labels: Record<string, string> | null };
};

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
 * Where the docker CLI's daemon is, as it decides: DOCKER_HOST when set, else the context DOCKER_CONTEXT names, else the
 * config's `currentContext` (`$DOCKER_CONFIG/config.json`, default `~/.docker`). No setting, a unix socket and the
 * `default` context are this machine; any other address (tcp://, ssh://) is another one, and so is a context whose
 * record (`contexts/meta/<sha256 of its name>/meta.json`) does not name a unix socket or cannot be read. `named` is the
 * setting that points away, and `fix` what brings it back.
 */
export function dockerDaemon(env: NodeJS.ProcessEnv): { local: true } | { local: false; named: string; fix: string } {
	const host = env.DOCKER_HOST ?? "";
	if (host !== "")
		return LOCAL_HOST.test(host)
			? { local: true }
			: { local: false, named: `DOCKER_HOST=${host}`, fix: "unset DOCKER_HOST" };
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
 */
export function dockerBoxes(options: DockerBoxesOptions = {}): BoxProvider {
	// Read once, as the docker CLI this provider runs reads them: a daemon on another machine binds none of this one's paths.
	const daemon = dockerDaemon(process.env);
	if (options.user !== undefined && !/^\d+(:\d+)?$/.test(options.user)) {
		throw new Error(`the docker user ${options.user} is not uid or uid:gid`);
	}
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
			if (!daemon.local && mounts.length > 0) {
				const { named, fix } = daemon;
				const message = `the Docker daemon is not on this machine (${named}), so it cannot bind this machine's ${mounts[0]!.source}: ${fix} to run boxes on this machine's Docker`;
				return err(new BoxError("unsupported", message));
			}
			const missing = await checkSources(mounts);
			if (missing !== undefined) return err(missing);
			const facts: BoxFacts = {
				provider: "docker",
				isolation: "container",
				cpus: spec.cpus ?? null,
				memoryMb: spec.memoryMb ?? null,
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
			if (spec.cpus !== undefined) args.push("--cpus", String(spec.cpus));
			if (spec.memoryMb !== undefined) args.push("--memory", `${spec.memoryMb}m`);
			if (spec.gpu !== undefined) args.push("--gpus", "all");
			for (const { source, target, readOnly } of mounts) {
				args.push("--mount", `type=bind,source=${source},target=${target}${readOnly ? ",readonly" : ""}`);
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
