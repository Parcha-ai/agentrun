// A secret as every view shows it (the shared shape): its name, whether it is set, where it came from and when it last
// changed; never a value, a prefix, a length or a hash. source is "console" for a value saved through the server's own
// routes (sealed in the store), "env" for one the server's environment gives, "sign-in" for one an OAuth sign-in or a
// Connect obtained, and null when it is not set. changed_at is the credential's own time: when its sealed row was last
// written; null when it is not set, or comes from the environment.
import type { Store } from "./store/index.js";

export type SecretSource = "env" | "console" | "sign-in" | null;
export type KeyMeta = { name: string; set: boolean; source: SecretSource; changed_at: string | null };

/** One secret a view shows: its name in the API, and the sealed-key row it is kept in. */
export type KeySlot = { readonly name: string; readonly row: string };

/** Each slot's metadata, from the store's sealed-key rows (read once for all of them). */
export async function keyMetaOf(store: { sealedKeys: Pick<Store["sealedKeys"], "all"> }, slots: readonly KeySlot[]): Promise<KeyMeta[]> {
  const rows = new Map((await store.sealedKeys.all()).map((row) => [row.name, row.updatedAt]));
  return slots.map((slot) => {
    const at = rows.get(slot.row);
    return at === undefined ? { name: slot.name, set: false, source: null, changed_at: null } : { name: slot.name, set: true, source: "console", changed_at: new Date(at).toISOString() };
  });
}
