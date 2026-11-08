// Settings → Computers' keys, serve side: a provider's saved keys, by the names the computer package's kind registry
// declares for it (kinds.ts PROVIDERS), as that provider's create() options, and Settings' "test connection" over them
// (the registry's TestConnection: one account-level read that never makes a computer), its coded errors in plain words.
//
// The map from a key's name to the option it fills is serve's, and lives here: E2B_API_KEY is E2B's apiKey, the Modal
// token pair is the Modal client's tokenId and tokenSecret, and so on. A name a provider does not declare is never passed
// on; an empty optional key is left out; a required one not saved refuses in words naming what to save, before anything
// is made. The provider modules themselves (each one's create()) are passed in, as the rest of the computer package is
// until the cutover makes it serve's dependency: a provider with no module here answers that its test is not available.
// No key is ever in an answer: each value is scrubbed from the provider's words, and the words this module adds name keys
// only by their names.

/** One key a provider takes: its name in the kind registry, the create() option it fills, and whether it is needed. */
export interface ProviderKey {
  readonly name: string;
  readonly option: string;
  readonly required: boolean;
}

/** Each provider's keys, by the registry's names, and the option each fills. Docker takes none (its host is local). */
export const PROVIDER_KEYS: Readonly<Record<string, readonly ProviderKey[]>> = {
  docker: [],
  daytona: [
    { name: "DAYTONA_API_KEY", option: "apiKey", required: true },
    { name: "DAYTONA_API_URL", option: "apiUrl", required: false },
    { name: "DAYTONA_TARGET", option: "target", required: false },
  ],
  modal: [
    { name: "MODAL_TOKEN_ID", option: "tokenId", required: true },
    { name: "MODAL_TOKEN_SECRET", option: "tokenSecret", required: true },
  ],
  e2b: [{ name: "E2B_API_KEY", option: "apiKey", required: true }],
  orgo: [{ name: "ORGO_API_KEY", option: "apiKey", required: true }],
  "phone-harness": [{ name: "PHONE_HARNESS_API_KEY", option: "apiKey", required: true }],
  browserbase: [
    { name: "BROWSERBASE_API_KEY", option: "apiKey", required: true },
    { name: "BROWSERBASE_PROJECT_ID", option: "projectId", required: true },
  ],
  kernel: [{ name: "KERNEL_API_KEY", option: "apiKey", required: true }],
};

/** Each provider's name in words (the registry's labels). */
const LABELS: Readonly<Record<string, string>> = {
  docker: "Docker",
  daytona: "Daytona",
  modal: "Modal",
  e2b: "E2B",
  orgo: "Orgo",
  "phone-harness": "Phone harness",
  browserbase: "Browserbase",
  kernel: "Kernel",
};

/** The Modal app a server's computers live in when its settings name none (serve's box app until now). */
export const DEFAULT_MODAL_APP = "agentrun";

/** Settings that are no key but go to a provider's options: the Modal app. */
export interface ProviderSettings {
  readonly modalApp?: string;
}

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

const has = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);
const labelOf = (providerId: string): string => (has(LABELS, providerId) ? LABELS[providerId]! : providerId);
const refused = (code: string, message: string): { ok: false; error: { code: string; message: string } } => ({ ok: false, error: { code, message } });

/** Provider `providerId`'s create() options from its saved keys (by the registry's names) and the server's settings. */
export function providerOptions(providerId: string, keys: Readonly<Record<string, string>>, settings: ProviderSettings = {}): OptionsAnswer {
  if (!has(PROVIDER_KEYS, providerId)) return refused("unsupported", `${providerId} is not a computer provider: ${Object.keys(PROVIDER_KEYS).join(", ")}`);
  const label = labelOf(providerId);
  const options: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of PROVIDER_KEYS[providerId]!) {
    const value = has(keys, key.name) ? keys[key.name] : undefined;
    if (typeof value === "string" && value.trim() !== "") options[key.option] = value;
    else if (key.required) missing.push(key.name);
  }
  if (missing.length > 0) {
    return refused("missing_key", `${label} needs ${missing.join(" and ")} saved: save ${missing.length > 1 ? "them" : "it"} in Settings → Computers (PUT /v2/computers/${providerId}/keys)`);
  }
  if (providerId === "modal") options.app = settings.modalApp?.trim() || DEFAULT_MODAL_APP;
  return { ok: true, options };
}

/** `text` with every key value in `values` replaced by "[the key]". */
function scrub(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) if (value.length >= 4) out = out.split(value).join("[the key]");
  return out;
}

/** A coded error of a provider's test in plain words: what happened, what to do, and the vendor's own words after. */
function wordsFor(code: string, providerId: string, said: string): string {
  const label = labelOf(providerId);
  const names = (PROVIDER_KEYS[providerId] ?? []).filter((key) => key.required).map((key) => key.name).join(" and ");
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
    case "docker":
    case "daytona":
    case "modal":
    case "e2b":
    case "orgo":
    case "phone":
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
): Promise<TestAnswer> {
  const made = providerOptions(providerId, keys, settings);
  if (!made.ok) return made;
  const label = labelOf(providerId);
  const values = Object.values(keys).filter((value): value is string => typeof value === "string");
  const create = has(factories, providerId) ? factories[providerId] : undefined;
  if (typeof create !== "function") return refused("unsupported", `${label}'s connection test isn't available on this server yet.`);
  let provider: TestableProvider;
  try {
    provider = await create(made.options);
  } catch (error) {
    return refused("invalid", wordsFor("invalid", providerId, scrub(messageOf(error), values)));
  }
  if (typeof provider?.testConnection !== "function") return refused("unsupported", `${label}'s connection test isn't available on this server yet.`);
  let answer: KeyResult<{ detail: string }>;
  try {
    answer = await provider.testConnection(signal ? { signal } : {});
  } catch (error) {
    return refused("unreachable", wordsFor("unreachable", providerId, scrub(messageOf(error), values)));
  }
  if (answer?.ok === true) return { ok: true, value: { detail: scrub(String(answer.value?.detail ?? ""), values) } };
  const code = typeof answer?.error?.code === "string" ? answer.error.code : "error";
  return refused(code, wordsFor(code, providerId, scrub(String(answer?.error?.message ?? ""), values)));
}
