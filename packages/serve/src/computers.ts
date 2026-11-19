// Settings → Computers, the serve side: which computers this server offers, each provider's keys (saved or not, never a
// value), saving a provider's keys sealed in the store, and testing a provider's account. createComputerRoutes takes the
// server's Store and the computer package's kind registry by its own names (SETTING_KINDS, PROVIDERS, servingRefusals);
// the tools each kind brings are the server's to say (server.ts kindTools: a sandbox's shell tools from the kernel's
// hostToolDefs, a browser's from pi-browser, a desktop's or a phone's the kernel's COMPUTER_TOOLS). Keys go by their
// names only: a provider declares them, Settings takes only those, and the store keeps each sealed under the server's
// seal key (server-keys.ts); a provider is handed its keys only for its test, or for the agent's own computer
// (providerFor), through computer-keys.ts (providerOptions, testConnection), which maps a key's name onto the option it
// fills. A run's claim is refused by the workspace's resolver (workspace/resolve-computer.ts resolveComputer).
import { type ComputerProvider, connectOf, type GpuCapability, type HostCommand, imagesOf, type ProviderEntry } from "@parcha/agentrun-computer";
import { BOX_ALLOW_ENV, boxAllowOf } from "./box-settings.js";
import { KEY_TABLE, type KeyChoice, keyChoices, type KeyTable, type ProviderFactories, type ProviderSettings, providerOptions, settingOptions, testConnection } from "./computer-keys.js";
import { COMPUTER_KINDS, type ComputerKind, type ComputerSetting, kindSettings } from "./computer-setting.js";
import { inArchilMode } from "./archil-settings.js";
import { daemonUp, type DockerDaemon, noDockerWords } from "./docker-daemon.js";
import { ApiError, invalid } from "./errors.js";
import { commandOnPath } from "./host-command.js";
import { gpuRefused } from "./gpu-words.js";
import { redacted } from "./key-refusal.js";
import { type KeyEnv, type KeyMeta, keyMetaOf, envValue } from "./key-meta.js";
import { registerNotSecretWrite, registerSecretPage, registerSecretWrite, secretName } from "./secret-writes.js";
import { getSealedKey, putSealedKey, removeSealedKey } from "./server-keys.js";
import type { PairedComputerRow, Store } from "./store/index.js";
import type { PairedView } from "./computer-attach.js";
import { dialApartWords, RUNNER_APART_WORDS, withPaired } from "./workspace/attached-computers.js";
import { aLabel, type ComputerSettingKind, entryHere, folderKindOf, type KindRegistry, type ShellPlace, needsNetwork, shellChoiceOf } from "./workspace/resolve-computer.js";
import { restartWith } from "./start-switches.js";

// Every request to a computer's keys is a secret write (secret-writes.ts), whatever its body (a value, a null, an empty
// body or none), as saveToolKey's is: the server's one dispatch check keeps it to the owner's session before any provider
// is looked up, so a token learns nothing of which providers exist. The view and the connection test write none.
registerSecretWrite("saveComputerKeys", () => true);
registerSecretPage("saveComputerKeys", "/#/settings/computers");
registerNotSecretWrite("testComputer", "A connection test reads the saved keys and writes none.");

const ARCH_NAMES: Readonly<Record<string, string>> = { x64: "x86-64", arm64: "arm64" };
const PLATFORM_NAMES: Readonly<Record<string, string>> = { linux: "Linux", darwin: "macOS", win32: "Windows" };

/** Why a provider whose host command is not on this machine's PATH cannot run here, in words that say how to fix it,
 *  as the server says Docker's (docker-daemon.ts). On a machine the command has no build for (adb on arm64 Linux: AgentRun's
 *  arm64 image has none either), they say which machine it needs, not how to install it. */
export function hostCommandWhy(label: string, { command, from, builds }: HostCommand, platform: string = process.platform, arch: string = process.arch): string {
  if (!builds || builds.includes(`${platform}-${arch}`)) return `${command} isn't installed on this server (no ${command} command on PATH): install ${from}, then restart AgentRun`;
  const name = (one: string): string => ARCH_NAMES[one] ?? one;
  const others = builds.filter((one) => one.startsWith(`${platform}-`)).map((one) => name(one.slice(platform.length + 1)));
  const needs = others.length ? `an ${others.join(" or ")} server` : `a server where ${from} runs (${builds.join(", ")})`;
  return `this server's image has no ${command} for ${name(arch)} (${from} has no ${PLATFORM_NAMES[platform] ?? platform} build for ${name(arch)}): ${label} needs ${needs}`;
}

