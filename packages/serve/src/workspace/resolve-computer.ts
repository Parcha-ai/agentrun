// The claim's resolver: an agent's computer setting {kind, provider, image?, gpu?}, in the server's mode, read against the computer
// module's kind registry (its setting kinds and provider entries), gives how to start the computer for the run, whether
// it mounts the run's folder, and which of the kernel's ports it fills; or a refusal in words that name the setting
// (Settings → Computers). The runner's harness start calls it at the claim, starts the computer, and hands it to
// runTools (run-tools.ts), which follows the mount decided here. Pure until start: the registry, the saved keys and the
// launch of a vendor's computer are passed in, so a new provider is one entry in the registry and changes nothing here.
//
// The run's folder is mounted only when the kind has files and exec AND the provider takes the mode's folder (folderKindOf):
// Mode 1's is a folder of this machine (a bind); Mode 2's is on Archil, an archil mount where the provider takes one and
// Archil's image is here, else a synced folder, which the runner pushes in at the claim and keeps on the disk after each
// change (synced-folder.ts). A sandbox must hold it: Mode 1 refuses a sandbox that is not Docker's (only a bind reaches
// this machine), Mode 2 refuses Docker's (it takes neither). A desktop, a phone and a browser are allowed in both modes:
// a desktop mounts only where its provider takes the mode's folder and it offers files and exec; a phone and a browser
// never do. A provider whose required keys are not all saved is refused here, before anything starts; start hands the
// provider its declared keys alone. A sandbox's GPUs are held to what its provider declares, with the mode's folder as their mount (the kind its GPU computers take, where the
// provider takes more than one), in the computer package's checkGpu words, and go into the computer's spec.
//
// Where the run's shell is follows the mount (shellPlaceOf): in the computer that mounts the folder; with none, Archil's
// serverless exec in Mode 2 (bash only); in Mode 1 none at all, since the folder is one of this server's own and a
// command there would run on the server itself. runShellOf reads it off a setting before anything starts (the tool
// plane shows bash unavailable by it), and the claim's runTools takes the same rule over the computer it started.
import { hostToolDefs, type ShellPlace } from "@parcha/agentrun-kernel/kernel";
import { type BrowserFeatures, type BrowserFile, type BrowserSessionUsage, type BrowserSpec, type ComputerClient, type ComputerSettingKind, configurationOf, connectOf, type GpuSpec, type Group, type HelloResult, imagesOf, type KindCapabilities, type MountKind, type MountReadBack, type MountSpec, mountsOf, type ProviderEntry, type Result, type SettingKindSpec, syncingClient } from "@parcha/agentrun-computer";
import { type DockerDaemon, noDockerWords } from "../docker-daemon.js";
import { gpuRefused } from "../gpu-words.js";
import { recordedClient } from "../computer-calls.js";
import type { Recording, RecordWatch } from "../computer-record.js";
import type { MountCheck } from "./attach.js";
import type { AgentComputer, RunComputer } from "./run-tools.js";
import { emptyMeta, finalSyncWords, type FolderStore, type HeldFolder, holdSynced, pullFolder, recordMeta, recordWords, type StoredFolder, storedFolder, syncOf } from "./synced-folder.js";
import type { Workspace } from "./workspace.js";
import { restartWith } from "../start-switches.js";

/** The setting kind (what an agent is given, not a computer's capabilities().kind), a machine's kind and groups, and one
 *  provider of the kind registry: the computer module's own types. Where a run's shell is: the kernel registry's. */
export type { ComputerSettingKind, KindCapabilities, ProviderEntry, ShellPlace };

/** An agent's computer setting. `image`: the one of the provider's configurations it selects; absent, the default. A
 *  sandbox's may ask for GPUs. `persistent`: the agent keeps its own computer between runs (agent-computer.ts). A
 *  desktop's or a phone's `surface` and `exec` go to the run's tools on the RunComputer (run-tools.ts); `exec: false`
 *  also mounts no folder in it and gives the run no shell. A desktop's, a phone's or a browser's `record`: the claim
 *  records its screen (computer-for-claim.ts, computer-record.ts). */
export type ComputerSetting = { readonly kind: string; readonly provider?: string | null; readonly image?: string; readonly gpu?: GpuSpec; readonly persistent?: boolean; readonly surface?: "code" | "tools"; readonly exec?: boolean; readonly record?: boolean };

/** Whether a computer (or its setting) takes its agent's programs away: `exec: false`. Only a desktop or a phone takes
 *  `exec` (computer-setting.ts refuses it on any other kind at save), so a computer without programs is one of those. */
export const noPrograms = <C extends { readonly kind: string; readonly exec?: boolean }>(computer: C | undefined): computer is Extract<C, { readonly kind: "desktop" | "phone" }> => computer?.exec === false;

/** The computer module's kind registry (src/kinds.ts), by its own names: the setting kinds, why a machine does not serve
 *  one (servingRefusals, whose words a refusal here carries), and the providers. */
export type KindRegistry = {
  readonly SETTING_KINDS: Readonly<Record<ComputerSettingKind, SettingKindSpec>>;
  servingRefusals(capabilities: KindCapabilities, kind: ComputerSettingKind): string[];
  readonly PROVIDERS: readonly ProviderEntry[];
};

/** A computer a provider started for the run: its ref, its computerd client and what it offers (sandbox, desktop,
 *  phone), the hello it answered when the claim connected it (a desktop's or a phone's ports read its groups), the
 *  read-back of its mount (when mounted), and its release. A browser is started by none: the claim gives the run's
 *  browser tool its provider (`browser`), which opens each session at the tool's first call, and the release lets go
 *  of any the tool left open. */
