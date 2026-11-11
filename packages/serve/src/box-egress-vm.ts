// A Docker box's way out on a Mac, where Docker runs in a VM: the Linux path (box-egress.ts) binds a socket of this
// machine into the box, and a Mac's file-sharing layer carries files, not sockets, so the box sees it and is refused. Here
// serve's egress proxy runs instead in ONE container per server, inside the VM: the pinned EGRESS_IMAGE, the proxy's
// two dependency-free files and an entry (MAIN) bound read-only from the data root, the host list as its one variable, and
// a Unix socket in a tmpfs named volume owned by the server's uid. The box mounts that volume read-only at EGRESS_MOUNT
// and keeps `--network none`, its socat and its proxy variables, as on Linux. The proxy container is the only container
// with a network (Docker's default), and it publishes no port.
//
// This path is for a Mac alone, and only for a Docker that `docker info` names as a VM runtime this server knows
// (vmDockerOf): Docker Desktop, OrbStack or colima, on a kernel other than this machine's. Anything else stays offline, and
// the reason says what was seen. Linux keeps its own path, unchanged.
//
// Lifecycle (startEgressContainer): at the server's start, the volume is made if missing, every container of this
// server's label is removed (a crashed server's), the image is pulled if Docker lacks it, and the container is started
// and waited on until it logs EGRESS_READY (EGRESS_READY_MS). Docker restarts it if it dies (`--restart unless-stopped`);
// if it is gone (removed by hand), the server's watch starts it again. The server's stop removes it. Until it is ready,
// and when it cannot start, the box's network is none, and capabilities say why.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOW_HINT, EGRESS_SOCKET, INFO_TIMEOUT_MS } from "./box-egress.js";
import { withoutSecrets } from "./secrets.js";

/** What `docker info` is asked on a Mac: the daemon's OS type, its kernel, the name it gives its OS, and its host name. */
export const VM_INFO_FORMAT = "{{.OSType}}|{{.KernelVersion}}|{{.OperatingSystem}}|{{.Name}}";

/** The VM runtimes a box's network goes on for, on a Mac. */
export const VM_RUNTIMES = ["Docker Desktop", "OrbStack", "colima"] as const;
export type VmRuntime = (typeof VM_RUNTIMES)[number];

/** A colima VM's host name, which `docker info` gives as its Name: `colima` for the default profile, `colima-<profile>`
 *  for another (colima's config.ProfileName / CurrentProfile; its VM's hostname is the profile's ID). */
