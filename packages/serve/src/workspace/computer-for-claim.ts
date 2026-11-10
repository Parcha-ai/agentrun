// The run's computer at its claim, the one call both runner specs make (the adapter loop's and the CLI's): the agent's
// computer setting, resolved in the server's mode against the computer module's kind registry (resolveComputer), started
// for this run under this claim (labels agentrun.run and agentrun.epoch, the run's folder mounted only where the provider
// mounts it), with a hold and its live view when it is a desktop or a phone, and released once at the run's end. (The
// owner's take-over over the store is not on this line yet: its routes answer 501, computer-routes.ts.) A computer that cannot be had is refused in words
// with code computer_unavailable; kind none, or no setting where the server's default is none, is no computer.
//
// A provider is made with its keys (the server's environment's, else the store's sealed keys, through the composer's
// keyOf: computer-deps.ts), by the names the registry declares, through serve's own
// map of key names to options (computer-keys.ts providerOptions); a provider that keeps sessions with no labels of their
// own (the phone's) is given the store's computer ledger. Nothing here knows a vendor: the registry, the providers' create
// and a test's stand-ins are passed in.
import type { ComputerProvider, ComputerSpec, MountReadBack, Result, Swept } from "@parcha/agentrun-computer";
import { releaseOlder, runLabels, sweep } from "@parcha/agentrun-computer";
import { computerOfPlace, type ComputerSetting as RevisionComputer, type PlaceView } from "../computer-setting.js";
import { KEY_TABLE, type KeyTable, type ProviderSettings, providerOptions } from "../computer-keys.js";
import { getSealedKey } from "../server-keys.js";
import type { Store } from "../store/index.js";
import type { MountCheck } from "./attach.js";
import { computerHold, heldHands } from "./computer-hold.js";
import { type ProviderLedger, storeLedger } from "./computer-ledger.js";
import { type ClaimSide, type ComputerSetting, type ComputerSettingKind, type KindRegistry, type LaunchedComputer, type ProviderEntry, providerKeys, resolveComputer } from "./resolve-computer.js";
import type { RunComputer, RunHold } from "./run-tools.js";
import type { Workspace } from "./workspace.js";

/** What the claim knows of the run: its id, the claim's epoch, and where its computer setting is (the launch's own, else
 *  the revision's, else the launch's place, its v2 view). */
export interface ClaimLaunch {
  readonly runId: string;
  readonly epoch: number;
  /** The claim itself, as the live view's registration fences on it (absent: its run and epoch). */
  readonly claim?: unknown;
  readonly revisionId?: string;
  readonly computer?: ComputerSetting;
  readonly place?: PlaceView;
  /** What the run's computer may reach, as its launch resolved it (run-launch.ts boxAllow): "none" or absent is no
   *  network, a list an allow-list. The computer's spec takes it. */
  readonly boxAllow?: readonly string[] | "none";
}

/** What of the run a computer's spec is made from, besides its kind and provider: what it may reach; and what the
 *  provider declares it makes (its capabilities()): its networks and its longest lifetime. Absent, the spec asks as the
 *  run allows. */
export interface ComputerRun {
  readonly boxAllow?: readonly string[] | "none";
  readonly networks?: readonly ("none" | "open" | "allow")[];
  readonly maxLifetimeMs?: number;
}

/** A provider module's create(), by provider id: its options from the saved keys, and the store's ledger for a provider
 *  that keeps one (the phone's `ledger` option); for a claim, what its run's computer may reach (`boxAllow`, the
 *  launch's box_allow), which no provider option carries. The computer package's providers, or a test's stand-in. */
export type ProviderMakers = Readonly<Partial<Record<string, (options: Record<string, string>, extras: ProviderExtras) => ComputerProvider | Promise<ComputerProvider>>>>;
/** What a provider is made with beside its options: the store's ledger, and the claim's box_allow when a claim makes it. */
export type ProviderExtras = { readonly ledger: ProviderLedger; readonly boxAllow?: readonly string[] | "none" };

