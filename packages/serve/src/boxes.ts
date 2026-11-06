// The boxes this server can give a run: Docker, Daytona and a VM provider, each a pi-transport provider built from the
// server's settings and probed once at its start. bwrap comes later. The registry says which boxes this server has, why
// it lacks the others, and hands out an available box's provider (and the VM box's client, for the box relay).
//
// AGENTRUN_BOXES lists the boxes to set up. Not set at all, it is docker alone (DEFAULT_BOXES): a plain start probes
// Docker and offers it when Docker answers, so a new agent lands in its box (place.ts); every other box is the operator's
// to list. Set, it wins: a box it does not list is never probed and is unavailable, its reason naming the setting that
// lists it, an empty value or `none` sets up no box, and a name in it that is no box refuses the start. Every reason says
// what to do next.
// pi-transport is a dependency of this package (a plain install has the Docker box) and the VM provider's SDK is the
// host's; each is loaded by the
// probe that needs it, and a box whose module is not installed says what to install. The keys are the server's own: the
// launcher hands them over with its other secrets (secrets.ts), the probes read them here, and no run's process is
// handed one (SERVER_ONLY in runs.ts).
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { BoxProvider } from "@parcha/pi-transport";
import { withoutSecrets } from "./secrets.js";

/** Why the VM box has no network, said in capabilities whenever the server's host list is set: its provider's SDK takes
 *  a domain list at a sandbox's create, but has no read of a sandbox's network back, so the server could not check that
 *  a box holds the list it asked for (as it does Daytona's), and it never leaves the provider's open default either. */
