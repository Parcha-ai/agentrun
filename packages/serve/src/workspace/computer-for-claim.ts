// The run's computer at its claim, the one call both runner specs make (the adapter loop's and the CLI's): the agent's
// computer setting, resolved in the server's mode against the computer module's kind registry (resolveComputer), started
// for this run under this claim (labels agentrun.run and agentrun.epoch, the run's folder mounted only where the provider
// mounts it), with a hold and its live view when it is a desktop or a phone, and released once at the run's end. The hold
// goes back to the spec (`held`), whose adapter loop journals it and applies the owner's take-over and hand-back rows to it
// (runner/computer-journal.ts); the live view (computer-live.ts openClaimView) drives the same hold. Where the setting
// asks for it (computer.record), the screen is recorded too (computer-record.ts), until the release or a park. A computer that cannot
// be had is refused in words with code computer_unavailable; kind none, or no setting where the server's default is none,
// is no computer.
//
// A run's own computer does not outlive its claim: a later claim (a runner lost, a crash, a server's stop) makes a new
// one. A park is the one exception: the claim that parks keeps a desktop, a phone or a sandbox it has for KEEP_MS
// (`park`, computer-kept.ts), its live view closed saying what the run waits for and that the computer is kept
// (ParkedEnd), and the claim that resumes within that time attaches it again (`reattach`): the same machine, never said
// to be replaced. The claim that makes one says its kind (`made`), which the adapter loop records in the run's
// journal. When a later claim's replaces an earlier claim's (`replaced`: one this claim let go of, or one the run's
// journal says an earlier claim made, hadComputer), the ready line says so (and that the kept one's time had passed,
// `lapsed`), and the run's tools and model are told (run-tools.ts, the adapter loop's computer note). A kept one only
// the runner that kept it can reach again (a Docker container, a machine that dials that runner: computer-kept.ts
// pinnedOf) names that runner and its incarnation on its row (`ClaimLaunch.holder`), and the store's claim rule lets no
// other runner claim the run while that runner is live and the keep lasts; one taken after it is gone and not reached
// here is said to be lost with it (`lost`), and one taken while it is there but not claiming, and not reached here, is
// given back for it to end and said so (`elsewhere`).
//
// A sandbox the claim made can be lost mid-run (its vendor deleted it, or no longer has it): the call that finds it lost
// fails, saying so and that it was not run again (code gone, computer-lost.ts lostInCallWords), and is never sent to the
// new one; the next call of the run's tools starts a new one in its place under this claim (lostAware), its folder
// mounted again (Mode 2: a new mount credential, the lost one's removed), said on the run's timeline, up to `recreates`
// times a claim; the loss after that ends the run, code computer_unavailable. A provider error that is not a loss (a 5xx,
// a timeout) starts nothing. A desktop, a phone, a paired computer and the agent's own are never started again so.
//
// A provider is made with its keys (the server's environment's, else the store's sealed keys, through the composer's
// keyOf: computer-deps.ts), by the names the registry declares, through serve's own
// map of key names to options (computer-keys.ts providerOptions); a provider that keeps sessions with no labels of their
// own (the phone's) is given the store's computer ledger. Nothing here knows a vendor: the registry, the providers' create
// and a test's stand-ins are passed in.
//
// A paired computer (a person's own, attached-computers.ts) is one more provider of the registry for the claim, by its
// id: claimed through the hub of the server's process (the computer package's attachedProvider), or through a runner's
// relay hub once the server moved the box's socket there (dial-relay.ts), released by ending the run's hold, never made
// or deleted.
//
// A persistent setting (the agent's own computer, agent-computer.ts) is made once under the agent's owner (this server's
// id and the agent's), found again by its owner at each later claim and attached under the new claim, and detached, not
// deleted, at the run's end. A run that finds it held by another run still going is refused, naming that run.
import { randomUUID } from "node:crypto";
import type { BrowserComputerProvider, BrowserSpec, ComputerClient, ComputerConnection, ComputerError, ComputerOwner, ComputerProvider, ComputerRef, ComputerSpec, DaemonMethod, DaemonMethods, HelloResult, MountKind, MountReadBack, Result, ScreenWatch, ScreenWatchHandlers, WatchOptions } from "@parcha/agentrun-computer";
import { epochOf, isBrowserProvider, ownerFilter, releaseOlder, releaseUnheld, RUN_LABEL, runLabels } from "@parcha/agentrun-computer";
import { type RecordInput, type Recording, type RecordWatch, startRecording } from "../computer-record.js";
import { computerOfPlace, type ComputerSetting as RevisionComputer, type PlaceView } from "../computer-setting.js";
import { KEY_TABLE, type KeyTable, type ProviderSettings, providerOptions, settingOptions } from "../computer-keys.js";
import { LOST_RECREATES, lostEnd, lostInCallWords, lostRecreatedWords } from "../computer-lost.js";
import { missingNeeds, needsNoSandboxWords, needsWords } from "../computer-needs.js";
import { inToolCall, stopRun } from "../paid-calls.js";
import { getSealedKey } from "../server-keys.js";
import type { Claim, Store } from "../store/index.js";
import { type AgentComputerHold, agentComputerOf, forgetAgentComputer, holdAgentComputer, keepAgentComputer, liveHolderOf, reconcileAgentComputer, serverIdOf } from "./agent-computer.js";
import type { MountCheck } from "./attach.js";
import { type AttachedComputers, namesPaired, pairedProvider, scopedPairedWords, withPaired } from "./attached-computers.js";
import { computerHold, type HeldComputer, heldHands } from "./computer-hold.js";
import { endingDeletes, figuresOf, type IntervalWrites, intervalWrites, stderrLog } from "./computer-intervals.js";
import { type ComputeLedger, type ComputeMeter, computeMeter, type ComputeMeterOptions } from "../compute-cost.js";
import { bounded, deleteKept, dropKept, endKept, finishedKept, heldElsewhere, keepKept, KEEP_MS, KEPT_DELETE_MS, type Kept, keptBy, type KeptHolder, keptTaken, type ParkCause, type ParkedEnd, pinnedOf, readKept, restoreKept, takeKept } from "./computer-kept.js";
import { type ProviderLedger, storeLedger } from "./computer-ledger.js";
import { type BrowserHolds, type ClaimBrowser, type ClaimSide, type ComputerSetting, type ComputerSettingKind, type KindCapabilities, type KindRegistry, type LaunchedComputer, type ProviderEntry, providerKeys, registryHere, resolveComputer, runShellOf, type ShellPlace, type UnheldOptions, type UnheldSession } from "./resolve-computer.js";
import { computerDenied } from "../tool-gate.js";
import { loadToolSettings } from "../tool-plane.js";
import { computerDeniedWords, computerStillOffWords } from "../refusal-words.js";
import type { RunComputer, RunHold } from "./run-tools.js";
import { claimHolds, fencedStore, type FolderStore, type HeldFolder, holdSynced, storedFolder } from "./synced-folder.js";
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
  /** The runner this claim runs in: its name and its process's presence incarnation (runner/presence.ts). A park that
   *  keeps a computer only this runner can reach again (computer-kept.ts pinnedOf) names both on its row, so the claim
   *  rule gives the run back to this runner while it is there. Absent: nothing kept is pinned. */
  readonly holder?: KeptHolder;
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

/** Why a live view ends: the computer was released, the run ended, or the run parked with its computer kept (ParkedEnd:
 *  why it parked, and until when it is kept). */
export type ViewEnd = "released" | "ended" | ParkedEnd;

/** A computer's live frames and input: its provider's watch on the computer's ref (ComputerProvider.watch). */
export type WatchOf = (handlers: ScreenWatchHandlers, options: WatchOptions) => Promise<Result<ScreenWatch>>;

/** The live view of a desktop or a phone, proxy-only, as its registration (computer-live.ts openClaimView, which the
 *  runner composes in) opens it at the claim: fenced on the claim, tagged with the computer's ref id, fed by the
 *  provider's watch, and held by the run's take-over hold. */
export type OpenComputerView = (args: {
  readonly store: unknown;
  readonly sealKey: Buffer | undefined;
  readonly claim: unknown;
  readonly kind: "desktop" | "phone";
  /** How the viewer's input is made into actions: a desktop's, or the phone's platform (its machine kind). */
  readonly input: "desktop" | "android" | "ios";
  readonly tag: string;
  /** The launched computer's watch, bound to its ref: the opener gives the handlers and the signal. */
  readonly watch: WatchOf;
  /** The run's hold (computer-hold.ts ComputerHold). */
  readonly hold: unknown;
  /** Whether the computer is gone now, its provider no longer having it (goneOf): asked when its watch ends gone. */
  readonly gone?: () => Promise<boolean>;
}) => Promise<{ readonly ok: true; readonly view: { close(why: ViewEnd): unknown } } | { readonly ok: false; readonly refused: "fenced" | "bad_tag" | "kind" | "failed"; readonly message: string }>;

