// The boxes a place may name, as capabilities show them (places.boxes), read from the computers runs execute on: a
// sandbox place on box X is a sandbox computer on provider X (computer-setting.ts computerOfPlace), which a run's claim
// starts (workspace/). Which providers are boxes is their descriptors' facts (isBox), never a list of names. Read once,
// at the server's start: each fix takes a restart.
//
// AGENTRUN_BOXES lists the boxes to set up. Not set at all, it is the boxes on this machine's container engine alone
// (LOCAL_BOXES, Docker's): a plain start probes Docker and offers it when Docker answers, so a new agent lands in its box
// (place.ts); every other box is the operator's to list. Set, it wins: a box it does not list is never probed and is
// unavailable, its reason naming the setting that lists it, an empty value or `none` sets up no box, and a name in it
// that is no box refuses the start. Every reason says what to do next. A local box is probed (`docker version`); a
// vendor's box is offered when the keys its computer provider requires are set (the server's environment, else saved in
// Settings → Computers), and is not asked anything at the start: a key the vendor refuses fails the run's computer
// start, in the vendor's words.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { containerSigns, PROVIDERS, type ProviderEntry } from "@parcha/agentrun-computer";
import { BOX_ALLOW_ENV } from "./box-settings.js";
import { withoutSecrets } from "./secrets.js";

/**
 * Whether a computer provider can be a box, read from its descriptor's facts (PROVIDERS' entry). A place names a box
 * alone, no kind, image or network, so a run in it gets a sandbox computer on that provider with no image named
 * (computer-setting.ts computerOfPlace), resolved and started by the claim as any computer setting is
 * (workspace/resolve-computer.ts, computer-deps.ts computerSpecOf), and it needs:
 * - a Linux shell with files and processes, for bash and the background tools: the provider serves the sandbox kind;
 * - the run's folder in that shell: it takes a bind, an Archil mount or a synced folder (its derived mounts; a provider
 *   whose machines keep their own disk where the folder would be takes none);
 * - an image with none named: its default sandbox image, or the one its prepareImage() makes;
 * - what places.allow says: its computers keep to a host list, or reach nothing (its network forms hold allow or none).
 *   One that reaches only its vendor's own network can't be held to the list.
 * Which mode's folder it takes (a bind in Mode 1, Archil or a synced one in Mode 2) is the run's start's check, as for
 * any computer setting: the mode can change while the server runs.
 */
export const isBox = (entry: ProviderEntry): boolean =>
  entry.kinds.includes("sandbox") &&
  entry.mounts.length > 0 &&
  (entry.defaultImage?.sandbox !== undefined || entry.prepareImage === true) &&
  (entry.network.includes("allow") || entry.network.includes("none"));

/** Every box a place may name, in the order capabilities lists them (Settings' order of providers). */
export const BOX_IDS: readonly string[] = PROVIDERS.filter(isBox).map((entry) => entry.id);

/** The provider entry of box `id`. */
const boxEntry = (id: string): ProviderEntry => PROVIDERS.find((entry) => entry.id === id)!;

/** The boxes on this machine's container engine (their descriptor's `local`: Docker's), the boxes a server sets up when
 *  AGENTRUN_BOXES is not set at all. Their engine is Docker, so a local box is probed at the start with `docker
 *  version` (probeDocker), its computers mount this server's paths (box-paths.ts) and keep out the Docker host's own
 *  addresses (docker-host-addresses.ts). */
export const LOCAL_BOXES: readonly string[] = BOX_IDS.filter((id) => boxEntry(id).local === true);

/** A box as capabilities show it: whether this server has it, and why when not (or how it was checked); `state`, which
 *  capabilities derive from it (place.ts stated). `network`: what an available box reaches (BOX_NETWORKS), with
 *  `network_reason` when it is available and has none for a cause of its own (a daemon elsewhere). `host_addresses`: for Docker from a container (compose.yaml), the Docker host's own addresses
 *  its computers' egress proxy refuses as the host's (docker-host-addresses.ts: the read through the socket and
 *  AGENTRUN_DOCKER_HOST_ADDRESSES). */
