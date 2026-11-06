// A Docker box's way out to the network: the hosts on the server's list (AGENTRUN_BOX_ALLOW), and nothing else. The box
// stays `--network none`, with its own loopback alone. The run's process starts the kernel's egress proxy with the list
// (@parcha/agentrun-kernel/host), on a Unix socket in a directory of its own, which is bound into the box read-only at
// EGRESS_MOUNT; a socat in the box relays its own loopback port EGRESS_PORT to it, and the box's fixed environment
// names that port as its HTTP(S) proxy. The proxy refuses, before any lookup, a host off the list, an IP literal and any port but 80 and
// 443, and a listed name that resolves to a private or metadata address; it holds no key and adds none. A program in the
// box that ignores the proxy variables has no route and no resolver: its connection is unreachable. The list is the
// setting's one reading (run-box.ts boxAllowOf), as the server resolves it for this machine (boxNetworkOf); with `none`,
// a box is as it was: no proxy, no mount, no proxy variables. The proxy is never started without an explicit list: one
// with none would reach every public host.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { connect } from "node:net";
import { release } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type EgressProxy, type EgressProxyOptions, parseAllow, startEgressProxy } from "@parcha/agentrun-kernel/host";
import { FAUX_ENV } from "./model.js";
import { withoutSecrets } from "./secrets.js";

/** Where the proxy's directory is in the box, read-only. */
export const EGRESS_MOUNT = "/run/agentrun/egress";
/** The proxy's socket, in its directory. */
export const EGRESS_SOCKET = "egress.sock";
/** The box's loopback port socat relays to the socket. */
export const EGRESS_PORT = 3128;
/** The box's own loopback, where its relay listens: never a service of this machine's. */
const BOX_LOOPBACK = "127.0.0.1"; // key-gate: loopback-rule the box own loopback where its relay listens
/** The proxy's address in the box: EGRESS_PORT on its loopback. */
const PROXY_URL = `http://${BOX_LOOPBACK}:${EGRESS_PORT}`;
const NO_PROXY = "localhost,127.0.0.1,::1"; // key-gate: loopback-rule the box own loopback names the proxy leaves out
/** What a box with a list adds to its fixed environment (run-box.ts BOX_ENV): constants, no user, no password. */
export const PROXY_ENV: Readonly<Record<string, string>> = Object.freeze({ HTTP_PROXY: PROXY_URL, HTTPS_PROXY: PROXY_URL, http_proxy: PROXY_URL, https_proxy: PROXY_URL, NO_PROXY, no_proxy: NO_PROXY });
/** The box's relay to the proxy's socket `socket` (in EGRESS_MOUNT), started once each time the run's box opens (made
 *  or found): a second one finds the port taken and exits. Each connection opens the socket by its path, so a proxy
 *  started again is reached with no new relay. */
export const forwarder = (socket: string = EGRESS_SOCKET): string[] => ["socat", `TCP-LISTEN:${EGRESS_PORT},bind=127.0.0.1,reuseaddr,fork`, `UNIX-CONNECT:${EGRESS_MOUNT}/${socket}`]; // key-gate: loopback-rule the box own proxy port inside the box
/** How long the relay has to listen once started, in tenths of a second. */
const RELAY_WAIT_TENTHS = 30;
/** EGRESS_PORT on the box's loopback as /proc/net/tcp writes a listening socket: address and port in hex, state 0A. */
const LISTENING = ` 0100007F:${EGRESS_PORT.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A `;
/** The relay's start, in the box, answered once it listens: exit 127 when the image has no socat, 126 when it has no
 *  setsid, and 124 when the relay is not listening within 3 s (its own error, if it gave one, on stderr). A relay a
 *  process before this one started still listens, so a second start finds the port taken and answers at once. */
