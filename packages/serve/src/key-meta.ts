// A secret as every view shows it (the shared shape): its name, whether it is set, where it came from and when it last
// changed; never a value, a prefix, a length or a hash. source is "console" for a value saved through the server's own
// routes (sealed in the store), "env" for one the server's environment gives, "sign-in" for one an OAuth sign-in or a
// Connect obtained, and null when it is not set. changed_at is the credential's own time: when its sealed row was last
// written; null when it is not set, or comes from the environment.
//
// The environment wins: a variable named as the key, and not empty, is the key's value, over a saved one (source "env").
// The server's environment is passed in (never process.env read here), so a test gives its own.
import { getSealedKey } from "./server-keys.js";
import type { Store } from "./store/index.js";

export type SecretSource = "env" | "console" | "sign-in" | null;
export type KeyMeta = { name: string; set: boolean; source: SecretSource; changed_at: string | null };
/** The server's environment, as the key routes read it. */
export type KeyEnv = Readonly<Record<string, string | undefined>>;

/** One secret a view shows: its name in the API (and the environment variable that sets it), and the sealed-key row it
 *  is kept in. */
export type KeySlot = { readonly name: string; readonly row: string };

/** The environment's value for `name`, when it gives one. */
export const envValue = (env: KeyEnv, name: string): string | undefined => {
  const value = Object.hasOwn(env, name) ? env[name] : undefined;
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
};

/** A key's value by its name, as the server reads it: the environment's, else the saved one opened with `sealKey` (none
 *  without a seal key). The one reader Settings → Computers and a run's computer take a provider's keys through. */
export const keyReader = (store: { sealedKeys: Pick<Store["sealedKeys"], "get"> }, sealKey: Buffer | undefined, env: KeyEnv = {}) =>
  async (name: string): Promise<string | undefined> => envValue(env, name) ?? (sealKey ? await getSealedKey(store, sealKey, name) : undefined);

/** Each slot's metadata: from the environment when it names the key, else from the store's sealed-key rows (read once). */
export async function keyMetaOf(store: { sealedKeys: Pick<Store["sealedKeys"], "all"> }, slots: readonly KeySlot[], env: KeyEnv = {}): Promise<KeyMeta[]> {
  const rows = new Map((await store.sealedKeys.all()).map((row) => [row.name, row.updatedAt]));
  return slots.map((slot) => {
    if (envValue(env, slot.name) !== undefined) return { name: slot.name, set: true, source: "env", changed_at: null };
    const at = rows.get(slot.row);
    return at === undefined ? { name: slot.name, set: false, source: null, changed_at: null } : { name: slot.name, set: true, source: "console", changed_at: new Date(at).toISOString() };
  });
}
