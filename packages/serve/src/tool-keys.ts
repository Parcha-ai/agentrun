// The keys a person saves for this server's tools and models, by name, through /v2/settings/tool-keys: the rows each key
// is entered as and what it unlocks, the words a re-entry gives, and the seal key's name and reading. The values are kept
// sealed in the one store (tool-keys-store.ts), opened only by the server, never in the clear; a key is checked against
// its provider before it is kept (key-check.ts). The server reads a saved value by name as it reads a launcher's secret
// (secrets.ts' `secret`), the launcher's winning: a run gets it over its claim, never its environment.
import { HARNESSES } from "./harness.js";
import type { KeyCheck } from "./key-check.js";
import { MODEL_KEYS } from "./model.js";
import { TOOL_KEY_ROWS } from "./key-words.js";
import { registerSecretWrite, type SecretMeta, secretMeta, secretName } from "./secret-writes.js";

// Every value a person saves here is a secret (a tool's key, a model provider's key; BROWSERBASE_PROJECT_ID is kept the
// same way): saving one, replacing it or removing it takes the owner's session (secret-writes.ts), never the token.
registerSecretWrite("saveToolKey", () => true);
registerSecretWrite("deleteToolKey", () => true);

export const SEAL_KEY_ENV = "AGENTRUN_SEAL_KEY";

/** Each key a person may save, fixed here: its kind, the fields it is entered as (BROWSERBASE_PROJECT_ID is no secret,
 *  and is kept the same way), and what it may unlock: tools by name, and `decisions.<id>`, a workflow's decision
 *  provider. GET lists only those this server binds (unlockedBy), so a name here the server does not bind is never
 *  promised, and one shows by itself once the server binds it. A `tool` key's fields reach only the runs that name a
 *  tool it unlocks (runs.ts' secretsFor); a key of any other kind (a model's) reaches every run. The tool rows live in
 *  key-words.ts (TOOL_KEY_ROWS), whose words name this page where a key is not set. */
export const TOOL_KEYS = [
  ...TOOL_KEY_ROWS,
  // A model provider's key (model.ts' MODEL_KEYS, which give each its default model): every run gets it, as the
  // launcher's model keys reach every run. Its harnesses are pi and those that talk to the provider's API (MODEL_KEYS).
  ...MODEL_KEYS.map(({ id, label, field, harnesses }) => ({ id, kind: "model" as const, label, fields: [field] as const, unlocks: [] as const, harnesses })),
] as const;
/** The fields of the `tool` rows: keys a tool or a decision provider reads, and no harness (the harnesses read their
 *  packages, their pins and their models' keys). A row of another kind (a model's) is outside them. */
export const TOOL_FIELDS: readonly string[] = TOOL_KEYS.filter((row) => row.kind === "tool").flatMap((row) => row.fields);

/** What `candidates` unlock here, as capabilities show it: the tools of `tools` (capabilities' `tools`, available or
 *  not) and the providers of `providers` (its `workflows.decisions.providers`) named among them, and the harnesses
 *  that run those tools. A name neither holds is left out; a key that unlocks none of its names lists nothing. */
export function unlockedBy(candidates: readonly string[], tools: readonly { name: string; harnesses: readonly string[] }[], providers: readonly { id: string }[]) {
  const bound = new Set([...tools.map((tool) => tool.name), ...providers.map((provider) => `decisions.${provider.id}`)]);
  const unlocks = candidates.filter((name) => bound.has(name));
  const run = new Set(tools.filter((tool) => unlocks.includes(tool.name)).flatMap((tool) => tool.harnesses));
  return { unlocks, harnesses: HARNESSES.filter((harness) => run.has(harness)) };
}

/** What a row unlocks here: a `tool` row's, its tools and providers as capabilities bind them (unlockedBy); any other
 *  kind's (a model's), no tool, on those that run on it (its `harnesses`, when it names them) that this server runs
 *  (`offers`, harness.ts' harnessOffers) on the row's key: one whose `keys` (the model keys that run it here, available
 *  now or once one is saved) include the row's (its first field). So OpenRouter's row names all three before any key
 *  is saved, and no row changes when another provider's key is saved; a harness not installed, off its pins or too big
 *  for this host is left out. */
export function rowUnlocks(row: { kind: string; unlocks: readonly string[]; harnesses?: readonly string[]; fields?: readonly string[] }, tools: Parameters<typeof unlockedBy>[1], providers: Parameters<typeof unlockedBy>[2], offers: readonly { id: string; available: boolean; keys?: readonly string[] }[]) {
  if (row.kind === "tool") return unlockedBy(row.unlocks, tools, providers);
  const key = row.fields?.[0];
  // Where an offer knows which model keys run it (its `keys`), the row's key must be one of them, available now or not;
  // else (no key runs it: pi on any, or one unavailable for another reason) whether it runs here now.
  const runs = (harness: string) => offers.some((offer) => offer.id === harness && (offer.keys ? key !== undefined && offer.keys.includes(key) : offer.available));
  return { unlocks: [] as string[], harnesses: HARNESSES.filter((harness) => (row.harnesses ?? HARNESSES).includes(harness) && runs(harness)) };
}

/** The key that unlocks the tool `name` (capabilities' `tools[].key`, so a page links "needs the X key" to it), if any. */
export const keyOf = (name: string): string | undefined => TOOL_KEYS.find((row) => (row.unlocks as readonly string[]).includes(name))?.id;

/** Why a stored value does not open, in the order a re-entry names one: sealed under another key than the server's, or
 *  its row damaged. */
export const UNREADABLE = ["seal_key_changed", "file_unreadable"] as const;

/** The check of a key the server was started with (tool-keys-store.ts checkServer): a KeyCheck, or refused by its provider, why in
 *  plain words. Held in memory only, for this start. */
export type StartCheck = KeyCheck | { state: "refused"; reason: string; at: string };

/** A key row's secrets as every secret's view says them (secret-writes.ts SecretMeta): one per field, named
 *  "<kind>:<FIELD>" (tool:MONID_API_KEY, model:OPENROUTER_API_KEY); source env when the server is started with it, console
 *  when the owner saved it; `changedAt` the time that field's own value was saved (its own row in the store, its own entry
 *  in the file), null when not known. */
export function rowSecrets(row: { kind: "tool" | "model" }, fields: readonly { name: string; set: boolean; source: "server" | "stored" | null }[], changedAt: (name: string) => string | null): SecretMeta[] {
  return fields.map((field) => secretMeta(secretName(row.kind, field.name), {
    set: field.set,
    ...(field.source === "server" ? { source: "env" as const } : field.source === "stored" ? { source: "console" as const, changedAt: changedAt(field.name) } : {}),
  }));
}

/** The seal key `text` gives: 32 bytes in base64 (or base64url), else none. */
export function sealKeyOf(text: string | undefined): Buffer | undefined {
  const trimmed = text?.trim() ?? "";
  return /^[A-Za-z0-9+/_-]{43}=?$/.test(trimmed) ? Buffer.from(trimmed, "base64") : undefined;
}
