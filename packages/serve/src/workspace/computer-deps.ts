// A run's computer, composed once per process: the runner (runner/main.ts) and the server both take computerForClaim and
// its process-wide deps from computerDepsFrom, so nothing composes them a second time. A spec builder adds only the
// claim's own (its mode, its Workspace, the seal key, the Archil mount's revoke). The computerForClaim it gives
// (claimComputer) reads what the run's launch lets the computer reach (box_allow) from the launch row: none for a runner
// place, Docker for a Mode 1 sandbox place, a vendor's computer by the agent's setting, faux's under --faux. Both runner
// entrypoints (the CLI's runner and the test server's) take it in place of harness-loops.ts's stopgap.
//
// What it composes: the computer package's kind registry; every provider built through the one provider builder
// (computer-providers.ts computerProviderMakers, the package's providerFor); the computer's spec by provider and kind
// (computerSpecOf); the mount check the claim's attach runs (the package's readBackOf); and each provider key read as the
// server reads it (key-meta.ts keyReader: the environment's value, else the saved one opened with the seal key). Settings
// → Computers' factories come from the same makers. Under --faux, faux-computers.ts's registry, key table, launch and
// factories stand in for the package's.
//
// A key goes into the server-side provider call alone (the provider's create() options): the spec a computer is made
// with names no key, no account key and no database or Redis credential, and carries no environment at all.
import { isIP } from "node:net";
import { posix } from "node:path";
import { type AttachHub, type ComputerSpec, DEFAULT_DOCKER_IMAGE, DOCKER_RECIPE, DOCKER_RECIPE_HAS, type DockerVolume, PROVIDERS, providerFor, readBackOf, servingRefusals, SETTING_KINDS } from "@parcha/agentrun-computer";
// The local container engine's provider, for its check() of the operator's size settings at the start (dockerLimitsOf).
import { DockerProvider } from "@parcha/agentrun-computer/docker";
import { DOCKER_IMAGE_ENV } from "../box-image.js";
import type { DockerPaths } from "../box-paths.js";
import { dockerDaemonCheck } from "../docker-daemon.js";
import { type HostRead, unionOf } from "../docker-host-addresses.js";
import type { ProviderFactories } from "../computer-keys.js";
import type { FauxComputers } from "../faux-computers.js";
import { envValue, type KeyEnv, keyReader } from "../key-meta.js";
import { boxAllowOf, boxAllowSetIn } from "../box-settings.js";
import { readLaunchBody } from "../run-launch.js";
import type { Store } from "../store/index.js";
import { type ClaimComputer, type ClaimLaunch, computerForClaim, type ComputerForClaimDeps, type ComputerRun, type ComputerSaid, type OpenComputerView } from "./computer-for-claim.js";
import { storeLedger } from "./computer-ledger.js";
import { computerProviderFactories, computerProviderMakers, type ProviderLoad } from "./computer-providers.js";
import { type ComputerSettingKind, type KindRegistry, needsNetwork, noNetworkRefusal, type ProviderEntry, vendorNetworkOnly } from "./resolve-computer.js";

type ComputerKindOf = Exclude<ComputerSettingKind, "none">;

/** How long a run's computer lives whatever happens to the server: a bound on a leaked one, never its clean end (the old
 *  box's lifetime). The clean end is the run's release. */
export const COMPUTER_LIFETIME_MS = 24 * 60 * 60_000;

/** A computer this server cannot make here, with the code the run fails with and its words. */
const refused = (words: string): Error => Object.assign(new Error(words), { code: "computer_unavailable" });

/** The settings that size a Docker computer (a sandbox or a desktop): its CPUs, its memory (swap included) and how many
 *  processes and threads it may hold at once. Unset, the Docker provider's own defaults hold. A vendor's computer sizes
 *  itself and is never given them. */
export const BOX_CPUS_ENV = "AGENTRUN_BOX_CPUS";
export const BOX_MEMORY_ENV = "AGENTRUN_BOX_MEMORY";
export const BOX_PIDS_ENV = "AGENTRUN_BOX_PIDS";

/** A Docker computer's size, as the Docker provider takes it on its spec. */
export type DockerLimits = Pick<ComputerSpec, "cpus" | "memoryMb" | "pids">;

