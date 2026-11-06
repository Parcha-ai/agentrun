// The Docker provisioner: every call through the docker CLI with execFile or spawn, never a shell. The hardening flags
// and the inspect reading follow pi-transport's Docker box.
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DaemonClient } from "./client.js";
import {
	COMPUTER_LABEL,
	CPU_PERIOD_US,
	DAEMON_IN_COMPUTER,
	DEADLINE_LABEL,
	DEFAULT_CPUS,
	DEFAULT_MEMORY_MB,
	DEFAULT_PIDS,
	type DockerInspect,
	drift,
	helloDrift,
	networkOf,
	tmpfsOf,
	WORK,
} from "./drift.js";
import type {
	CallContext,
	ComputerCapabilities,
	ComputerConnection,
	ComputerInfo,
	ComputerProvider,
	ComputerRef,
	ComputerSpec,
	NetworkPolicy,
	NetworkSpec,
	Refusal,
} from "./provider.js";
import { fail, ok, type Result } from "./result.js";

export interface DockerProviderOptions {
	/** The daemon binary on this machine, for the computer's architecture (dist/computerd-linux-<arch>). */
	daemonPath: string;
	/** The docker CLI. */
	docker?: string;
	/** Who a computer runs as when its spec does not say: uid or uid:gid, in numbers. Default: this process's uid:gid, or
	 *  1000:1000 when its uid or gid is 0. Root and root's group are refused here: a computer runs as either only when
	 *  its spec asks. */
	user?: string;
}

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
 *  output is capped. */
const LIST_FORMAT =
	'{"Id":{{json .Id}},"Name":{{json .Name}},"State":{"Running":{{json .State.Running}}},"Config":{"Labels":{{json .Config.Labels}}},' +
	'"HostConfig":{"NetworkMode":{{json .HostConfig.NetworkMode}}},"NetworkSettings":{"Networks":{{json .NetworkSettings.Networks}}}}';
/** The longest lifetime: 30 days. A computer meant to live longer is asked for again. */
const MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const SPEC_FIELDS = new Set(["image", "lifetimeMs", "network", "cpus", "memoryMb", "pids", "labels", "workdir", "user"]);
const NUL = "a NUL byte cannot be passed to docker run";
const ALLOWLIST = "a Docker computer cannot enforce an allowlist yet; ask for network none or open";
/** Docker cannot move a container with no network onto one, nor take one off a network without a restart. */
const FIXED = "a Docker computer's network is fixed at create; create a new computer";
/** docker info names the kernel's architecture; hello names Go's. */
const GO_ARCH: Record<string, string> = { x86_64: "amd64", aarch64: "arm64" };

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
const policyWords = (policy: NetworkPolicy) => (typeof policy === "string" ? policy : JSON.stringify(policy));

export class DockerProvider implements ComputerProvider {
	readonly id = "docker";
	readonly version = VERSION;
	readonly #daemonPath: string;
	readonly #docker: string;
	readonly #user: string;

	constructor({ daemonPath, docker = "docker", user }: DockerProviderOptions) {
		this.#daemonPath = resolve(daemonPath);
		this.#docker = docker;
		const given = user === undefined ? defaultUser() : userOf(user);
		if (given === undefined) throw new Error(`the provider's user ${JSON.stringify(user)} must be ${USER_FORM}`);
		if (given.startsWith("0:")) throw new Error(`the provider's user ${user} is root; a computer runs as root only when its spec asks for user "0"`);
		if (given.endsWith(":0")) {
			throw new Error(`the provider's user ${user} is in root's group (gid 0); a computer is in group 0 only when its spec asks, such as user "${given}"`);
		}
		this.#user = given;
	}

	capabilities(): ComputerCapabilities {
		return { lifetime: "janitor", network: ["none", "open"], isolation: "container", os: "linux", daemon: ["exec", "files", "processes"], user: ["root", "uid"] };
	}

	check(spec: ComputerSpec): Refusal[] {
		const refusals: Refusal[] = [];
		const refuse = (field: string, message: string) => refusals.push({ field, message });
		const given = spec as unknown as Record<string, unknown>;
		const { image, lifetimeMs, network, cpus, memoryMb, pids, labels, workdir, user } = given;
		if (typeof image !== "string" || image.trim() === "" || image.startsWith("-")) {
			refuse("image", "an image is required, such as debian:bookworm-slim");
		} else if (image.includes("\0")) refuse("image", NUL);
		if (!isWhole(lifetimeMs) || lifetimeMs <= 0) {
			refuse("lifetimeMs", "lifetimeMs is required: a whole number of milliseconds above 0, after which the janitor deletes the computer");
		} else if (lifetimeMs > MAX_LIFETIME_MS) {
			refuse("lifetimeMs", `lifetimeMs is at most 30 days (${MAX_LIFETIME_MS} ms); ask for a new computer after that`);
		}
		if (typeof network === "object" && network !== null && "allow" in network) refuse("network", ALLOWLIST);
		else if (network !== "none" && network !== "open") refuse("network", 'network is required: "none" or "open"');
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
		for (const [field, value] of Object.entries(given)) {
			if (!SPEC_FIELDS.has(field) && value !== undefined) refuse(field, `a Docker computer does not support ${field}`);
		}
		return refusals;
	}

