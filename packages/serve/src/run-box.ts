// A sandbox run's box: one per run, made on the first call that runs in it and labelled with the run's id, so the label
// is the record (a bound box's read, write and edit run on this machine: bound-files.ts). A run's process that starts
// again finds it by that label and first kills the commands the process before it left running. Serve destroys it at
// every settle (a cancel included) and at archive, and its start sweeps the boxes of runs that have ended. A box gets the
// run's work/ only, at BOX_WORK, a fixed environment (never this process's, so no key or token enters it) and no network.
// pi-transport is an optional peer of this package: it is loaded only for a run whose place is a box.
//
// Docker's box is made here, in the run's process, as this server's user, with work/ bound. A Daytona box is remote: it
// cannot bind work/, and its key is the server's alone. The server makes it (through the box relay, box-relay.ts), seeds
// it with work/, pulls work/ back at each turn's end and once more before the run's end is recorded, and destroys it
// after that pull; the run's process reaches it through the relay, which holds the key. What the run's own host tools
// file in work/ meanwhile (writeInWork) is copied into the box too, so its tools read it.
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as BACKGROUND } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Box, BoxProvider, BoxSpec } from "@parcha/pi-transport";
import type { Manifest, PullReceipt } from "@parcha/pi-transport/sync";
import { RELAYED_KEY, relayedBox, relayFetch } from "./box-relay.js";
import { readJson, writeDurable } from "./files.js";
import { FAUX_ENV } from "./model.js";
import { agentWorkDir, BOX_WORK, type Place } from "./place.js";

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
/** Under `--faux` only: a module whose default export, given the data root, is the provider runs' boxes come from in
 *  place of Docker (the tests' faux box). */
export const FAUX_BOX_ENV = "AGENTRUN_SERVE_FAUX_BOX";

/** A remote box's sync mark in its run's directory: the box's id and the listing its seed or last pull left. */
export const BOX_SYNC_FILE = "box-sync.json";

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
 *  this process's user (serve's: a run's process is its child), so what a box writes in work/ stays serve's. */
export async function runBoxProvider(place: Place, env: NodeJS.ProcessEnv, root: string): Promise<BoxProvider> {
  const faux = env[FAUX_ENV] ? env[FAUX_BOX_ENV] : undefined;
  if (faux) return fauxBoxes(faux, root);
  if (place.mode !== "sandbox" || place.box !== "docker") throw new Error(`runs in the ${place.mode === "sandbox" ? place.box : "runner"} place have no box`);
  const { dockerBoxes } = await import("@parcha/pi-transport/box/docker");
  const user = process.getuid && process.getgid ? `${process.getuid()}:${process.getgid()}` : undefined;
  // With no capability and no way to gain one (no program in a run's box changes user): as root (serve run as uid 0) a
  // box could otherwise make a device node in work/.
  return dockerBoxes({ image: env[DOCKER_IMAGE_ENV] || DEFAULT_DOCKER_IMAGE, ...(user ? { user } : {}), dropCapabilities: true });
}

/** The tests' faux box provider, from its module. */
export const fauxBoxes = async (module: string, root: string): Promise<BoxProvider> =>
  ((await import(pathToFileURL(module).href)) as { default: (root: string) => BoxProvider }).default(root);

/** A run's box, as its tools' environment: found by its label or made on the first call, once; made again on the call
 *  after it was lost. A box that cannot be had fails that call; nothing falls back to this machine. `mirror`, on a remote
 *  box: copies a file the run's host tools filed in work/ (at `path`, relative to it) into the box, now when the box is open,
 *  else at its open. */
export type RunBox = { env(context: Context): Promise<ExecutionEnv>; hostWork: string; bound(): Promise<boolean>; leftEnded(context: Context): Promise<void>; mirror?: (path: string, data: string | Uint8Array) => Promise<void> };

/** Where a run's box comes from: a provider of this process's own (Docker, or the tests' faux box), or, for a remote box,
 *  the server's relay in data root `relay`. */
export type BoxSource = { provider: () => Promise<BoxProvider> } | { relay: string };

export function runBox(source: BoxSource, run: { id: string; root: string; dir: string; place: Place }): RunBox {
  let held: Promise<{ env: ExecutionEnv; box: Box }> | undefined;
  // What the host tools filed while no box was open in this process: a box a process before it made has no seed now, so
  // these go in when it opens (and to a new box, whose seed carries them anyway, again: the same bytes).
  const filed = new Map<string, Uint8Array>();
  const open = async (context: Context): Promise<{ env: ExecutionEnv; box: Box }> => {
    const { boxEnv, endLeftCommands } = await import("@parcha/pi-transport/hands");
    const { box, made } = "relay" in source ? await relayedRunBox(source.relay, run.dir, run.id, context) : await localRunBox(await source.provider(), run, context);
    if (!made) {
      // A process before this one left it: what it still runs is killed first, since its calls were answered interrupted.
      const ended = await endLeftCommands(box, context);
      if (!ended.ok) throw new Error(`the run's box could not be taken over: ${ended.error.message}`);
    }
    if (filed.size) {
      const files = [...filed].map(([path, bytes]) => ({ path: posix.join(BOX_WORK, path), bytes }));
      filed.clear();
      const sent = await box.upload(files, context);
      if (!sent.ok) mirrorFailed(files.map((file) => file.path).join(", "), sent.error);
    }
    return { box, env: boxEnv(box, { maxExecMs: BASH_TIMEOUT_MS, onLost: () => void (held = undefined) }) as unknown as ExecutionEnv };
  };
  const opened = (context: Context) => {
    held ??= open(context).catch((error: unknown) => {
      held = undefined;
      throw error;
    });
    return held;
  };
  let binds: Promise<boolean> | undefined;
  let checked: Promise<void> | undefined;
  const env = async (context: Context): Promise<ExecutionEnv> => (await opened(context)).env;
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
          },
        }
      : {}),
  };
}

/** Said in the run's process log: a file the host tools filed in work/ that its remote box did not get. */
function mirrorFailed(paths: string, error: Error): void {
  process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), event: "box_mirror_failed", message: `${paths} filed in work/ but not copied into the run's box: ${error.message}` })}\n`);
}

/** A box of this process's provider: the run's, by its label, or one made now with work/ bound. */
async function localRunBox(boxes: BoxProvider, run: { id: string; root: string; dir: string; place: Place }, context: Context): Promise<{ box: Box; made: boolean }> {
  const found = await attachRunBox(boxes, run.id, context);
  if (found) return { box: found, made: false };
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
  return { box: made.value, made: true };
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
export async function ensureRemoteBox(boxes: BoxProvider, run: { id: string; dir: string }, context: Context): Promise<{ id: string; made: boolean }> {
  let box = await attachRunBox(boxes, run.id, context);
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
export async function pullRemoteBox(boxes: BoxProvider, run: { id: string; dir: string }, context: Context): Promise<RemotePull | undefined> {
  const box = await attachRunBox(boxes, run.id, context);
  if (!box) return undefined;
  const { pullDir } = await import("@parcha/pi-transport/sync");
  const total: RemotePull = { changed: 0, files: 0, bytes: 0, removed: 0 };
  for (let round = 1; ; round++) {
    const kept = await markOf(run.dir);
    const pulled = await pullDir(box, { from: BOX_WORK, to: join(run.dir, "work"), ...(kept?.box === box.id ? { since: kept.mark } : {}), mirrorDeletes: true, overwrite: "if_unchanged" }, context);
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
