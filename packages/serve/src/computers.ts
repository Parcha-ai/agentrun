// Settings → Computers, the serve side: which computers this server offers, each provider's keys (saved or not, never a
// value), saving a provider's keys sealed in the store, testing a provider's account, and the refusal a run meets at its
// claim when its agent's computer cannot be had here. createComputerRoutes takes the server's Store and the computer
// package's kind registry by its own names (SETTING_KINDS, PROVIDERS, servingRefusals) and a TestConnection; the tools
// each kind brings come from the kernel's tool registry (capabilityToolDefs). Keys go by their names only: a provider
// declares them, Settings takes only those, and the store keeps each sealed under the server's seal key
// (server-keys.ts); a provider is handed its keys only at the claim, or for its test. testConnectionOf is serve's
// TestConnection: it maps a provider's keys, by name, onto the options its create() takes, builds it, and asks it for
// its one account-level read.
import { COMPUTER_KINDS, type ComputerKind, type ComputerSetting } from "./computer-setting.js";
import { getSealedKey, putSealedKey, removeSealedKey, sealedKeyNames } from "./server-keys.js";
import type { Store } from "./store/index.js";

/** A setting kind as the kind registry's SETTING_KINDS gives it. */
export interface SettingKindSpec {
  readonly machineKinds: readonly string[];
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

/** A provider configuration's machine kind and groups, as the kind registry gives them. */
export type KindCapabilities = { readonly kind: string; readonly groups: readonly string[] };

/** A provider as the kind registry's PROVIDERS gives it. */
export interface ProviderEntry {
  readonly id: string;
  readonly label: string;
  readonly kinds: readonly ComputerKind[];
  readonly keys: readonly { readonly name: string; readonly required: boolean }[];
  /** The mounts its computers take; none means it cannot mount the run's folder. */
  readonly mounts: readonly string[];
  readonly metered: boolean;
  readonly capabilities: readonly KindCapabilities[];
}

/** An answer of a TestConnection (the computer package's Result). */
export type TestResult = { ok: true; value: { detail: string } } | { ok: false; error: { code: string; message: string } };
/** The kind registry's TestConnection: one account-level read with the keys by their serve-side names, never a create. */
export type TestConnection = (providerId: string, options: { keys: Readonly<Record<string, string>>; signal?: AbortSignal }) => Promise<TestResult>;

/** The kind registry, by its own names. */
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
  /** The server's seal key; absent, no key is kept here. */
  readonly sealKey: Buffer | undefined;
  readonly kinds: KindRegistry;
  readonly testConnection: TestConnection;
  /** The model-visible tools a kind brings (the kernel registry's capabilityToolDefs), by name. */
  readonly tools: (kind: ComputerKind) => readonly string[];
  readonly mode: FolderMode;
}

/** A provider's key, as Settings shows it. */
export type KeyView = { name: string; required: boolean; saved: boolean };
export type ProviderView = { id: string; name: string; keys: KeyView[]; ready: boolean; why?: string };
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

/** The required keys `provider` has no saved value for, by name. */
const missingKeys = (provider: ProviderEntry, saved: ReadonlySet<string>): string[] => provider.keys.filter((key) => key.required && !saved.has(key.name)).map((key) => key.name);

/** Why a provider with keys missing is not ready, naming the setting to fill. */
const keysWhy = (provider: ProviderEntry, missing: readonly string[]): string =>
  `${provider.label} needs ${missing.join(" and ")} saved: save ${missing.length > 1 ? "them" : "it"} in Settings → Computers (PUT /v2/computers/${provider.id}/keys)`;

/** A failed account test in plain words, by its code: the key refused, the vendor not reached, or the vendor's own words. */
function testWhy(provider: ProviderEntry, error: { code: string; message: string }): string {
  const names = provider.keys.map((key) => key.name).join(" and ");
  if (error.code === "unauthorized") return `${provider.label} refused the key: check ${names} in Settings → Computers, then test again`;
  if (error.code === "unreachable") return `${provider.label} could not be reached from this server: check its network${provider.keys.some((key) => key.name.endsWith("_API_URL")) ? ", and the API URL if you saved one" : ""}, then test again`;
  return `${provider.label} did not pass its test: ${error.message}`;
}

