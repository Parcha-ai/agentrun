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
import { type ComputerSpec, DEFAULT_DOCKER_IMAGE, DOCKER_RECIPE, DOCKER_RECIPE_HAS, type DockerVolume, PROVIDERS, providerFor, readBackOf, servingRefusals, SETTING_KINDS } from "@parcha/agentrun-computer";
import { DOCKER_IMAGE_ENV } from "../box-image.js";
import type { DockerPaths } from "../box-paths.js";
import { type HostRead, unionOf } from "../docker-host-addresses.js";
import type { ProviderFactories } from "../computer-keys.js";
import type { FauxComputers } from "../faux-computers.js";
import { envValue, type KeyEnv, keyReader } from "../key-meta.js";
import { boxAllowOf } from "../run-box.js";
import { readLaunchBody } from "../run-launch.js";
import type { Store } from "../store/index.js";
import { type ClaimComputer, type ClaimLaunch, computerForClaim, type ComputerForClaimDeps, type ComputerRun, type OpenComputerView } from "./computer-for-claim.js";
import { storeLedger } from "./computer-ledger.js";
import { computerProviderFactories, computerProviderMakers, type ProviderLoad } from "./computer-providers.js";
import { type ComputerSettingKind, type KindRegistry, noNetworkRefusal, type ProviderEntry, vendorNetworkOnly } from "./resolve-computer.js";

type ComputerKindOf = Exclude<ComputerSettingKind, "none">;

/** How long a run's computer lives whatever happens to the server: a bound on a leaked one, never its clean end (the old
 *  box's lifetime). The clean end is the run's release. */
export const COMPUTER_LIFETIME_MS = 24 * 60 * 60_000;

/** A computer this server cannot make here, with the code the run fails with and its words. */
const refused = (words: string): Error => Object.assign(new Error(words), { code: "computer_unavailable" });

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
  /** The store: its sealed keys (a provider's saved keys) and its computer ledger (the phone provider's). */
  readonly store: Pick<Store, "sealedKeys" | "computerLedger">;
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
  /** The live view's registration for a desktop or a phone (proxy-only): absent, no view is opened. */
  readonly openComputerView?: OpenComputerView;
  /** --faux's computers (faux-computers.ts), in place of the computer package's: their kind registry, key table, launch
   *  and factories. */
  readonly faux?: FauxComputers;
}

/** The spec a computer of `kind` on `entry` is made with, besides its labels and its mount: its image (Docker's: the
 *  owner's AGENTRUN_DOCKER_IMAGE when set, else for a sandbox the package's recipe; any other provider's: its registry
 *  entry's defaultImage for the kind, the computer package's PROVIDERS[].defaultImage; a kind with none refused in
 *  words, a Docker desktop's saying it needs an image with an X server, which the recipe lacks), the leak bound for its lifetime (its clean end is the run's release), and its network
 *  (networkOf): the run's box_allow, or this server's own (AGENTRUN_BOX_ALLOW, read from `env`) for a launch that names
 *  none. No key and no environment. */
export function computerSpecOf(env: KeyEnv): ComputerForClaimDeps["spec"] {
  const named = envValue(env, DOCKER_IMAGE_ENV);
  // This server's allow setting, as a launch is stamped with it (run-box.ts boxAllowOf; its start checks the setting).
  const current = (): readonly string[] | "none" => boxAllowOf(env as NodeJS.ProcessEnv);
  const imageOf = (entry: ProviderEntry, kind: ComputerKindOf): string => {
    if (entry.id === "docker" && named !== undefined) return named;
    // Docker's sandbox: the package's own recipe, which serve builds (the registry gives Docker no default).
    if (entry.id === "docker" && kind === "sandbox") return DEFAULT_DOCKER_IMAGE;
    const image = entry.defaultImage?.[kind];
    if (image !== undefined) return image;
    if (entry.id === "docker" && kind === "desktop") throw refused("A Docker desktop needs an image with an X server; set one for desktops.");
    throw refused(`${entry.label} has no image for a ${kind} computer here: pick another provider for this agent's computer in Settings → Computers.`);
  };
  return (entry, kind, run) => ({
    image: imageOf(entry, kind),
    // The leak bound, within the longest the provider makes (E2B's is an hour): a longer one it refuses at create.
    lifetimeMs: Math.min(COMPUTER_LIFETIME_MS, run.maxLifetimeMs ?? COMPUTER_LIFETIME_MS),
    network: networkOf(entry, kind, run, current),
  });
}