	async create(spec: ComputerSpec, { signal }: { signal?: AbortSignal } = {}): Promise<Result<ComputerRef>> {
		const refusals = this.check(spec);
		if (refusals.length > 0) return fail("refused", refusals.map(({ field, message }) => `${field}: ${message}`).join("; "));
		const mode = fileMode(this.#daemonPath);
		if (mode === undefined) {
			return fail("not_found", `no daemon binary at ${this.#daemonPath}: run npm run build:daemon -w @parcha/agentrun-computer`);
		}
		// A computer's user, root or not, has no capabilities, so it runs the mounted daemon only if every user may.
		if ((mode & 0o005) !== 0o005) {
			return fail("invalid", `the daemon at ${this.#daemonPath} has mode ${(mode & 0o777).toString(8)}; a computer's user, with no capabilities, cannot run it: chmod 755 it`);
		}
		if (this.#daemonPath.includes(",")) return fail("invalid", `the daemon path ${this.#daemonPath} has a comma, which a Docker mount cannot hold`);
		if (signal?.aborted) return fail("aborted", "create was aborted before Docker was called");
		const name = `computer-${randomBytes(6).toString("hex")}`;
		const deadline = new Date(Date.now() + spec.lifetimeMs).toISOString();
		const args = ["run", "--detach", "--name", name, "--label", `${COMPUTER_LABEL}=1`, "--label", `${DEADLINE_LABEL}=${deadline}`];
		for (const [key, value] of Object.entries(spec.labels ?? {})) args.push("--label", `${key}=${value}`);
		const user = userOf(spec.user) ?? this.#user;
		const memoryMb = spec.memoryMb ?? DEFAULT_MEMORY_MB;
		args.push("--user", user, "--env", `HOME=${WORK}`);
		for (const [path, options] of Object.entries(tmpfsOf(user, memoryMb))) args.push("--tmpfs", `${path}:${options}`);
		args.push("--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", String(spec.pids ?? DEFAULT_PIDS));
		args.push("--network", spec.network === "none" ? "none" : "bridge");
		args.push("--cpu-period", String(CPU_PERIOD_US), "--cpu-quota", String(Math.round((spec.cpus ?? DEFAULT_CPUS) * CPU_PERIOD_US)));
		// Memory and swap together are the memory: swap never adds to it.
		const memory = `${memoryMb}m`;
		args.push("--memory", memory, "--memory-swap", memory);
		args.push("--mount", `type=bind,src=${this.#daemonPath},dst=${DAEMON_IN_COMPUTER},readonly`, "--entrypoint", DAEMON_IN_COMPUTER);
		args.push("--workdir", spec.workdir ?? WORK);
		// PID 1 ends the computer at the deadline the label holds, so a computer the janitor misses still stops.
		args.push(spec.image, "init", "--deadline", deadline);

		const started = await this.#run(args, signal);
		if (!started.ok || started.value.exitCode !== 0) {
			// A run that failed or was aborted may still have made the container.
			await this.#run(["rm", "--force", "--volumes", name]);
			return started.ok ? fail("docker", `docker run failed: ${started.value.stderr.trim()}`) : started;
		}
		const ref = { id: started.value.stdout.trim(), name };
		// From here the computer exists: every step takes the caller's signal, and an abort deletes the computer.
		const inspected = await this.#inspect([name], signal);
		if (signal?.aborted) return this.#abandon(ref);
		const report = inspected.ok ? inspected.value[0] : undefined;
		const state = report?.State;
		if (state?.Running !== true) {
			await this.#run(["rm", "--force", "--volumes", name]);
			const why = state ? `status ${state.Status}, exit code ${state.ExitCode}${state.Error ? `: ${state.Error}` : ""}` : "it could not be inspected";
			return fail("docker", `the computer ${name} was not running after its start (${why}), so it was removed`);
		}
		const checked = await this.#check(spec, ref, report as DockerInspect, deadline, user, signal);
		// Fail closed: no create returns ok once its signal has aborted.
		if (signal?.aborted) return this.#abandon(ref);
		if (checked.ok) return ok(ref);
		// Fail closed: a computer that is not what was declared, or that cannot show it is, does not outlive create.
		const removed = await this.release(ref, "delete");
		const after = removed.ok ? "was deleted" : `could not be deleted (${removed.error.message})`;
		return fail(checked.error.code, `the computer ${name} ${after}: ${checked.error.message}`);
	}

	/** Deletes a computer whose create was aborted after docker run; the delete itself is not signalled. */
	async #abandon(ref: ComputerRef): Promise<Result<never>> {
		const removed = await this.release(ref, "delete");
		const after = removed.ok ? "was deleted" : `could not be deleted (${removed.error.message})`;
		return fail("aborted", `create was aborted after docker run; the computer ${ref.name} ${after}`);
	}

	/** The drift check: the computer's own report, from inspect and from its daemon's hello, against the spec. */
	async #check(spec: ComputerSpec, ref: ComputerRef, report: DockerInspect, deadline: string, user: string, signal?: AbortSignal): Promise<Result<void>> {
		const arch = await this.#hostArch(signal);
		if (!arch.ok) return arch;
		const opened = await this.#open(ref, signal);
		if (!opened.ok) return opened;
		await opened.value.close();
		const expected = { version: VERSION, capabilities: this.capabilities().daemon, arch: arch.value, daemonPath: this.#daemonPath, deadline, user };
		const found = drift(spec, report, opened.value.hello, expected);
		return found.length === 0 ? ok(undefined) : fail("refused", `it did not match its spec: ${found.join("; ")}`);
	}

	async #hostArch(signal?: AbortSignal): Promise<Result<string>> {
		const ran = await this.#run(["info", "--format", "{{.Architecture}}"], signal);
		if (!ran.ok) return ran;
		if (ran.value.exitCode !== 0) return fail("docker", `docker info failed: ${ran.value.stderr.trim()}`);
		const machine = ran.value.stdout.trim();
		return ok(GO_ARCH[machine] ?? machine);
	}

