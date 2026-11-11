// Settings → Computers, the serve side: which computers this server offers, each provider's keys (saved or not, never a
// value), saving a provider's keys sealed in the store, testing a provider's account, and the refusal a run meets at its
// claim when its agent's computer cannot be had here, with the options its provider is made with. createComputerRoutes
// takes the server's Store and the computer package's kind registry by its own names (SETTING_KINDS, PROVIDERS,
// servingRefusals); the tools each kind brings come from the kernel's tool registry (capabilityToolDefs). Keys go by
// their names only: a provider declares them, Settings takes only those, and the store keeps each sealed under the
// server's seal key (server-keys.ts); a provider is handed its keys only at the claim, or for its test, both through
// computer-keys.ts (providerOptions, testConnection), which maps a key's name onto the option it fills.
import { checkGpu, type GpuCapability, imagesOf } from "@parcha/agentrun-computer";
import { BOX_ALLOW_ENV, boxAllowOf } from "./box-settings.js";
import { KEY_TABLE, type KeyTable, type OptionsAnswer, type ProviderFactories, type ProviderSettings, providerOptions, testConnection } from "./computer-keys.js";
import { COMPUTER_KINDS, type ComputerKind, type ComputerSetting, gpuOf } from "./computer-setting.js";
import { inArchilMode } from "./archil-settings.js";
import { daemonUp, type DockerDaemon, noDockerWords } from "./docker-daemon.js";
import { ApiError, invalid } from "./errors.js";
import { redacted } from "./key-refusal.js";
import { type KeyEnv, type KeyMeta, keyMetaOf, envValue } from "./key-meta.js";
import { registerNotSecretWrite, registerSecretWrite, secretName } from "./secret-writes.js";
import { getSealedKey, putSealedKey, removeSealedKey, sealedKeyNames } from "./server-keys.js";
import type { Store } from "./store/index.js";
import { vendorNetworkOnly } from "./workspace/resolve-computer.js";

// Every request to a computer's keys is a secret write (secret-writes.ts), whatever its body (a value, a null, an empty
// body or none), as saveToolKey's is: the server's one dispatch check keeps it to the owner's session before any provider
// is looked up, so a token learns nothing of which providers exist. The view and the connection test write none.
registerSecretWrite("saveComputerKeys", () => true);
registerNotSecretWrite("testComputer", "A connection test reads the saved keys and writes none.");