export type LaunchedComputer = {
  readonly id: string;
  readonly groups: readonly (Group | string)[];
  readonly client?: ComputerClient;
  /** The client of the machine `client` reaches now, where `client` may go on to a new one in its place (a sandbox
   *  started again once its provider lost it: computer-for-claim.ts lostAware). A synced folder's sync lists through it,
   *  so a sync never starts the new one and reads it against the lost one's manifest; a loss it finds is marked, so the
   *  run's next call starts the new one. Absent where `client` is it. */
  readonly own?: ComputerClient;
  readonly hello?: HelloResult;
  readBack?(): Promise<Result<MountReadBack>>;
  readonly browser?: ClaimBrowser;
  release(): Promise<void>;
};

/** A browser computer's provider as the run's browser tool opens its sessions through it: each session one computer of
 *  the provider's, made under the run's labels and the tool's tag (so a create whose answer was lost is found again),
 *  its CDP URL read through the provider's connect at each attach (a secret: it goes only to the driver), and released
 *  when the tool lets it go. Errors carry the provider's words, and its code. So the session's time is the time the
 *  tool holds it, which is what the run's spend books. */
export type ClaimBrowser = {
  /** The provider's id: the session's price and its name. */
  readonly provider: string;
  /** The longest a session lives, in seconds. */
  readonly maxLifetimeS: number;
  /** What its sessions offer beyond the protocol (the provider's capabilities().browser), which `open` may ask for. */
  readonly features: BrowserFeatures;
  /** Makes a session for `tag`, to live at most `lifetimeS`, with its own options (spec.browser): its computer's id. */
  open(tag: string, lifetimeS: number, browser?: BrowserSpec, signal?: AbortSignal): Promise<string>;
  /** The sessions made for `tag`, by id. */
  find(tag: string, signal?: AbortSignal): Promise<string[]>;
  /** Whether the session runs: false once it has ended or its provider no longer knows it. */
  running(id: string, signal?: AbortSignal): Promise<boolean>;
  /** The session's CDP URL now. */
  url(id: string): Promise<string>;
  /** Ends the session; one already gone is ended. */
  close(id: string): Promise<void>;
  /** Where the agent's setting asks for it (computer.record), records session `id`'s screen through `watch` (its live
   *  view's, computer-record.ts browserWatch) until the caller stops it at the session's release, or the claim's release
   *  stops it. Absent: nothing is recorded. */
  readonly record?: (id: string, watch: RecordWatch) => Recording;
  /** The provider's own record of session `id` (BrowserComputerProvider.sessionUsage), read once as it is let go: when it
   *  says the session started and ended, and its proxy bytes, each null where it does not say; undefined for a session it
   *  does not know. Absent where the provider keeps no such record. A failed read throws. */
  readonly usage?: (id: string, signal?: AbortSignal) => Promise<BrowserSessionUsage | undefined>;
  /** The files a session downloaded, kept by the provider: where its features declare downloads. */
  readonly downloads?: {
    list(id: string): Promise<BrowserFile[]>;
    /** The file's bytes, streamed; the stream fails in words once it passes maxBytes. */
    read(id: string, name: string, maxBytes: number): Promise<AsyncIterable<Uint8Array>>;
  };
};

/** The claim's side: the keys saved for a provider (Settings → Computers; values, never shown), and the launch of one
 *  computer of the kind, with the run's folder as its mount when it mounts it. A launch that fails throws its words. */
export type ClaimSide = {
  keysOf(provider: string): Promise<Readonly<Record<string, string>>>;
  /** Whether a provider that binds a folder of this machine (Docker) answers here now: the Mode 1 default asks it. */
  answers(provider: string): Promise<boolean>;
  /** Its daemon's answer (docker-daemon.ts), asked when a launch on such a provider fails: none answering is refused in
   *  the one wording a run's start and Settings → Computers say (noDockerWords). Absent: the launch's own words. */
  daemon?(provider: string): Promise<DockerDaemon>;
  /** `configuration`: the provider's configuration the setting selected; its options go to the provider with the keys,
   *  and its image, when it names one, is the computer's. `gpu`: a sandbox's GPUs, held to that configuration.
   *  `persistent`: the agent's own computer, which that configuration keeps (and which mounts no run's folder). */
  launch(entry: ProviderEntry, spec: { readonly kind: ComputerSettingKind; readonly keys: Readonly<Record<string, string>>; readonly configuration: KindCapabilities; readonly mount?: MountSpec; readonly gpu?: GpuSpec; readonly persistent?: true; readonly signal?: AbortSignal }): Promise<LaunchedComputer>;
  /** The computer an earlier claim of the run kept at its park (computer-kept.ts), attached again in place of a launch,
   *  or undefined to launch one. Asked first: a computer attached again mounts what it mounted, so no mount is made for
   *  it, and its mount reads back under `epoch`, the claim epoch its labels carry. `folder`: the kind of the run's folder
   *  in it, where it holds one: only a computer kept holding the folder so is taken back (computer-kept.ts Kept.folder),
   *  and a new one in place of it, once its provider loses it, holds the same. Never throws. Absent: always a launch. */
  reattach?(entry: ProviderEntry, spec: { readonly kind: ComputerSettingKind; readonly keys: Readonly<Record<string, string>>; readonly configuration: KindCapabilities; readonly folder?: MountKind; readonly gpu?: GpuSpec; readonly persistent?: true; readonly signal?: AbortSignal }): Promise<(LaunchedComputer & { readonly epoch: number }) | undefined>;
};

