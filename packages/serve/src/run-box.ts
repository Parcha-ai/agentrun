// A sandbox run's box: one per run, made on the first call that runs in it and labelled with the run's id, so the label
// is the record (a bound box's read, write and edit run on this machine: bound-files.ts). A run's process that starts
// again finds it by that label and first kills the commands the process before it left running. Serve destroys it at
// every settle (a cancel included) and at archive, and its start sweeps the boxes of runs that have ended. A box gets the
// run's work/ only, at BOX_WORK, a fixed environment (never this process's, so no key or token enters it), no network
// (or, on Docker with the server's host list set, those hosts alone, through this process's egress proxy: box-egress.ts),
// and limits on its CPUs, memory and processes. pi-transport is an optional peer of this package: it is loaded only for a
// run whose place is a box.
//
// Docker's box is made here, in the run's process, as this server's user, with work/ bound. A Daytona box is remote: it
// cannot bind work/, and its key is the server's alone. The server makes it (through the box relay, box-relay.ts), seeds
// it with work/, pulls work/ back at each turn's end and once more before the run's end is recorded, and destroys it
// after that pull; the run's process reaches it through the relay, which holds the key. What the run's own host tools
// file in work/ meanwhile (writeInWork) is copied into the box too, so its tools read it.
import { createHash } from "node:crypto";
import { appendFile, lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as BACKGROUND } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Box, BoxProvider, BoxSpec } from "@parcha/pi-transport";
import type { Manifest, PullReceipt } from "@parcha/pi-transport/sync";
import { type BoxEgress, type BoxNetwork, egressBlockedBy, forwarderStart, hostEgress, PROXY_ENV, relayFailed, runBoxAllowOf } from "./box-egress.js";
import { awaitImage, boxImageOf } from "./box-image.js";
import { RELAYED_KEY, relayedBox, relayFetch } from "./box-relay.js";
import { readJson, writeDurable } from "./files.js";
import { FAUX_ENV } from "./model.js";
import { agentWorkDir, BOX_WORK, type Place } from "./place.js";

/** The label a run's box carries: the run's id. */
export const RUN_LABEL = "agentrun.run";
/** And, on a box made with a network list, this one: the list's hash (netLabelOf). A box with none carries no such label,
 *  so its `docker run` is as it was. */
export const NET_LABEL = "agentrun.net";
/** The network label's value for a list. */
export const netLabelOf = (allow: readonly string[]): string => createHash("sha256").update(allow.join(",")).digest("hex").slice(0, 16);
/** And this one, the same on every run's box, which the start's sweep lists them by. */
export const KIND_LABEL = "agentrun.box";
/** The whole environment of a box's programs: a constant, never this process's. */
export const BOX_ENV: Readonly<Record<string, string>> = Object.freeze({ LANG: "C.UTF-8", HOME: "/tmp" });
/** How long a box lives whatever happens to the server: a bound on a leaked box, never its clean end. */
export const BOX_LIFETIME_MS = 24 * 60 * 60_000;
/** A bash command's timeout when the model names none. */
export const BASH_TIMEOUT_MS = 300_000;
/** The image a Docker box starts from (box-image.ts, where the server makes it ready). */
export { DEFAULT_DOCKER_IMAGE, DOCKER_IMAGE_ENV } from "./box-image.js";
/** The settings that bound a Docker box; unset, their defaults: enough for a build, and safe on a laptop, where one run's
 *  runaway build or fork bomb would otherwise starve everything else. */
export const BOX_CPUS_ENV = "AGENTRUN_BOX_CPUS";
export const BOX_MEMORY_ENV = "AGENTRUN_BOX_MEMORY";
export const BOX_PIDS_ENV = "AGENTRUN_BOX_PIDS";
/** 2 CPUs' time: a CFS quota (pi-transport's Docker provider), which holds whatever CPU count Docker's VM has. */
export const DEFAULT_BOX_CPUS = 2;
/** 4 GiB, swap included (--memory-swap the same). */
export const DEFAULT_BOX_MEMORY = "4g";
/** Processes and threads at once. */
export const DEFAULT_BOX_PIDS = 1024;

/** A Docker box's limits, as pi-transport's Docker provider takes them. */
export type BoxLimits = { cpus: number; memory: string; pidsLimit: number };

