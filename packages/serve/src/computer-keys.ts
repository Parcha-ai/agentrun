// Settings → Computers' keys, serve side: a provider's saved keys, by the names its descriptor declares (the computer
// package's PROVIDERS, derived from each provider's descriptor), as that provider's create() options, and Settings' "test
// connection" over them (the registry's TestConnection: one account-level read that never makes a computer), its coded
// errors in plain words.
//
// Serve knows no vendor here: each key's name and the option it fills, each setting that is no key (its name in the
// server's settings, its option and its default), and each provider's label all come from the descriptor. A name a
// provider does not declare is never passed on; an empty optional key is left out; a required one not saved refuses in
// words naming what to save, before anything is made. The provider modules themselves (each one's create()) are passed
// in: a provider with no module here answers that its test is not available. No key is ever in an answer: each value is
// scrubbed from the provider's words, and the words this module adds name keys only by their names.
import { PROVIDERS, type ProviderEntry } from "@parcha/agentrun-computer";

/** One key a provider takes: its name in its descriptor, the create() option it fills, and whether it is needed. */
export interface ProviderKey {
  readonly name: string;
  readonly option: string;
  readonly required: boolean;
}

/** A setting that is no key but fills a create() option: its name in the server's settings, and its default. */
export interface ProviderSetting {
  readonly name: string;
  readonly option: string;
  readonly default?: string;
}

/** The server's settings that are no key, by their names in the descriptors (modalApp): what fills each setting. */
export type ProviderSettings = Readonly<Record<string, string | undefined>>;

/** An answer in the registry's shape: a value, or an error with its code and words. */
export type KeyResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
/** The options answer: `options`, or why there are none. */
export type OptionsAnswer = { ok: true; options: Record<string, string> } | { ok: false; error: { code: string; message: string } };
/** testConnection's answer: the registry's own (TestConnection's Result<{ detail }>). */
export type TestAnswer = KeyResult<{ detail: string }>;

/** A provider as testConnection uses it: its one account-level read. */
export interface TestableProvider {
  testConnection?(context?: { signal?: AbortSignal }): Promise<KeyResult<{ detail: string }>>;
}
/** A provider module's create(), by provider id: the computer package's, or a test's stand-in. */
export type ProviderFactories = Readonly<Partial<Record<string, (options: Record<string, string>) => TestableProvider | Promise<TestableProvider>>>>;

/** The table the map reads: each provider's keys, settings and name in words, by id. Serve's own (KEY_TABLE, the
 *  computer package's descriptors), or --faux's (keyTableOf its entries). */
export interface KeyTable {
  readonly keys: Readonly<Record<string, readonly ProviderKey[]>>;
  readonly labels: Readonly<Record<string, string>>;
  readonly settings?: Readonly<Record<string, readonly ProviderSetting[]>>;
}

/** The key table of `entries` (the kind registry's PROVIDERS, each from its descriptor). */
export function keyTableOf(entries: readonly Pick<ProviderEntry, "id" | "label" | "keys" | "settings">[]): KeyTable {
  return {
    keys: Object.fromEntries(entries.map((entry) => [entry.id, entry.keys.map(({ name, option, required }) => ({ name, option, required }))])),
    labels: Object.fromEntries(entries.map((entry) => [entry.id, entry.label])),
    settings: Object.fromEntries(entries.map((entry) => [entry.id, (entry.settings ?? []).map(({ name, option, default: fallback }) => ({ name, option, ...(fallback === undefined ? {} : { default: fallback }) }))])),
  };
}

/** Serve's table: every provider the computer package declares. */
export const KEY_TABLE: KeyTable = keyTableOf(PROVIDERS);

const has = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);
const labelOf = (providerId: string, table: KeyTable): string => (has(table.labels, providerId) ? table.labels[providerId]! : providerId);
const refused = (code: string, message: string): { ok: false; error: { code: string; message: string } } => ({ ok: false, error: { code, message } });

/**
 * Provider `providerId`'s create() options from its saved keys (by its descriptor's names) and the server's settings
 * (each of its descriptor's settings, by name, else its default). A provider the table does not list takes no keys and
 * no settings: it is not refused here, and whether it can be made is its maker's to say.
 */
