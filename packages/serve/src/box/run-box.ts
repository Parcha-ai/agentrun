// The box a run's own process builds for its harness: serve hands it the settings at launch, in one non-secret
// environment variable (never the secrets pipe nor RUN_SECRETS), and the run's process builds bwrapBox from them, once.
// A box that cannot be built as asked is refused by name, never built with less: no data root, or a run whose own
// directory is not under it, would leave the box's hidden list short of the run's own tree.
import { lstatSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { type Box, BoxError, bwrapBox, type Isolation, type MachineBox } from "@parcha/agentrun-kernel/host";
import { boxRecorder } from "./record.js";

/** The variable serve sets on a harness run's process. Not a secret: paths and a mode. */
export const RUN_BOX_ENV = "AGENTRUN_RUN_BOX";

/** What serve hands the run's process: its data root, what serve's probe proved (the run never probes again), serve's
 *  own temporary directory (where the session's sockets go: the run's own TMPDIR is under the data root, too long for a
 *  socket's path), and on a shared server the delegated cgroup subtree and pids.max. */
export type RunBoxSettings = { data: string; isolation: Isolation; runtimeDir?: string; cgroupRoot?: string; pidsMax?: number };

const refuse = (why: string): never => {
  throw new BoxError("box_refused", `this run's box is refused: ${why}`);
};

/** The settings in `env`, strictly: undefined when serve set none (no box for this run); anything malformed, or with no
 *  data root, is refused by name. */
export function runBoxOf(env: NodeJS.ProcessEnv): RunBoxSettings | undefined {
  const text = env[RUN_BOX_ENV];
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return refuse(`${RUN_BOX_ENV} is not JSON`);
  }
  const v = value as Partial<Record<keyof RunBoxSettings, unknown>> | null;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return refuse(`${RUN_BOX_ENV} is not an object`);
  if (typeof v.data !== "string" || !isAbsolute(v.data)) return refuse("serve gave it no data root (an absolute path), so nothing of the server's would be hidden from it");
  const isolation = v.isolation as Isolation | undefined;
  if (typeof isolation !== "object" || isolation === null || typeof isolation.mode !== "string") return refuse(`${RUN_BOX_ENV} names no isolation`);
  if (v.cgroupRoot !== undefined && (typeof v.cgroupRoot !== "string" || !isAbsolute(v.cgroupRoot))) return refuse("its cgroup root is not an absolute path");
  if (v.runtimeDir !== undefined && (typeof v.runtimeDir !== "string" || !isAbsolute(v.runtimeDir))) return refuse("its socket directory's root is not an absolute path");
  if (v.pidsMax !== undefined && !(Number.isSafeInteger(v.pidsMax) && (v.pidsMax as number) > 0)) return refuse("its pids.max is not a positive integer");
  return { data: v.data, isolation, ...(v.runtimeDir !== undefined ? { runtimeDir: v.runtimeDir as string } : {}), ...(v.cgroupRoot !== undefined ? { cgroupRoot: v.cgroupRoot as string } : {}), ...(v.pidsMax !== undefined ? { pidsMax: v.pidsMax as number } : {}) };
}

/** What a box never sees for the run in `runDir`: the whole data root, and the run's own journal and log (its cost, its
 *  decisions, its state), with the harnesses' credential directories the operator named. Each as resolved. */
export function hiddenFor(data: string, runDir: string, env: NodeJS.ProcessEnv): string[] {
  const named = [env.CLAUDE_CONFIG_DIR, env.CODEX_HOME].filter((path): path is string => typeof path === "string" && isAbsolute(path));
  return [data, join(runDir, "store"), join(runDir, "process.log"), ...named];
}

/** The run's own directory must sit under the data root it was handed, both resolved: else the box's hidden list would
 *  not hold the run's own tree, and the kernel's data-root scope would fail open. */
