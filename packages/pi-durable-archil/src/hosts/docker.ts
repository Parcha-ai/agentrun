// dockerHost: one container per instance of a run, from an image that carries Node, the archil client, FUSE and
// this package (docker/Dockerfile). The container is the instance's machine and its cage: the instance runs as root inside
// (the archil verbs need root, and no sudo is involved), mounts the run's directory through /dev/fuse, and runs the
// agent's commands as the image's unprivileged user under no_new_privs (`run --run-as`). Nothing on the host needs root.
//
// One container is one incarnation: no restart policy; the supervisor decides. A container that dies takes its FUSE
// daemon and its mount with it (the mount lives in the container's mount namespace, never on the host), so the claim
// is orphaned and the next supervisor tick revokes it and starts a new container. The name `<prefix><run>-g<attempt>`
// is the idempotency key of a start: a retry of the same attempt adopts a container that is running, and replaces one
// that never started or already exited.
//
// The mount token never appears in the container's configuration (`docker inspect` shows its environment and argv): the
// driver copies it into the created container as a root-only file (`docker cp -`, a tar stream built in memory, so it
// never touches the host's file system), the image's entrypoint makes that file the instance's stdin and removes it
// before the instance starts, and the instance closes its stdin once read. The API key stays with the supervisor.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { DEFAULT_MOUNT_ROOT, runPath, type RunRef } from "../claim.ts";
import { PdaError } from "../errors.ts";
import type { HostDriver, HostHandle, HostStatus, StartAttempt } from "../supervise.ts";

export type DockerRan = { code: number | null; timedOut: boolean; stdout: string; stderr: string };
/** Runs one docker CLI command; replaceable so tests can drive a fake daemon. */
export type DockerRunner = (argv: string[], opts?: { input?: string | Uint8Array; timeoutMs?: number }) => Promise<DockerRan>;

export interface DockerHostOptions {
  /** The image every container runs (docker/Dockerfile or one built FROM it). Required to start. */
  image?: string;
  /** The docker CLI. Default `docker` on the PATH; it talks to whatever daemon its context or DOCKER_HOST names. */
  docker?: string;
  /** Labels every container `pda.fleet=<fleet>`; a handle of another fleet is not this driver's. Default "default". */
  fleet?: string;
  /** Container names are `<namePrefix><run id>-g<attempt>`. Default "pda-". */
  namePrefix?: string;
  /** Where runs mount inside every container (the same on every host). Default /mnt/archil. */
  mountRoot?: string;
  /** The app module on this machine (`run --app`); its directory, or `appRoot`, is bind-mounted read-only. */
  app?: string;
  /** The directory mounted at /opt/pda/app (default: the app's own). Its node_modules is hidden: imports resolve to the image's. */
  appRoot?: string;
  /** Extra flags for `run` (heartbeat and lease periods, `--on-sigterm`). */
  runArgs?: string[];
  /** The user the agent's commands run as inside the container. Default "pda" (uid 1500 in the image). */
  runAs?: string;
  /** Environment for the instance. Visible to `docker inspect`, so never a secret; the driver never copies its own. */
  env?: Record<string, string>;
  /** Extra `docker create` flags (resource limits, `--add-host`, a network). */
  dockerArgs?: string[];
  /**
   * The AppArmor profile, false to pass none, or "auto" (the default): `apparmor=unconfined` only where the Docker daemon
   * applies AppArmor (`docker info` lists it in its security options). There Docker's default profile denies mount(2),
   * so `archil mount` fails with "Permission denied" under it. Where the daemon applies none (Docker Desktop and OrbStack
   * on a Mac), no option is passed.
   */
  apparmor?: "auto" | string | false;
  /** Called once with each decision the driver makes about the host (the AppArmor option and why). */
  note?: (line: string) => void;
  /** `docker stop -t`: SIGTERM (the instance drains and releases), then SIGKILL. Default 30 s. */
  stopTimeoutMs?: number;
  exec?: DockerRunner;
}

export class DockerHostError extends PdaError {
  constructor(code: "INVALID_ARGUMENT" | "START_FAILED" | "STOP_FAILED" | "DOCKER_FAILED", message: string, options: { cause?: unknown } = {}) {
    super(code, message, options);
  }
}