export interface ComputerForClaimDeps {
  /** The server's folder mode: 1, a folder of this machine; 2, Archil. */
  readonly mode: 1 | 2;
  /** In Mode 2, the server's Archil region where it has no serverless exec (archil-settings.ts noExecRegionOf): a run
   *  with no computer that mounts its folder has no shell there (resolve-computer.ts shellPlaceOf). */
  readonly noExec: string | undefined;
  /** The computer module's kind registry (or --faux's). */
  readonly kinds: KindRegistry;
  /** The server's seal key: absent, no key is opened, so a provider that needs one is refused in words. */
  readonly sealKey: Buffer | undefined;
  readonly providers: ProviderMakers;
  /** What a computer of `kind` is made with, besides its labels and its mount: image, lifetime, network (from `run`).
   *  `image`: the one the setting's configuration names, over the kind's default. No image: a provider that prepares
   *  its own (prepareImage), which the claim starts from. */
  readonly spec: (entry: ProviderEntry, kind: Exclude<ComputerSettingKind, "none">, run: ComputerRun, image?: string) => Omit<ComputerSpec, "labels" | "mount" | "image"> & { readonly image?: string };
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
  /** A launch of the server's own in place of the providers' (--faux's desktop), for the providers `launches` takes (by
   *  id; absent, every one): any other is made by its provider, as with no launch. Given the claim's run (`run`), as a
   *  provider's create is given it in its labels. */
  readonly launch?: (entry: ProviderEntry, spec: Parameters<ClaimSide["launch"]>[1] & { readonly run?: string }) => ReturnType<ClaimSide["launch"]>;
  readonly launches?: (provider: string) => boolean;
  /** The run's folder (mounted only where the provider mounts it) and the mount check attach runs. */
  readonly workspace: Workspace;
  readonly check: MountCheck;
  /** Removes the run's Archil mount credential (the Archil claim's revoke): called once the computer is released, and
   *  when a start fails after a mount was minted. Absent: nothing was minted (Mode 1). */
  readonly revokeMount?: () => Promise<void>;
  /** The Archil disk this claim's mount credential is on (the Archil claim's disk id), asked only at a park: written into
   *  the row of a computer kept holding the run's folder on Archil, so the janitor that ends the row removes the credential
   *  there with no run lookup (computer-kept.ts Kept.disk). A computer taken back keeps the disk its row named. Absent:
   *  nothing was minted (Mode 1). */
  readonly mountDisk?: () => string;
  /** The live view's registration for a desktop or a phone (proxy-only). Absent: no view is opened. */
  readonly openComputerView?: OpenComputerView;
  /** Where the agent's setting asks for a video of its computer's screen (computer.record): the run's
   *  recordings folder on this machine (paths.ts recordingsFolder) and where its lines on the run's timeline go
   *  (computer-record.ts startRecording; for tests, the program in ffmpeg's place and the bounds). The desktop or phone
   *  this claim attaches is recorded through a watch of its own, with or without a viewer, until its release, the run's
   *  end or its park; a browser's sessions each by the run's browser tool, through its ClaimBrowser's `record`. Absent:
   *  nothing is recorded. */
  readonly recordings?: Pick<RecordInput, "folder" | "say" | "ffmpeg" | "limits">;
  /** Told once, before the claim waits on its computer's image (a provider that makes its own: Docker's recipe built on
   *  a host that lacks it, or a named image pulled); never when the host has it. The run's caller says it on the run's
   *  timeline. Absent: nothing is said. */
  readonly onImageWait?: ImageWait;
  /** Told once a computer the claim made through its provider is connected, with what it says it is (its hello's OS,
   *  the OS's version and its architecture): the run's caller says it on the run's timeline. A browser session, made
   *  by the run's tool, is never told. Absent: nothing is said. */
  readonly onConnected?: (said: ComputerSaid) => void;
  /** Told once, as the claim asks its provider for a new computer (never for a browser, or an agent's own computer,
   *  whose claim says what became of it in onComputerNote): the run's caller says it on the run's timeline, which
   *  otherwise shows nothing while a phone boots. Absent: nothing is said. */
  readonly onStarting?: (said: Pick<ComputerSaid, "provider" | "kind">) => void;
  /** Why this machine cannot run a provider's computers, by its provider id (computers.ts hostCommandRefusals: the
   *  phone's adb not on PATH), in words that say how to fix it, or undefined: refused with code computer_unavailable
   *  before anything is rented. Absent: not asked. */
  readonly hostWhy?: (provider: string) => string | undefined;
  /** The paired computers (attached-computers.ts): each one more provider of `kinds` for this claim, claimed through the
   *  hub of this process. Absent: none is. */
  readonly attached?: AttachedComputers;
  /** Told what became of the agent's own computer at the claim (a persistent setting): made, attached from an earlier
   *  run, or made again because the one this server kept is gone; and when a sandbox the claim made was lost mid-run and
   *  a new one started in its place (computer-lost.ts lostRecreatedWords). The run's caller says it on the run's
   *  timeline. */
  readonly onComputerNote?: (words: string) => void;
  /** The most new sandboxes the claim starts in place of ones its provider lost mid-run (lostAware); the next loss past
   *  them ends the run, code computer_unavailable. Default LOST_RECREATES (2). */
  readonly recreates?: number;
  /** Stops the run for good in `words`, from any caller (paid-calls.ts stopRunWith over the run's ledger's pause): how a
   *  loss past `recreates` ends the run, whoever's call found it (the owner's computer channel too). Absent: the ledger
   *  of the tool call that found it (stopRun), and a loss found outside one stops nothing. */
  readonly stopRun?: (words: string) => Promise<void>;
  /** Whether the run's journal says an earlier claim made the run a computer of its own (ClaimComputer.made, recorded by
   *  the adapter loop: computer-journal.ts hadComputer): asked at a later claim that makes a fresh one, before anything
   *  is rented, so a claim that finds no older computer of the run to let go (the earlier claim let its own go at its
   *  end: a server's stop, a park) still knows it replaces one. Absent: not asked. */
  readonly hadComputer?: () => Promise<boolean>;
  /** Told when the claim attaches a computer an earlier claim kept at its park, whose run folder is mounted under that
   *  claim's Archil mount credential (Mode 2): the credential is this claim's to remove now (archil-claim.ts inherit),
   *  since this claim mints none. Absent: nothing was minted (Mode 1). */
  readonly inheritMount?: () => void;
  /** The kind of the run's computer an earlier claim's deny turned off for the run (runner/computer-journal.ts
   *  computerTurnedOff): this claim starts none, says so, and ends at once the one a park kept, its mount with it.
   *  Absent: the computer is on. */
  readonly turnedOff?: string;
  /** The clock a kept computer's time is read by (computer-kept.ts), and its computers' intervals are written on
   *  (computer-intervals.ts). Default Date.now. */
  readonly now?: () => number;
  /** Where a computer interval that could not be written is said (computer-intervals.ts). Default the runner's stderr. */
  readonly log?: (line: string) => void;
  /** The run's one ledger and the server's environment, for its computers' time (compute-cost.ts): each computer the
   *  claim makes or takes back is metered there, priced by the operator's per-resource settings, its next stretch held
   *  under the run's cap. Absent (a runner of its own with no ledger here), nothing is held or booked: its time is on the
   *  usage read alone. */
  readonly compute?: { readonly ledger: ComputeLedger; readonly env: NodeJS.ProcessEnv; readonly every?: ComputeMeterOptions["every"] };
  readonly signal?: AbortSignal;
}

/** The run's computer at its claim: what runTools takes, the person's hold on a desktop's or phone's ports, the hold
 *  itself with the computer's kind (`held`, what the adapter loop takes as AdapterRunSpec.computer: it commits the hold's
 *  changes to the run's journal and applies the person's take-over and hand-back to it), and its release (idempotent):
 *  the live view closed ("released" when the computer goes before the run's end, "ended" at the run's end), the
 *  owner's view let go, then the computer. */
export interface ClaimComputer {
  readonly computer?: RunComputer;
  /** The agent's computer was not started: every tool it serves the run is set to deny (tool-gate.ts computerDenied), or
   *  an earlier claim's deny turned it off for the run (ComputerForClaimDeps.turnedOff). The run goes on without it, and
   *  its kind's skill is not named to the model. */
  readonly off?: true;
  readonly hold?: RunHold;
  readonly held?: HeldComputer;
  /** The computer is a new one that replaced an earlier claim's (Replaced): nothing on that one comes with it. Absent: the
   *  run's first, or the agent's own or a paired computer, which are the same computer at every claim. */
  readonly replaced?: Replaced;
  /** The claim made the run a computer of its own, of this kind: never the agent's own (a persistent setting), a paired
   *  computer or --faux's launch, nor a browser (its sessions are the browser tool's). The adapter loop records it in the
   *  run's journal, which is how a later claim knows the run had one (hadComputer). */
  readonly made?: MadeKind;
  /** This claim started the computer (a vendor's launch, or --faux's), so nothing has run in it but what the claim runs:
   *  never one an earlier claim kept at its park and this claim took back, the agent's own (a persistent setting, even
   *  made new: every run of the agent shares it) or a paired computer. Only such a computer gets a checkout with the
   *  server's GitHub token (pr-checkout.ts checkoutWhereNoExec). */
  readonly fresh?: true;
  /** The computer outlives the run: a person's paired computer or the agent's own (a persistent setting), never deleted
   *  when the run ends, so the model is never told it is (computerFilesNote). */
  readonly outlives?: true;
  /** The run's sandbox, desktop or phone was made with network "none" (its spec's, computer-deps.ts networkOf): nothing on
   *  it reaches the internet, so the model is told so once (computerOfflineNote). Absent: another network, a paired
   *  computer (a person's own, whose network is theirs), a browser, or a computer --faux's launch made. */
  readonly offline?: true;
  /** The kind of computer a park of this claim keeps (`park`): a desktop, a phone or a sandbox the claim made through its
   *  provider, or took back from an earlier claim's park. Absent: a park lets the computer go as the run's end does. */
  readonly keeps?: KeptKind;
  /** Books the time of every computer this claim holds up to now on the run's ledger, its holds let go, its meter
   *  stopped (compute-cost.ts): run before the run's end or park is written (the spec's beforeRelease), so the end's
   *  cost holds it. Absent where nothing is metered. */
  settle?(): Promise<void>;
  /** Strict durable folder sync for project checkpoints; distinct from metering settlement. */
  syncProject?(signal?: AbortSignal): Promise<void>;
  release(why?: ViewEnd): Promise<void>;
  /** The claim's release at the run's park, for `cause`: a computer it `keeps` is kept for KEEP_MS (computer-kept.ts),
   *  its live view closed with the park's cause and the keep's time (ParkedEnd) and its hold ended, but the machine left
   *  running and its mount credential left in place, and true is answered; any other is released as `release` does, and
   *  false. A synced folder's delta lands first: one that does not keeps nothing, and the park throws as `release` does.
   *  Idempotent with `release`. */
  park?(cause: ParkCause): Promise<boolean>;
  /** The park's keep written ahead of the park, before the run's timeline says it (adapter-loop.ts keepAtPark): the
   *  folder's delta landed, then the row (computer-kept.ts keepKept), once; true when the park will keep the computer.
   *  False: the park keeps nothing (nothing to keep, a delta that did not land, no clock read, another runner's row still
   *  there, a write that failed), and nothing should say it is kept. The park uses this row; a `release` with no park
   *  after it takes the row off. Absent: the park writes the row itself. */
  keepRow?(): Promise<boolean>;
}

/** The kinds of computer a claim makes the run fresh. */
export type MadeKind = "desktop" | "sandbox" | "phone";
/** The kinds of computer a park keeps. */
export type KeptKind = Kept["kind"];

/** A computer the claim made fresh in place of an earlier claim's: its kind, and `folderKept`, the run's folder is on
 *  Archil (Mode 2) and mounted in it, so the folder is kept. `lapsed`: the earlier one was kept at a park, and its time
 *  (KEEP_MS) passed before this claim. `lost`: the earlier one was kept at a park pinned to another runner (or another
 *  process of this runner's name), that runner was gone by this claim, and this claim could not reach it. `elsewhere`:
 *  the same, but that runner was still there (refusing claims, or its word late), so this claim gave the row back for
 *  that runner to end the machine (restoreKept). `refused`: the earlier one was kept at a park, and its provider refused
 *  to attach it again (a Docker computer made before its egress bridge, or bound from another runner's home); the
 *  provider's words went to the runner's log alone. */
export type Replaced = { readonly kind: MadeKind; readonly folderKept: boolean; readonly lapsed?: true; readonly lost?: true; readonly elsewhere?: true; readonly refused?: true };

/** A computer that cannot be had, with the code the run fails with and the server's words. */
const unavailable = (words: string): Error => Object.assign(new Error(words), { code: "computer_unavailable" });
/** The claim was lost (its live view's registration was fenced): the run's process holds it no more. */
const claimLost = (words: string): Error => Object.assign(new Error(words), { code: "claim_lost" });
const noop = async (): Promise<void> => {};