export function checkUnderData(data: string, runDir: string): void {
  let realData: string;
  let realRun: string;
  try {
    realData = realpathSync(data);
    realRun = realpathSync(runDir);
  } catch (error) {
    return refuse(`its data root or its own directory cannot be resolved (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`);
  }
  const under = relative(realData, realRun);
  if (under === "" || under.startsWith("..") || isAbsolute(under)) refuse(`its own directory ${realRun} is not under the data root ${realData} it was handed`);
}

const LOOPBACK = "127.0.0.1"; // key-gate: loopback-rule the free port is found on host loopback

/** A port nothing listens on now: the one the box serves the session's model front on, at its own loopback. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, LOOPBACK, resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** The run's box, built once from serve's settings: the kernel's bwrapBox with the run's hidden list, its record in the
 *  run's directory (box.json), and on a shared server the run's own cgroup. `unsandboxed` is no box, the operator's word. */
export async function runBox(settings: RunBoxSettings, run: { id: string; dir: string }, env: NodeJS.ProcessEnv): Promise<MachineBox | "unsandboxed"> {
  if (settings.isolation.mode === "unsandboxed") return "unsandboxed";
  checkUnderData(settings.data, run.dir);
  const box = bindsChecked(bwrapBox({
    hidden: hiddenFor(settings.data, run.dir, env),
    isolation: settings.isolation,
    ...(settings.cgroupRoot !== undefined ? { cgroupRoot: settings.cgroupRoot } : {}),
    ...(settings.pidsMax !== undefined ? { pidsMax: settings.pidsMax } : {}),
  }));
  return {
    box,
    recorder: boxRecorder(run.dir),
    readOnly: [],
    modelPort: await freePort(),
    // The session's sockets in serve's own temporary directory, short: the machine's default is in this process's TMPDIR,
    // the launch's own under the data root, where a socket's path would run past the 107 bytes a socket may have. Keyed by
    // this launch (its own temporary directory), never the run alone: a hung earlier launch of the run may still be
    // running beside this one, and two launches never share a socket directory.
    ...(settings.runtimeDir !== undefined ? { runtimeDir: join(settings.runtimeDir, `arb-${createHash("sha256").update(`${join(run.dir, "harness")}\0${resolve(tmpdir())}`).digest("hex").slice(0, 12)}`) } : {}),
    ...(settings.cgroupRoot !== undefined && (settings.isolation as { cgroup?: boolean }).cgroup ? { cgroup: join(settings.cgroupRoot, run.id) } : {}),
  };
}

/** The box, with each child's own binds (the spec's `bind:<n>` homes: the harness's config and resume directories)
 *  checked before the kernel's own check: a real directory, never a link, directly under this launch's temporary
 *  directory, resolved (os.tmpdir(), which serve set). Anything else is refused by name, before anything starts. */
export function bindsChecked(box: Box, launchTmp: () => string = tmpdir): Box {
  const start: Box["start"] = (spec, child, recorder) => {
    const root = realpathSync(launchTmp());
    for (const [key, path] of Object.entries(spec.homes)) {
      if (!key.startsWith("bind:")) continue;
      let real: string | undefined;
      try {
        real = lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory() ? undefined : realpathSync(path);
      } catch {
        real = undefined;
      }
      if (real === undefined || dirname(real) !== root) refuse(`a child's bind ${path} is not a directory directly under this launch's temporary directory ${root} (a link, missing, or elsewhere)`);
    }
    return box.start(spec, child, recorder);
  };
  return { isolation: box.isolation, start, reap: (record) => box.reap(record) };
}

/** A boxed Claude session live in this process: there is at most one. A second one at once is refused by name; the
 *  temporary directory its box is lent from is this process's, and one process's directories are one session's. */
let boxedClaude: string | undefined;

/** Claims this process's one boxed Claude session for `key`; the release lets the next one open. */
export function claimBoxedClaude(key: string): () => void {
  if (boxedClaude !== undefined) refuse(`a second boxed Claude session (${key}) in one run process while ${boxedClaude} is live: one run process holds one`);
  boxedClaude = key;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (boxedClaude === key) boxedClaude = undefined;
  };
}