export type BoxOffer = { id: string; available: boolean; state?: BoxState; reason?: string; network?: BoxNetwork; network_reason?: string; host_addresses?: string[] };
/** What an available box reaches: the hosts of `places.allow` (`allowlist`), or nothing (`none`). */
export const BOX_NETWORKS = ["allowlist", "none"] as const;
export type BoxNetwork = (typeof BOX_NETWORKS)[number];
/** A box's state in capabilities: ready (available) or unavailable. */
export const BOX_STATES = ["ready", "unavailable"] as const;
export type BoxState = (typeof BOX_STATES)[number];

/** The setting that lists the boxes to set up: a comma list of box ids, empty or `none` for no box. */
export const BOXES_ENV = "AGENTRUN_BOXES";
/** The AGENTRUN_BOXES that sets up no box, as an empty one does. */
const NO_BOXES = "none";
/** Whether `env` leaves the boxes to this server's default (LOCAL_BOXES): AGENTRUN_BOXES is not set at all. */
export const boxesByDefault = (env: NodeJS.ProcessEnv): boolean => env[BOXES_ENV] === undefined;

/** The boxes `env` lists in AGENTRUN_BOXES, LOCAL_BOXES when it is not set, none when it is empty or `none`; a name
 *  that is no box throws, naming it, and so does `none` with another. */
export function enabledBoxes(env: NodeJS.ProcessEnv): Set<string> {
  if (boxesByDefault(env)) return new Set(LOCAL_BOXES);
  const names = env[BOXES_ENV]!.split(",").map((name) => name.trim()).filter(Boolean);
  if (names.includes(NO_BOXES)) {
    if (names.length > 1) throw new Error(`${BOXES_ENV}=${NO_BOXES} sets up no box, so it names no other: list the boxes to set up, or ${NO_BOXES} alone`);
    return new Set();
  }
  const unknown = names.filter((name) => !BOX_IDS.includes(name));
  if (unknown.length) throw new Error(`${BOXES_ENV} names ${unknown.join(", ")}, which ${unknown.length === 1 ? "is not a box" : "are not boxes"}: list any of ${BOX_IDS.join(", ")}`);
  return new Set(names);
}

/** Why box `id` is unavailable when AGENTRUN_BOXES does not list it: the setting that does, keeping what it lists now. */
const notEnabled = (id: string, enabled: ReadonlySet<string>) => `not enabled on this server: start AgentRun with ${BOXES_ENV}=${BOX_IDS.filter((box) => box === id || enabled.has(box)).join(",")}`;
/** The start's log line: the boxes available, the rest, and why each box AGENTRUN_BOXES lists (`listed`) is not available. */
export function boxesLog(offers: readonly BoxOffer[], listed: ReadonlySet<string>): Record<string, string> {
  const ids = (yes: boolean) => offers.filter((offer) => offer.available === yes).map((offer) => offer.id).join(",") || "none";
  const why = offers.filter((offer) => !offer.available && listed.has(offer.id));
  return { available: ids(true), unavailable: ids(false), ...Object.fromEntries(why.map((offer) => [offer.id, offer.reason ?? ""])) };
}

/** Why docker is unavailable when its daemon refuses this server's process its socket (EACCES on /var/run/docker.sock)
 *  and the group file lists this user in the docker group: this process started before the user joined it (a systemd
 *  user manager that has run since, kept by linger), so a restart of that manager, or a new login, gives it the group. */
export const DOCKER_NOT_IN_GROUP = "This server's process isn't in the docker group: restart your user manager with `sudo systemctl restart user@$(id -u)`, or log in again if linger is off";
/** The same, when the group file does not list this user in the docker group (or cannot say): joining comes first. */
export const DOCKER_JOIN_GROUP = "This server's process isn't in the docker group: add this user to it with `sudo usermod -aG docker $USER`, then restart your user manager with `sudo systemctl restart user@$(id -u)`, or log in again if linger is off";

/** Whether the group file lists `user` in the docker group while this process's groups (`ids`) lack that group: a
 *  membership granted after this process started. False when it cannot say (no file, no docker group, users listed
 *  elsewhere, as a directory service lists them). */
