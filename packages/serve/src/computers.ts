// Settings → Computers, the serve side: which computers this server offers, each provider's keys (saved or not, never a
// value), saving a provider's keys sealed in the store, testing a provider's account, and the refusals a run meets when
// its agent's computer cannot be had here. The kinds and providers come from the computer package's kind registry
// (SETTING_KINDS, PROVIDERS, testConnection), passed in; the tools each kind brings from the kernel's tool registry
// (capabilityToolDefs). Keys go by their names only: a provider declares them, Settings takes only those, and the store
// keeps each sealed under the server's seal key (server-keys.ts); a provider reads its keys only at the claim.
import { COMPUTER_KINDS, type ComputerKind, type ComputerSetting } from "./computer-setting.js";
import { getSealedKey, putSealedKey, removeSealedKey, sealedKeyNames } from "./server-keys.js";
import type { SealedKeys } from "./store/index.js";

/** A kind of computer as the kind registry gives it: the capability groups it needs, and those it brings when declared. */
export interface KindSpec {
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

/** A provider as the kind registry gives it (computer package kinds.ts ProviderEntry). */
export interface ProviderEntry {
  readonly id: string;
  readonly label: string;
  readonly kinds: readonly ComputerKind[];
  readonly keys: readonly { readonly name: string; readonly required: boolean }[];
  /** The mounts its computers take; none means it cannot mount the run's folder. */
  readonly mounts: readonly string[];
  readonly metered: boolean;
}

/** An account check's answer, as the kind registry's testConnection gives it. */
export type TestAnswer = { ok: true; value: { detail: string } } | { ok: false; error: { code: string; message: string } };

/** What this module reads from the kind registry and the tool registry. */
export interface ComputerRegistry {
  readonly kinds: Readonly<Record<ComputerKind, KindSpec>>;
  readonly providers: readonly ProviderEntry[];
  /** One account-level read, never a create (so it never spends). */
  test(providerId: string, options: { keys: Readonly<Record<string, string>>; signal?: AbortSignal }): Promise<TestAnswer>;
  /** The model-visible tools a kind brings (the kernel registry's capabilityToolDefs), by name. */
  tools(kind: ComputerKind): readonly string[];
}

/** Where the run's folder lives: on this machine (Mode 1), or on the owner's disk (Mode 2). */
export type FolderMode = "local" | "disk";

/** The store the keys are saved in, and the server's seal key (absent: keys cannot be saved here). */
export interface ComputerKeys {
  readonly store: { sealedKeys: SealedKeys };
  readonly sealKey: Buffer | undefined;
}

/** A provider's key, as Settings shows it. */
export type KeyView = { name: string; required: boolean; saved: boolean };
export type ProviderView = { id: string; name: string; keys: KeyView[]; ready: boolean; why?: string };
export type KindView = { kind: ComputerKind; offered: boolean; why?: string; groups: string[]; tools: string[]; providers: ProviderView[] };

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

/** Settings → Computers: each kind, whether this server offers it and why not, the capability groups and tools it brings,
 *  and each provider that serves it, with its keys (saved or not, never a value) and whether a run could have it now. */
export async function computersView(registry: ComputerRegistry, keys: ComputerKeys, mode: FolderMode): Promise<{ kinds: KindView[] }> {
  const saved = new Set(await sealedKeyNames(keys.store));
  const kinds = COMPUTER_KINDS.map((kind): KindView => {
    const spec = registry.kinds[kind];
    const providers = registry.providers.filter((provider) => provider.kinds.includes(kind)).map((provider): ProviderView => {
      const missing = missingKeys(provider, saved);
      const why = modeRefusal(kind, provider, mode) ?? (missing.length ? keysWhy(provider, missing) : undefined);
      return { id: provider.id, name: provider.label, keys: provider.keys.map((key) => ({ name: key.name, required: key.required, saved: saved.has(key.name) })), ready: why === undefined, ...(why ? { why } : {}) };
    });
    const offered = kind === "none" || providers.some((provider) => modeRefusal(kind, registry.providers.find((one) => one.id === provider.id)!, mode) === undefined);
    return { kind, offered, ...(offered ? {} : { why: providers.length ? `no provider of a ${kind} computer can serve this server's run folders here` : `no provider serves a ${kind} computer` }), groups: [...spec.required, ...spec.optional], tools: [...registry.tools(kind)], providers };
  });
  return { kinds };
}

/** Why a key save is refused, before anything is saved: a name `provider` does not declare, or a value that is not text. */
export class KeysRefused extends Error {
  readonly fields: { field: string; reason: string; message: string }[];
  constructor(fields: { field: string; reason: string; message: string }[]) {
    super(fields.map((field) => field.message).join("; "));
    this.name = "KeysRefused";
    this.fields = fields;
  }
}

/** Saves `body`'s keys for `provider`, each sealed in the store under its declared name; null removes one. Only names the
 *  provider declares are taken, and nothing is saved when any is refused. The answer is the provider's view: names and
 *  whether each is saved, never a value. */
export async function saveProviderKeys(registry: ComputerRegistry, keys: ComputerKeys, mode: FolderMode, providerId: string, body: Readonly<Record<string, unknown>>): Promise<ProviderView | undefined> {
  const provider = registry.providers.find((one) => one.id === providerId);
  if (!provider) return undefined;
  const declared = new Set(provider.keys.map((key) => key.name));
  const refused = Object.entries(body).flatMap(([name, value]) =>
    !declared.has(name) ? [{ field: name, reason: "not_allowed", message: `${provider.label} takes ${[...declared].join(", ") || "no keys"}, not ${name}` }]
      : value !== null && (typeof value !== "string" || value === "") ? [{ field: name, reason: "wrong_type", message: `${name} is a non-empty string, or null to remove it` }] : []);
  if (refused.length) throw new KeysRefused(refused);
  if (!keys.sealKey && Object.values(body).some((value) => value !== null)) throw new KeysRefused([{ field: Object.keys(body)[0]!, reason: "unavailable", message: "this server was given no seal key, so it keeps no key: start it with AGENTRUN_SEAL_KEY" }]);
  for (const [name, value] of Object.entries(body)) {
    if (value === null) await removeSealedKey(keys.store, name);
    else await putSealedKey(keys.store, keys.sealKey!, name, value as string);
  }
  return (await computersView(registry, keys, mode)).kinds.flatMap((kind) => kind.providers).find((one) => one.id === providerId);
}

/** The account check of `provider` with its saved keys: one account-level read, never a create. */
export async function testProvider(registry: ComputerRegistry, keys: ComputerKeys, providerId: string, signal?: AbortSignal): Promise<{ ok: true; detail: string } | { ok: false; why: string } | undefined> {
  const provider = registry.providers.find((one) => one.id === providerId);
  if (!provider) return undefined;
  const values: Record<string, string> = {};
  for (const key of provider.keys) {
    const value = keys.sealKey ? await getSealedKey(keys.store, keys.sealKey, key.name) : undefined;
    if (value !== undefined) values[key.name] = value;
  }
  const missing = missingKeys(provider, new Set(Object.keys(values)));
  if (missing.length) return { ok: false, why: keysWhy(provider, missing) };
  const answer = await registry.test(providerId, { keys: values, ...(signal ? { signal } : {}) });
  return answer.ok ? { ok: true, detail: answer.value.detail } : { ok: false, why: answer.error.message };
}

/** Why a run of an agent whose computer is `computer` cannot have it here, in words naming the setting to fill; undefined
 *  when it can. Checked at the claim: the provider must serve the kind, fit this server's folder mode, and have every
 *  required key saved. */
export async function claimRefusal(registry: ComputerRegistry, keys: ComputerKeys, mode: FolderMode, computer: ComputerSetting): Promise<string | undefined> {
  if (computer.kind === "none") return undefined;
  const provider = registry.providers.find((one) => one.id === computer.provider);
  if (!provider) return `this agent's computer names the provider ${computer.provider}, which this server does not have: set its computer in Settings → Computers`;
  if (!provider.kinds.includes(computer.kind)) return `${provider.label} does not serve a ${computer.kind} computer: set this agent's computer to one it serves (Settings → Computers)`;
  const refused = modeRefusal(computer.kind, provider, mode);
  if (refused) return refused;
  const missing = missingKeys(provider, new Set(await sealedKeyNames(keys.store)));
  return missing.length ? keysWhy(provider, missing) : undefined;
}

/** A run's failure code when its computer cannot be had. */
export const COMPUTER_UNAVAILABLE = "computer_unavailable";
