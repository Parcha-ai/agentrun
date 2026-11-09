// The server's model, provider and account keys in the one store (store.sealedKeys), each sealed under the server's seal
// key with store/seal.ts's one rule (AAD sealed_keys|<name>|sealed). The store holds only the sealed bytes and never opens
// them; only this process does, when asked, with the seal key the launcher hands it (AGENTRUN_SEAL_KEY). A value that does
// not open (another seal key, or damaged) reads as not set, never a clear fallback, as the file-based tool keys do. The
// store-backed replacement for the tool-keys.json field store; the cut wires it.
import { sealColumn, sealedAt, type SealedKeys, unsealColumn } from "./store/index.js";

/** Saves `value` sealed under `name` (e.g. a model provider's key, or an account key like "archil.api_key"). */
export async function putSealedKey(store: { sealedKeys: Pick<SealedKeys, "put"> }, sealKey: Buffer, name: string, value: string): Promise<void> {
  await store.sealedKeys.put(name, sealColumn(sealKey, sealedAt.sealedKey(name), value));
}

/** The value saved under `name`, opened now; undefined with none saved, or one that does not open under this seal key
 *  (sealed under another key, or damaged). Never a value the store could read in the clear. */
export async function getSealedKey(store: { sealedKeys: Pick<SealedKeys, "get"> }, sealKey: Buffer, name: string): Promise<string | undefined> {
  const sealed = await store.sealedKeys.get(name);
  if (sealed === undefined) return undefined;
  try {
    return unsealColumn(sealKey, sealedAt.sealedKey(name), sealed).toString("utf8");
  } catch {
    return undefined;
  }
}

/** The key's row goes. */
export async function removeSealedKey(store: { sealedKeys: Pick<SealedKeys, "remove"> }, name: string): Promise<void> {
  await store.sealedKeys.remove(name);
}

/** Every saved key's name, for a view that lists which are set (its bytes never opened). */
export async function sealedKeyNames(store: { sealedKeys: Pick<SealedKeys, "all"> }): Promise<string[]> {
  return (await store.sealedKeys.all()).map((row) => row.name);
}

/** Every saved key's value that opens under `sealKey` now: what the server never shows (its serverSecrets read them), for
 *  a reader in another process (the runner's learning end) that must refuse them too. One that does not open is left out,
 *  as getSealedKey reads it. */
export async function savedKeyValues(store: { sealedKeys: Pick<SealedKeys, "all" | "get"> }, sealKey: Buffer): Promise<string[]> {
  const names = await sealedKeyNames(store);
  const values = await Promise.all(names.map((name) => getSealedKey(store, sealKey, name)));
  return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}
