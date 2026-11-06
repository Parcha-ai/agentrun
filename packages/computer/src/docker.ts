// The Docker provisioner: every call through the docker CLI with execFile or spawn, never a shell. The hardening flags
// and the inspect reading follow pi-transport's Docker box.
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DaemonClient } from "./client.js";
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
}

const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
/** Where the daemon is mounted in each computer, read-only. */
const DAEMON_IN_COMPUTER = "/opt/agentrun/computerd";
const COMPUTER_LABEL = "agentrun.computer";
const DEADLINE_LABEL = "agentrun.computer.deadline";
const NAME = /^computer-[0-9a-f]{12}$/;
const DEFAULT_PIDS = 4096;
/** The kernel's PID_MAX_LIMIT: a larger --pids-limit fails the create. */
const MAX_PIDS = 4_194_304;
/** Docker's least --memory. */
const MIN_MEMORY_MB = 6;
const HELLO_TIMEOUT_MS = 30_000;
/** The longest lifetime: 30 days. A computer meant to live longer is asked for again. */
const MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const SPEC_FIELDS = new Set(["image", "lifetimeMs", "network", "cpus", "memoryMb", "pids", "labels", "workdir"]);
const NUL = "a NUL byte cannot be passed to docker run";
const ALLOWLIST = "a Docker computer cannot enforce an allowlist yet; ask for network none or open";

interface Ran {
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface Inspected {
	State?: { Running?: boolean; Status?: string; ExitCode?: number; Error?: string };
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isWhole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const noSuchContainer = (stderr: string) => /no such container/i.test(stderr);

export class DockerProvider implements ComputerProvider {
	readonly id = "docker";
	readonly version = VERSION;
	readonly #daemonPath: string;
	readonly #docker: string;

	constructor({ daemonPath, docker = "docker" }: DockerProviderOptions) {
		this.#daemonPath = resolve(daemonPath);
		this.#docker = docker;
	}

	capabilities(): ComputerCapabilities {
		return { lifetime: "janitor", network: ["none", "open"], isolation: "container", os: "linux", daemon: ["exec", "files", "processes"] };
	}

	check(spec: ComputerSpec): Refusal[] {
		const refusals: Refusal[] = [];
		const refuse = (field: string, message: string) => refusals.push({ field, message });
		const given = spec as unknown as Record<string, unknown>;
		const { image, lifetimeMs, network, cpus, memoryMb, pids, labels, workdir } = given;
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
		// A computer drops every capability, so its root runs the mounted daemon only if every user may.
		if ((mode & 0o005) !== 0o005) {
			return fail("invalid", `the daemon at ${this.#daemonPath} has mode ${(mode & 0o777).toString(8)}; a computer's root, with no capabilities, cannot run it: chmod 755 it`);
		}
		if (this.#daemonPath.includes(",")) return fail("invalid", `the daemon path ${this.#daemonPath} has a comma, which a Docker mount cannot hold`);
		if (signal?.aborted) return fail("aborted", "create was aborted before Docker was called");
		const name = `computer-${randomBytes(6).toString("hex")}`;
		const args = ["run", "--detach", "--name", name, "--label", `${COMPUTER_LABEL}=1`];
		args.push("--label", `${DEADLINE_LABEL}=${new Date(Date.now() + spec.lifetimeMs).toISOString()}`);
		for (const [key, value] of Object.entries(spec.labels ?? {})) args.push("--label", `${key}=${value}`);
		args.push("--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", String(spec.pids ?? DEFAULT_PIDS));
		args.push("--network", spec.network === "none" ? "none" : "bridge");
		if (spec.cpus !== undefined) args.push("--cpus", String(spec.cpus));
		// Memory and swap together are the memory: swap never adds to it.
		if (spec.memoryMb !== undefined) args.push("--memory", `${spec.memoryMb}m`, "--memory-swap", `${spec.memoryMb}m`);
		args.push("--mount", `type=bind,src=${this.#daemonPath},dst=${DAEMON_IN_COMPUTER},readonly`, "--entrypoint", DAEMON_IN_COMPUTER);
		if (spec.workdir !== undefined) args.push("--workdir", spec.workdir);
		args.push(spec.image, "init");

		const started = await this.#run(args, signal);
		if (!started.ok || started.value.exitCode !== 0) {
			// A run that failed or was aborted may still have made the container.
			await this.#run(["rm", "--force", "--volumes", name]);
			return started.ok ? fail("docker", `docker run failed: ${started.value.stderr.trim()}`) : started;
		}
		const inspected = await this.#run(["inspect", "--type", "container", "--format", "{{json .}}", name]);
		let state: Inspected["State"];
		if (inspected.ok && inspected.value.exitCode === 0) {
			try {
				state = (JSON.parse(inspected.value.stdout) as Inspected).State;
			} catch {
				state = undefined;
			}
		}
		if (state?.Running !== true) {
			await this.#run(["rm", "--force", "--volumes", name]);
			const why = state ? `status ${state.Status}, exit code ${state.ExitCode}${state.Error ? `: ${state.Error}` : ""}` : "it could not be inspected";
			return fail("docker", `the computer ${name} was not running after its start (${why}), so it was removed`);
		}
		return ok({ id: started.value.stdout.trim(), name });
	}

	async connect(ref: ComputerRef): Promise<Result<ComputerConnection>> {
		if (!NAME.test(ref.name)) return fail("invalid", `${ref.name} is not the name of a Docker computer (computer-<12 hex digits>)`);
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
		const hello = await client.call("hello", { client: `@parcha/agentrun-computer ${VERSION}` }, { signal: AbortSignal.timeout(HELLO_TIMEOUT_MS) });
		if (!hello.ok) {
			await close();
			if (hello.error.code === "aborted") return fail("timeout", `the daemon in ${ref.name} did not answer hello within ${HELLO_TIMEOUT_MS / 1000} s`);
			if (hello.error.code !== "gone") return hello;
			const words = stderr.trim() || hello.error.message;
			return fail(noSuchContainer(words) ? "not_found" : "docker", `cannot reach the daemon in ${ref.name}: ${words}`);
		}
		if (!hello.value.capabilities.includes("exec")) {
			await close();
			return fail("unsupported", `the daemon in ${ref.name} (version ${hello.value.version}) does not offer exec`);
		}
		return ok({ client, hello: hello.value, close });
	}

	async attach(_ref: { id: string } | { labels: Record<string, string> }, _context: CallContext = {}): Promise<Result<ComputerRef>> {
		return fail("unsupported", "attach is not built yet");
	}

	async list(_labels: Record<string, string>, _context: CallContext = {}): Promise<Result<ComputerInfo[]>> {
		return fail("unsupported", "list is not built yet");
	}

	async network(_ref: ComputerRef, _policy?: NetworkSpec, _context: CallContext = {}): Promise<Result<NetworkPolicy>> {
		return fail("unsupported", "network is not built yet");
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

/** The mode of a regular file, or undefined when there is none. */
function fileMode(path: string): number | undefined {
	try {
		const stat = statSync(path);
		return stat.isFile() ? stat.mode : undefined;
	} catch {
		return undefined;
	}
}