export const forwarderStart = (socket: string = EGRESS_SOCKET): string[] => ["sh", "-c", [
  "command -v socat >/dev/null 2>&1 || exit 127",
  "command -v setsid >/dev/null 2>&1 || exit 126",
  `listening() { grep -q '${LISTENING}' /proc/net/tcp 2>/dev/null; }`,
  "listening && exit 0",
  `log=$(mktemp); setsid ${forwarder(socket).join(" ")} </dev/null >/dev/null 2>"$log" &`,
  `i=0; while [ "$i" -lt ${RELAY_WAIT_TENTHS} ]; do listening && { rm -f "$log"; exit 0; }; i=$((i + 1)); sleep 0.1; done`,
  `head -c 300 "$log" >&2; rm -f "$log"; exit 124`,
].join("\n")];
/** The timeline row of a box whose relay could not start, by the start's exit (forwarderStart): the box keeps no network. */
export function relayFailed(code: number, said: string): string {
  if (code === 127) return "This box's image has no socat, so it has no network. Add socat to the image, or set AGENTRUN_BOX_ALLOW=none to silence this.";
  if (code === 126) return "This box's image has no setsid, so it has no network. Add util-linux's setsid to the image, or set AGENTRUN_BOX_ALLOW=none to silence this.";
  const why = said.trim().replace(/[\u0000-\u001f]+/g, " ").slice(0, 200);
  return `This box's network relay did not start within 3 s (${code === 124 ? why || "it was not listening" : `exit ${code}`}), so it has no network.`;
}
/** The row for an image with no socat (relayFailed 127). */
export const NO_SOCAT = relayFailed(127, "");
/** What a refusal of a host off the list says to do, after its words. */
export const ALLOW_HINT = `use web_fetch for web pages, or ask the operator to add it to AGENTRUN_BOX_ALLOW`;
/** Each run's proxy: connections open at once, and in all. */
export const MAX_TUNNELS = 64;
export const MAX_CONNECTIONS = 20_000;
/** Under `--faux` only: a module whose default export gives the proxy's `lookup` and `dial` (the tests' fake network), so
 *  a test's box reaches no host but its fake. */
export const FAUX_EGRESS_ENV = "AGENTRUN_SERVE_FAUX_EGRESS";

/** The proxy's directory for run `runId`: short, so its socket's path stays within a Unix socket's limit (107 bytes)
 *  wherever the data root is, and the same each time the run's process starts, since the box keeps its bind. */
export function egressDir(runId: string, uid: number = process.getuid?.() ?? 0): string {
  return join("/tmp", `agentrun-egress-${uid}`, createHash("sha256").update(runId).digest("hex").slice(0, 16));
}

/** Removes a run's proxy directory once its box is gone. */
export const removeEgressDir = (runId: string): Promise<void> => rm(egressDir(runId), { recursive: true, force: true });

/** This user's parent directory in /tmp: made 0700, and refused unless it is a directory of this user's, not a link. */
async function ownParent(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const at = await lstat(dir);
  const uid = process.getuid?.();
  if (!at.isDirectory() || at.isSymbolicLink() || (uid !== undefined && at.uid !== uid) || (at.mode & 0o077) !== 0) {
    throw new Error(`the box's network directory ${dir} is not a directory of this user's alone (0700, not a link): remove it, or set AGENTRUN_BOX_ALLOW=none`);
  }
}

/** Where a run's box finds its proxy: what is mounted read-only at EGRESS_MOUNT, and the socket's name there. The one
 *  seam between the box's side, which is the same wherever the proxy runs (the mount, the relay, the proxy variables),
 *  and where the proxy runs. Today that is hostEgress: the run's own process, its socket's directory on this machine
 *  bound into the box. */
export type BoxEgress = (runId: string) => Promise<{ mount?: { source: string; target: typeof EGRESS_MOUNT; readOnly: true }; socket: string; fresh: boolean }>;

/** The proxy in the run's process (hostEgress): for a Docker daemon on this Linux machine, which can reach a socket in a
 *  directory of this machine bound into a container. */
export const hostEgress = (allow: readonly string[], env: NodeJS.ProcessEnv, log: (line: string) => void): BoxEgress => async (runId) => {
  const { dir, fresh } = await runProxy(runId, allow, env, log);
  return { mount: { source: dir, target: EGRESS_MOUNT, readOnly: true }, socket: EGRESS_SOCKET, fresh };
};

const started = new Map<string, Promise<{ proxy: EgressProxy; fresh: boolean }>>();
const opened = new Set<string>();

/** Run `runId`'s proxy in this process, with `allow`, started once: its directory, to bind into the box, and whether that
 *  directory was made now (`fresh`): a box bound to one an earlier process made, which the start's sweep took since, holds
 *  the old directory, not this one. Its decisions go to `log`. */