/** The fewest CPUs a quota gives: the kernel's least quota is 1 ms of each 100 ms period. A quota is also a whole number of
 *  µs, so a count too large for one (or a long string of digits, which reads as Infinity) is refused too. */
const MIN_BOX_CPUS = 0.01;
const MIB = 1024 * 1024;
/** A size's units as Docker reads them, each 1024 of the one before. */
const SIZE_UNITS: Readonly<Record<string, number>> = { b: 1, k: 1024, m: MIB, g: 1024 * MIB };
/** The least memory Docker gives a container. */
const MIN_BOX_MEMORY = 6 * MIB;
/** The most processes a cgroup may be given (the kernel's PID_MAX_LIMIT); above it, every create fails. */
const MAX_BOX_PIDS = 4_194_304;

/** A Docker box's limits from `env`: each setting's value, or its default when unset or empty. A value that is not one, or
 *  that every create would fail on (less than a 1 ms quota, less memory than Docker gives, more processes than the kernel
 *  allows), throws, naming its setting: the start checks them (startServe), so no run meets one. */
export function boxLimitsOf(env: NodeJS.ProcessEnv): BoxLimits {
  const read = (name: string, what: string, takes: (value: string) => boolean): string | undefined => {
    const value = env[name];
    if (!value) return undefined;
    if (!takes(value)) throw new Error(`${name} is ${what}; it is ${JSON.stringify(value)}`);
    return value;
  };
  const cpus = read(BOX_CPUS_ENV, "a number of CPUs of at least 0.01, such as 2 or 1.5", (value) => /^\d+(\.\d+)?$/.test(value) && Number(value) >= MIN_BOX_CPUS && Number.isSafeInteger(Math.round(Number(value) * 100_000)));
  const memory = read(BOX_MEMORY_ENV, "a size of at least 6m with its unit (b, k, m or g), such as 512m or 4g", (value) => {
    const size = /^(\d+(?:\.\d+)?)([bkmg])$/i.exec(value);
    // Its bytes as Docker reads them, and pi-transport's Docker provider: the number times the unit, the fraction dropped.
    const bytes = size ? Math.floor(Number(size[1]) * SIZE_UNITS[size[2].toLowerCase()]) : 0;
    return Number.isSafeInteger(bytes) && bytes >= MIN_BOX_MEMORY;
  });
  const pids = read(BOX_PIDS_ENV, "a whole number from 1 to 4194304, such as 1024", (value) => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= MAX_BOX_PIDS);
  return { cpus: cpus === undefined ? DEFAULT_BOX_CPUS : Number(cpus), memory: memory ?? DEFAULT_BOX_MEMORY, pidsLimit: pids === undefined ? DEFAULT_BOX_PIDS : Number(pids) };
}

/** The setting that names the hosts a box may reach: a comma list of hosts, each a name or `*.` and a name, which
 *  replaces the default list; `none` for no network at all. Unset or empty, the default. */
export const BOX_ALLOW_ENV = "AGENTRUN_BOX_ALLOW";
/** The hosts a box reaches when the setting names none: the package registries pip and npm (and yarn) install from, and
 *  GitHub for a clone or an archive. */
export const DEFAULT_BOX_ALLOW: readonly string[] = Object.freeze(["pypi.org", "files.pythonhosted.org", "registry.npmjs.org", "registry.yarnpkg.com", "github.com", "codeload.github.com"]);
/** The most hosts the list may hold: Daytona's own limit on a sandbox's domain list. */
export const MAX_BOX_ALLOW = 100;
/** A host name, or `*.` and one: letters, digits and hyphens in dotted labels, the last one starting with a letter, so no
 *  IP address is one. */
const ALLOW_HOST = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The hosts a box may reach, from `env`'s AGENTRUN_BOX_ALLOW: its list, lower-cased, each host once; the default list when
 *  unset or empty; `none` for no network. `*`, an IP address, a CIDR, a port, a URL, or more than 100 hosts throws, saying
 *  what the setting takes: the start checks it (startServe), so no run meets one. */
