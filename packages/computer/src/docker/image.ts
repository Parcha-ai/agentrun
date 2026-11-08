// The image a Docker computer starts from, made ready by the provider's own process: a recipe built once, or an image by
// name pulled once. There is no state file and no second process to wait on: Docker's own tag is the shared state.
//
// A recipe is a Dockerfile with no build context, built with `docker build -` (the recipe on stdin), tagged
// `agentrun-computer:<the first 12 hex digits of its sha256>` and labelled with the whole sha256 (RECIPE_LABEL). It is
// built only when Docker has no image under the tag, or has one of another recipe. Same recipe, same tag, same label: a
// build is idempotent. Two processes that both miss the tag both build, BuildKit sharing its cache. With Docker 29's
// containerd image store the first to tag wins and the others fail with "already exists"; with the classic store the
// last one wins. Either way a build or pull that fails asks Docker once more, and the tag on an image of this recipe is
// the answer. A computer made from an image that lost its tag keeps it, as Docker holds an image by its id. An image by
// name is pulled when Docker has none, and never built.
//
// In one process, concurrent callers share one flight per docker CLI and recipe (or image): the first starts it, the rest
// wait on it. A flight is forgotten once it settles, so a later call asks Docker again, and a failure is never kept: the
// next call tries again. One bound, the first caller's timeoutMs, covers a flight's inspect and its build or pull; past
// it, the docker CLI is killed. A caller's signal ends its own wait; when the last caller waiting aborts, the flight's
// docker is killed too. The words say what happened and the next step, and hold none of Docker's output: only the
// recipe's own failing step, or the line Docker could not parse, which the caller wrote.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fail, ok, type Result } from "../result.js";

/** The repository every recipe's image is tagged in. */
export const IMAGE_REPOSITORY = "agentrun-computer";
/** The label a recipe's image carries: the recipe's whole sha256. A computer made from the image carries it too. */
export const RECIPE_LABEL = "agentrun.computer.recipe";
/** How long a flight, inspect and build or pull, may take before its docker is killed: 10 minutes. */
export const IMAGE_TIMEOUT_MS = 10 * 60_000;
/** What the default image has, in words: serve's, for the timeline row a run shows while it is built. */
export const DOCKER_RECIPE_HAS = "python, git, curl, node, npm, rg";
/** The base the default image builds from: `python:3.12-slim`, pinned to the multi-arch index digest Docker Hub served
 *  for that tag on 2026-11-03, so a build gets the same base wherever it runs. To move it, read the tag's index digest
 *  again (an anonymous pull token from auth.docker.io for `repository:library/python:pull`, then a HEAD of
 *  registry-1.docker.io/v2/library/python/manifests/3.12-slim accepting an OCI index or a manifest list: its
 *  `docker-content-digest`), and put it here. The recipe's hash changes with it, and so does DEFAULT_DOCKER_IMAGE. */
export const DOCKER_BASE = "python:3.12-slim@sha256:b18b261e1b4974b4f321451ad5251ded85abb22c2b8b262da527dda1d031ab30";
/** The default image's recipe: python with git, curl, node, npm and rg for a model's tools, and socat, the relay to a
 *  computer's egress proxy when it has one. */
export const DOCKER_RECIPE = [
	`FROM ${DOCKER_BASE}`,
	"RUN apt-get update \\",
	" && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git curl ca-certificates nodejs npm ripgrep socat \\",
	" && rm -rf /var/lib/apt/lists/*",
	"",
].join("\n");

/** Where an image comes from: a recipe, built here, or an image by name, pulled when Docker has none. */
export type ImageSource = { recipe: string } | { image: string };

export interface EnsureImageOptions {
	/** The docker CLI. */
	docker?: string;
	/** Ends this caller's wait; the last caller's abort stops the build or pull. */
	signal?: AbortSignal;
	/** The flight's bound, when this call starts it; default IMAGE_TIMEOUT_MS. */
	timeoutMs?: number;
	/** Told once, before this caller waits on a build or pull, its own or one it joined; never when Docker has the image.
	 *  A throw from it is ignored. */
	onWait?: (making: Making, tag: string) => void;
}

/** What a flight does when Docker has no image of its source. */
export type Making = "build" | "pull";

export const recipeHash = (recipe: string): string => createHash("sha256").update(recipe).digest("hex");
/** The tag a recipe's image has: the repository and the first 12 hex digits of the recipe's sha256. */
export const recipeTag = (recipe: string): string => `${IMAGE_REPOSITORY}:${recipeHash(recipe).slice(0, 12)}`;
/** The default image: the provider's own, built from DOCKER_RECIPE. */
export const DEFAULT_DOCKER_IMAGE = recipeTag(DOCKER_RECIPE);