/** A narrow port of the kernel's hands a computer fills: files, exec and processes where the folder is mounted; a
 *  desktop's screen and input; a phone; a browser. */
export type Port = "files" | "exec" | "processes" | "screen" | "input" | "phone" | "browser";

/** A provider's keys as the claim reads them: each key its registry entry declares, by `keyOf` (the server's reader:
 *  key-meta.ts keyReader, the environment's value, else the saved one); a key with no value is left out. */
export const providerKeys = (registry: Pick<KindRegistry, "PROVIDERS">, keyOf: (name: string) => Promise<string | undefined>): ClaimSide["keysOf"] =>
  async (provider) => {
    const keys: Record<string, string> = {};
    for (const key of registry.PROVIDERS.find((one) => one.id === provider)?.keys ?? []) {
      const value = await keyOf(key.name);
      if (value !== undefined) keys[key.name] = value;
    }
    return keys;
  };

/** What a provider is on this server beside its descriptor: the mounts the operator's keys turn on, and whether the
 *  operator names its image here. */
type HereFields = {
  readonly label?: string;
  /** Whether its machines dial this server: always, or as its connect option says (the computer package's connectOf). */
  readonly connect?: "dial" | "either";
  readonly mounts: readonly string[];
  readonly unmounted?: Readonly<Partial<Record<string, string>>>;
  readonly mountsWith?: Readonly<Partial<Record<string, string>>>;
  readonly imageEnv?: string;
  readonly prepareImage?: boolean;
  /** Its descriptor's imageEnv has a value here: the operator names the image every computer of it starts from. */
  readonly imageNamed?: true;
};

/** `entry` as this server has it, by `set` (whether a key, or a setting of this server, has a value here): with the
 *  mounts the operator's keys turn on (its descriptor's mountsWith, by the computer package's mountsOf: Daytona's Archil
 *  mount where DAYTONA_ARCHIL_EGRESS names a self-hosted target's Archil egress relay), and imageNamed where its
 *  descriptor's imageEnv names its image here (Daytona's AGENTRUN_DAYTONA_SNAPSHOT). Any other entry as it is. Every
 *  reader of an entry's mounts (Settings → Computers, the claim, a run's start, its shell) reads this, so the
 *  provider made with those keys and the server agree on what it mounts. `options`: the create() options its server
 *  settings give (computer-keys.ts settingOptions): where its machines dial this server by them, mountsOf leaves out
 *  the Archil mount, so its folder is synced where Archil's would be. */
export function entryHere<Entry extends HereFields>(entry: Entry, set: (name: string) => boolean, options: Readonly<Record<string, unknown>> = {}): Entry {
  const named = entry.imageEnv !== undefined && set(entry.imageEnv);
  const dial = dials(entry, options);
  if (entry.mountsWith === undefined && !named && !dial) return entry;
  return { ...entry, ...mountsOf(entry as unknown as Parameters<typeof mountsOf>[0], set, dial), ...(named ? { imageNamed: true as const } : {}) };
}

/** Whether a computer of `entry` made with `options` dials this server (the computer package's connectOf). A connect it
 *  doesn't know reads as exec here: the provider refuses it in its own words when it is made, and no other provider's
 *  listing or run fails on it. */
function dials(entry: HereFields, options: Readonly<Record<string, unknown>>): boolean {
  try {
    return connectOf(entry as unknown as Parameters<typeof connectOf>[0], options) === "dial";
  } catch {
    return false;
  }
}

/** The names entryHere reads of `entry`: the keys of its mountsWith, and its imageEnv. */
const hereNames = (entry: HereFields): string[] => [...Object.values(entry.mountsWith ?? {}).filter((name): name is string => typeof name === "string"), ...(entry.imageEnv === undefined ? [] : [entry.imageEnv])];

/** `registry` with each provider as this server has it (entryHere), reading only the names an entry's mountsWith or
 *  imageEnv names, by `valueOf` (key-meta.ts keyReader: the environment's value, else the saved key), and the options
 *  its server settings give, by `optionsOf` (settingOptions; absent: none). A value of whitespace alone is none. */
export async function registryHere<Registry extends { readonly PROVIDERS: readonly ProviderEntry[] }>(registry: Registry, valueOf: (name: string) => Promise<string | undefined>, optionsOf?: (provider: string) => Readonly<Record<string, unknown>>): Promise<Registry> {
  const names = [...new Set(registry.PROVIDERS.flatMap(hereNames))];
  const set = new Set((await Promise.all(names.map(async (name) => ((await valueOf(name))?.trim() ? name : "")))).filter((name) => name !== ""));
  return { ...registry, PROVIDERS: registry.PROVIDERS.map((entry) => entryHere(entry, (name) => set.has(name), optionsOf?.(entry.id))) };
}

/** Whether a computer of `entry` that mounts the owner's Archil disk has Archil's image in the owner's vendor account:
 *  its provider prepares it (prepareImage), or the operator names it here (imageNamed, entryHere). */
const archilImageHere = (entry: HereFields): boolean => entry.prepareImage === true || entry.imageNamed === true;

