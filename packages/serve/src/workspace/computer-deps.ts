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
import { type ComputerSpec, DEFAULT_DOCKER_IMAGE, DOCKER_RECIPE, DOCKER_RECIPE_HAS, PROVIDERS, providerFor, readBackOf, servingRefusals, SETTING_KINDS } from "@parcha/agentrun-computer";
import { DOCKER_IMAGE_ENV } from "../box-image.js";
import type { ProviderFactories } from "../computer-keys.js";
import type { FauxComputers } from "../faux-computers.js";
import { envValue, type KeyEnv, keyReader } from "../key-meta.js";
import { readLaunchBody } from "../run-launch.js";
import type { Store } from "../store/index.js";
import { type ClaimComputer, type ClaimLaunch, computerForClaim, type ComputerForClaimDeps, type OpenComputerView } from "./computer-for-claim.js";
import { storeLedger } from "./computer-ledger.js";
import { computerProviderFactories, computerProviderMakers, type ProviderLoad } from "./computer-providers.js";
import type { ComputerSettingKind, KindRegistry, ProviderEntry } from "./resolve-computer.js";

type ComputerKindOf = Exclude<ComputerSettingKind, "none">;

/** How long a run's computer lives whatever happens to the server: a bound on a leaked one, never its clean end (the old
 *  box's lifetime). The clean end is the run's release. */
export const COMPUTER_LIFETIME_MS = 24 * 60 * 60_000;

/** A computer this server cannot make here, with the code the run fails with and its words. */
const refused = (words: string): Error => Object.assign(new Error(words), { code: "computer_unavailable" });

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
 *  words, a Docker desktop's saying it needs an image with an X server, which the recipe lacks), the leak bound for its lifetime (its clean end is the run's release), and its network. box_allow is a
 *  sandbox's egress list: a sandbox with none, or "none", has no network; a browser, desktop or phone with none has its
 *  provider's own ("open"); an explicit list or "none" applies to any kind. No key and no environment. */
export function computerSpecOf(env: KeyEnv): ComputerForClaimDeps["spec"] {
  const named = envValue(env, DOCKER_IMAGE_ENV);
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
    lifetimeMs: COMPUTER_LIFETIME_MS,
    network: run.boxAllow === undefined ? (kind === "sandbox" ? "none" : "open") : run.boxAllow === "none" ? "none" : { allow: [...run.boxAllow] },
  });
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

/** computerForClaim and its process-wide deps, composed once; and Settings → Computers' factories from the same makers. */
export function computerDepsFrom(options: ComputerDepsOptions): { computerForClaim: typeof claimComputer; computerDeps: ComputerDeps; factories: ProviderFactories } {
  const { env, store, sealKey, faux } = options;
  // The faux registry is Settings' shape (computers.ts); the claim reads the same data as resolve-computer.ts's.
  const kinds = (faux?.kinds as unknown as KindRegistry | undefined) ?? options.kinds ?? ({ SETTING_KINDS, PROVIDERS, servingRefusals } as unknown as KindRegistry);
  // The Docker provider is given its image's source, which it makes ready itself (its image(): built from the recipe
  // when Docker lacks it, or pulled by name): the owner's AGENTRUN_DOCKER_IMAGE, else the package's recipe. Never the
  // recipe's bare tag, which no registry has.
  const named = envValue(env, DOCKER_IMAGE_ENV);
  const dockerImage = named !== undefined ? { image: named } : { recipe: DOCKER_RECIPE };
  const load = options.load ?? (providerFor as unknown as ProviderLoad);
  const providers = computerProviderMakers({ load: (id, given) => load(id, id === "docker" ? { ...given, image: dockerImage } : given) });
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
