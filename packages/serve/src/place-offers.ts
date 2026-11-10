// The boxes a place may name, as capabilities show them (places.boxes), read from the computers runs execute on: a
// sandbox place on box X is a sandbox computer on provider X (computer-setting.ts computerOfPlace), which a run's claim
// starts (workspace/). Read once, at the server's start: each fix takes a restart.
//
// AGENTRUN_BOXES lists the boxes to set up. Not set at all, it is docker alone (DEFAULT_BOXES): a plain start probes
// Docker and offers it when Docker answers, so a new agent lands in its box (place.ts); every other box is the operator's
// to list. Set, it wins: a box it does not list is never probed and is unavailable, its reason naming the setting that
// lists it, an empty value or `none` sets up no box, and a name in it that is no box refuses the start. Every reason says
// what to do next. Docker is probed (`docker version`); Daytona and Modal are offered when the keys their computer
// provider requires are set (the server's environment, else saved in Settings → Computers), and are not asked anything
// at the start: a key the vendor refuses fails the run's computer start, in the vendor's words. bwrap is in no release.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { PROVIDERS } from "@parcha/agentrun-computer";
import { withoutSecrets } from "./secrets.js";

/** Why a remote box (Daytona's, Modal's) has no network, said in capabilities whenever the server's host list is set:
 *  its computer is made with no network (Daytona) or no network or an open one (Modal), never with a host list, so a
 *  list is narrowed to none (workspace/computer-deps.ts networkOf). */
export const remoteNoList = (id: "daytona" | "modal"): string => `a ${id === "daytona" ? "Daytona" : "Modal"} computer is never made with a host list, so a ${id} box has no network`;

/** Every box a place may name, in the order capabilities lists them. */
export const BOX_IDS = ["bwrap", "docker", "modal", "daytona"] as const;
export type BoxId = (typeof BOX_IDS)[number];

/** A box as capabilities show it: whether this server has it, and why when not (or how it was checked). `state`, set
 *  where the server knows more than the probe did (box-image.ts): `preparing` is available, its image still coming. `network`: what an available box reaches (BOX_NETWORKS), with `network_reason` when
 *  it is available and has none for a cause of its own (a Docker in a VM, a daemon elsewhere; a Daytona that could not
 *  keep its domain list). `host_addresses`: for Docker from a container (compose.yaml), the Docker host's own addresses
 *  its computers' egress proxy refuses as the host's (docker-host-addresses.ts: the read through the socket and
 *  AGENTRUN_DOCKER_HOST_ADDRESSES). */
export type BoxOffer = { id: BoxId; available: boolean; state?: BoxState; reason?: string; network?: BoxNetwork; network_reason?: string; host_addresses?: string[] };
/** What an available box reaches: the hosts of `places.allow` (`allowlist`), or nothing (`none`). */
export const BOX_NETWORKS = ["allowlist", "none"] as const;
export type BoxNetwork = (typeof BOX_NETWORKS)[number];
/** A box's state in capabilities: ready, preparing (available; a run's first box waits for its image), or unavailable. */
export const BOX_STATES = ["ready", "preparing", "unavailable"] as const;
export type BoxState = (typeof BOX_STATES)[number];

/** The remote boxes' keys: secrets the server holds and its computer providers read, which no run is handed
 *  (run-secrets.ts SERVER_ONLY). */