/** The kind of the run's folder a sandbox or a desktop of `entry` with files and exec holds in `mode`, or undefined for
 *  none. Mode 1: a bind of this machine. Mode 2: an Archil mount where the provider takes one and Archil's image is here
 *  (archilImageHere), else a synced folder where it takes one (the runner keeps the folder on the disk: no Archil image
 *  or client is needed in the computer). `gpuMounts`: what its GPU computers take, where the setting asks for GPUs: a
 *  kind they leave out is not picked, unless they leave out every one, and then the kind with no GPU is (so the GPU's
 *  refusal says why). Settings (computers.ts) and the claim read this one rule. */
export function folderKindOf(entry: HereFields, mode: 1 | 2, gpuMounts?: readonly string[]): MountKind | undefined {
  const pick = (takes: (kind: MountKind) => boolean): MountKind | undefined => {
    if (mode === 1) return takes("bind") ? "bind" : undefined;
    if (takes("archil") && archilImageHere(entry)) return "archil";
    return takes("sync") ? "sync" : undefined;
  };
  const taken = (kind: MountKind) => entry.mounts.includes(kind);
  return pick((kind) => taken(kind) && (gpuMounts?.includes(kind) ?? true)) ?? pick(taken);
}

/** Whether a provider's computers run only on the vendor's own network: the network forms it declares (its
 *  descriptor's, its capabilities().network) are "open" alone, as a cloud phone's and a hosted browser's are. */
export const vendorNetworkOnly = (network: readonly string[] | undefined): boolean => network !== undefined && network.length > 0 && network.every((one) => one === "open");

/** Whether a provider's computers can't have no network: it declares its network forms and "none" isn't one (a cloud
 *  phone, a hosted browser, Local Chrome). */
export const needsNetwork = (network: readonly string[] | undefined): boolean => network !== undefined && network.length > 0 && !network.includes("none");

/** A provider's label after its article, as it is said: "a Modal", "an E2B" (every label is said by its first letter's
 *  sound). `start`: at a sentence's start, "A"/"An". */
export const aLabel = (label: string, start = false): string => `${start ? "A" : "a"}${/^[AEIOU]/i.test(label) ? "n" : ""} ${label}`;

/** Why a computer that needs a network is refused where this server's AGENTRUN_BOX_ALLOW is none, in words that name the
 *  fix: the operator said no network at all, and the computer can't run without one. */
export const noNetworkRefusal = (label: string, kind: string): string =>
  `This agent's computer is ${aLabel(label)} ${kind}, which needs a network (the vendor's own, or public addresses from this machine), and this server's AGENTRUN_BOX_ALLOW is none (no network): pick a computer that runs with no network in ${SETTINGS}, or ${restartWith("AGENTRUN_BOX_ALLOW set to a host list")}.`;

/** Whether an agent's computer `setting` can be had in `mode` now, by the answers the claim gives (resolveComputer: the
 *  kind, the provider and what it serves, the mode's mount, the provider's keys by `keyOf`): ok, or its refusal in words
 *  that name the fix. Nothing starts. A run's start asks it before the run is made (runnable.ts).
 *
 *  `answers`: whether a provider that binds a folder of this machine (Docker) answers here now, or why not (the server's
 *  daemon check, docker-daemon.ts). Any computer on such a provider, a sandbox or a desktop in either mode, is refused
 *  here, at the start, where the claim would only fail to launch it: no daemon at all in the one wording Settings →
 *  Computers and the claim say (noDockerWords), another reason in its own words. Asked here, not in resolveComputer: the
 *  claim launches it, and asks only once its launch fails (ClaimSide.daemon). Absent: not asked.
 *
 *  `boxAllow`: this server's allow setting (box-settings.ts boxAllowOf). Under "none", a computer whose provider makes no
 *  "none" is refused (noNetworkRefusal), as the claim refuses it. Absent: not asked.
 *
 *  `hostWhy`: why this machine cannot run a provider's computers, in words that say how to fix it (computers.ts
 *  hostCommandRefusals, read at the server's start: the phone's adb not on PATH), or undefined. Absent: not asked. */
export async function computerReadiness(setting: ComputerSetting, mode: 1 | 2, given: KindRegistry, keyOf: (name: string) => Promise<string | undefined>, answers?: (provider: string) => DockerDaemon | Promise<DockerDaemon>, boxAllow?: readonly string[] | "none", hostWhy?: (provider: string) => string | undefined): Promise<{ readonly ok: true } | { readonly refused: string; readonly box?: string }> {
  // Each provider as this server has it: the mounts its keys turn on, and whether the operator names its image.
  const registry = await registryHere(given, keyOf);
  const resolved = await resolveComputer(setting, mode, registry, {
    keysOf: providerKeys(registry, keyOf),
    // A setting is given, so the Mode 1 default (the only asker) is never read; and nothing is launched.
    answers: async () => false,
    launch: async () => { throw new Error("a readiness check starts no computer"); },
  });
  if ("refused" in resolved) return { refused: resolved.refused };
  const entry = registry.PROVIDERS.find((one) => one.id === resolved.provider);
  if (entry && entry.mounts.includes("bind") && answers) {
    const said = await answers(entry.id);
    // It names the box whose probe said no (a refusal's details.box), as the box check did.
    if (!said.up && said.absent) return { refused: noDockerWords(resolved.kind, registry.PROVIDERS, mode), box: entry.id };
    if (!said.up) return { refused: `This agent's computer is ${aLabel(entry.label)} ${resolved.kind}, and this server cannot run it: ${said.reason.replace(/[.!?]+$/, "")}.`, box: entry.id };
  }
  const host = entry ? hostWhy?.(entry.id) : undefined;
  if (host) return { refused: `This agent's computer is a ${entry!.label} ${resolved.kind}, and this server cannot run it: ${host.replace(/[.!?]+$/, "")}.` };
  if (boxAllow === "none" && entry && needsNetwork(entry.network)) return { refused: noNetworkRefusal(entry.label, resolved.kind) };
  return { ok: true };
}

