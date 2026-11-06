// Where the Docker a server runs boxes on has the server's files. On a host, the server's paths are the daemon's own, and
// a box binds the run's work/ by its path: nothing here is asked. A server in a container of that Docker's own, given its
// socket (compose.yaml at the repository's root), has paths the daemon does not: the daemon has only what it mounted
// into the server's container. One layout is supported: the data directory on a named volume of the server's own
// container, as compose.yaml makes it. The server reads its own container's id from /proc/self/mountinfo (Docker binds
// /etc/hostname from `<its root>/containers/<id>/hostname`), asks Docker for that container's mounts, and takes the
// named volume that holds the data directory; a box then mounts the run's work/ and its egress directory as that volume's
// subpaths (pi-transport's Docker `paths`, `volume-subpath`: Docker Engine 26 and later), never the volume's root. Any
// other layout, or an older engine, is a reason, said once at the start, and docker is unavailable: a guess would make
// every box fail at its create.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { withoutSecrets } from "./secrets.js";

/** Where the daemon has the data directory: the named volume mounted at `at`, as pi-transport's Docker `paths` takes it. */
export type BoxPaths = { at: string; volume: string };

/** The server's Docker files: its own (`here`, a host), through its container's named volume (`paths`), or none, and why. */
export type DockerPaths = { here: true } | { paths: BoxPaths } | { reason: string };

/** The one way a server in a container runs boxes. */
export const IN_COMPOSE = "run AgentRun in a container with `docker compose up` from compose.yaml (its named data volume is how boxes reach a run's files)";
/** An engine that cannot mount a volume's subpath. */
export const OLD_ENGINE = "Docker Engine <26 can't mount a named volume's subpath: upgrade to Docker 26+";

/** Under `--faux` only: a file the server reads as its /proc/self/mountinfo (server.ts fauxMountinfo). */
export const FAUX_MOUNTINFO_ENV = "AGENTRUN_SERVE_FAUX_MOUNTINFO";

/** What the server hands a run's process: the paths, as JSON; empty on a host. */
export const RUN_BOX_PATHS_ENV = "AGENTRUN_RUN_BOX_PATHS";

/** The run's process's reading of RUN_BOX_PATHS_ENV: the paths, or undefined when it is empty or not theirs. */
export function runBoxPathsOf(env: NodeJS.ProcessEnv): BoxPaths | undefined {
  try {
    const paths = JSON.parse(env[RUN_BOX_PATHS_ENV] || "null") as Partial<BoxPaths> | null;
    return typeof paths?.at === "string" && typeof paths.volume === "string" ? { at: paths.at, volume: paths.volume } : undefined;
  } catch {
    return undefined;
  }
}

/** The directory the runs' egress proxy sockets are in, for a server in a container: on its data volume, so a box can
 *  mount its run's (box-egress.ts egressDir). */
export const egressParentOf = (data: string): string => `${data}/box-egress`;

/** Its own container's id, from /proc/self/mountinfo: the source of the /etc/hostname Docker bound in. */
export function ownContainerOf(mountinfo: string): string | undefined {
  for (const line of mountinfo.split("\n")) {
    const fields = line.split(" ");
    const id = fields[4] === "/etc/hostname" ? /\/containers\/([0-9a-f]{64})\/hostname$/.exec(fields[3] ?? "")?.[1] : undefined;
    if (id) return id;
  }
  return undefined;
}

/** A mount of a container, as `docker inspect` gives it. */
export type ContainerMount = { Type?: string; Name?: string; Destination?: string; RW?: boolean };

/** Where the daemon has `data`, by the server's container's `mounts` and the daemon's API version (`api`, `docker
 *  version`'s): the read-write named volume that holds it, the deepest such mount, on an engine that mounts its subpath
 *  (API 1.45, Docker Engine 26); else why. Pure. */
export function pathsOf(mounts: readonly ContainerMount[], data: string, api: string): { paths: BoxPaths } | { reason: string } {
  const holds = (at: string) => data === at || data.startsWith(`${at}/`);
  const mount = mounts.filter((m) => typeof m.Destination === "string" && holds(m.Destination)).sort((a, b) => b.Destination!.length - a.Destination!.length)[0];
  if (mount?.Type !== "volume" || !mount.Name || mount.RW !== true) return { reason: IN_COMPOSE };
  // A mount below the data directory hides part of it from that volume: a box would get the volume's files there.
  if (mounts.some((m) => typeof m.Destination === "string" && m.Destination.startsWith(`${data}/`))) return { reason: IN_COMPOSE };
  const version = /^(\d+)\.(\d+)$/.exec(api.trim());
  if (!version || Number(version[1]) < 1 || (Number(version[1]) === 1 && Number(version[2]) < 45)) return { reason: OLD_ENGINE };
  return { paths: { at: mount.Destination!, volume: mount.Name } };
}

/** `docker` with `args`: its exit code (or the spawn's error code) and output. */
export type DockerCall = (args: readonly string[]) => Promise<{ code: number | string; stdout: string; stderr: string }>;

const dockerCall = (env: NodeJS.ProcessEnv): DockerCall => (args) =>
  new Promise((resolve) => {
    const child = execFile("docker", args, { env: withoutSecrets(env), timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const failed = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      resolve({ code: !failed ? 0 : failed.killed ? "timeout" : typeof failed.code === "number" ? failed.code : (failed.code ?? failed.name), stdout: String(stdout), stderr: String(stderr) });
    });
    child.stdin?.end();
  });

/**
 * Where the Docker this server runs boxes on has `data` (see the head of this file), resolved once at its start. A
 * server with no container id in its mountinfo and none of a container's marks (`inContainer`: /.dockerenv, Podman's
 * /run/.containerenv) is on a host: `here`, and nothing is asked. `mountinfo`, `inContainer` and `docker` are the tests'.
 */
export async function dockerPathsOf(env: NodeJS.ProcessEnv, data: string, options: { mountinfo?: string; inContainer?: boolean; docker?: DockerCall } = {}): Promise<DockerPaths> {
  const mountinfo = options.mountinfo ?? (await readFile("/proc/self/mountinfo", "utf8").catch(() => ""));
  const id = ownContainerOf(mountinfo);
  if (!id) return (options.inContainer ?? (existsSync("/.dockerenv") || existsSync("/run/.containerenv"))) ? { reason: IN_COMPOSE } : { here: true };
  const docker = options.docker ?? dockerCall(env);
  // A container this Docker does not have is another Docker's: its socket is not the one that runs this server.
  const inspected = await docker(["inspect", "--type", "container", "--format", "{{json .Mounts}}", id]);
  if (inspected.code !== 0 && !/no such (container|object)/i.test(inspected.stderr)) return { reason: `docker inspect of this server's own container failed (${inspected.code === "timeout" ? "it did not answer" : `exit ${inspected.code}`}): restart this server to try again` };
  let mounts: ContainerMount[] = [];
  try {
    if (inspected.code === 0) mounts = JSON.parse(inspected.stdout) as ContainerMount[];
  } catch {}
  const version = await docker(["version", "--format", "{{.Server.APIVersion}}"]);
  return pathsOf(Array.isArray(mounts) ? mounts : [], data, version.code === 0 ? version.stdout : "");
}