export const VM_NO_LIST = "the Modal sandbox takes a host list, but this server cannot read a sandbox's list back to check that it holds, so the Modal sandbox has no network";
/** The VM provider: its box id, which is also its SDK's npm name, the SDK's client class and the token's names. */
export const VM_PROVIDER = { id: "modal", client: "ModalClient", keys: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"] } as const;
const VM = VM_PROVIDER.id;

/** Every box a place may name, in the order capabilities lists them. */
export const BOX_IDS = ["bwrap", "docker", VM, "daytona"] as const;
export type BoxId = (typeof BOX_IDS)[number];

/** One box: whether this server has it, and why when not (or how it was checked). `state`, set where the server knows
 *  more than the probe did (box-image.ts): `preparing` is available, its image still coming. */
/** A box as capabilities show it. `network`: what an available box reaches (BOX_NETWORKS), with `network_reason` when
 *  it is available and has none for a cause of its own (a Docker in a VM, a daemon elsewhere; a Daytona that could not
 *  keep its domain list). */
export type BoxOffer = { id: BoxId; available: boolean; state?: BoxState; reason?: string; network?: BoxNetwork; network_reason?: string };
/** What an available box reaches: the hosts of `places.allow` (`allowlist`), or nothing (`none`). */
export const BOX_NETWORKS = ["allowlist", "none"] as const;
export type BoxNetwork = (typeof BOX_NETWORKS)[number];
/** A box's state in capabilities: ready, preparing (available; a run's first box waits for its image), or unavailable. */
export const BOX_STATES = ["ready", "preparing", "unavailable"] as const;
export type BoxState = (typeof BOX_STATES)[number];

/** The boxes this server set up at its start. */
export type BoxRegistry = {
  /** Every box, in BOX_IDS order. */
  offers(): BoxOffer[];
  /** An available box's provider; undefined for any other. */
  provider(id: BoxId): BoxProvider | undefined;
  /** The VM box's SDK client, when it is available: the box relay makes a run's calls with it (box-relay-vm.ts). */
  vmClient(): unknown;
};
/** What boxRegistry takes beyond the environment: the probes' bound, and, for tests only, the module that stands in for
 *  the VM provider's SDK (startServe's `fauxVm`, under --faux) and the group file and this process's groups that say
 *  whether a refused docker socket is a membership granted since this process started (`groups`). */
export type BoxRegistryOptions = { timeoutMs?: number; vmSdk?: () => Promise<Record<string, unknown>>; groups?: { file: string; user: string; ids: readonly number[] } };

/** The setting that lists the boxes to set up: a comma list of box ids, empty or `none` for no box. */
export const BOXES_ENV = "AGENTRUN_BOXES";
/** The boxes a server sets up when AGENTRUN_BOXES is not set at all: Docker, probed as if listed. */
export const DEFAULT_BOXES: readonly BoxId[] = ["docker"];
/** The AGENTRUN_BOXES that sets up no box, as an empty one does. */
const NO_BOXES = "none";
/** The VM provider's app, which its sandboxes live in (made when missing). */
export const BOX_APP_ENV = "AGENTRUN_BOX_APP";
const DEFAULT_BOX_APP = "agentrun";
const DAYTONA_KEY = "DAYTONA_API_KEY";
/** Daytona's API when DAYTONA_API_URL names none: pi-transport's own default. */
export const DAYTONA_API_URL = "https://app.daytona.io/api";

/** Daytona's API and this server's key for it, from its environment (its secrets readable); undefined without a key. The
 *  key goes to the server's Daytona provider and its box relay, never further (box-relay.ts). */
export function daytonaApi(env: NodeJS.ProcessEnv): { apiKey: string; apiUrl: string } | undefined {
  const apiKey = env[DAYTONA_KEY];
  return apiKey ? { apiKey, apiUrl: env.DAYTONA_API_URL || DAYTONA_API_URL } : undefined;
}
/** The boxes' keys: secrets the server holds and the probes read, which no run's process is handed (runs.ts). */
export const BOX_KEYS: readonly string[] = [DAYTONA_KEY, ...VM_PROVIDER.keys];

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
  return members.split(",").map((name) => name.trim()).includes(groups.user) && !groups.ids.includes(Number(gid));
}
/** This process's user and groups, read from the system's group file: the probe's default for `groups`. */
const ownGroups = () => ({ file: "/etc/group", user: userInfo().username, ids: process.getgroups?.() ?? [] });
/** docker's own words for a socket that refused this process (the CLI's, or the connect's EACCES). Matched, never shown. */
const SOCKET_DENIED = /permission denied while trying to connect to the docker daemon socket|docker\.sock: connect: permission denied/i;

/** How long one box's probe may take; the probes run at once, so this bounds them all. */
export const PROBE_TIMEOUT_MS = 5_000;

/** Why box `id` is unavailable when AGENTRUN_BOXES does not list it: the setting that does, keeping what it lists now. */
const notEnabled = (id: BoxId, enabled: ReadonlySet<BoxId>) => `not enabled on this server: start AgentRun with ${BOXES_ENV}=${BOX_IDS.filter((box) => box === id || enabled.has(box)).join(",")}`;
const NOT_YET = "the bwrap box is not in this release yet: use the docker box";
const NOT_PROBED = "configured; not probed at start";
const TRANSPORT = "@parcha/pi-transport";

type Probed = { offer: BoxOffer; provider?: BoxProvider; client?: unknown };
const unavailable = (id: BoxId, reason: string): Probed => ({ offer: { id, available: false, reason } });
const available = (id: BoxId, provider: BoxProvider, reason?: string, client?: unknown): Probed => ({ offer: { id, available: true, ...(reason ? { reason } : {}) }, provider, ...(client === undefined ? {} : { client }) });

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

/** The boxes `env` (the server's environment, its secrets readable) lists, each probed once, all at once, each within
 *  `timeoutMs`. Rejects only for a name that is no box: a probe that fails, throws or takes too long leaves its box
 *  unavailable, with a short reason that holds no key and no answer's body. */