/** The run's computer started: what runTools takes (none for kind none), and its release, after the run's end. */
export type StartedComputer = {
  readonly computer: RunComputer | undefined;
  release(): Promise<void>;
  /** What the run's disk keeps of the folder beyond what the computer wrote, now (a park lands it before the computer is
   *  kept): a synced folder's delta, or an Archil mount's modes and links in sync.json (recordMeta). */
  readonly sync?: () => Promise<Result<void>>;
};

/** A setting resolved: its kind and provider, the run's folder in it where it mounts one, the ports, and how to start it. */
export type ResolvedComputer = {
  readonly kind: ComputerSettingKind;
  readonly provider: string | null;
  /** The kind of the run's folder in it, where it mounts: a bind, an Archil mount or a synced folder (folderKindOf). */
  readonly folder?: MountKind;
  readonly ports: readonly Port[];
  /** Starts the computer, mounting `workspace`'s folder when it mounts (a synced folder pushed in from `store` before
   *  the computer is handed on); `check` is the mount check attach runs (the claim's epoch bound in); `store`: the run's
   *  disk as the claim writes the folder on it, each write fenced by the claim (computer-for-claim.ts, fencedStore),
   *  absent where this runner keeps none; `held`: the claim's synced folder, set here and again by a new sandbox in place
   *  of a lost one (computer-for-claim.ts renewalOf). A computer that cannot be had throws with code
   *  computer_unavailable and the words. */
  start(run: { readonly workspace: Workspace; readonly check: MountCheck; readonly store?: FolderStore; readonly held: HeldFolder; readonly signal?: AbortSignal }): Promise<StartedComputer>;
};

const SETTINGS = "Settings → Computers";
const FOLDER_PORTS: readonly Port[] = ["files", "exec", "processes"];

const unavailable = (words: string): Error => Object.assign(new Error(words), { code: "computer_unavailable" });
const nothing = async (): Promise<void> => {};

/**
 * Where a run's shell is, from whether a computer mounts its folder and the server's mode:
 * - "computer": a computer mounts the folder (a sandbox, or a desktop with files and exec whose provider mounts it);
 *   bash and the background tools run there;
 * - "local": none does, in Mode 2: the folder is on Archil, and a command runs on Archil's serverless exec, a fresh
 *   container holding the run's folder alone, never a process of this server; bash only;
 * - "none": none does, in Mode 1: the folder is one of this server's own, and a command there would run on the server
 *   itself, able to read its data and its keys; no bash family at all, the file tools alone (confined to the folder).
 */
export function shellPlaceOf(mounts: boolean, mode: 1 | 2): ShellPlace {
  if (mounts) return "computer";
  return mode === 2 ? "local" : "none";
}

/** The kind of the run's folder a computer of `kind` on `entry` holds in `mode` (folderKindOf), or undefined for none:
 *  the kind has files and exec (a configuration of the provider that serves the kind offers both) and the provider takes
 *  the mode's folder. A phone and a browser never do. `gpuMounts`: folderKindOf's. */
function folderOf(kind: ComputerSettingKind, entry: ProviderEntry, serving: readonly KindCapabilities[], mode: 1 | 2, gpuMounts?: readonly string[]): MountKind | undefined {
  const shell = serving.some((one) => one.groups.includes("files") && one.groups.includes("exec"));
  if (!((kind === "sandbox" || kind === "desktop") && shell)) return undefined;
  // Configurations made on dial by their own options take no Archil mount either (mountsOf), as entryHere's settings'
  // dial. `entry` holds its keyed mounts already: no key is read again.
  const dialed = serving.every((one) => dials(entry, one.options ?? {}));
  return folderKindOf(dialed ? { ...entry, ...mountsOf(entry, () => false, true) } : entry, mode, gpuMounts);
}

/** The configurations of `entry` that serve `kind`. */
const servingOf = (registry: Pick<KindRegistry, "servingRefusals">, entry: ProviderEntry, kind: ComputerSettingKind): KindCapabilities[] => entry.capabilities.filter((one) => registry.servingRefusals(one, kind).length === 0);

/** The one configuration of `serving` the setting selects (configurationOf), as a list: [] when its image names none. */
const selectedOf = (serving: readonly KindCapabilities[], setting: ComputerSetting, entry: ProviderEntry, kind: ComputerSettingKind): readonly KindCapabilities[] => {
  const one = configurationOf(serving, setting.image, entry.defaultImage?.[kind]);
  return one ? [one] : [];
};

/**
 * Where a run of an agent with computer `setting` has its shell in `mode` (shellPlaceOf), read off the setting and the
 * kind registry before anything starts: what the claim's runTools gives the run once its computer is started. "computer"
 * for a sandbox, or a desktop whose provider mounts the folder and offers files and exec; for kind none, a phone, a
 * browser or a desktop that does not mount, Archil's exec in Mode 2 ("local", bash only) and no shell at all in Mode 1
 * ("none"). A setting this server refuses (an unknown kind or provider, a sandbox that cannot mount the mode's folder)
 * runs nothing: "none". The setting is the agent's as saved; where it has none, the caller gives the server's default.
 */