/** A claim's create request: the run and its claim epoch, so a retry of the claim's create finds the computer it made. */
const claimRequestId = (claim: { readonly runId: string; readonly epoch: number }) => `${claim.runId}#${claim.epoch}`;

/** A kept machine (its provider's `id`) a claim gave back, and what marks its row ended once it is gone. */
type KeptGone = { readonly id: string; readonly gone: () => Promise<void> };

/** `provider` that calls `kept.gone` once its delete of the kept machine answers it gone: ok, or not_found or gone (its
 *  vendor ended it already). A gone that throws is the store's: the row stays ending, for the janitor. */
function keptDeletes(provider: ComputerProvider, kept: KeptGone): ComputerProvider {
  return new Proxy(provider, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (key !== "release") return typeof value === "function" ? value.bind(target) : value;
      return async (...args: Parameters<ComputerProvider["release"]>) => {
        const released = await target.release(...args);
        const [ref, how] = args;
        if (ref.id === kept.id && how === "delete" && (released.ok || released.error.code === "not_found" || released.error.code === "gone")) await kept.gone().catch(() => undefined);
        return released;
      };
    },
  });
}

/** The run's computers of a lower claim epoch released (the janitor's releaseOlder: one claim's computer at a time), its
 *  failure thrown in its words; the ones it deleted, each an earlier claim's computer its runner never let go (a runner
 *  lost, a crash). A run's first claim is epoch 1 (a queued run is epoch 0; each claim and release moves it up one): no
 *  claim came before it to leave a computer, so the provider is not asked (its list is a vendor round trip before the
 *  create). */
async function releaseOlderClaims(provider: ComputerProvider, claim: { readonly runId: string; readonly epoch: number }, signal: AbortSignal | undefined, ending?: { readonly entry: string; readonly writes: IntervalWrites; readonly keptGone?: KeptGone }): Promise<readonly ComputerRef[]> {
  if (claim.epoch <= 1) return [];
  // Each delete that answers ok ends its interval as it answers (computer-intervals.ts endingDeletes), so one deleted
  // before another failed, or before the call was cut, keeps its end; one detached or not let go is left open.
  const releasing = ending ? endingDeletes(provider, ending.entry, ending.writes) : provider;
  const older = await releaseOlder(ending?.keptGone ? keptDeletes(releasing, ending.keptGone) : releasing, claim.runId, claim.epoch, signal ? { signal } : {});
  if (!older.ok) throw new Error(older.error.message);
  return older.value.released;
}

/** The agent's computer setting: the launch's, else its revision's (computer, else place), else the launch's place. The
 *  run's end reads it the same way (run-end-computers.ts). */
export async function settingOf(launch: ClaimLaunch, store: Pick<Store, "agents">): Promise<ComputerSetting | undefined> {
  if (launch.computer) return launch.computer;
  const body = launch.revisionId ? ((await store.agents.revision(launch.revisionId))?.body as { computer?: RevisionComputer; place?: PlaceView } | undefined) : undefined;
  if (body?.computer) return body.computer;
  if (body?.place) return computerOfPlace(body.place);
  return launch.place ? computerOfPlace(launch.place) : undefined;
}

/** The kind of the claim's computer `setting` when every tool it serves the run is set to deny (tool-gate.ts
 *  computerDenied): the revision's grants and tool settings over the server's, as the run's gate reads them. `shell`: where
 *  the run's shell would be with it. A store with no settings, or settings that do not read, deny nothing. */
async function deniedKind(launch: ClaimLaunch, setting: ComputerSetting, store: Pick<Store, "agents"> & { readonly settings?: Store["settings"] }, shell: ShellPlace): Promise<string | undefined> {
  if (setting.kind === "none" || !store.settings || !launch.revisionId) return undefined;
  const revision = await store.agents.revision(launch.revisionId);
  if (!revision || revision.kind !== "agentic") return undefined;
  const server = await loadToolSettings({ settings: store.settings }).catch(() => undefined);
  if (!server || server.unreadable) return undefined;
  return computerDenied({ kind: revision.kind, body: { ...(revision.body as object), computer: setting } }, shell, server);
}

/** A phone's platform: what the phone says it is, else its provider's phone configuration's machine kind; android when
 *  neither says ios. */
function phonePlatform(machine: string | undefined, entry: ProviderEntry | undefined): "android" | "ios" {
  const said = machine ?? entry?.capabilities.find((one) => one.kind === "android" || one.kind === "ios")?.kind;
  return said === "ios" ? "ios" : "android";
}

/** Told once, before the claim waits on its computer's image being built or pulled; never when the host has it. */
export type ImageWait = (making: "build" | "pull", tag: string) => void;
/** What a computer the claim made says it is, once it is connected: the provider's name in words, the agent's setting
 *  kind, and its hello's own facts (its OS, the OS's version where it says one, its architecture). */
