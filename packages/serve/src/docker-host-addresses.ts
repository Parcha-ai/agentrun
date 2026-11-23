// The Docker host's own addresses, for a Docker provider whose interfaces aren't that host's (the server in a container
// given the host's Docker socket, compose.yaml). A Docker computer's egress proxy refuses them as the host's, so an
// allow-list never reaches the host itself; with none known, the provider refuses any allow-list there, and the server
// says so before a run (server.ts). They are the union of two sources, never one or the other, and never made up:
//   - what the Docker host shows, read once per process through the socket: one short-lived container on the host's own
//     network (`--network host`) from the egress proxy's image (@parcha/agentrun-computer's EGRESS_IMAGE, pinned by
//     digest, which every Docker computer with an allow-list needs on the host anyway), as nobody (65534:65534), with no
//     capability, no new privileges, a read-only root, 64 MiB and 32 processes, removed when it exits, bound to
//     READ_MS. A read that runs out of time or fails is removed by its name (a killed or failed client can leave its
//     container running, or made and never started), and a name Docker doesn't confirm gone is removed again at the
//     next read. It prints the host's interface addresses (Node's os.networkInterfaces: IPv4 and IPv6 alike) and what
//     host.docker.internal resolves to (host-gateway: on Docker Desktop or OrbStack the listing is the VM's, and the
//     gateway is the way back to the Mac). A read that fails gives none, in words, and the server reads again in the
//     background until one answers (retryHostAddresses).
//   - the operator's AGENTRUN_DOCKER_HOST_ADDRESSES (workspace/computer-deps.ts), for what no interface shows: a NAT'd
//     or elastic public address.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { EGRESS_IMAGE } from "@parcha/agentrun-computer";
import { withoutSecrets } from "./secrets.js";

/** How long the read may take, its image's pull included. */
export const READ_MS = 60_000;
/** The label the read's container carries, so it is told apart from a run's. */
export const READ_LABEL = "agentrun.read=host-addresses";

/** What the read's container runs: Node, printing the interface addresses and host.docker.internal's, as one JSON line. */
const SCRIPT = [
  "const os = require('node:os'), dns = require('node:dns');",
  "const interfaces = Object.values(os.networkInterfaces()).flat().filter(Boolean).map((one) => one.address);",
  "dns.lookup('host.docker.internal', { all: true }, (error, found) => { process.stdout.write(JSON.stringify({ interfaces, gateway: error ? [] : found.map((one) => one.address) }) + '\\n'); });",
].join(" ");

/** The read's `docker run`, every argument, its container named `name` (a fresh one per read: helperName), so a read
 *  that runs out of time removes it by that name. */
export const readArgsOf = (name: string): readonly string[] => [
  "run", "--rm", "--name", name, "--network", "host", "--add-host", "host.docker.internal:host-gateway", "--pull", "missing",
  "--user", "65534:65534", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
  "--memory", "64m", "--pids-limit", "32", "--label", READ_LABEL, "--entrypoint", "node", EGRESS_IMAGE, "-e", SCRIPT,
];

/** A fresh name for one read's container. */
export const helperName = (): string => `agentrun-host-read-${randomBytes(6).toString("hex")}`;

/** How long removing a read's container that ran out of time, and checking it is gone, may each take. */
const REMOVE_MS = 15_000;

/** Loopback and link-local: no address another machine reaches the host by. */
const local = (address: string): boolean => /^127\./.test(address) || address === "::1" || /^169\.254\./.test(address) || /^fe[89ab][0-9a-f]:/i.test(address);

/** The addresses in the read's answer: each an IP address, the zone of a scoped one cut, loopback and link-local left out,
 *  each once. */