/** A setting kind as the kind registry's SETTING_KINDS gives it. */
export interface SettingKindSpec {
  readonly machineKinds: readonly string[];
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

/** A provider configuration's machine kind and groups, the GPUs it gives where it declares them, and the image a setting
 *  selects it by, where it names one, as the kind registry gives them. */
export type KindCapabilities = { readonly kind: string; readonly groups: readonly string[]; readonly gpu?: GpuCapability; readonly image?: string };

/** A provider as the kind registry's PROVIDERS gives it. */
export interface ProviderEntry {
  readonly id: string;
  readonly label: string;
  readonly kinds: readonly ComputerKind[];
  readonly keys: readonly { readonly name: string; readonly required: boolean }[];
  /** The mounts its computers take; none means it cannot mount the run's folder. */
  readonly mounts: readonly string[];
  /** The network forms its computers make ("none", "open", "allow"), as its descriptor declares them. Absent (a
   *  test's fixture): nothing is said of its network. */
  readonly network?: readonly string[];
  readonly metered: boolean;
  readonly capabilities: readonly KindCapabilities[];
  /** The image a computer of each kind starts from when its setting names none. */
  readonly defaultImage?: Partial<Record<ComputerKind, string>>;
}

/** The kind registry, by its own names: the computer package's module (SETTING_KINDS, PROVIDERS, servingRefusals). */
export interface KindRegistry {
  readonly SETTING_KINDS: Readonly<Record<ComputerKind, SettingKindSpec>>;
  readonly PROVIDERS: readonly ProviderEntry[];
  servingRefusals(capabilities: KindCapabilities, kind: ComputerKind): string[];
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
  /** The model-visible tools a kind brings (the kernel registry's capabilityToolDefs), by name. */
  readonly tools: (kind: ComputerKind) => readonly string[];
  /** This server's folder mode, or how to read it at each call (folderModeOf: the Archil settings row), so turning
   *  Archil on or off takes effect without building the routes again. */
  readonly mode: FolderMode | (() => FolderMode | Promise<FolderMode>);
  /** The server's environment: a variable named as a provider's key overrides the saved one (source "env"). */
  readonly env?: KeyEnv;
  /** Whether a provider that binds a folder of this machine (Docker) answers here now, or why not (the server's daemon
   *  check, docker-daemon.ts, which keeps its answer a while). Absent: taken as answering. */
  readonly answers?: (provider: string) => Promise<DockerDaemon>;
}

/** A provider as Settings shows it: `metered` straight from the kind registry (its computers are billed by the vendor);
 *  its keys as SecretMeta under `secrets`, each named "computer:<provider>:<KEY>", and `required`, the names of the ones
 *  it needs. `network`: what this server's allow-list means for a vendor-hosted computer, in words (networkWords).
 *  `images`: the images it offers for the kind, by name, where it offers any to choose. */
export type ProviderView = { id: string; name: string; metered: boolean; secrets: KeyMeta[]; required: string[]; ready: boolean; why?: string; network?: string; images?: string[]; gpu?: GpuView };
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

/** A computer on the vendor's own network where this server's AGENTRUN_BOX_ALLOW is none: a run of it is refused at its start
 *  and at its claim (resolve-computer.ts noNetworkRefusal), so Settings says so and never offers it. */
export const VENDOR_NETWORK_REFUSED_WORDS = `the vendor's own network, which this server refuses: its ${BOX_ALLOW_ENV} is none`;

/** Why a provider whose computers run only on the vendor's own network is not ready where this server has no network. */
const noNetworkWhy = (provider: ProviderEntry): string =>
  `${provider.label} runs only on the vendor's own network, and this server's ${BOX_ALLOW_ENV} is none (no network): pick a computer that runs with no network, or set ${BOX_ALLOW_ENV} to a host list`;

/** What this server's allow-list means for a provider's computers, by the network forms it declares: words for one that
 *  makes "none" alone, "open" alone, or "open" and "allow" but no "none" (a browser behind its own proxy); none where
 *  the allow-list applies as it is (Docker), or nothing is declared. */
export function networkWords(network: readonly string[] | undefined): string | undefined {
  if (network?.length === 1 && network[0] === "none") return NO_NETWORK_WORDS;
  if (network?.length === 1 && network[0] === "open") return VENDOR_NETWORK_WORDS;
  if (network?.length === 2 && network.includes("open") && network.includes("allow")) return OPERATOR_LIST_WORDS;
  return undefined;
}
export type KindView = { kind: ComputerKind; offered: boolean; why?: string; groups: string[]; tools: string[]; providers: ProviderView[] };
export type TestView = { ok: true; detail: string } | { ok: false; why: string };

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

/** Why `provider` cannot serve a run's computer of kind `kind` in `mode`, by the mounts it takes: undefined when it can.
 *  A sandbox holds the run's folder: Mode 1 keeps it on this machine, which only a computer that binds a local folder
 *  (Docker) reaches; Mode 2 keeps it on the owner's disk, which only a computer that mounts the disk reaches (never a
 *  local Docker bind). A desktop, phone or browser holds no folder unless its provider mounts it, so either mode takes
 *  it. */
export function modeRefusal(kind: ComputerKind, provider: ProviderEntry, mode: FolderMode): string | undefined {
  if (kind !== "sandbox") return undefined;
  if (mode === "local" && !provider.mounts.includes("bind")) return `${provider.label} can't mount this server's run folders (they are on its own disk): set this agent's computer to sandbox on Docker, or none (Settings → Computers)`;
  if (mode === "disk" && !provider.mounts.includes("archil")) return `${provider.label} can't mount the owner's disk this server keeps run folders on: set this agent's computer to a sandbox that mounts it, or none (Settings → Computers)`;
  return undefined;
}

/** The GPUs a sandbox of `provider` gives, as its configuration that serves a sandbox declares them, or undefined. */
const sandboxGpu = (kinds: Pick<KindRegistry, "servingRefusals">, provider: ProviderEntry): GpuCapability | undefined =>
  provider.capabilities.find((one) => one.gpu !== undefined && kinds.servingRefusals(one, "sandbox").length === 0)?.gpu;

/** The mount a sandbox takes in `mode`: the run's folder, a bind of this machine or the owner's Archil disk. */
const folderMount = (mode: FolderMode): { kind: string } => ({ kind: mode === "local" ? "bind" : "archil" });

/** A sandbox provider's GPUs as Settings shows them, with why a run here cannot have them (checkGpu's words for its
 *  smallest ask, one of its first type, with this mode's mount). */
function gpuView(gpu: GpuCapability, mode: FolderMode): GpuView {
  const [refusal] = gpu.types.length ? checkGpu({ type: gpu.types[0], count: 1 }, { gpu }, folderMount(mode)) : [];
  return { ...structuredClone(gpu), ...(refusal ? { why: refusal.message } : {}) };
}

/** Why `computer`'s GPUs cannot be had on `provider` in `mode`, in checkGpu's words; undefined when they can, or it asks
 *  for none (only a sandbox does). */
function gpuRefusal(kinds: Pick<KindRegistry, "servingRefusals">, computer: ComputerSetting, provider: ProviderEntry, mode: FolderMode): string | undefined {
  const asked = gpuOf(computer);
  if (!asked) return undefined;
  const gpu = sandboxGpu(kinds, provider);
  const [refusal] = checkGpu(asked, gpu ? { gpu } : {}, folderMount(mode));
  return refusal ? `${provider.label} can't give this agent's computer its GPUs: ${refusal.message} (Settings → Computers)` : undefined;
}

/** The required keys `provider` has no saved value for, by name. */
const missingKeys = (provider: ProviderEntry, saved: ReadonlySet<string>): string[] => provider.keys.filter((key) => key.required && !saved.has(key.name)).map((key) => key.name);

/** Why a provider with keys missing is not ready, naming the setting to fill: a person reads it (the view, the test), so
 *  it ends at the setting. A caller's refusal (the claim's) adds the route that saves them (`route`). */
const keysWhy = (provider: ProviderEntry, missing: readonly string[], route = false): string =>
  `${provider.label} needs ${missing.join(" and ")} saved: save ${missing.length > 1 ? "them" : "it"} in Settings → Computers${route ? ` (PUT /v2/computers/${provider.id}/keys)` : ""}`;

/** Whether `provider` binds a folder of this machine, so its computers need this machine's Docker daemon. */
const local = (provider: ProviderEntry): boolean => provider.mounts.includes("bind");

/** The routes' work over the server's store: GET /v2/computers (view), PUT /v2/computers/{provider}/keys (saveKeys), POST
 *  /v2/computers/{provider}/test (test), and the claim's refusal (claimRefusal). */
export function createComputerRoutes(options: ComputerRoutesOptions) {
  const { store, sealKey, kinds, factories, settings = {}, keyTable = KEY_TABLE, tools, env = {}, answers = daemonUp } = options;
  const providerOf = (id: string) => kinds.PROVIDERS.find((one) => one.id === id);
  const modeNow = async (): Promise<FolderMode> => (typeof options.mode === "function" ? options.mode() : options.mode);
  /** Why a computer of `kind` on `provider` can't be had for its daemon (a provider that binds a folder of this machine,
   *  `said` its answer, in folder `mode`): none answering is the one wording (docker-daemon.ts noDockerWords); else its
   *  reason. */
  const daemonWhy = (kind: ComputerKind, said: DockerDaemon, mode: FolderMode): string | undefined =>
    said.up ? undefined : said.absent ? noDockerWords(kind, kinds.PROVIDERS, mode === "disk" ? 2 : 1) : said.reason;

  /** Each kind, whether this server offers it and why not, the capability groups and tools it brings, and each provider
   *  that serves it, with its keys (saved or not, never a value) and whether a run could have it now. */
  async function view(): Promise<{ kinds: KindView[] }> {
    const mode = await modeNow();
    // Every provider's keys in one read: each a SecretMeta named for its provider, set by the environment or the store row
    // of its key's name.
    const slots = kinds.PROVIDERS.flatMap((provider) => provider.keys.map((key) => ({ secret: secretName("computer", provider.id, key.name), env: key.name, row: key.name })));
    const metas = new Map((await keyMetaOf(store, slots, env)).map((meta) => [meta.name, meta]));
    const saved = new Set(slots.filter((slot) => metas.get(slot.secret)!.set).map((slot) => slot.env));
    // Under this server's AGENTRUN_BOX_ALLOW none, a computer that runs only on the vendor's own network is refused at a
    // run's start and its claim (resolve-computer.ts noNetworkRefusal), so it is never ready here, whatever its keys.
    const refusedOpen = (provider: ProviderEntry): boolean => boxAllowOf(env as NodeJS.ProcessEnv) === "none" && vendorNetworkOnly(provider.network);
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
          const why = unusable(kind, provider) ?? (daemon ? daemonWhy(kind, daemon, mode) : undefined) ?? (missing.length ? keysWhy(provider, missing) : undefined);
          // The images an agent's computer.image may name for this kind: those of its configurations that serve it.
          const images = imagesOf(provider.capabilities.filter((one) => kinds.servingRefusals(one, kind).length === 0), provider.defaultImage?.[kind]);
          const network = refusedOpen(provider) ? VENDOR_NETWORK_REFUSED_WORDS : networkWords(provider.network);
          // A sandbox's GPUs: only a sandbox takes them (computer-setting.ts computerIssues).
          const gpu = kind === "sandbox" ? sandboxGpu(kinds, provider) : undefined;
          return { id: provider.id, name: provider.label, metered: provider.metered, secrets: provider.keys.map((key) => metas.get(secretName("computer", provider.id, key.name))!), required: provider.keys.filter((key) => key.required).map((key) => secretName("computer", provider.id, key.name)), ready: why === undefined, ...(why ? { why } : {}), ...(network ? { network } : {}), ...(images.length > 0 ? { images } : {}), ...(gpu ? { gpu: gpuView(gpu, mode) } : {}) };
        });
        const offered = kind === "none" || serving.some((provider) => unusable(kind, provider) === undefined);
        const why = offered ? undefined
          : serving.length && serving.every(refusedOpen) ? `every provider of a ${kind} computer runs only on the vendor's own network, and this server's ${BOX_ALLOW_ENV} is none (no network)`
          : serving.length ? `no provider of a ${kind} computer can reach this server's run folders` : `no provider serves a ${kind} computer`;
        return { kind, offered, ...(why ? { why } : {}), groups: [...spec.required, ...spec.optional], tools: [...tools(kind)], providers };
      }),
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
        : value !== null && (typeof value !== "string" || value === "") ? [{ field: name, reason: "wrong_type", message: `${name} is a non-empty string, or null to remove it` }] : []);
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
    const keys = await keysOf(provider);
    const missing = missingKeys(provider, new Set(Object.keys(keys)));
    if (missing.length) return { ok: false, why: keysWhy(provider, missing) };
    const answer = await testConnection(providerId, { keys, ...(signal ? { signal } : {}) }, factories, settings, keyTable);
    const cut = (text: string): string => redacted(text, Object.values(keys));
    return answer.ok ? { ok: true, detail: cut(answer.value.detail) } : { ok: false, why: cut(answer.error.message) };
  }

  /** Why a run of an agent whose computer is `computer` cannot have it here, in words naming the setting to fill;
   *  undefined when it can. Checked at the claim: the provider must serve the kind (servingRefusals' words), fit this
   *  server's folder mode, give a sandbox the GPUs it asks for (checkGpu's words), have its daemon answer where it binds
   *  a folder of this machine (Docker), and have every required key saved; a key refusal names the route that saves them. */
  async function claimRefusal(computer: ComputerSetting): Promise<string | undefined> {
    if (computer.kind === "none") return undefined;
    const provider = providerOf(computer.provider);
    if (!provider) return `this agent's computer names the provider ${computer.provider}, which this server does not have: set its computer in Settings → Computers`;
    if (!provider.kinds.includes(computer.kind)) {
      const words = [...new Set(provider.capabilities.flatMap((capabilities) => kinds.servingRefusals(capabilities, computer.kind)))];
      return `${provider.label} does not serve a ${computer.kind} computer${words.length ? ` (${words.join("; ")})` : ""}: set this agent's computer to one it serves (Settings → Computers)`;
    }
    const mode = await modeNow();
    const refused = modeRefusal(computer.kind, provider, mode) ?? gpuRefusal(kinds, computer, provider, mode) ?? (local(provider) ? daemonWhy(computer.kind, await answers(provider.id), mode) : undefined);
    if (refused) return refused;
    const missing = missingKeys(provider, new Set([...(await sealedKeyNames(store)), ...provider.keys.filter((key) => envValue(env, key.name) !== undefined).map((key) => key.name)]));
    return missing.length ? keysWhy(provider, missing, true) : undefined;
  }

  /** What the claim makes a run's computer with: the options its provider's create() takes, from its saved keys and the
   *  server's settings (computer-keys.ts providerOptions); refused with computer_unavailable and claimRefusal's words when
   *  the computer cannot be had here. Undefined for a run with no computer. */
  async function claimOptions(computer: ComputerSetting): Promise<OptionsAnswer | undefined> {
    if (computer.kind === "none") return undefined;
    const why = await claimRefusal(computer);
    if (why) return { ok: false, error: { code: COMPUTER_UNAVAILABLE, message: why } };
    return providerOptions(computer.provider, await keysOf(providerOf(computer.provider)!), settings, keyTable);
  }

  return { view, saveKeys, test, claimRefusal, claimOptions };
}

export type ComputerRoutes = ReturnType<typeof createComputerRoutes>;

/** This server's folder mode, read from the store at each call: "disk" (Mode 2) while the Archil settings row is saved
 *  (PUT /v2/workspace/archil), else "local" (Mode 1). createComputerRoutes' `mode`. */
export const folderModeOf = (store: { settings: Pick<Store["settings"], "get"> }) => async (): Promise<FolderMode> => ((await inArchilMode(store)) ? "disk" : "local");

/** Settings → Computers' routes, by their operation names: GET /v2/computers, PUT /v2/computers/{provider}/keys and POST
 *  /v2/computers/{provider}/test. */
export const COMPUTER_SETTINGS_ROUTES: ReadonlySet<string> = new Set(["listComputers", "saveComputerKeys", "testComputer"]);

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
  throw new ApiError("not_found", `no computer route ${name}`);
}

/** capabilities.computers: the kinds this server offers now, in the registry's order. */
export async function computerCapabilities(routes: ComputerRoutes): Promise<{ kinds: ComputerKind[] }> {
  return { kinds: (await routes.view()).kinds.filter((kind) => kind.offered).map((kind) => kind.kind) };
}