export type ComputerSaid = {
  readonly provider: string;
  readonly kind: Exclude<ComputerSettingKind, "none">;
  readonly hello: Pick<HelloResult, "os" | "osVersion" | "arch">;
  /** It replaced an earlier claim's computer (ClaimComputer.replaced). */
  readonly replaced?: Replaced;
  /** It is the computer an earlier claim kept at the run's park, attached again as it was. */
  readonly kept?: true;
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

/** The provider's watch of a computer's screen on `ref` (ComputerProvider.watch), where it has one. */
const watchOf = (provider: ComputerProvider, ref: { readonly id: string; readonly name: string }): WatchOf | undefined =>
  typeof provider.watch === "function" ? (handlers, options) => provider.watch!(ref, handlers, options) : undefined;

/** Whether the computer `id` is gone now: its provider's listing under `labels` (the run's, or its owner's for the
 *  agent's own) no longer shows it, deleted under the run (by the vendor's own API, say) or going. The listing is the
 *  janitor's read: it starts nothing and leaves out a machine on its way out. A listing that failed is not gone. A
 *  desktop listed stopped is still there. A phone is never stopped and kept (a phone provider has no stop), so one
 *  listed stopped is ending (the phone harness lists a closing or errored session so) and counts as gone. */
const goneOf = (provider: ComputerProvider, id: string, labels: Record<string, string>, kind: "desktop" | "phone") => async (): Promise<boolean> => {
  const listed = await provider.list(labels);
  return listed.ok && !listed.value.some((info) => info.ref.id === id && (kind === "desktop" || info.state === "running"));
};

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
  // When the vendor's listing said each session a find listed was made (madeAt): a session a release by its tag ended beside
  // the one it was for is charged from then.
  const made = new Map<string, string>();
  // The tag labels of the sessions this claim is opening now, how many opens each: a let-go never releases one whose
  // create is still in flight (releaseUnheld), which its create answers.
  const creating = new Map<string, number>();
  // The run and claim epoch its sessions are made under: what a let-go releases the unheld ones of (releaseUnheld).
  const run = spec.labels?.[RUN_LABEL];
  const epoch = spec.labels ? epochOf(spec.labels) : undefined;
  const unheld = run !== undefined && epoch?.ok
    ? {
        async releaseUnheld(holds: () => BrowserHolds | Promise<BrowserHolds>, { signal, releasing, released }: UnheldOptions = {}) {
          // Read once, at the first computer of the run and epoch the list gave (after the list).
          let read: Promise<{ ids: ReadonlySet<string>; tags: Set<string> }> | undefined;
          const held = () => (read ??= Promise.resolve(holds()).then((got) => ({ ids: got.ids, tags: new Set([...got.tags].map(labelValue)) })));
          const left: string[] = [];
          const session = (one: { ref: { id: string }; labels: Record<string, string>; createdAt?: Date }): UnheldSession => ({ id: one.ref.id, tag: one.labels[SESSION_TAG] ?? null, createdAt: one.createdAt?.toISOString() ?? null });
          const swept = await valueOf(
            releaseUnheld(
              provider,
              run,
              epoch.value,
              async (info) => {
                const tag = info.labels[SESSION_TAG] ?? "";
                if (creating.has(tag)) {
                  left.push(info.ref.id);
                  return true;
                }
                const { ids, tags } = await held();
                return ids.has(info.ref.id) || tags.has(tag);
              },
              {
                ...(signal ? { signal } : {}),
                ...(releasing ? { releasing: (one) => releasing(session(one)) } : {}),
                ...(released ? { released: (one) => released(session(one)) } : {}),
              },
            ),
          );
          for (const one of swept.released) open.delete(one.ref.id);
          return {
            released: swept.released.map(session),
            failed: swept.failed.map((one) => `${one.ref.id}: ${one.problem}`),
            creating: left,
          };
        },
      }
    : {};
  return {
    browser: {
      ...unheld,
      provider: provider.id,
      maxLifetimeS: Math.floor(lifetime / 1000),
      features: structuredClone(features),
      async open(tag, lifetimeS, browser?: BrowserSpec, signal?: AbortSignal) {
        const lifetimeMs = Math.min(lifetime, Math.max(1, Math.round(lifetimeS)) * 1000);
        const label = labelValue(tag);
        creating.set(label, (creating.get(label) ?? 0) + 1);
        // Each open is its own request: a session closed and opened again under one tag is a new one.
        const created = await provider
          .create({ ...spec, lifetimeMs, labels: { ...spec.labels, [SESSION_TAG]: label }, ...(browser ? { browser } : {}) }, { requestId: randomUUID(), ...(signal ? { signal } : {}) })
          .finally(() => {
            const left = (creating.get(label) ?? 1) - 1;
            if (left > 0) creating.set(label, left);
            else creating.delete(label);
          });
        if (!created.ok) throw failed(created.error);
        open.add(created.value.id);
        return created.value.id;
      },
      async find(tag) {
        const listed = await provider.list({ ...spec.labels, [SESSION_TAG]: labelValue(tag) });
        if (!listed.ok) throw failed(listed.error);
        for (const one of listed.value) if (one.createdAt instanceof Date) made.set(one.ref.id, one.createdAt.toISOString());
        return listed.value.map((one) => one.ref.id);
      },
      madeAt: (id) => made.get(id) ?? null,
      async running(id, signal) {
        const found = await provider.attach({ id }, signal ? { signal } : {});
        if (found.ok) return true;
        if (found.error.code === "not_found" || found.error.code === "gone") return false;
        throw failed(found.error);
      },
      url: (id) => cdpUrlOf(provider, { id, name: id }),
      close: release,
      ...(isBrowserProvider(provider) && typeof provider.sessionUsage === "function"
        ? { usage: (id: string, signal?: AbortSignal) => valueOf((provider as Required<Pick<BrowserComputerProvider, "sessionUsage">>).sessionUsage({ id, name: id }, signal ? { signal } : {})) }
        : {}),
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

/** A run's computer of `provider` the claim holds, connected: its groups from its hello, its read-back the provider's
 *  own, its connection's `close` (a park keeps the machine), and its release, which deletes it. */
type ProviderComputer = LaunchedComputer & { readonly client: ComputerClient; readBack(): Promise<Result<MountReadBack>>; machine: string; hello: ComputerSaid["hello"]; watch?: WatchOf; ref: { readonly id: string; readonly name: string }; close(): Promise<void> };

/** The run's computer `ref` of `provider`, connected (`connection`), as the claim holds it (ProviderComputer). `ended`:
 *  told once its delete answered ok (its interval's end, computer-intervals.ts). */
function providerComputer(provider: ComputerProvider, ref: { readonly id: string; readonly name: string }, connection: ComputerConnection, ended?: () => Promise<void>): ProviderComputer {
  const { client, hello } = connection;
  const watch = watchOf(provider, ref);
  const close = async () => {
    await connection.close().catch(() => undefined);
  };
  return {
    id: ref.id,
    ref,
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
    ...(watch ? { watch } : {}),
    close,
    async release() {
      await close();
      const released = await provider.release(ref, "delete");
      if (!released.ok) throw new Error(released.error.message);
      await ended?.();
    },
  };
}

/** `entry`'s computer started through its provider: the run's computers of a lower claim epoch released first
 *  (releaseOlderClaims; none at a run's first claim; `releasedOlder`, whether it deleted one), then made with the run's
 *  labels (and the run's folder, when it mounts), connected (providerComputer); its release deletes it. Its interval
 *  (computer-intervals.ts) is opened under `entry` (the provider's registry id) once the create answers, of `kind`, and
 *  ended by each delete that answers ok. */
async function providerLaunch(
  provider: ComputerProvider,
  claim: { readonly runId: string; readonly epoch: number },
  spec: ComputerSpec,
  signal: AbortSignal | undefined,
  interval: { readonly writes: IntervalWrites; readonly entry: string; readonly kind: string; readonly meter?: ComputeMeter; readonly keptGone?: KeptGone },
): Promise<ProviderComputer & { releasedOlder: boolean }> {
  const { writes, entry, keptGone } = interval;
  const releasedOlder = (await releaseOlderClaims(provider, claim, signal, { entry, writes, ...(keptGone ? { keptGone } : {}) })).length > 0;
  // Its first stretch held under the run's cap at what the create asks for, before anything is made: refused, nothing is.
  const ahead = await interval.meter?.before(entry, figuresOf(spec));
  // The claim is the request: a retry of this launch under the same epoch gets the computer it made, never a second.
  const created = await provider.create(spec, { requestId: claimRequestId(claim), ...(signal ? { signal } : {}) });
  if (!created.ok) {
    void ahead?.drop();
    throw new Error(created.error.message);
  }
  const ref = { id: created.value.id, name: created.value.name };
  // What it was made with: its provider's figures where it said them, else what was asked. Metered from here.
  const figures = figuresOf(spec, created.value.resources);
  await writes.opened(entry, ref.id, claim.runId, interval.kind, figures);
  interval.meter?.start(entry, ref.id, figures, ahead);
  const ended = () => writes.ended(entry, ref.id);
  const connected = await provider.connect(ref);
  if (!connected.ok) {
    const released = await provider.release(ref, "delete").catch(() => undefined);
    if (released?.ok) await ended();
    throw new Error(connected.error.message);
  }
  return { ...providerComputer(provider, ref, connected.value, ended), releasedOlder };
}

/** The words a hosted provider's connection answers every call in once its vendor deleted the machine (the computer
 *  package's hosted deletedSaid: "the computer <name> (<id>) was deleted: <vendor> no longer has it"). */
const DELETED_SAID = /^the computer \S+ \(\S+\) was deleted: /;

/** Whether `error` says the computer that answered it is gone (its connection ended, or its vendor deleted it), as a call
 *  in flight on one another call found lost answers. */
const lossSaid = (error: ComputerError): boolean => error.code === "gone" || (error.code === "not_found" && DELETED_SAID.test(error.message));

/** What a sandbox the claim made needs to be started again once its provider lost it (lostAware). */
type Renewal = {
  readonly provider: ComputerProvider;
  /** The most new ones this claim starts (ComputerForClaimDeps.recreates). */
  readonly max: number;
  /** A new sandbox in place of the lost one, the claim's `times`th, connected and its mount read back: what the lost one
   *  was made with, under the same claim's labels. A synced folder is held in it through `own` of it (lostAware's
   *  ownOf). Its words, thrown, when it can't be had. */
  remake(times: number, own: (held: ProviderComputer) => ComputerClient): Promise<ProviderComputer>;
  /** Told once a new one is up, with its name: the run's Timeline row. */
  started(name: string): void;
  /** The run's end in `words`, once a lost sandbox is past the bound: the run's own stop (ComputerForClaimDeps.stopRun). */
  stop(words: string): Promise<void>;
  /** Whether a lost sandbox may be started again now: inside a tool call of the run's, and the claim still held. */
  may(): boolean;
};

/**
 * `first`, a sandbox the claim made through its provider (or took back from the run's park), held so its loss is not the
 * run's: a call it answers deleted (the hosted connection's own words, DELETED_SAID), or gone with its provider
 * confirming it no longer has it (attach answers not_found or gone), marks it lost, and that call fails code gone in
 * lostInCallWords (the computer was lost while it ran, and it was not run again), never not_found: a caller that reads
 * not_found as a program or file not there (the shell's fallback from bash to sh) would send it again, to the new one. The
 * next call made inside one of the run's tool calls starts a new one in its place (`renewal.remake`, one at a time
 * however many calls ask) and goes to it: the lost one let go, the run's Timeline told (`started`). Each new one is the
 * claim's, under its epoch: a later claim lets it go as it lets any of the run's older computers go. A start that fails
 * answers its words and counts for nothing: the next call tries again under the same request, so a retry finds what an
 * earlier try made. Gone with the provider still reporting the machine, or its read failing (a 5xx, a timeout), is not
 * lost: the call's own answer stands. A call in flight on one another call found lost (or already replaced) is cut by the
 * same loss: an answer that says gone fails in lostInCallWords too, and any other answer stands; neither marks the new
 * one lost. A loss once `renewal.max` new ones were started ends the run at once (`renewal.stop`, computer-lost.ts
 * lostEnd's words, code computer_unavailable), the call that found it answering those words, as every later call does.
 * A call outside a tool call (the run's end sweeping its scratch, the owner's computer channel) gets the loss's own
 * answer and starts nothing.
 */
function lostAware(first: ProviderComputer, renewal: Renewal): ProviderComputer {
  let current = first;
  /** Why the current one is lost, until a new one replaces it. */
  let lost: ComputerError | undefined;
  /** How many new ones this claim started. */
  let made = 0;
  /** The current one was let go since it was lost (a failed start's retry does not let it go again). */
  let letGo = false;
  /** The bound was passed: every call answers this. */
  let spent: ComputerError | undefined;
  let renewing: Promise<ComputerError | undefined> | undefined;
  let released = false;
  /** Whether `error`, answered by `held`, says its provider no longer has it. */
  const goneFrom = async (held: ProviderComputer, error: ComputerError): Promise<boolean> => {
    if (error.code === "not_found") return DELETED_SAID.test(error.message);
    if (error.code !== "gone") return false;
    const found = await renewal.provider.attach({ id: held.ref.id }).catch(() => undefined);
    return found !== undefined && !found.ok && (found.error.code === "not_found" || found.error.code === "gone");
  };
  /** The answer of a call in flight on `held` when it was lost, `why` its own: inside one of the run's tool calls, gone in
   *  lostInCallWords; outside one (the run's end, the owner's computer channel), `why` itself, as every later call
   *  outside one answers the loss. */
  const cutBy = (held: ProviderComputer, why: ComputerError): ComputerError => (renewal.may() ? { code: "gone", message: lostInCallWords(held.ref.name, why.message) } : why);
  /** `why`, the current one's (`held`'s) loss, as the call that found it answers: past the bound, the run's end, at once. */
  const lose = async (held: ProviderComputer, why: ComputerError): Promise<ComputerError> => {
    if (made < renewal.max) {
      lost = why;
      letGo = false;
      return cutBy(held, why);
    }
    spent = { code: "not_found", message: lostEnd(renewal.max, why.message) };
    await renewal.stop(spent.message);
    return spent;
  };
  /** `held`'s own client, for a synced folder's sync, which stays on the machine it holds and starts nothing: a loss it
   *  finds while `held` is the current one marks it lost as any call's does (lose), so the run's next call starts the new
   *  one before it runs. Its answers on a machine already lost or replaced stand. */
  const ownOf = (held: ProviderComputer): ComputerClient => ({
    async call<M extends DaemonMethod>(method: M, params: DaemonMethods[M]["params"], options?: { signal?: AbortSignal }): Promise<Result<DaemonMethods[M]["result"]>> {
      const answered = await held.client.call(method, params, options);
      if (answered.ok || spent || held !== current || lost) return answered;
      if (!(await goneFrom(held, answered.error)) || spent || held !== current || lost) return answered;
      return { ok: false, error: await lose(held, answered.error) };
    },
    close() {
      held.client.close();
    },
  });
  /** A new one in place of the lost one, or why the run has none now. */
  const renew = async (why: ComputerError): Promise<ComputerError | undefined> => {
    // The lost one's resources go first: a vendor's delete of one it no longer has is done already.
    if (!letGo) {
      await current.release().catch(() => undefined);
      letGo = true;
    }
    let fresh: ProviderComputer;
    try {
      fresh = await renewal.remake(made + 1, ownOf);
    } catch (error) {
      return { code: "gone", message: `${why.message}; a new sandbox could not be started: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (released) {
      await fresh.release().catch(() => undefined);
      return why;
    }
    made += 1;
    current = fresh;
    lost = undefined;
    renewal.started(fresh.ref.name);
    return undefined;
  };
  const client: ComputerClient = {
    async call<M extends DaemonMethod>(method: M, params: DaemonMethods[M]["params"], options?: { signal?: AbortSignal }): Promise<Result<DaemonMethods[M]["result"]>> {
      if (spent) return { ok: false, error: spent };
      if (lost) {
        if (!renewal.may()) return { ok: false, error: lost };
        const why = lost;
        const failed = await (renewing ??= renew(why).finally(() => (renewing = undefined)));
        if (failed) return { ok: false, error: failed };
      }
      const held = current;
      const answered = await held.client.call(method, params, options);
      if (answered.ok || spent) return answered;
      // Another call found `held` lost, or replaced it, while this one was in flight on it (a command's stdout and stderr
      // read side by side): an answer that says gone is this call's cut by the same loss, never sent again either. Any
      // other answer stands, and starts nothing.
      if (held !== current || lost) return lossSaid(answered.error) ? { ok: false, error: cutBy(held, answered.error) } : answered;
      const gone = await goneFrom(held, answered.error);
      if (!gone) return answered;
      // Read back after another call replaced it, or found it lost, or the run ended: cut by that loss, nothing more.
      if (spent) return answered;
      if (held !== current || lost) return { ok: false, error: cutBy(held, answered.error) };
      return { ok: false, error: await lose(held, answered.error) };
    },
    close() {
      current.client.close();
    },
  };
  return {
    get id() {
      return current.id;
    },
    get ref() {
      return current.ref;
    },
    groups: first.groups,
    machine: first.machine,
    hello: first.hello,
    client,
    // The current one's own (ownOf): a synced folder's sync through it marks a loss it finds and starts nothing.
    get own() {
      return ownOf(current);
    },
    readBack: () => current.readBack(),
    close: () => current.close(),
    async release() {
      released = true;
      await current.release();
    },
  };
}

/** The computer an earlier claim of the run kept at its park (`kept`), attached again through `provider` and connected;
 *  `refused`, the provider's words, when it refuses to attach it; or undefined when its provider no longer has it or it
 *  does not connect (one that does not is deleted). */
async function keptLaunch(provider: ComputerProvider, kept: Kept, signal: AbortSignal | undefined, ended: () => Promise<void>): Promise<ProviderComputer | { readonly refused: string } | undefined> {
  const ref = { id: kept.id, name: kept.name };
  const found = await provider.attach({ id: ref.id }, signal ? { signal } : {});
  if (!found.ok) return found.error.code === "refused" ? { refused: found.error.message } : undefined;
  const connected = await provider.connect(ref);
  if (!connected.ok) {
    const released = await provider.release(ref, "delete").catch(() => undefined);
    if (released?.ok) await ended();
    return undefined;
  }
  return providerComputer(provider, ref, connected.value, ended);
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
): Promise<LaunchedComputer & { machine: string; hello: HelloResult; watch?: WatchOf }> {
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
): Promise<LaunchedComputer & { machine: string; hello: HelloResult; watch?: WatchOf }> {
  const call = signal ? { signal } : {};
  const { store, agentId, note } = context;
  await releaseOlderClaims(provider, claim, signal);
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
    const created = await provider.create(spec, { ...call, requestId: claimRequestId(claim) });
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
    // The provider's watch of the screen, which feeds the run's proxied live view, as a made computer's.
    ...(watchOf(provider, ref) ? { watch: watchOf(provider, ref)! } : {}),
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
  // `settings` and `runs`: the agent's own computer's record and its holder's run row, for a persistent setting; and the
  // run's own row, whose epoch and runner fence every write of the run's folder to its disk.
  // `computerIntervals`: where each computer the claim makes is written, from its create to its proven delete
  // (computer-intervals.ts); absent, none is. `runners`: who is there now, read when this claim took a kept row pinned to
  // another runner and could not reach its machine (reattach): the row goes back to a runner still there.
  store: Pick<Store, "agents" | "sealedKeys" | "computerLedger"> & { readonly settings?: Store["settings"]; readonly runs?: Pick<Store["runs"], "get">; readonly computerIntervals?: Store["computerIntervals"]; readonly runners?: Pick<Store["runners"], "live"> },
  deps: ComputerForClaimDeps,
): Promise<ClaimComputer> {
  // The run's disk as this claim writes the folder on it: each write refused once a later claim has taken the run (Q1).
  const runs = store.runs;
  const holds = runs ? claimHolds((runId) => runs.get(runId), launch) : undefined;
  const diskOf = (): FolderStore | undefined => {
    const disk = deps.workspace.syncStore?.();
    return disk && holds ? fencedStore(disk, holds) : disk;
  };
  /** The claim's synced folder, held at the start and again by each new sandbox in place of a lost one. */
  const folderHeld: HeldFolder = {};
  const table = deps.keyTable ?? KEY_TABLE;
  // The paired computers, each one more provider of the registry (attached-computers.ts): a setting names one by its id.
  const paired = deps.attached ? await deps.attached.rows() : [];
  const keyOf = deps.keyOf ?? (async (name: string) => (deps.sealKey ? await getSealedKey(store, deps.sealKey, name) : undefined));
  // Each provider as this server has it (registryHere: the mounts its keys turn on, whether the operator names its
  // image, and no Archil mount where its settings make its machines dial this server), as a run's start reads it, so the
  // claim holds the folder the start said it would.
  const kinds = await registryHere(withPaired(deps.kinds, paired), keyOf, (provider) => settingOptions(provider, deps.settings ?? {}, table));
  /** The computer this claim started (one per claim): its ref id tags its live view, and its watch feeds it. */
  let made: { readonly id: string; readonly machine?: string; readonly watch?: WatchOf; readonly gone?: () => Promise<boolean> } | undefined;
  /** The provider entry it was started from: a phone's platform where the computer did not say it. */
  let madeBy: ProviderEntry | undefined;
  /** Set when the computer this claim made fresh replaced an earlier claim's. */
  let replaced: Replaced | undefined;
  /** The kind of the computer this claim made the run fresh (ClaimComputer.made). */
  let ownKind: MadeKind | undefined;
  /** The computer outlives the run: a paired one or the agent's own (ClaimComputer.outlives). */
  let outlives = false;
  /** This claim started the computer (ClaimComputer.fresh). */
  let startedHere = false;
  /** The computer was made, or taken back, with network "none" (ClaimComputer.offline). */
  let offline = false;
  const now = deps.now ?? Date.now;
  /** The store's clock (the deadlines': the database's on Postgres), the one a kept computer's `until` is stamped and
   *  judged by everywhere (computer-kept.ts Kept.until), never this runner's own. */
  const storeClock = (): Promise<number> => store.sealedKeys.clock();
  /** Each computer this claim makes through its provider, from its create to its proven delete. */
  const written = intervalWrites(store, deps.log, now);
  /** Its time on the run's ledger (compute-cost.ts), while this claim holds it; none with no ledger here. */
  const meter = deps.compute ? computeMeter({ env: deps.compute.env, ledger: deps.compute.ledger, booked: written.booked, now, ...(deps.compute.every ? { every: deps.compute.every } : {}), ...(deps.log ? { log: deps.log } : {}) }) : undefined;
  /** The writes, each computer's meter stopped (its time booked up to now) before it is kept or its end written. */
  const writes: IntervalWrites = meter
    ? {
        ...written,
        kept: async (provider, providerId) => {
          await meter.stop(provider, providerId);
          await written.kept(provider, providerId);
        },
        ended: async (provider, providerId) => {
          await meter.stop(provider, providerId);
          await written.ended(provider, providerId);
        },
      }
    : written;
  /** The computer an earlier claim of the run kept at its park (computer-kept.ts), read once: attached again when it is
   *  the setting's and its time is not over (reattach), else left to the launch's releaseOlderClaims. A read that fails
   *  is none. A run's first claim follows no park. */
  let kept = store.settings && launch.epoch > 1 ? await readKept(store.settings, launch.runId).catch(() => undefined) : undefined;
  /** The kept computer's time passed before this claim: the new one says so (Replaced.lapsed). */
  let lapsed = false;
  /** The kept computer was pinned to another runner, gone by this claim, and this claim could not reach it: the new one
   *  says so (Replaced.lost). */
  let lost = false;
  /** The same, but that runner was still there, and this claim gave its row back for it to end (Replaced.elsewhere). */
  let heldThere = false;
  /** The kept computer's provider refused to attach it again: the new one says so (Replaced.refused), in serve's words. */
  let refused = false;
  /** The kept row as this claim gave it back marked ending (restoreKept), where it did: the launch's release of the
   *  older claims' computers that deletes its machine marks it ended (finishedKept), so the run's end removes it. */
  let givenBack: Kept | undefined;
  /** What a park of this claim keeps (ClaimComputer.park): a desktop, a phone or a sandbox it made through its provider, or took
   *  back, with its provider, its connection's close and the claim epoch its labels carry; `pinned`: only this runner can
   *  reach it again (computer-kept.ts pinnedOf), so the park names this claim's holder on its row. `disk`: the Archil disk
   *  of the mount credential a computer taken back carries (its row's); absent, this claim's (mountDisk). */
  let keepable: { readonly provider: ComputerProvider; readonly entry: string; readonly kind: KeptKind; readonly computer: ProviderComputer; readonly pinned: boolean; epoch: number; disk: string | undefined } | undefined;
  /** Whether a computer of `entry` made with `configuration` is reachable again only by this runner: its options as
   *  vendorProvider makes it (the settings' options under the configuration's). */
  const pinnedHere = (entry: ProviderEntry, configuration: { readonly options?: Readonly<Record<string, unknown>> }): boolean =>
    pinnedOf(entry, { ...settingOptions(entry.id, deps.settings ?? {}, table), ...configuration.options });
  /** A vendor's provider (or a local one's), made with the keys and the configuration the setting selected: that
   *  configuration is built by its own create() options (Orgo's Windows: { os: "windows" }), beside the keys'. */
  const vendorProvider = async (entry: ProviderEntry, keys: Readonly<Record<string, string>>, configuration: { readonly options?: Readonly<Record<string, unknown>> }): Promise<ComputerProvider> => {
    const make = Object.hasOwn(deps.providers, entry.id) ? deps.providers[entry.id] : undefined;
    if (!make) throw new Error(`this server has no ${entry.label} provider to start one with`);
    const options = providerOptions(entry.id, keys, deps.settings ?? {}, table);
    if (!options.ok) throw new Error(options.error.message);
    return make({ ...options.options, ...configuration.options }, { ledger: storeLedger(store.computerLedger, entry.id), ...(launch.boxAllow === undefined ? {} : { boxAllow: launch.boxAllow }) });
  };
  /** What a computer of `kind` from `entry` is made with under this claim, but its mount: the deps' spec, within what
   *  `provider` declares it makes, from the image it prepares (readyImage) or the spec's, under the claim's labels. */
  /** What the run asks of a computer from `provider`: what the launch allows, within what the provider declares it makes
   *  (its networks, its lifetime: computer-deps.ts computerSpecOf). */
  const runOf = (provider: ComputerProvider): ComputerRun => {
    const { network: networks, maxLifetimeMs } = provider.capabilities();
    return {
      ...(launch.boxAllow === undefined ? {} : { boxAllow: launch.boxAllow }),
      ...(launch.boxAllowSet ? { boxAllowSet: true as const } : {}),
      ...(networks ? { networks } : {}),
      ...(typeof maxLifetimeMs === "number" ? { maxLifetimeMs } : {}),
    };
  };
  /** Whether a computer of `kind` from `provider` is made under this launch with network "none" (ClaimComputer.offline):
   *  the spec's network, read without its image. A spec this server refuses now says nothing. */
  const offlineSpec = (entry: ProviderEntry, provider: ComputerProvider, kind: MadeKind, configuration: KindCapabilities): boolean => {
    try {
      return deps.spec(entry, kind, runOf(provider), configuration.image).network === "none";
    } catch {
      return false;
    }
  };
  const specOf = async (entry: ProviderEntry, provider: ComputerProvider, kind: ComputerSettingKind, configuration: KindCapabilities, signal: AbortSignal | undefined, gpu?: ComputerSpec["gpu"]): Promise<ComputerSpec> => {
    // A provider that declares it prepares its own image (its prepareImage(): its recipe built when the engine lacks it,
    // an image by name pulled) does so first, and the computer starts from the tag it answers: the recipe's tag is in no
    // registry, so a run of it unbuilt would be refused. The spec comes first, so a setting it refuses builds nothing. A
    // configuration that names its image starts from it, else the kind's default.
    const asked = deps.spec(entry, kind as Exclude<ComputerSettingKind, "none">, runOf(provider), configuration.image);
    const ready = await readyImage(entry, provider, signal, deps.onImageWait);
    const image = ready ?? asked.image;
    if (image === undefined) throw new Error(`${entry.label} names no image for its ${kind} computer and prepares none`);
    return { ...asked, image, labels: runLabels(launch.runId, launch.epoch), ...(gpu ? { gpu } : {}) };
  };
  /** How a sandbox of `provider` this claim holds is started again once its provider lost it (lostAware): made from
   *  `specNow` (the lost one's spec, or for one taken back from the park this claim's own, read when it is needed), under
   *  this claim's labels and its own request (the claim's, then which new one), so a retry of it under this epoch finds
   *  the one it made. Where it holds the run's folder (`folder`), the new one holds it too, read back before it serves a
   *  call: a mount's credential of the lost one removed (Mode 2) and a new one asked for; a synced folder pushed in again
   *  from the disk and held (synced-folder.ts holdSynced), so the claim's sync goes on from the new one's manifest. */
  const renewalOf = (provider: ComputerProvider, entry: ProviderEntry, specNow: () => Promise<ComputerSpec>, folder: MountKind | undefined): Renewal => ({
    provider,
    max: deps.recreates ?? LOST_RECREATES,
    async remake(times, own) {
      deps.onStarting?.({ provider: entry.label, kind: "sandbox" });
      const spec = await specNow();
      let mount: ComputerSpec["mount"];
      // The store is read whole before anything is made, so a folder over a cap rents nothing.
      const store = folder === "sync" ? diskOf() : undefined;
      if (folder === "sync" && !store) throw new Error("this runner keeps no synced folder for the run");
      const stored = store ? await storedFolder(store) : undefined;
      if (folder === "sync") mount = { kind: "sync" };
      else if (folder !== undefined) {
        await deps.revokeMount?.();
        mount = await deps.workspace.mountSpec();
      }
      const call = deps.signal ? { signal: deps.signal } : {};
      const ahead = await meter?.before(entry.id, figuresOf(spec));
      const created = await provider.create({ ...spec, ...(mount ? { mount } : {}) }, { requestId: `${claimRequestId(launch)}#lost-${times}`, ...call });
      if (!created.ok) {
        void ahead?.drop();
        throw new Error(created.error.message);
      }
      const ref = { id: created.value.id, name: created.value.name };
      const figures = figuresOf(spec, created.value.resources);
      await writes.opened(entry.id, ref.id, launch.runId, "sandbox", figures);
      meter?.start(entry.id, ref.id, figures, ahead);
      const ended = () => writes.ended(entry.id, ref.id);
      const connected = await provider.connect(ref);
      if (!connected.ok) {
        const released = await provider.release(ref, "delete").catch(() => undefined);
        if (released?.ok) await ended();
        throw new Error(connected.error.message);
      }
      const again = providerComputer(provider, ref, connected.value, ended);
      if (mount) {
        try {
          if (store && stored) folderHeld.folder = await holdSynced(store, own(again), stored, deps.signal);
          await deps.workspace.attach({ id: ref.id, client: again.client, readBack: () => again.readBack() }, { ...deps.check, epoch: deps.check.epoch ?? launch.epoch, ...(store ? { sync: true as const } : {}) });
        } catch (error) {
          await again.release().catch(() => undefined);
          throw error;
        }
      }
      return again;
    },
    started: (name) => {
      // A park after this keeps the new one, whose labels and mount are this claim's epoch's and disk's (a kept one taken
      // back carried its park's).
      if (keepable) {
        keepable.epoch = launch.epoch;
        keepable.disk = undefined;
      }
      deps.onComputerNote?.(lostRecreatedWords(name));
    },
    stop: (words) => (deps.stopRun ?? stopRun)(words),
    may: () => inToolCall() && deps.signal?.aborted !== true,
  });
  const side: ClaimSide = {
    keysOf: providerKeys(kinds, keyOf),
    answers: deps.answers ?? (async () => false),
    ...(deps.daemon ? { daemon: deps.daemon } : {}),
    // The computer an earlier claim kept at the run's park, when it is this setting's (its provider and kind, holding the
    // run's folder the same way) and its time is not over: marked taking on its row first (computer-kept.ts takeKept),
    // then attached and connected again, then the mark taken off (keptTaken), so its end and this claim never both have
    // it and the row is there until this claim holds the machine. Its mount, where it has one, stays the
    // one it was made with: its credential is this claim's from here (inheritMount). Never the agent's own computer, a
    // paired one or --faux's. One that isn't this setting's is left to the launch's releaseOlderClaims and its keep's end.
    async reattach(entry, { kind, keys, configuration, folder, gpu, persistent, signal }) {
      const record = kept;
      kept = undefined;
      if (!record || !store.settings) return undefined;
      if (persistent || paired.some((row) => row.id === entry.id) || (deps.launch && (deps.launches?.(entry.id) ?? true)) || record.provider !== entry.id || record.kind !== kind || record.folder !== folder) return undefined;
      // Kept pinned to another runner (or another process of this runner's name): the claim rule let this claim have the
      // run only once that runner was gone, or no longer claiming. Taken off its row, it is tried here all the same (a
      // runner on the same host, sharing its Docker engine, finds it); one this claim cannot reach is lost to this claim,
      // said so.
      const elsewhere = record.runner !== undefined && !keptBy(record, launch.holder);
      const settings = store.settings;
      /** The row as this claim marked it taking (takeKept), until this claim gave it back. */
      let taking: Kept | undefined;
      /** The machine, once reached: closed here when this claim goes on without it. */
      let reached: ProviderComputer | undefined;
      // Taken and not used here: the row turns ending (restoreKept), whoever is there: this claim goes on on a new
      // machine, so no claim takes that one back as the run's. A runner still there (refusing claims or not, or one whose
      // word was only late) ends it at its time (endKept finishes a row so marked) or at its janitor's pass; once it is
      // gone, or where any runner reaches it, any janitor's pass does. A give-back the store fails every try leaves the
      // row marked taking, ended at its time all the same, and is said on the log. Then who is there is read for the new
      // one's words alone (Replaced.elsewhere, lost): true when that runner is there (or the read failed) and the row reads
      // ending, so that runner ends it; false when it is gone; undefined when who is there was never read (the row not
      // taken, or not pinned elsewhere) or the give-back never landed, and the words name neither.
      const giveBack = async (): Promise<boolean | undefined> => {
        const row = taking;
        if (!row) return undefined;
        taking = undefined;
        await reached?.close().catch(() => undefined);
        const restored = await restoreKept(settings, launch.runId, row);
        if (restored) givenBack = row;
        if (!restored) deps.log?.(`run ${launch.runId}'s kept ${record.kind} ${record.name} could not be marked ending: the store did not take the write, so its row stays marked taking and it ends at its time`);
        if (!elsewhere) return undefined;
        const there = await heldElsewhere({ ...(store.runners ? { runners: store.runners } : {}), ...(launch.holder ? { self: launch.holder } : {}) })(record);
        return there ? (restored ? true : undefined) : false;
      };
      try {
        // Its end begun before its time: a claim that could not reach it went on on a new machine and gave its row back so,
        // or a park that kept nothing or a stop marked it so (restoreKept, keepKept, endingKept); or another claim is
        // taking it back (taking). It is the run's no more, and it did not lapse: a new one, said as any replaced one is.
        // Once its time passed (a clock that can't be read counts so): it lapsed, said so.
        if (record.ending || record.ended || record.taking !== undefined) {
          lapsed = await storeClock().then((at) => at >= record.until, () => true);
          return undefined;
        }
        // Its time over (on the store's clock, which stamped it): a new one, said lapsed. Marked under this claim's fence,
        // so a claim that lost the run takes nothing.
        const fence = (launch.claim ?? { runId: launch.runId, epoch: launch.epoch }) as Claim;
        if ((await storeClock()) >= record.until) {
          lapsed = true;
          return undefined;
        }
        // Its row changed since this claim read it: its end began first (its keeper's at its time, or a stop's end that
        // marked it ending between its two reads of the run, run-end-computers.ts), or another claim marked it. Said as
        // a row read ending is: lapsed only once its time passed, else a new one said as any replaced one is.
        if (!(taking = await takeKept(settings, launch.runId, record, launch.epoch, fence))) {
          lapsed = await storeClock().then((at) => at >= record.until, () => true);
          return undefined;
        }
        const provider = await vendorProvider(entry, keys, configuration);
        const taken = await keptLaunch(provider, record, signal, () => writes.ended(entry.id, record.id));
        if (!taken || "refused" in taken) {
          // The provider's words name host paths and its settings: the runner's log alone hears them.
          if (taken) {
            refused = true;
            (deps.log ?? stderrLog)(`run ${launch.runId}'s kept ${record.kind} ${record.name} could not be taken back, so the claim goes on on a new one: ${taken.refused}`);
          }
          const there = await giveBack();
          heldThere = there === true;
          lost = there === false;
          return undefined;
        }
        reached = taken;
        // Reached: the mark taken off, only while it still reads so. A row changed since is its end begun (at its time,
        // or a park or a stop marked it ending): the machine goes, so this claim never uses it, and goes on on a new one.
        if (!(await keptTaken(settings, launch.runId, taking))) {
          taking = undefined;
          await taken.close().catch(() => undefined);
          lapsed = await storeClock().then((at) => at >= record.until, () => true);
          return undefined;
        }
        // Metered again from here, with what its interval says it was made with: the time it was kept is no claim's.
        const row = meter ? (await store.computerIntervals?.forRun(launch.runId).catch(() => undefined))?.find((one) => one.provider === entry.id && one.providerId === record.id) : undefined;
        if (row) meter?.start(entry.id, record.id, row);
        deps.inheritMount?.();
        // A sandbox taken back is started again when it is lost as one this claim made (lostAware): the new one is this
        // claim's, made from this claim's spec, its folder mounted.
        const again = record.kind === "sandbox" ? lostAware(taken, renewalOf(provider, entry, () => specOf(entry, provider, kind, configuration, deps.signal, gpu), folder)) : taken;
        keepable = { provider, entry: entry.id, kind: record.kind, computer: again, pinned: pinnedHere(entry, configuration), epoch: record.epoch, disk: record.disk };
        ownKind = record.kind;
        // Made under this launch by the claim that parked it, so with the network this claim's spec asks.
        offline = offlineSpec(entry, provider, record.kind, configuration);
        const screen = record.kind === "sandbox" ? undefined : record.kind;
        made = { id: again.id, machine: again.machine, ...(again.watch && screen ? { watch: again.watch, gone: goneOf(provider, again.id, runLabels(launch.runId, record.epoch), screen) } : {}) };
        madeBy = entry;
        const { os, osVersion, arch } = again.hello;
        deps.onConnected?.({ provider: entry.label, kind: record.kind, hello: { os, ...(osVersion ? { osVersion } : {}), arch }, kept: true });
        return { ...again, epoch: record.epoch };
      } catch {
        // Taken off its row, and not reached here: lost to this claim where it was pinned to another runner, its row given
        // back while that runner is there, said so. Never taken (its clock read or its take threw): who is there was never
        // read, so the new one says neither.
        const there = await giveBack().catch(() => undefined);
        heldThere = there === true;
        lost = there === false && !lapsed;
        return undefined;
      }
    },
    async launch(entry, { kind, keys, configuration, mount, gpu, persistent, signal }) {
      const ownLaunch = deps.launch && (deps.launches?.(entry.id) ?? true) ? deps.launch : undefined;
      // An agent's own computer needs its agent and the store's record of it; the server's launch (--faux) keeps none.
      if (persistent && (ownLaunch || launch.agentId === undefined || store.settings === undefined)) throw new Error("this run can't keep its agent's own computer here: start it again with persistent off");
      // A paired computer is claimed through the hub of this process (attachedProvider), never made: --faux's launch,
      // which stands in for the vendors', is not its.
      const pairedRow = paired.find((row) => row.id === entry.id);
      if (ownLaunch && !pairedRow) {
        const own = await ownLaunch(entry, { kind, keys, configuration, run: launch.runId, ...(mount ? { mount } : {}), ...(gpu ? { gpu } : {}), ...(signal ? { signal } : {}) });
        const ownWatch = (own as unknown as { watch?: WatchOf }).watch;
        made = { id: own.id, ...(ownWatch ? { watch: ownWatch } : {}) };
        madeBy = entry;
        startedHere = true;
        return own;
      }
      // Under a runner of its own process, through its relay: the box is routed under the run's claim (launch.claim, a
      // store Claim from each claim's launch), so a claim another runner superseded is Fenced at the route.
      const provider = pairedRow ? pairedProvider(pairedRow, deps.attached?.hub, deps.attached?.relay, launch.claim as Claim | undefined) : await vendorProvider(entry, keys, configuration);
      outlives = pairedRow !== undefined || persistent === true;
      const spec: ComputerSpec = { ...(await specOf(entry, provider, kind, configuration, signal, gpu)), ...(mount ? { mount } : {}) };
      // A paired computer is a person's own, its network theirs: the spec's network says nothing of it.
      offline = !pairedRow && kind !== "browser" && spec.network === "none";
      // A browser makes nothing here: the run's browser tool opens each session through it, so a session lives (and is
      // booked) only while the tool holds it.
      if (kind === "browser") {
        // The run's sessions of a lower claim epoch go first, as a computer's do (the janitor's releaseOlder); the ones it
        // released, by id and when, are the browser's sweptOlder.
        const swept = await releaseOlderClaims(provider, launch, signal, { entry: entry.id, writes });
        const sweptAt = new Date().toISOString();
        const opened = claimBrowser(provider, spec);
        madeBy = entry;
        const browser = swept.length > 0 ? { ...opened.browser, sweptOlder: new Map(swept.map((ref) => [ref.id, sweptAt])) } : opened.browser;
        return { id: entry.id, groups: ["cdp"], browser, release: opened.release };
      }
      let launched: Awaited<ReturnType<typeof ownedLaunch>> | ProviderComputer;
      /** The labels the provider lists this computer under: its owner's for the agent's own, else the run's. */
      let listedUnder = spec.labels ?? {};
      if (persistent) {
        // The agent's own: its owner (this server and the agent), and no run deadline (it outlives the run).
        const owner: ComputerOwner = { agent: launch.agentId!, server: await serverIdOf({ settings: store.settings! }) };
        listedUnder = ownerFilter(owner);
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
        deps.onStarting?.({ provider: entry.label, kind: kind as Exclude<ComputerSettingKind, "none"> });
        // A fresh computer in place of an earlier claim's: one this claim let go of (its runner lost, a crash, a park's
        // kept one whose time passed), or one the run's journal says an earlier claim made (that claim let it go at its
        // end: a server's stop). The journal is read before anything is rented, so a read that fails leaves nothing to let
        // go. A paired computer is the same one at every claim, and is no computer of the run's own.
        const journalSays = !pairedRow && launch.epoch > 1 && (await deps.hadComputer?.()) === true;
        // A paired computer is no computer of the run's own: it has no interval. A kept machine this claim gave back (it
        // could not take it) that the release of the older claims' computers deletes has its row marked ended there: no
        // janitor's pass is left to wait for, and the run's end removes the row (forgetEnded).
        const ended = givenBack;
        const keptGone = !pairedRow && ended && store.settings ? { id: ended.id, gone: async () => void (await finishedKept(store.settings!, launch.runId, ended)) } : undefined;
        const fresh = await providerLaunch(provider, launch, spec, signal, pairedRow ? { writes: intervalWrites(undefined), entry: entry.id, kind } : { writes, entry: entry.id, kind, ...(meter ? { meter } : {}), ...(keptGone ? { keptGone } : {}) });
        // A sandbox the claim made is started again when its provider loses it mid-run (lostAware): never a paired
        // computer, nor a desktop or a phone (a person may hold or watch it), nor the agent's own (persistent, above).
        const { releasedOlder } = fresh;
        const held = kind === "sandbox" && !pairedRow ? lostAware(fresh, renewalOf(provider, entry, async () => spec, mount?.kind)) : fresh;
        launched = held;
        startedHere = !pairedRow;
        if (!pairedRow) ownKind = kind as MadeKind;
        if (!pairedRow && (kind === "desktop" || kind === "phone" || kind === "sandbox")) keepable = { provider, entry: entry.id, kind, computer: held, pinned: pinnedHere(entry, configuration), epoch: launch.epoch, disk: undefined };
        if (!pairedRow && (releasedOlder || journalSays || lost || heldThere || refused)) replaced = { kind: kind as MadeKind, folderKept: deps.mode === 2 && mount !== undefined, ...(lost ? { lost: true as const } : heldThere ? { elsewhere: true as const } : lapsed ? { lapsed: true as const } : {}), ...(refused ? { refused: true as const } : {}) };
      }
      made = { id: launched.id, machine: launched.machine, ...(launched.watch ? { watch: launched.watch, ...(kind === "desktop" || kind === "phone" ? { gone: goneOf(provider, launched.id, listedUnder, kind) } : {}) } : {}) };
      madeBy = entry;
      const { os, osVersion, arch } = launched.hello;
      deps.onConnected?.({ provider: entry.label, kind: kind as Exclude<ComputerSettingKind, "none">, hello: { os, ...(osVersion ? { osVersion } : {}), arch }, ...(replaced ? { replaced } : {}) });
      return launched;
    },
  };

  /** The computer an earlier claim kept at the run's park, ended now by a claim that starts none (the run's computer is
   *  off): deleted, its interval ended, and the parking claim's mount credential taken on and removed (archil-claim.ts
   *  revoke removes only one its claim minted or took on), so the run's folder is its own again before its tools touch
   *  it. It is taken on only once this claim's end holds the row (endKept's compare-and-set): a later claim that took the
   *  computer back first holds its mount. The delete and the revoke are bounded (KEPT_DELETE_MS) and end at the run's
   *  stop; one that fails or does not answer leaves the row ending, said, for the janitor, which removes the credential
   *  too. Never throws. */
  const endKeptNow = async (): Promise<void> => {
    const record = kept;
    kept = undefined;
    const settings = store.settings;
    const entry = record && kinds.PROVIDERS.find((one) => one.id === record.provider);
    if (!record || record.ended || !settings || !entry) return;
    try {
      await endKept(settings, launch.runId, record, () => {
        deps.inheritMount?.();
        return bounded(KEPT_DELETE_MS, (async () => {
          try {
            const provider = await vendorProvider(entry, await side.keysOf(entry.id), {});
            if (await deleteKept(provider, record)) await writes.ended(entry.id, record.id);
          } finally {
            await deps.revokeMount?.();
          }
        })(), deps.signal);
      });
    } catch (error) {
      (deps.log ?? stderrLog)(`the ${record.kind} kept for run ${launch.runId} was left for the janitor's next pass: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  // The run's computer turned off by an earlier claim's deny: none is started, and the one a park kept goes now.
  if (deps.turnedOff) {
    deps.onComputerNote?.(computerStillOffWords(deps.turnedOff));
    await endKeptNow();
    return { computer: undefined, off: true, release: noop };
  }
  const setting = await settingOf(launch, store);
  // A run of an agent in a workspace never takes a paired computer, whatever its revision names (its save refuses one).
  if (namesPaired(setting) && launch.agentId !== undefined && typeof (await store.agents.workspace(launch.agentId)) === "string") throw unavailable(scopedPairedWords(setting.provider));
  // Programs it needs (computer.needs) are checked in a sandbox's box alone: a setting that needs them and is any other
  // kind is refused before anything is rented, never run without them.
  const needs = (setting as { needs?: readonly string[] } | undefined)?.needs;
  if (needs?.length && setting?.kind !== "sandbox") {
    const label = setting?.provider ? kinds.PROVIDERS.find((one) => one.id === setting.provider)?.label ?? setting.provider : undefined;
    throw unavailable(needsNoSandboxWords(needs, setting?.kind === "none" || !setting ? "none" : `a ${setting.kind}${label ? ` on ${label}` : ""}`));
  }
  // A computer every tool of which is set to deny (tool-gate.ts computerDenied) serves the run nothing: none is started,
  // nothing is rented or checked, and the run goes on without it, its timeline saying why.
  const denied = setting && (await deniedKind(launch, setting, store, runShellOf(setting, deps.mode, kinds, deps.noExec)));
  if (denied) {
    deps.onComputerNote?.(computerDeniedWords(denied));
    await endKeptNow();
    return { computer: undefined, off: true, release: noop };
  }
  const resolved = await resolveComputer(setting, deps.mode, kinds, side);
  if ("refused" in resolved) throw unavailable(resolved.refused);
  if (resolved.kind === "none") return { computer: undefined, release: noop };
  // The program its provider runs on this machine (the phone's adb) is checked before anything is rented.
  const hostRefusal = resolved.provider ? deps.hostWhy?.(resolved.provider) : undefined;
  if (hostRefusal) throw unavailable(`This agent's computer is a ${resolved.kind} on ${resolved.provider}, and this runner cannot run it: ${hostRefusal.replace(/[.!?]+$/, "")}.`);

  // The run's mount credential (Mode 2), minted when the mount was made: removed with the computer, or at once when the
  // start fails after it was minted.
  const revoke = async (): Promise<void> => { await deps.revokeMount?.(); };
  let started: Awaited<ReturnType<typeof resolved.start>>;
  try {
    // The mount check carries the claim's epoch (a disk read-back under another epoch is refused) unless it names one.
    const disk = diskOf();
    started = await resolved.start({ workspace: deps.workspace, check: { ...deps.check, epoch: deps.check.epoch ?? launch.epoch }, ...(disk ? { store: disk } : {}), held: folderHeld, ...(deps.signal ? { signal: deps.signal } : {}) });
  } catch (error) {
    // A computer made before the start failed is the claim's no more: its time booked up to now.
    await meter?.stopAll().catch(() => undefined);
    await revoke().catch(() => undefined);
    throw error;
  }
  const computer = started.computer;
  // What the agent needs its sandbox to have (computer.needs): asked of the box it started, before anything of the run
  // reaches a model. A box that lacks one, or that could not be asked, is let go and the run ends in words: never a run on
  // a box without what its work needs.
  if (needs?.length) {
    // A sandbox setting whose start gave no sandbox is no box to check: refused as one that could not be asked.
    const answer = computer?.kind === "sandbox" ? await missingNeeds(computer.computer.client, needs, deps.signal) : { unchecked: "its start gave no sandbox" };
    if ("unchecked" in answer || answer.missing.length > 0) {
      await started.release().catch(() => undefined);
      await meter?.stopAll().catch(() => undefined);
      await revoke().catch(() => undefined);
      throw unavailable(needsWords(answer, needs, kinds.PROVIDERS.find((one) => one.id === resolved.provider)));
    }
  }
  // A desktop's or a phone's: its hold, parking the run's ports while a person holds it, and its live view, proxy-only (no
  // vendor's URL reaches a person), opened under this claim. A fenced open is a lost claim. The release ends the hold.
  let endHold: () => void = () => {};
  let hold: RunHold | undefined;
  let held: HeldComputer | undefined;
  let view: { close(why: ViewEnd): unknown } | undefined;
  // The agent asks for a video of the screen (computer.record): the desktop's or phone's, through a watch of the
  // recorder's own while this claim holds it; each browser session's, through its live view's (the run's browser tool).
  const recordings: Recording[] = [];
  const record = deps.recordings && setting?.record === true
    ? (watch: RecordWatch, tag: string, kind: RecordInput["kind"]): Recording => {
        const one = startRecording({ ...deps.recordings!, watch, tag, kind });
        recordings.push(one);
        return one;
      }
    : undefined;
  const runComputer = computer?.kind === "browser" && record ? { ...computer, browser: { ...computer.browser, record: (id: string, watch: RecordWatch) => record(watch, id, "browser") } } : computer;
  if (computer && (computer.kind === "desktop" || computer.kind === "phone")) {
    const theHold = computerHold();
    if (deps.openComputerView && made?.watch) {
      const watch = made.watch;
      const input = computer.kind === "desktop" ? "desktop" : phonePlatform(made.machine, madeBy);
      const opened = await deps.openComputerView({ store, sealKey: deps.sealKey, claim: launch.claim ?? { runId: launch.runId, epoch: launch.epoch }, kind: computer.kind, input, tag: made.id, watch, hold: theHold, ...(made.gone ? { gone: made.gone } : {}) });
      if (!opened.ok) {
        await started.release().catch(() => undefined);
        await meter?.stopAll().catch(() => undefined);
        await revoke().catch(() => undefined);
        if (opened.refused === "fenced") throw claimLost(`run ${launch.runId}'s claim (epoch ${launch.epoch}) is no longer this runner's, so its ${computer.kind} was released: ${opened.message}`);
        throw unavailable(`the ${computer.kind}'s live view could not be opened: ${opened.message}`);
      }
      view = opened.view;
    }
    if (record && made?.watch) record(made.watch, made.id, computer.kind);
    // The run's end closes the hold (workspace/computer-hold.ts close()): a take in force ends `released` (the computer
    // goes; the composer's `ended` ViewEnd maps onto it), the agent's open ask is let go at once, and nothing is taken after.
    endHold = () => theHold.close();
    hold = (ports) => heldHands(ports as never, theHold);
    held = { kind: computer.kind, hold: theHold };
  }
  let released: Promise<void> | undefined;
  /** The park's row, once written (keepRow, or park() itself): its row as written and this process's clock when its end
   *  was stamped; undefined when the park keeps nothing. */
  let keeping: Promise<{ readonly row: Kept; readonly stamped: number } | undefined> | undefined;
  const release = (why: ViewEnd = "released"): Promise<void> =>
    (released ??= (async () => {
      // A row written for a park that never followed (the run's timeline refused its keep line: a lost claim) is taken
      // off, only while it reads as written: its machine goes here, and a row naming this live runner would keep a later
      // claim's park from keeping anything (keepKept).
      const reserved = await keeping?.catch(() => undefined);
      if (reserved && store.settings) await dropKept(store.settings, launch.runId, reserved.row).catch(() => false);
      await Promise.all(recordings.map((one) => one.stop(typeof why === "object" ? "parked" : why)));
      await Promise.resolve(view?.close(why)).catch(() => undefined);
      endHold();
      try {
        await started.release();
      } finally {
        // A computer whose delete failed is held by no claim from here: its time is booked up to now, and no more.
        await meter?.stopAll();
        await revoke();
      }
    })());
  // A park keeps the desktop, phone or sandbox this claim made or took back, while the claim still holds it (park(): one its
  // release already let go is not).
  const keeps = computer && keepable && store.settings ? keepable : undefined;
  const settings = store.settings;
  /** The park's row written, once: a synced folder's delta landed first (an Archil mount's modes and links recorded; one
   *  that does not land keeps nothing), then the keep's end stamped on the store's clock (the one the claim rule's pin,
   *  every claim's take-back and every janitor judge it by: a runner whose clock is off from the store's never moves it)
   *  and the row written, never over a row pinned to another runner still there (keepKept: that runner's end compares
   *  it). What is written in the folder after the delta landed is the disk's only if a claim takes it back (pullFolder).
   *  Every write is under this claim (keepKept's claim, the store's fence): one that lost the run by now (its lease ran
   *  out, another claim may have parked and kept since) writes and marks nothing. No clock read, no row, a row this park
   *  may not write over, or a claim fenced: undefined, and the park keeps nothing. */
  const keepRow = (): Promise<{ readonly row: Kept; readonly stamped: number } | undefined> =>
    (keeping ??= (async () => {
      if (!keeps || !settings || released) return undefined;
      if (started.sync && !(await started.sync()).ok) return undefined;
      try {
        const at = await storeClock();
        const stamped = now();
        const ref = keeps.computer.ref;
        const fence = (launch.claim ?? { runId: launch.runId, epoch: launch.epoch }) as Claim;
        const disk = resolved.folder === "archil" ? keeps.disk ?? deps.mountDisk?.() : undefined;
        const row = await keepKept(settings, launch.runId, { provider: keeps.entry, kind: keeps.kind, id: ref.id, name: ref.name, epoch: keeps.epoch, until: at + KEEP_MS, ...(resolved.folder ? { folder: resolved.folder } : {}), ...(disk ? { disk } : {}), ...(keeps.pinned && launch.holder ? { runner: launch.holder.runner, incarnation: launch.holder.incarnation } : {}) }, { ...(store.runners ? { runners: store.runners } : {}), ...(launch.holder ? { self: launch.holder } : {}) }, fence);
        return row ? { row, stamped } : undefined;
      } catch {
        return undefined;
      }
    })());
  return {
    ...(runComputer ? { computer: runComputer } : {}),
    ...(hold ? { hold } : {}),
    ...(held ? { held } : {}),
    ...(replaced ? { replaced } : {}),
    ...(ownKind ? { made: ownKind } : {}),
    ...(startedHere ? { fresh: true as const } : {}),
    ...(outlives ? { outlives: true as const } : {}),
    ...(offline && runComputer && runComputer.kind !== "browser" ? { offline: true as const } : {}),
    ...(keeps ? { keeps: keeps.kind } : {}),
    ...(meter ? { settle: () => meter.stopAll() } : {}),
    release,
    async syncProject(signal) {
      const cancellation = signal && deps.signal ? AbortSignal.any([signal, deps.signal]) : signal ?? deps.signal;
      cancellation?.throwIfAborted();
      if (started.sync) { if (!(await started.sync()).ok) throw new Error("The project folder could not be durably synchronized."); }
      else if (resolved.folder === "bind") {
        // A bind is already this Workspace's filesystem, so there is no remote folder delta to pull. File tools
        // fsync their own writes, but arbitrary shell edits need this final syncfs after dispatch has settled.
        // Use the supplied host Workspace, never the lost-aware computer client (which could recreate a machine).
        const flushed = await deps.workspace.exec(["/usr/bin/sync", "-f", "."], {
          env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, timeoutMs: 30_000, maxOutput: 1024,
          ...(cancellation ? { signal: cancellation } : {}),
        });
        if (flushed.code !== 0 || flushed.signal || flushed.timedOut || flushed.truncated)
          throw new Error("The bound project folder could not be durably synchronized.");
      }
      else if (runComputer && "check" in runComputer && runComputer.check) throw new Error("This mounted project has no verified synchronization capability.");
      cancellation?.throwIfAborted();
    },
    async keepRow(): Promise<boolean> {
      return (await keepRow()) !== undefined;
    },
    async park(cause: ParkCause): Promise<boolean> {
      // The row keepRow wrote before the run's timeline said the keep, or written here now. None (nothing to keep, a
      // delta that did not land, no clock read, a row this park may not write over): nothing to find it by, so it goes as
      // at the run's end.
      const kept = await keepRow();
      if (!kept || !keeps || !settings || released) {
        await release();
        return false;
      }
      const ref = keeps.computer.ref;
      const row: Kept = kept.row;
      /** The keep's end on this process's clock: KEEP_MS from the stamp, its own timer and its live view count from it. */
      const localUntil = kept.stamped + KEEP_MS;
      await writes.kept(keeps.entry, ref.id);
      // The live view ends (its frames and any take-over), saying what the run waits for and until when the computer is
      // kept, never that it ended; the hold with it; the machine and its mount stay.
      released = (async () => {
        // The recording pauses: the claim that resumes the run goes on in a new file.
        await Promise.all(recordings.map((one) => one.stop("parked")));
        // The viewer counts down on this process's clock, so it is told the end on it.
        await Promise.resolve(view?.close({ parked: cause, until: localUntil })).catch(() => undefined);
        endHold();
        await keeps.computer.close();
      })();
      await released;
      // Its end at its time, by this process (KEEP_MS after the stamp, counted on its own clock, so the store's clock
      // being off from it changes nothing); the janitor's (computer-kept.ts sweepKept) whatever becomes of it. Either
      // deletes it, a synced folder with no read-back. A delete or a mount revoke that fails leaves the row ending, said
      // here: the janitor's next pass ends it again, the credential's remove with it.
      const timer = setTimeout(() => {
        void endKept(settings, launch.runId, row, async () => {
          if (await deleteKept(keeps.provider, ref)) await writes.ended(keeps.entry, ref.id);
          await revoke();
        }).catch((error: unknown) => (deps.log ?? stderrLog)(`the ${keeps.kind} kept for run ${launch.runId} was left for the janitor's next pass: ${error instanceof Error ? error.message : String(error)}`));
      }, Math.max(0, localUntil - now()));
      timer.unref?.();
      return true;
    },
  };
}