/** Why a live view ends: the computer was released, or the run ended. */
export type ViewEnd = "released" | "ended";

/** The live view of a desktop or a phone, proxy-only, as its registration (computer-live.ts
 *  openComputerView, taken as a dep until it is on the base) opens it at the claim: fenced on the claim, tagged with the
 *  computer's ref id, fed by the provider's watch, and held by the run's take-over hold. */
export type OpenComputerView = (args: {
  readonly store: unknown;
  readonly sealKey: Buffer | undefined;
  readonly claim: unknown;
  readonly kind: "desktop" | "phone";
  /** How the viewer's input is made into actions: a desktop's, or the phone's platform (its machine kind). */
  readonly input: "desktop" | "android" | "ios";
  readonly tag: string;
  readonly watch: (signal: AbortSignal) => unknown;
  readonly hold: unknown;
}) => Promise<{ readonly ok: true; readonly view: { close(why: ViewEnd): unknown } } | { readonly ok: false; readonly refused: "fenced" | "bad_tag" | "kind"; readonly message: string }>;

export interface ComputerForClaimDeps {
  /** The server's folder mode: 1, a folder of this machine; 2, Archil. */
  readonly mode: 1 | 2;
  /** The computer module's kind registry (or --faux's). */
  readonly kinds: KindRegistry;
  /** The server's seal key: absent, no key is opened, so a provider that needs one is refused in words. */
  readonly sealKey: Buffer | undefined;
  readonly providers: ProviderMakers;
  /** What a computer of `kind` is made with, besides its labels and its mount: image, lifetime, network (from `run`). */
  readonly spec: (entry: ProviderEntry, kind: Exclude<ComputerSettingKind, "none">, run: ComputerRun) => Omit<ComputerSpec, "labels" | "mount">;
  /** A provider key's value by its name, as the server reads it (key-meta.ts keyReader: the environment's, else the
   *  saved one). Absent: the saved one alone, opened with `sealKey`. */
  readonly keyOf?: (name: string) => Promise<string | undefined>;
  /** The map from key names to options: serve's own unless given (--faux's). */
  readonly keyTable?: KeyTable;
  readonly settings?: ProviderSettings;
  /** Whether a provider that binds a folder of this machine answers here now (Docker): the Mode 1 default asks it. */
  readonly answers?: (provider: string) => Promise<boolean>;
  /** A launch of the server's own in place of the providers' (--faux's desktop). */
  readonly launch?: ClaimSide["launch"];
  /** The run's folder (mounted only where the provider mounts it) and the mount check attach runs. */
  readonly workspace: Workspace;
  readonly check: MountCheck;
  /** Removes the run's Archil mount credential (the Archil claim's revoke): called once the computer is released, and
   *  when a start fails after a mount was minted. Absent: nothing was minted (Mode 1). */
  readonly revokeMount?: () => Promise<void>;
  /** The live view's registration for a desktop or a phone (proxy-only). Absent: no view is opened. */
  readonly openComputerView?: OpenComputerView;
  /** Told once, before the claim waits on its computer's image (a provider that makes its own: Docker's recipe built on
   *  a host that lacks it, or a named image pulled); never when the host has it. The run's caller says it on the run's
   *  timeline. Absent: nothing is said. */
  readonly onImageWait?: ImageWait;
  readonly signal?: AbortSignal;
}

/** The run's computer at its claim: what runTools takes, the person's hold on a desktop's or phone's ports, and its
 *  release (idempotent): the live view closed ("released" when the computer goes before the run's end, "ended" at the
 *  run's end), the owner's view let go, then the computer. */
export interface ClaimComputer {
  readonly computer?: RunComputer;
  readonly hold?: RunHold;
  release(why?: ViewEnd): Promise<void>;
}

/** A computer that cannot be had, with the code the run fails with and the server's words. */
const unavailable = (words: string): Error => Object.assign(new Error(words), { code: "computer_unavailable" });
/** The claim was lost (its live view's registration was fenced): the run's process holds it no more. */
const claimLost = (words: string): Error => Object.assign(new Error(words), { code: "claim_lost" });
const noop = async (): Promise<void> => {};