/** Inside the container: where the app root is mounted, the root-owned archil wrapper, and where the token lands. */
const APP_DIR = "/opt/pda/app";
const CONTAINER_ARCHIL = "/usr/local/sbin/archil-scoped";
const TOKEN_DIR = "/run/pda";
const TOKEN_FILE = "token";

const NAME_SAFE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
const SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const NO_SUCH = /No such (container|object)/i;
const IN_USE = /Conflict|already in use/i;

/** The docker CLI with the caller's PATH (Docker Desktop installs outside the system paths) and HOME (its contexts). */
export const runDocker: DockerRunner = (argv, opts = {}) =>
  new Promise((resolvePromise, reject) => {
    let stdout = "", stderr = "", settled = false;
    const env: Record<string, string> = { PATH: process.env.PATH || SAFE_PATH, HOME: process.env.HOME ?? "/", LANG: "C.UTF-8" };
    for (const k of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY", "XDG_RUNTIME_DIR"]) {
      if (process.env[k]) env[k] = process.env[k]!;
    }
    const child = spawn(argv[0], argv.slice(1), { env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    const done = (r: DockerRan) => void (settled || ((settled = true), clearTimeout(timer), resolvePromise(r)));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ code: null, timedOut: true, stdout, stderr });
    }, opts.timeoutMs ?? 60_000);
    child.on("error", (err) => void (settled || ((settled = true), clearTimeout(timer), reject(err))));
    child.on("close", (code) => done({ code, timedOut: false, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
  });

/** One regular file in a POSIX tar stream, owned by root: what `docker cp -` extracts into the container. */
export function tarOneFile(name: string, data: Uint8Array, mode = 0o600): Uint8Array {
  if (!/^[A-Za-z0-9._-]{1,99}$/.test(name)) throw new DockerHostError("INVALID_ARGUMENT", `tar entry ${name} is not a plain file name`);
  const header = Buffer.alloc(512);
  const put = (text: string, offset: number, length: number) => header.write(text, offset, length, "ascii");
  const octal = (n: number, width: number) => `${n.toString(8).padStart(width - 1, "0")}\0`;
  put(name, 0, 100);
  put(octal(mode, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(data.length, 12), 124, 12);
  put(octal(Math.floor(Date.now() / 1000), 12), 136, 12);
  header.fill(" ", 148, 156);
  put("0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  put("root", 265, 32);
  put("root", 297, 32);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, Buffer.from(data), pad, Buffer.alloc(1024)]);
}

type DockerState = { Status?: string; ExitCode?: number; OOMKilled?: boolean; Error?: string; StartedAt?: string; FinishedAt?: string; Running?: boolean; Paused?: boolean };

/**
 * A container's state as a host status. Paused is a frozen host that still holds its claim: running, so the lease decides,
 * and STONITH stops it (`docker stop` works on a paused container). Exit 0 (a drain) is stopped; any other exit, the
 * terminal 65, 70, 75 and 76 included, is failed. Created (never started) is stopped.
 */
export function containerStatus(state: DockerState): HostStatus {
  switch (state.Status) {
    case "running":
    case "paused":
    case "restarting":
      return "running";
    case "created":
    case "removing":
      return "stopped";
    case "exited":
      return state.ExitCode === 0 ? "stopped" : "failed";
    case "dead":
      return "failed";
    default:
      return "unknown";
  }
}

export type ContainerInfo = { status: HostStatus; state: string; exitCode: number | null; oomKilled: boolean; error: string; startedAt: string | null; finishedAt: string | null };

export function dockerHost(opts: DockerHostOptions = {}): HostDriver & {
  readonly fleet: string;
  readonly mountRoot: string;
  describe(handle: HostHandle): Promise<ContainerInfo | null>;
} {
  const docker = opts.docker ?? "docker";
  const exec = opts.exec ?? runDocker;
  const fleet = opts.fleet ?? "default";
  const prefix = opts.namePrefix ?? "pda-";
  const mountRoot = opts.mountRoot ?? DEFAULT_MOUNT_ROOT;
  const runAs = opts.runAs ?? "pda";
  const stopTimeoutMs = opts.stopTimeoutMs ?? 30_000;
  const apparmorOption = opts.apparmor ?? "auto";
  if (!/^[A-Za-z0-9_.-]{1,63}$/.test(fleet)) throw new DockerHostError("INVALID_ARGUMENT", `fleet ${fleet} is not a plain label value`);
  if (!isAbsolute(mountRoot)) throw new DockerHostError("INVALID_ARGUMENT", `mountRoot ${mountRoot} is not absolute`);
  const app = appMount(opts.app, opts.appRoot);

  const run = (args: string[], o?: { input?: string | Uint8Array; timeoutMs?: number }) => exec([docker, ...args], o);
  const firstLine = (r: DockerRan) => (r.timedOut ? "timed out" : (r.stderr.trim().split("\n").at(-1) ?? "").slice(0, 300));
  const ok = (r: DockerRan) => r.code === 0 && !r.timedOut;

  // The daemon's identity: a handle from another daemon is not this driver's to judge.
  let daemonId: Promise<string> | undefined;
  const daemon = () =>
    (daemonId ??= run(["info", "--format", "{{.ID}}"], { timeoutMs: 30_000 }).then((r) => {
      if (!ok(r) || !r.stdout.trim()) {
        daemonId = undefined;
        throw new DockerHostError("DOCKER_FAILED", `docker info: ${firstLine(r)}`);
      }
      return r.stdout.trim();
    }));

  // The AppArmor option, decided once: given, or from what the daemon reports it applies.
  let apparmorProfile: Promise<string | null> | undefined;
  const apparmor = () =>
    (apparmorProfile ??= (async () => {
      if (apparmorOption !== "auto") return apparmorOption === false ? null : apparmorOption;
      const r = await run(["info", "--format", "{{json .SecurityOptions}}"], { timeoutMs: 30_000 });
      if (!ok(r)) {
        apparmorProfile = undefined;
        throw new DockerHostError("DOCKER_FAILED", `docker info: ${firstLine(r)}`);
      }
      const options = (JSON.parse(r.stdout.trim() || "[]") as string[] | null) ?? [];
      const applies = options.some((o) => o.split(",").includes("name=apparmor"));
      opts.note?.(
        applies
          ? "the docker daemon applies AppArmor, whose default profile denies the mount archil needs: containers run with --security-opt apparmor=unconfined"
          : "the docker daemon applies no AppArmor profile: containers get no AppArmor option",
      );
      return applies ? "unconfined" : null;
    })());

  const mine = async (h: HostHandle) => h.driver === "docker" && h.fleet === fleet && typeof h.name === "string" && NAME_SAFE.test(h.name) && h.daemon === (await daemon());
  const target = (h: HostHandle) => (typeof h.id === "string" && /^[0-9a-f]{12,64}$/.test(h.id) ? h.id : String(h.name));

  async function inspect(ref: string): Promise<{ state: DockerState; labels: Record<string, string> } | null> {
    const r = await run(["inspect", "--type", "container", "--format", "{{json .State}}\t{{json .Config.Labels}}", ref], { timeoutMs: 30_000 });
    if (!ok(r)) {
      if (NO_SUCH.test(r.stderr)) return null;
      throw new DockerHostError("DOCKER_FAILED", `docker inspect ${ref}: ${firstLine(r)}`);
    }
    const [state, labels] = r.stdout.trim().split("\t");
    return { state: JSON.parse(state) as DockerState, labels: (JSON.parse(labels || "null") as Record<string, string> | null) ?? {} };
  }

  async function remove(ref: string): Promise<void> {
    const r = await run(["rm", "-f", ref], { timeoutMs: 60_000 });
    if (!ok(r) && !NO_SUCH.test(r.stderr)) throw new DockerHostError("DOCKER_FAILED", `docker rm -f ${ref}: ${firstLine(r)}`);
  }

  function createArgs(ref: RunRef, name: string, attempt: number | null, holder: HostHandle, profile: string | null): string[] {
    const env: Record<string, string> = { ...opts.env, PDA_HOLDER: JSON.stringify(holder) };
    const runFlags = [
      "run",
      "--disk", ref.disk,
      "--region", ref.region,
      "--id", ref.id,
      "--mount-root", mountRoot,
      "--archil", CONTAINER_ARCHIL,
      "--run-as", runAs,
      ...(app ? ["--app", app.inside] : []),
      ...(opts.runArgs ?? []),
      "--token-stdin",
    ];
    return [
      "create",
      "--name", name,
      "--hostname", name.slice(0, 63).replace(/[^A-Za-z0-9-]/g, "-").replace(/-+$/, ""),
      "--label", `pda.fleet=${fleet}`,
      "--label", `pda.run=${ref.id}`,
      ...(attempt === null ? [] : ["--label", `pda.attempt=${attempt}`]),
      // FUSE: the device and the capability mount(2) needs; the container's root holds them, the commands never do.
      "--device", "/dev/fuse",
      "--cap-add", "SYS_ADMIN",
      ...(profile === null ? [] : ["--security-opt", `apparmor=${profile}`]),
      // Nothing in the container gains privilege through exec (setuid binaries, file capabilities).
      "--security-opt", "no-new-privileges",
      "--restart", "no",
      "--stop-timeout", String(Math.max(1, Math.ceil(stopTimeoutMs / 1000))),
      ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
      ...(app?.mounts ?? []),
      ...(opts.dockerArgs ?? []),
      opts.image!,
      ...runFlags,
    ];
  }

  async function create(ref: RunRef, name: string, attempt: number | null, holder: HostHandle): Promise<{ id: string } | { adopted: true }> {
    const profile = await apparmor();
    for (let tries = 0; ; tries++) {
      const r = await run(createArgs(ref, name, attempt, holder, profile), { timeoutMs: 120_000 });
      if (ok(r)) return { id: r.stdout.trim().split("\n").at(-1)!.trim() };
      if (!IN_USE.test(r.stderr) || tries > 0) throw new DockerHostError("START_FAILED", `docker create ${name}: ${firstLine(r)}`);
      // The same attempt again: a running container is a start that already happened (a racing supervisor, or a retry
      // after a timeout), so it is adopted; one that never started or already exited is replaced.
      const found = await inspect(name);
      if (found && found.labels["pda.fleet"] !== fleet) throw new DockerHostError("START_FAILED", `container ${name} exists and is not fleet ${fleet}'s`);
      if (found && containerStatus(found.state) === "running") return { adopted: true };
      await remove(name);
    }
  }

  /**
   * Remove this run's other containers of this fleet that have ended (a killed or fenced instance stays as an exited
   * container until here, so its `docker logs` can be read until the next start), and those created for an earlier
   * attempt that never started. Best effort; never a running or paused one, never the one just started.
   */
  async function collect(ref: RunRef, attempt: number | null, keep: string): Promise<void> {
    const r = await run(["ps", "-a", "--filter", `label=pda.fleet=${fleet}`, "--filter", `label=pda.run=${ref.id}`, "--format", "{{.ID}}\t{{.State}}\t{{.Label \"pda.attempt\"}}"], { timeoutMs: 30_000 }).catch(() => null);
    if (!r || !ok(r)) return;
    for (const line of r.stdout.split("\n").filter(Boolean)) {
      const [id, state, label] = line.split("\t");
      if (keep.startsWith(id) || id.startsWith(keep)) continue;
      const ended = state === "exited" || state === "dead";
      const abandoned = state === "created" && attempt !== null && /^\d+$/.test(label ?? "") && Number(label) < attempt;
      if (ended || abandoned) await remove(id).catch(() => {});
    }
  }

  return {
    fleet,
    mountRoot,

    async start(ref, token, attemptInfo?: StartAttempt) {
      runPath(ref.id);
      if (!opts.image) throw new DockerHostError("INVALID_ARGUMENT", "dockerHost needs an image to start an instance");
      if (!token || /[\r\n]/.test(token)) throw new DockerHostError("INVALID_ARGUMENT", "no mount token, or one with a line break");
      const attempt = attemptInfo?.attempt ?? null;
      const name = `${prefix}${ref.id}-${attempt === null ? `t${Date.now().toString(36)}` : `g${attempt}`}`;
      if (!NAME_SAFE.test(name)) throw new DockerHostError("INVALID_ARGUMENT", `container name ${name} is not safe`);
      const handle: HostHandle = { driver: "docker", fleet, daemon: await daemon(), name, mountpoint: posix.join(mountRoot, runPath(ref.id)), image: opts.image };
      const made = await create(ref, name, attempt, handle);
      if ("adopted" in made) return handle;
      try {
        const cp = await run(["cp", "-", `${made.id}:${TOKEN_DIR}`], { input: tarOneFile(TOKEN_FILE, Buffer.from(`${token}\n`)), timeoutMs: 60_000 });
        if (!ok(cp)) throw new DockerHostError("START_FAILED", `docker cp of the mount token into ${name}: ${firstLine(cp)}`);
        const st = await run(["start", made.id], { timeoutMs: 120_000 });
        if (!ok(st)) throw new DockerHostError("START_FAILED", `docker start ${name}: ${firstLine(st)}`);
      } catch (err) {
        await remove(made.id).catch(() => {});
        throw err;
      }
      await collect(ref, attempt, made.id);
      return { ...handle, id: made.id };
    },

    async status(h) {
      if (!(await mine(h))) return "unknown";
      const found = await inspect(target(h));
      return found ? containerStatus(found.state) : "gone";
    },

    /** The container's state with its exit code (75 fenced, 76 held, 65 and 70 data errors), or null when it is gone. */
    async describe(h) {
      if (!(await mine(h))) return null;
      const found = await inspect(target(h));
      if (!found) return null;
      const s = found.state;
      const time = (t?: string) => (t && !t.startsWith("0001-") ? t : null);
      return { status: containerStatus(s), state: s.Status ?? "", exitCode: s.Status === "exited" || s.Status === "dead" ? (s.ExitCode ?? null) : null, oomKilled: s.OOMKilled === true, error: s.Error ?? "", startedAt: time(s.StartedAt), finishedAt: time(s.FinishedAt) };
    },

    async stop(h) {
      if (!(await mine(h))) return;
      const ref = target(h);
      const found = await inspect(ref);
      if (!found) return;
      if (found.labels["pda.fleet"] !== fleet) return;
      // SIGTERM drains (the instance releases its claim); a paused container is thawed by the daemon to take it. Then
      // the container goes, and its mount with it: nothing is left on the host.
      const st = await run(["stop", "-t", String(Math.max(1, Math.ceil(stopTimeoutMs / 1000))), ref], { timeoutMs: stopTimeoutMs + 30_000 });
      if (!ok(st) && !NO_SUCH.test(st.stderr) && (await inspect(ref).then((f) => f && containerStatus(f.state) === "running"))) {
        await run(["kill", ref], { timeoutMs: 30_000 });
      }
      await remove(ref);
      if (await inspect(ref)) throw new DockerHostError("STOP_FAILED", `container ${ref} is still there after docker rm -f`);
    },
  };
}

/** The bind mount of the app's directory (read-only, its node_modules hidden) and the module's path inside the container. */
function appMount(app: string | undefined, appRoot: string | undefined): { inside: string; mounts: string[] } | null {
  if (app === undefined) {
    if (appRoot !== undefined) throw new DockerHostError("INVALID_ARGUMENT", "appRoot without an app module");
    return null;
  }
  const file = resolve(app);
  const root = resolve(appRoot ?? dirname(file));
  const rel = relative(root, file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new DockerHostError("INVALID_ARGUMENT", `the app module ${file} is not under its root ${root}`);
  // --mount takes comma-separated fields; a path with a comma or a quote would need quoting rules worth not depending on.
  if (/[",\n]/.test(root)) throw new DockerHostError("INVALID_ARGUMENT", `the app root ${root} contains a comma, a quote or a newline`);
  const mounts = ["--mount", `type=bind,source=${root},target=${APP_DIR},readonly`];
  // The image's node_modules holds the one copy of pi-durable this package and the app must share: an app root's own
  // node_modules (installed on the host, maybe for another platform) is hidden under an empty read-only tmpfs.
  if (existsSync(join(root, "node_modules"))) mounts.push("--mount", `type=tmpfs,target=${APP_DIR}/node_modules,tmpfs-size=4096,tmpfs-mode=0555`);
  return { inside: posix.join(APP_DIR, ...rel.split(sep)), mounts };
}