export const BOX_KEYS: readonly string[] = ["DAYTONA_API_KEY", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"];

/** The setting that lists the boxes to set up: a comma list of box ids, empty or `none` for no box. */
export const BOXES_ENV = "AGENTRUN_BOXES";
/** The boxes a server sets up when AGENTRUN_BOXES is not set at all: Docker, probed as if listed. */
export const DEFAULT_BOXES: readonly BoxId[] = ["docker"];
/** The AGENTRUN_BOXES that sets up no box, as an empty one does. */
const NO_BOXES = "none";
/** Whether `env` leaves the boxes to this server's default (DEFAULT_BOXES): AGENTRUN_BOXES is not set at all. */
export const boxesByDefault = (env: NodeJS.ProcessEnv): boolean => env[BOXES_ENV] === undefined;

/** The boxes `env` lists in AGENTRUN_BOXES, DEFAULT_BOXES when it is not set, none when it is empty or `none`; a name
 *  that is no box throws, naming it, and so does `none` with another. */
export function enabledBoxes(env: NodeJS.ProcessEnv): Set<BoxId> {
  if (boxesByDefault(env)) return new Set(DEFAULT_BOXES);
  const names = env[BOXES_ENV]!.split(",").map((name) => name.trim()).filter(Boolean);
  if (names.includes(NO_BOXES)) {
    if (names.length > 1) throw new Error(`${BOXES_ENV}=${NO_BOXES} sets up no box, so it names no other: list the boxes to set up, or ${NO_BOXES} alone`);
    return new Set();
  }
  const unknown = names.filter((name) => !(BOX_IDS as readonly string[]).includes(name));
  if (unknown.length) throw new Error(`${BOXES_ENV} names ${unknown.join(", ")}, which ${unknown.length === 1 ? "is not a box" : "are not boxes"}: list any of ${BOX_IDS.join(", ")}`);
  return new Set(names as BoxId[]);
}

/** Why box `id` is unavailable when AGENTRUN_BOXES does not list it: the setting that does, keeping what it lists now. */
const notEnabled = (id: BoxId, enabled: ReadonlySet<BoxId>) => `not enabled on this server: start AgentRun with ${BOXES_ENV}=${BOX_IDS.filter((box) => box === id || enabled.has(box)).join(",")}`;
/** The start's log line: the boxes available, the rest, and why each box AGENTRUN_BOXES lists (`listed`) is not available. */
export function boxesLog(offers: readonly BoxOffer[], listed: ReadonlySet<BoxId>): Record<string, string> {
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

/** Docker's offer: `docker version` names the daemon's version, so the CLI is on PATH and its daemon answers this user.
 *  Bounded by `timeoutMs`; never rejects. */
async function probeDocker(env: NodeJS.ProcessEnv, timeoutMs: number, groups: { file: string; user: string; ids: readonly number[] }): Promise<BoxOffer> {
  const no = (reason: string): BoxOffer => ({ id: "docker", available: false, reason });
  // Its environment is the server's through the cut a run's takes (withoutSecrets): no box key, no other secret, no
  // name shaped like a key.
  const dockerEnv = withoutSecrets(env);
  const answer = await new Promise<{ failed?: string; denied?: true; late?: true; out: string }>((resolve) =>
    execFile("docker", ["version", "--format", "{{.Server.Version}}"], { env: dockerEnv, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      const failed = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      const code = failed?.code;
      resolve({ ...(failed ? { failed: typeof code === "number" ? `exit ${code}` : errorName(failed), ...(failed.killed ? { late: true as const } : {}), ...(SOCKET_DENIED.test(String(stderr)) ? { denied: true as const } : {}) } : {}), out: String(stdout) });
    }),
  );
  // Docker is on by default, so its reason is often a first-time user's first read: what is wrong in plain words, what
  // the probe saw, then what to do.
  if (answer.late) return no(`Docker isn't answering on this machine (docker version took over ${timeoutMs} ms): start Docker, then restart AgentRun`);
  if (answer.failed === "ENOENT") return no("Docker isn't running on this machine (no docker command on PATH): install or start Docker, then restart AgentRun");
  // Its socket refused this process: the group it lacks, and how to get it without a reboot (the words, never docker's):
  // a restart alone where the group file already lists this user, else joining it first.
  if (answer.denied) return no((await joinedSince(groups)) ? DOCKER_NOT_IN_GROUP : DOCKER_JOIN_GROUP);
  if (answer.failed) return no(`Docker isn't running on this machine, or this user may not use it (docker version failed: ${answer.failed}): start Docker, or add this user to the docker group, then restart AgentRun`);
  if (!answer.out.trim()) return no("Docker isn't running on this machine (docker version named no daemon): start Docker, then restart AgentRun");
  return { id: "docker", available: true };
}

/** A remote box's offer: available when every key its computer provider requires is set, read as a run's claim reads
 *  it (`keyOf`: the server's environment, else the key saved in Settings → Computers); nothing is asked of the vendor. */
async function remoteOffer(id: "daytona" | "modal", keyOf: (name: string) => Promise<string | undefined>): Promise<BoxOffer> {
  const required = (PROVIDERS.find((entry) => entry.id === id)?.keys ?? []).filter((key) => key.required).map((key) => key.name);
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
  /** Under --faux only: Docker answers, whatever AGENTRUN_BOXES lists, and nothing asks it. */
  fauxDocker?: boolean;
};

/** Every box, in BOX_IDS order, as this server has it at its start (`env`: its environment, its secrets readable): bwrap
 *  is in no release; a box AGENTRUN_BOXES does not list is not enabled; docker by its probe (or `fauxDocker`); daytona
 *  and modal by their keys. Rejects only for a name in AGENTRUN_BOXES that is no box. No reason holds a key or an answer's body. */
export async function placeOffers(env: NodeJS.ProcessEnv, options: PlaceOffersOptions = {}): Promise<BoxOffer[]> {
  const enabled = enabledBoxes(env);
  const keyOf = options.keyOf ?? (async (name: string) => env[name] || undefined);
  return Promise.all(
    BOX_IDS.map(async (id): Promise<BoxOffer> => {
      if (id === "bwrap") return { id, available: false, reason: NOT_YET };
      // The tests' faux docker stands in whatever AGENTRUN_BOXES lists, as the old faux box did.
      if (id === "docker" && options.fauxDocker) return { id, available: true, reason: "a faux docker (tests)" };
      if (!enabled.has(id)) return { id, available: false, reason: notEnabled(id, enabled) };
      if (id === "docker") return probeDocker(env, options.timeoutMs ?? PROBE_TIMEOUT_MS, options.groups ?? ownGroups());
      return remoteOffer(id, keyOf);
    }),
  );
}
const NOT_YET = "the bwrap box is not in this release yet: use the docker box";

/** What each available box reaches, from the server's host list (`allow`, box-settings.ts boxAllowOf): Docker's
 *  computers through their egress proxy (an allowlist), with the Docker host's own addresses it refuses when the server
 *  runs in a container (`hostAddresses`), or unavailable where `dockerRefused` says Docker can't run a computer here
 *  (box-paths.ts dockerComputerRefusal, docker-host-addresses.ts noHostAddresses); Daytona's and Modal's none
 *  (remoteNoList). With `allow` none, none has a network. */
export function withNetworks(offers: readonly BoxOffer[], allow: readonly string[] | "none", docker: { refused?: string; hostAddresses?: readonly string[]; faux?: boolean } = {}): BoxOffer[] {
  return offers.map((offer): BoxOffer => {
    if (!offer.available) return offer;
    if (offer.id === "docker") {
      if (docker.refused !== undefined) return { id: offer.id, available: false, state: "unavailable", reason: docker.refused };
      if (docker.faux) return { ...offer, network: "none", network_reason: "a faux docker (tests)" };
      if (allow === "none") return { ...offer, network: "none", network_reason: "AGENTRUN_BOX_ALLOW is none" };
      return { ...offer, network: "allowlist", ...(docker.hostAddresses?.length ? { host_addresses: [...docker.hostAddresses] } : {}) };
    }
    if (allow === "none" || (offer.id !== "daytona" && offer.id !== "modal")) return { ...offer, network: "none" };
    return { ...offer, network: "none", network_reason: remoteNoList(offer.id) };
  });
}