export function boxAllowOf(env: NodeJS.ProcessEnv): readonly string[] | "none" {
  const value = (env[BOX_ALLOW_ENV] ?? "").trim();
  if (!value) return DEFAULT_BOX_ALLOW;
  if (value.toLowerCase() === "none") return "none";
  const hosts = [...new Set(value.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean))];
  const takes = "a comma list of host names (such as pypi.org or *.pythonhosted.org), or none for no network";
  const bad = hosts.find((host) => !ALLOW_HOST.test(host));
  if (bad !== undefined) throw new Error(`${BOX_ALLOW_ENV} is ${takes}: ${JSON.stringify(bad)} is not a host name${bad === "*" ? " (a box never reaches every host)" : ""}`);
  if (hosts.length === 0) throw new Error(`${BOX_ALLOW_ENV} is ${takes}; it is ${JSON.stringify(value)}`);
  if (hosts.length > MAX_BOX_ALLOW) throw new Error(`${BOX_ALLOW_ENV} names ${hosts.length} hosts; it takes at most ${MAX_BOX_ALLOW}`);
  return Object.freeze(hosts);
}

/** What a server's Docker boxes reach, resolved once at its start: the setting's list (boxAllowOf) where egressBlockedBy
 *  (box-egress.ts) finds the daemon is this Linux machine's own, else none with the reason; `none` from the setting, with
 *  it as the reason. */
export async function boxNetworkOf(env: NodeJS.ProcessEnv, options: Parameters<typeof egressBlockedBy>[1] = {}): Promise<BoxNetwork> {
  const allow = boxAllowOf(env);
  if (allow === "none") return { allow: "none", reason: `${BOX_ALLOW_ENV} is none` };
  const blocked = await egressBlockedBy(env, options);
  return blocked ? { allow: "none", reason: blocked } : { allow };
}

/** Under `--faux` only: a module whose default export, given the data root, is the provider runs' boxes come from in
 *  place of Docker (the tests' faux box). */
export const FAUX_BOX_ENV = "AGENTRUN_SERVE_FAUX_BOX";

/** A remote box's sync mark in its run's directory: the box's id and the listing its seed or last pull left. The
 *  server alone writes it. */
export const BOX_SYNC_FILE = "box-sync.json";
/** What the run's process copied into its remote box after the seed (a file its host tools filed in work/): one JSON line
 *  per file, `{path, sha256, bytes}`, appended by that process alone. The mark has one writer, the server, so the
 *  process never writes it; a pull folds these lines into the mark it compares against, for paths the mark lacks, so
 *  the box's later edit of such a file comes back instead of reading as a change the server made. */
export const BOX_MIRRORED_FILE = "box-mirrored.jsonl";

type Mount = NonNullable<BoxSpec["mounts"]>[number];

/** `source`, when it is below `root` through no link and is its own canonical path; else a refusal naming the link.
 *  `root`, the data root, is canonical already (startServe), so a link above it is the operator's choice. */
export async function mountSource(root: string, source: string): Promise<string> {
  const below = relative(root, source);
  if (!below || below.startsWith("..") || isAbsolute(below)) throw new Error(`the mount source ${source} is not below the data root ${root}`);
  let at = root;
  for (const part of below.split(sep)) {
    at = join(at, part);
    if ((await lstat(at)).isSymbolicLink()) throw new Error(`the mount source ${source} is refused: ${at} is a link`);
  }
  if ((await realpath(source)) !== source) throw new Error(`the mount source ${source} is refused: it is not its own canonical path`);
  return source;
}

/** Every mount a run's box gets, each through mountSource: its work/ only, read-write, at BOX_WORK. A run's home joins
 *  this list (read-only parts included) when it comes; nothing else of the data root does. */
export async function boxMounts(root: string, runDir: string, place: Place): Promise<Mount[]> {
  return [{ source: await mountSource(root, join(runDir, "work")), target: agentWorkDir(runDir, place) }];
}

/** The provider runs' boxes come from, what a create of its box waits on first (`ready`, run-box below), and, for a box
 *  that reaches the server's host list, where it finds its egress proxy (`egress`, box-egress.ts). */
export type RunBoxes = BoxProvider & { ready?: BoxReady; egress?: BoxEgress; net?: string };

/** The provider runs' boxes come from: under `--faux` with a faux box, its module's; else Docker on this machine, run as
 *  this process's user (serve's: a run's process is its child), so what a box writes in work/ stays serve's, within the
 *  box limits the server's settings give (boxLimitsOf), and whose create first waits while the server pulls its image
 *  (box-image.ts). */