export function runShellOf(setting: ComputerSetting, mode: 1 | 2, registry: Pick<KindRegistry, "SETTING_KINDS" | "servingRefusals" | "PROVIDERS">): ShellPlace {
  const kind = setting.kind as ComputerSettingKind;
  if (!Object.hasOwn(registry.SETTING_KINDS, kind)) return "none";
  if (kind === "none") return shellPlaceOf(false, mode);
  if (!registry.PROVIDERS.some((one) => one.kinds.includes(kind))) return "none";
  const entry = registry.PROVIDERS.find((one) => one.id === setting.provider);
  if (!entry) return "none";
  const serving = selectedOf(servingOf(registry, entry, kind), setting, entry, kind);
  if (serving.length === 0) return "none";
  // An agent whose computer runs no programs of its own has no shell anywhere: not its computer's, not Archil's exec.
  if (noPrograms(setting)) return "none";
  const mounts = folderOf(kind, entry, serving, mode) !== undefined;
  if (kind === "sandbox" && !mounts) return "none";
  return shellPlaceOf(mounts, mode);
}

/** What a choice of computer leaves out of the shell, in plain words: shown beside it (GET /v2/computers shell_note) and
 *  said by the save's refusal of a tool it leaves out. A computer that mounts the folder leaves nothing out. */
export const SHELL_NOTES: Readonly<Record<Exclude<ShellPlace, "computer">, string>> = Object.freeze({
  local: "No computer: bash runs in a fresh container on the folder's own storage; background commands need a computer.",
  none: "No computer on this server: the agent gets the file tools only, no shell. Pick a computer to run commands.",
});

/** The host tools a run with its shell at `shell` gets, by name: the kernel registry's own list (hostToolDefs), never a
 *  second one: the file tools always, bash with a shell, the five background tools on a computer. */
export const hostToolsOf = (shell: ShellPlace): string[] => hostToolDefs({ maxExecS: 600, shell }).map((def) => def.name);

/** A computer choice as an agent's settings show it: where its runs have their shell (runShellOf), the host tools that
 *  gives, and what it leaves out, in words (none for a computer that mounts the folder). */
export function shellChoiceOf(setting: ComputerSetting, mode: 1 | 2, registry: Pick<KindRegistry, "SETTING_KINDS" | "servingRefusals" | "PROVIDERS">): { shell: ShellPlace; host_tools: string[]; shell_note?: string } {
  const shell = runShellOf(setting, mode, registry);
  return { shell, host_tools: hostToolsOf(shell), ...(shell === "computer" ? {} : { shell_note: SHELL_NOTES[shell] }) };
}

/** The server's default where an agent has no computer setting: in Mode 1 a sandbox on the first provider that binds a
 *  folder of this machine and answers here (Docker), else none; in Mode 2 none. */
async function defaultSetting(mode: 1 | 2, registry: KindRegistry, side: ClaimSide): Promise<ComputerSetting> {
  if (mode === 1) {
    for (const entry of registry.PROVIDERS) {
      if (entry.kinds.includes("sandbox") && entry.mounts.includes("bind") && (await side.answers(entry.id))) return { kind: "sandbox", provider: entry.id };
    }
  }
  return { kind: "none" };
}

/** The setting resolved for `mode` (none given: the server's default), or a refusal in words that name the setting. A
 *  workflow runs with no computer: its caller gives kind none. */
