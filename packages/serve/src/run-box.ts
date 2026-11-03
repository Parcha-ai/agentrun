// A sandbox run's box: one per run, made on its first tool call and labelled with the run's id, so the label is the
// record. A run's process that starts again finds it by that label and first kills the commands the process before it
// left running. Serve destroys it at every settle (a cancel included) and at archive, and its start sweeps the boxes of
// runs that have ended. A box gets the run's work/ only, bound at BOX_WORK, a fixed environment (never this process's,
// so no key or token enters it), no network, this server's user, and limits on its CPUs, memory and processes. pi-transport
// is an optional peer of this package: it is loaded only for a run whose place is a box.
import { lstat, realpath } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Box, BoxProvider, BoxSpec } from "@parcha/pi-transport";
import { FAUX_ENV } from "./model.js";
import { agentWorkDir, type Place } from "./place.js";

/** The label a run's box carries: the run's id. */
export const RUN_LABEL = "agentrun.run";
/** And this one, the same on every run's box, which the start's sweep lists them by. */
export const KIND_LABEL = "agentrun.box";
/** The whole environment of a box's programs: a constant, never this process's. */
export const BOX_ENV: Readonly<Record<string, string>> = Object.freeze({ LANG: "C.UTF-8", HOME: "/tmp" });
/** How long a box lives whatever happens to the server: a bound on a leaked box, never its clean end. */
export const BOX_LIFETIME_MS = 24 * 60 * 60_000;
/** A bash command's timeout when the model names none. */
export const BASH_TIMEOUT_MS = 300_000;
/** The image a Docker box starts from. */
export const DOCKER_IMAGE_ENV = "AGENTRUN_DOCKER_IMAGE";
export const DEFAULT_DOCKER_IMAGE = "debian:bookworm-slim";
/** The settings that bound a Docker box, each a value or `none` for no limit; unset, their defaults: enough for a build,
 *  and safe on a laptop, where one run's runaway build or fork bomb would otherwise starve everything else. */
export const BOX_CPUS_ENV = "AGENTRUN_BOX_CPUS";
export const BOX_MEMORY_ENV = "AGENTRUN_BOX_MEMORY";
export const BOX_PIDS_ENV = "AGENTRUN_BOX_PIDS";
/** 2 CPUs, or this machine's count when it has fewer: Docker refuses more CPUs than it has. */
export const DEFAULT_BOX_CPUS = 2;
/** 4 GiB, swap included (--memory-swap the same). */
export const DEFAULT_BOX_MEMORY = "4g";
/** Processes and threads at once. */
export const DEFAULT_BOX_PIDS = 1024;

/** A Docker box's limits, as pi-transport's Docker provider takes them; an absent one is no limit. */
export type BoxLimits = { cpus?: number; memory?: string; pidsLimit?: number };

const MIB = 1024 * 1024;
/** A size's units as Docker reads them, each 1024 of the one before. */
const SIZE_UNITS: Readonly<Record<string, number>> = { b: 1, k: 1024, m: MIB, g: 1024 * MIB };
/** The least memory Docker gives a container. */
const MIN_BOX_MEMORY = 6 * MIB;

/** A Docker box's limits from `env`: each setting's value, `none` for no limit, or its default when unset or empty (the
 *  CPUs' lowered to `cpusHere`, this machine's count). A value Docker would refuse at a box's create (more CPUs than this
 *  machine has, less memory than Docker gives) is refused here, with any value that is not one, naming its setting: the
 *  start checks them (startServe), so no run meets one. */
export function boxLimitsOf(env: NodeJS.ProcessEnv, cpusHere = availableParallelism()): BoxLimits {
  const read = (name: string, what: string, takes: (value: string) => boolean): string | undefined | null => {
    const value = env[name];
    if (!value) return undefined;
    if (value === "none") return null;
    if (!takes(value)) throw new Error(`${name} is ${what}, or none for no limit; it is ${JSON.stringify(value)}`);
    return value;
  };
  const cpus = read(BOX_CPUS_ENV, `a number of CPUs above 0 and at most this machine's ${cpusHere}, such as 2 or 1.5`, (value) => /^\d+(\.\d+)?$/.test(value) && Number(value) > 0 && Number(value) <= cpusHere);
  const memory = read(BOX_MEMORY_ENV, "a size of at least 6m with its unit (b, k, m or g), such as 512m or 4g", (value) => {
    const size = /^(\d+(?:\.\d+)?)([bkmg])$/i.exec(value);
    // Its bytes as Docker reads them, and pi-transport's Docker provider: the number times the unit, the fraction dropped.
    const bytes = size ? Math.floor(Number(size[1]) * SIZE_UNITS[size[2].toLowerCase()]) : 0;
    return Number.isSafeInteger(bytes) && bytes >= MIN_BOX_MEMORY;
  });
  const pids = read(BOX_PIDS_ENV, "a whole number above 0, such as 1024", (value) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0);
  return {
    ...(cpus === null ? {} : { cpus: cpus === undefined ? Math.min(DEFAULT_BOX_CPUS, cpusHere) : Number(cpus) }),
    ...(memory === null ? {} : { memory: memory ?? DEFAULT_BOX_MEMORY }),
    ...(pids === null ? {} : { pidsLimit: pids === undefined ? DEFAULT_BOX_PIDS : Number(pids) }),
  };
}

