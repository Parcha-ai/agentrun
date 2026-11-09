// A computer or Archil key as every view shows it: the one shared shape, secret-writes.ts's SecretMeta ({ name, set,
// source, changed_at }) made by its secretMeta, never a value, a prefix, a length or a hash. name is "<plane>:<id>"
// (secret-writes.ts secretName): "computer:<provider>:<KEY>" for a computer provider's key, "workspace:archil" for the Archil account key.
// An object with one secret carries `secret`, one with several `secrets`.
//
// What this module adds is where each key comes from: the server's environment first (a variable named as the key, not
// empty: source "env", no time of its own), else the sealed row the console's save wrote (source "console", changed_at
// the row's own time), else not set. The server's environment is passed in (never process.env read here), so a test gives
// its own.
import { getSealedKey } from "./server-keys.js";
import { type SecretMeta, type SecretSource, secretMeta } from "./secret-writes.js";
import type { Store } from "./store/index.js";

export type { SecretMeta, SecretSource };
/** The same shape, as these key views have named it. */
export type KeyMeta = SecretMeta;
/** The server's environment, as the key routes read it. */
export type KeyEnv = Readonly<Record<string, string | undefined>>;

/** One secret a view shows: its SecretMeta name, the environment variable that sets it, and the sealed-key row it is
 *  kept in. */
export type KeySlot = { readonly secret: string; readonly env: string; readonly row: string };

/** The environment's value for `name`, when it gives one. */
export const envValue = (env: KeyEnv, name: string): string | undefined => {
  const value = Object.hasOwn(env, name) ? env[name] : undefined;
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
};

/** A key's value by its name, as the server reads it: the environment's, else the saved one opened with `sealKey` (none
 *  without a seal key). The one reader Settings → Computers and a run's computer take a provider's keys through (the
 *  claim-time computer composer, workspace/computer-deps.ts). */
export const keyReader = (store: { sealedKeys: Pick<Store["sealedKeys"], "get"> }, sealKey: Buffer | undefined, env: KeyEnv = {}) =>
  async (name: string): Promise<string | undefined> => envValue(env, name) ?? (sealKey ? await getSealedKey(store, sealKey, name) : undefined);

/** Each slot's SecretMeta: from the environment when it names the key, else from the store's sealed-key rows (read once). */
export async function keyMetaOf(store: { sealedKeys: Pick<Store["sealedKeys"], "all"> }, slots: readonly KeySlot[], env: KeyEnv = {}): Promise<SecretMeta[]> {
  const rows = new Map((await store.sealedKeys.all()).map((row) => [row.name, row.updatedAt]));
  return slots.map((slot) => {
    if (envValue(env, slot.env) !== undefined) return secretMeta(slot.secret, { set: true, source: "env", changedAt: null });
    const at = rows.get(slot.row);
    return at === undefined ? secretMeta(slot.secret, { set: false }) : secretMeta(slot.secret, { set: true, source: "console", changedAt: new Date(at) });
  });
}