export async function boxRegistry(env: NodeJS.ProcessEnv, options: BoxRegistryOptions = {}): Promise<BoxRegistry> {
  const enabled = enabledBoxes(env);
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const probed = await Promise.all(
    BOX_IDS.map((id) => {
      if (id === "bwrap") return unavailable(id, NOT_YET);
      if (!enabled.has(id)) return unavailable(id, notEnabled(id, enabled));
      return bounded(id, timeoutMs, (signal) => PROBES[id](env, signal, options));
    }),
  );
  return {
    offers: () => probed.map(({ offer }) => ({ ...offer })),
    provider: (id) => probed.find(({ offer }) => offer.id === id && offer.available)?.provider,
    vmClient: () => probed.find(({ offer }) => offer.id === VM && offer.available)?.client,
  };
}

/** The start's log line: the boxes available, the rest, and why each box AGENTRUN_BOXES lists (`listed`) is not available. */
export function boxesLog(offers: readonly BoxOffer[], listed: ReadonlySet<BoxId>): Record<string, string> {
  const ids = (yes: boolean) => offers.filter((offer) => offer.available === yes).map((offer) => offer.id).join(",") || "none";
  const why = offers.filter((offer) => !offer.available && listed.has(offer.id));
  return { available: ids(true), unavailable: ids(false), ...Object.fromEntries(why.map((offer) => [offer.id, offer.reason ?? ""])) };
}

