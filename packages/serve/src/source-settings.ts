// A trigger source's settings that are the server's (trigger-adapter.ts `settings`, scope "server"), through one route
// for every such source: GET, PUT and DELETE /v2/settings/sources/{source}, driven by its SettingsSpec. GET shows the
// public fields, and which secret fields are set, never a secret's value. PUT gives the secret fields (each one) and the
// public fields a save may give; the source's own check (trigger-adapter.ts `check`) runs before anything is kept and
// fills the public fields it learns; then the settings are kept whole, in the source's sealed settings, what an earlier
// save kept gone first. DELETE removes them. A source whose settings a flow of its own writes (`managed`) refuses PUT and
// DELETE. So the next source whose settings are the server's is one adapter and one registry line, not one more route.
import { ApiError, invalid } from "./errors.js";
import { type SealedSettings, SERVER_SCOPE } from "./sealed-settings.js";
import type { TriggerAdapter } from "./trigger-adapter.js";
import { SEAL_KEY_ENV } from "./tool-keys.js";
import { type Json, unknownFields } from "./validate.js";

/** The longest value a PUT may give. */
const VALUE_MAX = 512;

/** The source `id` names, if it is one whose settings are the server's; else 404. */
export function serverSettingsOf(adapters: readonly TriggerAdapter[], id: string): TriggerAdapter {
  const adapter = adapters.find((a) => a.id === id);
  if (!adapter?.settings || adapter.settings.scope !== "server") throw new ApiError("not_found", `no trigger source ${id} whose settings are the server's`);
  return adapter;
}

const fieldsOf = (adapter: TriggerAdapter) => Object.entries(adapter.settings!.fields);
const secretFields = (adapter: TriggerAdapter) => fieldsOf(adapter).filter(([, f]) => !f.public && !f.mint).map(([name]) => name);

/** GET: whether every secret field is set, the public fields as they stand, and which secret fields are set. */
export function sourceSettingsView(adapter: TriggerAdapter, store: SealedSettings | undefined) {
  const get = (field: string) => store?.get(SERVER_SCOPE, field);
  const secrets = Object.fromEntries(secretFields(adapter).map((name) => [name, get(name) !== undefined]));
  const values = Object.fromEntries(fieldsOf(adapter).filter(([, f]) => f.public).map(([name]) => [name, get(name) ?? null]));
  return { source: adapter.id, configured: Object.values(secrets).every(Boolean), managed: adapter.settings!.managed ?? null, values, secrets };
}

/** PUT: the secret fields, each one, and the given public fields, checked by the source (its `check`) before anything is
 *  kept, then kept whole. */
export async function saveSourceSettings(adapter: TriggerAdapter, store: SealedSettings | undefined, body: Json, api?: string): Promise<ReturnType<typeof sourceSettingsView>> {
  const spec = adapter.settings!;
  if (spec.managed) throw new ApiError("settings_managed", `The ${adapter.label}'s settings are written by ${spec.managed}, not by this route.`);
  const secrets = secretFields(adapter);
  const given = fieldsOf(adapter).filter(([, f]) => f.public && f.given).map(([name]) => name);
  const issues = unknownFields(body, [...secrets, ...given]);
  const text = (value: unknown) => typeof value === "string" && value.length >= 1 && value.length <= VALUE_MAX;
  for (const name of secrets) if (!text(body[name])) issues.push({ field: name, reason: body[name] === undefined ? "missing" : "wrong_type", message: `${name} is a string of 1 to ${VALUE_MAX} characters` });
  for (const name of given) if (body[name] !== undefined && !text(body[name])) issues.push({ field: name, reason: "wrong_type", message: `${name} is a string of 1 to ${VALUE_MAX} characters` });
  if (issues.length) throw invalid(issues);
  if (!store?.canSeal()) throw new ApiError("no_sealing_key", `This server was handed no seal key (${SEAL_KEY_ENV}), so it keeps no ${adapter.label} secrets: it never keeps one in the clear.`);
  const values = Object.fromEntries([...secrets, ...given].flatMap((name) => (typeof body[name] === "string" ? [[name, body[name] as string]] : [])));
  const learned = (await adapter.check?.(values, api)) ?? {};
  // Kept whole: what an earlier save kept goes first (a field this one leaves out, why posting was off), its secrets
  // still cut from what is shown for as long as the server runs (sealed-settings.ts retired).
  store.remove(SERVER_SCOPE);
  const kept: Record<string, string> = { ...values, ...learned, ...("updated_at" in spec.fields ? { updated_at: new Date().toISOString() } : {}) };
  for (const [field, value] of Object.entries(kept)) if (field in spec.fields) store.set(SERVER_SCOPE, field, value);
  return sourceSettingsView(adapter, store);
}

/** DELETE: the settings gone. */
export function removeSourceSettings(adapter: TriggerAdapter, store: SealedSettings | undefined): void {
  if (adapter.settings!.managed) throw new ApiError("settings_managed", `The ${adapter.label}'s settings are written by ${adapter.settings!.managed}, not by this route.`);
  store?.remove(SERVER_SCOPE);
}