export async function runBoxProvider(place: Place, env: NodeJS.ProcessEnv, root: string): Promise<RunBoxes> {
  const faux = env[FAUX_ENV] ? env[FAUX_BOX_ENV] : undefined;
  if (faux) return fauxBoxes(faux, root);
  if (place.mode !== "sandbox" || place.box !== "docker") throw new Error(`runs in the ${place.mode === "sandbox" ? place.box : "runner"} place have no box`);
  const { dockerBoxes } = await import("@parcha/pi-transport/box/docker");
  const user = process.getuid && process.getgid ? `${process.getuid()}:${process.getgid()}` : undefined;
  // With no capability and no way to gain one (no program in a run's box changes user): as root (serve run as uid 0) a
  // box could otherwise make a device node in work/.
  const image = boxImageOf(env);
  // The list the server resolved for this run's box (box-egress.ts boxNetworkOf), or none.
  const allow = runBoxAllowOf(env);
  return {
    ...dockerBoxes({ image, ...(user ? { user } : {}), ...boxLimitsOf(env), dropCapabilities: true }),
    ready: (context, note) => awaitImage(root, image, context, note),
    // Where the proxy runs: the one line that picks it (box-egress.ts BoxEgress).
    ...(allow === "none" ? {} : { egress: hostEgress(allow, env, egressLog), net: netLabelOf(allow) }),
  };
}

/** What a run's box create waits on first, `note` taking its one timeline row: the server's pull of the Docker image
 *  (box-image.ts). A faux box has no image, so none. */
export type BoxReady = (context: Context, note: (summary: string) => Promise<void> | void) => Promise<void>;

/** The tests' faux box provider, from its module. */
export const fauxBoxes = async (module: string, root: string): Promise<BoxProvider> =>
  ((await import(pathToFileURL(module).href)) as { default: (root: string) => BoxProvider }).default(root);

/** A run's box, as its tools' environment: found by its label or made on the first call, once; made again on the call
 *  after it was lost. A box that cannot be had fails that call; nothing falls back to this machine. Before a local box is
 *  made, its provider's `ready` is waited on (its image), and the call that opens it gives the `note` for its timeline
 *  row; a remote box is the server's to make (ensureRemoteBox), and never waits on that. `mirror`, on a remote box: copies
 *  a file the run's host tools filed in work/ (at `path`, relative to it) into the box, now when the box is open, else at
 *  its open. */
export type RunBox = { env(context: Context, note?: (summary: string) => Promise<void> | void): Promise<ExecutionEnv>; hostWork: string; bound(): Promise<boolean>; leftEnded(context: Context): Promise<void>; mirror?: (path: string, data: string | Uint8Array) => Promise<void> };

/** Where a run's box comes from: a provider of this process's own (Docker, or the tests' faux box), or, for a remote box,
 *  the server's relay in data root `relay`. A bare function is a provider of this process's own. */
export type BoxSource = { provider: () => Promise<RunBoxes> } | { relay: string };