/** Each provider whose host command is not on `path` (the server's PATH at its start), by its id, with hostCommandWhy's
 *  words: what Settings → Computers, a run's start and the claim say for it. A command is there when a folder of `path`
 *  holds an executable file of its name. */
export function hostCommandRefusals(providers: readonly Pick<ProviderEntry, "id" | "label" | "hostCommand">[], path: string | undefined, platform: string = process.platform, arch: string = process.arch): Readonly<Record<string, string>> {
  return Object.fromEntries(providers.flatMap((provider) => (provider.hostCommand && !commandOnPath(provider.hostCommand.command, path, platform) ? [[provider.id, hostCommandWhy(provider.label, provider.hostCommand, platform, arch)]] : [])));
}

/** Where the run's folder lives: on this machine (Mode 1), or on the owner's disk (Mode 2). */
export type FolderMode = "local" | "disk";

export interface ComputerRoutesOptions {
  /** The server's one store: its sealed keys. */
  readonly store: Pick<Store, "sealedKeys">;
  /** The server's seal key: there is always one (seal-key.ts bootSealKey, at the start). */
  readonly sealKey: Buffer;
  readonly kinds: KindRegistry;
  /** Each provider module's create(), by provider id (the computer package's): what a test and a claim make. */
  readonly factories: ProviderFactories;
  /** The server's settings that go to a provider's options but are no key (the Modal app). */
  readonly settings?: ProviderSettings;
  /** The map from a provider's key names to its options: serve's own unless given (--faux gives its own). */
  readonly keyTable?: KeyTable;
  /** The model-visible tools a kind brings, by name (server.ts kindTools). */
  readonly tools: (kind: ComputerKind) => readonly string[];
  /** This server's folder mode, or how to read it at each call (folderModeOf: the Archil settings, the environment's or the saved row), so turning
   *  Archil on or off takes effect without building the routes again. */
  readonly mode: FolderMode | (() => FolderMode | Promise<FolderMode>);
  /** Why this machine cannot run a provider's computers, by its id (hostCommandRefusals at the server's start): the
   *  provider is not ready, and a claim of it is refused, in these words. Absent: every provider can run here. */
  readonly hostWhy?: Readonly<Record<string, string>>;
  /** The server's environment: a variable named as a provider's key overrides the saved one (source "env"). */
  readonly env?: KeyEnv;
  /** Whether a provider that binds a folder of this machine (Docker) answers here now, or why not (the server's daemon
   *  check, docker-daemon.ts, which keeps its answer a while). Absent: taken as answering. */
  readonly answers?: (provider: string) => Promise<DockerDaemon>;
  /** The person's own computers paired with this server (computer-attach.ts): the store's rows and each one's view.
   *  Each is one more provider of its kind (attached-computers.ts pairedEntry), ready while it is attached. Absent:
   *  none. */
  readonly paired?: { rows(): Promise<readonly PairedComputerRow[]>; viewOf(row: PairedComputerRow, serves: readonly ComputerSettingKind[]): PairedView };
  /** No runner in this server's process (ServeOptions.runnerApart): no run here can use a computer whose socket the
   *  server's attach hub takes, a paired computer's or a dial provider's machine's. Each such provider's row says so
   *  (runs_refused), and a dial provider's test fails in those words. */
  readonly runnerApart?: boolean;
  /** Whether a runner in a process of its own relays its dials now (dial-relay.ts): its machines dial this server, which
   *  relays each socket to it, so a dial provider's runs can use it and its row says nothing. Read once per view and per
   *  test. Absent: none does. A paired computer's socket is never relayed. */
  readonly relayed?: () => Promise<boolean>;
}

/** A provider as Settings shows it: `metered` straight from the kind registry (its computers are billed by the vendor);
 *  its keys as SecretMeta under `secrets`, each named "computer:<provider>:<KEY>", and `required`, the names of the ones
 *  it needs. `network`: what this server's allow-list means for a vendor-hosted computer, in words (networkWords).
 *  `images`: the images it offers for the kind, by name, where it offers any to choose. `persistent`: present where an
 *  agent's computer of this kind can be kept between its runs (computer.persistent: true), with the images that keep one
 *  where it offers images to choose. `picked`: the names of the secrets a person picks from the vendor's own list
 *  (GET /v2/computers/{provider}/choices) rather than pastes, where it has any. `runs_refused`: on a server whose runner
 *  runs in a process of its own, why no run here can use it and the fix, for a computer whose socket the server's
 *  process takes (a dial provider's, a paired one's); else null. */
