import type { SecretMeta, ToolKey } from "@/lib/v2";

/** A test's key, its fields written as the secrets they are (source env | console | sign-in | null, changed_at), as the
 *  server serves it: `fields` in the served form (server | stored), and `secrets` in the settled one, each named
 *  "<kind>:<KEY>" (SECRETS-PLAN "Shared pieces"). */
export type KeyIn = Omit<ToolKey, "fields" | "secrets"> & { fields: (Pick<SecretMeta, "name" | "set" | "source"> & { changed_at?: string | null; stored_unreadable?: true })[] };
const SERVED: Record<string, "server" | "stored"> = { env: "server", console: "stored" };
export const servedKey = (k: KeyIn): ToolKey => ({
  ...k,
  fields: k.fields.map((f) => ({ name: f.name, set: f.set, source: f.source ? SERVED[f.source] ?? null : null, ...(f.stored_unreadable ? { stored_unreadable: true as const } : {}) })),
  secrets: k.fields.map((f) => ({ name: `${k.kind}:${f.name}`, set: f.set, source: f.source, changed_at: f.changed_at ?? null })),
});