export function runBox(given: BoxSource | (() => Promise<RunBoxes>), run: { id: string; root: string; dir: string; place: Place }): RunBox {
  const source: BoxSource = typeof given === "function" ? { provider: given } : given;
  let held: Promise<{ env: ExecutionEnv; box: Box }> | undefined;
  // What the host tools filed while no box was open in this process: a box a process before it made has no seed now, so
  // these go in when it opens (and to a new box, whose seed carries them anyway, again: the same bytes).
  const filed = new Map<string, Uint8Array>();
  const open = async (context: Context, note: (summary: string) => Promise<void> | void): Promise<{ env: ExecutionEnv; box: Box }> => {
    const { boxEnv, endLeftCommands } = await import("@parcha/pi-transport/hands");
    const { box, made } = "relay" in source ? await relayedRunBox(source.relay, run.dir, run.id, context) : await localRunBox(await source.provider(), run, context, note);
    if (!made) {
      // A process before this one left it: what it still runs is killed first, since its calls were answered interrupted.
      const ended = await endLeftCommands(box, context);
      if (!ended.ok) throw new Error(`the run's box could not be taken over: ${ended.error.message}`);
    }
    if (filed.size) {
      const queued = [...filed];
      filed.clear();
      const sent = await box.upload(queued.map(([path, bytes]) => ({ path: posix.join(BOX_WORK, path), bytes })), context);
      if (!sent.ok) mirrorFailed(queued.map(([path]) => path).join(", "), sent.error);
      else for (const [path, bytes] of queued) await mirrored(run.dir, path, bytes);
    }
    return { box, env: boxEnv(box, { maxExecMs: BASH_TIMEOUT_MS, onLost: () => void (held = undefined) }) as unknown as ExecutionEnv };
  };
  const opened = (context: Context, note: (summary: string) => Promise<void> | void = () => undefined) => {
    held ??= open(context, note).catch((error: unknown) => {
      held = undefined;
      throw error;
    });
    return held;
  };
  let binds: Promise<boolean> | undefined;
  let checked: Promise<void> | undefined;
  const env = async (context: Context, note?: (summary: string) => Promise<void> | void): Promise<ExecutionEnv> => (await opened(context, note)).env;
  return {
    // The bind's source, or what a remote box is seeded from: a path another harness names under it is the same file in
    // the box (coding-tools.ts boxPath).
    hostWork: join(run.dir, "work"),
    env,
    // Whether the provider binds it (BoxProvider.mounts): then the file tools may work on it here (bound-files.ts). A
    // remote box binds nothing.
    bound() {
      if ("relay" in source) return Promise.resolve(false);
      const provider = source.provider;
      binds ??= provider().then((boxes) => boxes.mounts === true, (error: unknown) => {
        binds = undefined;
        throw error;
      });
      return binds;
    },
    // Before a file tool works on work/ here, once a process: a box an earlier process of the run left may still run a
    // command that changes work/, so that box is taken over (env: its left commands killed first). None, none is made.
    // A remote box's file tools never work here.
    leftEnded(context) {
      if ("relay" in source) return Promise.resolve();
      const provider = source.provider;
      checked ??= (async () => {
        if (held) return void (await held);
        const listed = await (await provider()).list({ [RUN_LABEL]: run.id }, context);
        if (!listed.ok) throw listed.error;
        if (listed.value.length) await env(context);
      })().catch((error: unknown) => {
        checked = undefined;
        throw error;
      });
      return checked;
    },
    ...("relay" in source
      ? {
          // An open (or opening) box is written now; with none, the file waits for the box's open.
          mirror: async (path: string, data: string | Uint8Array) => {
            const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
            const box = held && (await held.catch(() => undefined))?.box;
            if (!box) return void filed.set(path, bytes);
            const sent = await box.upload([{ path: posix.join(BOX_WORK, path), bytes }], BACKGROUND);
            if (!sent.ok) throw sent.error;
            await mirrored(run.dir, path, bytes);
          },
        }
      : {}),
  };
}