async function joinedSince(groups: { file: string; user: string; ids: readonly number[] }): Promise<boolean> {
  const line = (await readFile(groups.file, "utf8").catch(() => "")).split("\n").find((entry) => entry.startsWith("docker:"));
  if (!line) return false;
  const [, , gid, members = ""] = line.split(":");
  return groups.user !== "" && members.split(",").map((name) => name.trim()).includes(groups.user) && !groups.ids.includes(Number(gid));
}
/** This process's user and groups, read from the system's group file: the probe's default for `groups`. A user with no
 *  name (a numeric uid with no passwd entry, as in a container) is none: membership cannot be checked, so joining is said. */
const ownGroups = () => {
  let user = "";
  try {
    user = userInfo().username;
  } catch {}
  return { file: "/etc/group", user, ids: process.getgroups?.() ?? [] };
};
/** No Docker daemon for this server, as Settings → Computers says it (docker-daemon.ts noDockerWords). */
export const NO_DOCKER_HERE = "No Docker on this server: Render and most hosted services run none.";
/** Why docker is unavailable to a server in AgentRun's image that has no Docker socket: a hosted service (Fly.io, Render,
 *  a Kubernetes pod), the one-container `docker run` and deploy/'s compose file give it none, so it asks a daemon that is
 *  not there. Starting Docker or joining its group would not help. Hosted, there is no host socket to give, so the way is
 *  a vendor's computer, as Settings → Computers says (its opening sentence is the same); on a machine the person runs,
 *  compose.yaml at the repository's root mounts the host's socket, which is root on that host (compose.yaml's own header
 *  says so), so the words say that too. */
export const DOCKER_NO_SOCKET = `${NO_DOCKER_HERE} Its agents get file tools and web_fetch but no shell. For a shell, use a vendor computer (Settings → Computers); or, on a machine you run, give this server the host's Docker socket, as \`docker compose up -d\` with compose.yaml at the repository's root does. That socket is root on the host, so give it only where you would give AgentRun root`;
/** The same, for a container given the socket and refused it: the group compose.yaml adds (DOCKER_GID) is not the
 *  socket's. usermod in the container would not last past its restart. */
export const DOCKER_SOCKET_GROUP = "This server's container may not use the Docker socket: set DOCKER_GID in .env to the socket's group, as compose.yaml says, then run `docker compose up -d` again";

/** Where this server runs: on a host, in AgentRun's own image (IMAGE_ENV), or in some other container; and how it tells
 *  whether a path is there (`exists`: the socket a failed probe names). What a failed probe says to do. */
export type ContainerFacts = { where: "host" | "image" | "other"; exists?: (path: string) => boolean };
/** Set by AgentRun's image (packages/serve/docker/Dockerfile): the socket advice (DOCKER_NO_SOCKET, DOCKER_SOCKET_GROUP)
 *  is for it alone, and Kubernetes and other containerd runtimes, which write no mark of their own, run it too. */
export const IMAGE_ENV = "AGENTRUN_IN_IMAGE";
/** A container: AgentRun's image (IMAGE_ENV), or any other that computer's containerSigns sees under `root` (the
 *  filesystem's root; the tests' seam): a runtime's mark or a container's cgroup, such as a Kubernetes pod's. */
export const containerOf = (env: NodeJS.ProcessEnv, root = "/"): ContainerFacts => ({
  where: env[IMAGE_ENV] === "1" ? "image" : containerSigns(root) !== undefined ? "other" : "host",
});
/** A reason in a container that is not AgentRun's image: the host's words, said to be the container's (its own Docker, its
 *  own docker group), never compose.yaml's, which is not there to use. */
const inOtherContainer = (container: ContainerFacts, reason: string): string => (container.where === "other" ? `This server runs in a container. ${reason}` : reason);
/** The daemon address docker names when it cannot connect ("Cannot connect to the Docker daemon at unix:///….sock."):
 *  the one its DOCKER_HOST or current context resolved to. Matched, never shown. */
const DAEMON_AT = /docker daemon at ([a-z]+:\/\/\S+?)\.?(?:\s|$)/i;
/** Whether the socket a failed probe asked is there: the unix socket docker named (DAEMON_AT); any other address (tcp,
 *  ssh) is one; with none named, DOCKER_HOST or DOCKER_CONTEXT is one, else the default /var/run/docker.sock. */