/** The agent's computer setting: the launch's, else its revision's (computer, else place), else the launch's place. */
async function settingOf(launch: ClaimLaunch, store: Pick<Store, "agents">): Promise<ComputerSetting | undefined> {
  if (launch.computer) return launch.computer;
  const body = launch.revisionId ? ((await store.agents.revision(launch.revisionId))?.body as { computer?: RevisionComputer; place?: PlaceView } | undefined) : undefined;
  if (body?.computer) return body.computer;
  if (body?.place) return computerOfPlace(body.place);
  return launch.place ? computerOfPlace(launch.place) : undefined;
}

/** A phone's platform: what the phone says it is, else its provider's phone configuration's machine kind; android when
 *  neither says ios. */
function phonePlatform(machine: string | undefined, entry: ProviderEntry | undefined): "android" | "ios" {
  const said = machine ?? entry?.capabilities.find((one) => one.kind === "android" || one.kind === "ios")?.kind;
  return said === "ios" ? "ios" : "android";
}

/** The provider's watch of a computer's screen (ComputerProvider.watch), where it has one. */
/** Told once, before the claim waits on its computer's image being built or pulled; never when the host has it. */
export type ImageWait = (making: "build" | "pull", tag: string) => void;
/** The image `provider` made ready, when its descriptor declares it prepares its image (`entry.prepareImage`) and it has
 *  the contract's prepareImage(): its recipe built when the engine lacks it, or its image by name pulled, answering the
 *  tag to start from; undefined for any other provider, which starts from its spec's image. A failure is the provider's
 *  words. `onWait`: told once if the claim waits on a build or a pull. */
async function readyImage(entry: ProviderEntry, provider: ComputerProvider, signal: AbortSignal | undefined, onWait: ImageWait | undefined): Promise<string | undefined> {
  if (!entry.prepareImage || provider.prepareImage === undefined) return undefined;
  const ready = await provider.prepareImage({ ...(signal ? { signal } : {}), ...(onWait ? { onWait } : {}) });
  if (!ready.ok) throw new Error(ready.error.message);
  return ready.value;
}

type Watching = { watch(ref: { readonly id: string; readonly name: string }, context: { readonly signal: AbortSignal }): unknown };
const watching = (provider: ComputerProvider): Watching | undefined =>
  typeof (provider as Partial<Watching>).watch === "function" ? (provider as unknown as Watching) : undefined;

/** `entry`'s computer started through its provider: the run's computers of a lower claim epoch released first (the
 *  janitor's releaseOlder: one claim's computer at a time), then made with the run's labels (and the run's folder, when
 *  it mounts), connected, its groups from its hello; its read-back is the provider's own; its release deletes it. */
async function providerLaunch(
  provider: ComputerProvider,
  claim: { readonly runId: string; readonly epoch: number },
  spec: ComputerSpec,
  signal: AbortSignal | undefined,
): Promise<LaunchedComputer & { machine: string; watch?: (signal: AbortSignal) => unknown }> {
  const older = await releaseOlder(provider, claim.runId, claim.epoch, signal ? { signal } : {});
  if (!older.ok) throw new Error(older.error.message);
  const created = await provider.create(spec, signal ? { signal } : {});
  if (!created.ok) throw new Error(created.error.message);
  const ref = { id: created.value.id, name: created.value.name };
  const release = async () => {
    const released = await provider.release(ref, "delete");
    if (!released.ok) throw new Error(released.error.message);
  };
  const connected = await provider.connect(ref);
  if (!connected.ok) {
    await release().catch(() => undefined);
    throw new Error(connected.error.message);
  }
  const { client, hello } = connected.value;
  return {
    id: ref.id,
    groups: hello.groups,
    // What the machine says it is (a phone's android or ios): its live view's input platform.
    machine: hello.kind,
    client,
    async readBack(): Promise<Result<MountReadBack>> {
      const attached = await provider.attach({ id: ref.id });
      if (!attached.ok) return attached;
      return attached.value.spec.mount ? { ok: true, value: attached.value.spec.mount } : { ok: false, error: { code: "not_found", message: "nothing is mounted in this computer" } };
    },
    // The provider's watch of the screen (provider.watch), which feeds the run's proxied live view.
    ...(watching(provider) ? { watch: (signal: AbortSignal) => watching(provider)!.watch(ref, { signal }) } : {}),
    async release() {
      await connected.value.close().catch(() => undefined);
      await release();
    },
  };
}

