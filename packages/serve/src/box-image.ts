// The image a Docker box starts from, made ready at the server's start, so a run's first tool call is never a silent pull
// or build. By default it is this server's own, built here from BOX_RECIPE (python 3.12 with git and curl), tagged
// `agentrun-box:<the recipe's hash>` and labelled with the whole hash (RECIPE_LABEL): built on first use, and again only
// when the recipe changes. AGENTRUN_DOCKER_IMAGE names another image instead, which is pulled when Docker has none.
//
// Once docker answers its probe (boxes.ts), the server asks Docker for the image (`docker image inspect`). When Docker has
// it (the built one with this recipe's hash), the box is ready. When not, the server builds or pulls it once, in the
// background, within BUILD_TIMEOUT_MS or PULL_TIMEOUT_MS: docker is then available and preparing ("building the box
// image (...)", "pulling <image>"), and ready once the image is in. A build or pull that fails is tried once more,
// RETRY_AFTER_MS later, docker preparing meanwhile with why ("trying once more: <the failure>"); one that fails again, or
// does not finish in time, makes docker unavailable with the reason, until a restart tries again. Docker's own output
// is never in a reason, as for the probes: the reason says what kind of failure it was, and what to do. The build
// reaches the network (the base image, apt); a box never does (`--network none`, run-box.ts).
//
// The state is written to IMAGE_STATE_FILE in the data directory at each change, for the run's processes: a run's first
// box create reads it there (awaitImage, from run-box.ts) and, while the image is coming, waits for it, with one row on
// the run's timeline, instead of a `docker run` that pulls inside the tool call. Each record names its writer, the server
// (its pid and start time). A server that went away mid-way (killed, or closed while the image came) leaves the file
// saying preparing: a run that reads it once that writer is gone (the check box/sweep.ts makes of a box record's writer),
// or past its deadline where the writer cannot be told (no /proc), stops waiting and fails its call in words that say to
// restart the server, which builds or pulls the image again; never the `docker run` of an image that is not there.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { startTimeOf, writerGone } from "./box/sweep.js";
import { BOX_KEYS, type BoxOffer } from "./boxes.js";

/** The setting that names another image for Docker boxes than this server's own. */
export const DOCKER_IMAGE_ENV = "AGENTRUN_DOCKER_IMAGE";
/** What the default image has, in words. */
export const RECIPE_HAS = "python, git, curl, node, rg";
/** The base the default image builds from: `python:3.12-slim`, pinned to the multi-arch index digest Docker Hub served
 *  for that tag on 2026-11-03, so a build gets the same base wherever it runs. To move it, read the tag's index digest
 *  again (an anonymous pull token from auth.docker.io for `repository:library/python:pull`, then a HEAD of
 *  registry-1.docker.io/v2/library/python/manifests/3.12-slim accepting an OCI index or a manifest list: its
 *  `docker-content-digest`), and put it here. The recipe's hash changes with it, and so does the image's tag
 *  (DEFAULT_DOCKER_IMAGE), so every server builds the new one at its next start. */
export const BOX_BASE = "python:3.12-slim@sha256:b18b261e1b4974b4f321451ad5251ded85abb22c2b8b262da527dda1d031ab30";
/** The default image's recipe: a Dockerfile that needs no other file, written alone into a private context directory for
 *  each build (buildContext). Its hash names the image. */