function socketThere(endpoint: string | undefined, env: NodeJS.ProcessEnv, exists: (path: string) => boolean): boolean {
  if (endpoint !== undefined) return endpoint.startsWith("unix://") ? exists(endpoint.slice("unix://".length)) : true;
  return Boolean(env.DOCKER_HOST || env.DOCKER_CONTEXT) || exists("/var/run/docker.sock");
}
/** A failed probe's reason in AgentRun's image, where the host's words (start Docker, usermod) are the wrong fix: a socket
 *  that refused this process (wherever it is) is its group's; a socket that is not there is compose.yaml's. Undefined on
 *  a host and in another container (inOtherContainer), and for a socket that is there and whose daemon does not answer
 *  (the host's Docker is down). */
const containerReason = (answer: { failed?: string; denied?: true; endpoint?: string }, env: NodeJS.ProcessEnv, container: ContainerFacts): string | undefined => {
  if (container.where !== "image" || answer.failed === undefined) return undefined;
  if (answer.denied) return DOCKER_SOCKET_GROUP;
  return socketThere(answer.endpoint, env, container.exists ?? existsSync) ? undefined : DOCKER_NO_SOCKET;
};
/** The daemon address in docker's stderr, when it names one (DAEMON_AT). */
const endpointIn = (stderr: unknown): { endpoint?: string } => {
  const named = DAEMON_AT.exec(String(stderr))?.[1];
  return named !== undefined ? { endpoint: named } : {};
};

/** docker's own words for a socket that refused this process (the CLI's, or the connect's EACCES). Matched, never shown. */
const SOCKET_DENIED = /permission denied while trying to connect to the docker daemon socket|docker\.sock: connect: permission denied/i;

/** How long Docker's probe may take. */
export const PROBE_TIMEOUT_MS = 5_000;

/** What kind of error, never its message: a message can hold an answer's body, a path or a key. */
function errorName(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code)) return code;
  return error instanceof Error ? error.name : "not an error";
}

/** What `docker version` says of this machine's Docker daemon: it answers (`up`), or why not. `absent`: no daemon
 *  answers this process (no docker command, a call that fails, or one that names no daemon); not absent: one is there,
 *  and its socket refuses this process (the group it lacks). */
export type DockerDaemon = { readonly up: true } | { readonly up: false; readonly absent: boolean; readonly reason: string };

/** Asks this machine's Docker daemon its version (`docker version`), as the Docker computer's check (docker-daemon.ts)
 *  does: the CLI is on PATH and its daemon answers this user. `signal` bounds it. */
export async function askDockerDaemon(env: NodeJS.ProcessEnv, signal: AbortSignal, groups: { file: string; user: string; ids: readonly number[] } = ownGroups(), container: ContainerFacts = containerOf(env)): Promise<DockerDaemon> {
  // Its environment is the server's through the cut a run's takes (withoutSecrets): no box key, no other secret, no
  // name shaped like a key.
  const dockerEnv = withoutSecrets(env);
  const answer = await new Promise<{ failed?: string; denied?: true; endpoint?: string; out: string }>((resolve) =>
    execFile("docker", ["version", "--format", "{{.Server.Version}}"], { env: dockerEnv, signal, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      const code = (error as { code?: unknown } | null)?.code;
      resolve({ ...(error ? { failed: typeof code === "number" ? `exit ${code}` : errorName(error), ...(SOCKET_DENIED.test(String(stderr)) ? { denied: true as const } : {}), ...endpointIn(stderr) } : {}), out: String(stdout) });
    }),
  );
  // An absent daemon's reason is read by no one: Settings → Computers and a run's start say noDockerWords instead
  // (computers.ts, resolve-computer.ts), so only a refused socket's words are said to be another container's.
  const absent = (reason: string): DockerDaemon => ({ up: false, absent: true, reason });
  // The box's probe runs once, at the start: each fix takes a restart. Docker is on by default, so its reason is often a
  // first-time user's first read: what is wrong in plain words, what the probe saw, then what to do.
  // In AgentRun's image, a socket that refused this process is that socket's group's to fix (containerReason), never the
  // host's; a socket that is not there is no daemon, which every reader words as none (noDockerWords).
  const inside = answer.denied ? containerReason(answer, env, container) : undefined;
  if (inside !== undefined) return { up: false, absent: false, reason: inside };
  if (answer.failed === "ENOENT") return absent("Docker isn't running on this machine (no docker command on PATH): install or start Docker, then restart AgentRun");
  // Its socket refused this process: the group it lacks, and how to get it without a reboot (the words, never docker's):
  // a restart alone where the group file already lists this user, else joining it first.
  if (answer.denied) return { up: false, absent: false, reason: inOtherContainer(container, (await joinedSince(groups)) ? DOCKER_NOT_IN_GROUP : DOCKER_JOIN_GROUP) };
  if (answer.failed) return absent(`Docker isn't running on this machine, or this user may not use it (docker version failed: ${answer.failed}): start Docker, or add this user to the docker group, then restart AgentRun`);
  if (!answer.out.trim()) return absent("Docker isn't running on this machine (docker version named no daemon): start Docker, then restart AgentRun");
  return { up: true };
}