export function addressesOf(answer: string): string[] {
  const parsed = JSON.parse(answer.trim()) as { interfaces?: unknown; gateway?: unknown };
  const listed = [...(Array.isArray(parsed.interfaces) ? parsed.interfaces : []), ...(Array.isArray(parsed.gateway) ? parsed.gateway : [])];
  const addresses = listed.filter((one): one is string => typeof one === "string").map((one) => one.split("%")[0]!);
  return [...new Set(addresses.filter((one) => isIP(one) !== 0 && !local(one)))];
}

/** What the read found: the host's addresses, or why there are none. */
export type HostRead = { readonly addresses: readonly string[] } | { readonly why: string };

/** `docker` with `args`, bound to `ms`: its exit code (or the spawn's error code) and output. */
export type DockerRun = (args: readonly string[], ms: number) => Promise<{ code: number | string; stdout: string; stderr: string }>;

const dockerRun = (env: NodeJS.ProcessEnv): DockerRun => (args, ms) =>
  new Promise((resolve) => {
    const child = execFile("docker", args, { env: withoutSecrets(env), timeout: ms, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      const failed = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      resolve({ code: !failed ? 0 : failed.killed ? "timeout" : typeof failed.code === "number" ? failed.code : (failed.code ?? failed.name), stdout: String(stdout), stderr: String(stderr) });
    });
    child.stdin?.end();
  });

/** What removing a read's container by its name found: gone, still there, or unknown (Docker didn't answer the check),
 *  with the words for the read's why. */
type Removal = { readonly left: "gone" } | { readonly left: "there" | "unknown"; readonly words: string };

/** Removes the read's container `name` (`docker rm -f`) and checks it is gone. A container whose `docker run` client was
 *  killed or failed can outlive it: running, or made and never started, so `--rm` never fires. A name Docker doesn't
 *  confirm gone is kept in `kept`, and the next read removes it first; one it confirms gone is dropped. */
async function removeHelper(docker: DockerRun, name: string, kept: Set<string>): Promise<Removal> {
  await docker(["rm", "-f", name], REMOVE_MS);
  const left = await docker(["inspect", "--type", "container", "--format", "{{.State.Running}}", name], REMOVE_MS);
  // Gone only when Docker says it has no such container; a daemon that didn't answer says nothing of it.
  if (left.code !== 0 && NO_SUCH_CONTAINER.test(left.stderr)) {
    kept.delete(name);
    return { left: "gone" };
  }
  kept.add(name);
  if (left.code === 0) return { left: "there", words: `its container ${name} is still there: remove it with docker rm -f ${name}` };
  return { left: "unknown", words: `its container ${name} may still be running (docker inspect failed: ${left.stderr.trim().slice(0, 160) || `exit ${left.code}`}): remove it with docker rm -f ${name}` };
}

/** Docker's words for a container it doesn't have, as `docker inspect` gives them. */
const NO_SUCH_CONTAINER = /no such (object|container)/i;

/** An environment's docker: the binary PATH finds and the daemon it reaches. */
const envKey = (env: NodeJS.ProcessEnv): string => [env.PATH, env.DOCKER_HOST, env.DOCKER_CONTEXT, env.DOCKER_CONFIG].map((one) => one ?? "").join("\0");

/** For each environment's docker (envKey), the names of this process's reads' containers not yet confirmed gone. Only
 *  names this process made: another server on the same host may have a read in flight, so nothing is swept by label. */
const leftovers = new Map<string, Set<string>>();
const keptOf = (env: NodeJS.ProcessEnv): Set<string> => {
  const key = envKey(env);
  let kept = leftovers.get(key);
  if (!kept) leftovers.set(key, (kept = new Set()));
  return kept;
};

/** The Docker host's addresses, read through `env`'s docker as above, after removing the containers earlier reads left
 *  (keptOf). Never throws: a read that fails, or whose answer can't be read, says why; one that runs out of time or exits
 *  non-zero has its container removed by name. `docker`, `ms` and `name` are the tests'. */