export type ProviderView = { id: string; name: string; metered: boolean; secrets: KeyMeta[]; required: string[]; picked?: string[]; ready: boolean; why?: string; runs_refused: string | null; network?: string; images?: string[]; persistent?: { images?: string[] }; gpu?: GpuView } & ShellChoice;
/** A choice's shell (workspace runShellOf, in this server's mode), the host tools it gives (the kernel registry's
 *  hostToolDefs for that shell) and what it leaves out in words (absent on a computer that mounts the folder). */
export type ShellChoice = { shell: ShellPlace; host_tools: string[]; shell_note?: string };
/** A sandbox provider's GPUs as Settings shows them: what its configuration declares (the types an agent's
 *  `computer.gpu.type` names, the most one computer gets, and the limits it states), and why a run here cannot have
 *  them, when it cannot: a GPU computer of it that takes no mount of this server's folder mode. */
export type GpuView = GpuCapability & { why?: string };

/** A computer with no network: its programs run in a network of their own, so a run's allow-list is never offered it. */
export const NO_NETWORK_WORDS = "no network, so this server's allow-list isn't offered";
/** A computer on the vendor's own network: open, which this server's allow-list doesn't reach. */
export const VENDOR_NETWORK_WORDS = "the vendor's own network; this server's allow-list doesn't apply";
/** A browser behind its own egress proxy (Local Chrome): every public host, unless the operator set a list. */
export const OPERATOR_LIST_WORDS = "open unless this server sets AGENTRUN_BOX_ALLOW; then only those hosts";

/** A computer that needs a network where this server's AGENTRUN_BOX_ALLOW is none: a run of it is refused at its start
 *  and at its claim (resolve-computer.ts noNetworkRefusal), so Settings says so and never offers it. */
export const NETWORK_REFUSED_WORDS = `needs a network, which this server refuses: its ${BOX_ALLOW_ENV} is none`;

/** Why a provider whose computers can't run with no network is not ready where this server has none. */
const noNetworkWhy = (provider: ProviderEntry): string =>
  `${provider.label} needs a network, and this server's ${BOX_ALLOW_ENV} is none (no network): pick a computer that runs with no network, or ${restartWith(`${BOX_ALLOW_ENV} set to a host list`)}`;

/** What this server's allow-list means for a provider's computers, by the network forms it declares: words for one that
 *  makes "none" alone, "open" alone, or "open" and "allow" but no "none" (a browser behind its own proxy); none where
 *  the allow-list applies as it is (Docker), or nothing is declared. */
export function networkWords(network: readonly string[] | undefined, kind?: ComputerKind): string | undefined {
  if (network?.length === 1 && network[0] === "none") return NO_NETWORK_WORDS;
  // A desktop whose provider makes open is open under the default list (computer-deps.ts networkOf), as Local Chrome is.
  if (kind === "desktop" && network?.includes("open") && network.includes("allow")) return OPERATOR_LIST_WORDS;
  if (network?.length === 1 && network[0] === "open") return VENDOR_NETWORK_WORDS;
  if (network?.length === 2 && network.includes("open") && network.includes("allow")) return OPERATOR_LIST_WORDS;
  return undefined;
}
/** A kind; kind none, the one "no computer" choice, carries its ShellChoice itself (it has no providers). `settings`: the
 *  fields its computer may set beside kind and provider (computer-setting.ts kindSettings). */
export type KindView = { kind: ComputerKind; offered: boolean; why?: string; groups: string[]; tools: string[]; settings: string[]; providers: ProviderView[] } & Partial<ShellChoice>;
export type TestView = { ok: true; detail: string } | { ok: false; why: string };
/** A picked key's choices (GET /v2/computers/{provider}/choices): its KEY, as PUT …/keys takes it, then the values the
 *  vendor's list offers, each saved as it is and shown by its label, and `saved`, the one whose value is saved now, where
 *  one is (it is among the options already, so it says nothing new); or why there are none to pick, in words. */