export async function resolveComputer(given: ComputerSetting | undefined, mode: 1 | 2, registry: KindRegistry, side: ClaimSide): Promise<ResolvedComputer | { readonly refused: string }> {
  const setting = given ?? (await defaultSetting(mode, registry, side));
  const kind = setting.kind as ComputerSettingKind;
  if (!Object.hasOwn(registry.SETTING_KINDS, kind)) {
    const [why] = registry.servingRefusals({ kind: "linux", groups: [] }, kind);
    return { refused: `This agent's computer: ${why}. Set it in ${SETTINGS}.` };
  }
  if (kind === "none") return { kind, provider: null, ports: [], start: async () => ({ computer: undefined, release: nothing }) };

  const offered = registry.PROVIDERS.filter((entry) => entry.kinds.includes(kind));
  const pick = `one of ${offered.map((entry) => entry.label).join(", ")} for this agent's computer in ${SETTINGS}.`;
  if (offered.length === 0) return { refused: `No provider gives a ${kind} computer on this server: pick another kind for this agent's computer in ${SETTINGS}.` };
  if (!setting.provider) return { refused: `A ${kind} computer needs a provider: pick ${pick}` };
  // `registry` is as this server has it (registryHere, by its caller): the mounts its keys turn on, and whether the
  // operator names its image, so the folder it holds is the one the start and the readiness check said.
  const entry = registry.PROVIDERS.find((one) => one.id === setting.provider);
  if (!entry) return { refused: `${JSON.stringify(setting.provider)} is no computer provider this server knows: pick ${pick}` };
  // The configurations of the provider that serve the kind; none, and its own why (unserved: its descriptor's, a paired
  // computer's), else the registry's, by its closest one.
  const serving = servingOf(registry, entry, kind);
  if (serving.length === 0) {
    const unserved = entry.unserved?.[kind];
    const why = unserved !== undefined ? [unserved] : (entry.capabilities.map((one) => registry.servingRefusals(one, kind)).sort((a, b) => a.length - b.length)[0] ?? []);
    return { refused: `${entry.label} gives no ${kind} computer${why.length > 0 ? `: ${why.join("; ")}` : ""}. Pick ${pick}` };
  }
  // The configuration the setting's image selects: one the provider does not offer for the kind is refused, naming those
  // it does.
  const [configuration] = selectedOf(serving, setting, entry, kind);
  if (!configuration) {
    const images = imagesOf(serving, entry.defaultImage?.[kind]);
    const offers = images.length === 0 ? `offers no ${kind} image to choose: remove the image` : `offers the ${kind} image${images.length === 1 ? "" : "s"} ${images.join(", ")}: pick one`;
    // A configuration its descriptor parks (built, not offered yet): refused saying so, never as an unknown image.
    const parked = entry.parked?.find((one) => one.image === setting.image);
    if (parked) return { refused: `${parked.why}, so this agent's ${JSON.stringify(setting.image)} ${kind} is parked. It ${offers} for this agent's computer in ${SETTINGS}.` };
    return { refused: `${entry.label} has no ${kind} image ${JSON.stringify(setting.image)}. It ${offers} for this agent's computer in ${SETTINGS}.` };
  }

  // The run's folder: held where the selected configuration has files and exec and the provider takes the mode's folder
  // (of the kinds its GPU computers take, where the setting asks for GPUs), and the agent may run programs there (a
  // folder is mounted for its shell).
  const gpu = kind === "sandbox" && setting.gpu ? setting.gpu : undefined;
  const folder = noPrograms(setting) ? undefined : folderOf(kind, entry, [configuration], mode, gpu ? configuration.gpu?.mounts : undefined);
  const mounts = folder !== undefined;
  if (kind === "sandbox" && folder === undefined) {
    if (mode === 1) return { refused: `Mode 1 runs a sandbox only on Docker: ${aLabel(entry.label)} sandbox can't reach the run's folder on this machine. Pick Docker for this agent's computer in ${SETTINGS}, or another kind of computer.` };
    if (entry.mounts.includes("bind")) return { refused: `Mode 2 keeps workspaces on Archil; a local Docker computer can't mount them. Pick a remote sandbox for this agent's computer in ${SETTINGS}, or no computer.` };
    const why = [entry.unmounted?.archil, entry.unmounted?.sync].filter((one) => one !== undefined).join("; ");
    return { refused: `${aLabel(entry.label, true)} sandbox can't hold the run's folder from Archil${why ? ` (${why})` : ""}: pick another sandbox for this agent's computer in ${SETTINGS}.` };
  }

  // Its GPUs, a sandbox's alone: in gpuRefused's words, against what the configuration the setting selected declares,
  // with the run's folder as the mount it takes (a sandbox here always holds it). A GPU computer that can't take the
  // folder is told so, and what to use instead.
  if (gpu && folder) {
    const refused = gpuRefused(gpu, configuration.gpu, { kind: folder }, entry.label);
    if (refused?.folder) return { refused: refused.words };
    if (refused) return { refused: `${aLabel(entry.label, true)} sandbox can't have this agent's GPUs: ${refused.words}. Change the GPUs or the provider for this agent's computer in ${SETTINGS}.` };
  }

  // The agent's own computer, kept between its runs: only where the configuration keeps one, and never one that mounts
  // the run's folder (a later run would find an earlier run's folder in it).
  const persistent = setting.persistent === true;
  if (persistent && configuration.persistence === undefined) return { refused: `${aLabel(entry.label, true)} ${kind} keeps no computer for an agent between runs (it declares no persistence): turn persistent off, or pick a computer that keeps one, for this agent's computer in ${SETTINGS}.` };
  if (persistent && mounts) return { refused: `${aLabel(entry.label, true)} ${kind} mounts each run's folder, so it can't be kept between runs: turn persistent off for this agent's computer in ${SETTINGS}.` };

  // Its keys: every required one saved, before anything starts; only declared names go to the provider.
  const saved = await side.keysOf(entry.id);
  const has = (name: string) => typeof saved[name] === "string" && saved[name] !== "";
  const missing = entry.keys.filter((key) => key.required && !has(key.name)).map((key) => key.name);
  if (missing.length > 0) {
    return { refused: `${entry.label} needs its key${missing.length === 1 ? "" : "s"} ${missing.join(", ")} saved: add ${missing.length === 1 ? "it" : "them"} in ${SETTINGS}.` };
  }
  const keys = Object.fromEntries(entry.keys.filter((key) => has(key.name)).map((key) => [key.name, saved[key.name]!]));

  const ports: readonly Port[] = kind === "sandbox" ? FOLDER_PORTS
    : kind === "desktop" ? [...(mounts ? FOLDER_PORTS : []), "screen", "input"]
    : kind === "phone" ? ["phone"] : ["browser"];

  return {
    kind,
    provider: entry.id,
    ...(folder ? { folder } : {}),
    ports,
    async start({ workspace, check, store: disk, held, signal }) {
      // A computer kept at the run's park, attached again: it mounts what it mounted, read back under its own epoch.
      const again = await side.reattach?.(entry, { kind, keys, configuration, ...(folder ? { folder } : {}), ...(gpu ? { gpu: { type: gpu.type, count: gpu.count } } : {}), ...(persistent ? { persistent: true as const } : {}), ...(signal ? { signal } : {}) });
      // The run's disk as the claim keeps the folder on it. A synced folder's store: for a new computer, listed and held
      // to the caps before it is rented. Under an Archil mount, its sync.json emptied here and written again at the park
      // and release.
      const store = folder === "sync" ? disk : undefined;
      if (folder === "sync" && store === undefined) {
        await again?.release().catch(() => undefined);
        throw unavailable(`${entry.label} could not start a ${kind} computer: this run's folder can't be synced into a computer here`);
      }
      if (folder === "archil" && disk) {
        try {
          await emptyMeta(disk);
        } catch (error) {
          await again?.release().catch(() => undefined);
          throw unavailable(`${entry.label} could not start a ${kind} computer: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      let stored: StoredFolder | undefined;
      if (store && !again) {
        try {
          stored = await storedFolder(store);
        } catch (error) {
          throw unavailable(`${aLabel(entry.label, true)} ${kind} can't hold this run's folder: ${error instanceof Error ? error.message : String(error)}.`);
        }
      }
      const mount: MountSpec | undefined = !mounts || again ? undefined : folder === "sync" ? { kind: "sync" } : await workspace.mountSpec();
      let launched: LaunchedComputer;
      try {
        launched = again ?? await side.launch(entry, { kind, keys, configuration, ...(mount ? { mount } : {}), ...(gpu ? { gpu: { type: gpu.type, count: gpu.count } } : {}), ...(persistent ? { persistent: true as const } : {}), ...(signal ? { signal } : {}) });
      } catch (error) {
        // A provider that binds a folder of this machine (Docker) whose daemon does not answer: the one wording.
        const said = entry.mounts.includes("bind") && side.daemon ? await side.daemon(entry.id).catch(() => undefined) : undefined;
        if (said && !said.up && said.absent) throw unavailable(noDockerWords(kind, registry.PROVIDERS, mode));
        throw unavailable(`${entry.label} could not start a ${kind} computer: ${error instanceof Error ? error.message : String(error)}`);
      }
      // A synced folder, before any tool runs there: pushed into a new computer, or pulled whole from a kept one (whose
      // copy may be newer than the disk's), through the machine's own client. One that can't be had lets the computer go.
      let sync: (() => Promise<Result<void>>) | undefined;
      const own = launched.own ?? launched.client;
      if (store && own) {
        try {
          held.folder = again ? await pullFolder(store, own, signal) : await holdSynced(store, own, stored!, signal);
        } catch (error) {
          await launched.release().catch(() => undefined);
          throw unavailable(`${entry.label} could not start a ${kind} computer: ${error instanceof Error ? error.message : String(error)}`);
        }
        sync = syncOf(held);
      }
      const checked = mounts ? { ...check, ...(again ? { epoch: again.epoch } : {}), ...(folder === "sync" ? { sync: true as const } : {}) } : undefined;
      const computer = runComputerOf(kind, launched, checked, { ...(setting.surface ? { surface: setting.surface } : {}), ...(noPrograms(setting) ? { exec: false as const } : {}) }, sync);
      if (typeof computer === "string") {
        await launched.release();
        throw unavailable(`${entry.label} could not start a ${kind} computer: ${computer}`);
      }
      if (folder === "archil" && disk && own) {
        // An Archil mount's park and release: its modes and links recorded in sync.json first (recordMeta), read through
        // the machine's own client as it is then (a lost one's replacement, never the lost one; asking it starts none),
        // for a later claim that syncs the folder; the computer goes whatever that answered, and a failed one is said.
        const record = () => recordMeta(disk, launched.own ?? own);
        return {
          computer,
          sync: record,
          async release() {
            const recorded = await record();
            await launched.release();
            if (!recorded.ok) throw new Error(recordWords(recorded.error.message));
          },
        };
      }
      if (!sync) return { computer, release: () => launched.release() };
      const final = sync;
      // A synced folder's release: a final delta (what a background program wrote since the last change), then the
      // computer goes, whatever the delta answered; a failed one is said in archilRelease's words.
      return {
        computer,
        sync: final,
        async release() {
          const synced = await final();
          await launched.release();
          if (!synced.ok) throw new Error(finalSyncWords(synced.error.message));
        },
      };
    },
  };
}

/** The started computer as runTools takes it, or what it lacks, in words. `agent`: a desktop's or a phone's surface and
 *  exec, as its agent's setting says them. `sync`: a synced folder's delta, which lands on the disk after every call
 *  that may change the folder, before it answers (syncingClient); the tools, the attached Workspace and the owner's door
 *  share the one client, and each call's recorded time holds its sync. */
function runComputerOf(kind: Exclude<ComputerSettingKind, "none">, launched: LaunchedComputer, check: MountCheck | undefined, agent: AgentComputer, sync?: () => Promise<Result<void>>): RunComputer | string {
  // The run's browser tool opens a browser's sessions through its provider.
  if (kind === "browser") return launched.browser ? { kind, browser: launched.browser } : "it gave no CDP connection";
  const { hello } = launched;
  if (!launched.client) return "it gave no computer protocol client";
  // Each call the agent's tools make is recorded on the tool call's row (computer-calls.ts): the run's one client.
  const client = recordedClient(sync ? syncingClient(launched.client, sync) : launched.client);
  if (kind === "phone") return hello ? { kind, computer: { client }, hello, ...agent } : "it gave no hello";
  if (check && !launched.readBack) return "it gave no read-back of its mount";
  const readBack = launched.readBack ? () => launched.readBack!() : async (): Promise<Result<MountReadBack>> => ({ ok: false, error: { code: "unsupported", message: "nothing is mounted in this computer" } });
  const computer = { id: launched.id, client, readBack };
  if (kind === "sandbox") return check ? { kind, computer, check } : "a sandbox mounts the run's folder";
  return hello ? { kind, computer, hello, ...(check ? { check } : {}), ...agent } : "it gave no hello";
}