export async function readHostAddresses(env: NodeJS.ProcessEnv, docker: DockerRun = dockerRun(env), ms = READ_MS, name = helperName()): Promise<HostRead> {
  const kept = keptOf(env);
  for (const left of [...kept]) await removeHelper(docker, left, kept);
  const ran = await docker(readArgsOf(name), ms);
  if (ran.code === "timeout") {
    const removal = await removeHelper(docker, name, kept);
    return { why: `the read through Docker's socket took over ${ms / 1000} s (${removal.left === "gone" ? "its container was removed" : removal.words})` };
  }
  if (ran.code !== 0) {
    const failed = `the read through Docker's socket failed (exit ${ran.code}: ${ran.stderr.trim().slice(0, 200)})`;
    // A docker that never ran (its spawn failed: no exit code) made no container.
    if (typeof ran.code !== "number") return { why: failed };
    const removal = await removeHelper(docker, name, kept);
    return { why: removal.left === "there" ? `${failed} (${removal.words})` : failed };
  }
  try {
    return { addresses: addressesOf(ran.stdout) };
  } catch {
    return { why: `the read through Docker's socket answered what is not its list (${ran.stdout.trim().slice(0, 120)})` };
  }
}

/** The union of the read's addresses and the operator's, each once; the read's why when it failed. */
export function unionOf(read: HostRead, named: readonly string[] | undefined): { addresses: string[]; why?: string } {
  const addresses = [...new Set([...("addresses" in read ? read.addresses : []), ...(named ?? [])])];
  return "why" in read ? { addresses, why: read.why } : { addresses };
}

/** One read per process, for each environment's docker (the binary PATH finds and the daemon it reaches), kept once it
 *  succeeds: a server and the runner beside it share it, and a failed read is tried again at the next ask. */
const reads = new Map<string, Promise<HostRead>>();
export function hostAddressesOnce(env: NodeJS.ProcessEnv): Promise<HostRead> {
  const key = envKey(env);
  const known = reads.get(key);
  if (known) return known;
  const read = readHostAddresses(env).then((result) => {
    if ("why" in result) reads.delete(key);
    return result;
  });
  reads.set(key, read);
  return read;
}

/** The waits before each read again after a read failed at the start, the last one repeated: soon at first, as a busy
 *  host's Docker (an image pull, a loaded daemon) often answers within minutes, then every 4 minutes, so a daemon that
 *  stays down costs one short-lived container each time and no more. */
export const RETRY_MS: readonly number[] = [15_000, 30_000, 60_000, 120_000, 240_000];

/** Waits `ms`, ending at once when `signal` aborts. The tests give one that ends when they say. */
export type Wait = (ms: number, signal: AbortSignal) => Promise<void>;
const wait: Wait = (ms, signal) => delay(ms, undefined, { signal }).catch(() => undefined);

/** Reads again (`read`: hostAddressesOnce, so the runner beside the server shares what it finds) after a read failed,
 *  waiting RETRY_MS before each, until one answers (`found` gets it) or `signal` aborts (the server's close): then a
 *  pending wait ends at once, no read follows, and a read in flight is not taken. */
export async function retryHostAddresses(read: () => Promise<HostRead>, found: (read: HostRead) => void, signal: AbortSignal, waitFor: Wait = wait): Promise<void> {
  for (let tried = 0; !signal.aborted; tried++) {
    await waitFor(RETRY_MS[Math.min(tried, RETRY_MS.length - 1)]!, signal);
    if (signal.aborted) return;
    const result = await read();
    if (signal.aborted) return;
    if (!("why" in result)) return found(result);
  }
}

/** Why a Docker computer can't keep this server's allow-list from a container: no address of the Docker host is known,
 *  with `why` (the read's failure, or that it found none), and the two ways out. */
export const noHostAddresses = (why: string): string =>
  `the server runs in a container and doesn't know the Docker host's own addresses (${why}), so a Docker computer can't keep this server's allow-list: set AGENTRUN_DOCKER_HOST_ADDRESSES to the host's IP addresses, or AGENTRUN_BOX_ALLOW=none for no network`;