/** Notes in BOX_MIRRORED_FILE that `bytes` at `path` (below work/) went into the run's box: one appended line. */
async function mirrored(runDir: string, path: string, bytes: Uint8Array): Promise<void> {
  const line = { path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  await appendFile(join(runDir, BOX_MIRRORED_FILE), `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

/** `mark` with each file the run's process mirrored into the box since (BOX_MIRRORED_FILE) that it lacks: as the bytes
 *  both sides held, so the box's edit of it is a change to fetch and this machine's copy is not a change of its own. */
async function withMirrored(runDir: string, mark: Manifest): Promise<Manifest> {
  const text = await readFile(join(runDir, BOX_MIRRORED_FILE), "utf8").catch(() => "");
  const held = new Set(mark.entries.map((entry) => entry.path));
  const added = new Map<string, Manifest["entries"][number]>();
  for (const line of text.split("\n")) {
    let entry: { path?: unknown; sha256?: unknown; bytes?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry.path !== "string" || typeof entry.sha256 !== "string" || typeof entry.bytes !== "number" || held.has(entry.path)) continue;
    // The newest line for a path wins; its listed fields never match the box's, so the pull lists it as changed.
    added.set(entry.path, { path: entry.path, kind: "file", bytes: entry.bytes, sha256: entry.sha256, mode: 0o644, mtime: "0" });
  }
  if (!added.size) return mark;
  const entries = [...mark.entries, ...added.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) };
}

/** Said in the run's process log: a file the host tools filed in work/ that its remote box did not get. */
function mirrorFailed(paths: string, error: Error): void {
  process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), event: "box_mirror_failed", message: `${paths} filed in work/ but not copied into the run's box: ${error.message}` })}\n`);
}

/** Said in the run's process log: one of its egress proxy's decisions (the host, port, address and class). */
const egressLog = (line: string): void => void process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), event: "box_egress", line })}\n`);

/** A box of this process's provider: the run's, by its label, or one made now with work/ bound, once its image is in
 *  (the provider's `ready`, `note` writing the one timeline row while it is built or pulled). A box that reaches the
 *  server's host list has the run's egress proxy started first, its directory bound read-only and the proxy variables
 *  in its environment, and, made or found, its relay started (startRelay). */
async function localRunBox(boxes: RunBoxes, run: { id: string; root: string; dir: string; place: Place }, context: Context, note: (summary: string) => Promise<void> | void): Promise<{ box: Box; made: boolean }> {
  let egress: Awaited<ReturnType<BoxEgress>> | undefined;
  try {
    egress = boxes.egress ? await boxes.egress(run.id) : undefined;
  } catch (error) {
    throw new Error(`the run's box could not have its network: ${(error as Error).message}`);
  }
  // A box a process before this one made with another network (none, or another list: the server's setting changed
  // since) is made again: its mounts and environment are fixed at its create. Its work/ is this machine's, bound.
  await destroyListed(boxes, { [RUN_LABEL]: run.id }, (labels) => labels[NET_LABEL] !== boxes.net, context);
  const found = await attachRunBox(boxes, run.id, context);
  if (found) {
    if (egress) await startRelay(found, egress.socket, context, note);
    return { box: found, made: false };
  }
  // A box made while the server builds or pulls its image waits for the image, not for a `docker run` that pulls it.
  if (boxes.ready) {
    try {
      await boxes.ready(context, note);
    } catch (error) {
      if (context.abortSignal?.aborted) throw error;
      throw new Error(`the run's box could not be made: ${(error as Error).message}`);
    }
  }
  // Docker's network stays none either way: the box's only way out is the proxy's socket, which checks everything.
  const spec: BoxSpec = {
    env: egress ? { ...BOX_ENV, ...PROXY_ENV } : BOX_ENV, workspace: agentWorkDir(run.dir, run.place),
    mounts: [...(await boxMounts(run.root, run.dir, run.place)), ...(egress ? [egress.mount] : [])],
    labels: { [RUN_LABEL]: run.id, [KIND_LABEL]: "run", ...(boxes.net ? { [NET_LABEL]: boxes.net } : {}) }, network: "none", maxLifetimeMs: BOX_LIFETIME_MS,
  };
  const made = await boxes.create(spec, context);
  if (!made.ok) {
    // A create that failed may still have left a box (a client cut off while the daemon made it): it carries the label.
    await destroyRunBoxes(boxes, run.id, context).catch(() => undefined);
    throw new Error(`the run's box could not be made: ${made.error.message}`);
  }
  if (egress) await startRelay(made.value, egress.socket, context, note);
  return { box: made.value, made: true };
}

/** The box's relay to its proxy's `socket` (box-egress.ts forwarder), started in the background and answered once it
 *  listens. One that cannot start (an image with no socat or setsid, or a relay not listening in time) leaves the box with
 *  no network, nothing listening on its proxy port, and the run's timeline says why (`note`). */
async function startRelay(box: Box, socket: string, context: Context, note: (summary: string) => Promise<void> | void): Promise<void> {
  const started = await box.exec(forwarderStart(socket), undefined, context);
  if (!started.ok) throw new Error(`the run's box could not start its network relay: ${started.error.message}`);
  let said = "";
  const drain = async (stream: AsyncIterable<Uint8Array>, keep: boolean) => {
    for await (const chunk of stream) if (keep && said.length < 1000) said += new TextDecoder().decode(chunk);
  };
  const [ended] = await Promise.all([started.value.wait(), drain(started.value.stdout, false), drain(started.value.stderr, true)]);
  if (!ended.ok) throw new Error(`the run's box could not start its network relay: ${ended.error.message}`);
  if (ended.value !== 0) await Promise.resolve(note(relayFailed(ended.value, said))).catch(() => undefined);
}

/** A remote box, which the server finds or makes and seeds (ensureRemoteBox), reached through its relay: this process's
 *  Daytona provider holds no key, and every call it makes goes to the relay, which sends it on with the server's. */
