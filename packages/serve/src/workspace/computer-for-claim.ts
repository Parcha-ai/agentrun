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
//
// A persistent setting (the agent's own computer, agent-computer.ts) is made once under the agent's owner (this server's
// id and the agent's), found again by its owner at each later claim and attached under the new claim, and detached, not
// deleted, at the run's end. A run that finds it held by another run still going is refused, naming that run.
import { randomUUID } from "node:crypto";
import type { BrowserSpec, ComputerConnection, ComputerOwner, ComputerProvider, ComputerSpec, HelloResult, MountReadBack, Result } from "@parcha/agentrun-computer";
import { EPOCH_LABEL, isBrowserProvider, ownerFilter, releaseOlder, RUN_LABEL, runLabels } from "@parcha/agentrun-computer";
import { computerOfPlace, type ComputerSetting as RevisionComputer, type PlaceView } from "../computer-setting.js";
import { KEY_TABLE, type KeyTable, type ProviderSettings, providerOptions } from "../computer-keys.js";
import { getSealedKey } from "../server-keys.js";
import type { Store } from "../store/index.js";
import { type AgentComputerHold, agentComputerOf, forgetAgentComputer, holdAgentComputer, keepAgentComputer, liveHolderOf, reconcileAgentComputer, serverIdOf } from "./agent-computer.js";
import type { MountCheck } from "./attach.js";
import { computerHold, type HeldComputer, heldHands } from "./computer-hold.js";
import { type ProviderLedger, storeLedger } from "./computer-ledger.js";
import { type ClaimBrowser, type ClaimSide, type ComputerSetting, type ComputerSettingKind, type KindRegistry, type LaunchedComputer, type ProviderEntry, providerKeys, resolveComputer } from "./resolve-computer.js";
import type { RunComputer, RunHold } from "./run-tools.js";
import type { Workspace } from "./workspace.js";

/** What the claim knows of the run: its id, the claim's epoch, and where its computer setting is (the launch's own, else
 *  the revision's, else the launch's place, its v2 view). */
export interface ClaimLaunch {
  readonly runId: string;
  readonly epoch: number;
  /** The run's agent: the owner of its own computer where its setting is persistent (agent-computer.ts). */
  readonly agentId?: string;
  /** The claim itself, as the live view's registration fences on it (absent: its run and epoch). */
  readonly claim?: unknown;
  readonly revisionId?: string;
  readonly computer?: ComputerSetting;
  readonly place?: PlaceView;
  /** What the run's computer may reach, as its launch resolved it (run-launch.ts boxAllow): "none" or absent is no
   *  network, a list an allow-list. The computer's spec takes it. */
  readonly boxAllow?: readonly string[] | "none";
  /** The operator set that (run-launch.ts boxAllowSet), not the default. */
  readonly boxAllowSet?: true;
}

/** What of the run a computer's spec is made from, besides its kind and provider: what it may reach, and whether the
 *  operator set that; and what the provider declares it makes (its capabilities()): its networks and its longest
 *  lifetime. Absent, the spec asks as the run allows. */
export interface ComputerRun {
  readonly boxAllow?: readonly string[] | "none";
  readonly boxAllowSet?: true;
  readonly networks?: readonly ("none" | "open" | "allow")[];
  readonly maxLifetimeMs?: number;
}

/** A provider module's create(), by provider id: its options from the saved keys, and the store's ledger for a provider
 *  that keeps one (the phone's `ledger` option); for a claim, what its run's computer may reach (`boxAllow`, the
 *  launch's box_allow), which no provider option carries. The computer package's providers, or a test's stand-in. */