async function runProxy(runId: string, allow: readonly string[], env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<{ dir: string; fresh: boolean }> {
  const dir = egressDir(runId);
  let proxy = started.get(runId);
  if (!proxy) {
    proxy = (async () => {
      await ownParent(join(dir, ".."));
      const fresh = await mkdir(dir, { mode: 0o700 }).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
        return false;
      });
      const proxy = await startEgressProxy({ socketPath: join(dir, EGRESS_SOCKET), maxTunnels: MAX_TUNNELS, maxConnections: MAX_CONNECTIONS, log, allow: [...allow], allowHint: ALLOW_HINT, ...(await fauxSeams(env)) });
      log(`egress start allow=${allow.join(",")}`);
      return { proxy, fresh };
    })();
    started.set(runId, proxy);
    proxy.catch(() => started.delete(runId));
  }
  // Fresh once: a later open in this process binds what the first one did.
  const fresh = (await proxy).fresh && !opened.has(runId);
  opened.add(runId);
  return { dir, fresh };
}

type Seams = Pick<EgressProxyOptions, "lookup" | "dial">;

/** The tests' seams, under `--faux` with FAUX_EGRESS_ENV set: its module's. */
async function fauxSeams(env: NodeJS.ProcessEnv): Promise<Seams> {
  const module = env[FAUX_ENV] ? env[FAUX_EGRESS_ENV] : undefined;
  if (!module) return {};
  return ((await import(pathToFileURL(module).href)) as { default: () => Seams | Promise<Seams> }).default();
}

/** How long `docker info` may take to say where this Docker runs. */
export const INFO_TIMEOUT_MS = 5_000;
/** A platform by the name people use. */
const PLATFORM_NAMES: Readonly<Record<string, string>> = { darwin: "macOS", win32: "Windows" };
/** What `docker info` is asked: the daemon's OS type, its kernel, where it keeps its data, and the name it gives its OS. */
export const INFO_FORMAT = "{{.OSType}}|{{.KernelVersion}}|{{.DockerRootDir}}|{{.OperatingSystem}}";