	async connect(ref: ComputerRef): Promise<Result<ComputerConnection>> {
		if (!NAME.test(ref.name)) return fail("invalid", `${ref.name} is not the name of a Docker computer (computer-<12 hex digits>)`);
		const opened = await this.#open(ref);
		if (!opened.ok) return opened;
		const found = helloDrift(opened.value.hello, { version: VERSION, capabilities: this.capabilities().daemon });
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

	async attach(ref: { id: string } | { labels: Record<string, string> }, { signal }: CallContext = {}): Promise<Result<ComputerRef>> {
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
			return ok({ id: report.Id, name: nameOf(report) });
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
		return ok(matches[0] as ComputerRef);
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
		for (let at = 0; at < ids.length; at += INSPECT_BATCH) {
			// A computer removed between ps and inspect is left out.
			const found = await this.#inspect(ids.slice(at, at + INSPECT_BATCH), signal, LIST_FORMAT);
			if (!found.ok) return found;
			infos.push(...found.value.filter(ours).map(infoOf));
		}
		return ok(infos);
	}

	async network(ref: ComputerRef, policy?: NetworkSpec, { signal }: CallContext = {}): Promise<Result<NetworkPolicy>> {
		if (!NAME.test(ref?.name)) return fail("invalid", `${ref?.name} is not the name of a Docker computer (computer-<12 hex digits>)`);
		if (policy !== undefined && policy !== "none" && policy !== "open") {
			const allow = typeof policy === "object" && policy !== null && "allow" in policy;
			return fail("refused", allow ? `${ALLOWLIST}; ${FIXED}` : `${FIXED}; a network is "none" or "open"`);
		}
		const found = await this.#inspect([ref.name], signal);
		if (!found.ok) return found;
		const [report] = found.value;
		if (report === undefined || !ours(report)) return fail("not_found", `no Docker computer is named ${ref.name}`);
		const current = networkOf(report);
		if (policy === undefined || policy === current) return ok(current);
		return fail("refused", `${FIXED}: ${ref.name} has network ${policyWords(current)}, not ${policy}`);
	}

	async release(ref: ComputerRef, how: "stop" | "delete"): Promise<Result<void>> {
		if (!NAME.test(ref.name)) return fail("invalid", `${ref.name} is not the name of a Docker computer (computer-<12 hex digits>)`);
		if (how !== "stop" && how !== "delete") return fail("invalid", `release is "stop" or "delete", not ${String(how)}`);
		const args = how === "stop" ? ["stop", ref.name] : ["rm", "--force", "--volumes", ref.name];
		const ran = await this.#run(args);
		if (!ran.ok) return ran;
		if (ran.value.exitCode === 0 || noSuchContainer(ran.value.stderr)) return ok(undefined);
		return fail("docker", `docker ${args[0]} ${ref.name} failed: ${ran.value.stderr.trim()}`);
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

/** A computer as list() reports it. The deadline counts only as the provider writes it, an ISO time. */
function infoOf(report: DockerInspect): ComputerInfo {
	const labels = { ...(report.Config?.Labels ?? {}) };
	const written = labels[DEADLINE_LABEL];
	const at = written === undefined ? Number.NaN : Date.parse(written);
	const deadline = Number.isNaN(at) || new Date(at).toISOString() !== written ? undefined : new Date(at);
	const state = report.State?.Running === true ? "running" : "stopped";
	return { ref: { id: report.Id ?? "", name: nameOf(report) }, labels, deadline, state, network: networkOf(report) };
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
