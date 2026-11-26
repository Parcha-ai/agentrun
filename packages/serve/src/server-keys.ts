// The server's model, provider and account keys in the one store (store.sealedKeys), each sealed under the server's seal
// key with store/seal.ts's one rule (AAD sealed_keys|<name>|sealed). The store holds only the sealed bytes and never opens
// them; only this process does, when asked, with the seal key the launcher hands it (AGENTRUN_SEAL_KEY). A value that does
// not open (another seal key, or damaged) reads as not set, never a clear fallback, as the file-based tool keys do. The
// store-backed replacement for the tool-keys.json field store; the cut wires it.
import { createHmac } from "node:crypto";
import { sealColumn, sealedAt, type SealedKeys, unsealColumn } from "./store/index.js";

/** Why a saved value does not open: sealed under another seal key (its fingerprint no longer matches), or damaged. */
export const UNREADABLE = ["seal_key_changed", "file_unreadable"] as const;
export type Unreadable = (typeof UNREADABLE)[number];
/** A sealed row opened now, or why not. */
export type Opened = { value: string } | { unreadable: Unreadable };
/** Why a saved harness key (harness-keys.ts) is not one its recipe's runs get, so it is entered again: saved for another
 *  recipe file of its id (`recipe_changed`), bound to none (`not_bound`: saved before keys were bound, or its binding
 *  write was cut off), or one of UNREADABLE. Here, beside UNREADABLE, so the API document reads it without loading the
 *  keys layer. */
export const HARNESS_KEY_REENTER = ["recipe_changed", "not_bound", ...UNREADABLE] as const;

/** The fingerprint of a seal key: an HMAC of a fixed label under it, stable across restarts, so a value whose fingerprint
 *  no longer matches was sealed under another key (seal_key_changed), told apart from one that is simply damaged. No
 *  secret: neither the key nor a hash of it. Kept beside the sealed rows, in a settings row of the layer that writes them. */
export const sealFingerprint = (key: Buffer): string => createHmac("sha256", key).update("agentrun-serve sealed_keys key check").digest("base64url");

/** Opens the sealed bytes of the row `name` now, or why not: a fingerprint kept for it that no longer matches `sealKey`'s
 *  (seal_key_changed); else unseal, which fails as file_unreadable. `fp` undefined: none was kept, so only unseal tells. */
export function openSealed(sealKey: Buffer, name: string, sealed: Uint8Array, fp: string | undefined): Opened {
  if (fp !== undefined && fp !== sealFingerprint(sealKey)) return { unreadable: "seal_key_changed" };
  try {
    return { value: unsealColumn(sealKey, sealedAt.sealedKey(name), sealed).toString("utf8") };
  } catch {
    return { unreadable: "file_unreadable" };
  }
}

/** Saves `value` sealed under `name` (e.g. a model provider's key, or an account key like "archil.api_key"). */
export async function putSealedKey(store: { sealedKeys: Pick<SealedKeys, "put"> }, sealKey: Buffer, name: string, value: string): Promise<void> {
  await store.sealedKeys.put(name, sealColumn(sealKey, sealedAt.sealedKey(name), value));
}

/** The value kept under `name`, opened now: the one saved there that opens under `sealKey`, else `value`, saved so that of
 *  writers racing on the row one's is kept and every one reads it back. A row that does not open (sealed under another
 *  key, or damaged) is replaced only while it holds the bytes read. Undefined only when the row still does not open. */
export async function keepSealedKey(store: { sealedKeys: Pick<SealedKeys, "get" | "putIfAbsent" | "replaceIf"> }, sealKey: Buffer, name: string, value: string): Promise<string | undefined> {
  const was = await store.sealedKeys.get(name);
  const sealed = sealColumn(sealKey, sealedAt.sealedKey(name), value);
  if (was === undefined) await store.sealedKeys.putIfAbsent(name, sealed);
  else if (!("value" in openSealed(sealKey, name, was, undefined))) await store.sealedKeys.replaceIf(name, was, sealed);
  return getSealedKey(store, sealKey, name);
}

/** The value saved under `name`, opened now; undefined with none saved, or one that does not open under this seal key
 *  (sealed under another key, or damaged). Never a value the store could read in the clear. */
export async function getSealedKey(store: { sealedKeys: Pick<SealedKeys, "get"> }, sealKey: Buffer, name: string): Promise<string | undefined> {
  const sealed = await store.sealedKeys.get(name);
  if (sealed === undefined) return undefined;
  const opened = openSealed(sealKey, name, sealed, undefined);
  return "value" in opened ? opened.value : undefined;
}

/** The key's row goes. */
export async function removeSealedKey(store: { sealedKeys: Pick<SealedKeys, "remove"> }, name: string): Promise<void> {
  await store.sealedKeys.remove(name);
}

/** Every saved key's name, for a view that lists which are set (its bytes never opened). */
export async function sealedKeyNames(store: { sealedKeys: Pick<SealedKeys, "all"> }): Promise<string[]> {
  return (await store.sealedKeys.all()).map((row) => row.name);
}