export type ProviderMakers = Readonly<Partial<Record<string, (options: Readonly<Record<string, unknown>>, extras: ProviderExtras) => ComputerProvider | Promise<ComputerProvider>>>>;
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
  /** What a computer of `kind` is made with, besides its labels and its mount: image, lifetime, network (from `run`).
   *  `image`: the one the setting's configuration names, over the kind's default. */
  readonly spec: (entry: ProviderEntry, kind: Exclude<ComputerSettingKind, "none">, run: ComputerRun, image?: string) => Omit<ComputerSpec, "labels" | "mount">;
  /** A provider key's value by its name, as the server reads it (key-meta.ts keyReader: the environment's, else the
   *  saved one). Absent: the saved one alone, opened with `sealKey`. */
  readonly keyOf?: (name: string) => Promise<string | undefined>;
  /** The map from key names to options: serve's own unless given (--faux's). */
  readonly keyTable?: KeyTable;
  readonly settings?: ProviderSettings;
  /** Whether a provider that binds a folder of this machine answers here now (Docker): the Mode 1 default asks it. */
  readonly answers?: (provider: string) => Promise<boolean>;
  /** Its daemon's answer (docker-daemon.ts), asked when a launch on such a provider fails (ClaimSide.daemon). */
  readonly daemon?: ClaimSide["daemon"];
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
  /** Told once a computer the claim made through its provider is connected, with what it says it is (its hello's OS,
   *  the OS's version and its architecture): the run's caller says it on the run's timeline. A browser session, made
   *  by the run's tool, is never told. Absent: nothing is said. */
  readonly onConnected?: (said: ComputerSaid) => void;
  /** Why this machine cannot run a provider's computers, by its provider id (computers.ts hostCommandRefusals: the
   *  phone's adb not on PATH), in words that say how to fix it, or undefined: refused with code computer_unavailable
   *  before anything is rented. Absent: not asked. */
  readonly hostWhy?: (provider: string) => string | undefined;
  /** Why this run's harness takes no computer of `kind`, in words (a CLI harness's of a browser), or undefined: a kind
   *  it refuses is refused with code computer_unavailable before anything is made. Absent: every kind. */
  readonly refuseKind?: (kind: Exclude<ComputerSettingKind, "none">) => string | undefined;
  /** Told what became of the agent's own computer at the claim (a persistent setting): made, attached from an earlier
   *  run, or made again because the one this server kept is gone. The run's caller says it on the run's timeline. */
  readonly onComputerNote?: (words: string) => void;
  readonly signal?: AbortSignal;
}

/** The run's computer at its claim: what runTools takes, the person's hold on a desktop's or phone's ports, the hold
 *  itself with the computer's kind (`held`, what the adapter loop takes as AdapterRunSpec.computer: it commits the hold's
 *  changes to the run's journal and applies the person's take-over and hand-back to it), and its release (idempotent):
 *  the live view closed ("released" when the computer goes before the run's end, "ended" at the run's end), the
 *  owner's view let go, then the computer. */
export interface ClaimComputer {
  readonly computer?: RunComputer;
  readonly hold?: RunHold;
  readonly held?: HeldComputer;
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
/** What a computer the claim made says it is, once it is connected: the provider's name in words, the agent's setting
 *  kind, and its hello's own facts (its OS, the OS's version where it says one, its architecture). */
export type ComputerSaid = {
  readonly provider: string;
  readonly kind: Exclude<ComputerSettingKind, "none">;
  readonly hello: Pick<HelloResult, "os" | "osVersion" | "arch">;
};
/** The image `provider` made ready, when its descriptor declares it prepares its image (`entry.prepareImage`): its
 *  prepareImage(), its recipe built when the engine lacks it or its image by name pulled, answering the tag to start
 *  from; undefined for any other provider, which starts from its spec's image. A provider whose descriptor declares it
 *  and that has none breaks the contract, in words. A failure is the provider's words. `onWait`: told once if the claim
 *  waits on a build or a pull. */
async function readyImage(entry: ProviderEntry, provider: ComputerProvider, signal: AbortSignal | undefined, onWait: ImageWait | undefined): Promise<string | undefined> {
  if (!entry.prepareImage) return undefined;
  if (provider.prepareImage === undefined) throw new Error(`${entry.label}'s descriptor says it prepares its image, but its provider has no prepareImage()`);
  const ready = await provider.prepareImage({ ...(signal ? { signal } : {}), ...(onWait ? { onWait } : {}) });
  if (!ready.ok) throw new Error(ready.error.message);
  return ready.value;
}

type Watching = { watch(ref: { readonly id: string; readonly name: string }, context: { readonly signal: AbortSignal }): unknown };
const watching = (provider: ComputerProvider): Watching | undefined =>
  typeof (provider as Partial<Watching>).watch === "function" ? (provider as unknown as Watching) : undefined;

/** The browser computer `ref`'s CDP URL now: the provider's connect (its signed URL), its words and code when the session
 *  has ended. The connection itself is let go once read. */
async function cdpUrlOf(provider: ComputerProvider, ref: { readonly id: string; readonly name: string }): Promise<string> {
  const connected = await provider.connect(ref);
  if (!connected.ok) throw Object.assign(new Error(connected.error.message), { code: connected.error.code });
  const url = connected.value.cdp?.url;
  await connected.value.close().catch(() => undefined);
  if (!url) throw new Error(`the ${provider.id} computer ${ref.id} gave no CDP connection`);
  return url;
}

/** The label a browser session's computer carries its browser tool's tag in. */
const SESSION_TAG = "agentrun.session";
/** A label value of letters, digits and `_.:-` alone, as every provider takes one. */
const labelValue = (value: string) => value.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 63);
/** A provider failure as an error with the provider's words and code. */
const failed = (error: { readonly code: string; readonly message: string }) => Object.assign(new Error(error.message), { code: error.code });