/** Each setting's spec field and what it takes, in an operator's words. */
const LIMIT_SETTINGS = [
  { name: BOX_CPUS_ENV, field: "cpus", form: "a number of CPUs, such as 2 or 1.5" },
  { name: BOX_MEMORY_ENV, field: "memoryMb", form: "a size with its unit (b, k, m or g), such as 512m or 4g" },
  { name: BOX_PIDS_ENV, field: "pids", form: "a whole number of processes and threads, such as 1024" },
] as const;

/** A size's units as Docker reads them, each 1024 of the one before, in MiB. */
const SIZE_MIB: Readonly<Record<string, number>> = { b: 1 / (1024 * 1024), k: 1 / 1024, m: 1, g: 1024 };

/** One setting's value as its spec field: a number where it reads as one, else NaN, which the provider's check refuses. */
const LIMIT_VALUE: Readonly<Record<(typeof LIMIT_SETTINGS)[number]["field"], (value: string) => number>> = {
  cpus: (value) => (/^\d+(\.\d+)?$/.test(value) ? Number(value) : Number.NaN),
  // Its MiB, the fraction dropped, as Docker reads a size: 0.5g is 512, 6.5m is 6.
  memoryMb: (value) => {
    const size = /^(\d+(?:\.\d+)?)([bkmg])$/i.exec(value);
    return size ? Math.floor(Number(size[1]) * SIZE_MIB[size[2]!.toLowerCase()]!) : Number.NaN;
  },
  pids: (value) => (/^\d+$/.test(value) ? Number(value) : Number.NaN),
};

/** Asked only check(): its constructor runs nothing and reads no Docker, and check() reads only the spec. */
let checker: DockerProvider | undefined;

/** A Docker computer's size from `env`'s AGENTRUN_BOX_CPUS, _MEMORY and _PIDS: each one set, as its spec field; none set,
 *  none, so the provider's defaults hold. A value the Docker provider would refuse at every create throws, in its own
 *  words, naming the setting and what it takes: the server's start reads them (startServe), so no run meets one. */
export function dockerLimitsOf(env: KeyEnv): DockerLimits {
  const limits: Record<string, number> = {};
  for (const { name, field } of LIMIT_SETTINGS) {
    const value = envValue(env, name)?.trim();
    if (value !== undefined) limits[field] = LIMIT_VALUE[field](value);
  }
  if (Object.keys(limits).length === 0) return {};
  checker ??= new DockerProvider({ daemonPath: "computerd" });
  const refusals = checker.check({ image: DEFAULT_DOCKER_IMAGE, lifetimeMs: COMPUTER_LIFETIME_MS, network: "none", ...limits });
  for (const { name, field, form } of LIMIT_SETTINGS) {
    const refusal = refusals.find((one) => one.field === field);
    if (refusal) throw new Error(`${name} ${JSON.stringify(envValue(env, name)!.trim())} is refused by the Docker provider: ${refusal.message} (${name} is ${form})`);
  }
  return limits as DockerLimits;
}

/** The Docker host's own addresses, for a Docker provider whose interfaces aren't that host's (the server in a
 *  container): a comma list of IP addresses. The Docker provider's egress proxy refuses them as the host's, so a
 *  computer's allow-list never reaches the host itself; without them it refuses any allow-list there. */
export const DOCKER_HOST_ADDRESSES_ENV = "AGENTRUN_DOCKER_HOST_ADDRESSES";

/** `env`'s AGENTRUN_DOCKER_HOST_ADDRESSES: its addresses, each once; undefined when unset or empty, never one made up.
 *  An entry that is not an IP address throws, naming it: the server's start checks the setting, so no run meets one. */
export function dockerHostAddressesOf(env: KeyEnv): string[] | undefined {
  const value = envValue(env, DOCKER_HOST_ADDRESSES_ENV);
  if (value === undefined) return undefined;
  const addresses = [...new Set(value.split(",").map((one) => one.trim()).filter((one) => one !== ""))];
  const bad = addresses.find((one) => isIP(one) === 0);
  if (bad !== undefined) throw new Error(`${DOCKER_HOST_ADDRESSES_ENV} is a comma list of the Docker host's own IP addresses (such as 172.17.0.1): ${JSON.stringify(bad)} is not an IP address`);
  return addresses.length > 0 ? addresses : undefined;
}

/** Where the Docker provider's daemon copy goes on a server in a container: under the named volume's mount, so the
 *  host's Docker reaches it as that volume's subpath, as it reaches the run's folder. */
export const DAEMON_CACHE_IN_VOLUME = ".agentrun/computerd";