async function relayedRunBox(root: string, runDir: string, runId: string, context: Context): Promise<{ box: Box; made: boolean }> {
  const given = await relayedBox(root, runDir, runId, context.abortSignal);
  const { daytonaBoxes } = await import("@parcha/pi-transport/box/daytona");
  const boxes = daytonaBoxes({ apiKey: RELAYED_KEY, apiUrl: given.apiUrl, fetch: relayFetch(root, runDir, runId) });
  const attached = await boxes.attach(given.id, context);
  if (!attached.ok) throw new Error(`the run's box could not be reached: ${attached.error.message}`);
  if (!attached.value) throw new Error(`the run's box ${given.id} is not running`);
  return { box: attached.value, made: given.made };
}

/** The spec of a run's remote box: its work/ comes with its seed, never a mount. */
const remoteSpec = (runId: string): BoxSpec => ({
  env: BOX_ENV, workspace: BOX_WORK, labels: { [RUN_LABEL]: runId, [KIND_LABEL]: "run" }, network: "none", maxLifetimeMs: BOX_LIFETIME_MS,
});

type SyncMark = { box: string; mark: Manifest };
const markOf = async (runDir: string): Promise<SyncMark | undefined> => {
  const kept = (await readJson(join(runDir, BOX_SYNC_FILE))) as Partial<SyncMark> | null;
  return typeof kept?.box === "string" && kept.mark && Array.isArray(kept.mark.entries) ? (kept as SyncMark) : undefined;
};
const keepMark = (runDir: string, mark: SyncMark) => writeDurable(join(runDir, BOX_SYNC_FILE), `${JSON.stringify(mark)}\n`);

/** The server's side of a remote box: run `run`'s box, found by its label or made, with its work/ seeded once (its mark
 *  says so); its id, and whether it was made now. A found box whose network is not closed is destroyed and made again;
 *  a box whose seed fails is destroyed, and the call fails. */
export async function ensureRemoteBox(boxes: BoxProvider, run: { id: string; dir: string }, context: Context, wake?: () => Promise<number>): Promise<{ id: string; made: boolean }> {
  let box = await runningRunBox(boxes, run.id, context, wake);
  let made = false;
  if (box && box.facts().network !== "none") {
    await destroyRunBoxes(boxes, run.id, context);
    box = undefined;
  }
  if (!box) {
    const created = await boxes.create(remoteSpec(run.id), context);
    if (!created.ok) {
      await destroyRunBoxes(boxes, run.id, context).catch(() => undefined);
      throw new Error(`the run's box could not be made: ${created.error.message}`);
    }
    box = created.value;
    made = true;
    if (box.facts().network !== "none") {
      await box.destroy(context);
      throw new Error("the run's box was made with its network open, so it is not used");
    }
  }
  // A box found without its seed's mark was made by a server that went down before it seeded it: seeded now.
  if ((await markOf(run.dir))?.box !== box.id) {
    const { seedDir } = await import("@parcha/pi-transport/sync");
    const seeded = await seedDir(box, { from: join(run.dir, "work"), to: BOX_WORK }, context);
    if (!seeded.ok) {
      await box.destroy(context).catch(() => undefined);
      throw new Error(`the run's files could not be copied into its box: ${seeded.error.message}`);
    }
    await keepMark(run.dir, { box: box.id, mark: seeded.value.mark });
  }
  return { id: box.id, made };
}

/** What a pull of a remote box brought back; undefined when the run has no box (none made, or it is gone). */
export type RemotePull = { -readonly [K in "changed" | "files" | "bytes" | "removed"]: PullReceipt[K] };

/** A pull that did not bring the box's work/ back whole: what it wrote is kept, with its mark, and the box must stay.
 *  `lasting`: a stop another pull will meet again (an archive the extractor cannot read, or a limit a pull that wrote
 *  nothing reached); else the copy failed, and a later pull may land. */
export class PullIncomplete extends Error {
  readonly lasting: boolean;
  /** The box that keeps what did not come back. */
  readonly box: string;
  constructor(message: string, lasting: boolean, box: string) {
    super(message);
    this.lasting = lasting;
    this.box = box;
  }
}

/** How many pulls one copy back takes at most: each pull past a limit brings the next part, up to the limit again. */
const PULL_ROUNDS = 8;

/** The server's side of a remote box: what changed in the box's work/ since its mark, pulled into the run's work/ by the
 *  safe extractor (nothing outside work/, no link, safe names only). A file this machine changed since the mark stays
 *  (`if_unchanged`), and what the box removed is removed here too. A pull a limit stopped after it wrote something is
 *  followed by another, which asks only for the rest. Throws when the copy fails (the mark kept), and PullIncomplete when
 *  it is not whole: a caller then keeps the box. */