/** Docker's offer: `docker version` names the daemon's version, so the CLI is on PATH and its daemon answers this user.
 *  The same call names the daemon's architecture, told to `arch` when it does. Bounded by `timeoutMs`; never rejects. */
async function probeDocker(env: NodeJS.ProcessEnv, timeoutMs: number, groups: { file: string; user: string; ids: readonly number[] }, container: ContainerFacts, arch?: (arch: string) => void): Promise<BoxOffer> {
  const no = (reason: string): BoxOffer => ({ id: "docker", available: false, reason: inOtherContainer(container, reason) });
  // Its environment is the server's through the cut a run's takes (withoutSecrets): no box key, no other secret, no
  // name shaped like a key.
  const dockerEnv = withoutSecrets(env);
  const answer = await new Promise<{ failed?: string; denied?: true; late?: true; endpoint?: string; out: string }>((resolve) =>
    execFile("docker", ["version", "--format", "{{.Server.Version}} {{.Server.Arch}}"], { env: dockerEnv, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      const failed = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      const code = failed?.code;
      resolve({ ...(failed ? { failed: typeof code === "number" ? `exit ${code}` : errorName(failed), ...(failed.killed ? { late: true as const } : {}), ...(SOCKET_DENIED.test(String(stderr)) ? { denied: true as const } : {}), ...endpointIn(stderr) } : {}), out: String(stdout) });
    }),
  );
  // Docker is on by default, so its reason is often a first-time user's first read: what is wrong in plain words, what
  // the probe saw, then what to do.
  if (answer.late) return no(`Docker isn't answering on this machine (docker version took over ${timeoutMs} ms): start Docker, then restart AgentRun`);
  const inside = containerReason(answer, env, container);
  if (inside !== undefined) return no(inside);
  if (answer.failed === "ENOENT") return no("Docker isn't running on this machine (no docker command on PATH): install or start Docker, then restart AgentRun");
  // Its socket refused this process: the group it lacks, and how to get it without a reboot (the words, never docker's):
  // a restart alone where the group file already lists this user, else joining it first.
  if (answer.denied) return no((await joinedSince(groups)) ? DOCKER_NOT_IN_GROUP : DOCKER_JOIN_GROUP);
  if (answer.failed) return no(`Docker isn't running on this machine, or this user may not use it (docker version failed: ${answer.failed}): start Docker, or add this user to the docker group, then restart AgentRun`);
  if (!answer.out.trim()) return no("Docker isn't running on this machine (docker version named no daemon): start Docker, then restart AgentRun");
  const named = /^\S+\s+(\S+)$/.exec(answer.out.trim())?.[1];
  if (named !== undefined) arch?.(named);
  return { id: "docker", available: true };
}

/** A vendor's box's offer: available when every key its computer provider requires is set, read as a run's claim reads
 *  it (`keyOf`: the server's environment, else the key saved in Settings → Computers); nothing is asked of the vendor. */
async function remoteOffer(id: string, keyOf: (name: string) => Promise<string | undefined>): Promise<BoxOffer> {
  const required = boxEntry(id).keys.filter((key) => key.required).map((key) => key.name);
  const missing: string[] = [];
  for (const name of required) if ((await keyOf(name)) === undefined) missing.push(name);
  if (missing.length) return { id, available: false, reason: `needs ${missing.join(" and ")}` };
  return { id, available: true, reason: "configured; not probed at start" };
}