/** The Docker provider's options for a server in a container of its Docker's, its data on a named volume: the volume
 *  and where it is mounted here (`root`), under which the run's folder and the daemon copy are mounted as the volume's
 *  subpaths, and that daemon copy's place under it. Undefined on a host, or where no such volume was found (its reason
 *  then refuses a Docker computer before a run, box-paths.ts dockerComputerRefusal). */
export type DockerComputerOptions = { readonly volume: DockerVolume; readonly daemonCache: string };
export function dockerVolumeOf(paths: DockerPaths): DockerComputerOptions | undefined {
  if (!("paths" in paths)) return undefined;
  const root = paths.paths.at;
  return { volume: { name: paths.paths.volume, root }, daemonCache: posix.join(root, DAEMON_CACHE_IN_VOLUME) };
}

/** The deps computerForClaim takes once per process: all but the claim's own. */
export type ComputerDeps = Omit<ComputerForClaimDeps, "mode" | "workspace" | "sealKey" | "revokeMount" | "signal">;

export interface ComputerDepsOptions {
  /** The server's environment: a provider key named here wins over its saved one; AGENTRUN_DOCKER_IMAGE names Docker's
   *  image. Passed in, never read here. */
  readonly env: KeyEnv;
  /** The store: its sealed keys (a provider's saved keys), its computer ledger (the phone provider's) and its paired
   *  computers (a test's stand-in may have none). */
  readonly store: Pick<Store, "sealedKeys" | "computerLedger"> & { readonly pairedComputers?: Pick<Store["pairedComputers"], "list"> };
  /** The server's AttachHub, where this runner shares the server's process (runner/beside.ts): a paired computer's
   *  socket is there. Absent: a runner of its own process, which refuses a paired computer in words. */
  readonly hub?: AttachHub;
  /** The server's seal key: absent, no saved key is opened (a key from the environment still is). */
  readonly sealKey: Buffer | undefined;
  /** The kind registry: the computer package's unless given (a test's fixture). */
  readonly kinds?: KindRegistry;
  /** How a provider is built from its id and options: the package's providerFor unless given (a test's stand-in). */
  readonly load?: ProviderLoad;
  /** Where this process's Docker has the data directory (box-paths.ts dockerPathsForRuns), read once when a Docker
   *  provider is first built: in a container with a named data volume, the provider mounts by that volume
   *  (dockerVolumeOf). Absent: as on a host. */
  readonly dockerPaths?: () => Promise<DockerPaths>;
  /** The Docker host's own addresses, read through its socket (docker-host-addresses.ts hostAddressesOnce), for a server
   *  in a container of its Docker's: unioned with AGENTRUN_DOCKER_HOST_ADDRESSES. Absent: the operator's alone. */
  readonly hostAddresses?: () => Promise<HostRead>;
  /** Whether a provider that binds a folder of this machine answers here now (Docker), for the Mode 1 default. */
  readonly answers?: ComputerForClaimDeps["answers"];
  /** This machine's Docker daemon, asked when a Docker launch fails (docker-daemon.ts dockerDaemonCheck over `env`
   *  unless given; none under --faux, whose launch is its own). */
  readonly daemon?: ComputerForClaimDeps["daemon"];
  /** Why this machine cannot run a provider's computers, by its id (computers.ts hostCommandRefusals over this process's
   *  PATH): the claim refuses such a computer before it rents anything. Absent: not asked. */
  readonly hostWhy?: Readonly<Record<string, string>>;
  /** The live view's registration for a desktop or a phone (proxy-only): absent, no view is opened. */
  readonly openComputerView?: OpenComputerView;
  /** --faux's computers (faux-computers.ts), in place of the computer package's: their kind registry, key table, launch
   *  and factories. */
  readonly faux?: FauxComputers;
}

/** The spec a computer of `kind` on `entry` is made with, besides its labels and its mount: its image (a provider that
 *  prepares its own image, its descriptor's prepareImage: the owner's AGENTRUN_DOCKER_IMAGE when set, else for a sandbox
 *  the package's recipe, which its prepareImage() builds; a provider whose descriptor declares imageEnv (Daytona's
 *  AGENTRUN_DAYTONA_SNAPSHOT): that variable's value in `env` when set; any other provider's, and such a one's while it
 *  is unset: its descriptor's defaultImage for the kind, the computer package's
 *  PROVIDERS[].defaultImage; a kind with none refused in words, a prepared desktop's saying it needs an image with an X
 *  server, which the recipe lacks), the leak bound for its lifetime (its clean end is the run's release), and its
 *  network (networkOf): the run's box_allow, or this server's own (AGENTRUN_BOX_ALLOW, read from `env`) for a launch
 *  that names none; and the size of a computer on this machine's container engine (its descriptor's `local`),
 *  AGENTRUN_BOX_CPUS, _MEMORY and _PIDS (dockerLimitsOf, read once here): a vendor's computer sizes itself. No key and
 *  no environment. */