/** The longest delay Node's timers hold: 2^31 - 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;
const SOURCE_WORDS = "an image source is { recipe } or { image }, one of them";
const RECIPE_WORDS = "a recipe is the text of a Dockerfile with a FROM line and no NUL byte; it is built with no context";
const IMAGE_WORDS = 'an image is a name such as debian:bookworm-slim: not empty, with no space or NUL byte, not starting with "-"';
const FROM = /^\s*FROM\s+(?:--\S+\s+)*(\S+)/im;
/** Docker says `No such image`; Podman, standing in for it, `image not known`. */
const MISSING = /no such image|image not known/i;
const NOT_RUNNING = /Cannot connect to the Docker daemon|Is the docker daemon running|permission denied while trying to connect/i;
const UNREACHABLE = /dial tcp|no such host|i\/o timeout|connection refused|network is unreachable|TLS handshake timeout|Client\.Timeout|Temporary failure resolving|Could not resolve|Could not connect/i;
const NO_BASE = /pull access denied|manifest unknown|not found: manifest|failed to resolve source metadata|failed to fetch anonymous token/i;
const NO_PACKAGE = /Unable to locate package|has no installation candidate|E: Package|unable to select packages/i;
const PARSE = /dockerfile parse error on line (\d+)/i;
/** A RUN step that failed, as BuildKit and as the legacy builder say it. */
const STEP = [/process "((?:[^"\\]|\\.)*)" did not complete successfully: exit code: (\d+)/, /The command '(.*?)' returned a non-zero code: (\d+)/];
const DENIED = /pull access denied|unauthorized|authentication required|denied:/i;
const NO_MANIFEST = /manifest unknown|manifest for .* not found|not found: manifest/i;

type Source = { kind: "recipe"; recipe: string; tag: string; hash: string; base: string } | { kind: "image"; tag: string };
/** What a docker call ended with: its exit code, "timeout" (the bound killed it), "aborted" (no caller waits) or "ENOENT". */
interface Answer {
	code: number | "timeout" | "aborted" | "ENOENT" | string;
	stdout: string;
	stderr: string;
}
interface Flight {
	result: Promise<Result<string>>;
	controller: AbortController;
	waiting: number;
	/** Set once the flight builds or pulls; until then, the callers to tell when it does. */
	making?: Making;
	toTell: Set<() => void>;
}

/** One flight per docker CLI and source, for as long as it runs. */
const flights = new Map<string, Flight>();