/** `probe`, aborted after `timeoutMs`. Never rejects. */
async function bounded(id: BoxId, timeoutMs: number, probe: (signal: AbortSignal) => Promise<Probed>): Promise<Probed> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<Probed>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(unavailable(id, id === "docker" ? `Docker isn't answering on this machine (docker version took over ${timeoutMs} ms): start Docker, then restart AgentRun` : `its probe did not finish within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([probe(controller.signal).catch((error: unknown) => unavailable(id, `its probe failed (${errorName(error)})`)), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** What kind of error, never its message: a message can hold an answer's body, a path or a key. */
function errorName(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code)) return code;
  return error instanceof Error ? error.name : "not an error";
}

type Loaded<T> = { ok: true; value: T } | { ok: false; reason: string };
/** A module of package `name`, which may not be installed: then the box says to install it. */
async function load<T>(name: string, importer: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, value: await importer() };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException | null)?.code === "ERR_MODULE_NOT_FOUND" && String((error as Error).message).includes(`'${name}'`);
    return { ok: false, reason: missing ? `install ${name} to use this box` : `${name} did not load (${errorName(error)})` };
  }
}

const PROBES: Record<Exclude<BoxId, "bwrap">, (env: NodeJS.ProcessEnv, signal: AbortSignal, options: BoxRegistryOptions) => Promise<Probed>> = {
  /** `docker version` names the daemon's version: the CLI is on PATH and its daemon answers this user. */
  async docker(env, signal, options) {
    const boxes = await load(TRANSPORT, () => import("@parcha/pi-transport/box/docker").then((module) => module.dockerBoxes));
    if (!boxes.ok) return unavailable("docker", boxes.reason);
    // Its environment is the server's through the cut a run's takes (withoutSecrets): no box key, no other secret, no
    // name shaped like a key.
    const dockerEnv = withoutSecrets(env);
    const answer = await new Promise<{ failed?: string; denied?: true; out: string }>((resolve) =>
      execFile("docker", ["version", "--format", "{{.Server.Version}}"], { env: dockerEnv, signal, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        resolve({ ...(error ? { failed: typeof code === "number" ? `exit ${code}` : errorName(error), ...(SOCKET_DENIED.test(String(stderr)) ? { denied: true as const } : {}) } : {}), out: String(stdout) });
      }),
    );
    // The probe runs once, at the start: each fix takes a restart. Docker is on by default, so its reason is often a
    // first-time user's first read: what is wrong in plain words, what the probe saw, then what to do.
    if (answer.failed === "ENOENT") return unavailable("docker", "Docker isn't running on this machine (no docker command on PATH): install or start Docker, then restart AgentRun");
    // Its socket refused this process: the group it lacks, and how to get it without a reboot (the words, never docker's):
    // a restart alone where the group file already lists this user, else joining it first.
    if (answer.denied) return unavailable("docker", (await joinedSince(options.groups ?? ownGroups())) ? DOCKER_NOT_IN_GROUP : DOCKER_JOIN_GROUP);
    if (answer.failed) return unavailable("docker", `Docker isn't running on this machine, or this user may not use it (docker version failed: ${answer.failed}): start Docker, or add this user to the docker group, then restart AgentRun`);
    if (!answer.out.trim()) return unavailable("docker", "Docker isn't running on this machine (docker version named no daemon): start Docker, then restart AgentRun");
    return available("docker", boxes.value());
  },

  /** One authenticated read the provider makes anyway: the box with a name no box has (lowercase letters, digits and
   *  dashes). An answer of no such box (404) means Daytona took the key; 401 or 403 means it refused it. */
  async daytona(env, signal) {
    const apiKey = env[DAYTONA_KEY];
    if (!apiKey) return unavailable("daytona", `needs ${DAYTONA_KEY}`);
    const apiUrl = env.DAYTONA_API_URL || undefined;
    if (apiUrl !== undefined && !URL.canParse(apiUrl)) return unavailable("daytona", "DAYTONA_API_URL is not a URL");
    const boxes = await load(TRANSPORT, () => import("@parcha/pi-transport/box/daytona").then((module) => module.daytonaBoxes));
    if (!boxes.ok) return unavailable("daytona", boxes.reason);
    const provider = boxes.value({ apiKey, ...(apiUrl ? { apiUrl } : {}), ...(env.DAYTONA_TARGET ? { target: env.DAYTONA_TARGET } : {}) });
    const found = await provider.attach(`agentrun-probe-${randomUUID()}`, withAbortSignal(signal, BACKGROUND_CONTEXT));
    if (found.ok) return available("daytona", provider);
    if (found.error.code === "unauthorized") return unavailable("daytona", `Daytona refused ${DAYTONA_KEY}`);
    return unavailable("daytona", `Daytona did not answer the probe (${found.error.code})`);
  },

  /** The SDK is installed and the token is set; nothing is asked of the provider at start. The client gets the token as
   *  arguments: the server's environment does not hold it (secrets.ts). */
  async [VM](env, _signal, options) {
    const missing = VM_PROVIDER.keys.filter((name) => !env[name]);
    if (missing.length) return unavailable(VM, `needs ${missing.join(" and ")}`);
    const boxes = await load(TRANSPORT, () => import("@parcha/pi-transport/box/modal").then((module) => module.modalBoxes));
    if (!boxes.ok) return unavailable(VM, boxes.reason);
    const vmBoxes = boxes.value;
    type Sdk = Parameters<typeof vmBoxes>[0];
    // The SDK is not a dependency of this package (the host installs it), so its name is a value here, not a literal import.
    const sdk = await load(VM, options.vmSdk ?? (() => import(VM) as Promise<Record<string, unknown>>));
    if (!sdk.ok) return unavailable(VM, sdk.reason);
    const Client = sdk.value[VM_PROVIDER.client];
    if (typeof Client !== "function") return unavailable(VM, `the installed ${VM} package has no ${VM_PROVIDER.client}`);
    const [tokenId, tokenSecret] = VM_PROVIDER.keys.map((name) => env[name] as string);
    let client: Sdk;
    try {
      client = new (Client as new (params: { tokenId: string; tokenSecret: string }) => Sdk)({ tokenId, tokenSecret });
    } catch (error) {
      return unavailable(VM, `its SDK's client did not start (${errorName(error)})`);
    }
    return available(VM, vmBoxes(client, { appName: env[BOX_APP_ENV] || DEFAULT_BOX_APP }), NOT_PROBED, client);
  },
};