export function computerSpecOf(env: KeyEnv): ComputerForClaimDeps["spec"] {
  const named = envValue(env, DOCKER_IMAGE_ENV);
  // This server's allow setting, as a launch is stamped with it (box-settings.ts boxAllowOf; its start checks the setting).
  const current = (): readonly string[] | "none" => boxAllowOf(env as NodeJS.ProcessEnv);
  const currentSet = (): boolean => boxAllowSetIn(env as NodeJS.ProcessEnv);
  const imageOf = (entry: ProviderEntry, kind: ComputerKindOf): string => {
    if (entry.prepareImage && named !== undefined) return named;
    const chosen = entry.imageEnv === undefined ? undefined : envValue(env, entry.imageEnv)?.trim();
    if (chosen !== undefined) return chosen;
    // A sandbox whose provider prepares its image: the package's own recipe, which its prepareImage() builds (the
    // descriptor gives it no default).
    if (entry.prepareImage && kind === "sandbox") return DEFAULT_DOCKER_IMAGE;
    const image = entry.defaultImage?.[kind];
    if (image !== undefined) return image;
    if (entry.prepareImage && kind === "desktop") throw refused(`A ${entry.label} desktop needs an image with an X server; set one for desktops.`);
    throw refused(`${entry.label} has no image for a ${kind} computer here: pick another provider for this agent's computer in Settings → Computers.`);
  };
  const limits = dockerLimitsOf(env);
  return (entry, kind, run, image) => ({
    // The setting's configuration's image (Orgo's `windows`), else the kind's.
    image: image ?? imageOf(entry, kind),
    // The leak bound, within the longest the provider makes (E2B's is an hour): a longer one it refuses at create.
    lifetimeMs: Math.min(COMPUTER_LIFETIME_MS, run.maxLifetimeMs ?? COMPUTER_LIFETIME_MS),
    network: networkOf(entry, kind, run, current, currentSet),
    // The size of a computer on this machine's container engine, the operator's (dockerLimitsOf); a vendor's sizes itself.
    ...(entry.local ? limits : {}),
  });
}

/** The network a computer of `kind` on `entry` asks for: what the run allows (its box_allow), narrowed to "none" when its
 *  provider makes "none" but not what the run allows. A launch that names no box_allow (a row from before every launch
 *  was stamped with it) allows what this server allows now (`current`), never "open"; a sandbox with none still has no
 *  network, as it always had. A remote computer (Daytona's or E2B's, each one whose capabilities' network is ["none"])
 *  runs its programs in a network of their own, so an open or listed network is one it refuses at create; "none" reaches
 *  less than the run allows, never more. Under "none", the operator's word for no network at all, a computer whose
 *  provider makes no "none" (a cloud phone, a hosted browser, Local Chrome) is refused in words (noNetworkRefusal), as
 *  the run's start refuses it (resolve-computer.ts computerReadiness). A vendor-hosted computer that runs only on the
 *  vendor's own network (its capabilities' network is ["open"]) is "open" under a list, the default or the operator's,
 *  since this server's list can't reach it, and Settings says so (computers.ts networkWords). A browser whose provider
 *  makes both "open" and "allow" (Local Chrome, behind its own egress proxy) is held to the operator's list
 *  (`boxAllowSet`, the launch's, or this server's now for a launch that names no box_allow) and is "open" under the
 *  default list, which is a sandbox's package-install list and no browsing policy. */
function networkOf(entry: ProviderEntry, kind: ComputerKindOf, run: ComputerRun, current: () => readonly string[] | "none", currentSet: () => boolean): ComputerSpec["network"] {
  const boxAllow = run.boxAllow ?? (kind === "sandbox" ? "none" : current());
  const set = run.boxAllow !== undefined ? run.boxAllowSet === true : currentSet();
  if (boxAllow === "none" && needsNetwork(run.networks)) throw refused(noNetworkRefusal(entry.label, kind));
  if (vendorNetworkOnly(run.networks)) return "open";
  if (kind === "browser" && boxAllow !== "none" && run.networks?.includes("open") && run.networks.includes("allow")) return set ? { allow: [...boxAllow] } : "open";
  const allowed: ComputerSpec["network"] = boxAllow === "none" ? "none" : { allow: [...boxAllow] };
  const form = allowed === "none" ? "none" : "allow";
  return run.networks && !run.networks.includes(form) && run.networks.includes("none") ? "none" : allowed;
}