export function providerOptions(providerId: string, keys: Readonly<Record<string, string>>, settings: ProviderSettings = {}, table: KeyTable = KEY_TABLE): OptionsAnswer {
  const label = labelOf(providerId, table);
  const options: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of has(table.keys, providerId) ? table.keys[providerId]! : []) {
    const value = has(keys, key.name) ? keys[key.name] : undefined;
    if (typeof value === "string" && value.trim() !== "") options[key.option] = value;
    else if (key.required) missing.push(key.name);
  }
  if (missing.length > 0) {
    return refused("missing_key", `${label} needs ${missing.join(" and ")} saved: save ${missing.length > 1 ? "them" : "it"} in Settings → Computers (PUT /v2/computers/${providerId}/keys)`);
  }
  for (const setting of table.settings && has(table.settings, providerId) ? table.settings[providerId]! : []) {
    const given = has(settings, setting.name) ? settings[setting.name]?.trim() : undefined;
    const value = given || setting.default;
    if (value !== undefined && value !== "") options[setting.option] = value;
  }
  return { ok: true, options };
}

/** `text` with every key value in `values` replaced by "[the key]". */
function scrub(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) if (value.length >= 4) out = out.split(value).join("[the key]");
  return out;
}

/** A coded error of a provider's test in plain words: what happened, what to do, and the vendor's own words after. */
function wordsFor(code: string, providerId: string, said: string, table: KeyTable): string {
  const label = labelOf(providerId, table);
  const names = (table.keys[providerId] ?? []).filter((key) => key.required).map((key) => key.name).join(" and ");
  const vendor = said.trim() === "" ? "" : ` (the vendor said: ${said.trim()})`;
  switch (code) {
    case "unauthorized":
      return `${label} refused the saved key: check ${names || "its keys"} in Settings → Computers.${vendor}`;
    case "unreachable":
    case "timeout":
      return `${label} could not be reached: try again in a moment.${vendor}`;
    case "aborted":
      return `The test of ${label} was cancelled.`;
    case "refused":
    case "denied":
      return `${label} refused the request.${vendor}`;
    case "limit":
      return `${label} says the account is at a limit.${vendor}`;
    case "invalid":
      return `${label}'s settings are not valid.${vendor}`;
    case "unsupported":
      return `${label} can't be tested here.${vendor}`;
    // The one code for a vendor's own error (ComputerErrorCode "vendor"), whatever the vendor.
    case "vendor":
      return `${label} answered with an error.${vendor}`;
    default:
      return `The test of ${label} failed.${vendor}`;
  }
}

const messageOf = (error: unknown): string => String((error as Error)?.message ?? error).replace(/\s+/g, " ").slice(0, 500);

/**
 * Settings' "test connection" for `providerId` (the kind registry's TestConnection, and serve's ComputerRegistry.test):
 * the provider made from its saved keys by its module's create(), then its one account-level read. ok with the
 * provider's words on what it read; else its code kept and the words plain. Nothing is made when a required key is
 * missing or the provider has no module here.
 */
export async function testConnection(
  providerId: string,
  { keys, signal }: { keys: Readonly<Record<string, string>>; signal?: AbortSignal },
  factories: ProviderFactories,
  settings: ProviderSettings = {},
  table: KeyTable = KEY_TABLE,
): Promise<TestAnswer> {
  const made = providerOptions(providerId, keys, settings, table);
  if (!made.ok) return made;
  const label = labelOf(providerId, table);
  const values = Object.values(keys).filter((value): value is string => typeof value === "string");
  const create = has(factories, providerId) ? factories[providerId] : undefined;
  if (typeof create !== "function") return refused("unsupported", `${label}'s connection test isn't available on this server yet.`);
  let provider: TestableProvider;
  try {
    provider = await create(made.options);
  } catch (error) {
    return refused("invalid", wordsFor("invalid", providerId, scrub(messageOf(error), values), table));
  }
  if (typeof provider?.testConnection !== "function") return refused("unsupported", `${label}'s connection test isn't available on this server yet.`);
  let answer: KeyResult<{ detail: string }>;
  try {
    answer = await provider.testConnection(signal ? { signal } : {});
  } catch (error) {
    return refused("unreachable", wordsFor("unreachable", providerId, scrub(messageOf(error), values), table));
  }
  if (answer?.ok === true) return { ok: true, value: { detail: scrub(String(answer.value?.detail ?? ""), values) } };
  const code = typeof answer?.error?.code === "string" ? answer.error.code : "error";
  return refused(code, wordsFor(code, providerId, scrub(String(answer?.error?.message ?? ""), values), table));
}