/** The network a computer of `kind` on `entry` asks for: what the run allows (its box_allow), narrowed to "none" when its
 *  provider makes "none" but not what the run allows. A launch that names no box_allow (a row from before every launch
 *  was stamped with it) allows what this server allows now (`current`), never "open"; a sandbox with none still has no
 *  network, as it always had. A remote computer (Daytona's or E2B's, each one whose capabilities' network is ["none"])
 *  runs its programs in a network of their own, so an open or listed network is one it refuses at create; "none" reaches
 *  less than the run allows, never more. The one exception is a vendor-hosted computer that runs only on the vendor's own
 *  network (its capabilities' network is ["open"]: a cloud phone, a hosted browser): under a list, the default or the
 *  operator's, it is "open", since this server's list can't reach it, and Settings says so (computers.ts networkWords);
 *  under "none", the operator's word for no network at all, it is refused in words (noNetworkRefusal), as the run's
 *  start refuses it (resolve-computer.ts computerReadiness). */
function networkOf(entry: ProviderEntry, kind: ComputerKindOf, run: ComputerRun, current: () => readonly string[] | "none"): ComputerSpec["network"] {
  const boxAllow = run.boxAllow ?? (kind === "sandbox" ? "none" : current());
  if (vendorNetworkOnly(run.networks)) {
    if (boxAllow === "none") throw refused(noNetworkRefusal(entry.label, kind));
    return "open";
  }
  const allowed: ComputerSpec["network"] = boxAllow === "none" ? "none" : { allow: [...boxAllow] };
  const form = allowed === "none" ? "none" : "allow";
  return run.networks && !run.networks.includes(form) && run.networks.includes("none") ? "none" : allowed;
}

/** The run's timeline phase while its claim waits on its computer's image (computerForClaim's onImageWait): main's box
 *  image row, the computer's noun for the box's. */
export const imageWaitWords = (making: "build" | "pull", image: string): string =>
  making === "build" ? `Preparing the computer's image: building it (${DOCKER_RECIPE_HAS})…` : `Preparing the computer's image: pulling ${image}…`;

/** The claim's computer as the runner's specs call it: what the run's launch lets the computer reach (its box_allow),
 *  read from the launch row when the store has one and the claim does not say, then computerForClaim. */
export const claimComputer = async (
  launch: ClaimLaunch,
  store: Parameters<typeof computerForClaim>[1] & { readonly runs?: Pick<Store["runs"], "launch"> },
  deps: ComputerForClaimDeps,
): Promise<ClaimComputer> => {
  if (launch.boxAllow !== undefined || !store.runs) return computerForClaim(launch, store, deps);
  const boxAllow = readLaunchBody((await store.runs.launch(launch.runId)).body)?.boxAllow;
  return computerForClaim(boxAllow === undefined ? launch : { ...launch, boxAllow }, store, deps);
};

/** The kind registry a claim composed with `options` resolves a setting against: --faux's when it is given faux, else a
 *  test's own, else the computer package's. The one choice: computerDepsFrom makes it, and the server's start check
 *  (server.ts computerReady) asks it with what the runner composes with, so a run's start and its claim answer alike. */
export function claimKinds(options: Pick<ComputerDepsOptions, "faux" | "kinds">): KindRegistry {
  // The faux registry is Settings' shape (computers.ts); the claim reads the same data as resolve-computer.ts's.
  return (options.faux?.kinds as unknown as KindRegistry | undefined) ?? options.kinds ?? ({ SETTING_KINDS, PROVIDERS, servingRefusals } as unknown as KindRegistry);
}