/** A browser computer's provider as the run's browser tool opens its sessions through it (ClaimBrowser): nothing is made
 *  at the claim. A session's computer is made at the tool's call, under the run's labels (`spec`'s) and the tool's tag,
 *  with the session's own options (spec.browser) where the provider declares them (capabilities().browser); its release
 *  lets go of every one the tool left open. The claim's browser (the agent's computer) and the tool plane's vendor's
 *  (browser-computer.ts planeBrowser) are each one of these. */
export function claimBrowser(provider: ComputerProvider, spec: ComputerSpec): { readonly browser: ClaimBrowser; release(): Promise<void> } {
  // A run's browser: the claim's spec always carries its lifetime (computerSpecOf); an agent's computer (owner) has none.
  const lifetime = spec.lifetimeMs;
  if (lifetime === undefined) throw new TypeError("a run's browser needs lifetimeMs: the claim's spec carries none");
  // A provider of kind browser that declares no session features is opened as one that ends its sessions on a wall clock
  // and takes no option but a viewport.
  const features = provider.capabilities().browser ?? { timeout: "wall-clock" as const };
  const kept = isBrowserProvider(provider) ? provider.downloads : undefined;
  const open = new Set<string>();
  // Each open is its own create request: the run's claim (its run and epoch labels) with the tag and a count, or, for
  // a browser of no run, this browser's own id.
  const run = spec.labels?.[RUN_LABEL];
  const epoch = spec.labels?.[EPOCH_LABEL];
  const requestOf = run !== undefined && epoch !== undefined ? `${run}.${epoch}` : `browser.${randomUUID()}`;
  let opens = 0;
  const release = async (id: string) => {
    const released = await provider.release({ id, name: id }, "delete");
    if (!released.ok) throw failed(released.error);
    open.delete(id);
  };
  const valueOf = async <T>(result: Promise<Result<T>>): Promise<T> => {
    const answered = await result;
    if (!answered.ok) throw failed(answered.error);
    return answered.value;
  };
  return {
    browser: {
      provider: provider.id,
      maxLifetimeS: Math.floor(lifetime / 1000),
      features: structuredClone(features),
      async open(tag, lifetimeS, browser?: BrowserSpec, signal?: AbortSignal) {
        const lifetimeMs = Math.min(lifetime, Math.max(1, Math.round(lifetimeS)) * 1000);
        const requestId = `${requestOf}.${labelValue(tag)}.${++opens}`;
        const created = await provider.create({ ...spec, lifetimeMs, labels: { ...spec.labels, [SESSION_TAG]: labelValue(tag) }, ...(browser ? { browser } : {}) }, { requestId, ...(signal ? { signal } : {}) });
        if (!created.ok) throw failed(created.error);
        open.add(created.value.id);
        return created.value.id;
      },
      async find(tag) {
        const listed = await provider.list({ ...spec.labels, [SESSION_TAG]: labelValue(tag) });
        if (!listed.ok) throw failed(listed.error);
        return listed.value.map((one) => one.ref.id);
      },
      async running(id, signal) {
        const found = await provider.attach({ id }, signal ? { signal } : {});
        if (found.ok) return true;
        if (found.error.code === "not_found" || found.error.code === "gone") return false;
        throw failed(found.error);
      },
      url: (id) => cdpUrlOf(provider, { id, name: id }),
      close: release,
      ...(kept && features.downloads
        ? {
            downloads: {
              list: (id: string) => valueOf(kept.list({ id, name: id })),
              read: (id: string, name: string, maxBytes: number) => valueOf(kept.read({ id, name: id }, name, maxBytes)),
            },
          }
        : {}),
    },
    async release() {
      for (const id of [...open]) await release(id).catch(() => undefined);
    },
  };
}