export type KeyChoicesView = { key: string; options: KeyChoice[]; saved?: string } | { key: string; why: string };

/** Why a key save is refused, before anything is saved: a name the provider does not declare, or a value that is not text. */
export class KeysRefused extends Error {
  readonly fields: { field: string; reason: string; message: string }[];
  constructor(fields: { field: string; reason: string; message: string }[]) {
    super(fields.map((field) => field.message).join("; "));
    this.name = "KeysRefused";
    this.fields = fields;
  }
}

/** A run's failure code when its computer cannot be had. */
export const COMPUTER_UNAVAILABLE = "computer_unavailable";

/** Why `provider` cannot serve a run's computer of kind `kind` in `mode`, by the folder it holds (resolve-computer.ts
 *  folderKindOf): undefined when it can. A sandbox holds the run's folder: Mode 1 keeps it on this machine, which only a
 *  computer that binds a local folder (Docker) reaches; Mode 2 keeps it on the owner's disk, which a computer holds as an
 *  Archil mount where its provider takes one and Archil's image is here, else as a synced folder the runner keeps on the
 *  disk (never a local Docker bind). A desktop, phone or browser holds no folder unless its provider takes one, so either
 *  mode takes it. `provider` is as this server has it (resolve-computer.ts entryHere). */
export function modeRefusal(kind: ComputerKind, provider: ProviderEntry, mode: FolderMode): string | undefined {
  if (kind !== "sandbox") return undefined;
  if (mode === "local" && !provider.mounts.includes("bind")) return `${provider.label} can't mount this server's run folders (they are on its own disk): set this agent's computer to sandbox on Docker, or none (Settings → Computers)`;
  if (mode === "disk" && folderKindOf(provider, 2) === undefined) {
    const why = [provider.unmounted?.archil, provider.unmounted?.sync].filter((one) => one !== undefined).join("; ");
    return `${provider.label} can't mount the owner's disk this server keeps run folders on${why ? ` (${why})` : ""}: set this agent's computer to a sandbox that mounts it, or none (Settings → Computers)`;
  }
  return undefined;
}

/** The GPUs a sandbox of `provider` gives, as its configuration that serves a sandbox declares them, or undefined. */
const sandboxGpu = (kinds: Pick<KindRegistry, "servingRefusals">, provider: ProviderEntry): GpuCapability | undefined =>
  provider.capabilities.find((one) => one.gpu !== undefined && kinds.servingRefusals(one, "sandbox").length === 0)?.gpu;

/** The mount a GPU sandbox of `provider` takes in `mode` for the run's folder (resolve-computer.ts folderKindOf, with
 *  what its GPU computers take): a bind of this machine, the owner's Archil disk or a synced folder. */
const folderMount = (provider: ProviderEntry, gpu: GpuCapability | undefined, mode: FolderMode): { kind: string } => ({ kind: folderKindOf(provider, mode === "local" ? 1 : 2, gpu?.mounts) ?? (mode === "local" ? "bind" : "archil") });

/** A sandbox provider's GPUs as Settings shows them, with why a run here cannot have them (gpuRefused's words for its
 *  smallest ask, one of its first type, with this mode's mount). Its reason for taking no mount is in `why`, not a
 *  field of its own. */
function gpuView(gpu: GpuCapability, provider: ProviderEntry, mode: FolderMode): GpuView {
  const label = provider.label;
  const refused = gpu.types.length ? gpuRefused({ type: gpu.types[0], count: 1 }, gpu, folderMount(provider, gpu, mode), label) : undefined;
  const shown = structuredClone(gpu);
  delete shown.unmounted;
  return { ...shown, ...(refused ? { why: refused.words } : {}) };
}

/** The required keys `provider` has no saved value for, by name. */
const missingKeys = (provider: ProviderEntry, saved: ReadonlySet<string>): string[] => provider.keys.filter((key) => key.required && !saved.has(key.name)).map((key) => key.name);

/** Why a provider with keys missing is not ready, naming the setting to fill: a person reads it (the view, the test). */
const keysWhy = (provider: ProviderEntry, missing: readonly string[]): string =>
  `${provider.label} needs ${missing.join(" and ")} saved: save ${missing.length > 1 ? "them" : "it"} in Settings → Computers`;

