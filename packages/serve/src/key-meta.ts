// A secret as every view shows it, SecretMeta: { name, set, source, changed_at } and nothing else; never a value, a
// prefix, a length or a hash. name is "<plane>:<id>" (secretName): "computer:<provider>:<KEY>" for a computer provider's
// key, "workspace:archil" for the Archil account key. source is "console" for a value saved through the server's own
// routes (sealed in the store), "env" for one the server's environment gives, "sign-in" for one an OAuth sign-in or a
// Connect obtained, and null when it is not set. changed_at is the credential's own time: when its sealed row was last
// written; null when it is not set, or comes from the environment. An object with one secret carries `secret`, one with
// several `secrets`.
//
// The environment wins: a variable named as the key, and not empty, is the key's value, over a saved one (source "env").
// The server's environment is passed in (never process.env read here), so a test gives its own.
//
// tl-tools' secret-writes.ts (secretMeta, secretName) is the one shape for every plane; this module names its secrets the
// same way and swaps to those functions once secret-writes.ts is on this branch's base.
import type { Store } from "./store/index.js";

export type SecretSource = "env" | "console" | "sign-in" | null;
export type SecretMeta = { name: string; set: boolean; source: SecretSource; changed_at: string | null };
/** The same shape, as these key views have named it. */
export type KeyMeta = SecretMeta;
/** The server's environment, as the key routes read it. */
export type KeyEnv = Readonly<Record<string, string | undefined>>;

/** A secret's name: its plane, then its ids, joined by ":" ("computer:e2b:E2B_API_KEY", "workspace:archil"). */
export const secretName = (plane: string, ...id: readonly string[]): string => [plane, ...id].join(":");

/** One secret a view shows: its SecretMeta name, the environment variable that sets it, and the sealed-key row it is
 *  kept in. */
export type KeySlot = { readonly secret: string; readonly env: string; readonly row: string };

/** The environment's value for `name`, when it gives one. */
export const envValue = (env: KeyEnv, name: string): string | undefined => {
  const value = Object.hasOwn(env, name) ? env[name] : undefined;
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
};

/** Each slot's SecretMeta: from the environment when it names the key, else from the store's sealed-key rows (read once). */
export async function keyMetaOf(store: { sealedKeys: Pick<Store["sealedKeys"], "all"> }, slots: readonly KeySlot[], env: KeyEnv = {}): Promise<SecretMeta[]> {
  const rows = new Map((await store.sealedKeys.all()).map((row) => [row.name, row.updatedAt]));
  return slots.map((slot) => {
    if (envValue(env, slot.env) !== undefined) return { name: slot.secret, set: true, source: "env", changed_at: null };
    const at = rows.get(slot.row);
    return at === undefined ? { name: slot.secret, set: false, source: null, changed_at: null } : { name: slot.secret, set: true, source: "console", changed_at: new Date(at).toISOString() };
  });
}