/** `docker info`'s answer to INFO_FORMAT, its stdout, or a throw that says why there is none. */
export type DockerInfo = (env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<string>;

/** `docker info` in the server's environment through the cut a run's takes, nothing on its stdin, within `timeoutMs`. */
export const dockerInfo: DockerInfo = (env, timeoutMs) =>
  new Promise((resolve, reject) =>
    execFile("docker", ["info", "--format", INFO_FORMAT], { env: withoutSecrets(env), timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (!error) return resolve(String(stdout));
      const failed = error as NodeJS.ErrnoException & { killed?: boolean };
      reject(new Error(failed.killed ? `it did not answer within ${Math.round(timeoutMs / 1000)} s` : typeof failed.code === "number" ? `it failed (exit ${failed.code})` : `it failed (${failed.code ?? failed.name})`));
    }).stdin?.end(),
  );

/**
 * Why a Docker box on this server cannot reach its proxy, or undefined when it can. The proxy's socket is a file of this
 * machine bound into the box, which only a Docker daemon on this same Linux machine can connect to: a daemon in a VM
 * (Docker Desktop, OrbStack and their kin) sees the socket and is refused. So the network goes on only with positive
 * evidence that the daemon is this machine's: this machine is Linux; the docker CLI's endpoint is a local unix socket
 * (no DOCKER_HOST or a unix:// one, and the default context or a unix one: pi-transport's dockerDaemon); and `docker
 * info` answers within its bound with OS type linux and this machine's own kernel (os.release()): the same kernel, so no
 * VM in between; and the directory it keeps its data in (DockerRootDir) is one this server sees. A server in a container
 * given the host's docker socket shares the host's kernel, but not its files: it would bind a directory the daemon does
 * not have, so every box would fail to start. Anything else is no network, and the reason says what was seen, naming the
 * runtime docker info gives. A kernel is the evidence, not a runtime's name: Docker Desktop on WSL2 runs the kernel this
 * server does, but keeps its data outside the distro, so it passes only where the distro has that directory too.
 */
export async function egressBlockedBy(env: NodeJS.ProcessEnv, options: { info?: DockerInfo; platform?: string; kernel?: string; timeoutMs?: number; sees?: (dir: string) => boolean } = {}): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") return `this server runs on ${PLATFORM_NAMES[platform] ?? platform}, where Docker runs in a VM that can't reach this server's egress proxy yet`;
  const { dockerDaemon } = await import("@parcha/pi-transport/box/docker");
  const daemon = dockerDaemon(env);
  if (!daemon.local) return `this Docker (${daemon.named}) is not on this machine, so it can't reach this server's egress proxy`;
  let answer: string;
  try {
    answer = await (options.info ?? dockerInfo)(env, options.timeoutMs ?? INFO_TIMEOUT_MS);
  } catch (error) {
    return `docker info did not say where this Docker runs (${(error as Error).message}), so this server can't tell it is on this machine`;
  }
  const fields = answer.trim().split("|");
  const [osType, kernel, root, name] = fields.map((field) => field.trim());
  const shown = (text: string) => JSON.stringify(text.slice(0, 80));
  if (fields.length !== 4 || !osType || !kernel || !root) return `docker info's answer could not be read (${shown(answer.trim())}), so this server can't tell this Docker is on this machine`;
  const runtime = name ? `this Docker (${name.slice(0, 80)})` : "this Docker";
  if (osType !== "linux") return `${runtime} runs ${shown(osType)} containers, not Linux ones on this machine, so it can't reach this server's egress proxy`;
  const here = options.kernel ?? release();
  if (kernel !== here) return `${runtime} runs in a VM (its kernel is ${shown(kernel)}, this machine's ${shown(here)}) that can't reach this server's egress proxy yet`;
  const sees = options.sees ?? ((dir: string) => {
    try {
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
  if (!sees(root)) return `${runtime} keeps its data in ${shown(root)}, which this server can't see: it runs on another machine's files (this server in a container, given the host's docker socket), so it can't reach this server's egress proxy`;
  return undefined;
}

/** How old a run's proxy directory with no live socket must be before the start's sweep takes it: one just made, whose
 *  proxy is still starting, is not yet listening. */
export const STALE_EGRESS_MS = 60_000;

/**
 * The start's sweep of this user's proxy directories (egressDir's parent): each whose socket refuses a connect (or has
 * none) and that is older than STALE_EGRESS_MS is a run's process that is gone, and is removed, by its exact path. One
 * whose socket answers is a live run's, this server's or another's under this uid, and stays. Returns how many went.
 */
export async function sweepEgressDirs(uid: number = process.getuid?.() ?? 0, now: number = Date.now()): Promise<number> {
  const parent = join("/tmp", `agentrun-egress-${uid}`);
  let names: string[];
  try {
    const at = await lstat(parent);
    if (!at.isDirectory() || at.isSymbolicLink() || at.uid !== uid) return 0;
    names = await readdir(parent);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!/^[0-9a-f]{16}$/.test(name)) continue;
    const dir = join(parent, name);
    try {
      const at = await lstat(dir);
      if (!at.isDirectory() || at.isSymbolicLink() || at.uid !== uid || now - at.mtimeMs < STALE_EGRESS_MS) continue;
    } catch {
      continue;
    }
    if (await answers(join(dir, EGRESS_SOCKET))) continue;
    await rm(dir, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

/** Whether a Unix socket at `path` takes a connection: no for a refusal or no such file, yes for anything else. */
function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const timer = setTimeout(() => (socket.destroy(), resolve(true)), 2_000);
    socket.once("connect", () => (clearTimeout(timer), socket.destroy(), resolve(true)));
    socket.once("error", (error: NodeJS.ErrnoException) => (clearTimeout(timer), resolve(error.code !== "ECONNREFUSED" && error.code !== "ENOENT")));
  });
}

/** What a server's Docker boxes reach, resolved once at its start (run-box.ts boxNetworkOf): the list, or none and why. */
export type DockerNetwork = { allow: readonly string[]; /** On a Mac, the VM runtime whose proxy container serves the list (box-egress-vm.ts). */ vm?: string } | { allow: "none"; reason: string };

/** What the server hands a run's process: the list its box reaches, resolved (boxNetworkOf), or `none`. The run's
 *  process reads this, never AGENTRUN_BOX_ALLOW: unset, it is none. */
export const RUN_BOX_ALLOW_ENV = "AGENTRUN_RUN_BOX_ALLOW";

/** The run's process's reading of RUN_BOX_ALLOW_ENV: the list, or `none` when it says so, is unset or is not a list. */
export function runBoxAllowOf(env: NodeJS.ProcessEnv): readonly string[] | "none" {
  const value = env[RUN_BOX_ALLOW_ENV]?.trim();
  if (!value || value === "none") return "none";
  try {
    const list = parseAllow(value);
    return list.length ? list : "none";
  } catch {
    return "none";
  }
}