/** computerForClaim and its process-wide deps, composed once; and Settings → Computers' factories from the same makers. */
export function computerDepsFrom(options: ComputerDepsOptions): { computerForClaim: typeof claimComputer; computerDeps: ComputerDeps; factories: ProviderFactories } {
  const { env, store, sealKey, faux } = options;
  const kinds = claimKinds(options);
  // The Docker provider is given its image's source, which it makes ready itself (its image(): built from the recipe
  // when Docker lacks it, or pulled by name): the owner's AGENTRUN_DOCKER_IMAGE, else the package's recipe. Never the
  // recipe's bare tag, which no registry has.
  const named = envValue(env, DOCKER_IMAGE_ENV);
  const dockerImage = named !== undefined ? { image: named } : { recipe: DOCKER_RECIPE };
  // The operator's Docker host addresses (AGENTRUN_DOCKER_HOST_ADDRESSES), checked once here.
  const namedAddresses = dockerHostAddressesOf(env);
  // Where this process's Docker has the data, read once, when a Docker provider is first built.
  let paths: Promise<DockerPaths> | undefined;
  /** The Docker provider's options beside its image: for a server in a container of its Docker's, the named volume that
   *  holds its data and the daemon copy's place under it (dockerVolumeOf), and the Docker host's own addresses for its
   *  egress proxy, the union of the read through the socket (`hostAddresses`) and the operator's; on a host, the
   *  operator's alone (the provider reads its own interfaces). With none, none are given, and the provider refuses an
   *  allow-list where it isn't on the Docker host, in its words. The read is made only for a claim whose run's computer
   *  has an allow-list (`boxAllow`, the claim's own launch's box_allow, a list): a run launched under a list keeps it
   *  across a restart, whatever this process's AGENTRUN_BOX_ALLOW says now; one with none, or no claim, reads nothing.
   *  The read itself is once per process (`hostAddresses`). */
  const dockerOptions = async (boxAllow: readonly string[] | "none" | undefined): Promise<Record<string, unknown>> => {
    const where = options.dockerPaths ? await (paths ??= options.dockerPaths()) : ({ here: true } as const);
    const volume = dockerVolumeOf(where);
    // A launch that names no box_allow (a row from before every launch was stamped) allows what this server allows now,
    // as its computer's network does (networkOf), so the provider's options follow the same setting.
    const allow = boxAllow ?? boxAllowOf(env as NodeJS.ProcessEnv);
    const read = volume && Array.isArray(allow) && options.hostAddresses ? await options.hostAddresses() : undefined;
    const addresses = read ? unionOf(read, namedAddresses).addresses : (namedAddresses ?? []);
    return { image: dockerImage, ...(volume ?? {}), ...(addresses.length > 0 ? { egress: { hostAddresses: addresses } } : {}) };
  };
  const load = options.load ?? (providerFor as unknown as ProviderLoad);
  const providers = computerProviderMakers({ load: async (id, given, claim) => load(id, id === "docker" ? { ...given, ...(await dockerOptions(claim?.boxAllow)) } : given) });
  const computerDeps: ComputerDeps = {
    kinds,
    providers,
    spec: computerSpecOf(env),
    check: { readBackOf },
    keyOf: keyReader(store, sealKey, env),
    // Under --faux, its launch makes the computer, with its key table: no provider of the package is built.
    ...(faux ? { keyTable: faux.keyTable, launch: (entry, spec) => faux.launch(entry as never, spec) } : {}),
    ...(options.answers ? { answers: options.answers } : {}),
    ...(options.openComputerView ? { openComputerView: options.openComputerView } : {}),
  };
  const factories = faux?.factories ?? computerProviderFactories(providers, (id) => storeLedger(store.computerLedger, id));
  return { computerForClaim: claimComputer, computerDeps, factories };
}