const COLIMA_NAME = /^colima(-[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

/** Where this Docker runs, by `docker info`'s answer to VM_INFO_FORMAT (`answer`), on a server with `platform` and
 *  `kernel` (os.release()): a VM runtime this server knows, or why not. Pure. A runtime counts only when docker info
 *  names it (OperatingSystem `Docker Desktop` or `OrbStack`, or a colima host Name) AND its kernel is not this
 *  machine's: a VM in between. Anything else is a reason, never a guess. */
export function vmDockerOf(answer: string, here: { platform: string; kernel: string }): { runtime: VmRuntime } | { reason: string } {
  if (here.platform !== "darwin") return { reason: `this server runs on ${here.platform}, not a Mac, so a Docker in a VM gets no box network here` };
  const fields = answer.trim().split("|");
  const [osType, kernel, os, name] = fields.map((field) => field.trim());
  const shown = (text: string) => JSON.stringify(text.slice(0, 80));
  if (fields.length !== 4 || !osType || !kernel) return { reason: `docker info's answer could not be read (${shown(answer.trim())}), so this server can't tell which VM this Docker runs in` };
  const runtime = os ? `this Docker (${os.slice(0, 80)})` : "this Docker";
  if (osType !== "linux") return { reason: `${runtime} runs ${shown(osType)} containers, not Linux ones, so its boxes get no network` };
  if (kernel === here.kernel) return { reason: `${runtime} runs on this machine's own kernel, not in a VM this server knows, so its boxes get no network` };
  const known: VmRuntime | undefined = os === "Docker Desktop" ? "Docker Desktop" : os === "OrbStack" ? "OrbStack" : COLIMA_NAME.test(name ?? "") ? "colima" : undefined;
  if (!known) return { reason: `${runtime} runs in a VM this server does not know (its kernel is ${shown(kernel)}, its name ${shown(name ?? "")}), so its boxes get no network: on a Mac, a box's network goes on only for Docker Desktop, OrbStack or colima` };
  return { runtime: known };
}

/** `docker`, with `args`, in the server's environment through the cut a run's takes, nothing on its stdin, within
 *  `timeoutMs`: its exit code (or `timeout`, or the spawn's error code) and its output. */
export type DockerCall = (args: readonly string[], timeoutMs: number, signal?: AbortSignal) => Promise<{ code: number | string; stdout: string; stderr: string }>;

export const dockerCall = (env: NodeJS.ProcessEnv): DockerCall => (args, timeoutMs, signal) =>
  new Promise((resolve) => {
    const child = execFile("docker", args, { env: withoutSecrets(env), timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024, ...(signal ? { signal } : {}) }, (error, stdout, stderr) => {
      const failed = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      resolve({ code: !failed ? 0 : failed.killed ? "timeout" : typeof failed.code === "number" ? failed.code : (failed.code ?? failed.name), stdout: String(stdout), stderr: String(stderr) });
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end();
  });

/** Where this Mac's Docker runs (vmDockerOf), asked of `docker info` within its bound; a daemon the docker CLI does not
 *  reach by a local unix socket (DOCKER_HOST, or a context, elsewhere) is not this Mac's VM, and gets no network. */
export async function vmDocker(env: NodeJS.ProcessEnv, options: { platform?: string; kernel?: string; timeoutMs?: number; docker?: DockerCall } = {}): Promise<{ runtime: VmRuntime } | { reason: string }> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return vmDockerOf("", { platform, kernel: "" });
  const { dockerDaemon } = await import("@parcha/pi-transport/box/docker");
  const daemon = dockerDaemon(env);
  if (!daemon.local) return { reason: `this Docker (${daemon.named}) is not on this machine, so its boxes get no network` };
  const timeoutMs = options.timeoutMs ?? INFO_TIMEOUT_MS;
  const answer = await (options.docker ?? dockerCall(env))(["info", "--format", VM_INFO_FORMAT], timeoutMs);
  if (answer.code !== 0) return { reason: `docker info did not say where this Docker runs (${answer.code === "timeout" ? `it did not answer within ${Math.round(timeoutMs / 1000)} s` : `it failed (${typeof answer.code === "number" ? `exit ${answer.code}` : answer.code})`}), so its boxes get no network` };
  return vmDockerOf(answer.stdout, { platform, kernel: options.kernel ?? release() });
}

/** The proxy container's image: `node:22-bookworm-slim` (the kernel needs Node 22.19 or later), pinned to the multi-arch
 *  index digest Docker Hub served for that tag on 2026-11-05 (Node 22.23.4), as BOX_BASE is pinned (box-image.ts), so every Mac runs the
 *  same Node. To move it, read the tag's index digest again the way BOX_BASE says, and put it here. */
export const EGRESS_IMAGE = "node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da";
/** The label the proxy container and its volume carry: the server's key (egressKeyOf). */
export const EGRESS_LABEL = "agentrun.egress";
/** Where the volume is in the proxy container, and its code. */
export const EGRESS_VOLUME_MOUNT = "/egress";
export const EGRESS_CODE_MOUNT = "/code";
/** What the entry logs once its socket listens. */
export const EGRESS_READY = "egress ready";
/** How long the start waits for EGRESS_READY once the container runs. */
export const EGRESS_READY_MS = 10_000;
/** How often the server looks for its proxy container, to start it again when it is gone. */
export const EGRESS_WATCH_MS = 5_000;
/** How long the start's pull of EGRESS_IMAGE may take. */
export const EGRESS_PULL_MS = 10 * 60_000;
/** Connections open at once through the server's one proxy, every run's together. */
export const VM_MAX_TUNNELS = 256;
/** The setting the proxy container gets, and nothing else: the host list. */
const ALLOW_VAR = "AGENTRUN_BOX_ALLOW";

/** This server's key: its data root's hash, so two servers on one daemon get two proxies and two volumes. */
export const egressKeyOf = (data: string): string => createHash("sha256").update(data).digest("hex").slice(0, 12);
/** The proxy container's name, and its volume's, for a key. */
export const egressNameOf = (key: string): string => `agentrun-egress-${key}`;

/** The entry the proxy container runs (`node /code/main.js <socket>`): it refuses to start with no list, for a proxy with
 *  none would reach every public host, and logs EGRESS_READY once its socket listens. Its decisions go to its log. */
export const MAIN = `// The box network proxy's entry, written by the server that runs it (agentrun serve), in its container.
import { parseAllow, startEgressProxy } from "./egress-proxy.js";
const say = (line) => process.stdout.write(line + "\\n");
let allow = [];
try {
  allow = parseAllow(process.env.${ALLOW_VAR} ?? "");
} catch (error) {
  say("egress: ${ALLOW_VAR} is not a host list (" + error.message + "), so the proxy does not start");
  process.exit(2);
}
if (allow.length === 0) {
  say("egress: no host list, so the proxy does not start: one with none would reach every public host");
  process.exit(2);
}
const socketPath = process.argv[2];
if (!socketPath) {
  say("egress: no socket path, so the proxy does not start");
  process.exit(2);
}
const proxy = await startEgressProxy({ socketPath, maxTunnels: ${VM_MAX_TUNNELS}, maxConnections: Number.MAX_SAFE_INTEGER, log: say, allow, allowHint: ${JSON.stringify(ALLOW_HINT)} });
say("${EGRESS_READY} allow=" + allow.join(","));
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => void proxy.close().finally(() => process.exit(0)));
`;

/** The kernel's two proxy files, as built: they import only `node:` modules and each other. */
export const PROXY_FILES = ["egress-proxy.js", "egress-table.js"] as const;

/** The code the proxy container binds read-only: PROXY_FILES of this server's own build, and MAIN, written into
 *  `<data>/egress/<12 hex of their hash>/` once (a directory per version, so a running container's code never changes
 *  under it). Its path, real (Docker binds it by that). */
export async function egressCode(data: string): Promise<string> {
  const host = dirname(fileURLToPath(import.meta.url));
  const files: [string, string][] = [...(await Promise.all(PROXY_FILES.map(async (name) => [name, await readFile(join(host, name), "utf8")] as [string, string]))), ["main.js", MAIN]];
  const hash = createHash("sha256");
  for (const [name, text] of files) hash.update(`${name}\0${text}\0`);
  const parent = join(await realpath(data), "egress");
  const dir = join(parent, hash.digest("hex").slice(0, 12));
  if (await readFile(join(dir, "main.js"), "utf8").then((text) => text === MAIN, () => false)) return dir;
  await mkdir(parent, { recursive: true, mode: 0o755 });
  const making = `${dir}.${randomBytes(4).toString("hex")}.partial`;
  await mkdir(making, { mode: 0o755 });
  try {
    for (const [name, text] of files) await writeFile(join(making, name), text, { mode: 0o644 });
    await chmod(making, 0o755);
    await rename(making, dir).catch(async (error: NodeJS.ErrnoException) => {
      // Another start made it first: the same bytes.
      if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
    });
  } finally {
    await rm(making, { recursive: true, force: true }).catch(() => undefined);
  }
  return dir;
}

/** `docker volume create` of the server's volume: tmpfs, so no stale socket outlives the VM, and owned by the server's
 *  uid:gid with mode 0700, as the proxy's socket (0600) and the box (both run as that uid) need. */
export const egressVolumeArgs = (key: string, uid: number, gid: number): string[] => ["volume", "create", "--driver", "local", "--opt", "type=tmpfs", "--opt", "device=tmpfs", "--opt", `o=size=1m,uid=${uid},gid=${gid},mode=0700`, "--label", `${EGRESS_LABEL}=${key}`, egressNameOf(key)];

/** `docker run` of the proxy container. Docker's default network, the only container with one; no published port, no
 *  Docker socket, no variable but the list; a read-only root, no capability, no privilege to gain, the server's uid:gid;
 *  bounded memory, processes and log. Pinned by a golden test. */
export const egressRunArgs = (options: { key: string; uid: number; gid: number; code: string; allow: readonly string[] }): string[] => [
  "run", "--detach", "--name", egressNameOf(options.key), "--restart", "unless-stopped",
  "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", `${options.uid}:${options.gid}`,
  "--memory", "256m", "--pids-limit", "256", "--log-driver", "json-file", "--log-opt", "max-size=1m", "--log-opt", "max-file=2",
  "--label", `${EGRESS_LABEL}=${options.key}`,
  "--mount", `type=volume,source=${egressNameOf(options.key)},target=${EGRESS_VOLUME_MOUNT}`,
  "--mount", `type=bind,source=${options.code},target=${EGRESS_CODE_MOUNT},readonly`,
  "--env", `${ALLOW_VAR}=${options.allow.join(",")}`,
  "--entrypoint", "node", EGRESS_IMAGE, `${EGRESS_CODE_MOUNT}/main.js`, `${EGRESS_VOLUME_MOUNT}/${EGRESS_SOCKET}`,
];

/** The proxy container's state: `ready` once it listens; `preparing` while it is pulled, started or started again;
 *  `unavailable` when it could not start, with why. */
export type EgressState = { state: "ready" } | { state: "preparing" | "unavailable"; reason: string };

/** `volume`: the volume a run's box mounts, once it is made; absent when it could not be. */
export type EgressContainer = { readonly volume?: string; state(): EgressState; close(): Promise<void> };

const OWN_WORDS = /^egress: [\x20-\x7e]{1,200}$/;
/** A container's full id, as `docker run --detach` prints it. */
const CONTAINER_ID = /^[0-9a-f]{64}$/;

/**
 * The server's proxy container (see the head of this file): made ready now when Docker has its image (within
 * EGRESS_READY_MS), else pulled and started in the background; then watched every `watchMs`, and started again when it
 * is gone or stopped. `onChange` is told each new state. `close` stops the watch and removes the container; its volume
 * stays, for boxes still mounting it and the next start.
 */
export async function startEgressContainer(options: { env: NodeJS.ProcessEnv; data: string; allow: readonly string[]; uid: number; gid: number; onChange?: (state: EgressState) => void; warn?: (message: string) => void; docker?: DockerCall; watchMs?: number; readyMs?: number; pullMs?: number }): Promise<EgressContainer> {
  if (!options.allow.length) throw new Error("the box network proxy needs a host list: one with none would reach every public host");
  const docker = options.docker ?? dockerCall(options.env);
  const key = egressKeyOf(await realpath(options.data));
  const name = egressNameOf(key);
  const readyMs = options.readyMs ?? EGRESS_READY_MS;
  let state: EgressState = { state: "preparing", reason: "the box network proxy is starting" };
  let closed = false;
  // Aborted at close: a pull or a wait in progress ends with the server.
  const stopping = new AbortController();
  const set = (next: EgressState) => {
    if (closed || (next.state === state.state && ("reason" in next ? next.reason : "") === ("reason" in state ? state.reason : ""))) return;
    state = next;
    options.onChange?.(state);
  };
  const failed = (why: string): EgressState => ({ state: "unavailable", reason: `the box network proxy did not start (${why}), so boxes have no network: restart the server to try again` });

  /** Removes every container of this server's label: a crashed server's, or one being replaced. */
  const sweep = async () => {
    const listed = await docker(["ps", "--all", "--quiet", "--filter", `label=${EGRESS_LABEL}=${key}`], 10_000);
    if (listed.code !== 0) throw new Error(`docker ps failed (${listed.code})`);
    for (const id of listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
      const removed = await docker(["rm", "--force", id], 10_000);
      if (removed.code !== 0 && !/no such container/i.test(removed.stderr)) throw new Error(`docker rm of an old proxy failed (${removed.code})`);
    }
  };
  /** Makes the server's volume, unless it is there with this server's label: why not, or undefined. One of its name
   *  without the label (Docker makes a volume a box names with its own defaults: root's, not tmpfs) is replaced when
   *  nothing holds it, and is a failure, saying how to remove it, when something does. */
  const ensureVolume = async (): Promise<string | undefined> => {
    const seen = await docker(["volume", "inspect", "--format", `{{index .Labels "${EGRESS_LABEL}"}}`, name], 10_000);
    if (seen.code === 0 && seen.stdout.trim() === key) return undefined;
    if (seen.code === 0 && (await docker(["volume", "rm", name], 10_000)).code !== 0) return `a volume ${name} that this server did not make is in use: stop what uses it and run docker volume rm ${name}`;
    const made = await docker(egressVolumeArgs(key, options.uid, options.gid), 10_000);
    return made.code === 0 ? undefined : `docker volume create failed (${made.code})`;
  };
  // The proxy container this server started, by the id `docker run` printed: what the watch looks at and the close
  // removes. Never its name, which a container that is not this server's may hold.
  let ours: string | undefined;
  /** Removes the container this server started, by its id. */
  const removeOurs = async () => {
    if (ours) await docker(["rm", "--force", ours], 10_000);
    ours = undefined;
  };
  /** Starts the container, the image already in, and waits for its ready line. */
  const run = async (): Promise<EgressState> => {
    const volume = await ensureVolume();
    if (volume) return failed(volume);
    // A close since: nothing is removed or started, so a server that took this data root after it keeps its own proxy.
    if (closed) return state;
    await sweep();
    const code = await egressCode(options.data);
    if (closed) return state;
    const started = await docker(egressRunArgs({ key, uid: options.uid, gid: options.gid, code, allow: options.allow }), 30_000);
    // A name another container holds fails here (Docker's conflict), and that container is left as it is.
    if (started.code !== 0) return failed(`docker run failed (${started.code})`);
    // Only an id is taken as one: anything else Docker printed is never handed to rm, inspect or logs.
    const id = started.stdout.trim().split("\n").at(-1)?.trim() ?? "";
    if (!CONTAINER_ID.test(id)) return failed("docker run printed no container id");
    ours = id;
    // A close while it started: what it started goes too.
    if (closed) return (await removeOurs(), state);
    const until = Date.now() + readyMs;
    for (;;) {
      const logs = await docker(["logs", "--tail", "20", ours], 5_000);
      const lines = `${logs.stdout}\n${logs.stderr}`.split("\n").map((line) => line.trim());
      if (lines.some((line) => line.startsWith(EGRESS_READY))) return { state: "ready" };
      if (closed) return state;
      if (Date.now() > until) {
        const own = lines.filter((line) => OWN_WORDS.test(line)).at(-1);
        return failed(own ?? `it did not say it was ready within ${Math.round(readyMs / 1000)} s`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };
  const start = async (): Promise<EgressState> => {
    try {
      return await run();
    } catch (error) {
      return failed((error as Error).message);
    }
  };

  let busy: Promise<void> | undefined;
  const once = (step: () => Promise<void>) => (busy ??= step().finally(() => (busy = undefined)));
  // The volume first, before any run is handed its name: a box that mounted a missing one would have Docker make it
  // with its own defaults.
  const noVolume = await ensureVolume().catch((error: Error) => error.message);
  if (noVolume) {
    state = failed(noVolume);
    return { state: () => state, close: async () => void (closed = true) };
  }
  const inspected = await docker(["image", "inspect", "--format", "{{.Id}}", EGRESS_IMAGE], 10_000);
  if (inspected.code === 0) set(await start());
  else {
    set({ state: "preparing", reason: `the box network proxy is pulling its image, ${EGRESS_IMAGE.split("@")[0]}` });
    void once(async () => {
      const pulled = await docker(["pull", "--quiet", EGRESS_IMAGE], options.pullMs ?? EGRESS_PULL_MS, stopping.signal);
      if (closed) return;
      set(pulled.code === 0 ? await start() : failed(`docker pull ${EGRESS_IMAGE.split("@")[0]} failed (${pulled.code}): run it on this machine to see why`));
    });
  }
  // Docker restarts a proxy that dies; one that is gone, or stopped, makes the network none at the first look, and the
  // watch starts it again at the second in a row.
  let misses = 0;
  const watch = setInterval(() => {
    if (closed || busy || state.state === "unavailable") return;
    void once(async () => {
      const running = ours ? await docker(["inspect", "--format", "{{.State.Running}}", ours], 5_000) : undefined;
      if (running?.code === 0 && running.stdout.trim() === "true") {
        misses = 0;
        if (state.state !== "ready") set({ state: "ready" });
        return;
      }
      set({ state: "preparing", reason: "the box network proxy is not running" });
      if (++misses < 2) return;
      misses = 0;
      set({ state: "preparing", reason: "the box network proxy was gone, and is starting again" });
      set(await start());
    });
  }, options.watchMs ?? EGRESS_WATCH_MS);
  watch.unref();

  return {
    volume: name,
    state: () => state,
    async close() {
      closed = true;
      clearInterval(watch);
      stopping.abort();
      // What was under way ends first (a pull or a wait is aborted; a start checks `closed`), so nothing of this server's
      // touches Docker after its close.
      await busy?.catch(() => undefined);
      // Best effort, but never silent: a failure says the proxy may still run, and how to remove it.
      const left = (why: string) => options.warn?.(`the box network proxy may still be running (${why}): remove the containers labelled ${EGRESS_LABEL}=${key} with docker rm -f`);
      if (ours) {
        const removed = await docker(["rm", "--force", ours], 10_000);
        if (removed.code !== 0 && !/no such container/i.test(removed.stderr)) left(`docker rm failed (${removed.code})`);
        ours = undefined;
      }
      // And any other container of this server's own label, by its id: one a start made though its docker run gave no
      // answer (a client cut off). Never by name: a container that is not this server's carries no such label.
      await sweep().catch((error: Error) => left(error.message));
    },
  };
}

/** What the server hands a run's process on a Mac with the proxy container: its volume's name, which the run's Docker
 *  boxes mount read-only at EGRESS_MOUNT. Unset on Linux, where the run's process starts its own proxy (box-egress.ts). */
export const RUN_BOX_VOLUME_ENV = "AGENTRUN_RUN_BOX_VOLUME";