/** The run's timeline phase while its claim waits on its computer's image (computerForClaim's onImageWait): main's box
 *  image row, the computer's noun for the box's. */
export const imageWaitWords = (making: "build" | "pull", image: string): string =>
  making === "build" ? `Preparing the computer's image: building it (${DOCKER_RECIPE_HAS})…` : `Preparing the computer's image: pulling ${image}…`;

/** An OS as people write its name. */
const OS_NAMES: Readonly<Record<string, string>> = { linux: "Linux", windows: "Windows", macos: "macOS", android: "Android", ios: "iOS" };

/** The run's timeline phase once its claim's computer is connected (computerForClaim's onConnected): what it says it
 *  is, in its hello's own facts, such as "The phone is ready: Android 15 (arm64), from Phone harness." */
export const computerReadyWords = ({ provider, kind, hello }: ComputerSaid): string =>
  `The ${kind} is ready: ${[OS_NAMES[hello.os] ?? hello.os, hello.osVersion].filter(Boolean).join(" ")} (${hello.arch}), from ${provider}.`;

/** The claim's computer as the runner's specs call it: what the run's launch lets the computer reach (its box_allow),
 *  read from the launch row when the store has one and the claim does not say, then computerForClaim. */
export const claimComputer = async (
  launch: ClaimLaunch,
  store: Parameters<typeof computerForClaim>[1] & { readonly runs?: Pick<Store["runs"], "launch"> },
  deps: ComputerForClaimDeps,
): Promise<ClaimComputer> => {
  if (launch.boxAllow !== undefined || !store.runs) return computerForClaim(launch, store, deps);
  const body = readLaunchBody((await store.runs.launch(launch.runId)).body);
  const boxAllow = body?.boxAllow;
  return computerForClaim(boxAllow === undefined ? launch : { ...launch, boxAllow, ...(body?.boxAllowSet ? { boxAllowSet: true as const } : {}) }, store, deps);
};

/** The kind registry a claim composed with `options` resolves a setting against: --faux's when it is given faux, else a
 *  test's own, else the computer package's. The one choice: computerDepsFrom makes it, and the server's start check
 *  (server.ts computerReady) asks it with what the runner composes with, so a run's start and its claim answer alike. */
export function claimKinds(options: Pick<ComputerDepsOptions, "faux" | "kinds">): KindRegistry {
  // The faux registry is Settings' shape (computers.ts); the claim reads the same data as resolve-computer.ts's.
  return (options.faux?.kinds as unknown as KindRegistry | undefined) ?? options.kinds ?? ({ SETTING_KINDS, PROVIDERS, servingRefusals } as unknown as KindRegistry);
}

/** This machine's Docker daemon as the claim asks it once a Docker launch fails: one check per process (its answer
 *  kept a while, docker-daemon.ts), in `env`. */
const dockerDaemonOf = (env: KeyEnv): NonNullable<ComputerForClaimDeps["daemon"]> => {
  const check = dockerDaemonCheck({ env: { ...env } });
  return () => check();
};

