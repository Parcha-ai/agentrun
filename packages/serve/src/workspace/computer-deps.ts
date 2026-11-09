// A run's computer, composed once per process: the runner (runner/main.ts) and the server both take computerForClaim and
// its process-wide deps from computerDepsFrom, so nothing composes them a second time. A spec builder adds only the
// claim's own (its mode, its Workspace, the seal key, the Archil mount's revoke).
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
import { BROWSER_IMAGE, type ComputerSpec, DAYTONA_DEFAULT_SNAPSHOT, DEFAULT_DOCKER_IMAGE, PROVIDERS, readBackOf, servingRefusals, SETTING_KINDS } from "@parcha/agentrun-computer";
import { DOCKER_IMAGE_ENV } from "../box-image.js";
import type { ProviderFactories } from "../computer-keys.js";
import type { FauxComputers } from "../faux-computers.js";
import { envValue, type KeyEnv, keyReader } from "../key-meta.js";
import { COMPUTER_LIFETIME_MS } from "../runner/computer.js";
import type { Store } from "../store/index.js";
import { computerForClaim, type ComputerForClaimDeps, type OpenComputerView } from "./computer-for-claim.js";
import { storeLedger } from "./computer-ledger.js";
import { computerProviderFactories, computerProviderMakers, type ProviderLoad } from "./computer-providers.js";
import type { ComputerSettingKind, KindRegistry, ProviderEntry } from "./resolve-computer.js";

/** What a Modal sandbox starts from: a registry image (Modal builds it on its side). */
const MODAL_IMAGE = "debian:bookworm-slim";

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

/** The spec a computer of `kind` on `entry` is made with, besides its labels and its mount: its provider's image for the
 *  kind (Docker's: the owner's AGENTRUN_DOCKER_IMAGE, else the package's own), the leak bound for its lifetime (its clean
 *  end is the run's release), and no network. No key and no environment. */
export function computerSpecOf(env: KeyEnv): (entry: ProviderEntry, kind: Exclude<ComputerSettingKind, "none">) => Omit<ComputerSpec, "labels" | "mount"> {
  const docker = envValue(env, DOCKER_IMAGE_ENV) ?? DEFAULT_DOCKER_IMAGE;
  const imageOf = (id: string, kind: Exclude<ComputerSettingKind, "none">): string => {
    switch (id) {
      case "e2b": return kind === "desktop" ? "desktop" : "base";
      case "orgo": return "linux";
      case "daytona": return DAYTONA_DEFAULT_SNAPSHOT;
      case "modal": return MODAL_IMAGE;
      case "browserbase":
      case "kernel": return BROWSER_IMAGE;
      case "phone-harness": return "android";
      default: return docker;
    }
  };
  return (entry, kind) => ({ image: imageOf(entry.id, kind), lifetimeMs: COMPUTER_LIFETIME_MS, network: "none" });
}

/** computerForClaim and its process-wide deps, composed once; and Settings → Computers' factories from the same makers. */
export function computerDepsFrom(options: ComputerDepsOptions): { computerForClaim: typeof computerForClaim; computerDeps: ComputerDeps; factories: ProviderFactories } {
  const { env, store, sealKey, faux } = options;
  // The faux registry is Settings' shape (computers.ts); the claim reads the same data as resolve-computer.ts's.
  const kinds = (faux?.kinds as unknown as KindRegistry | undefined) ?? options.kinds ?? ({ SETTING_KINDS, PROVIDERS, servingRefusals } as unknown as KindRegistry);
  const providers = computerProviderMakers(options.load ? { load: options.load } : {});
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
  return { computerForClaim, computerDeps, factories };
}