/** The runner's start: every computer of `providers` with all of `labels` whose deadline (its agentrun.computer.deadline
 *  label) has passed is ended, once (the janitor's sweep), each provider apart. A provider whose vendor ends its own
 *  computers answers its refusal in words; nothing throws. */
export async function sweepComputers(providers: readonly ComputerProvider[], labels: Readonly<Record<string, string>>, now: Date = new Date()): Promise<{ readonly provider: string; readonly swept: Result<Swept> }[]> {
  const out: { provider: string; swept: Result<Swept> }[] = [];
  for (const provider of providers) {
    const swept = await sweep(provider, { labels: { ...labels }, now }).catch((error: unknown): Result<Swept> => ({ ok: false, error: { code: "refused", message: error instanceof Error ? error.message : String(error) } }));
    out.push({ provider: provider.id, swept });
  }
  return out;
}

/** The run's computer for this claim, started and registered; `{ computer: undefined }` for none. Throws with code
 *  computer_unavailable and the server's words when the agent's computer cannot be had here. */
export async function computerForClaim(launch: ClaimLaunch, store: Pick<Store, "agents" | "sealedKeys" | "computerLedger">, deps: ComputerForClaimDeps): Promise<ClaimComputer> {
  const table = deps.keyTable ?? KEY_TABLE;
  /** The computer this claim started (one per claim): its ref id tags its live view, and its watch feeds it. */
  let made: { readonly id: string; readonly machine?: string; readonly watch?: (signal: AbortSignal) => unknown } | undefined;
  /** The provider entry it was started from: a phone's platform where the computer did not say it. */
  let madeBy: ProviderEntry | undefined;
  const side: ClaimSide = {
    keysOf: providerKeys(deps.kinds, deps.keyOf ?? (async (name) => (deps.sealKey ? await getSealedKey(store, deps.sealKey, name) : undefined))),
    answers: deps.answers ?? (async () => false),
    async launch(entry, { kind, keys, mount, signal }) {
      if (deps.launch) {
        const own = await deps.launch(entry, { kind, keys, ...(mount ? { mount } : {}), ...(signal ? { signal } : {}) });
        const ownWatch = (own as unknown as { watch?: (signal: AbortSignal) => unknown }).watch;
        made = { id: own.id, ...(ownWatch ? { watch: ownWatch } : {}) };
        madeBy = entry;
        return own;
      }
      const make = Object.hasOwn(deps.providers, entry.id) ? deps.providers[entry.id] : undefined;
      if (!make) throw new Error(`this server has no ${entry.label} provider to start one with`);
      const options = providerOptions(entry.id, keys, deps.settings ?? {}, table);
      if (!options.ok) throw new Error(options.error.message);
      const provider = await make(options.options, { ledger: storeLedger(store.computerLedger, entry.id), ...(launch.boxAllow === undefined ? {} : { boxAllow: launch.boxAllow }) });
      // What this provider makes, as it declares it: the spec asks for one of its networks, within its lifetime
      // (computer-deps.ts computerSpecOf).
      const { network: networks, maxLifetimeMs } = provider.capabilities();
      const run: ComputerRun = {
        ...(launch.boxAllow === undefined ? {} : { boxAllow: launch.boxAllow }),
        ...(networks ? { networks } : {}),
        ...(typeof maxLifetimeMs === "number" ? { maxLifetimeMs } : {}),
      };
      // A provider that declares it prepares its own image (its prepareImage(): its recipe built when the engine lacks it,
      // an image by name pulled) does so first, and the computer starts from the tag it answers: the recipe's tag is in no
      // registry, so a run of it unbuilt would be refused. The spec comes first, so a setting it refuses builds nothing.
      const asked = deps.spec(entry, kind as Exclude<ComputerSettingKind, "none">, run);
      const ready = await readyImage(entry, provider, signal, deps.onImageWait);
      const spec: ComputerSpec = { ...asked, ...(ready ? { image: ready } : {}), labels: runLabels(launch.runId, launch.epoch), ...(mount ? { mount } : {}) };
      const launched = await providerLaunch(provider, launch, spec, signal);
      made = { id: launched.id, machine: launched.machine, ...(launched.watch ? { watch: launched.watch } : {}) };
      madeBy = entry;
      return launched;
    },
  };

  const resolved = await resolveComputer(await settingOf(launch, store), deps.mode, deps.kinds, side);
  if ("refused" in resolved) throw unavailable(resolved.refused);
  if (resolved.kind === "none") return { computer: undefined, release: noop };

  // The run's mount credential (Mode 2), minted when the mount was made: removed with the computer, or at once when the
  // start fails after it was minted.
  const revoke = async (): Promise<void> => { await deps.revokeMount?.(); };
  let started: Awaited<ReturnType<typeof resolved.start>>;
  try {
    // The mount check carries the claim's epoch (a disk read-back under another epoch is refused) unless it names one.
    started = await resolved.start({ workspace: deps.workspace, check: { ...deps.check, epoch: deps.check.epoch ?? launch.epoch }, ...(deps.signal ? { signal: deps.signal } : {}) });
  } catch (error) {
    await revoke().catch(() => undefined);
    throw error;
  }
  const computer = started.computer;
  // A desktop's or a phone's: its hold, parking the run's ports while a person holds it, and its live view, proxy-only (no
  // vendor's URL reaches a person), opened under this claim. A fenced open is a lost claim. The release ends the hold.
  let endHold: () => void = () => {};
  let hold: RunHold | undefined;
  let view: { close(why: ViewEnd): unknown } | undefined;
  if (computer && (computer.kind === "desktop" || computer.kind === "phone")) {
    const theHold = computerHold();
    if (deps.openComputerView && made?.watch) {
      const watch = made.watch;
      const input = computer.kind === "desktop" ? "desktop" : phonePlatform(made.machine, madeBy);
      const opened = await deps.openComputerView({ store, sealKey: deps.sealKey, claim: launch.claim ?? { runId: launch.runId, epoch: launch.epoch }, kind: computer.kind, input, tag: made.id, watch: (signal) => watch(signal), hold: theHold });
      if (!opened.ok) {
        await started.release().catch(() => undefined);
        await revoke().catch(() => undefined);
        if (opened.refused === "fenced") throw claimLost(`run ${launch.runId}'s claim (epoch ${launch.epoch}) is no longer this runner's, so its ${computer.kind} was released: ${opened.message}`);
        throw unavailable(`the ${computer.kind}'s live view could not be opened: ${opened.message}`);
      }
      view = opened.view;
    }
    // The run's end closes the hold (workspace/computer-hold.ts close()): a take in force ends `released` (the computer
    // goes; the composer's `ended` ViewEnd maps onto it), the agent's open ask is let go at once, and nothing is taken after.
    endHold = () => theHold.close();
    hold = (ports) => heldHands(ports as never, theHold);
  }
  let released: Promise<void> | undefined;
  return {
    ...(computer ? { computer } : {}),
    ...(hold ? { hold } : {}),
    release: (why: ViewEnd = "released") =>
      (released ??= (async () => {
        await Promise.resolve(view?.close(why)).catch(() => undefined);
        endHold();
        try {
          await started.release();
        } finally {
          await revoke();
        }
      })()),
  };
}