/** Seconds or minutes, in words. */
const span = (ms: number) => (ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`);
const exitOf = (answer: Answer) => (typeof answer.code === "number" ? `exit ${answer.code}` : answer.code);

/** Why source is not an image source, in words, or undefined when it is one. */
export function imageSourceProblem(source: unknown): string | undefined {
	const checked = sourceOf(source);
	return typeof checked === "string" ? checked : undefined;
}

/** The source checked, with its tag (and a recipe's hash and base), or why it is not one. */
function sourceOf(source: unknown): Source | string {
	const given = (typeof source === "object" && source !== null ? source : {}) as { recipe?: unknown; image?: unknown };
	if ((given.recipe === undefined) === (given.image === undefined)) return SOURCE_WORDS;
	if (given.recipe !== undefined) {
		const recipe = given.recipe;
		const base = typeof recipe === "string" && !recipe.includes("\0") ? FROM.exec(recipe)?.[1] : undefined;
		if (typeof recipe !== "string" || base === undefined) return RECIPE_WORDS;
		const hash = recipeHash(recipe);
		return { kind: "recipe", recipe, hash, base, tag: `${IMAGE_REPOSITORY}:${hash.slice(0, 12)}` };
	}
	const image = given.image;
	if (typeof image !== "string" || image === "" || image.startsWith("-") || /[\s\0]/.test(image)) return IMAGE_WORDS;
	return { kind: "image", tag: image };
}

/**
 * The image ready in Docker: its tag, for create's spec.image. A recipe is built when Docker has no image of it under its
 * tag; an image by name is pulled when Docker has none. Concurrent callers share one flight; see the top of this file.
 */
export async function ensureImage(source: ImageSource, { docker = "docker", signal, timeoutMs = IMAGE_TIMEOUT_MS, onWait }: EnsureImageOptions = {}): Promise<Result<string>> {
	const checked = sourceOf(source);
	if (typeof checked === "string") return fail("invalid", checked);
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS) {
		return fail("invalid", `timeoutMs must be a whole number of milliseconds above 0 and at most ${MAX_TIMER_MS}, not ${JSON.stringify(timeoutMs) ?? String(timeoutMs)}`);
	}
	if (signal?.aborted) return fail("aborted", `the wait for ${checked.tag} was aborted before it began`);
	const key = JSON.stringify([docker, checked.kind, checked.kind === "recipe" ? checked.hash : checked.tag]);
	let flight = flights.get(key);
	// A flight every caller left is stopping: a new caller starts its own.
	if (flight === undefined || flight.controller.signal.aborted) {
		const crew = { controller: new AbortController(), waiting: 0, toTell: new Set<() => void>() };
		const started: Flight = Object.assign(crew, { result: fly(docker, checked, timeoutMs, crew) });
		flight = started;
		flights.set(key, started);
		void started.result.finally(() => {
			if (flights.get(key) === started) flights.delete(key);
		});
	}
	const joined = flight;
	joined.waiting += 1;
	const tell = () => {
		try {
			if (joined.making !== undefined) onWait?.(joined.making, checked.tag);
		} catch {
			// The caller's listener is its own: a throw changes nothing here.
		}
	};
	// The abort listener goes in before onWait is told, and the signal is read again after: an onWait that aborts its own
	// caller's signal, told at once when the caller joins a build under way, is never missed.
	let leave: (() => void) | undefined;
	const settled =
		signal === undefined
			? joined.result
			: new Promise<Result<string>>((resolve) => {
					let left = false;
					const making = checked.kind === "recipe" ? "build" : "pull";
					leave = () => {
						if (left) return;
						left = true;
						signal.removeEventListener("abort", onAbort);
						joined.toTell.delete(tell);
						joined.waiting -= 1;
						if (joined.waiting > 0) return resolve(fail("aborted", `the wait for ${checked.tag} was aborted; the ${making} goes on for the other callers waiting on it`));
						joined.controller.abort();
						resolve(fail("aborted", `the wait for ${checked.tag} was aborted, and the ${making}, which no other caller waited on, was stopped`));
					};
					const onAbort = () => leave?.();
					signal.addEventListener("abort", onAbort, { once: true });
					void joined.result.then((result) => {
						if (left) return;
						left = true;
						signal.removeEventListener("abort", onAbort);
						resolve(result);
					});
				});
	if (onWait !== undefined) {
		if (joined.making !== undefined) tell();
		else joined.toTell.add(tell);
	}
	if (signal?.aborted) leave?.();
	return settled;
}

/**
 * The flight: inspect, then build or pull when Docker has no image of the source, all within timeoutMs. A build or pull
 * that fails asks Docker once more: another process may have tagged the image first (Docker 29's containerd image store
 * fails the loser of that race with "already exists"), and an image of this source under the tag is the answer.
 */
async function fly(docker: string, source: Source, timeoutMs: number, flight: Omit<Flight, "result">): Promise<Result<string>> {
	const { controller } = flight;
	let late = false;
	const timer = setTimeout(() => {
		late = true;
		controller.abort();
	}, timeoutMs);
	const call = (args: string[], input?: string) => run(docker, args, controller.signal, () => late, input);
	const inspect = () => call(["image", "inspect", "--format", "{{json .Config.Labels}}", source.tag]);
	const ready = (answer: Answer) => answer.code === 0 && (source.kind === "image" || labelsOf(answer.stdout)[RECIPE_LABEL] === source.hash);
	try {
		const inspected = await inspect();
		if (ready(inspected)) return ok(source.tag);
		if (inspected.code !== 0 && !MISSING.test(inspected.stderr)) return inspectFailure(docker, source.tag, inspected, timeoutMs);
		flight.making = source.kind === "image" ? "pull" : "build";
		for (const tell of flight.toTell) tell();
		flight.toTell.clear();
		// Every caller may have left while it was told (an onWait that aborts its own signal): then nothing is started.
		if (controller.signal.aborted && !late) return fail("aborted", "it was stopped before it began: no caller waits on it any more");
		const made =
			source.kind === "image"
				? await call(["pull", "--quiet", source.tag])
				: await call(["build", "--quiet", "--label", `${RECIPE_LABEL}=${source.hash}`, "--tag", source.tag, "-"], source.recipe);
		if (made.code === 0 || (typeof made.code === "number" && ready(await inspect()))) return ok(source.tag);
		return source.kind === "image" ? pullFailure(docker, source.tag, made, timeoutMs) : buildFailure(docker, source, made, timeoutMs);
	} finally {
		clearTimeout(timer);
	}
}

/** `docker` with args, the input on its stdin, killed with SIGKILL when the signal aborts. */
function run(docker: string, args: string[], signal: AbortSignal, late: () => boolean, input?: string): Promise<Answer> {
	return new Promise((resolve) => {
		const child = execFile(docker, args, { encoding: "utf8", signal, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error === null) return resolve({ code: 0, stdout, stderr });
			const failed = error as NodeJS.ErrnoException & { code?: number | string };
			const code = signal.aborted ? (late() ? "timeout" : "aborted") : typeof failed.code === "number" ? failed.code : (failed.code ?? failed.name);
			resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
		child.stdin?.on("error", () => undefined);
		child.stdin?.end(input ?? "");
	});
}

/** The labels `docker image inspect` gave, or none when it gave none. */
function labelsOf(stdout: string): Record<string, string> {
	try {
		const value = JSON.parse(stdout.trim() || "null") as unknown;
		return value && typeof value === "object" ? (value as Record<string, string>) : {};
	} catch {
		return {};
	}
}

/** The failures every docker call shares: no CLI, the bound (in the words given), the last caller gone. */
function common(docker: string, answer: Answer, timedOut: string): Result<never> | undefined {
	if (answer.code === "ENOENT") return fail("docker", `the docker CLI (${docker}) was not found`);
	if (answer.code === "timeout") return fail("timeout", timedOut);
	if (answer.code === "aborted") return fail("aborted", "it was stopped: no caller waits on it any more");
	return undefined;
}

function inspectFailure(docker: string, tag: string, answer: Answer, timeoutMs: number): Result<never> {
	const shared = common(docker, answer, `docker image inspect ${tag} did not answer within ${span(timeoutMs)}, so it was stopped: call again`);
	if (shared) return shared;
	if (NOT_RUNNING.test(answer.stderr)) return fail("docker", `Docker did not answer docker image inspect ${tag}: is it running, and may this user reach it?`);
	return fail("docker", `docker image inspect ${tag} failed (${exitOf(answer)}): run it on this machine as this process's user to see why`);
}