export const BOX_RECIPE = [
  `FROM ${BOX_BASE}`,
  "RUN apt-get update \\",
  " && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git curl ca-certificates nodejs ripgrep \\",
  " && rm -rf /var/lib/apt/lists/*",
  "",
].join("\n");
/** The label the built image carries: its recipe's sha256. */
export const RECIPE_LABEL = "agentrun.box-image";
export const RECIPE_HASH = createHash("sha256").update(BOX_RECIPE).digest("hex");
/** The default image: this server's own, built from BOX_RECIPE, its tag the recipe's hash. */
export const DEFAULT_DOCKER_IMAGE = `agentrun-box:${RECIPE_HASH.slice(0, 12)}`;
/** The image a Docker box starts from on a server or a run with `env`. */
export const boxImageOf = (env: NodeJS.ProcessEnv): string => env[DOCKER_IMAGE_ENV] || DEFAULT_DOCKER_IMAGE;
/** Where the image's state is kept for the run's processes, in the data directory. */
export const IMAGE_STATE_FILE = "box-image.json";
/** How long the start's pull, or build, may take; past it, it is stopped and docker is unavailable. */
export const PULL_TIMEOUT_MS = 10 * 60_000;
export const BUILD_TIMEOUT_MS = 10 * 60_000;
/** How long Docker may take to say whether it has the image. */
export const INSPECT_TIMEOUT_MS = 5_000;
/** How long past the pull's deadline a run still waits on a file that says preparing: the server's own timer ends the
 *  pull at the deadline, so only a server that is gone leaves the file saying preparing after it. */
export const STALE_AFTER_MS = 30_000;
/** How long after a failed build or pull it is tried once more. */
export const RETRY_AFTER_MS = 5_000;
/** How long the server's close waits for the image's last record to be saved, so a docker that hangs cannot hold it. */
export const CLOSE_WAIT_MS = 5_000;
/** How often a waiting run reads the file again. */
const POLL_MS = 250;

/** The image's state: `ready`; `preparing` while the server pulls it; `unavailable`, with why. */
export type ImageState = { state: "ready" } | { state: "preparing"; reason: string } | { state: "unavailable"; reason: string };
/** The file's record: the image, its state, and while it is coming, the time it is stopped by (`until`, epoch ms) and
 *  the timeline row a run that waits for it writes (`row`). `writer`: the server that wrote it, its pid and start time,
 *  where /proc gives that. */
export type ImageRecord = { image: string; state: ImageState["state"]; reason?: string; until?: number; row?: string; writer?: { pid: number; startTime: string } };

export type DockerImage = {
  readonly image: string;
  /** The state now. */
  state(): ImageState;
  /** Settles with the state once it is ready or unavailable. */
  readonly settled: Promise<ImageState>;
  /** Stops a build or pull in progress and waits, at most CLOSE_WAIT_MS, for its last record to be saved: the server's
   *  close (and a start that failed) calls it before the data directory's lock goes, so no record of this server lands
   *  after the next one took the lock. */
  close(): Promise<void>;
};

type Answer = { code: number | string | undefined; stdout: string; stderr: string };

/** `docker` with `args`, in the server's environment without the boxes' keys, nothing on its stdin, killed after
 *  `timeoutMs` or on `signal`. */