/** Whether `provider` binds a folder of this machine, so its computers need this machine's Docker daemon. */
const local = (provider: ProviderEntry): boolean => provider.mounts.includes("bind");

/** The routes' work over the server's store: GET /v2/computers (view), PUT /v2/computers/{provider}/keys (saveKeys), POST
 *  /v2/computers/{provider}/test (test), GET /v2/computers/{provider}/choices (choices), and the provider of an agent's
 *  own computer (providerFor). */
export function createComputerRoutes(options: ComputerRoutesOptions) {
  const { store, sealKey, kinds, factories, settings = {}, keyTable = KEY_TABLE, tools, env = {}, answers = daemonUp, hostWhy = {} } = options;
  const providerOf = (id: string) => kinds.PROVIDERS.find((one) => one.id === id);
  const hostOf = (provider: ProviderEntry): string | undefined => (Object.hasOwn(hostWhy, provider.id) ? hostWhy[provider.id] : undefined);
  const modeNow = async (): Promise<FolderMode> => (typeof options.mode === "function" ? options.mode() : options.mode);
  /** Why no run here can use `provider`'s computers, on a server whose runner runs in a process of its own: its machines
   *  dial this server (connectOf, with the connect its settings give), or it is a paired computer (`paired`), so the
   *  server's attach hub takes its socket, which the runner never reaches. A dial provider's machine reaches a runner
   *  that relays its dials (`relayed`, read by relaysNow), so it is null there. Null where its runs can use it. */
  const runsRefused = (provider: Pick<ProviderEntry, "id" | "label" | "connect">, relays: boolean, paired = false): string | null =>
    options.runnerApart !== true ? null : paired ? RUNNER_APART_WORDS : !relays && connectOf(provider, settingOptions(provider.id, settings, keyTable)) === "dial" ? dialApartWords(provider.label) : null;
  const relaysNow = async (): Promise<boolean> => options.runnerApart === true && options.relayed !== undefined && (await options.relayed());
  /** Why a computer of `kind` on `provider` can't be had for its daemon (a provider that binds a folder of this machine,
   *  `said` its answer, in folder `mode`): none answering is the one wording (docker-daemon.ts noDockerWords); else its
   *  reason. */
  const daemonWhy = (kind: ComputerKind, said: DockerDaemon, mode: FolderMode): string | undefined =>
    said.up ? undefined : said.absent ? noDockerWords(kind, kinds.PROVIDERS, mode === "disk" ? 2 : 1) : said.reason;

  /** Each kind, whether this server offers it and why not, the capability groups and tools it brings, and each provider
   *  that serves it, with its keys (saved or not, never a value) and whether a run could have it now. */
  async function view(): Promise<{ kinds: KindView[]; paired: PairedView[] }> {
    const mode = await modeNow();
    // The paired computers, each one more provider of its kind; one not attached now is not ready, saying so.
    const rows = options.paired ? await options.paired.rows() : [];
    const listed = withPaired(options.kinds, rows);
    const paired = rows.map((row) => options.paired!.viewOf(row, listed.PROVIDERS.find((provider) => provider.id === row.id)?.kinds ?? []));
    const offline = new Map(rows.flatMap((row, at) => (paired[at]!.online ? [] : [[row.id, `${row.name} is not attached now: open its driver on that computer, which dials this server`] as const])));
    const pairedIds = new Set(rows.map((row) => row.id));
    const relays = await relaysNow();
    // Every provider's keys in one read: each a SecretMeta named for its provider, set by the environment or the store row
    // of its key's name.
    const slots = listed.PROVIDERS.flatMap((provider) => provider.keys.map((key) => ({ secret: secretName("computer", provider.id, key.name), env: key.name, row: key.name })));
    const metas = new Map((await keyMetaOf(store, slots, env)).map((meta) => [meta.name, meta]));
    const saved = new Set(slots.filter((slot) => metas.get(slot.secret)!.set).map((slot) => slot.env));
    // Each provider as this server has it: the mounts its saved keys turn on, whether this server names its image, and no
    // Archil mount where its settings make its machines dial this server.
    const kinds = { ...listed, PROVIDERS: listed.PROVIDERS.map((provider) => entryHere(provider, (name) => saved.has(name) || envValue(env, name) !== undefined, settingOptions(provider.id, settings, keyTable))) };
    const choice = (setting: ComputerSetting): ShellChoice => shellChoiceOf(setting, mode === "disk" ? 2 : 1, kinds);
    // Under this server's AGENTRUN_BOX_ALLOW none, a computer that needs a network is refused at a
    // run's start and its claim (resolve-computer.ts noNetworkRefusal), so it is never ready here, whatever its keys.
    const refusedOpen = (provider: ProviderEntry): boolean => boxAllowOf(env as NodeJS.ProcessEnv) === "none" && needsNetwork(provider.network);
    const unusable = (kind: ComputerKind, provider: ProviderEntry): string | undefined => modeRefusal(kind, provider, mode) ?? (refusedOpen(provider) ? noNetworkWhy(provider) : undefined);
    // Each provider that binds a folder of this machine asked once for the view: its daemon answers, or why not.
    const daemons = new Map(await Promise.all(kinds.PROVIDERS.filter(local).map(async (provider) => [provider.id, await answers(provider.id)] as const)));
    return {
      kinds: COMPUTER_KINDS.map((kind): KindView => {
        const spec = kinds.SETTING_KINDS[kind];
        const serving = kinds.PROVIDERS.filter((provider) => provider.kinds.includes(kind));
        const providers = serving.map((provider): ProviderView => {
          const missing = missingKeys(provider, saved);
          const daemon = daemons.get(provider.id);
          const why = offline.get(provider.id) ?? unusable(kind, provider) ?? (daemon ? daemonWhy(kind, daemon, mode) : undefined) ?? hostOf(provider) ?? (missing.length ? keysWhy(provider, missing) : undefined);
          // The images an agent's computer.image may name for this kind: those of its configurations that serve it.
          const serving = provider.capabilities.filter((one) => kinds.servingRefusals(one, kind).length === 0);
          const images = imagesOf(serving, provider.defaultImage?.[kind]);
          const network = refusedOpen(provider) ? NETWORK_REFUSED_WORDS : networkWords(provider.network, kind);
          // A sandbox's GPUs: only a sandbox takes them (computer-setting.ts computerIssues).
          const gpu = kind === "sandbox" ? sandboxGpu(kinds, provider) : undefined;
          // The configurations of this kind that keep an agent's own computer (computer-setting.ts persistenceIssues).
          const keeping = serving.filter((one) => one.persistence !== undefined);
          const keptImages = images.filter((image) => keeping.some((one) => (one.image ?? provider.defaultImage?.[kind]) === image));
          const persistent = keeping.length === 0 ? undefined : images.length > 0 ? { images: keptImages } : {};
          const picked = provider.keys.filter((key) => key.picked).map((key) => secretName("computer", provider.id, key.name));
          return { id: provider.id, name: provider.label, metered: provider.metered, secrets: provider.keys.map((key) => metas.get(secretName("computer", provider.id, key.name))!), required: provider.keys.filter((key) => key.required).map((key) => secretName("computer", provider.id, key.name)), ...(picked.length > 0 ? { picked } : {}), ready: why === undefined, ...(why ? { why } : {}), runs_refused: runsRefused(provider, relays, pairedIds.has(provider.id)), ...(network ? { network } : {}), ...(images.length > 0 ? { images } : {}), ...(persistent ? { persistent } : {}), ...(gpu ? { gpu: gpuView(gpu, provider, mode) } : {}), ...choice({ kind, provider: provider.id } as ComputerSetting) };
        });
        const offered = kind === "none" || serving.some((provider) => unusable(kind, provider) === undefined);
        const why = offered ? undefined
          : serving.length && serving.every(refusedOpen) ? `every provider of a ${kind} computer needs a network, and this server's ${BOX_ALLOW_ENV} is none (no network)`
          : serving.length ? `no provider of a ${kind} computer can reach this server's run folders` : `no provider serves a ${kind} computer`;
        return { kind, offered, ...(why ? { why } : {}), groups: [...spec.required, ...spec.optional], tools: [...tools(kind)], settings: kindSettings(kind), providers, ...(kind === "none" ? choice({ kind: "none" }) : {}) };
      }),
      paired,
    };
  }

  /** Saves `body`'s keys for a provider, each sealed in the store under its declared name; null removes one. Only names
   *  the provider declares are taken, and nothing is saved when any is refused. The answer is the provider's view: names
   *  and whether each is saved, never a value. Undefined for a provider this server does not have. */
  async function saveKeys(providerId: string, body: Readonly<Record<string, unknown>>): Promise<ProviderView | undefined> {
    const provider = providerOf(providerId);
    if (!provider) return undefined;
    const declared = new Set(provider.keys.map((key) => key.name));
    const refused = Object.entries(body).flatMap(([name, value]) =>
      !declared.has(name) ? [{ field: name, reason: "not_allowed", message: `${provider.label} takes ${[...declared].join(", ") || "no keys"}, not ${name}` }]
        // Whitespace alone is no value, as in the environment (key-meta.ts envValue): saved, it would read as set here and
        // as none where a value is read (resolve-computer.ts registryHere), so Settings would show ready what a run refuses.
        : value !== null && (typeof value !== "string" || value.trim() === "") ? [{ field: name, reason: "wrong_type", message: `${name} is a non-empty string, or null to remove it` }] : []);
    if (refused.length) throw new KeysRefused(refused);
    for (const [name, value] of Object.entries(body)) {
      if (value === null) await removeSealedKey(store, name);
      else await putSealedKey(store, sealKey, name, value as string);
    }
    return (await view()).kinds.flatMap((kind) => kind.providers).find((one) => one.id === providerId);
  }

  /** A provider's saved keys, opened from the store, by name. */
  async function keysOf(provider: ProviderEntry): Promise<Record<string, string>> {
    const keys: Record<string, string> = {};
    for (const key of provider.keys) {
      // The environment's value wins over a saved one (source "env").
      const value = envValue(env, key.name) ?? (await getSealedKey(store, sealKey, key.name));
      if (value !== undefined) keys[key.name] = value;
    }
    return keys;
  }

  /** The account test of a provider with its saved keys (computer-keys.ts testConnection): one account-level read, never a
   *  create. Its words are the answer's why. Undefined for a provider this server does not have. What the provider said
   *  passes serve's one redactor (key-refusal.ts redacted) over the keys this test used: a vendor's error can quote a key
   *  in a form testConnection's plain cut misses (base64 in an Authorization header, JSON-escaped, percent-encoded). */
  async function test(providerId: string, signal?: AbortSignal): Promise<TestView | undefined> {
    const provider = providerOf(providerId);
    if (!provider) return undefined;
    // A dial provider on a server whose runner runs apart: its account would pass here, in the server's process, while
    // every run's create refuses at the runner. No key fixes that, so it is said first, with no vendor call.
    const apart = runsRefused(provider, await relaysNow());
    if (apart) return { ok: false, why: apart };
    const keys = await keysOf(provider);
    const missing = missingKeys(provider, new Set(Object.keys(keys)));
    if (missing.length) return { ok: false, why: keysWhy(provider, missing) };
    const answer = await testConnection(providerId, { keys, ...(signal ? { signal } : {}) }, factories, settings, keyTable);
    const cut = (text: string): string => redacted(text, Object.values(keys));
    return answer.ok ? { ok: true, detail: cut(answer.value.detail) } : { ok: false, why: cut(answer.error.message) };
  }

  /** Each picked key of a provider (Orgo's workspace) with the values the vendor's list offers for it, read with its
   *  saved keys (computer-keys.ts keyChoices), never making a computer; or why there are none, in words (a required key
   *  not saved, an account with none). Its words pass the redactor as the test's do. Undefined for a provider this server
   *  does not have. */
  async function choices(providerId: string, signal?: AbortSignal): Promise<{ choices: KeyChoicesView[] } | undefined> {
    const provider = providerOf(providerId);
    if (!provider) return undefined;
    const keys = await keysOf(provider);
    const missing = missingKeys(provider, new Set(Object.keys(keys)));
    const cut = (text: string): string => redacted(text, Object.values(keys));
    const views: KeyChoicesView[] = [];
    for (const key of provider.keys.filter((one) => one.picked)) {
      if (missing.length) {
        views.push({ key: key.name, why: keysWhy(provider, missing) });
        continue;
      }
      const answer = await keyChoices(providerId, key.name, { keys, ...(signal ? { signal } : {}) }, factories, settings, keyTable);
      if (!answer.ok) {
        views.push({ key: key.name, why: cut(answer.error.message) });
        continue;
      }
      const saved = answer.value.find((one) => one.value === keys[key.name])?.value;
      views.push({ key: key.name, options: answer.value.map((one) => ({ value: one.value, label: cut(one.label) })), ...(saved === undefined ? {} : { saved }) });
    }
    return { choices: views };
  }

  /** The provider an agent's own computer lives on (workspace/agent-computer.ts reconcileAgentComputer deletes it
   *  through it): made from its saved keys and the server's settings, with the create() options of the configuration
   *  `image` selects, and the store's ledger (the factories'). Throws, in words, when it cannot be made here. */
  async function providerFor(providerId: string, image: string | undefined): Promise<Pick<ComputerProvider, "release">> {
    const entry = providerOf(providerId);
    if (!entry) throw new Error(`this server has no computer provider ${JSON.stringify(providerId)}`);
    const options = providerOptions(providerId, await keysOf(entry), settings, keyTable);
    if (!options.ok) throw new Error(options.error.message);
    const make = Object.hasOwn(factories, providerId) ? factories[providerId] : undefined;
    if (typeof make !== "function") throw new Error(`this server cannot make ${aLabel(entry.label)} provider`);
    const configuration = image === undefined ? undefined : entry.capabilities.find((one) => one.image === image);
    const made = (await make({ ...options.options, ...((configuration?.options ?? {}) as Record<string, string>) })) as unknown as Partial<Pick<ComputerProvider, "release">>;
    if (typeof made.release !== "function") throw new Error(`this server's ${entry.label} provider cannot release a computer`);
    return made as Pick<ComputerProvider, "release">;
  }

  return { view, saveKeys, test, choices, providerFor };
}