/** The routes' work over the server's store: GET /v2/computers (view), PUT /v2/computers/{provider}/keys (saveKeys), POST
 *  /v2/computers/{provider}/test (test), and the claim's refusal (claimRefusal). */
export function createComputerRoutes(options: ComputerRoutesOptions) {
  const { store, sealKey, kinds, testConnection, tools, mode } = options;
  const providerOf = (id: string) => kinds.PROVIDERS.find((one) => one.id === id);

  /** Each kind, whether this server offers it and why not, the capability groups and tools it brings, and each provider
   *  that serves it, with its keys (saved or not, never a value) and whether a run could have it now. */
  async function view(): Promise<{ kinds: KindView[] }> {
    const saved = new Set(await sealedKeyNames(store));
    return {
      kinds: COMPUTER_KINDS.map((kind): KindView => {
        const spec = kinds.SETTING_KINDS[kind];
        const serving = kinds.PROVIDERS.filter((provider) => provider.kinds.includes(kind));
        const providers = serving.map((provider): ProviderView => {
          const missing = missingKeys(provider, saved);
          const why = modeRefusal(kind, provider, mode) ?? (missing.length ? keysWhy(provider, missing) : undefined);
          return { id: provider.id, name: provider.label, keys: provider.keys.map((key) => ({ name: key.name, required: key.required, saved: saved.has(key.name) })), ready: why === undefined, ...(why ? { why } : {}) };
        });
        const offered = kind === "none" || serving.some((provider) => modeRefusal(kind, provider, mode) === undefined);
        const why = offered ? undefined : serving.length ? `no provider of a ${kind} computer can reach this server's run folders` : `no provider serves a ${kind} computer`;
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
    if (!sealKey && Object.values(body).some((value) => value !== null)) throw new KeysRefused([{ field: Object.keys(body)[0]!, reason: "unavailable", message: "this server was given no seal key, so it keeps no key: start it with AGENTRUN_SEAL_KEY" }]);
    for (const [name, value] of Object.entries(body)) {
      if (value === null) await removeSealedKey(store, name);
      else await putSealedKey(store, sealKey!, name, value as string);
    }
    return (await view()).kinds.flatMap((kind) => kind.providers).find((one) => one.id === providerId);
  }

  /** A provider's saved keys, opened from the store, by name. */
  async function keysOf(provider: ProviderEntry): Promise<Record<string, string>> {
    const keys: Record<string, string> = {};
    for (const key of provider.keys) {
      const value = sealKey ? await getSealedKey(store, sealKey, key.name) : undefined;
      if (value !== undefined) keys[key.name] = value;
    }
    return keys;
  }

  /** The account test of a provider with its saved keys: one account-level read, never a create. Undefined for a provider
   *  this server does not have. */
  async function test(providerId: string, signal?: AbortSignal): Promise<TestView | undefined> {
    const provider = providerOf(providerId);
    if (!provider) return undefined;
    const keys = await keysOf(provider);
    const missing = missingKeys(provider, new Set(Object.keys(keys)));
    if (missing.length) return { ok: false, why: keysWhy(provider, missing) };
    const answer = await testConnection(providerId, { keys, ...(signal ? { signal } : {}) });
    return answer.ok ? { ok: true, detail: answer.value.detail } : { ok: false, why: testWhy(provider, answer.error) };
  }

  /** Why a run of an agent whose computer is `computer` cannot have it here, in words naming the setting to fill;
   *  undefined when it can. Checked at the claim: the provider must serve the kind (servingRefusals' words), fit this
   *  server's folder mode, and have every required key saved. */
  async function claimRefusal(computer: ComputerSetting): Promise<string | undefined> {
    if (computer.kind === "none") return undefined;
    const provider = providerOf(computer.provider);
    if (!provider) return `this agent's computer names the provider ${computer.provider}, which this server does not have: set its computer in Settings → Computers`;
    if (!provider.kinds.includes(computer.kind)) {
      const words = [...new Set(provider.capabilities.flatMap((capabilities) => kinds.servingRefusals(capabilities, computer.kind)))];
      return `${provider.label} does not serve a ${computer.kind} computer${words.length ? ` (${words.join("; ")})` : ""}: set this agent's computer to one it serves (Settings → Computers)`;
    }
    const refused = modeRefusal(computer.kind, provider, mode);
    if (refused) return refused;
    const missing = missingKeys(provider, new Set(await sealedKeyNames(store)));
    return missing.length ? keysWhy(provider, missing) : undefined;
  }

  return { view, saveKeys, test, claimRefusal, keysOf };
}

export type ComputerRoutes = ReturnType<typeof createComputerRoutes>;

/** A provider as its create() builds it, as far as the test reads it. */
export interface TestableProvider {
  testConnection?(context?: { signal?: AbortSignal }): Promise<TestResult>;
}

/** The options each provider's create() takes, from its keys by their serve-side names; undefined for a provider whose
 *  create() serve does not build. Docker takes no key; a key not saved is left out, so create() names it. */
export function providerOptionsOf(providerId: string, keys: Readonly<Record<string, string>>): Record<string, string> | undefined {
  const pick = (map: Readonly<Record<string, string>>) => Object.fromEntries(Object.entries(map).flatMap(([name, option]) => (keys[name] === undefined ? [] : [[option, keys[name]]])));
  switch (providerId) {
    case "docker": return {};
    case "daytona": return pick({ DAYTONA_API_KEY: "apiKey", DAYTONA_API_URL: "apiUrl", DAYTONA_TARGET: "target" });
    case "e2b": return pick({ E2B_API_KEY: "apiKey" });
    case "modal": return pick({ MODAL_TOKEN_ID: "tokenId", MODAL_TOKEN_SECRET: "tokenSecret" });
    default: return undefined;
  }
}

/** A message with every key value in it replaced, so no answer carries a key. */
const withoutKeys = (message: string, keys: Readonly<Record<string, string>>): string =>
  Object.values(keys).reduce((text, value) => (value ? text.split(value).join("[key]") : text), message);

/**
 * Serve's TestConnection: the provider's keys mapped by name onto its create() options (providerOptionsOf), with the
 * server's own settings for it (`settings`, such as Modal's app) under them, the provider built by `build` (the computer
 * package's providerFor), and its one account-level read. A provider serve does not build, or one without a test, is
 * refused in words; a create() that throws (a key it refuses) answers refused with its words. No answer carries a key.
 */
export function testConnectionOf(build: (providerId: string, options: object) => Promise<TestableProvider>, settings: Readonly<Record<string, object>> = {}): TestConnection {
  return async (providerId, { keys, signal }) => {
    const mapped = providerOptionsOf(providerId, keys);
    if (!mapped) return { ok: false, error: { code: "unsupported", message: `this server cannot build ${providerId} computers yet, so it cannot test the account` } };
    let provider: TestableProvider;
    try {
      provider = await build(providerId, { ...(settings[providerId] ?? {}), ...mapped });
    } catch (error) {
      return { ok: false, error: { code: "refused", message: withoutKeys(error instanceof Error ? error.message : String(error), keys) } };
    }
    if (!provider.testConnection) return { ok: false, error: { code: "unsupported", message: `${providerId} has no account test yet` } };
    const answer = await provider.testConnection(signal ? { signal } : {});
    return answer.ok ? answer : { ok: false, error: { code: answer.error.code, message: withoutKeys(answer.error.message, keys) } };
  };
}