function docker(env: NodeJS.ProcessEnv, args: readonly string[], timeoutMs: number, options: { signal?: AbortSignal } = {}): Promise<Answer> {
  const dockerEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !BOX_KEYS.includes(name)));
  return new Promise((resolve) => {
    const child = execFile("docker", args, { env: dockerEnv, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024, ...(options.signal ? { signal: options.signal } : {}) }, (error, stdout, stderr) => {
      const failed = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      resolve({ code: !failed ? 0 : failed.killed ? "timeout" : typeof failed.code === "number" ? failed.code : (failed.code ?? failed.name), stdout: String(stdout), stderr: String(stderr) });
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end();
  });
}

/** Seconds or minutes, in words. */
const span = (ms: number) => (ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`);

const exitOf = (answer: Answer) => (typeof answer.code === "number" ? `exit ${answer.code}` : answer.code);
const UNREACHABLE = /dial tcp|no such host|i\/o timeout|connection refused|network is unreachable|TLS handshake timeout|Client\.Timeout|Temporary failure resolving|Could not resolve|Could not connect/i;

/** A failure in words that hold none of Docker's output: what happened, and the next step. */
type Failure = { cause: string; next: string };
const reasonOf = (failure: Failure) => `${failure.cause}: ${failure.next}`;

/** Why the build of the default image failed, and the next step. */
function buildFailure(answer: Answer, timeoutMs: number): Failure {
  const next = `set ${DOCKER_IMAGE_ENV} to an image this machine has, or restart the server to build it again`;
  if (answer.code === "timeout") return { cause: `the build of the box image did not finish within ${span(timeoutMs)}`, next };
  if (/no space left on device/i.test(answer.stderr)) return { cause: "the build of the box image ran out of disk space", next: "free some, then restart the server" };
  // A base that could not be fetched for want of a network says so in both ways: the network is the cause.
  if (UNREACHABLE.test(answer.stderr)) return { cause: "the build of the box image could not reach the network (it pulls python:3.12-slim and installs git, curl, nodejs and ripgrep with apt)", next };
  if (/pull access denied|manifest unknown|not found: manifest|failed to resolve source metadata|failed to fetch anonymous token/i.test(answer.stderr)) return { cause: "the build of the box image could not pull its base, python:3.12-slim", next };
  if (/Unable to locate package|has no installation candidate|E: Package/i.test(answer.stderr)) return { cause: "apt could not install what the box image needs (git, curl, nodejs, ripgrep)", next };
  return { cause: `docker build of the box image failed (${exitOf(answer)})`, next };
}

/** Why a pull failed, and the next step. */
function pullFailure(image: string, answer: Answer, timeoutMs: number): Failure {
  const see = `run \`docker pull ${image}\` on this machine to see why, then restart the server`;
  if (answer.code === "timeout") return { cause: `the pull of ${image} did not finish within ${span(timeoutMs)}`, next: `run \`docker pull ${image}\` on this machine, then restart the server` };
  if (/pull access denied|unauthorized|authentication required|denied:/i.test(answer.stderr)) return { cause: `the registry refused the pull of ${image} (no such repository, or it needs a docker login)`, next: see };
  if (/manifest unknown|manifest for .* not found|not found: manifest/i.test(answer.stderr)) return { cause: `the registry has no ${image}`, next: "name an image it has in AGENTRUN_DOCKER_IMAGE, then restart the server" };
  if (UNREACHABLE.test(answer.stderr)) return { cause: `the registry could not be reached to pull ${image}`, next: see };
  return { cause: `docker pull ${image} failed (${exitOf(answer)})`, next: see };
}

/** This process, as a record names its writer: its pid and start time, where /proc gives that (Linux). */
function self(): Pick<ImageRecord, "writer"> {
  const startTime = startTimeOf(process.pid);
  return startTime ? { writer: { pid: process.pid, startTime } } : {};
}

/** Writes the record for the run's processes, whole or not at all, naming this server as its writer. */
async function record(data: string, value: ImageRecord): Promise<void> {
  const file = join(data, IMAGE_STATE_FILE);
  await writeFile(`${file}.partial`, `${JSON.stringify({ ...value, ...self() })}\n`, { mode: 0o600 });
  await rename(`${file}.partial`, file);
}

/** Removes the record: this server has no Docker box, so no run waits on its image. */
export const clearImage = (data: string): Promise<void> => rm(join(data, IMAGE_STATE_FILE), { force: true });

/** `docker build` of the default image: BOX_RECIPE written alone as `Dockerfile` into a fresh directory of its own (0700,
 *  under TMPDIR), which is the build's context and is removed when the build ends, however it ends. A file on disk, not
 *  stdin, so what was built can be read where it was built. */
async function buildContext(env: NodeJS.ProcessEnv, image: string, timeoutMs: number, signal: AbortSignal): Promise<Answer> {
  const dir = await mkdtemp(join(env.TMPDIR || tmpdir(), "agentrun-box-"));
  try {
    await chmod(dir, 0o700);
    await writeFile(join(dir, "Dockerfile"), BOX_RECIPE, { mode: 0o600 });
    return await docker(env, ["build", "--quiet", "--label", `${RECIPE_LABEL}=${RECIPE_HASH}`, "--tag", image, dir], timeoutMs, { signal });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The labels of `image` as `docker image inspect` gives them, or none when it has none. */
const labelsOf = (stdout: string): Record<string, string> => {
  try {
    const value = JSON.parse(stdout.trim() || "null") as unknown;
    return value && typeof value === "object" ? (value as Record<string, string>) : {};
  } catch {
    return {};
  }
};

/**
 * The image's readiness on this server: asked of Docker now (within INSPECT_TIMEOUT_MS), and when Docker has none (or,
 * for the default, has one of another recipe), built from BOX_RECIPE or pulled, in the background, within its bound; a
 * try that fails, but not for want of time, is made once more, `retryAfterMs` later. `onChange` is told each state after
 * the first. The record in the data directory follows the state.
 */
export async function dockerImage(env: NodeJS.ProcessEnv, data: string, image: string, options: { pullTimeoutMs?: number; buildTimeoutMs?: number; inspectTimeoutMs?: number; retryAfterMs?: number; onChange?: (state: ImageState, ms: number) => void; warn?: (message: string) => void } = {}): Promise<DockerImage> {
  const built = image === DEFAULT_DOCKER_IMAGE;
  const timeoutMs = built ? (options.buildTimeoutMs ?? BUILD_TIMEOUT_MS) : (options.pullTimeoutMs ?? PULL_TIMEOUT_MS);
  let state: ImageState;
  const write = (extra: Pick<ImageRecord, "until" | "row"> = {}) => record(data, { image, state: state.state, ...("reason" in state ? { reason: state.reason } : {}), ...extra }).catch(() => undefined);
  const inspected = await docker(env, ["image", "inspect", "--format", "{{json .Config.Labels}}", image], options.inspectTimeoutMs ?? INSPECT_TIMEOUT_MS);
  const controller = new AbortController();
  // Docker says `No such image`; Podman, standing in for it, `image not known`.
  const missing = inspected.code !== 0 && /no such image|image not known/i.test(inspected.stderr);
  if (inspected.code === 0 && (!built || labelsOf(inspected.stdout)[RECIPE_LABEL] === RECIPE_HASH)) state = { state: "ready" };
  else if (inspected.code !== 0 && !missing) {
    const why = inspected.code === "timeout" ? `did not answer within ${span(options.inspectTimeoutMs ?? INSPECT_TIMEOUT_MS)}` : `failed (${exitOf(inspected)})`;
    state = { state: "unavailable", reason: `docker image inspect ${image} ${why}: run it on this machine as this server's user to see why, then restart the server` };
  } else state = { state: "preparing", reason: built ? `building the box image (${RECIPE_HAS})` : `pulling ${image}` };
  if (state.state !== "preparing") {
    await write();
    const settled = state;
    return { image, state: () => settled, settled: Promise.resolve(settled), close: async () => undefined };
  }
  const started = Date.now();
  const row = built ? `Preparing the box image: building it (${RECIPE_HAS})…` : `Preparing the box image: pulling ${image}…`;
  await write({ until: started + timeoutMs, row });
  const retryAfterMs = options.retryAfterMs ?? RETRY_AFTER_MS;
  // The build's network is Docker's default, for the base image and apt; a box made from it has none (run-box.ts).
  const attempt = (): Promise<Answer> => built
    ? buildContext(env, image, timeoutMs, controller.signal).catch((error: Error) => ({ code: (error as NodeJS.ErrnoException).code ?? error.name, stdout: "", stderr: "" }))
    : docker(env, ["pull", "--quiet", image], timeoutMs, { signal: controller.signal });
  const failure = (answer: Answer) => (built ? buildFailure(answer, timeoutMs) : pullFailure(image, answer, timeoutMs));
  // A record that cannot be written once the build or pull is under way leaves none: a run then makes its box as it
  // would with none, never trusting a `preparing` (and its deadline) the record said before.
  const saveOrClear = (value: ImageRecord) => record(data, value).catch(async (error: NodeJS.ErrnoException) => {
    await clearImage(data).catch(() => undefined);
    options.warn?.(`the record of the box image's state could not be written (${error.code ?? error.name}), so it was removed: runs make their boxes without waiting on it`);
  });
  const settled = attempt().then(async (first) => {
    let answer = first;
    // One try more, after a pause, for a failure that may pass (the network, the registry); not for one that already
    // took the whole bound.
    if (answer.code !== 0 && answer.code !== "timeout" && !controller.signal.aborted) {
      state = { state: "preparing", reason: `trying once more: ${failure(answer).cause}` };
      await saveOrClear({ image, state: state.state, reason: state.reason, until: Date.now() + retryAfterMs + timeoutMs, row });
      options.onChange?.(state, Date.now() - started);
      await sleep(retryAfterMs, controller.signal).catch(() => undefined);
      if (!controller.signal.aborted) answer = await attempt();
    }
    if (controller.signal.aborted) return state;
    state = answer.code === 0 ? { state: "ready" } : { state: "unavailable", reason: reasonOf(failure(answer)) };
    await saveOrClear({ image, state: state.state, ...("reason" in state ? { reason: state.reason } : {}) });
    options.onChange?.(state, Date.now() - started);
    return state;
  });
  const close = async () => {
    controller.abort();
    // A build or pull that ended just before the abort may be saving its last record: that save ends first, within bound.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([settled.then(() => undefined, () => undefined), new Promise<void>((resolve) => (timer = setTimeout(resolve, CLOSE_WAIT_MS)))]);
    clearTimeout(timer);
  };
  return { image, state: () => state, settled, close };
}

/** Docker's offer with the image's state on it: available while it is ready or preparing, else unavailable with why. */
export function withImage(offer: BoxOffer, image: ImageState): BoxOffer {
  if (!offer.available) return offer;
  if (image.state === "ready") return { ...offer, state: "ready" };
  return { id: offer.id, available: image.state === "preparing", state: image.state, reason: image.reason };
}

/** The record the server left, or undefined when there is none or it is not one. */
async function recordIn(data: string): Promise<ImageRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(join(data, IMAGE_STATE_FILE), "utf8")) as Partial<ImageRecord> | null;
    return typeof value?.image === "string" && typeof value.state === "string" ? (value as ImageRecord) : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(() => (signal?.removeEventListener("abort", stop), resolve()), ms);
    const stop = () => (clearTimeout(timer), reject(signal?.reason ?? new Error("aborted")));
    signal?.addEventListener("abort", stop, { once: true });
  });