function buildFailure(docker: string, source: Extract<Source, { kind: "recipe" }>, answer: Answer, timeoutMs: number): Result<never> {
	const { tag, base } = source;
	const shared = common(docker, answer, `the build of ${tag} did not finish within ${span(timeoutMs)}, so it was stopped: call again to build it again`);
	if (shared) return shared;
	const said = answer.stderr;
	if (/no space left on device/i.test(said)) return fail("docker", `the build of ${tag} ran out of disk space: free some, then call again`);
	// A base that could not be fetched for want of a network says so in both ways: the network is the cause.
	if (UNREACHABLE.test(said)) return fail("docker", `the build of ${tag} could not reach the network (it pulls ${base}): call again once this machine can reach it`);
	if (NO_BASE.test(said)) return fail("docker", `the build of ${tag} could not pull its base, ${base}: name a base the registry has, or pull it on this machine first`);
	if (NO_PACKAGE.test(said)) return fail("docker", `the recipe of ${tag} names a package its base's package manager could not install: check the names, then call again`);
	const line = PARSE.exec(said)?.[1];
	if (line !== undefined) return fail("docker", `Docker could not parse the recipe of ${tag} at line ${line}: fix that line`);
	for (const pattern of STEP) {
		const step = pattern.exec(said);
		if (step === null) continue;
		// The step is the recipe's own words, which the caller wrote: the shell's prefix off, BuildKit's quoting undone.
		const command = (step[1] ?? "").replace(/\\(.)/g, "$1").replace(/^\/bin\/sh -c /, "").slice(0, 200);
		return fail("docker", `the recipe of ${tag} failed at the step \`RUN ${command}\` with exit code ${step[2]}: fix that step`);
	}
	return fail("docker", `docker build of ${tag} failed (${exitOf(answer)}): run docker build with the recipe on this machine to see why`);
}

function pullFailure(docker: string, image: string, answer: Answer, timeoutMs: number): Result<never> {
	const see = `run docker pull ${image} on this machine to see why`;
	const shared = common(docker, answer, `the pull of ${image} did not finish within ${span(timeoutMs)}, so it was stopped: run docker pull ${image} on this machine, or call again`);
	if (shared) return shared;
	const said = answer.stderr;
	if (DENIED.test(said)) return fail("docker", `the registry refused the pull of ${image} (no such repository, or it needs a docker login): ${see}`);
	if (NO_MANIFEST.test(said)) return fail("docker", `the registry has no ${image}: name an image it has`);
	if (UNREACHABLE.test(said)) return fail("docker", `the registry could not be reached to pull ${image}: ${see}`);
	return fail("docker", `docker pull ${image} failed (${exitOf(answer)}): ${see}`);
}