export type ComputerRoutes = ReturnType<typeof createComputerRoutes>;

/** This server's folder mode, read from the store at each call: "disk" (Mode 2) while the Archil settings row is saved
 *  (PUT /v2/workspace/archil), else "local" (Mode 1). createComputerRoutes' `mode`. */
export const folderModeOf = (store: { settings: Pick<Store["settings"], "get"> }, env: KeyEnv = {}) => async (): Promise<FolderMode> => ((await inArchilMode(store, env)) ? "disk" : "local");

/** Settings → Computers' routes, by their operation names: GET /v2/computers, PUT /v2/computers/{provider}/keys, POST
 *  /v2/computers/{provider}/test and GET /v2/computers/{provider}/choices. */
export const COMPUTER_SETTINGS_ROUTES: ReadonlySet<string> = new Set(["listComputers", "saveComputerKeys", "testComputer", "listComputerChoices"]);

const noProvider = (id: string | undefined): ApiError => new ApiError("not_found", `this server has no computer provider ${JSON.stringify(id ?? "")}: GET /v2/computers lists them`);

/** One of Settings → Computers' routes at its handler, as serve's dispatch calls it: its answer (sent 200), or its refusal
 *  as an ApiError (sent with its status): an unknown provider is not_found; a key save's body that is not an object of
 *  names, or a name the provider does not take, is input_invalid with its fields. */