/** computerForClaim and its process-wide deps, composed once; and Settings → Computers' factories from the same makers. */
export function computerDepsFrom(options: ComputerDepsOptions): { computerForClaim: typeof claimComputer; computerDeps: ComputerDeps; factories: ProviderFactories } {
  const { env, store, sealKey, faux } = options;
  const kinds = claimKinds(options);
  // A provider that prepares its own image (its descriptor's prepareImage) is given that image's source, which its
  // prepareImage() makes ready (built from the recipe when the engine lacks it, or pulled by name): the owner's
  // AGENTRUN_DOCKER_IMAGE, else the package's recipe. Never the recipe's bare tag, which no registry has.
  const named = envValue(env, DOCKER_IMAGE_ENV);
  const preparedImage = named !== undefined ? { image: named } : { recipe: DOCKER_RECIPE };
  // The operator's Docker host addresses (AGENTRUN_DOCKER_HOST_ADDRESSES), checked once here.
  const namedAddresses = dockerHostAddressesOf(env);
  // Where this process's Docker has the data, read once, when a Docker provider is first built.
  let paths: Promise<DockerPaths> | undefined;
  /** A local provider's host options (its descriptor's `local`: its computers run on this machine's container engine):
   *  for a server in a container of that engine's, the named volume that holds its data and the daemon copy's place
   *  under it (dockerVolumeOf), and the host's own addresses for its egress proxy, the union of the read through the
   *  socket (`hostAddresses`) and the operator's; on a host, the operator's alone (the provider reads its own
   *  interfaces). With none, none are given, and the provider refuses an allow-list where it isn't on the host, in its
   *  words. The read is made only for a claim whose run's computer has an allow-list (`boxAllow`, the claim's own
   *  launch's box_allow, a list): a run launched under a list keeps it across a restart, whatever this process's
   *  AGENTRUN_BOX_ALLOW says now; one with none, or no claim, reads nothing. The read itself is once per process
   *  (`hostAddresses`). */
  const localHostOptions = async (boxAllow: readonly string[] | "none" | undefined): Promise<Record<string, unknown>> => {
    const where = options.dockerPaths ? await (paths ??= options.dockerPaths()) : ({ here: true } as const);
    const volume = dockerVolumeOf(where);
    // A launch that names no box_allow (a row from before every launch was stamped) allows what this server allows now,
    // as its computer's network does (networkOf), so the provider's options follow the same setting.
    const allow = boxAllow ?? boxAllowOf(env as NodeJS.ProcessEnv);
    const read = volume && Array.isArray(allow) && options.hostAddresses ? await options.hostAddresses() : undefined;
    const addresses = read ? unionOf(read, namedAddresses).addresses : (namedAddresses ?? []);
    return { ...(volume ?? {}), ...(addresses.length > 0 ? { egress: { hostAddresses: addresses } } : {}) };
  };
  /** The server's own values of the environment variables a provider declares it reads on this machine (hostEnv: Local
   *  Chrome's, where it finds Chrome), and no other variable of the server's. */
  const hostEnvOf = (names: readonly string[]): Record<string, string> => Object.fromEntries(names.flatMap((name) => (env[name] === undefined ? [] : [[name, String(env[name])]])));
  /** The options a provider takes beside its keys, by what its descriptor declares, never by its id: the image source
   *  for one that prepares its image, the host options for a local one, the host environment it reads. */
  const declaredOptions = async (id: string, boxAllow: readonly string[] | "none" | undefined): Promise<Record<string, unknown>> => {
    const entry = kinds.PROVIDERS.find((one) => one.id === id);
    return {
      ...(entry?.prepareImage ? { image: preparedImage } : {}),
      ...(entry?.local ? await localHostOptions(boxAllow) : {}),
      ...(entry?.hostEnv ? { env: hostEnvOf(entry.hostEnv) } : {}),
    };
  };
  const load = options.load ?? (providerFor as unknown as ProviderLoad);
  // The claim and Settings → Computers' test alike.
  const providers = computerProviderMakers({ load: async (id, given, claim) => load(id, { ...given, ...(await declaredOptions(id, claim?.boxAllow)) }) });
  const computerDeps: ComputerDeps = {
    kinds,
    providers,
    spec: computerSpecOf(env),
    check: { readBackOf },
    keyOf: keyReader(store, sealKey, env),
    // Under --faux, its launch makes the computer, with its key table: no provider of the package is built.
    ...(faux ? { keyTable: faux.keyTable, launch: (entry, spec) => faux.launch(entry as never, spec) } : {}),
    ...(options.answers ? { answers: options.answers } : {}),
    ...(options.hostWhy ? { hostWhy: (provider: string): string | undefined => (Object.hasOwn(options.hostWhy!, provider) ? options.hostWhy![provider] : undefined) } : {}),
    ...(options.daemon ? { daemon: options.daemon } : faux ? {} : { daemon: dockerDaemonOf(env) }),
    ...(options.openComputerView ? { openComputerView: options.openComputerView } : {}),
    ...(store.pairedComputers ? { attached: { rows: () => store.pairedComputers!.list(), ...(options.hub ? { hub: options.hub } : {}) } } : {}),
  };
  const factories = faux?.factories ?? computerProviderFactories(providers, (id) => storeLedger(store.computerLedger, id));
  return { computerForClaim: claimComputer, computerDeps, factories };
}