/**
 * Before a run's box is made from `image`: returns once the server's record says the image is ready, or says nothing
 * of it (no record, another image); waits while it says the image is being built or pulled, telling `note` once, as the
 * run's timeline row; and throws, with the server's reason, when that failed, and saying to restart the server when the
 * server that was making it is gone (its writer, or where that cannot be told, its deadline). A cancel of `context`
 * ends the wait.
 */
export async function awaitImage(data: string, image: string, context: Context, note: (summary: string) => Promise<void> | void): Promise<void> {
  let noted = false;
  for (;;) {
    const at = await recordIn(data);
    if (!at || at.image !== image || at.state === "ready") return;
    if (at.state === "unavailable") throw new Error(`its image ${image} is not ready: ${at.reason ?? "the server could not make it ready"}`);
    if (typeof at.until !== "number") return;
    // Its writer named, that decides: a server that runs is still making the image. Only where it cannot be told does
    // the deadline.
    if (at.writer ? writerGone(at.writer) : Date.now() > at.until + STALE_AFTER_MS) {
      const making = image === DEFAULT_DOCKER_IMAGE ? ["building", "build"] : ["pulling", "pull"];
      throw new Error(`its image ${image} is not ready: the server stopped while ${making[0]} it: restart the server to ${making[1]} it again`);
    }
    if (!noted) {
      noted = true;
      await Promise.resolve(note(at.row ?? `Preparing the box image ${image}…`)).catch(() => undefined);
    }
    await sleep(POLL_MS, context.abortSignal);
  }
}