/** What placeOffers takes beyond the environment. */
export type PlaceOffersOptions = {
  /** A provider key's value as a run's claim reads it (key-meta.ts keyReader); default `env`'s alone. */
  keyOf?: (name: string) => Promise<string | undefined>;
  /** Docker's probe's bound (PROBE_TIMEOUT_MS). */
  timeoutMs?: number;
  /** The group file and this process's user and groups, which say whether a refused docker socket is a membership
   *  granted since this process started; default the system's. */
  groups?: { file: string; user: string; ids: readonly number[] };
  /** Whether this server runs in a container, and how a path is checked, which say a failed probe's fix (containerReason);
   *  default this process's. */
  container?: ContainerFacts;
  /** Under --faux only: the local box answers, whatever AGENTRUN_BOXES lists, and nothing asks Docker. */
  fauxDocker?: boolean;
  /** Told the architecture of the Docker daemon the probe found (amd64, arm64), when Docker answers and names it: the
   *  server's check that a Docker computer's daemon is built for it (box-paths.ts dockerComputerRefusal) asks Docker
   *  nothing more. */
  dockerArch?: (arch: string) => void;
};

/** Every box, in BOX_IDS order, as this server has it at its start (`env`: its environment, its secrets readable): a box
 *  AGENTRUN_BOXES does not list is not enabled; a local box by Docker's probe (or `fauxDocker`); a vendor's by its
 *  provider's required keys. Rejects only for a name in AGENTRUN_BOXES that is no box. No reason holds a key or an
 *  answer's body. */
export async function placeOffers(env: NodeJS.ProcessEnv, options: PlaceOffersOptions = {}): Promise<BoxOffer[]> {
  const enabled = enabledBoxes(env);
  const keyOf = options.keyOf ?? (async (name: string) => env[name] || undefined);
  return Promise.all(
    BOX_IDS.map(async (id): Promise<BoxOffer> => {
      const local = LOCAL_BOXES.includes(id);
      // The tests' faux docker stands in whatever AGENTRUN_BOXES lists, as the old faux box did.
      if (local && options.fauxDocker) return { id, available: true, reason: "a faux docker (tests)" };
      if (!enabled.has(id)) return { id, available: false, reason: notEnabled(id, enabled) };
      // A local box's engine is Docker (LOCAL_BOXES), so its probe is Docker's own, which answers as the docker box.
      if (local) return probeDocker(env, options.timeoutMs ?? PROBE_TIMEOUT_MS, options.groups ?? ownGroups(), options.container ?? containerOf(env), options.dockerArch);
      return remoteOffer(id, keyOf);
    }),
  );
}

/** What each available box reaches, from the server's host list (`allow`, box-settings.ts boxAllowOf). A local box's
 *  computers through their egress proxy (an allowlist), with the Docker host's own addresses it refuses when the server
 *  runs in a container (`local.hostAddresses`), or unavailable where `local.refused` says Docker can't run a computer
 *  here (box-paths.ts dockerComputerRefusal, docker-host-addresses.ts noHostAddresses). A vendor's box as its provider's
 *  network forms say: the list where its computers keep to one, through the egress proxy their init starts
 *  (@parcha/agentrun-computer's hosted/network.ts); nothing where they make no network but none, as the claim narrows
 *  them (computer-deps.ts networkOf), saying so. With `allow` none, none has a network. */
export function withNetworks(offers: readonly BoxOffer[], allow: readonly string[] | "none", local: { refused?: string; hostAddresses?: readonly string[]; faux?: boolean } = {}): BoxOffer[] {
  return offers.map((offer): BoxOffer => {
    if (!offer.available) return offer;
    if (LOCAL_BOXES.includes(offer.id)) {
      if (local.refused !== undefined) return { id: offer.id, available: false, state: "unavailable", reason: local.refused };
      if (local.faux) return { ...offer, network: "none", network_reason: "a faux docker (tests)" };
      if (allow === "none") return { ...offer, network: "none", network_reason: "AGENTRUN_BOX_ALLOW is none" };
      return { ...offer, network: "allowlist", ...(local.hostAddresses?.length ? { host_addresses: [...local.hostAddresses] } : {}) };
    }
    if (allow === "none") return { ...offer, network: "none" };
    const entry = boxEntry(offer.id);
    if (entry.network.includes("allow")) return { ...offer, network: "allowlist" };
    return { ...offer, network: "none", network_reason: `${entry.label}'s computers run with no network, whatever ${BOX_ALLOW_ENV} lists` };
  });
}