export async function settingsComputerRoute(routes: ComputerRoutes, name: string, request: { readonly provider?: string; readonly body?: unknown; readonly signal?: AbortSignal }): Promise<unknown> {
  if (name === "listComputers") return routes.view();
  if (name === "saveComputerKeys") {
    const { body } = request;
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ApiError("input_invalid", "the body is a JSON object of the provider's key names, each a string, or null to remove it");
    let saved: ProviderView | undefined;
    try {
      saved = await routes.saveKeys(request.provider ?? "", body as Record<string, unknown>);
    } catch (error) {
      if (error instanceof KeysRefused) throw invalid(error.fields, error.message);
      throw error;
    }
    if (saved === undefined) throw noProvider(request.provider);
    return saved;
  }
  if (name === "testComputer") {
    const answer = await routes.test(request.provider ?? "", request.signal);
    if (answer === undefined) throw noProvider(request.provider);
    return answer;
  }
  if (name === "listComputerChoices") {
    const answer = await routes.choices(request.provider ?? "", request.signal);
    if (answer === undefined) throw noProvider(request.provider);
    return answer;
  }
  throw new ApiError("not_found", `no computer route ${name}`);
}

/** capabilities.computers: the kinds this server offers now, in the registry's order. */
export async function computerCapabilities(routes: ComputerRoutes): Promise<{ kinds: ComputerKind[] }> {
  return { kinds: (await routes.view()).kinds.filter((kind) => kind.offered).map((kind) => kind.kind) };
}