/** Under `--faux` only: a module whose default export, given the data root, is the provider runs' boxes come from in
 *  place of Docker (the tests' faux box). */
export const FAUX_BOX_ENV = "AGENTRUN_SERVE_FAUX_BOX";

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

/** The provider runs' boxes come from: under `--faux` with a faux box, its module's; else Docker on this machine, run as
 *  this process's user (serve's: a run's process is its child), so what a box writes in work/ stays serve's, within the
 *  box limits the server's settings give (boxLimitsOf). */
export async function runBoxProvider(place: Place, env: NodeJS.ProcessEnv, root: string): Promise<BoxProvider> {
  const faux = env[FAUX_ENV] ? env[FAUX_BOX_ENV] : undefined;
  if (faux) return fauxBoxes(faux, root);
  if (place.mode !== "sandbox" || place.box !== "docker") throw new Error(`runs in the ${place.mode === "sandbox" ? place.box : "runner"} place have no box`);
  const { dockerBoxes } = await import("@parcha/pi-transport/box/docker");
  const user = process.getuid && process.getgid ? `${process.getuid()}:${process.getgid()}` : undefined;
  return dockerBoxes({ image: env[DOCKER_IMAGE_ENV] || DEFAULT_DOCKER_IMAGE, ...(user ? { user } : {}), ...boxLimitsOf(env) });
}

/** The tests' faux box provider, from its module. */
export const fauxBoxes = async (module: string, root: string): Promise<BoxProvider> =>
  ((await import(pathToFileURL(module).href)) as { default: (root: string) => BoxProvider }).default(root);

/** A run's box, as its tools' environment: found by its label or made on the first call, once; made again on the call
 *  after it was lost. A box that cannot be had fails that call; nothing falls back to this machine. */
export type RunBox = { env(context: Context): Promise<ExecutionEnv>; hostWork: string };

export function runBox(provider: () => Promise<BoxProvider>, run: { id: string; root: string; dir: string; place: Place }): RunBox {
  let held: Promise<ExecutionEnv> | undefined;
  const open = async (context: Context): Promise<ExecutionEnv> => {
    const boxes = await provider();
    const { boxEnv, endLeftCommands } = await import("@parcha/pi-transport/hands");
    let box = await attachRunBox(boxes, run.id, context);
    if (box) {
      // A process before this one left it: what it still runs is killed first, since its calls were answered interrupted.
      const ended = await endLeftCommands(box, context);
      if (!ended.ok) throw new Error(`the run's box could not be taken over: ${ended.error.message}`);
    } else {
      const spec: BoxSpec = {
        env: BOX_ENV, workspace: agentWorkDir(run.dir, run.place), mounts: await boxMounts(run.root, run.dir, run.place),
        labels: { [RUN_LABEL]: run.id, [KIND_LABEL]: "run" }, network: "none", maxLifetimeMs: BOX_LIFETIME_MS,
      };
      const made = await boxes.create(spec, context);
      if (!made.ok) {
        // A create that failed may still have left a box (a client cut off while the daemon made it): it carries the label.
        await destroyRunBoxes(boxes, run.id, context).catch(() => undefined);
        throw new Error(`the run's box could not be made: ${made.error.message}`);
      }
      box = made.value;
    }
    return boxEnv(box, { maxExecMs: BASH_TIMEOUT_MS, onLost: () => void (held = undefined) }) as unknown as ExecutionEnv;
  };
  return {
    // The bind's source: a path another harness names under it is the same file in the box (coding-tools.ts boxPath).
    hostWork: join(run.dir, "work"),
    env(context) {
      held ??= open(context).catch((error: unknown) => {
        held = undefined;
        throw error;
      });
      return held;
    },
  };
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

/** The start's sweep: destroys every run's box whose run `ended` says is over. A box of a run this server does not know
 *  is left to its lifetime: another server's, or one being made. */
export async function sweepRunBoxes(boxes: BoxProvider, ended: (runId: string) => boolean, context: Context): Promise<number> {
  return destroyListed(boxes, { [KIND_LABEL]: "run" }, (labels) => typeof labels[RUN_LABEL] === "string" && ended(labels[RUN_LABEL]), context);
}

async function destroyListed(boxes: BoxProvider, labels: Record<string, string>, pick: (labels: Readonly<Record<string, string>>) => boolean, context: Context): Promise<number> {
  const listed = await boxes.list(labels, context);
  if (!listed.ok) throw listed.error;
  let destroyed = 0;
  for (const ref of listed.value.filter((r) => pick(r.labels))) {
    const box = await boxes.attach(ref.id, context);
    if (!box.ok) throw box.error;
    if (!box.value) continue;
    const gone = await box.value.destroy(context);
    if (!gone.ok) throw gone.error;
    destroyed++;
  }
  return destroyed;
}