export async function pullRemoteBox(boxes: BoxProvider, run: { id: string; dir: string }, context: Context, wake?: () => Promise<number>): Promise<RemotePull | undefined> {
  const box = await runningRunBox(boxes, run.id, context, wake);
  if (!box) return undefined;
  const { pullDir } = await import("@parcha/pi-transport/sync");
  const total: RemotePull = { changed: 0, files: 0, bytes: 0, removed: 0 };
  for (let round = 1; ; round++) {
    const kept = await markOf(run.dir);
    const since = kept?.box === box.id ? await withMirrored(run.dir, kept.mark) : undefined;
    const pulled = await pullDir(box, { from: BOX_WORK, to: join(run.dir, "work"), ...(since ? { since } : {}), mirrorDeletes: true, overwrite: "if_unchanged" }, context);
    if (!pulled.ok) throw new Error(`the run's files could not be copied back from its box: ${pulled.error.message}`);
    // What it wrote is whole and in the mark, a stopped pull's too: the next pull asks only for the rest.
    await keepMark(run.dir, { box: box.id, mark: pulled.value.mark });
    const { changed, files, directories, bytes, removed, stopped } = pulled.value;
    if (round === 1) total.changed = changed;
    total.files += files;
    total.bytes += bytes;
    total.removed += removed;
    if (!stopped) return total;
    const wrote = files + directories + removed > 0;
    if (stopped.reason === "copy_failed") throw new PullIncomplete(`the copy back from the run's box stopped: ${stopped.message}`, false, box.id);
    if (stopped.reason === "malformed" || !wrote || round >= PULL_ROUNDS) throw new PullIncomplete(`the copy back from the run's box stopped (${stopped.reason}): ${stopped.message}`, true, box.id);
  }
}

/** The running box labelled with run `runId`; with none running, one `wake` started (Daytona stopped or paused it), else none. */
async function runningRunBox(boxes: BoxProvider, runId: string, context: Context, wake?: () => Promise<number>): Promise<Box | undefined> {
  const box = await attachRunBox(boxes, runId, context);
  if (box || !wake || (await wake()) === 0) return box;
  return attachRunBox(boxes, runId, context);
}

/** The running box labelled with run `runId`, if any. */
async function attachRunBox(boxes: BoxProvider, runId: string, context: Context): Promise<Box | undefined> {
  const listed = await boxes.list({ [RUN_LABEL]: runId }, context);
  if (!listed.ok) throw listed.error;
  for (const ref of listed.value) {
    const attached = await boxes.attach(ref.id, context);
    if (!attached.ok) throw attached.error;
    if (attached.value) return attached.value;
  }
  return undefined;
}

/** Destroys every box labelled with run `runId`; how many it destroyed. */
export async function destroyRunBoxes(boxes: BoxProvider, runId: string, context: Context): Promise<number> {
  return destroyListed(boxes, { [RUN_LABEL]: runId }, () => true, context);
}

/** The start's sweep: destroys every run's box whose run `ended` says is over, once `before` (a remote box's pull) for its
 *  run says it may go. A box of a run this server does not know is left to its lifetime: another server's, or one being
 *  made. */
export async function sweepRunBoxes(boxes: BoxProvider, ended: (runId: string) => boolean, context: Context, before?: (runId: string, boxId: string) => Promise<boolean>): Promise<number> {
  return destroyListed(boxes, { [KIND_LABEL]: "run" }, (labels) => typeof labels[RUN_LABEL] === "string" && ended(labels[RUN_LABEL]), context, before);
}

async function destroyListed(boxes: BoxProvider, labels: Record<string, string>, pick: (labels: Readonly<Record<string, string>>) => boolean, context: Context, before?: (runId: string, boxId: string) => Promise<boolean>): Promise<number> {
  const listed = await boxes.list(labels, context);
  if (!listed.ok) throw listed.error;
  let destroyed = 0;
  for (const ref of listed.value.filter((r) => pick(r.labels))) {
    const box = await boxes.attach(ref.id, context);
    if (!box.ok) throw box.error;
    if (!box.value) continue;
    if (before && !(await before(ref.labels[RUN_LABEL]!, ref.id))) continue;
    const gone = await box.value.destroy(context);
    if (!gone.ok) throw gone.error;
    destroyed++;
  }
  return destroyed;
}