/** `entry`'s computer started through its provider: the run's computers of a lower claim epoch released first (the
 *  janitor's releaseOlder: one claim's computer at a time), then made with the run's labels (and the run's folder, when
 *  it mounts), connected, its groups from its hello; its read-back is the provider's own; its release deletes it. */
async function providerLaunch(
  provider: ComputerProvider,
  claim: { readonly runId: string; readonly epoch: number },
  spec: ComputerSpec,
  signal: AbortSignal | undefined,
): Promise<LaunchedComputer & { machine: string; hello: HelloResult; watch?: (signal: AbortSignal) => unknown }> {
  const older = await releaseOlder(provider, claim.runId, claim.epoch, signal ? { signal } : {});
  if (!older.ok) throw new Error(older.error.message);
  // The claim is the request: a retry of this launch under the same epoch gets the computer it made, never a second.
  const created = await provider.create(spec, { requestId: `${claim.runId}.${claim.epoch}`, ...(signal ? { signal } : {}) });
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
    hello,
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

/** A run state in which the run still holds what it claimed. */
const LIVE_RUN = new Set(["queued", "running", "parked"]);

/** What the owned launch needs beside the provider: the store (the agent's record, the holder's run row), who owns the
 *  computer, where it was made (provider id and the configuration's image), and where its notes go. */
type OwnedContext = {
  readonly store: Pick<Store, "settings" | "agents"> & { readonly runs?: Pick<Store["runs"], "get"> };
  readonly agentId: string;
  readonly owner: ComputerOwner;
  readonly provider: string;
  readonly image: string | undefined;
  readonly note: (words: string) => void;
};

/**
 * The agent's own computer for this claim (a persistent setting): the one its owner's listing finds, attached under this
 * claim, else one made with `spec` (its owner, no lifetime). The record this server keeps names it, held by this run. A
 * computer whose listing names another run that is still going is refused in words naming that run; one a run that ended
 * left running is taken over. Its release detaches it (Orgo's suspend, say), keeping its state for the agent's next run;
 * then the agent's record is reconciled, so an agent that was archived or turned persistent off while the run went has
 * its computer deleted.
 */
async function ownedLaunch(
  provider: ComputerProvider,
  claim: { readonly runId: string; readonly epoch: number },
  spec: ComputerSpec,
  context: OwnedContext,
  signal: AbortSignal | undefined,
): Promise<LaunchedComputer & { machine: string; hello: HelloResult; watch?: (signal: AbortSignal) => unknown }> {
  const { store, agentId } = context;
  // One run at a time, taken in the store before anything is listed or made (agent-computer.ts holdAgentComputer): two
  // runs of the agent that claim at once never both make a computer. With no run rows to read, a holder is still going.
  // The hold is this claim's (its epoch): a later claim of the run takes it over, and this one's end then does nothing.
  const hold = await holdAgentComputer(store, agentId, claim.runId, liveHolderOf(store), { epoch: claim.epoch });
  let launched: Awaited<ReturnType<typeof ownedStart>>;
  try {
    launched = await ownedStart(provider, claim, spec, context, hold, signal);
  } catch (error) {
    await hold.letGo().catch(() => undefined);
    throw error;
  }
  return {
    ...launched,
    async release() {
      try {
        await launched.release();
      } finally {
        await hold.letGo();
      }
    },
  };
}

/** The owned launch once the run holds the agent's computer (ownedLaunch): found and attached, or made; connected. */
async function ownedStart(
  provider: ComputerProvider,
  claim: { readonly runId: string; readonly epoch: number },
  spec: ComputerSpec,
  context: OwnedContext,
  hold: AgentComputerHold,
  signal: AbortSignal | undefined,
): Promise<LaunchedComputer & { machine: string; hello: HelloResult; watch?: (signal: AbortSignal) => unknown }> {
  const call = signal ? { signal } : {};
  const { store, agentId, note } = context;
  const older = await releaseOlder(provider, claim.runId, claim.epoch, call);
  if (!older.ok) throw new Error(older.error.message);
  const listed = await provider.list(ownerFilter(context.owner), call);
  if (!listed.ok) throw new Error(listed.error.message);
  const record = await agentComputerOf(store, agentId);
  const found = listed.value.find((info) => info.ref.id === record?.id) ?? listed.value[0];
  let ref: { readonly id: string; readonly name: string };
  /** Whether this claim made the computer, or attached the one the agent had. */
  let made: boolean;
  if (found) {
    const holder = found.labels[RUN_LABEL];
    if (found.state === "running" && holder !== undefined && holder !== claim.runId) {
      const row = store.runs ? await store.runs.get(holder) : undefined;
      // With no run rows to read, a holder is taken as still going: never two runs on one agent's computer.
      if (!store.runs || (row !== undefined && LIVE_RUN.has(row.state))) {
        throw new Error(`this agent's computer ${found.ref.name} is held by run ${holder}, which is still ${row?.state ?? "going"}: an agent's own computer serves one run at a time. Start this run again once that one ends`);
      }
    }
    const attached = await provider.attach({ id: found.ref.id }, { claim: { run: claim.runId, epoch: claim.epoch }, ...call });
    if (!attached.ok) throw new Error(attached.error.message);
    ref = { id: found.ref.id, name: found.ref.name };
    made = false;
    note(`Attached this agent's computer ${ref.name}, kept from its last run.`);
  } else {
    const created = await provider.create(spec, { ...call, requestId: `${claim.runId}.${claim.epoch}` });
    if (!created.ok) throw new Error(created.error.message);
    ref = { id: created.value.id, name: created.value.name };
    made = true;
    note(record
      ? `This agent's computer ${record.name} is gone (deleted outside this server): made a new one, ${ref.name}, which later runs get back.`
      : `Made this agent's own computer ${ref.name}: later runs get it back.`);
  }
  // The computer is acquired: its cleanup is in place before anything else is awaited, and whatever fails from here (the
  // hold lost to a later claim included) lets go of exactly what this claim acquired.
  const computer = { provider: context.provider, image: context.image, ...ref };
  // The hold is marked letting go first, so no claim takes it over while the computer is detached. A claim that took it
  // over since (a later claim of this run, resumed, or another run once this one's row ended) has the computer now: it
  // is left as it is.
  const detach = async () => {
    if (!(await hold.releasing())) return;
    const released = await provider.release(ref, "detach");
    if (!released.ok) throw new Error(released.error.message);
    await keepAgentComputer(store, agentId, computer, "detached");
    await reconcileAgentComputer(store, agentId, async () => provider, hold);
  };
  // A launch that fails: a computer this claim made is deleted under its claim, so one a later claim has taken since (a
  // resume whose owner's listing found it) is left to that claim, and the record goes where it names it; one it attached
  // is detached as at the run's end, where the hold is still this claim's. Throws `error`, with what was let go.
  const abandon = async (error: unknown): Promise<never> => {
    const words = error instanceof Error ? error.message : String(error);
    if (!made) {
      const undone = await detach().then(
        () => undefined,
        (failed: unknown) => (failed instanceof Error ? failed.message : String(failed)),
      );
      throw new Error(undone === undefined ? words : `${words}; and ${ref.name} could not be detached: ${undone}`);
    }
    const deleted = await provider.release(ref, "delete", { claim: { run: claim.runId, epoch: claim.epoch } });
    if (deleted.ok) await forgetAgentComputer(store, agentId, ref.id).catch(() => undefined);
    throw new Error(`${words}; ${ref.name}, which this claim made, ${deleted.ok ? "was deleted" : `was not deleted (${deleted.error.message})`}`);
  };
  let connected: ComputerConnection;
  try {
    // A later claim of this run (or another run, this one's row ended) that took the hold over while this one attached
    // or made the computer has it now: its record is that claim's to write.
    if (!(await hold.holds())) throw new Error(`fenced: this agent's computer ${ref.name} was taken over by a later claim while run ${claim.runId}'s claim at epoch ${claim.epoch} ${made ? "made" : "attached"} it; it is left to that claim`);
    await keepAgentComputer(store, agentId, computer, "held", { run: claim.runId });
    const opened = await provider.connect(ref);
    if (!opened.ok) throw new Error(opened.error.message);
    connected = opened.value;
  } catch (error) {
    return abandon(error);
  }
  const { client, hello } = connected;
  return {
    id: ref.id,
    groups: hello.groups,
    machine: hello.kind,
    hello,
    client,
    // An agent's own computer mounts no run's folder (resolve-computer.ts refuses one that would).
    async readBack(): Promise<Result<MountReadBack>> {
      return { ok: false, error: { code: "not_found", message: "an agent's own computer mounts no run's folder" } };
    },
    ...(watching(provider) ? { watch: (signal: AbortSignal) => watching(provider)!.watch(ref, { signal }) } : {}),
    async release() {
      await connected.close().catch(() => undefined);
      await detach();
    },
  };
}

/** The run's computer for this claim, started and registered; `{ computer: undefined }` for none. Throws with code
 *  computer_unavailable and the server's words when the agent's computer cannot be had here. */
export async function computerForClaim(
  launch: ClaimLaunch,
  // `settings` and `runs`: the agent's own computer's record and its holder's run row, for a persistent setting alone.
  store: Pick<Store, "agents" | "sealedKeys" | "computerLedger"> & { readonly settings?: Store["settings"]; readonly runs?: Pick<Store["runs"], "get"> },
  deps: ComputerForClaimDeps,
): Promise<ClaimComputer> {
  const table = deps.keyTable ?? KEY_TABLE;
  /** The computer this claim started (one per claim): its ref id tags its live view, and its watch feeds it. */
  let made: { readonly id: string; readonly machine?: string; readonly watch?: (signal: AbortSignal) => unknown } | undefined;
  /** The provider entry it was started from: a phone's platform where the computer did not say it. */
  let madeBy: ProviderEntry | undefined;
  const side: ClaimSide = {
    keysOf: providerKeys(deps.kinds, deps.keyOf ?? (async (name) => (deps.sealKey ? await getSealedKey(store, deps.sealKey, name) : undefined))),
    answers: deps.answers ?? (async () => false),
    ...(deps.daemon ? { daemon: deps.daemon } : {}),
    async launch(entry, { kind, keys, configuration, mount, gpu, persistent, signal }) {
      // An agent's own computer needs its agent and the store's record of it; the server's launch (--faux) keeps none.
      if (persistent && (deps.launch || launch.agentId === undefined || store.settings === undefined)) throw new Error("this run can't keep its agent's own computer here: start it again with persistent off");
      if (deps.launch) {
        const own = await deps.launch(entry, { kind, keys, configuration, ...(mount ? { mount } : {}), ...(gpu ? { gpu } : {}), ...(signal ? { signal } : {}) });
        const ownWatch = (own as unknown as { watch?: (signal: AbortSignal) => unknown }).watch;
        made = { id: own.id, ...(ownWatch ? { watch: ownWatch } : {}) };
        madeBy = entry;
        return own;
      }
      const make = Object.hasOwn(deps.providers, entry.id) ? deps.providers[entry.id] : undefined;
      if (!make) throw new Error(`this server has no ${entry.label} provider to start one with`);
      const options = providerOptions(entry.id, keys, deps.settings ?? {}, table);
      if (!options.ok) throw new Error(options.error.message);
      // The configuration the setting selected is built by its own create() options (Orgo's Windows: { os: "windows" }),
      // beside the keys'.
      const provider = await make({ ...options.options, ...configuration.options }, { ledger: storeLedger(store.computerLedger, entry.id), ...(launch.boxAllow === undefined ? {} : { boxAllow: launch.boxAllow }) });
      // What this provider makes, as it declares it: the spec asks for one of its networks, within its lifetime
      // (computer-deps.ts computerSpecOf).
      const { network: networks, maxLifetimeMs } = provider.capabilities();
      const run: ComputerRun = {
        ...(launch.boxAllow === undefined ? {} : { boxAllow: launch.boxAllow }),
        ...(launch.boxAllowSet ? { boxAllowSet: true as const } : {}),
        ...(networks ? { networks } : {}),
        ...(typeof maxLifetimeMs === "number" ? { maxLifetimeMs } : {}),
      };
      // A provider that declares it prepares its own image (its prepareImage(): its recipe built when the engine lacks it,
      // an image by name pulled) does so first, and the computer starts from the tag it answers: the recipe's tag is in no
      // registry, so a run of it unbuilt would be refused. The spec comes first, so a setting it refuses builds nothing. A
      // configuration that names its image starts from it, else the kind's default.
      const asked = deps.spec(entry, kind as Exclude<ComputerSettingKind, "none">, run, configuration.image);
      const ready = await readyImage(entry, provider, signal, deps.onImageWait);
      const spec: ComputerSpec = { ...asked, ...(ready ? { image: ready } : {}), labels: runLabels(launch.runId, launch.epoch), ...(mount ? { mount } : {}), ...(gpu ? { gpu } : {}) };
      // A browser makes nothing here: the run's browser tool opens each session through it, so a session lives (and is
      // booked) only while the tool holds it.
      if (kind === "browser") {
        // The run's sessions of a lower claim epoch go first, as a computer's do (the janitor's releaseOlder).
        const older = await releaseOlder(provider, launch.runId, launch.epoch, signal ? { signal } : {});
        if (!older.ok) throw new Error(older.error.message);
        const opened = claimBrowser(provider, spec);
        madeBy = entry;
        return { id: entry.id, groups: ["cdp"], browser: opened.browser, release: opened.release };
      }
      let launched: Awaited<ReturnType<typeof providerLaunch>>;
      if (persistent) {
        // The agent's own: its owner (this server and the agent), and no run deadline (it outlives the run).
        const owner: ComputerOwner = { agent: launch.agentId!, server: await serverIdOf({ settings: store.settings! }) };
        const { lifetimeMs: _, ...owned } = spec;
        launched = await ownedLaunch(provider, launch, { ...owned, owner }, {
          store: { settings: store.settings!, agents: store.agents, ...(store.runs ? { runs: store.runs } : {}) },
          agentId: launch.agentId!,
          owner,
          provider: entry.id,
          image: configuration.image,
          note: deps.onComputerNote ?? (() => {}),
        }, signal);
      } else {
        launched = await providerLaunch(provider, launch, spec, signal);
      }
      made = { id: launched.id, machine: launched.machine, ...(launched.watch ? { watch: launched.watch } : {}) };
      madeBy = entry;
      const { os, osVersion, arch } = launched.hello;
      deps.onConnected?.({ provider: entry.label, kind: kind as Exclude<ComputerSettingKind, "none">, hello: { os, ...(osVersion ? { osVersion } : {}), arch } });
      return launched;
    },
  };

  const resolved = await resolveComputer(await settingOf(launch, store), deps.mode, deps.kinds, side);
  if ("refused" in resolved) throw unavailable(resolved.refused);
  if (resolved.kind === "none") return { computer: undefined, release: noop };
  const refusedKind = deps.refuseKind?.(resolved.kind);
  if (refusedKind) throw unavailable(refusedKind);
  // The program its provider runs on this machine (the phone's adb) is checked before anything is rented.
  const hostRefusal = resolved.provider ? deps.hostWhy?.(resolved.provider) : undefined;
  if (hostRefusal) throw unavailable(`This agent's computer is a ${resolved.kind} on ${resolved.provider}, and this runner cannot run it: ${hostRefusal.replace(/[.!?]+$/, "")}.`);

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
  let held: HeldComputer | undefined;
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
    held = { kind: computer.kind, hold: theHold };
  }
  let released: Promise<void> | undefined;
  return {
    ...(computer ? { computer } : {}),
    ...(hold ? { hold } : {}),
    ...(held ? { held } : {}),
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
